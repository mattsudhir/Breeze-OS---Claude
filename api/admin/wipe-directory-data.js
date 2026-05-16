// GET|POST /api/admin/wipe-directory-data?secret=<TOKEN>&dry_run=true|false
//
// Clears the CSV-bootstrapped directory data so it can be re-imported
// clean from AppFolio's API. Wipes ONLY the directory layer:
//   maintenance_ticket_comments, maintenance_tickets, lease_tenants,
//   leases, tenants, property_utilities, units, properties
//
// KEEPS: owners, entities, utility providers, GL accounts, bank
// accounts, the org itself, and the accounting ledger (journal
// entries / bills / bank transactions). Those tables' unit_id /
// property_id FKs are ON DELETE SET NULL, so they survive the wipe
// with their (junk) directory attribution nulled — re-attribution
// happens naturally once real data is re-imported.
//
// Order matters: leases.unit_id is NOT NULL (RESTRICT), so leases
// must go before units; units cascade from properties but we delete
// explicitly for honest counts.
//
// dry_run by default — returns the row counts that WOULD be deleted.
// One transaction; all-or-nothing.

import { eq, sql } from 'drizzle-orm';
import {
  withAdminHandler,
  getDefaultOrgId,
  parseBody,
} from '../../lib/adminHelpers.js';
import { getDb, schema } from '../../lib/db/index.js';

export const config = { maxDuration: 120 };

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

  // property_utilities and lease_tenants have no organization_id of
  // their own — they're scoped via property_id / lease_id. Pull those
  // id sets up front so both the count and the delete can use them.
  const orgPropertyRows = await db
    .select({ id: schema.properties.id })
    .from(schema.properties)
    .where(eq(schema.properties.organizationId, organizationId));
  const orgPropertyIds = orgPropertyRows.map((r) => r.id);
  const orgLeaseRows = await db
    .select({ id: schema.leases.id })
    .from(schema.leases)
    .where(eq(schema.leases.organizationId, organizationId));
  const orgLeaseIds = orgLeaseRows.map((r) => r.id);

  // Count helper for org-scoped tables.
  async function count(table) {
    const rows = await db
      .select({ c: sql`COUNT(*)`.as('c') })
      .from(table)
      .where(eq(table.organizationId, organizationId));
    return Number(rows[0].c);
  }
  // Count helper for a table scoped by an id list (empty list → 0).
  async function countIn(table, column, ids) {
    if (ids.length === 0) return 0;
    const rows = await db
      .select({ c: sql`COUNT(*)`.as('c') })
      .from(table)
      .where(sql`${column} IN ${ids}`);
    return Number(rows[0].c);
  }

  const counts = {
    maintenance_ticket_comments: await count(schema.maintenanceTicketComments),
    maintenance_tickets: await count(schema.maintenanceTickets),
    lease_tenants: await countIn(schema.leaseTenants, schema.leaseTenants.leaseId, orgLeaseIds),
    leases: await count(schema.leases),
    tenants: await count(schema.tenants),
    property_utilities: await countIn(
      schema.propertyUtilities, schema.propertyUtilities.propertyId, orgPropertyIds,
    ),
    units: await count(schema.units),
    properties: await count(schema.properties),
  };

  if (dryRun) {
    return res.status(200).json({
      ok: true,
      dry_run: true,
      organization_id: organizationId,
      would_delete: counts,
      total_rows: Object.values(counts).reduce((s, n) => s + n, 0),
      note: 'Owners, entities, utility providers, GL accounts, bank accounts and the accounting ledger are KEPT.',
    });
  }

  // Delete in FK-safe order, one transaction. Each step is wrapped so
  // that if anything throws, the response tells us exactly which table
  // blew up — no more "Cannot convert undefined or null to object" with
  // no fingerprint. The throw still aborts the transaction (Drizzle
  // rolls back on a thrown promise inside .transaction()).
  const deleted = {};
  let failedStep = null;
  try {
    await db.transaction(async (tx) => {
      async function step(name, fn) {
        failedStep = name;
        const n = await fn(tx);
        deleted[name] = n;
        failedStep = null;
      }

      await step('maintenance_ticket_comments', async (tx) => {
        const rows = await tx.delete(schema.maintenanceTicketComments)
          .where(eq(schema.maintenanceTicketComments.organizationId, organizationId))
          .returning({ id: schema.maintenanceTicketComments.id });
        return rows.length;
      });

      await step('maintenance_tickets', async (tx) => {
        const rows = await tx.delete(schema.maintenanceTickets)
          .where(eq(schema.maintenanceTickets.organizationId, organizationId))
          .returning({ id: schema.maintenanceTickets.id });
        return rows.length;
      });

      // lease_tenants is org-less — scope via its leases. Composite PK
      // (lease_id, tenant_id), NO `id` column.
      await step('lease_tenants', async (tx) => {
        if (orgLeaseIds.length === 0) return 0;
        const rows = await tx.delete(schema.leaseTenants)
          .where(sql`${schema.leaseTenants.leaseId} IN ${orgLeaseIds}`)
          .returning({ leaseId: schema.leaseTenants.leaseId });
        return rows.length;
      });

      await step('leases', async (tx) => {
        const rows = await tx.delete(schema.leases)
          .where(eq(schema.leases.organizationId, organizationId))
          .returning({ id: schema.leases.id });
        return rows.length;
      });

      await step('tenants', async (tx) => {
        const rows = await tx.delete(schema.tenants)
          .where(eq(schema.tenants.organizationId, organizationId))
          .returning({ id: schema.tenants.id });
        return rows.length;
      });

      // property_utilities is org-less — scope via its properties.
      await step('property_utilities', async (tx) => {
        if (orgPropertyIds.length === 0) return 0;
        const rows = await tx.delete(schema.propertyUtilities)
          .where(sql`${schema.propertyUtilities.propertyId} IN ${orgPropertyIds}`)
          .returning({ id: schema.propertyUtilities.id });
        return rows.length;
      });

      await step('units', async (tx) => {
        const rows = await tx.delete(schema.units)
          .where(eq(schema.units.organizationId, organizationId))
          .returning({ id: schema.units.id });
        return rows.length;
      });

      await step('properties', async (tx) => {
        const rows = await tx.delete(schema.properties)
          .where(eq(schema.properties.organizationId, organizationId))
          .returning({ id: schema.properties.id });
        return rows.length;
      });
    });
  } catch (err) {
    return res.status(500).json({
      ok: false,
      build: 'wipe-v3',
      failed_step: failedStep,
      error: err?.message || String(err),
      partial_deleted: deleted,
    });
  }

  return res.status(200).json({
    ok: true,
    build: 'wipe-v3',
    dry_run: false,
    organization_id: organizationId,
    deleted,
    total_rows: Object.values(deleted).reduce((s, n) => s + n, 0),
  });
});
