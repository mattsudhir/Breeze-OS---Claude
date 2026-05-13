// GET /api/admin/debug-leases-state?secret=<TOKEN>
//
// Snapshot the current state of the directory tables so we can
// diagnose why the Properties page shows 0% occupancy.
//
// Returns counts + sample rows for properties / units / leases /
// tenants / lease_tenants — broken down so we can spot which
// step of the sync didn't land.

import { and, eq, isNotNull, isNull, sql } from 'drizzle-orm';
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

  const [
    propTotalRow,
    propWithSourceRow,
    unitTotalRow,
    unitWithSourceIdRow,
    unitWithSourceNameRow,
    leaseTotalRow,
    leaseActiveRow,
    leaseFromAfRow,
    tenantTotalRow,
    tenantFromAfRow,
    leaseTenantTotalRow,
  ] = await Promise.all([
    db.select({ c: sql`COUNT(*)`.as('c') })
      .from(schema.properties)
      .where(eq(schema.properties.organizationId, organizationId)),
    db.select({ c: sql`COUNT(*)`.as('c') })
      .from(schema.properties)
      .where(and(
        eq(schema.properties.organizationId, organizationId),
        isNotNull(schema.properties.sourcePropertyId),
      )),
    db.select({ c: sql`COUNT(*)`.as('c') })
      .from(schema.units)
      .where(eq(schema.units.organizationId, organizationId)),
    db.select({ c: sql`COUNT(*)`.as('c') })
      .from(schema.units)
      .where(and(
        eq(schema.units.organizationId, organizationId),
        isNotNull(schema.units.sourceUnitId),
      )),
    db.select({ c: sql`COUNT(*)`.as('c') })
      .from(schema.units)
      .where(and(
        eq(schema.units.organizationId, organizationId),
        isNotNull(schema.units.sourceUnitName),
      )),
    db.select({ c: sql`COUNT(*)`.as('c') })
      .from(schema.leases)
      .where(eq(schema.leases.organizationId, organizationId)),
    db.select({ c: sql`COUNT(*)`.as('c') })
      .from(schema.leases)
      .where(and(
        eq(schema.leases.organizationId, organizationId),
        eq(schema.leases.status, 'active'),
      )),
    db.select({ c: sql`COUNT(*)`.as('c') })
      .from(schema.leases)
      .where(and(
        eq(schema.leases.organizationId, organizationId),
        eq(schema.leases.sourcePms, 'appfolio'),
      )),
    db.select({ c: sql`COUNT(*)`.as('c') })
      .from(schema.tenants)
      .where(eq(schema.tenants.organizationId, organizationId)),
    db.select({ c: sql`COUNT(*)`.as('c') })
      .from(schema.tenants)
      .where(and(
        eq(schema.tenants.organizationId, organizationId),
        eq(schema.tenants.sourcePms, 'appfolio'),
      )),
    db.select({ c: sql`COUNT(*)`.as('c') })
      .from(schema.leaseTenants),
  ]);

  // Per-status lease breakdown
  const leasesByStatus = await db
    .select({ status: schema.leases.status, count: sql`COUNT(*)`.as('count') })
    .from(schema.leases)
    .where(eq(schema.leases.organizationId, organizationId))
    .groupBy(schema.leases.status);

  // Sample 5 leases (most recently created)
  const sampleLeases = await db
    .select({
      id: schema.leases.id,
      leaseNumber: schema.leases.leaseNumber,
      status: schema.leases.status,
      startDate: schema.leases.startDate,
      endDate: schema.leases.endDate,
      rentCents: schema.leases.rentCents,
      unitId: schema.leases.unitId,
      sourceLeaseId: schema.leases.sourceLeaseId,
      sourcePms: schema.leases.sourcePms,
      createdAt: schema.leases.createdAt,
    })
    .from(schema.leases)
    .where(eq(schema.leases.organizationId, organizationId))
    .orderBy(sql`${schema.leases.createdAt} DESC`)
    .limit(5);

  // Sample 5 units with source IDs to see if backfill happened
  const sampleUnits = await db
    .select({
      id: schema.units.id,
      sourceUnitId: schema.units.sourceUnitId,
      sourceUnitName: schema.units.sourceUnitName,
      propertyId: schema.units.propertyId,
    })
    .from(schema.units)
    .where(and(
      eq(schema.units.organizationId, organizationId),
      isNotNull(schema.units.sourceUnitName),
    ))
    .orderBy(sql`${schema.units.updatedAt} DESC`)
    .limit(5);

  // Units that DON'T have source_unit_id (could not be backfilled)
  const unitsMissingSourceId = await db
    .select({ c: sql`COUNT(*)`.as('c') })
    .from(schema.units)
    .where(and(
      eq(schema.units.organizationId, organizationId),
      isNull(schema.units.sourceUnitId),
    ));

  return res.status(200).json({
    ok: true,
    organization_id: organizationId,
    counts: {
      properties_total: Number(propTotalRow[0].c),
      properties_with_source_id: Number(propWithSourceRow[0].c),
      units_total: Number(unitTotalRow[0].c),
      units_with_source_unit_id: Number(unitWithSourceIdRow[0].c),
      units_with_source_unit_name: Number(unitWithSourceNameRow[0].c),
      units_missing_source_unit_id: Number(unitsMissingSourceId[0].c),
      leases_total: Number(leaseTotalRow[0].c),
      leases_active: Number(leaseActiveRow[0].c),
      leases_from_appfolio: Number(leaseFromAfRow[0].c),
      tenants_total: Number(tenantTotalRow[0].c),
      tenants_from_appfolio: Number(tenantFromAfRow[0].c),
      lease_tenants_total: Number(leaseTenantTotalRow[0].c),
    },
    leases_by_status: leasesByStatus.map((r) => ({ status: r.status, count: Number(r.count) })),
    sample_leases: sampleLeases,
    sample_units_with_name: sampleUnits,
  });
});
