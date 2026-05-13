// POST /api/admin/sync-appfolio-leases-all?secret=<TOKEN>
// body: {
//   limit?:  integer (default 25)   — properties per batch
//   offset?: integer (default 0)    — pagination cursor
// }
//
// Loops over every property in our org that has source_pms='appfolio'
// + source_property_id set, pulls AppFolio /tenants?property_id=<id>
// for each, and upserts active tenants + leases + lease_tenants into
// our canonical tables.
//
// Batched because Vercel functions cap at 300s and each property is
// one AppFolio API call. The UI calls this in a loop with rolling
// offset until { has_more: false }.

import { and, eq, isNotNull, asc } from 'drizzle-orm';
import {
  withAdminHandler,
  getDefaultOrgId,
  parseBody,
} from '../../lib/adminHelpers.js';
import { getDb, schema } from '../../lib/db/index.js';
import { fetchAllPages } from '../../lib/backends/appfolio.js';

export const config = { maxDuration: 300 };

function isAppfolioConfigured() {
  return Boolean(
    process.env.APPFOLIO_CLIENT_ID &&
      process.env.APPFOLIO_CLIENT_SECRET &&
      process.env.APPFOLIO_DEVELOPER_ID,
  );
}

async function syncOneProperty(tx, organizationId, property) {
  const appfolioPropertyId = Number(property.sourcePropertyId);
  if (!Number.isInteger(appfolioPropertyId) || appfolioPropertyId <= 0) {
    return { skipped: true, reason: 'invalid source_property_id' };
  }

  const tenantsResult = await fetchAllPages('/tenants', { property_id: appfolioPropertyId });
  const afTenants = tenantsResult.rows || [];

  const today = new Date().toISOString().slice(0, 10);
  const activeTenants = afTenants.filter((t) => {
    const end = t.LeaseToDate || t.LeaseTo || null;
    return !end || end >= today;
  });

  if (activeTenants.length === 0) {
    return {
      property_id: property.id,
      tenants_seen: afTenants.length,
      active_tenants: 0,
      tenants_upserted: 0,
      leases_upserted: 0,
      leases_skipped_no_unit: 0,
    };
  }

  // Map AppFolio UnitId → our unit_id (units must already exist; bulk-import
  // populated them with source_unit_id from AppFolio).
  const ourUnits = await tx
    .select({ id: schema.units.id, sourceUnitId: schema.units.sourceUnitId })
    .from(schema.units)
    .where(
      and(
        eq(schema.units.organizationId, organizationId),
        eq(schema.units.propertyId, property.id),
      ),
    );
  const unitIdBySource = new Map(
    ourUnits.filter((u) => u.sourceUnitId).map((u) => [String(u.sourceUnitId), u.id]),
  );

  let tenantsUpserted = 0;
  let leasesUpserted = 0;
  let leasesSkippedNoUnit = 0;

  for (const t of activeTenants) {
    const sourceTenantId = String(t.TenantId || t.OccupancyId || '');
    if (!sourceTenantId) continue;

    const firstName = t.FirstName || null;
    const lastName = t.LastName || null;
    const displayName = [firstName, lastName].filter(Boolean).join(' ') || `Tenant ${sourceTenantId}`;

    const [existingTenant] = await tx
      .select({ id: schema.tenants.id })
      .from(schema.tenants)
      .where(
        and(
          eq(schema.tenants.organizationId, organizationId),
          eq(schema.tenants.sourceTenantId, sourceTenantId),
        ),
      )
      .limit(1);

    const tenantValues = {
      organizationId,
      firstName,
      lastName,
      displayName,
      email: t.Email || null,
      phone: t.PhoneNumber || t.Phone || null,
      mobilePhone: t.MobilePhone || null,
      sourceTenantId,
      sourcePms: 'appfolio',
      updatedAt: new Date(),
    };

    let tenantId;
    if (existingTenant) {
      await tx
        .update(schema.tenants)
        .set(tenantValues)
        .where(eq(schema.tenants.id, existingTenant.id));
      tenantId = existingTenant.id;
    } else {
      const [inserted] = await tx
        .insert(schema.tenants)
        .values(tenantValues)
        .returning({ id: schema.tenants.id });
      tenantId = inserted.id;
    }
    tenantsUpserted += 1;

    const unitId = unitIdBySource.get(String(t.UnitId));
    if (!unitId) {
      leasesSkippedNoUnit += 1;
      continue;
    }

    const startDate = t.LeaseFromDate || t.LeaseFrom || null;
    const endDate = t.LeaseToDate || t.LeaseTo || null;
    const rent = t.Rent || t.MonthlyRent || 0;
    const rentCents = Math.round(Number(rent) * 100);
    if (!startDate) continue;

    const sourceLeaseId = String(t.OccupancyId || t.TenantId);
    const [existingLease] = await tx
      .select({ id: schema.leases.id })
      .from(schema.leases)
      .where(
        and(
          eq(schema.leases.organizationId, organizationId),
          eq(schema.leases.sourceLeaseId, sourceLeaseId),
        ),
      )
      .limit(1);

    const leaseValues = {
      organizationId,
      unitId,
      leaseNumber: `AF-${sourceLeaseId}`,
      status: 'active',
      startDate,
      endDate: endDate || null,
      rentCents,
      rentDueDay: 1,
      securityDepositCents: Math.round(Number(t.SecurityDeposit || 0) * 100),
      sourceLeaseId,
      sourcePms: 'appfolio',
      updatedAt: new Date(),
    };

    let leaseId;
    if (existingLease) {
      await tx
        .update(schema.leases)
        .set(leaseValues)
        .where(eq(schema.leases.id, existingLease.id));
      leaseId = existingLease.id;
    } else {
      const [inserted] = await tx
        .insert(schema.leases)
        .values(leaseValues)
        .returning({ id: schema.leases.id });
      leaseId = inserted.id;
    }
    leasesUpserted += 1;

    await tx
      .insert(schema.leaseTenants)
      .values({ leaseId, tenantId })
      .onConflictDoNothing();
  }

  return {
    property_id: property.id,
    tenants_seen: afTenants.length,
    active_tenants: activeTenants.length,
    tenants_upserted: tenantsUpserted,
    leases_upserted: leasesUpserted,
    leases_skipped_no_unit: leasesSkippedNoUnit,
  };
}

export default withAdminHandler(async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'POST only' });
  }
  if (!isAppfolioConfigured()) {
    return res.status(503).json({
      ok: false,
      error: 'AppFolio not configured (APPFOLIO_CLIENT_ID / APPFOLIO_CLIENT_SECRET / APPFOLIO_DEVELOPER_ID).',
    });
  }

  const body = parseBody(req);
  const limit = Math.min(Math.max(parseInt(body.limit, 10) || 25, 1), 100);
  const offset = Math.max(parseInt(body.offset, 10) || 0, 0);

  const db = getDb();
  const organizationId = await getDefaultOrgId();

  const properties = await db
    .select({
      id: schema.properties.id,
      displayName: schema.properties.displayName,
      sourcePropertyId: schema.properties.sourcePropertyId,
    })
    .from(schema.properties)
    .where(
      and(
        eq(schema.properties.organizationId, organizationId),
        eq(schema.properties.sourcePms, 'appfolio'),
        isNotNull(schema.properties.sourcePropertyId),
      ),
    )
    .orderBy(asc(schema.properties.displayName))
    .limit(limit)
    .offset(offset);

  // Total count for has_more calc — separate query, same filter.
  const totalRows = await db
    .select({ id: schema.properties.id })
    .from(schema.properties)
    .where(
      and(
        eq(schema.properties.organizationId, organizationId),
        eq(schema.properties.sourcePms, 'appfolio'),
        isNotNull(schema.properties.sourcePropertyId),
      ),
    );
  const total = totalRows.length;

  const results = [];
  let totalTenants = 0;
  let totalLeases = 0;
  let totalSkippedNoUnit = 0;

  for (const property of properties) {
    try {
      const summary = await db.transaction((tx) => syncOneProperty(tx, organizationId, property));
      results.push({
        property_id: property.id,
        display_name: property.displayName,
        source_property_id: property.sourcePropertyId,
        ...summary,
      });
      totalTenants += summary.tenants_upserted || 0;
      totalLeases += summary.leases_upserted || 0;
      totalSkippedNoUnit += summary.leases_skipped_no_unit || 0;
    } catch (err) {
      results.push({
        property_id: property.id,
        display_name: property.displayName,
        source_property_id: property.sourcePropertyId,
        error: err.message || String(err),
      });
    }
  }

  const nextOffset = offset + properties.length;
  return res.status(200).json({
    ok: true,
    organization_id: organizationId,
    processed: properties.length,
    offset,
    next_offset: nextOffset,
    total_properties: total,
    has_more: nextOffset < total,
    totals: {
      tenants_upserted: totalTenants,
      leases_upserted: totalLeases,
      leases_skipped_no_unit: totalSkippedNoUnit,
    },
    results,
  });
});
