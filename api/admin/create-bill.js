// POST /api/admin/create-bill?secret=<TOKEN>
// body: {
//   vendor_id:      uuid          required
//   bill_number?:   string        vendor's invoice number
//   bill_date:      YYYY-MM-DD    required
//   due_date?:      YYYY-MM-DD    defaults to bill_date + vendor.payment_terms_days
//   ap_gl_code?:    string        defaults to '2010' (AP - Trade Vendors)
//   memo?:          string
//   post_immediately?: boolean    if true, also runs postBill() after create.
//   lines: [                       at least 1, summed = bill total
//     {
//       gl_account_code?:  string       use this OR gl_account_id
//       gl_account_id?:    uuid
//       amount_cents:      integer > 0
//       memo?:             string
//       property_id?:      uuid
//       unit_id?:          uuid
//       entity_id?:        uuid
//     }
//   ]
// }

import { and, eq } from 'drizzle-orm';
import {
  withAdminHandler,
  getDefaultOrgId,
  parseBody,
} from '../../lib/adminHelpers.js';
import { getDb, schema } from '../../lib/db/index.js';
import { lookupGlAccountByCode } from '../../lib/accounting/posting.js';
import { postBill } from '../../lib/accounting/apPostingFlows.js';

export default withAdminHandler(async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'POST only' });
  }
  const body = parseBody(req);

  if (!body.vendor_id) return res.status(400).json({ ok: false, error: 'vendor_id required' });
  if (!body.bill_date || !/^\d{4}-\d{2}-\d{2}$/.test(body.bill_date)) {
    return res.status(400).json({ ok: false, error: 'bill_date required (YYYY-MM-DD)' });
  }
  if (!Array.isArray(body.lines) || body.lines.length === 0) {
    return res.status(400).json({ ok: false, error: 'lines[] required' });
  }
  for (const [i, l] of body.lines.entries()) {
    const amt = Number(l.amount_cents);
    if (!Number.isInteger(amt) || amt <= 0) {
      return res.status(400).json({ ok: false, error: `lines[${i}].amount_cents must be a positive integer` });
    }
    if (!l.gl_account_id && !l.gl_account_code) {
      return res.status(400).json({ ok: false, error: `lines[${i}] must have gl_account_id or gl_account_code` });
    }
  }

  const db = getDb();
  const organizationId = await getDefaultOrgId();

  const [vendor] = await db
    .select({
      id: schema.vendors.id,
      paymentTermsDays: schema.vendors.paymentTermsDays,
    })
    .from(schema.vendors)
    .where(
      and(
        eq(schema.vendors.id, body.vendor_id),
        eq(schema.vendors.organizationId, organizationId),
      ),
    )
    .limit(1);
  if (!vendor) return res.status(404).json({ ok: false, error: 'vendor not found' });

  // Compute due date if not given.
  let dueDate = body.due_date;
  if (!dueDate || !/^\d{4}-\d{2}-\d{2}$/.test(dueDate)) {
    const d = new Date(body.bill_date + 'T00:00:00Z');
    d.setUTCDate(d.getUTCDate() + (vendor.paymentTermsDays || 30));
    dueDate = d.toISOString().slice(0, 10);
  }

  const apCode = body.ap_gl_code || '2010';
  let result;
  try {
    result = await db.transaction(async (tx) => {
      const apGlAccountId = await lookupGlAccountByCode(tx, organizationId, apCode);

      // Resolve each line's gl_account_id.
      const resolvedLines = [];
      let lineNumber = 0;
      let total = 0;
      for (const l of body.lines) {
        lineNumber += 1;
        const amt = Number(l.amount_cents);
        const glId = l.gl_account_id
          || await lookupGlAccountByCode(tx, organizationId, l.gl_account_code);
        resolvedLines.push({
          organizationId,
          lineNumber,
          glAccountId: glId,
          amountCents: amt,
          memo: l.memo || null,
          propertyId: l.property_id || null,
          unitId: l.unit_id || null,
          entityId: l.entity_id || null,
        });
        total += amt;
      }

      const [bill] = await tx
        .insert(schema.bills)
        .values({
          organizationId,
          vendorId: body.vendor_id,
          billNumber: body.bill_number || null,
          billDate: body.bill_date,
          dueDate,
          amountCents: total,
          balanceCents: total,
          apGlAccountId,
          status: 'draft',
          memo: body.memo || null,
        })
        .returning({ id: schema.bills.id });

      // Insert lines with bill_id back-filled.
      for (const rl of resolvedLines) {
        rl.billId = bill.id;
      }
      await tx.insert(schema.billLines).values(resolvedLines);

      let postedJe = null;
      if (body.post_immediately === true) {
        postedJe = await postBill(tx, organizationId, bill.id);
      }
      return { billId: bill.id, total, postedJe };
    });
  } catch (err) {
    return res.status(400).json({ ok: false, error: err.message || String(err) });
  }

  return res.status(200).json({
    ok: true,
    organization_id: organizationId,
    bill_id: result.billId,
    total_cents: result.total,
    posted: result.postedJe ? {
      journal_entry_id: result.postedJe.journalEntryId,
      entry_number: result.postedJe.entryNumber,
    } : null,
  });
});
