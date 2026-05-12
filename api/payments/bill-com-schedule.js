// POST /api/payments/bill-com-schedule?secret=<TOKEN>
// body: {
//   bill_id:          uuid       required — bill in our system to pay
//   bank_account_id:  uuid       required — must have bill_com_bank_account_id set
//   payment_date:     YYYY-MM-DD required
//   process_date?:    YYYY-MM-DD when Bill.com debits the bank
//   delivery_method?: 'ACH' | 'Check' | 'Card'   default 'ACH'
//   memo?:            string
//   amount_cents?:    integer    partial payment; defaults to bill.balance_cents
// }
//
// Schedules an outbound payment via Bill.com for a bill in our DB.
// Walks the same payBill() helper used by the manual-pay endpoint —
// so the journal entry, allocations, and balance update behavior is
// identical. The Bill.com-specific pieces are:
//   1. Resolve vendor.bill_com_vendor_id + bank_account.bill_com_bank_account_id
//   2. Schedule the payment via Bill.com
//   3. Stamp the bill_payments row with bill_com_payment_id + status
//
// Webhook updates roll bill_com_status forward as Bill.com confirms
// scheduling → sending → cleared.

import { and, eq } from 'drizzle-orm';
import {
  withAdminHandler,
  getDefaultOrgId,
  parseBody,
} from '../../lib/adminHelpers.js';
import { getDb, schema } from '../../lib/db/index.js';
import { payBill } from '../../lib/accounting/apPostingFlows.js';
import { schedulePayment, isBillComConfigured } from '../../lib/backends/billcom.js';

export default withAdminHandler(async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'POST only' });
  }
  if (!isBillComConfigured()) {
    return res.status(503).json({
      ok: false,
      error: 'Bill.com not configured. Set BILL_COM_DEV_KEY, BILL_COM_USER_NAME, BILL_COM_PASSWORD, BILL_COM_ORG_ID env vars.',
    });
  }

  const body = parseBody(req);
  if (!body.bill_id)         return res.status(400).json({ ok: false, error: 'bill_id required' });
  if (!body.bank_account_id) return res.status(400).json({ ok: false, error: 'bank_account_id required' });
  if (!body.payment_date)    return res.status(400).json({ ok: false, error: 'payment_date required' });

  const db = getDb();
  const organizationId = await getDefaultOrgId();

  // Load bill + vendor + bank.
  const [bill] = await db
    .select({
      id: schema.bills.id,
      vendorId: schema.bills.vendorId,
      balanceCents: schema.bills.balanceCents,
      status: schema.bills.status,
    })
    .from(schema.bills)
    .where(
      and(
        eq(schema.bills.id, body.bill_id),
        eq(schema.bills.organizationId, organizationId),
      ),
    )
    .limit(1);
  if (!bill) return res.status(404).json({ ok: false, error: 'bill not found' });
  if (bill.status !== 'posted') {
    return res.status(400).json({ ok: false, error: 'bill must be posted to pay' });
  }

  const [vendor] = await db
    .select({
      id: schema.vendors.id,
      displayName: schema.vendors.displayName,
      billComVendorId: schema.vendors.billComVendorId,
    })
    .from(schema.vendors)
    .where(eq(schema.vendors.id, bill.vendorId))
    .limit(1);
  if (!vendor?.billComVendorId) {
    return res.status(400).json({
      ok: false,
      error: 'Vendor has no bill_com_vendor_id. Set it on the vendor record before scheduling.',
    });
  }

  const [bank] = await db
    .select({
      id: schema.bankAccounts.id,
      billComBankAccountId: schema.bankAccounts.billComBankAccountId,
    })
    .from(schema.bankAccounts)
    .where(
      and(
        eq(schema.bankAccounts.id, body.bank_account_id),
        eq(schema.bankAccounts.organizationId, organizationId),
      ),
    )
    .limit(1);
  if (!bank?.billComBankAccountId) {
    return res.status(400).json({
      ok: false,
      error: 'Bank account has no bill_com_bank_account_id. Set it before scheduling via Bill.com.',
    });
  }

  const amountCents = Number(body.amount_cents) || Number(bill.balanceCents);
  if (amountCents <= 0 || amountCents > Number(bill.balanceCents)) {
    return res.status(400).json({
      ok: false,
      error: `amount_cents must be 1..${bill.balanceCents}`,
    });
  }

  // 1. Schedule with Bill.com FIRST. If that throws, we never write
  //    a payment row — no JE, no allocation, clean failure.
  let billComResult;
  try {
    billComResult = await schedulePayment({
      billComVendorId: vendor.billComVendorId,
      billComBankAccountId: bank.billComBankAccountId,
      amountCents,
      paymentDate: body.payment_date,
      processDate: body.process_date,
      deliveryMethod: body.delivery_method || 'ACH',
      memo: body.memo || `Breeze OS payment to ${vendor.displayName}`,
    });
  } catch (err) {
    return res.status(502).json({ ok: false, error: err.message || String(err) });
  }

  // 2. Post our payment + allocation + JE in one transaction, then
  //    stamp the Bill.com identifiers.
  let payResult;
  try {
    payResult = await db.transaction(async (tx) => {
      const result = await payBill(tx, organizationId, {
        vendorId: bill.vendorId,
        bankAccountId: bank.id,
        paymentDate: body.payment_date,
        paymentMethod: 'bill_com',
        externalReference: billComResult.billComPaymentId,
        memo: body.memo || null,
        allocations: [{ billId: bill.id, amountCents }],
      });
      await tx
        .update(schema.billPayments)
        .set({
          billComPaymentId: billComResult.billComPaymentId,
          billComStatus: billComResult.status,
          billComSyncedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(schema.billPayments.id, result.billPaymentId));
      return result;
    });
  } catch (err) {
    // Bill.com payment scheduled but our books didn't write — flag it.
    return res.status(500).json({
      ok: false,
      error: `Bill.com payment scheduled (id ${billComResult.billComPaymentId}) but our books failed: ${err.message}. Use /api/admin/sync-bill-com-payments to reconcile.`,
      bill_com_payment_id: billComResult.billComPaymentId,
    });
  }

  return res.status(200).json({
    ok: true,
    organization_id: organizationId,
    bill_payment_id: payResult.billPaymentId,
    bill_com_payment_id: billComResult.billComPaymentId,
    bill_com_status: billComResult.status,
    journal_entry_id: payResult.journalEntryId,
    amount_cents: amountCents,
  });
});
