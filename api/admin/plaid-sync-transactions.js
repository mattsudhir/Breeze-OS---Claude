// POST /api/admin/plaid-sync-transactions?secret=<TOKEN>
// body: { bank_account_id?: string }   // optional; defaults to all linked
//
// Pulls fresh transactions from Plaid for the specified bank_account
// (or every linked bank_account in the org) using the
// /transactions/sync incremental endpoint. New transactions are
// inserted into bank_transactions with ON CONFLICT DO NOTHING so
// repeated calls are safe. The cursor is persisted on bank_accounts
// so subsequent calls only pull deltas.
//
// Plaid's sign convention: positive amount = money OUT of the
// account (debit), negative = money IN (credit). We store as-is
// and document; the match-candidate engine handles sign translation
// when comparing to journal_lines.

import { and, eq } from 'drizzle-orm';
import {
  withAdminHandler,
  getDefaultOrgId,
  parseBody,
} from '../../lib/adminHelpers.js';
import { getDb, schema } from '../../lib/db/index.js';
import {
  syncTransactions,
  isPlaidConfigured,
} from '../../lib/backends/plaid.js';
import { decryptText, isEncryptionConfigured } from '../../lib/encryption.js';

export default withAdminHandler(async (req, res) => {
  if (req.method !== 'POST' && req.method !== 'GET') {
    return res.status(405).json({ ok: false, error: 'GET or POST only' });
  }
  if (!isPlaidConfigured()) {
    return res.status(503).json({ ok: false, error: 'Plaid not configured.' });
  }
  if (!isEncryptionConfigured()) {
    return res.status(503).json({ ok: false, error: 'BREEZE_ENCRYPTION_KEY not set.' });
  }

  const body = parseBody(req);
  const targetBankAccountId = body.bank_account_id || req.query?.bank_account_id || null;
  const organizationId = await getDefaultOrgId();
  const db = getDb();

  // Fetch linked bank_accounts (one or all).
  const whereClauses = [
    eq(schema.bankAccounts.organizationId, organizationId),
    eq(schema.bankAccounts.plaidStatus, 'linked'),
  ];
  if (targetBankAccountId) {
    whereClauses.push(eq(schema.bankAccounts.id, targetBankAccountId));
  }

  const banks = await db
    .select({
      id: schema.bankAccounts.id,
      displayName: schema.bankAccounts.displayName,
      plaidItemId: schema.bankAccounts.plaidItemId,
      plaidAccountId: schema.bankAccounts.plaidAccountId,
      plaidCursor: schema.bankAccounts.plaidCursor,
      plaidAccessTokenEncrypted: schema.bankAccounts.plaidAccessTokenEncrypted,
    })
    .from(schema.bankAccounts)
    .where(and(...whereClauses));

  if (banks.length === 0) {
    return res.status(200).json({
      ok: true,
      message: 'No Plaid-linked bank accounts found.',
      synced: [],
    });
  }

  // Plaid's sync endpoint is per-Item (= per access_token), but
  // returns transactions across every account in the item. Group
  // banks by item_id so we only call sync once per item.
  const banksByItem = new Map();
  for (const b of banks) {
    if (!b.plaidItemId || !b.plaidAccessTokenEncrypted) continue;
    if (!banksByItem.has(b.plaidItemId)) banksByItem.set(b.plaidItemId, []);
    banksByItem.get(b.plaidItemId).push(b);
  }

  const syncedItems = [];

  for (const [itemId, itemBanks] of banksByItem) {
    const first = itemBanks[0];
    let accessToken;
    try {
      accessToken = decryptText(first.plaidAccessTokenEncrypted);
    } catch (err) {
      syncedItems.push({
        item_id: itemId,
        error: `decrypt access_token failed: ${err.message}`,
      });
      continue;
    }

    // All banks in the same item share a cursor — they were all
    // linked by the same Link session and Plaid tracks deltas per
    // item, not per account. Use the cursor from the first bank.
    let cursor = first.plaidCursor;

    let synced;
    try {
      synced = await syncTransactions(accessToken, cursor);
    } catch (err) {
      syncedItems.push({
        item_id: itemId,
        error: `Plaid sync failed: ${err.message}`,
      });
      continue;
    }

    // Index our banks by plaid_account_id so we can route added/
    // modified rows.
    const bankByPlaidAcct = new Map(
      itemBanks.map((b) => [b.plaidAccountId, b]),
    );

    let insertedCount = 0;
    let skippedCount = 0;

    await db.transaction(async (tx) => {
      for (const txn of synced.added) {
        const bank = bankByPlaidAcct.get(txn.account_id);
        if (!bank) {
          skippedCount += 1;
          continue;
        }
        // Plaid amount: positive = out (debit), negative = in (credit).
        // Convert dollars to cents for storage.
        const amountCents = Math.round(Number(txn.amount) * 100);
        const result = await tx
          .insert(schema.bankTransactions)
          .values({
            organizationId,
            bankAccountId: bank.id,
            externalId: txn.transaction_id,
            postedDate: txn.date,
            amountCents,
            description: txn.name || null,
            merchantName: txn.merchant_name || null,
            pending: !!txn.pending,
            rawPayload: txn,
          })
          .onConflictDoNothing()
          .returning({ id: schema.bankTransactions.id });
        if (result.length > 0) insertedCount += 1;
        else skippedCount += 1;
      }

      // For now, modified/removed transactions are not auto-applied.
      // They surface in match_candidates re-review when implemented.

      // Persist the new cursor on every bank_account in the item.
      for (const b of itemBanks) {
        await tx
          .update(schema.bankAccounts)
          .set({
            plaidCursor: synced.next_cursor,
            updatedAt: new Date(),
          })
          .where(eq(schema.bankAccounts.id, b.id));
      }
    });

    syncedItems.push({
      item_id: itemId,
      banks: itemBanks.length,
      added: synced.added.length,
      modified: synced.modified.length,
      removed: synced.removed.length,
      inserted_count: insertedCount,
      skipped_count: skippedCount,
      next_cursor_updated: true,
    });
  }

  return res.status(200).json({
    ok: true,
    organization_id: organizationId,
    synced: syncedItems,
  });
});
