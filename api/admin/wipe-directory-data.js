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

  // Count helper.
  async function count(table, hasOrg = true) {
    const where = hasOrg ? eq(table.organizationId, organizationId) : undefined;
    const q = db.select({ c: sql`COUNT(*)`.as('c') }).from(table);
    const rows = where ? await q.where(where) : await q;
    return Number(rows[0].c);
  }

  // maintenance_ticket_comments has organization_id; the rest do too.
  const counts = {
    maintenance_ticket_comments: await count(schema.maintenanceTicketComments),
    maintenance_tickets: await count(schema.maintenanceTickets),
    lease_tenants: await count(schema.leaseTenants, false),
    leases: await count(schema.leases),
    tenants: await count(schema.tenants),
    property_utilities: await count(schema.propertyUtilities),
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

  // Delete in FK-safe order, one transaction.
  const deleted = {};
  await db.transaction(async (tx) => {
    // lease_tenants is org-less — scope via its leases. Simplest:
    // delete all lease_tenants whose lease belongs to this org.
    const orgLeaseIds = await tx
      .select({ id: schema.leases.id })
      .from(schema.leases)
      .where(eq(schema.leases.organizationId, organizationId));
    const leaseIdList = orgLeaseIds.map((r) => r.id);

    const d1 = await tx.delete(schema.maintenanceTicketComments)
      .where(eq(schema.maintenanceTicketComments.organizationId, organizationId))
      .returning({ id: schema.maintenanceTicketComments.id });
    deleted.maintenance_ticket_comments = d1.length;

    const d2 = await tx.delete(schema.maintenanceTickets)
      .where(eq(schema.maintenanceTickets.organizationId, organizationId))
      .returning({ id: schema.maintenanceTickets.id });
    deleted.maintenance_tickets = d2.length;

    if (leaseIdList.length > 0) {
      const d3 = await tx.delete(schema.leaseTenants)
        .where(sql`${schema.leaseTenants.leaseId} IN ${leaseIdList}`)
        .returning({ id: schema.leaseTenants.id });
      deleted.lease_tenants = d3.length;
    } else {
      deleted.lease_tenants = 0;
    }

    const d4 = await tx.delete(schema.leases)
      .where(eq(schema.leases.organizationId, organizationId))
      .returning({ id: schema.leases.id });
    deleted.leases = d4.length;

    const d5 = await tx.delete(schema.tenants)
      .where(eq(schema.tenants.organizationId, organizationId))
      .returning({ id: schema.tenants.id });
    deleted.tenants = d5.length;

    const d6 = await tx.delete(schema.propertyUtilities)
      .where(eq(schema.propertyUtilities.organizationId, organizationId))
      .returning({ id: schema.propertyUtilities.id });
    deleted.property_utilities = d6.length;

    const d7 = await tx.delete(schema.units)
      .where(eq(schema.units.organizationId, organizationId))
      .returning({ id: schema.units.id });
    deleted.units = d7.length;

    const d8 = await tx.delete(schema.properties)
      .where(eq(schema.properties.organizationId, organizationId))
      .returning({ id: schema.properties.id });
    deleted.properties = d8.length;
  });

  return res.status(200).json({
    ok: true,
    dry_run: false,
    organization_id: organizationId,
    deleted,
    total_rows: Object.values(deleted).reduce((s, n) => s + n, 0),
  });
});
