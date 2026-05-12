// POST /api/admin/sync-bill-com-card-transactions?secret=<TOKEN>
// body: { bank_account_id?: uuid, since_date?: YYYY-MM-DD }
//
// Pulls Bill.com card-charge transactions and upserts them as
// bank_transactions rows. Same shape as Plaid sync, so the
// reconciliation engine works against them without special-casing.
//
// If bank_account_id is supplied, syncs just that account (must have
// bill_com_card_account_id set). Otherwise syncs every active
// bank_account in the org with a bill_com_card_account_id mapping.
//
// After insert, runs the existing rule engine
// (runRulesAgainstTransaction) so auto-match candidates land
// immediately — same UX as Plaid sync.

import { and, eq, isNotNull } from 'drizzle-orm';
import {
  withAdminHandler,
  getDefaultOrgId,
  parseBody,
} from '../../lib/adminHelpers.js';
import { getDb, schema } from '../../lib/db/index.js';
import { listCardTransactions, isBillComConfigured } from '../../lib/backends/billcom.js';
import { runRulesAgainstTransaction } from '../../lib/accounting/matchEngine.js';

export default withAdminHandler(async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'POST only' });
  }
  if (!isBillComConfigured()) {
    return res.status(503).json({ ok: false, error: 'Bill.com not configured' });
  }
  const body = parseBody(req);

  const db = getDb();
  const organizationId = await getDefaultOrgId();

  // Pick which bank_accounts to sync.
  const where = [
    eq(schema.bankAccounts.organizationId, organizationId),
    eq(schema.bankAccounts.isActive, true),
    isNotNull(schema.bankAccounts.billComCardAccountId),
  ];
  if (body.bank_account_id) {
    where.push(eq(schema.bankAccounts.id, body.bank_account_id));
  }
  const banks = await db
    .select({
      id: schema.bankAccounts.id,
      displayName: schema.bankAccounts.displayName,
      billComCardAccountId: schema.bankAccounts.billComCardAccountId,
    })
    .from(schema.bankAccounts)
    .where(and(...where));

  if (banks.length === 0) {
    return res.status(200).json({
      ok: true,
      organization_id: organizationId,
      synced: [],
      message: 'No Bill.com-mapped card bank_accounts found.',
    });
  }

  const sinceDate = body.since_date || null;
  const summary = [];

  for (const bank of banks) {
    let txns;
    try {
      txns = await listCardTransactions({
        // Bill.com's API filters by account aren't always exposed;
        // pull recent transactions and filter client-side by
        // chargeAccountId if their payload includes one.
        sinceDate: sinceDate || undefined,
        maxResults: 500,
      });
    } catch (err) {
      summary.push({ bank_account_id: bank.id, error: err.message });
      continue;
    }

    // Filter to this card account (Bill.com payloads include
    // chargeAccountId / accountId on each row).
    const forThisCard = txns.filter((t) =>
      !bank.billComCardAccountId ||
      t.chargeAccountId === bank.billComCardAccountId ||
      t.accountId === bank.billComCardAccountId,
    );

    let inserted = 0;
    let skipped = 0;
    let candidatesCreated = 0;

    await db.transaction(async (tx) => {
      for (const t of forThisCard) {
        const billComTxnId = t.id;
        if (!billComTxnId) { skipped += 1; continue; }

        // Idempotent insert via unique index on bill_com_transaction_id.
        const amountCents = Math.round(Number(t.amount) * 100);
        const result = await tx
          .insert(schema.bankTransactions)
          .values({
            organizationId,
            bankAccountId: bank.id,
            externalId: `billcom:${billComTxnId}`,
            postedDate: (t.transactionDate || '').slice(0, 10) || new Date().toISOString().slice(0, 10),
            amountCents,
            description: t.description || t.memo || null,
            merchantName: t.vendorName || t.merchantName || null,
            pending: false,
            rawPayload: t,
            billComTransactionId: billComTxnId,
          })
          .onConflictDoNothing()
          .returning({ id: schema.bankTransactions.id });

        if (result.length > 0) {
          inserted += 1;
          const matched = await runRulesAgainstTransaction(
            tx, organizationId, result[0].id,
          );
          candidatesCreated += matched.candidates_created;
        } else {
          skipped += 1;
        }
      }
    });

    summary.push({
      bank_account_id: bank.id,
      display_name: bank.displayName,
      bill_com_card_account_id: bank.billComCardAccountId,
      transactions_seen: forThisCard.length,
      inserted,
      skipped,
      auto_match_candidates_created: candidatesCreated,
    });
  }

  return res.status(200).json({
    ok: true,
    organization_id: organizationId,
    synced: summary,
  });
});
