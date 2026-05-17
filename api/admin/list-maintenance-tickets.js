// GET /api/admin/list-maintenance-tickets?secret=<TOKEN>
//   &status=open|all|<specific>
//   &property_id=<uuid>
//   &priority=<enum>
//
// Returns tickets joined with property + unit + vendor for the
// Maintenance page. 'open' = anything not completed/cancelled.

import { and, eq, desc, ne, or, sql } from 'drizzle-orm';
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
  const statusFilter = req.query?.status || 'open';
  const propertyId = req.query?.property_id || null;
  const priority = req.query?.priority || null;
  const limit = Math.min(Math.max(parseInt(req.query?.limit, 10) || 200, 1), 500);

  const whereClauses = [eq(schema.maintenanceTickets.organizationId, organizationId)];
  if (statusFilter === 'open') {
    whereClauses.push(
      or(
        ne(schema.maintenanceTickets.status, 'completed'),
        ne(schema.maintenanceTickets.status, 'cancelled'),
      ),
    );
    // Actually we want NOT IN (completed, cancelled). Express via sql.
    whereClauses.pop();
    whereClauses.push(
      sql`${schema.maintenanceTickets.status} NOT IN ('completed', 'cancelled')`,
    );
  } else if (statusFilter !== 'all') {
    whereClauses.push(eq(schema.maintenanceTickets.status, statusFilter));
  }
  if (propertyId) whereClauses.push(eq(schema.maintenanceTickets.propertyId, propertyId));
  if (priority) whereClauses.push(eq(schema.maintenanceTickets.priority, priority));

  const rows = await db
    .select({
      id: schema.maintenanceTickets.id,
      title: schema.maintenanceTickets.title,
      titleSource: schema.maintenanceTickets.titleSource,
      description: schema.maintenanceTickets.description,
      category: schema.maintenanceTickets.category,
      status: schema.maintenanceTickets.status,
      priority: schema.maintenanceTickets.priority,
      reportedAt: schema.maintenanceTickets.reportedAt,
      scheduledAt: schema.maintenanceTickets.scheduledAt,
      completedAt: schema.maintenanceTickets.completedAt,
      estimatedCostCents: schema.maintenanceTickets.estimatedCostCents,
      actualCostCents: schema.maintenanceTickets.actualCostCents,
      propertyId: schema.maintenanceTickets.propertyId,
      propertyName: schema.properties.displayName,
      unitId: schema.maintenanceTickets.unitId,
      unitName: schema.units.sourceUnitName,
      tenantId: schema.maintenanceTickets.tenantId,
      vendorId: schema.maintenanceTickets.vendorId,
      vendorName: schema.vendors.displayName,
      sourceTicketId: schema.maintenanceTickets.sourceTicketId,
      sourcePms: schema.maintenanceTickets.sourcePms,
      createdAt: schema.maintenanceTickets.createdAt,
    })
    .from(schema.maintenanceTickets)
    .leftJoin(schema.properties, eq(schema.maintenanceTickets.propertyId, schema.properties.id))
    .leftJoin(schema.units, eq(schema.maintenanceTickets.unitId, schema.units.id))
    .leftJoin(schema.vendors, eq(schema.maintenanceTickets.vendorId, schema.vendors.id))
    .where(and(...whereClauses))
    .orderBy(desc(schema.maintenanceTickets.reportedAt))
    .limit(limit);

  // Summary by status.
  const byStatus = await db
    .select({
      status: schema.maintenanceTickets.status,
      count: sql`COUNT(*)`.as('count'),
    })
    .from(schema.maintenanceTickets)
    .where(eq(schema.maintenanceTickets.organizationId, organizationId))
    .groupBy(schema.maintenanceTickets.status);

  return res.status(200).json({
    ok: true,
    organization_id: organizationId,
    count: rows.length,
    summary_by_status: byStatus.map((r) => ({ status: r.status, count: Number(r.count) })),
    tickets: rows.map((t) => ({
      id: t.id,
      title: t.title,
      title_source: t.titleSource,
      description: t.description,
      category: t.category,
      status: t.status,
      priority: t.priority,
      reported_at: t.reportedAt,
      scheduled_at: t.scheduledAt,
      completed_at: t.completedAt,
      estimated_cost_cents: t.estimatedCostCents,
      actual_cost_cents: t.actualCostCents,
      property_id: t.propertyId,
      property_name: t.propertyName,
      unit_id: t.unitId,
      unit_name: t.unitName,
      tenant_id: t.tenantId,
      vendor_id: t.vendorId,
      vendor_name: t.vendorName,
      source_ticket_id: t.sourceTicketId,
      source_pms: t.sourcePms,
      created_at: t.createdAt,
    })),
  });
});
