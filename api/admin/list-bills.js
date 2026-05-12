// GET /api/admin/list-bills?secret=<TOKEN>&status=open
//
// status filter: open (default — draft + posted-with-balance>0),
// all, draft, posted, voided, paid.

import { and, desc, eq, gt, ne, or, sql } from 'drizzle-orm';
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
  const statusFilter = req.query?.status || 'open';
  const limit = Math.min(Math.max(parseInt(req.query?.limit, 10) || 200, 1), 500);

  const whereClauses = [eq(schema.bills.organizationId, organizationId)];
  if (statusFilter === 'open') {
    // Drafts + posted with balance remaining.
    whereClauses.push(
      or(
        eq(schema.bills.status, 'draft'),
        and(
          eq(schema.bills.status, 'posted'),
          gt(schema.bills.balanceCents, 0),
        ),
      ),
    );
  } else if (statusFilter === 'paid') {
    whereClauses.push(eq(schema.bills.status, 'posted'));
    whereClauses.push(eq(schema.bills.balanceCents, 0));
  } else if (['draft', 'posted', 'voided'].includes(statusFilter)) {
    whereClauses.push(eq(schema.bills.status, statusFilter));
  } else if (statusFilter !== 'all') {
    whereClauses.push(ne(schema.bills.status, 'voided'));
  }

  const rows = await db
    .select({
      id: schema.bills.id,
      vendorId: schema.bills.vendorId,
      vendorName: schema.vendors.displayName,
      billNumber: schema.bills.billNumber,
      billDate: schema.bills.billDate,
      dueDate: schema.bills.dueDate,
      amountCents: schema.bills.amountCents,
      balanceCents: schema.bills.balanceCents,
      status: schema.bills.status,
      memo: schema.bills.memo,
      apGlCode: schema.glAccounts.code,
      apGlName: schema.glAccounts.name,
      journalEntryId: schema.bills.journalEntryId,
      postedAt: schema.bills.postedAt,
    })
    .from(schema.bills)
    .leftJoin(schema.vendors, eq(schema.bills.vendorId, schema.vendors.id))
    .leftJoin(schema.glAccounts, eq(schema.bills.apGlAccountId, schema.glAccounts.id))
    .where(and(...whereClauses))
    .orderBy(desc(schema.bills.dueDate))
    .limit(limit);

  // Summary
  const [openTotal] = await db
    .select({
      balance: sql`COALESCE(SUM(${schema.bills.balanceCents}), 0)`.as('balance'),
      count: sql`COUNT(*)`.as('count'),
    })
    .from(schema.bills)
    .where(
      and(
        eq(schema.bills.organizationId, organizationId),
        eq(schema.bills.status, 'posted'),
        gt(schema.bills.balanceCents, 0),
      ),
    );

  return res.status(200).json({
    ok: true,
    organization_id: organizationId,
    count: rows.length,
    open_balance_cents: Number(openTotal?.balance || 0),
    open_count: Number(openTotal?.count || 0),
    bills: rows.map((b) => ({
      id: b.id,
      vendor_id: b.vendorId,
      vendor_name: b.vendorName,
      bill_number: b.billNumber,
      bill_date: b.billDate,
      due_date: b.dueDate,
      amount_cents: Number(b.amountCents),
      balance_cents: Number(b.balanceCents),
      status: b.status,
      memo: b.memo,
      ap_gl_code: b.apGlCode,
      ap_gl_name: b.apGlName,
      journal_entry_id: b.journalEntryId,
      posted_at: b.postedAt,
    })),
  });
});
