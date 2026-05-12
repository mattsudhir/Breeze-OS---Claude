// Match engine — evaluates active match_rules against bank_transactions
// and produces match_candidates.
//
// Pure-function evaluator + transactional helpers:
//
//   evaluateRule(rule, transaction)
//     Returns { confidence, reasonCodes } if the rule matches the
//     transaction, or null if it doesn't. Pure / synchronous.
//
//   runRulesAgainstTransaction(tx, organizationId, transactionId)
//     Loads all active rules for the org, evaluates each, inserts
//     match_candidates rows for every match. Returns counts.
//
//   applyRuleToTransaction(tx, organizationId, ruleId, transactionId,
//                          { autoConfirm = false })
//     Apply ONE specific rule to ONE transaction. Used after the
//     LLM rule generator returns a fresh rule — we apply it to the
//     originating transaction immediately so the user sees the
//     effect without waiting for the next sync.
//
//   confirmMatchCandidate(tx, organizationId, candidateId, userId)
//     Mark a candidate confirmed, increment the rule's times_used,
//     update last_matched_at, and (TODO Stage 4) generate the
//     actual journal_entry that posts the bank transaction
//     against the target GL account.
//
//   rejectMatchCandidate(tx, organizationId, candidateId, userId)
//     Mark candidate rejected, increment the rule's times_rejected.
//     Auto-disable the rule if rejected 3+ times.

import { and, eq, sql } from 'drizzle-orm';
import {
  bankTransactions,
  matchCandidates,
  matchRules,
} from '../db/schema/accounting.js';

const AUTO_DISABLE_REJECTION_THRESHOLD = 3;

// ── evaluateRule ────────────────────────────────────────────────

/**
 * Pure evaluator. Returns { confidence, reasonCodes } if matched,
 * null otherwise.
 *
 * Pattern shape (composite):
 *   {
 *     merchant_keywords:    string[]   // any one match qualifies
 *     exclude_keywords:     string[]   // any one match disqualifies
 *     amount_range_cents:   [min, max] // inclusive, on |amount_cents|
 *     bank_account_ids:     uuid[]     // restrict to these bank_accounts
 *   }
 */
export function evaluateRule(rule, transaction) {
  const pattern = rule.patternPayload || {};
  const text = (
    (transaction.description || '') + ' ' + (transaction.merchantName || '')
  ).toLowerCase();
  const reasonCodes = [`rule_id:${rule.id}`];

  // Merchant keywords — any one substring match qualifies.
  if (Array.isArray(pattern.merchant_keywords) && pattern.merchant_keywords.length > 0) {
    const matched = pattern.merchant_keywords.find((kw) =>
      text.includes(String(kw).toLowerCase()),
    );
    if (!matched) return null;
    reasonCodes.push(`merchant:${matched}`);
  }

  // Exclude keywords — any one disqualifies.
  if (Array.isArray(pattern.exclude_keywords) && pattern.exclude_keywords.length > 0) {
    const excluded = pattern.exclude_keywords.find((kw) =>
      text.includes(String(kw).toLowerCase()),
    );
    if (excluded) return null;
  }

  // Amount range (on absolute value, since Plaid signs vary).
  if (Array.isArray(pattern.amount_range_cents) && pattern.amount_range_cents.length === 2) {
    const [min, max] = pattern.amount_range_cents;
    const amt = Math.abs(Number(transaction.amountCents));
    if (amt < Number(min) || amt > Number(max)) return null;
    reasonCodes.push(`amount_in_range:${min}-${max}`);
  }

  // Bank account scope.
  if (Array.isArray(pattern.bank_account_ids) && pattern.bank_account_ids.length > 0) {
    if (!pattern.bank_account_ids.includes(transaction.bankAccountId)) return null;
    reasonCodes.push('bank_account_in_scope');
  }

  return {
    confidence: Number(rule.confidenceScore),
    reasonCodes,
  };
}

// ── runRulesAgainstTransaction ──────────────────────────────────

/**
 * Evaluate every active rule against a single transaction. Insert
 * match_candidates for every match. Used by the auto-match worker
 * (e.g. after Plaid sync inserts a new bank_transaction).
 */
export async function runRulesAgainstTransaction(tx, organizationId, transactionId) {
  const [transaction] = await tx
    .select()
    .from(bankTransactions)
    .where(
      and(
        eq(bankTransactions.id, transactionId),
        eq(bankTransactions.organizationId, organizationId),
      ),
    )
    .limit(1);
  if (!transaction) {
    throw new Error(`bank_transaction not found: ${transactionId}`);
  }

  const rules = await tx
    .select()
    .from(matchRules)
    .where(
      and(
        eq(matchRules.organizationId, organizationId),
        eq(matchRules.isActive, true),
      ),
    );

  const candidates = [];
  for (const rule of rules) {
    const result = evaluateRule(rule, transaction);
    if (!result) continue;
    candidates.push({
      organizationId,
      bankTransactionId: transactionId,
      // journal_entry_id null — the candidate doesn't have a target
      // JE yet; that's created on confirm.
      journalEntryId: null,
      confidenceScore: result.confidence,
      matchReasonCodes: result.reasonCodes,
      // Auto-confirm threshold: confidence >= 0.95 AND rule has
      // earned trust (times_used > 5). Otherwise pending review.
      status:
        result.confidence >= 0.95 && rule.timesUsed > 5
          ? 'auto_matched'
          : 'pending_review',
    });
  }

  if (candidates.length > 0) {
    await tx.insert(matchCandidates).values(candidates);
  }

  return {
    rules_evaluated: rules.length,
    candidates_created: candidates.length,
  };
}

// ── applyRuleToTransaction ──────────────────────────────────────

/**
 * Force-apply ONE rule to ONE transaction. Bypasses the active-rule
 * filter — used when the LLM generator just produced a fresh rule
 * and we want to apply it to the originating transaction
 * immediately. Always creates the candidate as `pending_review` so
 * the user can sanity-check the LLM's first inference before the
 * rule earns auto-trust.
 */
export async function applyRuleToTransaction(
  tx,
  organizationId,
  ruleId,
  transactionId,
) {
  const [rule] = await tx
    .select()
    .from(matchRules)
    .where(
      and(
        eq(matchRules.id, ruleId),
        eq(matchRules.organizationId, organizationId),
      ),
    )
    .limit(1);
  if (!rule) throw new Error(`match_rule not found: ${ruleId}`);

  const [transaction] = await tx
    .select()
    .from(bankTransactions)
    .where(
      and(
        eq(bankTransactions.id, transactionId),
        eq(bankTransactions.organizationId, organizationId),
      ),
    )
    .limit(1);
  if (!transaction) throw new Error(`bank_transaction not found: ${transactionId}`);

  const result = evaluateRule(rule, transaction);
  if (!result) {
    return {
      matched: false,
      reason: "rule pattern doesn't match this transaction",
    };
  }

  const [candidate] = await tx
    .insert(matchCandidates)
    .values({
      organizationId,
      bankTransactionId: transactionId,
      journalEntryId: null,
      confidenceScore: result.confidence,
      matchReasonCodes: result.reasonCodes,
      status: 'pending_review',
    })
    .returning({
      id: matchCandidates.id,
      confidenceScore: matchCandidates.confidenceScore,
    });

  return {
    matched: true,
    candidate_id: candidate.id,
    confidence: candidate.confidenceScore,
  };
}

// ── confirm / reject ────────────────────────────────────────────

export async function confirmMatchCandidate(
  tx,
  organizationId,
  candidateId,
  userId = null,
) {
  const [candidate] = await tx
    .select()
    .from(matchCandidates)
    .where(
      and(
        eq(matchCandidates.id, candidateId),
        eq(matchCandidates.organizationId, organizationId),
      ),
    )
    .limit(1);
  if (!candidate) throw new Error(`match_candidate not found: ${candidateId}`);
  if (candidate.status === 'confirmed') {
    return { already_confirmed: true, candidate_id: candidateId };
  }

  await tx
    .update(matchCandidates)
    .set({
      status: 'confirmed',
      confirmedByUserId: userId,
      confirmedAt: new Date(),
    })
    .where(eq(matchCandidates.id, candidateId));

  // Bump the rule's stats. Rule id lives in matchReasonCodes as
  // "rule_id:<uuid>" — extract.
  const ruleIdCode = (candidate.matchReasonCodes || []).find((c) =>
    c.startsWith('rule_id:'),
  );
  if (ruleIdCode) {
    const ruleId = ruleIdCode.slice('rule_id:'.length);
    await tx
      .update(matchRules)
      .set({
        timesUsed: sql`${matchRules.timesUsed} + 1`,
        lastMatchedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(matchRules.id, ruleId));
  }

  // TODO Stage 4: generate the journal_entry that posts the bank
  // transaction against the rule's target GL account, link via
  // candidate.journalEntryId. For now the candidate is just
  // confirmed — the JE creation is the next milestone.

  return { confirmed: true, candidate_id: candidateId };
}

export async function rejectMatchCandidate(
  tx,
  organizationId,
  candidateId,
  userId = null,
) {
  const [candidate] = await tx
    .select()
    .from(matchCandidates)
    .where(
      and(
        eq(matchCandidates.id, candidateId),
        eq(matchCandidates.organizationId, organizationId),
      ),
    )
    .limit(1);
  if (!candidate) throw new Error(`match_candidate not found: ${candidateId}`);

  await tx
    .update(matchCandidates)
    .set({
      status: 'rejected',
      confirmedByUserId: userId,
      confirmedAt: new Date(),
    })
    .where(eq(matchCandidates.id, candidateId));

  // Bump the rule's rejection counter; auto-disable past threshold.
  const ruleIdCode = (candidate.matchReasonCodes || []).find((c) =>
    c.startsWith('rule_id:'),
  );
  if (ruleIdCode) {
    const ruleId = ruleIdCode.slice('rule_id:'.length);
    const [updated] = await tx
      .update(matchRules)
      .set({
        timesRejected: sql`${matchRules.timesRejected} + 1`,
        updatedAt: new Date(),
      })
      .where(eq(matchRules.id, ruleId))
      .returning({
        timesRejected: matchRules.timesRejected,
        timesUsed: matchRules.timesUsed,
      });

    if (
      updated.timesRejected >= AUTO_DISABLE_REJECTION_THRESHOLD &&
      updated.timesRejected > updated.timesUsed
    ) {
      await tx
        .update(matchRules)
        .set({ isActive: false, updatedAt: new Date() })
        .where(eq(matchRules.id, ruleId));
    }
  }

  return { rejected: true, candidate_id: candidateId };
}
