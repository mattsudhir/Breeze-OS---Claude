// POST /api/admin/match-candidate-action?secret=<TOKEN>
// body: { candidate_id, action: 'confirm' | 'reject', user_id?: uuid }
//
// Confirm or reject a match_candidate. Confirming bumps the rule's
// times_used + last_matched_at; rejecting bumps times_rejected and
// auto-disables the rule once rejections exceed the threshold (3+
// AND > times_used).

import {
  withAdminHandler,
  getDefaultOrgId,
  parseBody,
} from '../../lib/adminHelpers.js';
import { getDb } from '../../lib/db/index.js';
import {
  confirmMatchCandidate,
  rejectMatchCandidate,
} from '../../lib/accounting/matchEngine.js';

export default withAdminHandler(async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'POST only' });
  }
  const body = parseBody(req);
  const candidateId = body.candidate_id;
  const action = body.action;
  const userId = body.user_id || null;
  if (!candidateId) {
    return res.status(400).json({ ok: false, error: 'candidate_id required' });
  }
  if (action !== 'confirm' && action !== 'reject') {
    return res.status(400).json({
      ok: false,
      error: "action must be 'confirm' or 'reject'",
    });
  }

  const db = getDb();
  const organizationId = await getDefaultOrgId();

  const result = await db.transaction(async (tx) => {
    if (action === 'confirm') {
      return await confirmMatchCandidate(tx, organizationId, candidateId, userId);
    }
    return await rejectMatchCandidate(tx, organizationId, candidateId, userId);
  });

  return res.status(200).json({
    ok: true,
    organization_id: organizationId,
    action,
    ...result,
  });
});
