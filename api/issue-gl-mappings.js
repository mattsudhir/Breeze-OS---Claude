// Issue category → GL account mapping API.
//
// GET /api/issue-gl-mappings
//   Returns { categories, mappings } so Settings can render every
//   category and the user's saved GL choice for it.
//
// PUT /api/issue-gl-mappings
//   Body: { category, gl_account_id?, gl_account_name }
//   Upsert (one row per org+category). Empty gl_account_name clears
//   the mapping.

import { getDb, schema } from '../lib/db/index.js';
import { eq, and } from 'drizzle-orm';
import { getDefaultOrgId } from '../lib/adminHelpers.js';

// Fixed catalog of issue categories. Adding a new one means: append
// here, redeploy, and the Settings page picks it up automatically.
// Stable ids — they end up persisted to issue_gl_mappings.category.
export const ISSUE_CATEGORIES = [
  {
    id: 'plumbing',
    label: 'Plumbing Issues',
    description: 'Clogs, leaks, fixture failures — plugged toilets, dripping faucets, water heater repairs.',
    glHint: 'plumbing',
  },
  {
    id: 'electrical',
    label: 'Electrical Issues',
    description: 'Wiring, outlets, breaker resets, light fixtures.',
    glHint: 'electrical',
  },
  {
    id: 'hvac',
    label: 'HVAC Issues',
    description: 'Heating, cooling, ventilation, thermostat repairs.',
    glHint: 'hvac',
  },
  {
    id: 'other_repair',
    label: 'Other Repair Issues',
    description: 'General repairs that don\'t fit the categories above.',
    glHint: 'repairs',
  },
];

const VALID_IDS = new Set(ISSUE_CATEGORIES.map((c) => c.id));

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-breeze-user-id');
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    const db = getDb();
    const orgId = await getDefaultOrgId();

    if (req.method === 'GET') {
      const rows = await db
        .select()
        .from(schema.issueGlMappings)
        .where(eq(schema.issueGlMappings.organizationId, orgId));
      const mappings = {};
      for (const row of rows) {
        mappings[row.category] = {
          glAccountId: row.glAccountId,
          glAccountName: row.glAccountName,
        };
      }
      return res.status(200).json({
        ok: true,
        categories: ISSUE_CATEGORIES,
        mappings,
      });
    }

    if (req.method === 'PUT') {
      const { category, gl_account_id, gl_account_name } = req.body || {};
      if (!category) return res.status(400).json({ error: 'category required' });
      if (!VALID_IDS.has(category)) {
        return res.status(400).json({
          error: `Unknown category "${category}". Valid: ${[...VALID_IDS].join(', ')}.`,
        });
      }
      if (!gl_account_name) {
        return res.status(400).json({ error: 'gl_account_name required' });
      }
      const now = new Date();
      await db
        .insert(schema.issueGlMappings)
        .values({
          organizationId: orgId,
          category,
          glAccountId: gl_account_id || null,
          glAccountName: gl_account_name,
          createdAt: now,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: [schema.issueGlMappings.organizationId, schema.issueGlMappings.category],
          set: {
            glAccountId: gl_account_id || null,
            glAccountName: gl_account_name,
            updatedAt: now,
          },
        });
      return res.status(200).json({ ok: true, category });
    }

    if (req.method === 'DELETE') {
      const { category } = req.body || {};
      if (!category) return res.status(400).json({ error: 'category required' });
      await db
        .delete(schema.issueGlMappings)
        .where(and(
          eq(schema.issueGlMappings.organizationId, orgId),
          eq(schema.issueGlMappings.category, category),
        ));
      return res.status(200).json({ ok: true, category });
    }

    return res.status(405).json({ error: 'GET, PUT, or DELETE only' });
  } catch (err) {
    console.error('[/api/issue-gl-mappings] error:', err);
    return res.status(err.status || 500).json({ error: err.message || 'Unknown error' });
  }
}
