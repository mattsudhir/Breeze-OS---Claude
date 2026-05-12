// GET /api/admin/list-pending-approvals?secret=<TOKEN>
//
// Returns every outbound message in 'queued' status — the AI
// autonomy threshold parked it here pending staff review. Includes
// the workflow name and any related tenant/property metadata so the
// reviewer has context.

import { and, desc, eq } from 'drizzle-orm';
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
      id: schema.messages.id,
      channel: schema.messages.channel,
      direction: schema.messages.direction,
      status: schema.messages.status,
      toAddress: schema.messages.toAddress,
      body: schema.messages.body,
      tenantId: schema.messages.tenantId,
      propertyId: schema.messages.propertyId,
      leaseId: schema.messages.leaseId,
      aiWorkflowId: schema.messages.aiWorkflowId,
      createdAt: schema.messages.createdAt,
      workflowName: schema.aiWorkflows.name,
      workflowSlug: schema.aiWorkflows.slug,
      workflowChannel: schema.aiWorkflows.channel,
      workflowAssistantId: schema.aiWorkflows.vapiAssistantId,
    })
    .from(schema.messages)
    .leftJoin(
      schema.aiWorkflows,
      eq(schema.messages.aiWorkflowId, schema.aiWorkflows.id),
    )
    .where(
      and(
        eq(schema.messages.organizationId, organizationId),
        eq(schema.messages.direction, 'outbound'),
        eq(schema.messages.status, 'queued'),
      ),
    )
    .orderBy(desc(schema.messages.createdAt));

  return res.status(200).json({
    ok: true,
    organization_id: organizationId,
    count: rows.length,
    pending: rows.map((r) => ({
      id: r.id,
      channel: r.channel,
      direction: r.direction,
      status: r.status,
      to_address: r.toAddress,
      body: r.body,
      tenant_id: r.tenantId,
      property_id: r.propertyId,
      lease_id: r.leaseId,
      workflow_id: r.aiWorkflowId,
      workflow_name: r.workflowName,
      workflow_slug: r.workflowSlug,
      workflow_channel: r.workflowChannel,
      workflow_has_assistant: Boolean(r.workflowAssistantId),
      created_at: r.createdAt,
    })),
  });
});
