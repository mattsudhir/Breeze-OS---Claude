// POST /api/voice/transfer-call?secret=<TOKEN>
// body: { voice_call_id, destination_phone }
//
// Transfers an in-progress VAPI call to a staff phone. The AI drops;
// the tenant is routed to the destination. Logs an audit_event.

import { and, eq } from 'drizzle-orm';
import {
  withAdminHandler,
  getDefaultOrgId,
  parseBody,
} from '../../lib/adminHelpers.js';
import { getDb, schema } from '../../lib/db/index.js';
import { transferCall, isVapiConfigured } from '../../lib/backends/vapi.js';

export default withAdminHandler(async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'POST only' });
  }
  if (!isVapiConfigured()) {
    return res.status(503).json({ ok: false, error: 'VAPI not configured' });
  }

  const body = parseBody(req);
  if (!body.voice_call_id || !body.destination_phone) {
    return res.status(400).json({ ok: false, error: 'voice_call_id and destination_phone required' });
  }

  const db = getDb();
  const organizationId = await getDefaultOrgId();

  const [vc] = await db
    .select({
      id: schema.voiceCalls.id,
      vapiCallId: schema.voiceCalls.vapiCallId,
      messageId: schema.voiceCalls.messageId,
    })
    .from(schema.voiceCalls)
    .where(
      and(
        eq(schema.voiceCalls.id, body.voice_call_id),
        eq(schema.voiceCalls.organizationId, organizationId),
      ),
    )
    .limit(1);
  if (!vc) return res.status(404).json({ ok: false, error: 'voice_call not found' });
  if (!vc.vapiCallId) return res.status(400).json({ ok: false, error: 'voice_call has no vapi_call_id' });

  try {
    await transferCall(vc.vapiCallId, body.destination_phone);
  } catch (err) {
    return res.status(502).json({ ok: false, error: err.message });
  }

  await db.insert(schema.auditEvents).values({
    organizationId,
    actorType: 'admin_action',
    actorId: null,
    subjectTable: 'voice_calls',
    subjectId: vc.id,
    eventType: 'voice_call_transferred',
    beforeState: null,
    afterState: { destination: body.destination_phone },
  });

  return res.status(200).json({
    ok: true,
    voice_call_id: vc.id,
    transferred_to: body.destination_phone,
  });
});
