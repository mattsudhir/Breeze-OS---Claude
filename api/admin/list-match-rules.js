// GET /api/admin/list-match-rules?secret=<TOKEN>&include_inactive=true
//
// Returns every match_rule for the org with its natural-language
// description, target GL account, usage stats, and last-matched
// timestamp. Drives the rule-management UI.

import { and, eq, sql } from 'drizzle-orm';
import {
  withAdminHandler,
  getDefaultOrgId,
} from '../../lib/adminHelpers.js';
import { getDb, schema } from '../../lib/db/index.js';

export default withAdminHandler(async (req, res) => {
  if (req.method !== 'GET') {
    return res.status(405).json({ ok: false, error: 'GET only' });
  }
  const db = getDb();
  const organizationId = await getDefaultOrgId();
  const includeInactive =
    req.query?.include_inactive === 'true' ||
    req.query?.include_inactive === '1';

  const whereClauses = [eq(schema.matchRules.organizationId, organizationId)];
  if (!includeInactive) whereClauses.push(eq(schema.matchRules.isActive, true));

  const rules = await db
    .select()
    .from(schema.matchRules)
    .where(and(...whereClauses))
    .orderBy(sql`${schema.matchRules.lastMatchedAt} DESC NULLS LAST`);

  return res.status(200).json({
    ok: true,
    organization_id: organizationId,
    count: rules.length,
    rules: rules.map((r) => ({
      id: r.id,
      name: r.name,
      natural_language_description: r.naturalLanguageDescription,
      pattern_type: r.patternType,
      pattern_payload: r.patternPayload,
      target: r.target,
      confidence_score: r.confidenceScore,
      times_used: r.timesUsed,
      times_rejected: r.timesRejected,
      is_active: r.isActive,
      last_matched_at: r.lastMatchedAt,
      notes: r.notes,
      created_at: r.createdAt,
    })),
  });
});
