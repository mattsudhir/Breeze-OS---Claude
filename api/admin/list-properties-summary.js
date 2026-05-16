// GET /api/admin/list-properties-summary?secret=<TOKEN>
//
// Properties dashboard data — each property with its units, the
// current tenant per unit, and rolled-up financial stats (active
// monthly rent + open AR + YTD income/expense).
//
// One endpoint powers the new PropertiesPage so it doesn't have to
// fan out N+1 queries from the client.

import { and, eq, gte, inArray, sql } from 'drizzle-orm';
import {
  withAdminHandler,
  getDefaultOrgId,
} from '../../lib/adminHelpers.js';
import { getDb, schema } from '../../lib/db/index.js';

// Maintenance ticket statuses considered "still open" — anything not
// in completed / cancelled. Matches the open-WO concept the
// Properties drilldown surfaces in its KPI strip.
const OPEN_MAINTENANCE_STATUSES = [
  'new', 'triage', 'assigned', 'in_progress',
  'awaiting_parts', 'awaiting_tenant',
];

export default withAdminHandler(async (req, res) => {
  if (req.method !== 'GET') {
    return res.status(405).json({ ok: false, error: 'GET only' });
  }
  const db = getDb();
  const organizationId = await getDefaultOrgId();
  const yearStart = `${new Date().getUTCFullYear()}-01-01`;

  // ── Properties ─────────────────────────────────────────────────
  const propRows = await db
    .select({
      id: schema.properties.id,
      displayName: schema.properties.displayName,
      propertyType: schema.properties.propertyType,
      addressLine1: schema.properties.serviceAddressLine1,
      addressLine2: schema.properties.serviceAddressLine2,
      city: schema.properties.serviceCity,
      state: schema.properties.serviceState,
      zip: schema.properties.serviceZip,
      ownerId: schema.properties.ownerId,
      ownerLegalName: schema.owners.legalName,
      entityId: schema.properties.entityId,
      entityName: schema.entities.name,
      sourcePropertyId: schema.properties.sourcePropertyId,
      sourcePms: schema.properties.sourcePms,
    })
    .from(schema.properties)
    .leftJoin(schema.owners, eq(schema.properties.ownerId, schema.owners.id))
    .leftJoin(schema.entities, eq(schema.properties.entityId, schema.entities.id))
    .where(eq(schema.properties.organizationId, organizationId))
    .orderBy(schema.properties.displayName);

  // ── Units (with active lease + primary tenant) ──────────────
  // One row per unit. If a unit has an active lease, attach its
  // rent + tenant. We pull all leases (any status) and pick the
  // most recent active one per unit in JS.
  const unitRows = await db
    .select({
      unitId: schema.units.id,
      propertyId: schema.units.propertyId,
      sourceUnitName: schema.units.sourceUnitName,
      sourceUnitId: schema.units.sourceUnitId,
      sqft: schema.units.sqft,
      bedrooms: schema.units.bedrooms,
      bathrooms: schema.units.bathrooms,
    })
    .from(schema.units)
    .where(eq(schema.units.organizationId, organizationId));

  const leaseRows = await db
    .select({
      id: schema.leases.id,
      unitId: schema.leases.unitId,
      status: schema.leases.status,
      startDate: schema.leases.startDate,
      endDate: schema.leases.endDate,
      rentCents: schema.leases.rentCents,
    })
    .from(schema.leases)
    .where(eq(schema.leases.organizationId, organizationId));

  // Primary tenant per active lease.
  const leasePrimaryTenant = await db
    .select({
      leaseId: schema.leaseTenants.leaseId,
      tenantId: schema.leaseTenants.tenantId,
      tenantName: schema.tenants.displayName,
    })
    .from(schema.leaseTenants)
    .leftJoin(schema.tenants, eq(schema.leaseTenants.tenantId, schema.tenants.id))
    .where(eq(schema.leaseTenants.role, 'primary'));
  const tenantByLease = new Map(leasePrimaryTenant.map((r) => [r.leaseId, r.tenantName]));

  // Active leases indexed by unit_id (one per unit by status='active'
  // — DB doesn't enforce 1:1 but the AR flow does in practice).
  const activeLeaseByUnit = new Map();
  for (const l of leaseRows) {
    if (l.status === 'active') activeLeaseByUnit.set(l.unitId, l);
  }

  const unitsByProperty = new Map();
  for (const u of unitRows) {
    if (!unitsByProperty.has(u.propertyId)) unitsByProperty.set(u.propertyId, []);
    const lease = activeLeaseByUnit.get(u.unitId);
    unitsByProperty.get(u.propertyId).push({
      id: u.unitId,
      name: u.sourceUnitName || `Unit ${u.sourceUnitId || ''}`.trim(),
      source_unit_id: u.sourceUnitId,
      sqft: u.sqft,
      bedrooms: u.bedrooms,
      bathrooms: u.bathrooms,
      active_lease_id: lease?.id || null,
      lease_start_date: lease?.startDate || null,
      lease_end_date: lease?.endDate || null,
      monthly_rent_cents: lease?.rentCents || 0,
      tenant_name: lease ? tenantByLease.get(lease.id) || null : null,
      is_occupied: Boolean(lease),
    });
  }

  // ── Open AR per property ─────────────────────────────────────
  const arRows = await db
    .select({
      propertyId: schema.postedCharges.propertyId,
      openAr: sql`COALESCE(SUM(${schema.postedCharges.balanceCents}), 0)`.as('open_ar'),
    })
    .from(schema.postedCharges)
    .where(
      and(
        eq(schema.postedCharges.organizationId, organizationId),
        eq(schema.postedCharges.status, 'open'),
      ),
    )
    .groupBy(schema.postedCharges.propertyId);
  const openArByProperty = new Map(arRows.map((r) => [r.propertyId, Number(r.openAr)]));

  // ── YTD income + expense per property ───────────────────────
  const ytdRows = await db
    .select({
      propertyId: schema.journalLines.propertyId,
      accountType: schema.glAccounts.accountType,
      debitCents: sql`SUM(${schema.journalLines.debitCents})`.as('debit_cents'),
      creditCents: sql`SUM(${schema.journalLines.creditCents})`.as('credit_cents'),
    })
    .from(schema.journalLines)
    .innerJoin(
      schema.journalEntries,
      eq(schema.journalLines.journalEntryId, schema.journalEntries.id),
    )
    .innerJoin(
      schema.glAccounts,
      eq(schema.journalLines.glAccountId, schema.glAccounts.id),
    )
    .where(
      and(
        eq(schema.journalLines.organizationId, organizationId),
        eq(schema.journalEntries.status, 'posted'),
        gte(schema.journalEntries.entryDate, yearStart),
      ),
    )
    .groupBy(schema.journalLines.propertyId, schema.glAccounts.accountType);

  const ytdByProperty = new Map();
  for (const r of ytdRows) {
    if (!r.propertyId) continue;
    if (!ytdByProperty.has(r.propertyId)) {
      ytdByProperty.set(r.propertyId, { income: 0, expense: 0 });
    }
    const dr = Number(r.debitCents) || 0;
    const cr = Number(r.creditCents) || 0;
    const cell = ytdByProperty.get(r.propertyId);
    if (r.accountType === 'income') cell.income += cr - dr; // credit normal
    if (r.accountType === 'expense') cell.expense += dr - cr; // debit normal
  }

  // ── Open maintenance tickets per property ───────────────────
  const maintRows = await db
    .select({
      propertyId: schema.maintenanceTickets.propertyId,
      openCount: sql`COUNT(*)`.as('open_count'),
    })
    .from(schema.maintenanceTickets)
    .where(
      and(
        eq(schema.maintenanceTickets.organizationId, organizationId),
        inArray(schema.maintenanceTickets.status, OPEN_MAINTENANCE_STATUSES),
      ),
    )
    .groupBy(schema.maintenanceTickets.propertyId);
  const openMaintByProperty = new Map(
    maintRows.map((r) => [r.propertyId, Number(r.openCount)]),
  );

  // ── Assemble ─────────────────────────────────────────────────
  const properties = propRows.map((p) => {
    const units = unitsByProperty.get(p.id) || [];
    const occupiedCount = units.filter((u) => u.is_occupied).length;
    const totalMonthlyRentCents = units.reduce(
      (s, u) => s + (u.monthly_rent_cents || 0), 0,
    );
    const ytd = ytdByProperty.get(p.id) || { income: 0, expense: 0 };
    return {
      id: p.id,
      display_name: p.displayName,
      property_type: p.propertyType,
      address: {
        line1: p.addressLine1,
        line2: p.addressLine2,
        city: p.city,
        state: p.state,
        zip: p.zip,
      },
      owner_id: p.ownerId,
      owner_legal_name: p.ownerLegalName,
      entity_id: p.entityId,
      entity_name: p.entityName,
      source_property_id: p.sourcePropertyId,
      source_pms: p.sourcePms,
      unit_count: units.length,
      occupied_count: occupiedCount,
      vacant_count: units.length - occupiedCount,
      total_monthly_rent_cents: totalMonthlyRentCents,
      open_ar_cents: openArByProperty.get(p.id) || 0,
      open_maintenance_count: openMaintByProperty.get(p.id) || 0,
      ytd_income_cents: ytd.income,
      ytd_expense_cents: ytd.expense,
      ytd_net_cents: ytd.income - ytd.expense,
      units,
    };
  });

  return res.status(200).json({
    ok: true,
    organization_id: organizationId,
    count: properties.length,
    year_start: yearStart,
    properties,
  });
});
