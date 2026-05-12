// Default tag assignments for GL accounts.
//
// When the seeder or AppFolio importer creates a new gl_accounts row,
// the service layer also seeds gl_account_tags entries here so every
// future journal_line posting to that account inherits sensible
// classification defaults. Staff can refine on a per-line basis.
//
// Rules apply in declaration order. Each rule may match by:
//
//   accountType        exact match
//   accountSubtype     exact match
//   codePrefix         account.code starts with this string
//   codeRange          [from, to] inclusive numeric range over
//                      account.code (only used when code parses as
//                      a number)
//   namePattern        case-insensitive substring match in name
//
// A rule that matches contributes its `tags` (array of
// { namespace, value, notes? }) to the account's default set. Rules
// are cumulative — multiple rules may match a single account.
//
// The vocabularies referenced here are declared in
// lib/accounting/tagVocabularies.js. The runtime seeder verifies
// every (namespace, value) is known to that file before writing,
// so a typo in this rule set is caught at seed time, not at
// posting time.

export const DEFAULT_GL_ACCOUNT_TAG_RULES = [
  // ── Cash & cash equivalents ─────────────────────────────────────
  {
    label: 'Cash accounts → non-capitalizable, no tax treatment',
    match: { accountSubtype: 'cash' },
    tags: [
      { namespace: 'asset_category', value: 'non_capitalizable' },
    ],
  },

  // ── AR → operating, ordinary tax treatment ──────────────────────
  {
    label: 'AR accounts',
    match: { accountSubtype: 'accounts_receivable' },
    tags: [
      { namespace: 'cost_class', value: 'operating' },
      { namespace: 'asset_category', value: 'non_capitalizable' },
    ],
  },

  // ── Operating expenses (6000–6999 range) ───────────────────────
  {
    label: 'Operating expenses → operating + ordinary tax',
    match: { accountType: 'expense', codeRange: ['6000', '6999'] },
    tags: [
      { namespace: 'cost_class', value: 'operating' },
      { namespace: 'tax_treatment', value: 'ordinary' },
    ],
  },

  // ── Capital expenses (7000–7999 range) ─────────────────────────
  {
    label: 'Capital expenses → capital_expense + MACRS by default',
    match: { accountType: 'expense', codeRange: ['7000', '7999'] },
    tags: [
      { namespace: 'cost_class', value: 'capital_expense' },
      { namespace: 'tax_treatment', value: 'capitalized_macrs' },
    ],
  },

  // ── Overhead (8000–8999) → operating ────────────────────────────
  {
    label: 'Overhead → operating + ordinary',
    match: { accountType: 'expense', codeRange: ['8000', '8999'] },
    tags: [
      { namespace: 'cost_class', value: 'operating' },
      { namespace: 'tax_treatment', value: 'ordinary' },
    ],
  },

  // ── Acquisition / disposition costs ────────────────────────────
  {
    label: 'Acquisition costs',
    match: { accountSubtype: 'acquisition' },
    tags: [
      { namespace: 'cost_class', value: 'capital_expense' },
      { namespace: 'business_context', value: 'acquisition' },
    ],
  },

  // ── Below-the-line / Other Expense (9000+) ─────────────────────
  {
    label: 'Depreciation',
    match: { accountSubtype: 'depreciation' },
    tags: [
      { namespace: 'cost_class', value: 'capital_expense' },
      { namespace: 'tax_treatment', value: 'capitalized_macrs' },
    ],
  },
  {
    label: 'Amortization',
    match: { accountSubtype: 'amortization' },
    tags: [
      { namespace: 'cost_class', value: 'capital_expense' },
      { namespace: 'tax_treatment', value: 'capitalized_macrs' },
      { namespace: 'asset_category', value: 'intangible_section_197' },
    ],
  },

  // ── Functional tags by subtype ──────────────────────────────────
  // Account subtypes already encode "what kind of expense" — copy
  // the value over to the `functional` tag namespace so cross-
  // account reporting can roll up by trade without joining
  // gl_accounts.
  {
    label: 'HVAC functional tag',
    match: { namePattern: 'hvac' },
    tags: [{ namespace: 'functional', value: 'hvac' }],
  },
  {
    label: 'Plumbing functional tag',
    match: { namePattern: 'plumbing' },
    tags: [{ namespace: 'functional', value: 'plumbing' }],
  },
  {
    label: 'Electrical functional tag',
    match: { namePattern: 'electrical' },
    tags: [{ namespace: 'functional', value: 'electrical' }],
  },
  {
    label: 'Roofing functional tag',
    match: { namePattern: 'roof' },
    tags: [{ namespace: 'functional', value: 'roofing' }],
  },
  {
    label: 'Painting functional tag',
    match: { namePattern: 'paint' },
    tags: [{ namespace: 'functional', value: 'paint' }],
  },
  {
    label: 'Flooring functional tag',
    match: { namePattern: 'floor' },
    tags: [{ namespace: 'functional', value: 'flooring' }],
  },
  {
    label: 'Appliance functional tag',
    match: { namePattern: 'appliance' },
    tags: [{ namespace: 'functional', value: 'appliance' }],
  },
  {
    label: 'Landscaping functional tag',
    match: { namePattern: 'landscap' },
    tags: [{ namespace: 'functional', value: 'landscaping' }],
  },
  {
    label: 'Pest control functional tag',
    match: { namePattern: 'pest' },
    tags: [{ namespace: 'functional', value: 'pest_control' }],
  },
  {
    label: 'Snow removal functional tag',
    match: { namePattern: 'snow' },
    tags: [{ namespace: 'functional', value: 'snow_removal' }],
  },
  {
    label: 'Pool functional tag',
    match: { namePattern: 'pool' },
    tags: [{ namespace: 'functional', value: 'pool' }],
  },
  {
    label: 'Janitorial functional tag',
    match: { namePattern: 'janit' },
    tags: [{ namespace: 'functional', value: 'janitorial' }],
  },
  {
    label: 'Security functional tag',
    match: { namePattern: 'security' },
    tags: [{ namespace: 'functional', value: 'security' }],
  },
  {
    label: 'Turnover business context',
    match: { namePattern: 'turnover' },
    tags: [{ namespace: 'business_context', value: 'turnover' }],
  },
];

// ── Rule application ─────────────────────────────────────────────

function matchesRule(account, match) {
  if (match.accountType && account.accountType !== match.accountType) return false;
  if (match.accountSubtype && account.accountSubtype !== match.accountSubtype) return false;
  if (match.codePrefix && !account.code?.startsWith(match.codePrefix)) return false;
  if (match.codeRange) {
    const codeNum = parseInt(account.code, 10);
    if (Number.isNaN(codeNum)) return false;
    const from = parseInt(match.codeRange[0], 10);
    const to = parseInt(match.codeRange[1], 10);
    if (codeNum < from || codeNum > to) return false;
  }
  if (match.namePattern) {
    const haystack = (account.name || '').toLowerCase();
    if (!haystack.includes(match.namePattern.toLowerCase())) return false;
  }
  return true;
}

/**
 * Compute the default tag set for a single GL account by applying
 * every matching rule.
 *
 * @param {object} account - { code, name, accountType, accountSubtype }
 * @returns {Array<{ namespace: string, value: string, notes?: string }>}
 *   De-duplicated list (one row per namespace+value).
 */
export function computeDefaultTagsFor(account) {
  const seen = new Map(); // key = "ns:value"
  for (const rule of DEFAULT_GL_ACCOUNT_TAG_RULES) {
    if (!matchesRule(account, rule.match)) continue;
    for (const tag of rule.tags) {
      const key = `${tag.namespace}:${tag.value}`;
      if (seen.has(key)) continue;
      seen.set(key, {
        ...tag,
        notes: tag.notes || `auto-applied by rule: ${rule.label}`,
      });
    }
  }
  return Array.from(seen.values());
}
