// POST /api/admin/explain-and-rule?secret=<TOKEN>
// body: { bank_transaction_id, one_liner }
//
// The user's natural-language one-liner about a single bank
// transaction. Calls Claude to produce a structured match_rule,
// inserts it into match_rules, then immediately applies the rule
// to the originating transaction (creates a pending_review
// match_candidate). Returns the created rule + candidate.
//
// Requires ANTHROPIC_API_KEY (already in env for the chat backend).
// Requires the user to have already linked at least one bank
// account so there's a transaction to explain.

import { and, eq } from 'drizzle-orm';
import {
  withAdminHandler,
  getDefaultOrgId,
  parseBody,
} from '../../lib/adminHelpers.js';
import { getDb, schema } from '../../lib/db/index.js';
import { generateRuleFromNaturalLanguage } from '../../lib/accounting/ruleGenerator.js';
import { applyRuleToTransaction } from '../../lib/accounting/matchEngine.js';

export default withAdminHandler(async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'POST only' });
  }
  if (!process.env.ANTHROPIC_API_KEY) {
    return res.status(503).json({
      ok: false,
      error: 'ANTHROPIC_API_KEY not set in Vercel env vars.',
    });
  }

  const body = parseBody(req);
  const transactionId = body.bank_transaction_id;
  const oneLiner = body.one_liner;
  if (!transactionId) {
    return res.status(400).json({ ok: false, error: 'bank_transaction_id required' });
  }
  if (!oneLiner || typeof oneLiner !== 'string' || oneLiner.trim().length === 0) {
    return res.status(400).json({ ok: false, error: 'one_liner required' });
  }

  const db = getDb();
  const organizationId = await getDefaultOrgId();

  // Fetch the transaction + the bank account it belongs to.
  const [txn] = await db
    .select({
      id: schema.bankTransactions.id,
      bankAccountId: schema.bankTransactions.bankAccountId,
      externalId: schema.bankTransactions.externalId,
      postedDate: schema.bankTransactions.postedDate,
      amountCents: schema.bankTransactions.amountCents,
      description: schema.bankTransactions.description,
      merchantName: schema.bankTransactions.merchantName,
      bankAccountName: schema.bankAccounts.displayName,
    })
    .from(schema.bankTransactions)
    .leftJoin(
      schema.bankAccounts,
      eq(schema.bankTransactions.bankAccountId, schema.bankAccounts.id),
    )
    .where(
      and(
        eq(schema.bankTransactions.id, transactionId),
        eq(schema.bankTransactions.organizationId, organizationId),
      ),
    )
    .limit(1);
  if (!txn) {
    return res.status(404).json({
      ok: false,
      error: `bank_transaction ${transactionId} not found for org`,
    });
  }

  // Fetch the chart of accounts (sorted by posting count desc so
  // most-used accounts surface first in the prompt context).
  const glAccounts = await db
    .select({
      id: schema.glAccounts.id,
      code: schema.glAccounts.code,
      name: schema.glAccounts.name,
      accountType: schema.glAccounts.accountType,
    })
    .from(schema.glAccounts)
    .where(
      and(
        eq(schema.glAccounts.organizationId, organizationId),
        eq(schema.glAccounts.isActive, true),
      ),
    );

  // Fetch existing rules (so the LLM doesn't duplicate).
  const existingRules = await db
    .select({
      name: schema.matchRules.name,
      naturalLanguageDescription: schema.matchRules.naturalLanguageDescription,
    })
    .from(schema.matchRules)
    .where(
      and(
        eq(schema.matchRules.organizationId, organizationId),
        eq(schema.matchRules.isActive, true),
      ),
    );

  // Call Claude.
  let llmRule;
  try {
    llmRule = await generateRuleFromNaturalLanguage({
      transaction: {
        amount_cents: txn.amountCents,
        posted_date: txn.postedDate,
        merchant_name: txn.merchantName,
        description: txn.description,
        bank_account_display_name: txn.bankAccountName,
      },
      userOneLiner: oneLiner,
      glAccounts: glAccounts.map((a) => ({
        code: a.code,
        name: a.name,
        account_type: a.accountType,
      })),
      existingRules: existingRules.map((r) => ({
        name: r.name,
        natural_language_description: r.naturalLanguageDescription,
      })),
    });
  } catch (err) {
    return res.status(502).json({
      ok: false,
      error: `LLM rule generation failed: ${err.message}`,
    });
  }

  // Insert the rule + apply it to the originating transaction.
  const result = await db.transaction(async (tx) => {
    const [rule] = await tx
      .insert(schema.matchRules)
      .values({
        organizationId,
        name: llmRule.name,
        patternType: llmRule.pattern_type,
        patternPayload: llmRule.pattern_payload,
        target: llmRule.target,
        confidenceScore: llmRule.initial_confidence,
        isActive: true,
        naturalLanguageDescription: oneLiner.trim(),
        notes: llmRule.explanation,
      })
      .returning({ id: schema.matchRules.id });

    const applied = await applyRuleToTransaction(
      tx,
      organizationId,
      rule.id,
      transactionId,
    );

    return { ruleId: rule.id, applied };
  });

  return res.status(200).json({
    ok: true,
    organization_id: organizationId,
    rule: {
      id: result.ruleId,
      name: llmRule.name,
      pattern_payload: llmRule.pattern_payload,
      target: llmRule.target,
      initial_confidence: llmRule.initial_confidence,
      explanation: llmRule.explanation,
    },
    candidate: result.applied,
  });
});
