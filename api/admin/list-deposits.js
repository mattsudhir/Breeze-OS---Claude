// GET /api/admin/list-deposits?secret=<TOKEN>&limit=200
//
// Drives the Deposits tab. Includes the count of receipts grouped
// into each deposit.

import { eq, desc, sql } from 'drizzle-orm';
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

  const limit = Math.min(
    Math.max(parseInt(req.query?.limit, 10) || 200, 1),
    500,
  );

  const rows = await db
    .select({
      id: schema.deposits.id,
      bankAccountId: schema.deposits.bankAccountId,
      depositDate: schema.deposits.depositDate,
      amountCents: schema.deposits.amountCents,
      depositType: schema.deposits.depositType,
      externalReference: schema.deposits.externalReference,
      status: schema.deposits.status,
      bankDisplay: schema.bankAccounts.displayName,
      receiptCount: sql`(SELECT COUNT(*) FROM ${schema.receipts} WHERE ${schema.receipts.depositId} = ${schema.deposits.id})`.as('receipt_count'),
    })
    .from(schema.deposits)
    .leftJoin(schema.bankAccounts, eq(schema.deposits.bankAccountId, schema.bankAccounts.id))
    .where(eq(schema.deposits.organizationId, organizationId))
    .orderBy(desc(schema.deposits.depositDate))
    .limit(limit);

  return res.status(200).json({
    ok: true,
    organization_id: organizationId,
    count: rows.length,
    deposits: rows.map((d) => ({
      id: d.id,
      bank_account_id: d.bankAccountId,
      bank_account_display: d.bankDisplay,
      deposit_date: d.depositDate,
      amount_cents: Number(d.amountCents),
      deposit_type: d.depositType,
      external_reference: d.externalReference,
      status: d.status,
      receipt_count: Number(d.receiptCount),
    })),
  });
});
