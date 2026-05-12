// GET /api/admin/list-pending-reconciliation?secret=<TOKEN>
//
// Returns bank_transactions that have no `confirmed` match_candidate
// yet — the reconciliation work queue. Includes any pending/auto-
// matched candidates so the UI can show "the engine thinks this is
// X" before the user confirms.

import { and, eq, sql } from 'drizzle-orm';
import {
  withAdminHandler,
  getDefaultOrgId,
} from '../../lib/adminHelpers.js';
import { getDb, schema } from '../../lib/db/index.js';

export default withAdminHandler(async (req, res) => {
  if (req.method !== 'GET') {
    return res.status(405).json({ ok: false, error: 'GET only' });
  }
  const db = getDb();
  const organizationId = await getDefaultOrgId();
  const limit = Math.min(
    Math.max(parseInt(req.query?.limit, 10) || 100, 1),
    500,
  );

  // Bank transactions for the org that don't have a `confirmed`
  // match_candidate. Subquery: ids of bank_transactions that DO
  // have a confirmed candidate, then NOT IN.
  const confirmedIds = db
    .select({ btxId: schema.matchCandidates.bankTransactionId })
    .from(schema.matchCandidates)
    .where(
      and(
        eq(schema.matchCandidates.organizationId, organizationId),
        eq(schema.matchCandidates.status, 'confirmed'),
      ),
    );

  const transactions = await db
    .select({
      id: schema.bankTransactions.id,
      bankAccountId: schema.bankTransactions.bankAccountId,
      externalId: schema.bankTransactions.externalId,
      postedDate: schema.bankTransactions.postedDate,
      amountCents: schema.bankTransactions.amountCents,
      description: schema.bankTransactions.description,
      merchantName: schema.bankTransactions.merchantName,
      pending: schema.bankTransactions.pending,
      bankAccountName: schema.bankAccounts.displayName,
      bankAccountType: schema.bankAccounts.accountType,
    })
    .from(schema.bankTransactions)
    .leftJoin(
      schema.bankAccounts,
      eq(schema.bankTransactions.bankAccountId, schema.bankAccounts.id),
    )
    .where(
      and(
        eq(schema.bankTransactions.organizationId, organizationId),
        sql`${schema.bankTransactions.id} NOT IN ${confirmedIds}`,
      ),
    )
    .orderBy(sql`${schema.bankTransactions.postedDate} DESC`)
    .limit(limit);

  // Pull any non-confirmed candidates for these transactions.
  let candidatesByTxn = new Map();
  if (transactions.length > 0) {
    const txnIds = transactions.map((t) => t.id);
    const candidates = await db
      .select({
        id: schema.matchCandidates.id,
        bankTransactionId: schema.matchCandidates.bankTransactionId,
        confidenceScore: schema.matchCandidates.confidenceScore,
        matchReasonCodes: schema.matchCandidates.matchReasonCodes,
        status: schema.matchCandidates.status,
        createdAt: schema.matchCandidates.createdAt,
      })
      .from(schema.matchCandidates)
      .where(
        and(
          eq(schema.matchCandidates.organizationId, organizationId),
          sql`${schema.matchCandidates.bankTransactionId} IN ${txnIds}`,
        ),
      )
      .orderBy(sql`${schema.matchCandidates.confidenceScore} DESC NULLS LAST`);
    for (const c of candidates) {
      if (!candidatesByTxn.has(c.bankTransactionId)) {
        candidatesByTxn.set(c.bankTransactionId, []);
      }
      candidatesByTxn.get(c.bankTransactionId).push({
        id: c.id,
        bank_transaction_id: c.bankTransactionId,
        confidence_score: c.confidenceScore,
        match_reason_codes: c.matchReasonCodes,
        status: c.status,
        created_at: c.createdAt,
      });
    }
  }

  return res.status(200).json({
    ok: true,
    organization_id: organizationId,
    count: transactions.length,
    limit,
    transactions: transactions.map((t) => ({
      id: t.id,
      bank_account_id: t.bankAccountId,
      bank_account_name: t.bankAccountName,
      bank_account_type: t.bankAccountType,
      external_id: t.externalId,
      posted_date: t.postedDate,
      amount_cents: t.amountCents,
      description: t.description,
      merchant_name: t.merchantName,
      pending: t.pending,
      candidates: candidatesByTxn.get(t.id) || [],
    })),
  });
});
