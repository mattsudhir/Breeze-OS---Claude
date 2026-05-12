// GET  /api/admin/recon-settings?secret=<TOKEN>
//   Returns the org's auto-match thresholds.
//
// POST /api/admin/recon-settings?secret=<TOKEN>
//   body: {
//     auto_match_confidence?:    number 0–1
//     auto_match_min_times_used?: integer >= 0
//   }
//   Updates either or both. Validates ranges defensively (the DB
//   CHECK constraints from migration 0018 are the ultimate gate).

import { eq } from 'drizzle-orm';
import {
  withAdminHandler,
  getDefaultOrgId,
  parseBody,
} from '../../lib/adminHelpers.js';
import { getDb, schema } from '../../lib/db/index.js';

export default withAdminHandler(async (req, res) => {
  if (req.method !== 'GET' && req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'GET or POST only' });
  }
  const db = getDb();
  const organizationId = await getDefaultOrgId();

  if (req.method === 'POST') {
    const body = parseBody(req);
    const updates = {};

    if (body.auto_match_confidence !== undefined) {
      const v = Number(body.auto_match_confidence);
      if (!Number.isFinite(v) || v < 0 || v > 1) {
        return res.status(400).json({
          ok: false,
          error: 'auto_match_confidence must be a number in [0, 1]',
        });
      }
      updates.reconAutoMatchConfidence = v;
    }

    if (body.auto_match_min_times_used !== undefined) {
      const v = Number(body.auto_match_min_times_used);
      if (!Number.isInteger(v) || v < 0) {
        return res.status(400).json({
          ok: false,
          error: 'auto_match_min_times_used must be a non-negative integer',
        });
      }
      updates.reconAutoMatchMinTimesUsed = v;
    }

    if (Object.keys(updates).length === 0) {
      return res.status(400).json({
        ok: false,
        error: 'no fields to update; supply auto_match_confidence and/or auto_match_min_times_used',
      });
    }

    updates.updatedAt = new Date();

    await db
      .update(schema.organizations)
      .set(updates)
      .where(eq(schema.organizations.id, organizationId));
  }

  const [org] = await db
    .select({
      autoMatchConfidence: schema.organizations.reconAutoMatchConfidence,
      autoMatchMinTimesUsed: schema.organizations.reconAutoMatchMinTimesUsed,
    })
    .from(schema.organizations)
    .where(eq(schema.organizations.id, organizationId))
    .limit(1);

  return res.status(200).json({
    ok: true,
    organization_id: organizationId,
    auto_match_confidence: Number(org.autoMatchConfidence),
    auto_match_min_times_used: Number(org.autoMatchMinTimesUsed),
  });
});
