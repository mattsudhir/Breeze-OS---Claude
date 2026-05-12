// POST /api/voice/place-call?secret=<TOKEN>
// body: {
//   workflow_id?:     uuid    // OR workflow_slug
//   workflow_slug?:   string  // e.g. 'switch_utilities'
//   phone_number:     string  // E.164, e.g. '+14155551234'
//   customer_name?:   string
//   tenant_id?:       uuid    // attribution for the resulting message row
//   property_id?:     uuid
//   lease_id?:        uuid
//   metadata?:        object  // arbitrary extra data echoed to VAPI webhooks
//   assistant_overrides?: object  // per-call prompt/voice/etc. overrides
// }
//
// Initiates an outbound voice call via VAPI using the workflow's
// assistant_id and records a 'queued' message + voice_calls row that
// the webhook handler will later flesh out with transcript + status.
//
// Autonomy gating:
//   draft_only / approve_before_contact → does NOT dial; creates the
//                                         message in 'queued' status,
//                                         to be approved by staff.
//   approve_before_action / notify_only / full → dials immediately.

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
      error: 'VAPI_API_KEY not set in env vars. Configure VAPI to enable voice agents.',
    });
  }

  const body = parseBody(req);
  if (!body.phone_number) {
    return res.status(400).json({ ok: false, error: 'phone_number required (E.164)' });
  }
  if (!body.workflow_id && !body.workflow_slug) {
    return res.status(400).json({ ok: false, error: 'workflow_id or workflow_slug required' });
  }

  const db = getDb();
  const organizationId = await getDefaultOrgId();

  // Resolve workflow + effective autonomy.
  const [workflow] = await db
    .select()
    .from(schema.aiWorkflows)
    .where(
      and(
        eq(schema.aiWorkflows.organizationId, organizationId),
        body.workflow_id
          ? eq(schema.aiWorkflows.id, body.workflow_id)
          : eq(schema.aiWorkflows.slug, body.workflow_slug),
      ),
    )
    .limit(1);
  if (!workflow) {
    return res.status(404).json({ ok: false, error: 'workflow not found' });
  }
  if (!workflow.isActive) {
    return res.status(400).json({ ok: false, error: 'workflow is inactive' });
  }
  if (workflow.channel !== 'voice' || workflow.direction !== 'outbound') {
    return res.status(400).json({
      ok: false,
      error: `workflow ${workflow.slug} is not an outbound voice workflow`,
    });
  }

  const [org] = await db
    .select({ defaultAutonomy: schema.organizations.aiDefaultAutonomyLevel })
    .from(schema.organizations)
    .where(eq(schema.organizations.id, organizationId))
    .limit(1);
  const effectiveAutonomy = workflow.autonomyLevel || org?.defaultAutonomy || 'approve_before_action';
  const requiresPreContactApproval =
    effectiveAutonomy === 'draft_only' || effectiveAutonomy === 'approve_before_contact';

  if (!workflow.vapiAssistantId) {
    return res.status(400).json({
      ok: false,
      error: `workflow ${workflow.slug} has no vapi_assistant_id. Set one in the AI Agents tab to enable calls.`,
    });
  }

  // Always create the message + voice_call row first so we have a
  // record even if the call is queued for approval or fails.
  const [message] = await db
    .insert(schema.messages)
    .values({
      organizationId,
      channel: 'voice',
      direction: 'outbound',
      status: requiresPreContactApproval ? 'queued' : 'sending',
      tenantId: body.tenant_id || null,
      propertyId: body.property_id || null,
      leaseId: body.lease_id || null,
      toAddress: body.phone_number,
      aiWorkflowId: workflow.id,
      body: `Outbound ${workflow.name} call to ${body.phone_number}`,
    })
    .returning({ id: schema.messages.id });

  if (requiresPreContactApproval) {
    return res.status(200).json({
      ok: true,
      message_id: message.id,
      status: 'queued',
      autonomy_level: effectiveAutonomy,
      note: 'Call queued — requires staff approval before dialing.',
    });
  }

  // Dial.
  let callResult;
  try {
    callResult = await placeCall({
      assistantId: workflow.vapiAssistantId,
      phoneNumber: body.phone_number,
      customerName: body.customer_name,
      assistantOverrides: body.assistant_overrides,
      metadata: {
        breeze_message_id: message.id,
        organization_id: organizationId,
        workflow_id: workflow.id,
        workflow_slug: workflow.slug,
        tenant_id: body.tenant_id || null,
        property_id: body.property_id || null,
        lease_id: body.lease_id || null,
        autonomy_level: effectiveAutonomy,
        ...(body.metadata || {}),
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
      .where(eq(schema.messages.id, message.id));
    return res.status(502).json({
      ok: false,
      error: err.message || String(err),
      message_id: message.id,
    });
  }

  // Stamp external id + insert voice_call shell.
  await db.transaction(async (tx) => {
    await tx
      .update(schema.messages)
      .set({
        externalId: callResult.id,
        sentAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(schema.messages.id, message.id));
    await tx.insert(schema.voiceCalls).values({
      messageId: message.id,
      organizationId,
      vapiCallId: callResult.id,
      vapiAssistantId: workflow.vapiAssistantId,
    });
  });

  return res.status(200).json({
    ok: true,
    message_id: message.id,
    vapi_call_id: callResult.id,
    status: callResult.status || 'sending',
    autonomy_level: effectiveAutonomy,
  });
});
