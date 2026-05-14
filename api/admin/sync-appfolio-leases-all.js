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
import { recordHealth } from '../../lib/integrationHealth.js';

export const config = { maxDuration: 300 };

function isAppfolioConfigured() {
  return Boolean(
    process.env.APPFOLIO_CLIENT_ID &&
      process.env.APPFOLIO_CLIENT_SECRET &&
      process.env.APPFOLIO_DEVELOPER_ID,
  );
}

async function syncOneProperty(tx, organizationId, property) {
  // source_property_id is AppFolio's property Id — a UUID string,
  // not an integer. (It used to be a RentManager integer; migration
  // 0031 widened the column and the backfill rewrote the values.)
  const appfolioPropertyId = String(property.sourcePropertyId || '').trim();
  if (!appfolioPropertyId) {
    return { skipped: true, reason: 'missing source_property_id' };
  }

  // Pull units AND tenants for the property in parallel. Units pass
  // gives us AppFolio's UnitId → UnitName, which we use to match our
  // already-imported units by source_unit_name (since bulk-import
  // didn't populate source_unit_id). We also backfill source_unit_id
  // on our rows so subsequent syncs are fast.
  const [unitsResult, tenantsResult] = await Promise.all([
    fetchAllPages('/units', { property_ids: appfolioPropertyId }),
    fetchAllPages('/tenants', { property_id: appfolioPropertyId }),
  ]);
  if (unitsResult.error) throw new Error(`AppFolio /units: ${unitsResult.error}`);
  if (tenantsResult.error) throw new Error(`AppFolio /tenants: ${tenantsResult.error}`);
  const afUnits = unitsResult.data || [];
  const afTenants = tenantsResult.data || [];

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
      unit_ids_backfilled: 0,
    };
  }

  // Load our units for this property — both source_unit_id (if set)
  // and source_unit_name (always set by bulk-import).
  const ourUnits = await tx
    .select({
      id: schema.units.id,
      sourceUnitId: schema.units.sourceUnitId,
      sourceUnitName: schema.units.sourceUnitName,
    })
    .from(schema.units)
    .where(
      and(
        eq(schema.units.organizationId, organizationId),
        eq(schema.units.propertyId, property.id),
      ),
    );

  // Map approaches, in priority order:
  //   1. (already-set source_unit_id) → our unit_id  — exact match
  //   2. (source_unit_name) → our unit_id            — fallback for
  //      units imported via bulk CSV without an AppFolio UnitId
  const unitIdBySource = new Map();
  const ourUnitByName = new Map();
  for (const u of ourUnits) {
    if (u.sourceUnitId) unitIdBySource.set(String(u.sourceUnitId), u.id);
    if (u.sourceUnitName) ourUnitByName.set(String(u.sourceUnitName).trim(), u.id);
  }

  // Walk AppFolio's unit list, fill any gaps in the lookup, and
  // backfill source_unit_id on rows that matched by name.
  //
  // AppFolio's /units payload: the unit's own primary key is `Id`
  // (NOT `UnitId` — that's only on rows that REFERENCE a unit, like
  // tenants/work-orders). The display name is `Name` / `UnitNumber`
  // / `Address1`.
  let unitIdsBackfilled = 0;
  for (const au of afUnits) {
    const afUnitId = au.Id != null ? String(au.Id) : null;
    if (!afUnitId) continue;
    if (unitIdBySource.has(afUnitId)) continue;

    const candidateNames = [au.Name, au.UnitNumber, au.Address1, au.Address2]
      .filter(Boolean)
      .map((s) => String(s).trim());
    let matched = null;
    for (const name of candidateNames) {
      if (ourUnitByName.has(name)) { matched = ourUnitByName.get(name); break; }
    }
    if (matched) {
      unitIdBySource.set(afUnitId, matched);
      await tx
        .update(schema.units)
        .set({ sourceUnitId: afUnitId, updatedAt: new Date() })
        .where(eq(schema.units.id, matched));
      unitIdsBackfilled += 1;
    }
  }

  // SFR fallback: if the property has exactly one unit on each side
  // and name-matching didn't already pair them, match them anyway.
  // Single-family rentals frequently have a CSV unit name that
  // doesn't line up with AppFolio's (e.g. "" vs "Main" vs the street
  // address), but with a 1:1 mapping there's no ambiguity.
  if (afUnits.length === 1 && ourUnits.length === 1) {
    const onlyAfUnit = afUnits[0];
    const onlyAfId = onlyAfUnit.Id != null ? String(onlyAfUnit.Id) : null;
    const onlyOurUnit = ourUnits[0];
    if (onlyAfId && !unitIdBySource.has(onlyAfId)) {
      unitIdBySource.set(onlyAfId, onlyOurUnit.id);
      await tx
        .update(schema.units)
        .set({ sourceUnitId: onlyAfId, updatedAt: new Date() })
        .where(eq(schema.units.id, onlyOurUnit.id));
      unitIdsBackfilled += 1;
    }
  }

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
    unit_ids_backfilled: unitIdsBackfilled,
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
  let totalUnitIdsBackfilled = 0;
  let consecutive401s = 0;
  let aborted = false;
  let abortReason = null;

  // Soft throttle: 150ms gap between properties. Each property fires
  // 2 AppFolio calls (/units + /tenants), so this keeps us under ~13
  // req/sec — comfortably below AppFolio's ~10/sec rate ceiling once
  // overhead is factored in. fetchAllPages also honors Retry-After on
  // 429s as a safety net.
  const PROPERTY_DELAY_MS = 150;

  for (let i = 0; i < properties.length; i += 1) {
    const property = properties[i];
    if (i > 0) {
      await new Promise((resolve) => setTimeout(resolve, PROPERTY_DELAY_MS));
    }
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
      totalUnitIdsBackfilled += summary.unit_ids_backfilled || 0;
      consecutive401s = 0;
      await recordHealth(organizationId, 'appfolio_database', 'AppFolio (Database API)', { ok: true });
    } catch (err) {
      const msg = err.message || String(err);
      results.push({
        property_id: property.id,
        display_name: property.displayName,
        source_property_id: property.sourcePropertyId,
        error: msg,
      });
      await recordHealth(organizationId, 'appfolio_database', 'AppFolio (Database API)', { ok: false, error: msg });
      // Circuit-breaker: if AppFolio returns 401 (auth failure) or
      // 429 (rate limit) repeatedly, stop hammering and surface the
      // error to the UI. A handful of bad creds shouldn't cost us
      // 250 wasted calls + a rate-limit cooldown.
      if (/\b401\b|\b429\b/.test(msg)) {
        consecutive401s += 1;
        if (consecutive401s >= 3) {
          aborted = true;
          abortReason = `Aborted after ${consecutive401s} consecutive AppFolio ${msg.includes('429') ? '429' : '401'} responses. Fix credentials (run /api/admin/debug-appfolio-auth) before retrying.`;
          break;
        }
      } else {
        consecutive401s = 0;
      }
    }
  }

  const processed = results.length;
  const nextOffset = offset + processed;
  return res.status(200).json({
    ok: !aborted,
    organization_id: organizationId,
    processed,
    offset,
    next_offset: nextOffset,
    total_properties: total,
    has_more: !aborted && nextOffset < total,
    aborted,
    abort_reason: abortReason,
    totals: {
      tenants_upserted: totalTenants,
      leases_upserted: totalLeases,
      leases_skipped_no_unit: totalSkippedNoUnit,
      unit_ids_backfilled: totalUnitIdsBackfilled,
    },
    results,
  });
});
