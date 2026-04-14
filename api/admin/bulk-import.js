// Vercel Serverless Function — bulk import of properties + units from
// a parsed TSV paste.
//
// POST /api/admin/bulk-import
// Body:
//   {
//     defaultOwnerName: "Breeze (unassigned)",  // LLC auto-created if missing
//     rows: [
//       {
//         sourcePropertyId: 688,
//         displayName: "1919 Ottawa Dr",
//         propertyType: "multi_family",
//         serviceAddressLine1: "1919 Ottawa Dr",
//         serviceCity: "Toledo",
//         serviceState: "OH",
//         serviceZip: "43606",
//         unit: {
//           sourceUnitName: "Unit 1",
//           sqft: 750,
//           bedrooms: 1,
//           bathrooms: "1"
//         }
//       },
//       ...
//     ]
//   }
//
// Each row represents a unit. Rows with the same sourcePropertyId are
// grouped into the same property; the first row's property fields
// define the property, subsequent rows just contribute units.
//
// Behavior:
//   - Upserts properties on (organization_id, source_property_id) —
//     safe to re-run, updates property fields from the most recent
//     paste.
//   - For each re-imported property: deletes pre-existing units and
//     re-inserts from the paste. Destructive but predictable on re-run.
//   - Wraps the whole thing in a transaction so a mid-import failure
//     leaves the DB untouched.
//   - Returns counts + a list of per-row issues (bad data that was
//     skipped rather than failing the whole import).

import { and, eq } from 'drizzle-orm';
import { getDb, schema } from '../../lib/db/index.js';
import {
  withAdminHandler,
  getDefaultOrgId,
  parseBody,
} from '../../lib/adminHelpers.js';

function toInt(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = parseInt(String(v).replace(/,/g, ''), 10);
  return Number.isFinite(n) ? n : null;
}

function toStr(v) {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s === '' ? null : s;
}

function inferPropertyType(unitCount) {
  if (unitCount >= 3) return 'multi_family';
  if (unitCount === 2) return 'multi_family';
  return 'sfr';
}

export default withAdminHandler(async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'POST only' });
  }

  const body = parseBody(req);
  const rows = Array.isArray(body.rows) ? body.rows : [];
  const defaultOwnerName = toStr(body.defaultOwnerName) || 'Breeze (unassigned)';

  if (rows.length === 0) {
    return res.status(400).json({ ok: false, error: 'rows array is required and must be non-empty' });
  }

  const db = getDb();
  const orgId = await getDefaultOrgId();

  let ownerId;
  {
    const existing = await db
      .select()
      .from(schema.owners)
      .where(
        and(
          eq(schema.owners.organizationId, orgId),
          eq(schema.owners.legalName, defaultOwnerName),
        ),
      )
      .limit(1);
    if (existing.length > 0) {
      ownerId = existing[0].id;
    } else {
      const [created] = await db
        .insert(schema.owners)
        .values({
          organizationId: orgId,
          legalName: defaultOwnerName,
        })
        .returning();
      ownerId = created.id;
    }
  }

  // Group rows by sourcePropertyId.
  const propertyGroups = new Map();
  const rowErrors = [];

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    // Accept either the new sourcePropertyId or legacy rmPropertyId
    // field name so old client code keeps working while the rename
    // propagates.
    const sourcePropertyId = toInt(row.sourcePropertyId ?? row.rmPropertyId);
    if (!sourcePropertyId) {
      rowErrors.push({ rowIndex: i, error: 'Missing or invalid sourcePropertyId', row });
      continue;
    }
    const displayName = toStr(row.displayName);
    const serviceAddressLine1 = toStr(row.serviceAddressLine1);
    const serviceCity = toStr(row.serviceCity);
    const serviceState = toStr(row.serviceState);
    const serviceZip = toStr(row.serviceZip);
    if (!displayName || !serviceAddressLine1 || !serviceCity || !serviceState) {
      rowErrors.push({
        rowIndex: i,
        error: 'Missing one of: displayName, serviceAddressLine1, serviceCity, serviceState',
        row,
      });
      continue;
    }

    if (!propertyGroups.has(sourcePropertyId)) {
      propertyGroups.set(sourcePropertyId, {
        propertyFields: {
          sourcePropertyId,
          displayName,
          serviceAddressLine1,
          serviceAddressLine2: toStr(row.serviceAddressLine2),
          serviceCity,
          serviceState,
          serviceZip,
          propertyType: toStr(row.propertyType) || null,
        },
        units: [],
      });
    }
    const group = propertyGroups.get(sourcePropertyId);

    // Accept both new sourceUnitName and legacy rmUnitName.
    const unitName = row.unit?.sourceUnitName ?? row.unit?.rmUnitName;
    if (
      row.unit &&
      (unitName || row.unit.sqft || row.unit.bedrooms || row.unit.bathrooms)
    ) {
      group.units.push({
        sourceUnitName: toStr(unitName),
        sqft: toInt(row.unit.sqft),
        bedrooms: toInt(row.unit.bedrooms),
        bathrooms: toStr(row.unit.bathrooms),
      });
    }
  }

  const propertyIdsBySource = new Map();
  let propertiesInserted = 0;
  let propertiesUpdated = 0;
  let unitsInserted = 0;

  try {
    await db.transaction(async (tx) => {
      for (const [sourcePropertyId, group] of propertyGroups) {
        const inferred = group.propertyFields.propertyType ||
          inferPropertyType(group.units.length);

        const existing = await tx
          .select({ id: schema.properties.id })
          .from(schema.properties)
          .where(
            and(
              eq(schema.properties.organizationId, orgId),
              eq(schema.properties.sourcePropertyId, sourcePropertyId),
            ),
          )
          .limit(1);

        let propertyRowId;
        if (existing.length > 0) {
          const [updated] = await tx
            .update(schema.properties)
            .set({
              ownerId,
              displayName: group.propertyFields.displayName,
              propertyType: inferred,
              serviceAddressLine1: group.propertyFields.serviceAddressLine1,
              serviceAddressLine2: group.propertyFields.serviceAddressLine2,
              serviceCity: group.propertyFields.serviceCity,
              serviceState: group.propertyFields.serviceState,
              serviceZip: group.propertyFields.serviceZip || '',
              updatedAt: new Date(),
            })
            .where(eq(schema.properties.id, existing[0].id))
            .returning({ id: schema.properties.id });
          propertyRowId = updated.id;
          propertiesUpdated += 1;
        } else {
          const [created] = await tx
            .insert(schema.properties)
            .values({
              organizationId: orgId,
              ownerId,
              sourcePropertyId,
              displayName: group.propertyFields.displayName,
              propertyType: inferred,
              serviceAddressLine1: group.propertyFields.serviceAddressLine1,
              serviceAddressLine2: group.propertyFields.serviceAddressLine2,
              serviceCity: group.propertyFields.serviceCity,
              serviceState: group.propertyFields.serviceState,
              serviceZip: group.propertyFields.serviceZip || '',
            })
            .returning({ id: schema.properties.id });
          propertyRowId = created.id;
          propertiesInserted += 1;
        }

        propertyIdsBySource.set(sourcePropertyId, propertyRowId);

        // Replace-strategy for units.
        await tx
          .delete(schema.units)
          .where(eq(schema.units.propertyId, propertyRowId));

        if (group.units.length > 0) {
          const unitsToInsert = group.units.map((u) => ({
            organizationId: orgId,
            propertyId: propertyRowId,
            sourceUnitName: u.sourceUnitName,
            sqft: u.sqft,
            bedrooms: u.bedrooms,
            bathrooms: u.bathrooms,
          }));
          const insertedUnits = await tx
            .insert(schema.units)
            .values(unitsToInsert)
            .returning({ id: schema.units.id });
          unitsInserted += insertedUnits.length;
        }
      }
    });
  } catch (err) {
    console.error('[bulk-import] transaction failed:', err);
    return res.status(500).json({
      ok: false,
      error: `Import failed, no changes were committed: ${err.message}`,
      propertiesAttempted: propertyGroups.size,
    });
  }

  return res.status(200).json({
    ok: true,
    ownerId,
    defaultOwnerName,
    propertiesUpserted: propertiesInserted + propertiesUpdated,
    propertiesInserted,
    propertiesUpdated,
    unitsInserted,
    rowErrorCount: rowErrors.length,
    rowErrors: rowErrors.slice(0, 50),
    warning:
      'Re-running the import for the same sourcePropertyId will replace ' +
      "that property's units with the pasted set.",
  });
});
