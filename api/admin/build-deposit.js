// POST /api/admin/build-deposit?secret=<TOKEN>
// body: {
//   bank_account_id:    uuid       required
//   deposit_date:       YYYY-MM-DD required
//   deposit_type:       'cash_drawer' | 'lockbox' | 'electronic' | 'transfer' | 'other'
//   receipt_ids:        [uuid]     at least one undeposited receipt
//   external_reference?: string
//   undeposited_funds_gl_code?: string  default '1110'
// }
//
// Wraps buildDeposit(). JE: Dr bank cash, Cr Undeposited Funds.
// Receipts get their deposit_id stamped + status='cleared'.

import { eq, and } from 'drizzle-orm';
import {
  withAdminHandler,
  getDefaultOrgId,
  parseBody,
} from '../../lib/adminHelpers.js';
import { getDb, schema } from '../../lib/db/index.js';
import { lookupGlAccountByCode } from '../../lib/accounting/posting.js';
import { buildDeposit } from '../../lib/accounting/arPostingFlows.js';

export default withAdminHandler(async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'POST only' });
  }
  const body = parseBody(req);
  if (!body.bank_account_id) return res.status(400).json({ ok: false, error: 'bank_account_id required' });
  if (!body.deposit_date) return res.status(400).json({ ok: false, error: 'deposit_date required' });
  if (!body.deposit_type) return res.status(400).json({ ok: false, error: 'deposit_type required' });
  if (!Array.isArray(body.receipt_ids) || body.receipt_ids.length === 0) {
    return res.status(400).json({ ok: false, error: 'receipt_ids required' });
  }

  const db = getDb();
  const organizationId = await getDefaultOrgId();

  // Get bank's GL.
  const [bank] = await db
    .select({ id: schema.bankAccounts.id, glAccountId: schema.bankAccounts.glAccountId })
    .from(schema.bankAccounts)
    .where(
      and(
        eq(schema.bankAccounts.id, body.bank_account_id),
        eq(schema.bankAccounts.organizationId, organizationId),
      ),
    )
    .limit(1);
  if (!bank) return res.status(404).json({ ok: false, error: 'bank_account not found' });

  let result;
  try {
    result = await db.transaction(async (tx) => {
      const undepositedFundsGlAccountId = await lookupGlAccountByCode(
        tx, organizationId, body.undeposited_funds_gl_code || '1110',
      );
      return await buildDeposit(tx, organizationId, {
        bankCashGlAccountId: bank.glAccountId,
        undepositedFundsGlAccountId,
        depositDate: body.deposit_date,
        depositType: body.deposit_type,
        receiptIds: body.receipt_ids,
        externalReference: body.external_reference || null,
        bankAccountId: bank.id,
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
