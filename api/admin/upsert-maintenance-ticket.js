// POST /api/admin/upsert-maintenance-ticket?secret=<TOKEN>
// body: {
//   id?:               uuid (omit on create)
//   title:             required on create
//   description?:      string
//   category?:         string
//   priority?:         'low' | 'medium' | 'high' | 'emergency'
//   status?:           enum
//   property_id?:      uuid
//   unit_id?:          uuid
//   tenant_id?:        uuid
//   vendor_id?:        uuid
//   assigned_to_user_id?: uuid
//   scheduled_at?:     ISO timestamp
//   completed_at?:     ISO timestamp (auto-set when status flips to 'completed' if absent)
//   estimated_cost_cents?: integer
//   actual_cost_cents?:    integer
//   notes?:            string
// }

import { and, eq } from 'drizzle-orm';
import {
  withAdminHandler,
  getDefaultOrgId,
  parseBody,
} from '../../lib/adminHelpers.js';
import { getDb, schema } from '../../lib/db/index.js';

const VALID_STATUS = new Set([
  'new', 'triage', 'assigned', 'in_progress',
  'awaiting_parts', 'awaiting_tenant', 'completed', 'cancelled',
]);
const VALID_PRIORITY = new Set(['low', 'medium', 'high', 'emergency']);

export default withAdminHandler(async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'POST only' });
  }
  const body = parseBody(req);
  const id = body.id || null;

  if (body.status && !VALID_STATUS.has(body.status)) {
    return res.status(400).json({ ok: false, error: `status must be one of ${Array.from(VALID_STATUS).join(', ')}` });
  }
  if (body.priority && !VALID_PRIORITY.has(body.priority)) {
    return res.status(400).json({ ok: false, error: `priority must be one of ${Array.from(VALID_PRIORITY).join(', ')}` });
  }
  if (!id && (!body.title || !String(body.title).trim())) {
    return res.status(400).json({ ok: false, error: 'title required on create' });
  }

  const values = { updatedAt: new Date() };
  if (body.title !== undefined) {
    values.title = String(body.title).trim();
    // A title coming through the upsert endpoint is, by definition,
    // a user-set value — flag it so the AppFolio sync and the AI
    // summarization cron both leave it alone. See ADR 0004.
    values.titleSource = 'manual_edit';
  }
  if (body.description !== undefined) values.description = body.description || null;
  if (body.category !== undefined) values.category = body.category || null;
  if (body.priority !== undefined) values.priority = body.priority;
  if (body.status !== undefined) {
    values.status = body.status;
    if (body.status === 'completed' && !body.completed_at) {
      values.completedAt = new Date();
    }
  }
  if (body.property_id !== undefined) values.propertyId = body.property_id || null;
  if (body.unit_id !== undefined) values.unitId = body.unit_id || null;
  if (body.tenant_id !== undefined) values.tenantId = body.tenant_id || null;
  if (body.vendor_id !== undefined) values.vendorId = body.vendor_id || null;
  if (body.assigned_to_user_id !== undefined) values.assignedToUserId = body.assigned_to_user_id || null;
  if (body.scheduled_at !== undefined) values.scheduledAt = body.scheduled_at ? new Date(body.scheduled_at) : null;
  if (body.completed_at !== undefined) values.completedAt = body.completed_at ? new Date(body.completed_at) : null;
  if (body.estimated_cost_cents !== undefined) values.estimatedCostCents = body.estimated_cost_cents;
  if (body.actual_cost_cents !== undefined) values.actualCostCents = body.actual_cost_cents;
  if (body.notes !== undefined) values.notes = body.notes || null;

  const db = getDb();
  const organizationId = await getDefaultOrgId();

  let result;
  if (id) {
    const updated = await db
      .update(schema.maintenanceTickets)
      .set(values)
      .where(
        and(
          eq(schema.maintenanceTickets.id, id),
          eq(schema.maintenanceTickets.organizationId, organizationId),
        ),
      )
      .returning({ id: schema.maintenanceTickets.id });
    if (updated.length === 0) {
      return res.status(404).json({ ok: false, error: 'ticket not found' });
    }
    result = { id: updated[0].id, created: false };
  } else {
    const created = await db
      .insert(schema.maintenanceTickets)
      .values({ organizationId, ...values })
      .returning({ id: schema.maintenanceTickets.id });
    result = { id: created[0].id, created: true };
  }

  return res.status(200).json({ ok: true, organization_id: organizationId, ticket: result });
});
