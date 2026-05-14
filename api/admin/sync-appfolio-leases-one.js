// POST /api/admin/sync-appfolio-leases-one?secret=<TOKEN>
// body: { property_id?: uuid, source_property_id?: integer }
//
// Smoke-test for the lease sync pipeline. Picks ONE property
// (either by our DB id, or by AppFolio source_property_id, or the
// first one in the org) and runs the same syncOneProperty logic
// the bulk endpoint uses — but for a single property only. Returns
// in seconds with full per-step counts so you can verify the
// pipeline before committing to a 252-property batch run.
//
// Also returns timing data per AppFolio call so we can see whether
// "hanging" is auth, response size, or our own logic.

import { and, eq, isNotNull } from 'drizzle-orm';
import {
  withAdminHandler,
  getDefaultOrgId,
  parseBody,
} from '../../lib/adminHelpers.js';
import { getDb, schema } from '../../lib/db/index.js';
import { fetchAllPages } from '../../lib/backends/appfolio.js';
import { recordHealth } from '../../lib/integrationHealth.js';

export const config = { maxDuration: 60 };

export default withAdminHandler(async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'POST only' });
  }
  const body = parseBody(req);
  const db = getDb();
  const organizationId = await getDefaultOrgId();

  // Pick the property to test.
  const filters = [
    eq(schema.properties.organizationId, organizationId),
    eq(schema.properties.sourcePms, 'appfolio'),
    isNotNull(schema.properties.sourcePropertyId),
  ];
  if (body.property_id) {
    filters.push(eq(schema.properties.id, body.property_id));
  } else if (body.source_property_id) {
    filters.push(eq(schema.properties.sourcePropertyId, String(body.source_property_id)));
  }
  // Pull a handful and pick the first whose source_property_id is a
  // real UUID — AppFolio's filters[PropertyId] 422s on non-UUID
  // values (e.g. the one property the backfill couldn't match, which
  // still holds its old RentManager integer). When the caller names
  // a specific property we honor it as-is.
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const candidates = await db
    .select({
      id: schema.properties.id,
      displayName: schema.properties.displayName,
      sourcePropertyId: schema.properties.sourcePropertyId,
    })
    .from(schema.properties)
    .where(and(...filters))
    .limit(body.property_id || body.source_property_id ? 1 : 50);

  const property = (body.property_id || body.source_property_id)
    ? candidates[0]
    : candidates.find((p) => UUID_RE.test(String(p.sourcePropertyId || '').trim()))
      || candidates[0];

  if (!property) {
    return res.status(404).json({
      ok: false,
      error: 'No matching AppFolio-sourced property found in the org.',
    });
  }

  // source_property_id is AppFolio's property Id (a UUID string).
  const appfolioPropertyId = String(property.sourcePropertyId || '').trim();
  const timings = {};
  if (!UUID_RE.test(appfolioPropertyId)) {
    return res.status(200).json({
      ok: false,
      property: {
        id: property.id,
        display_name: property.displayName,
        source_property_id: property.sourcePropertyId,
      },
      error: 'This property\'s source_property_id is not a UUID — the backfill could not match it to AppFolio. Run the property-ID backfill, or pick a different property.',
    });
  }

  // /units probe
  let unitsResult;
  let t0 = Date.now();
  try {
    unitsResult = await fetchAllPages('/units', { 'filters[PropertyId]': appfolioPropertyId });
  } catch (err) {
    await recordHealth(organizationId, 'appfolio_database', 'AppFolio (Database API)', { ok: false, error: err.message });
    return res.status(502).json({ ok: false, stage: 'units', error: err.message, ms: Date.now() - t0 });
  }
  timings.units_ms = Date.now() - t0;
  if (unitsResult.error) {
    await recordHealth(organizationId, 'appfolio_database', 'AppFolio (Database API)', { ok: false, error: unitsResult.error });
    return res.status(502).json({ ok: false, stage: 'units', error: unitsResult.error, ms: timings.units_ms });
  }
  const afUnits = unitsResult.data || [];

  // /tenants probe
  let tenantsResult;
  t0 = Date.now();
  try {
    tenantsResult = await fetchAllPages('/tenants', { 'filters[PropertyId]': appfolioPropertyId });
  } catch (err) {
    await recordHealth(organizationId, 'appfolio_database', 'AppFolio (Database API)', { ok: false, error: err.message });
    return res.status(502).json({ ok: false, stage: 'tenants', error: err.message, ms: Date.now() - t0 });
  }
  timings.tenants_ms = Date.now() - t0;
  if (tenantsResult.error) {
    await recordHealth(organizationId, 'appfolio_database', 'AppFolio (Database API)', { ok: false, error: tenantsResult.error });
    return res.status(502).json({ ok: false, stage: 'tenants', error: tenantsResult.error, ms: timings.tenants_ms });
  }
  const afTenants = tenantsResult.data || [];

  await recordHealth(organizationId, 'appfolio_database', 'AppFolio (Database API)', { ok: true });

  // Active = AppFolio Status 'Current'/'Notice' (authoritative), or
  // no Status + not moved out. Mirrors sync-appfolio-leases-all.
  const activeTenants = afTenants.filter((t) => {
    const status = String(t.Status || '').toLowerCase();
    if (status === 'current' || status === 'notice') return true;
    if (!t.Status && !t.MoveOutOn && !t.MoveOutDate) return true;
    return false;
  });

  return res.status(200).json({
    ok: true,
    organization_id: organizationId,
    property: {
      id: property.id,
      display_name: property.displayName,
      source_property_id: property.sourcePropertyId,
    },
    timings,
    appfolio: {
      units_returned: afUnits.length,
      tenants_returned: afTenants.length,
      active_tenants: activeTenants.length,
      // Raw key lists + full first rows — so we can see AppFolio's
      // actual field names instead of guessing (the lease sync keeps
      // missing on lease-date / rent field names).
      raw_unit_keys: afUnits[0] ? Object.keys(afUnits[0]) : [],
      raw_tenant_keys: afTenants[0] ? Object.keys(afTenants[0]) : [],
      raw_sample_unit: afUnits[0] || null,
      raw_sample_tenant: afTenants[0] || null,
    },
    hint: afUnits.length === 0
      ? 'AppFolio returned 0 units for this property. Check that source_property_id matches AppFolio.'
      : afTenants.length === 0
        ? 'AppFolio returned 0 tenants for this property — likely a vacant building.'
        : `OK — pipeline is working. Multiply timings by ~252 properties to estimate full sync duration.`,
  });
});
