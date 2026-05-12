// LLM-powered rule generator.
//
// Takes a bank_transaction + the user's natural-language one-liner
// describing what it is and how to handle similar future ones, and
// returns a structured match_rule (pattern_payload + target +
// confidence) ready to insert into match_rules.
//
// Uses the Anthropic SDK (already a dep). Reads ANTHROPIC_API_KEY
// from env. Model defaults to the latest Sonnet.
//
// The Claude prompt includes the org's chart of accounts so the
// LLM can pick a real GL code, and a list of existing rules so it
// doesn't duplicate. Output is forced into a strict JSON shape via
// system prompt + JSON-mode-style instruction.

import Anthropic from '@anthropic-ai/sdk';

const MODEL = process.env.RECON_LLM_MODEL || 'claude-sonnet-4-6';

let cachedClient = null;
function getClient() {
  if (cachedClient) return cachedClient;
  cachedClient = new Anthropic();
  return cachedClient;
}

const SYSTEM_PROMPT = `You are a property-management accounting AI. The user is
manually reconciling a bank transaction. Given the transaction and a
short natural-language explanation, produce a structured rule that
will auto-categorize SIMILAR future transactions.

Return ONLY a single JSON object, no other text. Schema:

{
  "name": "<short human label, max 60 chars>",
  "pattern_payload": {
    "merchant_keywords": ["<lowercase substring matches>"] | null,
    "tenant_name_keywords": ["<lowercase tenant name substrings, e.g. 'smith', 'doe'>"] | null,
    "exclude_keywords": ["<keywords that disqualify>"] | null,
    "amount_range_cents": [<min>, <max>] | null,
    "bank_account_ids": ["<uuid>"] | null
  },
  "target": {
    "gl_account_code": "<exact code from the provided chart>",
    "memo_template": "<plain text, may use {merchant} {amount} {date} placeholders>",
    "attribute_to": {
      "property_id": "<uuid or null>",
      "unit_id": "<uuid or null>",
      "tenant_id": "<uuid or null>",
      "vendor_id": "<uuid or null>"
    }
  },
  "initial_confidence": <0.50 - 0.95>,
  "explanation": "<1-2 sentences for the audit trail>"
}

Guidelines:
- Prefer broader merchant_keywords (e.g. "walmart" not "WAL-MART
  SUPERCENTER #1234") so the rule generalizes.
- Use tenant_name_keywords when the user's hint references a person
  (e.g. "rent from John Smith", "ACH from the Doe family"). Extract
  the surname (lowercased) so future ACH descriptions like "Smith J
  ACH PAYMENT" match. tenant_name_keywords and merchant_keywords can
  coexist on the same rule — at least one keyword across the union
  must match the transaction text.
- Set initial_confidence based on how unambiguous the user's hint
  is. "All Walmart for SLM" is high (~0.85). "Maybe a repair
  expense" is low (~0.55).
- Only set attribute_to.* when the user's hint pins it explicitly.
  Otherwise leave null and let the staff fill in per-line.
- amount_range_cents should be wide enough to catch normal variation
  (e.g. ±50% around the example transaction) unless the user
  specifies tighter bounds.
- gl_account_code MUST exactly match a code in the provided chart.
  If you can't find a good match, return code "9900" (Forced
  Reconciliation / Suspense) and lower the confidence.`;

/**
 * Generate a match rule from a natural-language one-liner.
 *
 * @param {object} params
 * @param {object} params.transaction      bank_transaction row
 * @param {string} params.userOneLiner     the user's natural-language input
 * @param {Array} params.glAccounts        [{ code, name, account_type }]
 * @param {Array} [params.existingRules]   [{ name, natural_language_description }]
 * @returns {Promise<object>} the parsed JSON rule, ready to merge into
 *                            a match_rules INSERT.
 */
export async function generateRuleFromNaturalLanguage(params) {
  const {
    transaction,
    userOneLiner,
    glAccounts = [],
    existingRules = [],
  } = params;

  if (!userOneLiner || userOneLiner.trim().length === 0) {
    throw new Error('generateRuleFromNaturalLanguage: userOneLiner required');
  }
  if (!transaction) {
    throw new Error('generateRuleFromNaturalLanguage: transaction required');
  }
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error(
      'ANTHROPIC_API_KEY not set. Add it to Vercel env vars to enable LLM-assisted reconciliation.',
    );
  }

  // Cents → dollars for human-readable display in the prompt.
  const amountDollars = (Number(transaction.amount_cents || transaction.amountCents) / 100).toFixed(2);
  const merchantName = transaction.merchant_name || transaction.merchantName || '(unknown)';
  const description = transaction.description || '(none)';
  const postedDate = transaction.posted_date || transaction.postedDate;
  const bankAccountName =
    transaction.bank_account_display_name ||
    transaction.bankAccountDisplayName ||
    '(unknown)';

  // Truncate the GL account list to the most relevant subset to fit
  // in context. Prefer accounts that have postings (i.e. are
  // actually used). Caller is responsible for passing a sensibly-
  // sorted list.
  const coaSlice = glAccounts.slice(0, 80);
  const coaText = coaSlice
    .map((a) => `${a.code}\t${a.name}\t(${a.account_type})`)
    .join('\n');

  const existingText =
    existingRules.length === 0
      ? '(none)'
      : existingRules
          .map((r) => `- ${r.name || '(unnamed)'}: ${r.natural_language_description || '(no description)'}`)
          .join('\n');

  const userMessage = `BANK TRANSACTION
  Amount:        $${amountDollars}
  Posted date:   ${postedDate}
  Merchant:      ${merchantName}
  Description:   ${description}
  Bank account:  ${bankAccountName}

USER EXPLANATION
  "${userOneLiner.trim()}"

CHART OF ACCOUNTS (code, name, type — first 80)
${coaText}

EXISTING RULES IN THIS ORG (don't duplicate)
${existingText}

Generate the rule.`;

  const client = getClient();
  const response = await client.messages.create({
    model: MODEL,
    max_tokens: 1500,
    system: SYSTEM_PROMPT,
    messages: [{ role: 'user', content: userMessage }],
  });

  const text = response.content
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('')
    .trim();

  // Strip any accidental markdown fences just in case.
  const cleaned = text
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/i, '')
    .replace(/\s*```\s*$/i, '')
    .trim();

  let parsed;
  try {
    parsed = JSON.parse(cleaned);
  } catch (err) {
    throw new Error(
      `LLM returned non-JSON output: ${err.message}. Raw: ${text.slice(0, 500)}`,
    );
  }

  // Light validation.
  if (!parsed.pattern_payload || typeof parsed.pattern_payload !== 'object') {
    throw new Error('LLM output missing pattern_payload');
  }
  if (!parsed.target || typeof parsed.target !== 'object') {
    throw new Error('LLM output missing target');
  }
  if (!parsed.target.gl_account_code) {
    throw new Error('LLM output missing target.gl_account_code');
  }
  const conf = Number(parsed.initial_confidence);
  if (!Number.isFinite(conf) || conf < 0 || conf > 1) {
    throw new Error(`LLM returned invalid initial_confidence: ${parsed.initial_confidence}`);
  }

  return {
    name: String(parsed.name || 'Untitled rule').slice(0, 60),
    pattern_type: 'composite',
    pattern_payload: parsed.pattern_payload,
    target: parsed.target,
    initial_confidence: conf,
    explanation: parsed.explanation || '',
    raw_llm_response: text,
  };
}
