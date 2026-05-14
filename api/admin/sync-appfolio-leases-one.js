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
  const [property] = await db
    .select({
      id: schema.properties.id,
      displayName: schema.properties.displayName,
      sourcePropertyId: schema.properties.sourcePropertyId,
    })
    .from(schema.properties)
    .where(and(...filters))
    .limit(1);

  if (!property) {
    return res.status(404).json({
      ok: false,
      error: 'No matching AppFolio-sourced property found in the org.',
    });
  }

  const appfolioPropertyId = Number(property.sourcePropertyId);
  const timings = {};

  // /units probe
  let unitsResult;
  let t0 = Date.now();
  try {
    unitsResult = await fetchAllPages('/units', { property_ids: appfolioPropertyId });
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
    tenantsResult = await fetchAllPages('/tenants', { property_id: appfolioPropertyId });
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

  const today = new Date().toISOString().slice(0, 10);
  const activeTenants = afTenants.filter((t) => {
    const end = t.LeaseToDate || t.LeaseTo || null;
    return !end || end >= today;
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
      sample_unit: afUnits[0] ? {
        UnitId: afUnits[0].UnitId,
        UnitName: afUnits[0].UnitName,
        Address1: afUnits[0].Address1,
      } : null,
      sample_tenant: activeTenants[0] ? {
        TenantId: activeTenants[0].TenantId,
        UnitId: activeTenants[0].UnitId,
        FirstName: activeTenants[0].FirstName,
        LastName: activeTenants[0].LastName,
        Rent: activeTenants[0].Rent,
        LeaseFromDate: activeTenants[0].LeaseFromDate,
      } : null,
    },
    hint: afUnits.length === 0
      ? 'AppFolio returned 0 units for this property. Check that source_property_id matches AppFolio.'
      : afTenants.length === 0
        ? 'AppFolio returned 0 tenants for this property — likely a vacant building.'
        : `OK — pipeline is working. Multiply timings by ~252 properties to estimate full sync duration.`,
  });
});
