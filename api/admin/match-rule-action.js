// POST /api/admin/match-rule-action?secret=<TOKEN>
// body: { rule_id, action: 'enable' | 'disable' | 'delete' }
//
// Lifecycle controls for match_rules. Enable/disable toggle
// is_active so the auto-match worker stops/starts evaluating it.
// Delete is a hard delete — match_candidates have ON DELETE CASCADE
// on bank_transaction but not on match_rule (rule is referenced by
// reason_codes only, not via FK), so deleting the rule leaves
// historical candidates intact with their stored rule_id reason.

import { and, eq } from 'drizzle-orm';
import {
  withAdminHandler,
  getDefaultOrgId,
  parseBody,
} from '../../lib/adminHelpers.js';
import { getDb, schema } from '../../lib/db/index.js';

const VALID_ACTIONS = new Set(['enable', 'disable', 'delete']);

export default withAdminHandler(async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'POST only' });
  }
  const body = parseBody(req);
  const ruleId = body.rule_id;
  const action = body.action;
  if (!ruleId) {
    return res.status(400).json({ ok: false, error: 'rule_id required' });
  }
  if (!VALID_ACTIONS.has(action)) {
    return res.status(400).json({
      ok: false,
      error: "action must be 'enable', 'disable', or 'delete'",
    });
  }

  const db = getDb();
  const organizationId = await getDefaultOrgId();

  if (action === 'delete') {
    const result = await db
      .delete(schema.matchRules)
      .where(
        and(
          eq(schema.matchRules.id, ruleId),
          eq(schema.matchRules.organizationId, organizationId),
        ),
      )
      .returning({ id: schema.matchRules.id });
    if (result.length === 0) {
      return res.status(404).json({ ok: false, error: 'rule not found' });
    }
    return res.status(200).json({
      ok: true,
      action: 'delete',
      rule_id: ruleId,
    });
  }

  const isActive = action === 'enable';
  const result = await db
    .update(schema.matchRules)
    .set({ isActive, updatedAt: new Date() })
    .where(
      and(
        eq(schema.matchRules.id, ruleId),
        eq(schema.matchRules.organizationId, organizationId),
      ),
    )
    .returning({
      id: schema.matchRules.id,
      isActive: schema.matchRules.isActive,
    });
  if (result.length === 0) {
    return res.status(404).json({ ok: false, error: 'rule not found' });
  }

  return res.status(200).json({
    ok: true,
    action,
    rule_id: ruleId,
    is_active: result[0].isActive,
  });
});
