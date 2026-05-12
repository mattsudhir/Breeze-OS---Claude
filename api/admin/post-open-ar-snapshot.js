// POST /api/admin/post-open-ar-snapshot?secret=<TOKEN>
// body: {
//   entry_date: 'YYYY-MM-DD',     cutover date
//   entity_id:  uuid,             owning entity (inherited onto all JE lines)
//   ar_gl_code?: '1210',          AR sub-account to debit; defaults to 1200
//   offset_gl_code?: '3900',      equity account credited; default 3900
//                                 (Retained Earnings)
//   memo?: string,
//   lines: [
//     {
//       tenant_id:    uuid,
//       lease_id?:    uuid,
//       property_id?: uuid,
//       unit_id?:     uuid,
//       amount_cents: integer > 0,   tenant's open AR balance at cutover
//       charge_type?: string,        default 'opening_balance_ar'
//       description?: string,
//       due_date?:    'YYYY-MM-DD',  default same as entry_date
//     }, ...
//   ]
// }
//
// Third leg of the AppFolio cutover (after directory import + opening
// balance JE). Records each tenant's unpaid balance at cutover as a
// posted_charges row so the AR queries that already drive the
// Receivables tab work without any special-casing.
//
// Implementation:
//   For each line:
//     1. Post a journal_entry of type 'opening_balance' that debits
//        the AR account and credits the offset (retained earnings).
//        Line is tagged with the tenant + property + entity dimension
//        so per-entity / per-tenant balances roll up correctly.
//     2. Insert a posted_charges row referencing that JE with
//        balance_cents = amount_cents and status='open'. Future
//        receipt allocations pay it down through the normal flow.
//
// All work happens in a single Drizzle transaction; if any line
// fails (e.g. bad tenant id) the whole snapshot rolls back.

import { and, eq } from 'drizzle-orm';
import {
  withAdminHandler,
  getDefaultOrgId,
  parseBody,
} from '../../lib/adminHelpers.js';
import { getDb, schema } from '../../lib/db/index.js';
import { lookupGlAccountByCode, postJournalEntry } from '../../lib/accounting/posting.js';

export default withAdminHandler(async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'POST only' });
  }
  const body = parseBody(req);
  const entryDate = body.entry_date;
  const entityId = body.entity_id || null;
  const arCode = body.ar_gl_code || '1200';
  const offsetCode = body.offset_gl_code || '3900';
  const baseMemo = body.memo || 'Opening AR snapshot';
  const lines = Array.isArray(body.lines) ? body.lines : [];

  if (!entryDate || !/^\d{4}-\d{2}-\d{2}$/.test(entryDate)) {
    return res.status(400).json({ ok: false, error: 'entry_date required (YYYY-MM-DD)' });
  }
  if (!entityId) {
    return res.status(400).json({ ok: false, error: 'entity_id required' });
  }
  if (lines.length === 0) {
    return res.status(400).json({ ok: false, error: 'lines[] required' });
  }
  for (const [i, l] of lines.entries()) {
    if (!l.tenant_id) {
      return res.status(400).json({ ok: false, error: `lines[${i}].tenant_id required` });
    }
    const amt = Number(l.amount_cents);
    if (!Number.isInteger(amt) || amt <= 0) {
      return res.status(400).json({ ok: false, error: `lines[${i}].amount_cents must be a positive integer` });
    }
  }

  const db = getDb();
  const organizationId = await getDefaultOrgId();

  // Confirm entity is in org.
  const [entity] = await db
    .select({ id: schema.entities.id })
    .from(schema.entities)
    .where(
      and(
        eq(schema.entities.id, entityId),
        eq(schema.entities.organizationId, organizationId),
      ),
    )
    .limit(1);
  if (!entity) {
    return res.status(404).json({ ok: false, error: 'entity_id not in org' });
  }

  let result;
  try {
    result = await db.transaction(async (tx) => {
      const arGlAccountId = await lookupGlAccountByCode(tx, organizationId, arCode);
      const offsetGlAccountId = await lookupGlAccountByCode(tx, organizationId, offsetCode);

      const postedCharges = [];

      for (const l of lines) {
        const amountCents = Number(l.amount_cents);
        const tenantId = l.tenant_id;
        const memo = l.description || `${baseMemo} — tenant ${tenantId}`;
        const chargeType = l.charge_type || 'opening_balance_ar';
        const dueDate = l.due_date || entryDate;

        const je = await postJournalEntry(tx, organizationId, {
          entryDate,
          entryType: 'opening_balance',
          memo,
          sourceTable: 'opening_ar_snapshot',
          sourceId: null,
          lines: [
            {
              glAccountId: arGlAccountId,
              debitCents: amountCents,
              creditCents: 0,
              memo,
              entityId,
              tenantId,
              leaseId: l.lease_id || null,
              propertyId: l.property_id || null,
              unitId: l.unit_id || null,
            },
            {
              glAccountId: offsetGlAccountId,
              debitCents: 0,
              creditCents: amountCents,
              memo,
              entityId,
            },
          ],
        });

        const [pc] = await tx
          .insert(schema.postedCharges)
          .values({
            organizationId,
            leaseId: l.lease_id || null,
            unitId: l.unit_id || null,
            propertyId: l.property_id || null,
            tenantId,
            chargeType,
            description: memo,
            chargeDate: entryDate,
            dueDate,
            amountCents,
            balanceCents: amountCents,
            glAccountId: arGlAccountId,
            journalEntryId: je.journalEntryId,
            status: 'open',
          })
          .returning({ id: schema.postedCharges.id });

        postedCharges.push({
          posted_charge_id: pc.id,
          journal_entry_id: je.journalEntryId,
          entry_number: je.entryNumber,
          tenant_id: tenantId,
          amount_cents: amountCents,
        });
      }

      return postedCharges;
    });
  } catch (err) {
    return res.status(400).json({ ok: false, error: err.message || String(err) });
  }

  return res.status(200).json({
    ok: true,
    organization_id: organizationId,
    entity_id: entityId,
    line_count: result.length,
    total_cents: result.reduce((s, r) => s + r.amount_cents, 0),
    posted: result,
  });
});
