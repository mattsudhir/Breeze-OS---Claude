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
  bankAccounts,
  bankTransactions,
  matchCandidates,
  matchRules,
} from '../db/schema/accounting.js';
import { organizations } from '../db/schema/core.js';
import { lookupGlAccountByCode, postJournalEntry } from './posting.js';

const AUTO_DISABLE_REJECTION_THRESHOLD = 3;

// ── evaluateRule ────────────────────────────────────────────────

/**
 * Pure evaluator. Returns { confidence, reasonCodes } if matched,
 * null otherwise.
 *
 * Pattern shape (composite):
 *   {
 *     merchant_keywords:     string[]  // any one match qualifies
 *     tenant_name_keywords:  string[]  // any one match qualifies (e.g. "smith", "doe")
 *     exclude_keywords:      string[]  // any one match disqualifies
 *     amount_range_cents:    [min, max] // inclusive, on |amount_cents|
 *     bank_account_ids:      uuid[]    // restrict to these bank_accounts
 *   }
 *
 * merchant_keywords and tenant_name_keywords are both substring
 * searches over `description + merchant_name` lowercased. They're
 * separate fields so a rule for "rent from anyone named Smith"
 * doesn't need to look like a vendor-name match. Either field
 * matching counts (OR between the two when both are present).
 */
export function evaluateRule(rule, transaction) {
  const pattern = rule.patternPayload || {};
  const text = (
    (transaction.description || '') + ' ' + (transaction.merchantName || '')
  ).toLowerCase();
  const reasonCodes = [`rule_id:${rule.id}`];

  // Merchant + tenant-name keywords. Either field can qualify the
  // line; rules can use one, the other, or both. When both are
  // present at least one keyword across the union must match.
  const hasMerchant = Array.isArray(pattern.merchant_keywords) && pattern.merchant_keywords.length > 0;
  const hasTenant = Array.isArray(pattern.tenant_name_keywords) && pattern.tenant_name_keywords.length > 0;
  if (hasMerchant || hasTenant) {
    let matchedMerchant = null;
    let matchedTenant = null;
    if (hasMerchant) {
      matchedMerchant = pattern.merchant_keywords.find((kw) =>
        text.includes(String(kw).toLowerCase()),
      ) || null;
    }
    if (hasTenant) {
      matchedTenant = pattern.tenant_name_keywords.find((kw) =>
        text.includes(String(kw).toLowerCase()),
      ) || null;
    }
    if (!matchedMerchant && !matchedTenant) return null;
    if (matchedMerchant) reasonCodes.push(`merchant:${matchedMerchant}`);
    if (matchedTenant) reasonCodes.push(`tenant_name:${matchedTenant}`);
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

  // Per-org auto-match thresholds (migration 0018). Defaults preserve
  // historic behavior (0.95 / 5) for orgs that haven't tuned them.
  const [org] = await tx
    .select({
      autoMatchConfidence: organizations.reconAutoMatchConfidence,
      autoMatchMinTimesUsed: organizations.reconAutoMatchMinTimesUsed,
    })
    .from(organizations)
    .where(eq(organizations.id, organizationId))
    .limit(1);
  const autoMatchConfidence = Number(org?.autoMatchConfidence ?? 0.95);
  const autoMatchMinTimesUsed = Number(org?.autoMatchMinTimesUsed ?? 5);

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
      // Auto-match gate is per-org configurable (organizations.
      // recon_auto_match_confidence / recon_auto_match_min_times_used).
      status:
        result.confidence >= autoMatchConfidence &&
        rule.timesUsed >= autoMatchMinTimesUsed
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
    return {
      already_confirmed: true,
      candidate_id: candidateId,
      journal_entry_id: candidate.journalEntryId,
    };
  }

  // Rule id lives in matchReasonCodes as "rule_id:<uuid>". Required
  // for both the JE target and the stats bump.
  const ruleIdCode = (candidate.matchReasonCodes || []).find((c) =>
    c.startsWith('rule_id:'),
  );
  if (!ruleIdCode) {
    throw new Error(
      `candidate ${candidateId} has no rule_id reason code; cannot post`,
    );
  }
  const ruleId = ruleIdCode.slice('rule_id:'.length);

  // Load the bank transaction + its bank_account's GL account (the
  // cash side of the posting).
  const [txn] = await tx
    .select({
      id: bankTransactions.id,
      postedDate: bankTransactions.postedDate,
      amountCents: bankTransactions.amountCents,
      merchantName: bankTransactions.merchantName,
      description: bankTransactions.description,
      bankGlAccountId: bankAccounts.glAccountId,
    })
    .from(bankTransactions)
    .leftJoin(
      bankAccounts,
      eq(bankTransactions.bankAccountId, bankAccounts.id),
    )
    .where(
      and(
        eq(bankTransactions.id, candidate.bankTransactionId),
        eq(bankTransactions.organizationId, organizationId),
      ),
    )
    .limit(1);
  if (!txn) {
    throw new Error(`bank_transaction not found: ${candidate.bankTransactionId}`);
  }
  if (!txn.bankGlAccountId) {
    throw new Error(
      `bank_account for transaction ${txn.id} has no gl_account_id; cannot post`,
    );
  }

  // Load the rule to get target GL + attribution + memo template.
  const [rule] = await tx
    .select()
    .from(matchRules)
    .where(eq(matchRules.id, ruleId))
    .limit(1);
  if (!rule) throw new Error(`match_rule not found: ${ruleId}`);

  const target = rule.target || {};
  if (!target.gl_account_code) {
    throw new Error(`rule ${ruleId} has no target.gl_account_code`);
  }
  const targetGlAccountId = await lookupGlAccountByCode(
    tx,
    organizationId,
    target.gl_account_code,
  );

  // Memo: substitute template placeholders. Default template if the
  // rule didn't specify one keeps the entry searchable.
  const merchant = txn.merchantName || txn.description || '(no merchant)';
  const amountStr = (Math.abs(Number(txn.amountCents)) / 100).toFixed(2);
  const dateStr = txn.postedDate;
  const template = target.memo_template || '{merchant} — {date}';
  const memo = template
    .replace(/\{merchant\}/g, merchant)
    .replace(/\{amount\}/g, amountStr)
    .replace(/\{date\}/g, dateStr);

  // Direction: Plaid uses positive = money OUT (outflow / debit on
  // the bank side from Plaid's POV). For us:
  //   outflow → debit the rule's target (expense), credit cash.
  //   inflow  → debit cash, credit the rule's target (revenue / contra).
  const amountAbs = Math.abs(Number(txn.amountCents));
  const isOutflow = Number(txn.amountCents) > 0;
  const attr = target.attribute_to || {};
  const targetAttr = {
    propertyId: attr.property_id || null,
    unitId: attr.unit_id || null,
    tenantId: attr.tenant_id || null,
    vendorId: attr.vendor_id || null,
  };

  const lines = isOutflow
    ? [
        {
          glAccountId: targetGlAccountId,
          debitCents: amountAbs,
          creditCents: 0,
          memo,
          ...targetAttr,
        },
        {
          glAccountId: txn.bankGlAccountId,
          debitCents: 0,
          creditCents: amountAbs,
          memo,
        },
      ]
    : [
        {
          glAccountId: txn.bankGlAccountId,
          debitCents: amountAbs,
          creditCents: 0,
          memo,
        },
        {
          glAccountId: targetGlAccountId,
          debitCents: 0,
          creditCents: amountAbs,
          memo,
          ...targetAttr,
        },
      ];

  const { journalEntryId } = await postJournalEntry(tx, organizationId, {
    entryDate: txn.postedDate,
    entryType: isOutflow ? 'disbursement' : 'receipt',
    memo,
    sourceTable: 'bank_transactions',
    sourceId: txn.id,
    postedByUserId: userId,
    lines,
  });

  // Flip candidate to confirmed + link the journal entry.
  await tx
    .update(matchCandidates)
    .set({
      status: 'confirmed',
      confirmedByUserId: userId,
      confirmedAt: new Date(),
      journalEntryId,
    })
    .where(eq(matchCandidates.id, candidateId));

  // Bump the rule's stats.
  await tx
    .update(matchRules)
    .set({
      timesUsed: sql`${matchRules.timesUsed} + 1`,
      lastMatchedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(matchRules.id, ruleId));

  return {
    confirmed: true,
    candidate_id: candidateId,
    journal_entry_id: journalEntryId,
  };
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
