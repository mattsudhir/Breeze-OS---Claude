// POST /api/admin/import-appfolio-units?secret=<TOKEN>
//
// Imports every rentable unit straight from AppFolio's /units endpoint.
// source_unit_id is AppFolio's own Id (UUID) from the first write, and
// property_id is resolved against the properties imported by
// import-appfolio-properties (matched on source_property_id). No
// name-matching, no backfill, no reconciliation.
//
// NonRevenue units (common areas, model units, offices — AppFolio's
// NonRevenue=true flag) are skipped: they aren't leasable, so counting
// them would distort occupancy. This matches the customer's CSV import
// and keeps 'units' meaning 'rentable units'.
//
// Idempotent: upserts on (organization_id, source_unit_id). Run after
// import-appfolio-properties.

import { and, eq } from 'drizzle-orm';
import {
  withAdminHandler,
  getDefaultOrgId,
} from '../../lib/adminHelpers.js';
import { getDb, schema } from '../../lib/db/index.js';
import { fetchAllPages } from '../../lib/backends/appfolio.js';
import { recordHealth } from '../../lib/integrationHealth.js';

export const config = { maxDuration: 120 };

function isAppfolioConfigured() {
  return Boolean(
    process.env.APPFOLIO_CLIENT_ID &&
      process.env.APPFOLIO_CLIENT_SECRET &&
      process.env.APPFOLIO_DEVELOPER_ID,
  );
}

function toInt(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = parseInt(String(v), 10);
  return Number.isFinite(n) ? n : null;
}

export default withAdminHandler(async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'POST only' });
  }
  if (!isAppfolioConfigured()) {
    return res.status(503).json({ ok: false, error: 'AppFolio not configured.' });
  }

  const db = getDb();
  const organizationId = await getDefaultOrgId();

  // Our properties, indexed by AppFolio source_property_id.
  const ourProperties = await db
    .select({
      id: schema.properties.id,
      sourcePropertyId: schema.properties.sourcePropertyId,
    })
    .from(schema.properties)
    .where(eq(schema.properties.organizationId, organizationId));
  const propBySourceId = new Map(
    ourProperties
      .filter((p) => p.sourcePropertyId)
      .map((p) => [String(p.sourcePropertyId), p.id]),
  );
  if (propBySourceId.size === 0) {
    return res.status(400).json({
      ok: false,
      error: 'No properties with a source_property_id found. Run import-appfolio-properties first.',
    });
  }

  const startedAt = Date.now();
  const result = await fetchAllPages('/units', {});
  if (result.error) {
    await recordHealth(organizationId, 'appfolio_database', 'AppFolio (Database API)', {
      ok: false, error: result.error,
    });
    return res.status(502).json({ ok: false, error: `AppFolio /units: ${result.error}` });
  }
  const afUnits = (result.data || []).filter((u) => u && (u.Id || u.id));
  await recordHealth(organizationId, 'appfolio_database', 'AppFolio (Database API)', { ok: true });

  let inserted = 0;
  let updated = 0;
  let skippedNonRevenue = 0;
  let skippedNoProperty = 0;
  const skippedNoPropertyExamples = [];

  for (const au of afUnits) {
    if (au.NonRevenue === true) { skippedNonRevenue += 1; continue; }

    const sourceUnitId = String(au.Id || au.id);
    const afPropertyId = au.PropertyId != null ? String(au.PropertyId) : null;
    const propertyId = afPropertyId ? propBySourceId.get(afPropertyId) || null : null;
    if (!propertyId) {
      skippedNoProperty += 1;
      if (skippedNoPropertyExamples.length < 10) {
        skippedNoPropertyExamples.push({
          source_unit_id: sourceUnitId,
          appfolio_property_id: afPropertyId,
          name: au.Name || au.UnitNumber || au.Address1 || null,
        });
      }
      continue;
    }

    const values = {
      organizationId,
      propertyId,
      sourceUnitId,
      sourcePms: 'appfolio',
      sourceUnitName: au.Name || au.UnitNumber || au.Address1 || `Unit ${sourceUnitId}`,
      sqft: toInt(au.SquareFeet || au.SquareFootage),
      bedrooms: toInt(au.Bedrooms),
      bathrooms: au.Bathrooms != null ? String(au.Bathrooms) : null,
      updatedAt: new Date(),
    };

    const [existing] = await db
      .select({ id: schema.units.id })
      .from(schema.units)
      .where(
        and(
          eq(schema.units.organizationId, organizationId),
          eq(schema.units.sourceUnitId, sourceUnitId),
        ),
      )
      .limit(1);

    if (existing) {
      await db.update(schema.units).set(values)
        .where(eq(schema.units.id, existing.id));
      updated += 1;
    } else {
      await db.insert(schema.units).values(values);
      inserted += 1;
    }
  }

  return res.status(200).json({
    ok: true,
    organization_id: organizationId,
    appfolio_units_returned: afUnits.length,
    inserted,
    updated,
    skipped_non_revenue: skippedNonRevenue,
    skipped_no_property: skippedNoProperty,
    skipped_no_property_examples: skippedNoPropertyExamples,
    elapsed_ms: Date.now() - startedAt,
  });
});
