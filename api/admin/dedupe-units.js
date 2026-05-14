// GET|POST /api/admin/dedupe-units?secret=<TOKEN>&dry_run=true|false
//
// Removes duplicate unit rows. The CSV bootstrap (bulk-import +
// grid-import re-runs) created multiple rows for the same physical
// unit — same property, same name. That breaks unit reconciliation
// (two rows can't both map to one AppFolio unit) and inflates unit
// counts.
//
// A "duplicate group" = units in the same property whose normalized
// source_unit_name is identical. Within a group we pick ONE keeper
// and delete the rest:
//   keeper priority:  has source_unit_id  >  has leases  >  oldest
//
// Before deleting an orphan, every FK reference is re-pointed to the
// keeper so nothing is lost:
//   leases, maintenance_tickets, journal_lines, bill_lines,
//   scheduled_charges, posted_charges  → re-pointed
//   property_utilities                 → orphan's rows deleted
//                                         (keeper keeps its own)
//
// Each group is resolved in its own transaction — if a re-point or
// delete fails (an FK we didn't anticipate), that group rolls back
// and is reported as "could not dedupe" instead of corrupting data.
//
// dry_run by default — review the plan, then re-run with dry_run=false.

import { and, eq, inArray, sql } from 'drizzle-orm';
import {
  withAdminHandler,
  getDefaultOrgId,
  parseBody,
} from '../../lib/adminHelpers.js';
import { getDb, schema } from '../../lib/db/index.js';

export const config = { maxDuration: 120 };

function normalizeName(s) {
  return (s || '')
    .toString()
    .trim()
    .toLowerCase()
    .replace(/[.,#/\\-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Tables with a unit_id FK that should follow the keeper.
const REPOINT_TABLES = [
  { name: 'leases', table: () => schema.leases },
  { name: 'maintenance_tickets', table: () => schema.maintenanceTickets },
  { name: 'journal_lines', table: () => schema.journalLines },
  { name: 'bill_lines', table: () => schema.billLines },
  { name: 'scheduled_charges', table: () => schema.scheduledCharges },
  { name: 'posted_charges', table: () => schema.postedCharges },
];

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

  // All units for the org, with lease counts so we can pick keepers.
  const units = await db
    .select({
      id: schema.units.id,
      propertyId: schema.units.propertyId,
      sourceUnitId: schema.units.sourceUnitId,
      sourceUnitName: schema.units.sourceUnitName,
      createdAt: schema.units.createdAt,
    })
    .from(schema.units)
    .where(eq(schema.units.organizationId, organizationId));

  const leaseCounts = await db
    .select({
      unitId: schema.leases.unitId,
      total: sql`COUNT(*)`.as('total'),
    })
    .from(schema.leases)
    .where(eq(schema.leases.organizationId, organizationId))
    .groupBy(schema.leases.unitId);
  const leaseCountByUnit = new Map(leaseCounts.map((r) => [r.unitId, Number(r.total)]));

  // Group by (propertyId, normalized name). Skip rows with no name —
  // we can't tell if a nameless unit is a duplicate of anything.
  const groups = new Map();
  for (const u of units) {
    const n = normalizeName(u.sourceUnitName);
    if (!n) continue;
    const key = `${u.propertyId}::${n}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(u);
  }

  const dupGroups = [...groups.values()].filter((g) => g.length > 1);

  // Pick keeper per group: has source_unit_id > most leases > oldest.
  function pickKeeper(group) {
    return [...group].sort((a, b) => {
      const aHasId = a.sourceUnitId ? 1 : 0;
      const bHasId = b.sourceUnitId ? 1 : 0;
      if (aHasId !== bHasId) return bHasId - aHasId;
      const aLeases = leaseCountByUnit.get(a.id) || 0;
      const bLeases = leaseCountByUnit.get(b.id) || 0;
      if (aLeases !== bLeases) return bLeases - aLeases;
      return new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
    })[0];
  }

  let groupsResolved = 0;
  let unitsDeleted = 0;
  const repointTotals = {};
  const failures = [];
  const plan = [];

  for (const group of dupGroups) {
    const keeper = pickKeeper(group);
    const orphans = group.filter((u) => u.id !== keeper.id);
    const orphanIds = orphans.map((o) => o.id);

    const planEntry = {
      property_id: keeper.propertyId,
      name: keeper.sourceUnitName,
      group_size: group.length,
      keeper_unit_id: keeper.id,
      keeper_has_source_id: !!keeper.sourceUnitId,
      orphan_unit_ids: orphanIds,
      orphan_lease_counts: orphans.map((o) => leaseCountByUnit.get(o.id) || 0),
    };

    if (dryRun) {
      plan.push(planEntry);
      continue;
    }

    try {
      await db.transaction(async (tx) => {
        for (const t of REPOINT_TABLES) {
          const table = t.table();
          const moved = await tx
            .update(table)
            .set({ unitId: keeper.id })
            .where(inArray(table.unitId, orphanIds))
            .returning({ id: table.id });
          repointTotals[t.name] = (repointTotals[t.name] || 0) + moved.length;
        }
        // property_utilities cascade-deletes with the unit; just drop
        // the orphan's rows so the cascade has nothing to take.
        await tx
          .delete(schema.propertyUtilities)
          .where(inArray(schema.propertyUtilities.unitId, orphanIds));
        const deleted = await tx
          .delete(schema.units)
          .where(
            and(
              eq(schema.units.organizationId, organizationId),
              inArray(schema.units.id, orphanIds),
            ),
          )
          .returning({ id: schema.units.id });
        unitsDeleted += deleted.length;
      });
      groupsResolved += 1;
    } catch (err) {
      failures.push({
        property_id: keeper.propertyId,
        name: keeper.sourceUnitName,
        error: err.message || String(err),
      });
    }
  }

  return res.status(200).json({
    ok: true,
    dry_run: dryRun,
    organization_id: organizationId,
    total_units: units.length,
    duplicate_groups: dupGroups.length,
    duplicate_unit_rows: dupGroups.reduce((s, g) => s + g.length - 1, 0),
    groups_resolved: groupsResolved,
    units_deleted: unitsDeleted,
    repointed: repointTotals,
    failures,
    // First 60 groups so the UI can show what would be / was removed.
    plan: dryRun ? plan.slice(0, 60) : undefined,
  });
});
