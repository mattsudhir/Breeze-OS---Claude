// POST /api/admin/reject-queued-call?secret=<TOKEN>
// body: { message_id, reason? }
//
// Rejects a queued outbound message — marks it 'failed' with the
// supplied reason and logs an audit_event.

import { and, eq } from 'drizzle-orm';
import {
  withAdminHandler,
  getDefaultOrgId,
  parseBody,
} from '../../lib/adminHelpers.js';
import { getDb, schema } from '../../lib/db/index.js';

export default withAdminHandler(async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'POST only' });
  }
  const body = parseBody(req);
  if (!body.message_id) {
    return res.status(400).json({ ok: false, error: 'message_id required' });
  }
  const reason = body.reason || 'rejected by staff';

  const db = getDb();
  const organizationId = await getDefaultOrgId();

  const [row] = await db
    .select({ id: schema.messages.id, status: schema.messages.status })
    .from(schema.messages)
    .where(
      and(
        eq(schema.messages.id, body.message_id),
        eq(schema.messages.organizationId, organizationId),
      ),
    )
    .limit(1);

  if (!row) {
    return res.status(404).json({ ok: false, error: 'message not found in org' });
  }
  if (row.status !== 'queued') {
    return res.status(400).json({
      ok: false,
      error: `message is in status '${row.status}', expected 'queued'`,
    });
  }

  await db.transaction(async (tx) => {
    await tx
      .update(schema.messages)
      .set({ status: 'failed', errorMessage: reason, updatedAt: new Date() })
      .where(eq(schema.messages.id, row.id));
    await tx.insert(schema.auditEvents).values({
      organizationId,
      actorType: 'admin_action',
      actorId: null,
      subjectTable: 'messages',
      subjectId: row.id,
      eventType: 'voice_call_rejected',
      beforeState: { status: 'queued' },
      afterState: { status: 'failed', reason },
    });
  });

  return res.status(200).json({
    ok: true,
    organization_id: organizationId,
    message_id: row.id,
    status: 'failed',
    reason,
  });
});
