// GET /api/admin/list-receipts?secret=<TOKEN>
//   &deposit_status=undeposited | deposited
//   &limit=200
//
// Drives the Receipts tab. Joins tenant + lease for display.

import { and, eq, desc, isNull, sql } from 'drizzle-orm';
import {
  withAdminHandler,
  getDefaultOrgId,
} from '../../lib/adminHelpers.js';
import { getDb, schema } from '../../lib/db/index.js';

export default withAdminHandler(async (req, res) => {
  if (req.method !== 'GET') {
    return res.status(405).json({ ok: false, error: 'GET only' });
  }
  const db = getDb();
  const organizationId = await getDefaultOrgId();

  const depositFilter = req.query?.deposit_status || null;
  const limit = Math.min(
    Math.max(parseInt(req.query?.limit, 10) || 200, 1),
    500,
  );

  const whereClauses = [eq(schema.receipts.organizationId, organizationId)];
  if (depositFilter === 'undeposited') {
    whereClauses.push(isNull(schema.receipts.depositId));
  } else if (depositFilter === 'deposited') {
    whereClauses.push(sql`${schema.receipts.depositId} IS NOT NULL`);
  }

  const rows = await db
    .select({
      id: schema.receipts.id,
      receivedDate: schema.receipts.receivedDate,
      amountCents: schema.receipts.amountCents,
      paymentMethod: schema.receipts.paymentMethod,
      externalReference: schema.receipts.externalReference,
      depositId: schema.receipts.depositId,
      status: schema.receipts.status,
      tenantId: schema.receipts.tenantId,
      leaseId: schema.receipts.leaseId,
      tenantDisplay: schema.tenants.displayName,
      leaseNumber: schema.leases.leaseNumber,
    })
    .from(schema.receipts)
    .leftJoin(schema.tenants, eq(schema.receipts.tenantId, schema.tenants.id))
    .leftJoin(schema.leases, eq(schema.receipts.leaseId, schema.leases.id))
    .where(and(...whereClauses))
    .orderBy(desc(schema.receipts.receivedDate))
    .limit(limit);

  // Summary: undeposited total
  const [undepositedRow] = await db
    .select({
      total: sql`COALESCE(SUM(${schema.receipts.amountCents}), 0)`.as('total'),
      count: sql`COUNT(*)`.as('count'),
    })
    .from(schema.receipts)
    .where(
      and(
        eq(schema.receipts.organizationId, organizationId),
        isNull(schema.receipts.depositId),
      ),
    );

  return res.status(200).json({
    ok: true,
    organization_id: organizationId,
    count: rows.length,
    undeposited_total_cents: Number(undepositedRow?.total || 0),
    undeposited_count: Number(undepositedRow?.count || 0),
    receipts: rows.map((r) => ({
      id: r.id,
      received_date: r.receivedDate,
      amount_cents: Number(r.amountCents),
      payment_method: r.paymentMethod,
      external_reference: r.externalReference,
      deposit_id: r.depositId,
      status: r.status,
      tenant_id: r.tenantId,
      tenant_display: r.tenantDisplay,
      lease_id: r.leaseId,
      lease_number: r.leaseNumber,
    })),
  });
});
