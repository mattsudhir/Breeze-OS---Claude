// POST /api/admin/pay-bill?secret=<TOKEN>
// body: {
//   vendor_id:        uuid                  required
//   bank_account_id:  uuid                  required
//   payment_date:     YYYY-MM-DD            required
//   payment_method:   enum                  required
//   external_reference?: string             check #, ACH trace, etc.
//   memo?:            string
//   allocations: [
//     { bill_id: uuid, amount_cents: integer > 0 }, ...
//   ]
// }
//
// Creates a bill_payment, allocates against the named bills, posts
// a 'bill_payment' JE (debit AP, credit cash), and decrements each
// bill's balance_cents.

import {
  withAdminHandler,
  getDefaultOrgId,
  parseBody,
} from '../../lib/adminHelpers.js';
import { getDb } from '../../lib/db/index.js';
import { payBill } from '../../lib/accounting/apPostingFlows.js';

export default withAdminHandler(async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'POST only' });
  }
  const body = parseBody(req);

  const db = getDb();
  const organizationId = await getDefaultOrgId();

  let result;
  try {
    result = await db.transaction(async (tx) => payBill(tx, organizationId, {
      vendorId: body.vendor_id,
      bankAccountId: body.bank_account_id,
      paymentDate: body.payment_date,
      paymentMethod: body.payment_method,
      externalReference: body.external_reference,
      memo: body.memo,
      allocations: (body.allocations || []).map((a) => ({
        billId: a.bill_id,
        amountCents: Number(a.amount_cents),
      })),
    }));
  } catch (err) {
    return res.status(400).json({ ok: false, error: err.message || String(err) });
  }

  return res.status(200).json({
    ok: true,
    organization_id: organizationId,
    bill_payment_id: result.billPaymentId,
    journal_entry_id: result.journalEntryId,
    entry_number: result.entryNumber,
    total_cents: result.totalCents,
  });
});
