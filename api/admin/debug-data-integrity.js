// GET /api/admin/debug-data-integrity?secret=<TOKEN>
//
// Read-only. Surfaces the structural data problems the CSV bootstrap
// left behind, so we stop inferring them from conflict logs:
//
//   - properties sharing a source_property_id (the CSV gave distinct
//     properties the same external id — dedupe-by-name can't see it)
//   - units sharing a source_unit_id
//   - properties / units with a non-UUID source id (un-backfilled)
//   - properties / units with a NULL source id
//   - orphan units (property_id points at a missing property)
//
// No writes. This is the map before we decide how to clean it.

import { eq } from 'drizzle-orm';
import { withAdminHandler, getDefaultOrgId } from '../../lib/adminHelpers.js';
import { getDb, schema } from '../../lib/db/index.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default withAdminHandler(async (req, res) => {
  if (req.method !== 'GET') {
    return res.status(405).json({ ok: false, error: 'GET only' });
  }
  const db = getDb();
  const organizationId = await getDefaultOrgId();

  // ── Properties ──────────────────────────────────────────────
  const properties = await db
    .select({
      id: schema.properties.id,
      displayName: schema.properties.displayName,
      sourcePropertyId: schema.properties.sourcePropertyId,
    })
    .from(schema.properties)
    .where(eq(schema.properties.organizationId, organizationId));

  const propsBySourceId = new Map();
  let propsNullSourceId = 0;
  let propsNonUuidSourceId = 0;
  for (const p of properties) {
    const sid = p.sourcePropertyId;
    if (!sid) { propsNullSourceId += 1; continue; }
    if (!UUID_RE.test(String(sid))) propsNonUuidSourceId += 1;
    if (!propsBySourceId.has(sid)) propsBySourceId.set(sid, []);
    propsBySourceId.get(sid).push(p);
  }
  const propSharedGroups = [...propsBySourceId.entries()]
    .filter(([, list]) => list.length > 1)
    .map(([sid, list]) => ({
      source_property_id: sid,
      count: list.length,
      properties: list.map((p) => ({ id: p.id, display_name: p.displayName })),
    }));

  // ── Units ───────────────────────────────────────────────────
  const units = await db
    .select({
      id: schema.units.id,
      propertyId: schema.units.propertyId,
      sourceUnitId: schema.units.sourceUnitId,
      sourceUnitName: schema.units.sourceUnitName,
    })
    .from(schema.units)
    .where(eq(schema.units.organizationId, organizationId));

  const unitsBySourceId = new Map();
  let unitsNullSourceId = 0;
  let unitsNonUuidSourceId = 0;
  for (const u of units) {
    const sid = u.sourceUnitId;
    if (!sid) { unitsNullSourceId += 1; continue; }
    if (!UUID_RE.test(String(sid))) unitsNonUuidSourceId += 1;
    if (!unitsBySourceId.has(sid)) unitsBySourceId.set(sid, []);
    unitsBySourceId.get(sid).push(u);
  }
  const unitSharedGroups = [...unitsBySourceId.entries()]
    .filter(([, list]) => list.length > 1)
    .map(([sid, list]) => ({
      source_unit_id: sid,
      count: list.length,
      units: list.map((u) => ({
        id: u.id, name: u.sourceUnitName, property_id: u.propertyId,
      })),
    }));

  // ── Orphan units (property_id with no matching property) ────
  const propIds = new Set(properties.map((p) => p.id));
  const orphanUnits = units.filter((u) => u.propertyId && !propIds.has(u.propertyId));

  return res.status(200).json({
    ok: true,
    organization_id: organizationId,
    properties: {
      total: properties.length,
      null_source_id: propsNullSourceId,
      non_uuid_source_id: propsNonUuidSourceId,
      shared_source_id_groups: propSharedGroups.length,
      shared_source_id_property_rows: propSharedGroups.reduce((s, g) => s + g.count, 0),
    },
    units: {
      total: units.length,
      null_source_id: unitsNullSourceId,
      non_uuid_source_id: unitsNonUuidSourceId,
      shared_source_id_groups: unitSharedGroups.length,
      shared_source_id_unit_rows: unitSharedGroups.reduce((s, g) => s + g.count, 0),
      orphan_units: orphanUnits.length,
    },
    // Samples — capped so the payload stays small.
    shared_property_samples: propSharedGroups.slice(0, 40),
    shared_unit_samples: unitSharedGroups.slice(0, 40),
  });
});
