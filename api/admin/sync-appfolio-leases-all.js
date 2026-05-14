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

import { and, eq, ne, isNotNull, asc } from 'drizzle-orm';
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

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function syncOneProperty(tx, organizationId, property) {
  // source_property_id is AppFolio's property Id — a UUID string.
  // AppFolio's filters[PropertyId] 422s on anything non-UUID, so a
  // property whose id the backfill couldn't match (still holding its
  // old RentManager integer) is skipped cleanly instead of erroring.
  const appfolioPropertyId = String(property.sourcePropertyId || '').trim();
  if (!appfolioPropertyId) {
    return { skipped: true, reason: 'missing source_property_id' };
  }
  if (!UUID_RE.test(appfolioPropertyId)) {
    return { skipped: true, reason: 'source_property_id is not a UUID (un-backfilled property)' };
  }

  // Pull units AND tenants for this property in parallel.
  //
  // AppFolio's Database API filters use `filters[FieldName]` syntax.
  // Both /units and /tenants rows carry a `PropertyId` field, so we
  // scope each call with filters[PropertyId]. (Bare `property_ids` /
  // `property_id` params are silently ignored — that made every call
  // return the ENTIRE dataset, which is why the sync was slow and
  // unit-matching kept missing.)
  const [unitsResult, tenantsResult] = await Promise.all([
    fetchAllPages('/units', { 'filters[PropertyId]': appfolioPropertyId }),
    fetchAllPages('/tenants', { 'filters[PropertyId]': appfolioPropertyId }),
  ]);
  if (unitsResult.error) throw new Error(`AppFolio /units: ${unitsResult.error}`);
  if (tenantsResult.error) throw new Error(`AppFolio /tenants: ${tenantsResult.error}`);
  const afUnits = unitsResult.data || [];
  const afTenants = tenantsResult.data || [];

  // Occupancy is driven entirely off the UNIT's CurrentOccupancyId —
  // AppFolio's authoritative "this unit is occupied by this tenancy."
  // We do NOT pre-filter tenants by their individual Status: the
  // /tenants endpoint returns every tenant across every occupancy a
  // unit has ever had, and a unit's *current* occupant can have a
  // Status like 'Eviction' (still living there) that a Status
  // allow-list would wrongly drop. Matching OccupancyId ===
  // CurrentOccupancyId gives exactly one lease per occupied unit.
  if (afTenants.length === 0) {
    return {
      property_id: property.id,
      tenants_seen: 0,
      tenants_upserted: 0,
      tenants_skipped_not_current: 0,
      leases_upserted: 0,
      leases_ended: 0,
      leases_skipped_no_unit: 0,
      leases_skipped_no_start: 0,
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
  //
  // The DB write of source_unit_id is just a caching optimization —
  // unitIdBySource (in-memory) is what actually resolves leases. So
  // when a write would collide with units_org_source_unit_unique
  // (the same AppFolio unit id already on another row, or this row
  // already claimed), skip the write but keep the in-memory mapping.
  let unitIdsBackfilled = 0;
  const assignedOurUnitIds = new Set();

  async function tryBackfillSourceUnitId(ourUnitId, afUnitId) {
    if (assignedOurUnitIds.has(ourUnitId)) return; // already wrote this row
    const [collision] = await tx
      .select({ id: schema.units.id })
      .from(schema.units)
      .where(
        and(
          eq(schema.units.organizationId, organizationId),
          eq(schema.units.sourceUnitId, afUnitId),
        ),
      )
      .limit(1);
    if (collision && collision.id !== ourUnitId) return; // someone else owns it
    if (collision && collision.id === ourUnitId) {
      assignedOurUnitIds.add(ourUnitId);
      return; // already correct, no write needed
    }
    await tx
      .update(schema.units)
      .set({ sourceUnitId: afUnitId, updatedAt: new Date() })
      .where(eq(schema.units.id, ourUnitId));
    assignedOurUnitIds.add(ourUnitId);
    unitIdsBackfilled += 1;
  }

  // AppFolio's unit object carries CurrentOccupancyId — the one
  // occupancy that is the unit's *current* tenancy. AppFolio's
  // /tenants endpoint returns tenants across ALL occupancies of a
  // unit (historical included), so without this we'd create a lease
  // per past occupancy. Keyed by AppFolio unit Id.
  const currentOccupancyByAfUnit = new Map();
  for (const au of afUnits) {
    const afUnitId = au.Id != null ? String(au.Id) : null;
    if (afUnitId && au.CurrentOccupancyId) {
      currentOccupancyByAfUnit.set(afUnitId, String(au.CurrentOccupancyId));
    }
  }

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
      await tryBackfillSourceUnitId(matched, afUnitId);
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
      await tryBackfillSourceUnitId(onlyOurUnit.id, onlyAfId);
    }
  }

  let tenantsUpserted = 0;
  let leasesUpserted = 0;
  let leasesSkippedNoUnit = 0;
  let leasesSkippedNoStart = 0;
  let tenantsSkippedNotCurrent = 0;

  for (const t of afTenants) {
    // Resolve the unit, then gate strictly on the current occupancy.
    // AppFolio's /tenants returns tenants across every occupancy a
    // unit has ever had; only the unit's CurrentOccupancyId is the
    // live tenancy. A tenant whose OccupancyId isn't the unit's
    // current one is historical — skip it (no tenant row, no lease).
    // This gives exactly one lease per occupied unit, with its
    // current tenant(s) linked.
    const unitId = unitIdBySource.get(String(t.UnitId));
    if (!unitId) {
      leasesSkippedNoUnit += 1;
      continue;
    }
    const currentOcc = currentOccupancyByAfUnit.get(String(t.UnitId));
    if (!currentOcc || String(t.OccupancyId) !== currentOcc) {
      tenantsSkippedNotCurrent += 1;
      continue;
    }

    // AppFolio's tenant primary key is `Id`. OccupancyId is the
    // shared lease/occupancy key — falling back to it would collapse
    // two roommates into one tenant row.
    const sourceTenantId = String(t.Id || t.OccupancyId || '');
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

    // AppFolio tenant lease fields: LeaseStartDate / LeaseEndDate /
    // CurrentRent. Fall back to MoveInOn for the start when a tenant
    // predates structured lease data.
    const startDate = t.LeaseStartDate || t.MoveInOn || null;
    const endDate = t.LeaseEndDate || null;
    const rent = t.CurrentRent || t.MarketRent || 0;
    const rentCents = Math.round(Number(rent) * 100);
    if (!startDate) {
      leasesSkippedNoStart += 1;
      continue;
    }

    // One lease per AppFolio occupancy — roommates share an
    // OccupancyId and get linked to the same lease via lease_tenants.
    const sourceLeaseId = String(t.OccupancyId || t.Id);
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

  // Stale-lease cleanup. A prior buggy run created an 'active' lease
  // per historical occupancy. For every unit we resolved, mark any
  // 'active' AppFolio lease whose source_lease_id isn't the unit's
  // current occupancy as 'ended' — and end ALL active AppFolio
  // leases on units AppFolio now reports as vacant (no current
  // occupancy). This converges the DB to exactly one active lease
  // per occupied unit, even on a re-run.
  let leasesEnded = 0;
  for (const [afUnitId, ourUnitId] of unitIdBySource) {
    const currentOcc = currentOccupancyByAfUnit.get(afUnitId) || null;
    const conds = [
      eq(schema.leases.organizationId, organizationId),
      eq(schema.leases.unitId, ourUnitId),
      eq(schema.leases.status, 'active'),
      eq(schema.leases.sourcePms, 'appfolio'),
    ];
    // Occupied unit: end every active lease except the current one.
    // Vacant unit (no currentOcc): end them all.
    if (currentOcc) conds.push(ne(schema.leases.sourceLeaseId, currentOcc));
    const ended = await tx
      .update(schema.leases)
      .set({ status: 'ended', updatedAt: new Date() })
      .where(and(...conds))
      .returning({ id: schema.leases.id });
    leasesEnded += ended.length;
  }

  return {
    property_id: property.id,
    tenants_seen: afTenants.length,
    tenants_upserted: tenantsUpserted,
    tenants_skipped_not_current: tenantsSkippedNotCurrent,
    leases_upserted: leasesUpserted,
    leases_ended: leasesEnded,
    leases_skipped_no_unit: leasesSkippedNoUnit,
    leases_skipped_no_start: leasesSkippedNoStart,
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
  // Default batch of 10 (was 25). Each property fires 2 AppFolio
  // calls + collision-check SELECTs + a 150ms throttle, and a 429
  // can trigger retry waits — 25 could blow past Vercel's 300s cap
  // and the function dies returning nothing (UI stuck at "0/0").
  const limit = Math.min(Math.max(parseInt(body.limit, 10) || 10, 1), 100);
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
  let totalLeasesEnded = 0;
  let totalSkippedNoUnit = 0;
  let totalSkippedNoStart = 0;
  let totalTenantsSkippedNotCurrent = 0;
  let totalUnitIdsBackfilled = 0;
  let consecutive401s = 0;
  let aborted = false;
  let abortReason = null;
  let timedOut = false;

  // Wall-clock budget. Vercel kills the function at 300s with no
  // response — return early at 240s so the UI gets a partial result
  // and continues the loop with the next offset instead of hanging
  // on "0/0".
  const startedAt = Date.now();
  const TIME_BUDGET_MS = 240_000;

  // Soft throttle: 150ms gap between properties. Each property fires
  // 2 AppFolio calls (/units + /tenants), so this keeps us under ~13
  // req/sec — comfortably below AppFolio's ~10/sec rate ceiling once
  // overhead is factored in. fetchAllPages also honors Retry-After on
  // 429s as a safety net.
  const PROPERTY_DELAY_MS = 150;

  for (let i = 0; i < properties.length; i += 1) {
    if (Date.now() - startedAt > TIME_BUDGET_MS) {
      timedOut = true;
      break;
    }
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
      totalLeasesEnded += summary.leases_ended || 0;
      totalSkippedNoUnit += summary.leases_skipped_no_unit || 0;
      totalSkippedNoStart += summary.leases_skipped_no_start || 0;
      totalTenantsSkippedNotCurrent += summary.tenants_skipped_not_current || 0;
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
    // timedOut still has_more — the UI just continues with nextOffset.
    has_more: !aborted && nextOffset < total,
    aborted,
    abort_reason: abortReason,
    timed_out: timedOut,
    totals: {
      tenants_upserted: totalTenants,
      tenants_skipped_not_current: totalTenantsSkippedNotCurrent,
      leases_upserted: totalLeases,
      leases_ended: totalLeasesEnded,
      leases_skipped_no_unit: totalSkippedNoUnit,
      leases_skipped_no_start: totalSkippedNoStart,
      unit_ids_backfilled: totalUnitIdsBackfilled,
    },
    results,
  });
});
