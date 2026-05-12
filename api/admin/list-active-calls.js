// GET /api/admin/list-active-calls?secret=<TOKEN>
//
// Returns voice_calls whose parent message is still 'sending' (i.e.
// the call is in flight). Used by the Live Calls panel.

import { and, eq, desc } from 'drizzle-orm';
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

  const rows = await db
    .select({
      voiceCallId: schema.voiceCalls.id,
      vapiCallId: schema.voiceCalls.vapiCallId,
      vapiAssistantId: schema.voiceCalls.vapiAssistantId,
      messageId: schema.voiceCalls.messageId,
      createdAt: schema.voiceCalls.createdAt,
      toAddress: schema.messages.toAddress,
      status: schema.messages.status,
      workflowName: schema.aiWorkflows.name,
      workflowSlug: schema.aiWorkflows.slug,
    })
    .from(schema.voiceCalls)
    .innerJoin(schema.messages, eq(schema.voiceCalls.messageId, schema.messages.id))
    .leftJoin(schema.aiWorkflows, eq(schema.messages.aiWorkflowId, schema.aiWorkflows.id))
    .where(
      and(
        eq(schema.voiceCalls.organizationId, organizationId),
        eq(schema.messages.status, 'sending'),
      ),
    )
    .orderBy(desc(schema.voiceCalls.createdAt));

  return res.status(200).json({
    ok: true,
    organization_id: organizationId,
    count: rows.length,
    active_calls: rows.map((r) => ({
      voice_call_id: r.voiceCallId,
      vapi_call_id: r.vapiCallId,
      vapi_assistant_id: r.vapiAssistantId,
      message_id: r.messageId,
      to_address: r.toAddress,
      status: r.status,
      workflow_name: r.workflowName,
      workflow_slug: r.workflowSlug,
      started_at: r.createdAt,
    })),
  });
});
