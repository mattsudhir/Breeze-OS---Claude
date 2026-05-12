// POST /api/admin/record-receipt?secret=<TOKEN>
// body: {
//   tenant_id?:        uuid
//   lease_id?:         uuid
//   received_date:     YYYY-MM-DD
//   amount_cents:      integer > 0
//   payment_method:    'cash' | 'check' | 'ach' | 'card' | 'wire' | 'other'
//   external_reference?: string  (check #, ACH trace, etc.)
//   allocations?: [                          optional, default empty
//     { posted_charge_id: uuid, amount_cents: integer }
//   ]
//   undeposited_funds_gl_code?: string       default '1110'
//   tenant_credit_gl_code?:    string         default '2210' if needed
// }
//
// Wraps recordReceipt() — JE: Dr Undeposited Funds, Cr the charge GLs
// (or Cr Tenant Credit for the unallocated remainder).

import { eq, and, inArray } from 'drizzle-orm';
import {
  withAdminHandler,
  getDefaultOrgId,
  parseBody,
} from '../../lib/adminHelpers.js';
import { getDb, schema } from '../../lib/db/index.js';
import { lookupGlAccountByCode } from '../../lib/accounting/posting.js';
import { recordReceipt } from '../../lib/accounting/arPostingFlows.js';

export default withAdminHandler(async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'POST only' });
  }
  const body = parseBody(req);
  const amountCents = Number(body.amount_cents);
  if (!Number.isInteger(amountCents) || amountCents <= 0) {
    return res.status(400).json({ ok: false, error: 'amount_cents must be a positive integer' });
  }
  if (!body.received_date) return res.status(400).json({ ok: false, error: 'received_date required' });
  if (!body.payment_method) return res.status(400).json({ ok: false, error: 'payment_method required' });

  const db = getDb();
  const organizationId = await getDefaultOrgId();

  let result;
  try {
    result = await db.transaction(async (tx) => {
      const undepositedFundsGlAccountId = await lookupGlAccountByCode(
        tx, organizationId, body.undeposited_funds_gl_code || '1110',
      );
      let tenantCreditGlAccountId = null;

      // Look up posted_charges → their GL accounts.
      let allocations = [];
      const totalAllocations = (body.allocations || []).reduce(
        (s, a) => s + Number(a.amount_cents || 0), 0,
      );
      if (body.allocations && body.allocations.length > 0) {
        const ids = body.allocations.map((a) => a.posted_charge_id);
        const charges = await tx
          .select({
            id: schema.postedCharges.id,
            glAccountId: schema.postedCharges.glAccountId,
            balanceCents: schema.postedCharges.balanceCents,
          })
          .from(schema.postedCharges)
          .where(
            and(
              eq(schema.postedCharges.organizationId, organizationId),
              inArray(schema.postedCharges.id, ids),
            ),
          );
        const byId = new Map(charges.map((c) => [c.id, c]));
        for (const a of body.allocations) {
          const c = byId.get(a.posted_charge_id);
          if (!c) {
            throw new Error(`posted_charge ${a.posted_charge_id} not found in org`);
          }
          allocations.push({
            glAccountId: c.glAccountId,
            amountCents: Number(a.amount_cents),
            postedChargeId: a.posted_charge_id,
          });
        }
      }
      if (totalAllocations < amountCents) {
        tenantCreditGlAccountId = await lookupGlAccountByCode(
          tx, organizationId, body.tenant_credit_gl_code || '2210',
        );
      }

      return await recordReceipt(tx, organizationId, {
        undepositedFundsGlAccountId,
        tenantCreditGlAccountId,
        tenantId: body.tenant_id || null,
        leaseId: body.lease_id || null,
        receivedDate: body.received_date,
        amountCents,
        paymentMethod: body.payment_method,
        externalReference: body.external_reference || null,
        allocations,
      });
    });
  } catch (err) {
    return res.status(400).json({ ok: false, error: err.message || String(err) });
  }

  return res.status(200).json({
    ok: true,
    organization_id: organizationId,
    ...result,
  });
});
