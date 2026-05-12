// POST /api/admin/set-bank-bill-com-id?secret=<TOKEN>
// body: { bank_account_id, bill_com_bank_account_id }
//
// Sets the Bill.com bank account id mapping. Pass an empty string
// or null to clear.

import { and, eq } from 'drizzle-orm';
import {
  withAdminHandler,
  getDefaultOrgId,
  parseBody,
} from '../../lib/adminHelpers.js';
import { getDb, schema } from '../../lib/db/index.js';

export default withAdminHandler(async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'POST only' });
  }
  const body = parseBody(req);
  if (!body.bank_account_id) return res.status(400).json({ ok: false, error: 'bank_account_id required' });
  const value = body.bill_com_bank_account_id
    ? String(body.bill_com_bank_account_id).trim()
    : null;

  const db = getDb();
  const organizationId = await getDefaultOrgId();

  const updated = await db
    .update(schema.bankAccounts)
    .set({ billComBankAccountId: value, updatedAt: new Date() })
    .where(
      and(
        eq(schema.bankAccounts.id, body.bank_account_id),
        eq(schema.bankAccounts.organizationId, organizationId),
      ),
    )
    .returning({ id: schema.bankAccounts.id });

  if (updated.length === 0) {
    return res.status(404).json({ ok: false, error: 'bank_account not found' });
  }

  return res.status(200).json({
    ok: true,
    bank_account_id: updated[0].id,
    bill_com_bank_account_id: value,
  });
});
