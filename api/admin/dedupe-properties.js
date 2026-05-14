// GET|POST /api/admin/dedupe-properties?secret=<TOKEN>&dry_run=true|false
//
// Removes duplicate PROPERTY rows. The CSV bootstrap created multiple
// rows for the same physical property (same display name) — each with
// its own set of units. dedupe-units can't see these because it groups
// within a property; two "Unit 201" rows under two property-row-ids
// look distinct. This is the level above.
//
// A "duplicate group" = properties in the org whose normalized
// display_name is identical. Within a group we pick ONE keeper:
//   keeper priority:  has UUID source_property_id  >  has units  >  oldest
//
// Then, in one transaction per group:
//   1. Re-point every FK off the orphan properties to the keeper —
//      units, property_utilities, message_threads, messages,
//      phone_numbers, bill_lines, journal_lines, scheduled_charges,
//      posted_charges, maintenance_tickets.
//   2. Delete the orphan property rows.
//   3. The keeper now has duplicated units (e.g. two "Unit 201") —
//      dedupe them in place: keep the unit with source_unit_id /
//      leases / oldest, re-point its FKs, delete the orphans.
//
// dry_run by default. One transaction per group — a failure rolls
// back that group and is reported, never half-merges.

import { and, eq, inArray, sql } from 'drizzle-orm';
import {
  withAdminHandler,
  getDefaultOrgId,
  parseBody,
} from '../../lib/adminHelpers.js';
import { getDb, schema } from '../../lib/db/index.js';

export const config = { maxDuration: 120 };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function normalizeName(s) {
  return (s || '')
    .toString()
    .trim()
    .toLowerCase()
    .replace(/[.,#/\\-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Tables whose property_id should follow the keeper.
const PROPERTY_FK_TABLES = [
  () => schema.units,
  () => schema.propertyUtilities,
  () => schema.messageThreads,
  () => schema.messages,
  () => schema.phoneNumbers,
  () => schema.billLines,
  () => schema.journalLines,
  () => schema.scheduledCharges,
  () => schema.postedCharges,
  () => schema.maintenanceTickets,
];

// Tables whose unit_id should follow a unit keeper.
const UNIT_FK_TABLES = [
  () => schema.leases,
  () => schema.maintenanceTickets,
  () => schema.journalLines,
  () => schema.billLines,
  () => schema.scheduledCharges,
  () => schema.postedCharges,
];

// Collapse duplicate units within one property (after a merge brought
// two unit sets together). Returns count deleted.
async function dedupeUnitsInProperty(tx, organizationId, propertyId, leaseCountByUnit) {
  const units = await tx
    .select({
      id: schema.units.id,
      sourceUnitId: schema.units.sourceUnitId,
      sourceUnitName: schema.units.sourceUnitName,
      createdAt: schema.units.createdAt,
    })
    .from(schema.units)
    .where(
      and(
        eq(schema.units.organizationId, organizationId),
        eq(schema.units.propertyId, propertyId),
      ),
    );

  const groups = new Map();
  for (const u of units) {
    const n = normalizeName(u.sourceUnitName);
    if (!n) continue;
    if (!groups.has(n)) groups.set(n, []);
    groups.get(n).push(u);
  }

  let deleted = 0;
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    const keeper = [...group].sort((a, b) => {
      const aId = a.sourceUnitId ? 1 : 0;
      const bId = b.sourceUnitId ? 1 : 0;
      if (aId !== bId) return bId - aId;
      const aL = leaseCountByUnit.get(a.id) || 0;
      const bL = leaseCountByUnit.get(b.id) || 0;
      if (aL !== bL) return bL - aL;
      return new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
    })[0];
    const orphanIds = group.filter((u) => u.id !== keeper.id).map((u) => u.id);
    for (const t of UNIT_FK_TABLES) {
      const table = t();
      await tx.update(table).set({ unitId: keeper.id })
        .where(inArray(table.unitId, orphanIds));
    }
    await tx.delete(schema.propertyUtilities)
      .where(inArray(schema.propertyUtilities.unitId, orphanIds));
    const del = await tx.delete(schema.units)
      .where(inArray(schema.units.id, orphanIds))
      .returning({ id: schema.units.id });
    deleted += del.length;
  }
  return deleted;
}

export default withAdminHandler(async (req, res) => {
  if (req.method !== 'POST' && req.method !== 'GET') {
    return res.status(405).json({ ok: false, error: 'POST or GET only' });
  }
  const body = req.method === 'POST' ? parseBody(req) : {};
  const queryDryRun = req.query?.dry_run;
  const dryRun =
    body.dry_run !== undefined
      ? body.dry_run !== false
      : queryDryRun !== undefined
        ? !(queryDryRun === 'false' || queryDryRun === '0')
        : true;

  const db = getDb();
  const organizationId = await getDefaultOrgId();

  const properties = await db
    .select({
      id: schema.properties.id,
      displayName: schema.properties.displayName,
      sourcePropertyId: schema.properties.sourcePropertyId,
      createdAt: schema.properties.createdAt,
    })
    .from(schema.properties)
    .where(eq(schema.properties.organizationId, organizationId));

  // Unit counts per property + lease counts per unit, for keeper picks.
  const unitRows = await db
    .select({ id: schema.units.id, propertyId: schema.units.propertyId })
    .from(schema.units)
    .where(eq(schema.units.organizationId, organizationId));
  const unitCountByProperty = new Map();
  for (const u of unitRows) {
    unitCountByProperty.set(u.propertyId, (unitCountByProperty.get(u.propertyId) || 0) + 1);
  }
  const leaseRows = await db
    .select({ unitId: schema.leases.unitId, c: sql`COUNT(*)`.as('c') })
    .from(schema.leases)
    .where(eq(schema.leases.organizationId, organizationId))
    .groupBy(schema.leases.unitId);
  const leaseCountByUnit = new Map(leaseRows.map((r) => [r.unitId, Number(r.c)]));

  // Group properties by normalized display name.
  const groups = new Map();
  for (const p of properties) {
    const n = normalizeName(p.displayName);
    if (!n) continue;
    if (!groups.has(n)) groups.set(n, []);
    groups.get(n).push(p);
  }
  const dupGroups = [...groups.values()].filter((g) => g.length > 1);

  function pickKeeper(group) {
    return [...group].sort((a, b) => {
      const aUuid = UUID_RE.test(String(a.sourcePropertyId || '')) ? 1 : 0;
      const bUuid = UUID_RE.test(String(b.sourcePropertyId || '')) ? 1 : 0;
      if (aUuid !== bUuid) return bUuid - aUuid;
      const aU = unitCountByProperty.get(a.id) || 0;
      const bU = unitCountByProperty.get(b.id) || 0;
      if (aU !== bU) return bU - aU;
      return new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
    })[0];
  }

  let groupsResolved = 0;
  let propertiesDeleted = 0;
  let unitsDeletedAfterMerge = 0;
  const failures = [];
  const plan = [];

  for (const group of dupGroups) {
    const keeper = pickKeeper(group);
    const orphans = group.filter((p) => p.id !== keeper.id);
    const orphanIds = orphans.map((o) => o.id);

    const entry = {
      display_name: keeper.displayName,
      group_size: group.length,
      keeper_property_id: keeper.id,
      keeper_has_uuid: UUID_RE.test(String(keeper.sourcePropertyId || '')),
      keeper_units: unitCountByProperty.get(keeper.id) || 0,
      orphan_property_ids: orphanIds,
      orphan_units: orphans.map((o) => unitCountByProperty.get(o.id) || 0),
    };

    if (dryRun) {
      plan.push(entry);
      continue;
    }

    try {
      const merged = await db.transaction(async (tx) => {
        for (const t of PROPERTY_FK_TABLES) {
          const table = t();
          await tx.update(table).set({ propertyId: keeper.id })
            .where(inArray(table.propertyId, orphanIds));
        }
        const delProps = await tx.delete(schema.properties)
          .where(
            and(
              eq(schema.properties.organizationId, organizationId),
              inArray(schema.properties.id, orphanIds),
            ),
          )
          .returning({ id: schema.properties.id });
        // Keeper now holds the merged unit sets — collapse dup units.
        const unitsKilled = await dedupeUnitsInProperty(
          tx, organizationId, keeper.id, leaseCountByUnit,
        );
        return { props: delProps.length, units: unitsKilled };
      });
      groupsResolved += 1;
      propertiesDeleted += merged.props;
      unitsDeletedAfterMerge += merged.units;
    } catch (err) {
      failures.push({
        display_name: keeper.displayName,
        error: err.message || String(err),
      });
    }
  }

  return res.status(200).json({
    ok: true,
    dry_run: dryRun,
    organization_id: organizationId,
    total_properties: properties.length,
    duplicate_groups: dupGroups.length,
    orphan_properties: dupGroups.reduce((s, g) => s + g.length - 1, 0),
    groups_resolved: groupsResolved,
    properties_deleted: propertiesDeleted,
    units_deleted_after_merge: unitsDeletedAfterMerge,
    failures,
    plan: dryRun ? plan.slice(0, 60) : undefined,
  });
});
