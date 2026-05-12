// POST /api/admin/clear-plaid-state?secret=<TOKEN>
// body: { confirm: true }   // required — destructive
//
// Wipes every bank_account's Plaid linkage in the org. Use case:
// flipping PLAID_ENV from sandbox → production. Sandbox items and
// production items are not interoperable (different keypairs), so
// holding the encrypted sandbox access_tokens is just clutter — and
// future syncs would fail trying to use them against production
// Plaid.
//
// What it does, per row:
//   plaid_status                  → 'unlinked'
//   plaid_access_token_encrypted  → NULL
//   plaid_item_id                 → NULL
//   plaid_account_id              → NULL
//   plaid_cursor                  → NULL
//   current_balance_cents         → NULL  (stale anyway)
//   balance_as_of                 → NULL
//
// Preserves: the gl_account_id link (so the underlying GL account
// stays intact), display name, account type, notes. Re-linking via
// Plaid Link in production will re-populate the Plaid fields.
//
// Idempotent. Logs to audit_events per bank account.

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
  if (body.confirm !== true) {
    return res.status(400).json({
      ok: false,
      error: 'Pass {"confirm": true} to acknowledge this clears all Plaid linkage.',
    });
  }

  const db = getDb();
  const organizationId = await getDefaultOrgId();

  const linked = await db
    .select({
      id: schema.bankAccounts.id,
      displayName: schema.bankAccounts.displayName,
      plaidItemId: schema.bankAccounts.plaidItemId,
      plaidStatus: schema.bankAccounts.plaidStatus,
    })
    .from(schema.bankAccounts)
    .where(eq(schema.bankAccounts.organizationId, organizationId));

  const toClear = linked.filter((b) => b.plaidItemId || b.plaidStatus === 'linked');
  if (toClear.length === 0) {
    return res.status(200).json({
      ok: true,
      organization_id: organizationId,
      cleared: 0,
      message: 'No Plaid-linked bank accounts to clear.',
    });
  }

  await db.transaction(async (tx) => {
    await tx
      .update(schema.bankAccounts)
      .set({
        plaidStatus: 'unlinked',
        plaidAccessTokenEncrypted: null,
        plaidItemId: null,
        plaidAccountId: null,
        plaidCursor: null,
        currentBalanceCents: null,
        balanceAsOf: null,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(schema.bankAccounts.organizationId, organizationId),
        ),
      );

    for (const b of toClear) {
      await tx.insert(schema.auditEvents).values({
        organizationId,
        actorType: 'admin_action',
        actorId: null,
        subjectTable: 'bank_accounts',
        subjectId: b.id,
        eventType: 'plaid_state_cleared',
        beforeState: {
          plaid_status: b.plaidStatus,
          plaid_item_id: b.plaidItemId,
        },
        afterState: { plaid_status: 'unlinked' },
      });
    }
  });

  return res.status(200).json({
    ok: true,
    organization_id: organizationId,
    cleared: toClear.length,
    bank_accounts: toClear.map((b) => ({ id: b.id, display_name: b.displayName })),
  });
});
