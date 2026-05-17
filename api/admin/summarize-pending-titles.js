// POST /api/admin/summarize-pending-titles?secret=<TOKEN>
// body: {
//   limit?: 50,        // default 50, max 200 per invocation
//   dry_run?: false,   // default false; true returns what WOULD update without writing
//   min_description_length?: 200,   // skip tickets whose description is short enough that
//                                   // first_sentence is already good enough
// }
//
// Background worker for ADR 0004 (AI-summarized ticket titles).
//
// Picks up tickets where title_source = 'first_sentence' AND the
// description is long enough that an AI summary is likely better.
// Calls Claude Haiku with a tight prompt, writes the result back,
// and flips title_source to 'ai_summary'.
//
// Never touches rows where title_source = 'manual_edit' or
// 'ai_summary' — those are settled. The sync endpoint marks new
// rows as 'first_sentence' and resets to 'first_sentence' on any
// re-sync where the description changed, so this worker naturally
// re-summarizes when the source content drifts.
//
// Cost ceiling: max 200 tickets per call. ~$0.0001/ticket with
// Haiku 4.5 → ~$0.02 cap per invocation. Caller-controlled limit
// can throttle further.
//
// Failures (Anthropic down, rate limit, parse error) are recorded
// per-row in the response and the row stays at 'first_sentence' so
// the next run picks it up again.

import Anthropic from '@anthropic-ai/sdk';
import { and, eq, gt, sql } from 'drizzle-orm';
import {
  withAdminHandler,
  getDefaultOrgId,
  parseBody,
  recordAudit,
} from '../../lib/adminHelpers.js';
import { getDb, schema } from '../../lib/db/index.js';

export const config = { maxDuration: 300 };

const MODEL = process.env.TITLE_SUMMARIZER_MODEL || 'claude-haiku-4-5';
const HARD_LIMIT = 200;
const TITLE_MAX_CHARS = 120;

const SYSTEM_PROMPT = `You summarize property-management maintenance tickets into short, scannable titles for a list view.

Rules:
- 10-12 words, in active voice.
- Focus on what needs to be done or what's broken, NOT who reported it or compliance / insurance / inspection boilerplate.
- No quotes, no trailing period, no leading dash.
- If the ticket is an inspection finding, lead with the actionable item (e.g. "Install hard-wired smoke detectors in all units").
- If the ticket is a tenant repair request, lead with the broken thing and its location (e.g. "Kitchen sink leak at base, water pooling under cabinet").
- If you genuinely cannot summarize (input is gibberish), output the literal string UNABLE.

Examples:

Input: "Tenant reports kitchen sink leaking at base, water pooling under cabinet."
Output: Kitchen sink leak at base, water pooling under cabinet

Input: "SLM Toledo Investments LLC, as surveyed by Millers Mutual on April 17, 2026. You must notify your insurance agent of compliance status for these recommendations within 30 days. 01-2026-01: There was an inadequate amount of smoke detectors. U.L. smoke detectors should be installed in every living unit in the building."
Output: Insurance inspection: install hard-wired smoke detectors in every living unit

Input: "Annual HVAC service per maintenance schedule"
Output: Annual HVAC service

Output ONLY the title text. Nothing else.`;

let cachedClient = null;
function getClient() {
  if (cachedClient) return cachedClient;
  cachedClient = new Anthropic();
  return cachedClient;
}

async function summarizeOne(description) {
  const client = getClient();
  const resp = await client.messages.create({
    model: MODEL,
    max_tokens: 80,
    system: SYSTEM_PROMPT,
    messages: [{ role: 'user', content: description.slice(0, 6000) }],
  });
  // Extract text from the response.
  const text = (resp.content || [])
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('')
    .trim();
  if (!text || text === 'UNABLE') return null;
  // Clip + scrub trailing punctuation per the prompt rules.
  return text.replace(/^["'\-—\s]+|["'.\s]+$/g, '').slice(0, TITLE_MAX_CHARS);
}

export default withAdminHandler(async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'POST only' });
  }
  if (!process.env.ANTHROPIC_API_KEY) {
    return res.status(503).json({
      ok: false,
      error: 'ANTHROPIC_API_KEY not configured in Vercel env vars',
    });
  }

  const body = parseBody(req);
  const dryRun = body.dry_run === true;
  const limit = Math.min(
    Math.max(Number(body.limit) || 50, 1),
    HARD_LIMIT,
  );
  const minDescLength = Math.max(
    Number(body.min_description_length) || 200,
    50,
  );

  const db = getDb();
  const organizationId = await getDefaultOrgId();

  // Candidate rows: first_sentence titles with a long-enough
  // description that the summary would actually improve things.
  const candidates = await db
    .select({
      id: schema.maintenanceTickets.id,
      title: schema.maintenanceTickets.title,
      description: schema.maintenanceTickets.description,
    })
    .from(schema.maintenanceTickets)
    .where(
      and(
        eq(schema.maintenanceTickets.organizationId, organizationId),
        eq(schema.maintenanceTickets.titleSource, 'first_sentence'),
        sql`char_length(coalesce(${schema.maintenanceTickets.description}, '')) >= ${minDescLength}`,
      ),
    )
    .limit(limit);

  const results = [];
  let updated = 0;
  let skipped = 0;
  let failed = 0;

  for (const row of candidates) {
    if (!row.description) {
      skipped += 1;
      results.push({ id: row.id, status: 'skipped', reason: 'no description' });
      continue;
    }
    try {
      const newTitle = await summarizeOne(row.description);
      if (!newTitle) {
        skipped += 1;
        results.push({ id: row.id, status: 'skipped', reason: 'model returned UNABLE or empty' });
        continue;
      }
      if (newTitle === row.title) {
        skipped += 1;
        results.push({ id: row.id, status: 'skipped', reason: 'summary matched current title' });
        continue;
      }

      if (!dryRun) {
        await db
          .update(schema.maintenanceTickets)
          .set({
            title: newTitle,
            titleSource: 'ai_summary',
            updatedAt: new Date(),
          })
          .where(eq(schema.maintenanceTickets.id, row.id));
        // Record one consolidated audit entry per invocation? No —
        // per-row is more useful for tracking which tickets the AI
        // touched. Cheap insert; admin_audit_log has a 200k trim.
        await recordAudit(req, {
          action: 'UPDATE',
          table: 'maintenance_tickets',
          id: row.id,
          before: { title: row.title, title_source: 'first_sentence' },
          after: { title: newTitle, title_source: 'ai_summary' },
          context: { reason: 'ai_summarize_titles', model: MODEL },
        });
      }
      updated += 1;
      // Keep response size sane: only include text for the first 10 examples.
      if (results.length < 10) {
        results.push({
          id: row.id,
          status: dryRun ? 'would_update' : 'updated',
          old_title: row.title,
          new_title: newTitle,
        });
      } else {
        results.push({ id: row.id, status: dryRun ? 'would_update' : 'updated' });
      }
    } catch (err) {
      failed += 1;
      results.push({
        id: row.id,
        status: 'failed',
        error: err?.message || String(err),
      });
    }
  }

  return res.status(200).json({
    ok: true,
    organization_id: organizationId,
    dry_run: dryRun,
    model: MODEL,
    candidates: candidates.length,
    updated,
    skipped,
    failed,
    results,
  });
});
