// POST /api/admin/approve-queued-call?secret=<TOKEN>
// body: { message_id }
//
// Approves a queued outbound voice call. Looks up the workflow, dials
// via VAPI, transitions the message from 'queued' to 'sending', and
// writes a voice_calls shell row. Logs an audit_event tagged with the
// approving user (TODO: when Clerk session has user id wired).

import { and, eq } from 'drizzle-orm';
import {
  withAdminHandler,
  getDefaultOrgId,
  parseBody,
} from '../../lib/adminHelpers.js';
import { getDb, schema } from '../../lib/db/index.js';
import { placeCall, isVapiConfigured } from '../../lib/backends/vapi.js';

export default withAdminHandler(async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'POST only' });
  }
  if (!isVapiConfigured()) {
    return res.status(503).json({
      ok: false,
      error: 'VAPI_API_KEY not set in env vars.',
    });
  }

  const body = parseBody(req);
  if (!body.message_id) {
    return res.status(400).json({ ok: false, error: 'message_id required' });
  }

  const db = getDb();
  const organizationId = await getDefaultOrgId();

  const [row] = await db
    .select({
      id: schema.messages.id,
      status: schema.messages.status,
      channel: schema.messages.channel,
      direction: schema.messages.direction,
      toAddress: schema.messages.toAddress,
      tenantId: schema.messages.tenantId,
      propertyId: schema.messages.propertyId,
      leaseId: schema.messages.leaseId,
      aiWorkflowId: schema.messages.aiWorkflowId,
      workflowSlug: schema.aiWorkflows.slug,
      workflowAssistantId: schema.aiWorkflows.vapiAssistantId,
    })
    .from(schema.messages)
    .leftJoin(
      schema.aiWorkflows,
      eq(schema.messages.aiWorkflowId, schema.aiWorkflows.id),
    )
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
  if (row.channel !== 'voice' || row.direction !== 'outbound') {
    return res.status(400).json({
      ok: false,
      error: 'only outbound voice messages can be approved by this endpoint',
    });
  }
  if (!row.workflowAssistantId) {
    return res.status(400).json({
      ok: false,
      error: 'workflow has no vapi_assistant_id; configure it before approving',
    });
  }

  let callResult;
  try {
    callResult = await placeCall({
      assistantId: row.workflowAssistantId,
      phoneNumber: row.toAddress,
      metadata: {
        breeze_message_id: row.id,
        organization_id: organizationId,
        workflow_id: row.aiWorkflowId,
        workflow_slug: row.workflowSlug,
        tenant_id: row.tenantId,
        property_id: row.propertyId,
        lease_id: row.leaseId,
        approved_at: new Date().toISOString(),
      },
    });
  } catch (err) {
    await db
      .update(schema.messages)
      .set({
        status: 'failed',
        errorMessage: err.message || String(err),
        updatedAt: new Date(),
      })
      .where(eq(schema.messages.id, row.id));
    return res.status(502).json({
      ok: false,
      error: err.message || String(err),
      message_id: row.id,
    });
  }

  await db.transaction(async (tx) => {
    await tx
      .update(schema.messages)
      .set({
        status: 'sending',
        externalId: callResult.id,
        sentAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(schema.messages.id, row.id));
    await tx.insert(schema.voiceCalls).values({
      messageId: row.id,
      organizationId,
      vapiCallId: callResult.id,
      vapiAssistantId: row.workflowAssistantId,
    });
    await tx.insert(schema.auditEvents).values({
      organizationId,
      actorType: 'admin_action',
      actorId: null,
      subjectTable: 'messages',
      subjectId: row.id,
      eventType: 'voice_call_approved',
      beforeState: { status: 'queued' },
      afterState: { status: 'sending', vapi_call_id: callResult.id },
    });
  });

  return res.status(200).json({
    ok: true,
    organization_id: organizationId,
    message_id: row.id,
    vapi_call_id: callResult.id,
    status: callResult.status || 'sending',
  });
});
