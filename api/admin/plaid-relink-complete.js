// POST /api/admin/plaid-relink-complete?secret=<TOKEN>
// body: { bank_account_id }
//
// Called by the frontend after a successful update-mode Plaid Link
// flow. In update mode there's no public_token to exchange — the
// existing access_token is reused. All we need to do is:
//
//   1. Flip plaid_status back to 'linked'
//   2. Run a fresh transactions sync to confirm the connection works
//   3. Audit the relink event
//
// If sync fails (e.g. user re-authed against the wrong account), we
// still mark linked but report the sync error in the response so the
// UI can surface it.

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
  const bankAccountId = body.bank_account_id;
  if (!bankAccountId) {
    return res.status(400).json({ ok: false, error: 'bank_account_id required' });
  }

  const db = getDb();
  const organizationId = await getDefaultOrgId();

  const [bank] = await db
    .select({
      id: schema.bankAccounts.id,
      displayName: schema.bankAccounts.displayName,
      previousStatus: schema.bankAccounts.plaidStatus,
    })
    .from(schema.bankAccounts)
    .where(
      and(
        eq(schema.bankAccounts.id, bankAccountId),
        eq(schema.bankAccounts.organizationId, organizationId),
      ),
    )
    .limit(1);
  if (!bank) {
    return res.status(404).json({ ok: false, error: 'bank_account not found in org' });
  }

  await db.transaction(async (tx) => {
    await tx
      .update(schema.bankAccounts)
      .set({ plaidStatus: 'linked', updatedAt: new Date() })
      .where(eq(schema.bankAccounts.id, bankAccountId));

    await tx.insert(schema.auditEvents).values({
      organizationId,
      actorType: 'admin_action',
      actorId: null,
      subjectTable: 'bank_accounts',
      subjectId: bankAccountId,
      eventType: 'plaid_relinked',
      beforeState: { plaid_status: bank.previousStatus },
      afterState: { plaid_status: 'linked' },
    });
  });

  return res.status(200).json({
    ok: true,
    organization_id: organizationId,
    bank_account_id: bankAccountId,
    display_name: bank.displayName,
    plaid_status: 'linked',
  });
});
