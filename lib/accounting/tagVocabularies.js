// Controlled vocabularies for multi-dimensional tagging of GL
// accounts and journal lines.
//
// See docs/accounting/multi-dimensional-tagging.md for the design
// rationale. The tag tables (gl_account_tags, journal_line_tags)
// land in Stage 2 alongside the AR schema; this file is the
// declarative reference the service layer reads to validate tags
// at post time and the UI reads to render dropdowns.
//
// Adding a value to a vocabulary is a code change, not a migration —
// the schema stores tags as free-text namespace/value pairs. That's
// deliberate: vocabularies evolve faster than DB enums should.
// Adding a NEW namespace is also a code change here; it requires
// no schema work but should be socialised (it shows up in reporting
// queries and in the UI tag picker).
//
// Each vocabulary is keyed by its namespace name and contains:
//
//   description  short human-readable purpose
//   values       array of { value, label, description }
//   validation   optional array of validation rules — predicate
//                functions that read the full effective tag set
//                and return either null (ok) or a string (error /
//                warning message).

// ── Vocabularies ─────────────────────────────────────────────────

export const TAG_VOCABULARIES = {
  cost_class: {
    description:
      'Operating vs. one-time vs. capital classification. Drives ' +
      'the "is this on the income statement or the balance sheet" ' +
      'question independently of which GL account the dollar hits.',
    values: [
      { value: 'operating', label: 'Operating',
        description: 'Recurring operating expense; expensed in the period.' },
      { value: 'one_time', label: 'One-Time',
        description: 'Non-recurring but not capitalized — e.g. a single ' +
                     'consulting engagement or a one-off marketing push.' },
      { value: 'capital_expense', label: 'Capital Expense',
        description: 'Should be capitalized to the balance sheet and ' +
                     'depreciated over time.' },
      { value: 'judgment_call', label: 'Judgment Call',
        description: 'Repair-vs-replacement edge case; flagged for ' +
                     'review by CPA or owner before year-end.' },
    ],
  },

  tax_treatment: {
    description:
      'Federal income tax treatment. Drives the year-end depreciation ' +
      'schedule and tax-return classification.',
    values: [
      { value: 'ordinary', label: 'Ordinary Deduction',
        description: 'Fully deductible in the current tax year.' },
      { value: 'section_179', label: 'Section 179',
        description: 'Qualifies for Section 179 expense election ' +
                     '(IRC §179). Annual dollar limits apply.' },
      { value: 'bonus_depreciation_candidate', label: 'Bonus Depreciation',
        description: 'Qualifies for bonus depreciation under IRC §168(k). ' +
                     'Bonus % varies by tax year (phasing down 2023–2027).' },
      { value: 'capitalized_macrs', label: 'Capitalized (MACRS)',
        description: 'Standard MACRS depreciation; no acceleration applied.' },
      { value: 'passive_loss_limited', label: 'Passive Loss Limited',
        description: 'Subject to passive-activity loss rules (IRC §469). ' +
                     'Most rental real estate losses fall here unless ' +
                     'real-estate-professional status is claimed.' },
      { value: 'de_minimis_safe_harbor', label: 'De Minimis Safe Harbor',
        description: 'Falls under the de minimis safe-harbor election ' +
                     '(typically items under $2,500 per invoice/item ' +
                     'with applicable financial statements).' },
    ],
  },

  asset_category: {
    description:
      'Depreciation recovery class for capitalized items. Only ' +
      'meaningful when cost_class=capital_expense or when ' +
      'tax_treatment indicates capitalization.',
    values: [
      { value: 'building_residential', label: 'Residential Building',
        description: '27.5-year MACRS straight-line. Residential rental ' +
                     'structures (Section 168(c)).' },
      { value: 'building_commercial', label: 'Commercial Building',
        description: '39-year MACRS straight-line. Non-residential real ' +
                     'property.' },
      { value: 'land_improvement', label: 'Land Improvement',
        description: '15-year MACRS 150% DB. Sidewalks, fences, ' +
                     'landscaping, parking lots, exterior lighting.' },
      { value: 'personal_property_5yr', label: 'Personal Property (5-yr)',
        description: '5-year MACRS 200% DB. Appliances, computers, ' +
                     'autos, light trucks.' },
      { value: 'personal_property_7yr', label: 'Personal Property (7-yr)',
        description: '7-year MACRS 200% DB. Office furniture, ' +
                     'machinery, equipment without a specific class.' },
      { value: 'intangible_section_197', label: 'Intangible (§197)',
        description: '15-year straight-line amortization. Goodwill, ' +
                     'customer lists, franchise rights, going-concern ' +
                     'value.' },
      { value: 'non_capitalizable', label: 'Not Capitalizable',
        description: 'Sentinel value for accounts that should never be ' +
                     'capitalized (e.g. tenant credit clearings). ' +
                     'Helps the rule engine catch misclassifications.' },
    ],
  },

  business_context: {
    description:
      'Why the spend happened. Useful for operational analysis ' +
      'separate from tax / accounting treatment.',
    values: [
      { value: 'routine', label: 'Routine',
        description: 'Scheduled regular maintenance.' },
      { value: 'emergency', label: 'Emergency',
        description: 'Urgent, unscheduled. Typically a higher cost ' +
                     'per dollar than routine and a target for ' +
                     'preventive-maintenance investment.' },
      { value: 'turnover', label: 'Turnover',
        description: 'Work performed between tenants.' },
      { value: 'make_ready', label: 'Make-Ready',
        description: 'Preparing a unit for an incoming tenant.' },
      { value: 'improvement', label: 'Improvement',
        description: 'Value-adding upgrade beyond restoration. Often ' +
                     'should be capitalized.' },
      { value: 'compliance', label: 'Compliance',
        description: 'Required by code, regulation, inspector, or ' +
                     'court order.' },
      { value: 'acquisition', label: 'Acquisition',
        description: 'Related to property purchase. Often added to ' +
                     'basis rather than expensed.' },
      { value: 'disposition', label: 'Disposition',
        description: 'Related to property sale (broker fees, title, ' +
                     'capital-improvement preparation for sale).' },
    ],
  },

  functional: {
    description:
      'Finer-grain trade / functional category. Partially redundant ' +
      'with gl_accounts.account_subtype; allowed where cross-account ' +
      'reporting needs the rollup ("all HVAC dollars regardless of ' +
      'which expense GL was hit").',
    values: [
      { value: 'hvac', label: 'HVAC' },
      { value: 'plumbing', label: 'Plumbing' },
      { value: 'electrical', label: 'Electrical' },
      { value: 'roofing', label: 'Roofing' },
      { value: 'flooring', label: 'Flooring' },
      { value: 'paint', label: 'Paint' },
      { value: 'appliance', label: 'Appliance' },
      { value: 'landscaping', label: 'Landscaping' },
      { value: 'pest_control', label: 'Pest Control' },
      { value: 'janitorial', label: 'Janitorial' },
      { value: 'security', label: 'Security' },
      { value: 'pool', label: 'Pool / Spa' },
      { value: 'general_repair', label: 'General Repair' },
      { value: 'inspection', label: 'Inspection' },
      { value: 'snow_removal', label: 'Snow Removal' },
    ],
  },
};

// ── Validation rules ────────────────────────────────────────────
//
// Each rule is a function that takes the effective tag map for a
// line — `{ namespace: Set<value> }` — and returns:
//
//   null              if the rule is satisfied (or doesn't apply)
//   string            an error / warning message
//
// At post time the service layer runs every rule. Errors block
// auto-generated postings; for staff overrides they surface as
// warnings that require explicit acknowledgement.

export const VALIDATION_RULES = [
  {
    name: 'capital_expense_requires_capitalizable_tax_treatment',
    description:
      'A capital expense must have a tax treatment that capitalizes ' +
      'the cost (Section 179, bonus depreciation, or MACRS).',
    check(tags) {
      const cc = tags.cost_class;
      const tt = tags.tax_treatment;
      if (!cc?.has('capital_expense')) return null;
      const ok = tt && (
        tt.has('section_179') ||
        tt.has('bonus_depreciation_candidate') ||
        tt.has('capitalized_macrs')
      );
      if (ok) return null;
      return (
        'cost_class=capital_expense requires tax_treatment to be one ' +
        'of: section_179, bonus_depreciation_candidate, capitalized_macrs.'
      );
    },
  },
  {
    name: 'operating_forbids_macrs_capitalization',
    description:
      'An operating expense must not be marked as capitalized under ' +
      'MACRS — that combination is internally inconsistent.',
    check(tags) {
      const cc = tags.cost_class;
      const tt = tags.tax_treatment;
      if (!cc?.has('operating')) return null;
      if (!tt?.has('capitalized_macrs')) return null;
      return (
        'cost_class=operating cannot have tax_treatment=capitalized_macrs. ' +
        'Choose ordinary, passive_loss_limited, or change cost_class to ' +
        'capital_expense.'
      );
    },
  },
  {
    name: 'accelerated_depreciation_requires_asset_category',
    description:
      'Section 179 and bonus depreciation require an asset_category ' +
      'so the depreciation engine knows which recovery class applies.',
    check(tags) {
      const tt = tags.tax_treatment;
      if (!tt) return null;
      const accelerated =
        tt.has('section_179') || tt.has('bonus_depreciation_candidate');
      if (!accelerated) return null;
      const ac = tags.asset_category;
      if (ac && ac.size > 0 && !ac.has('non_capitalizable')) return null;
      return (
        'tax_treatment=section_179 or bonus_depreciation_candidate ' +
        'requires asset_category to be set to a capitalizable class.'
      );
    },
  },
  {
    name: 'de_minimis_forbids_capital_classification',
    description:
      'De-minimis safe harbor items are expensed; they cannot also ' +
      'be flagged as capital expenses.',
    check(tags) {
      const tt = tags.tax_treatment;
      const cc = tags.cost_class;
      if (!tt?.has('de_minimis_safe_harbor')) return null;
      if (!cc?.has('capital_expense')) return null;
      return (
        'tax_treatment=de_minimis_safe_harbor is incompatible with ' +
        'cost_class=capital_expense. Choose one approach.'
      );
    },
  },
];

// ── Helpers ──────────────────────────────────────────────────────

/**
 * Validate an effective tag set against the vocabulary rules.
 *
 * @param {Record<string, Set<string>>} tags - Effective tags as a
 *   namespace → Set<value> map.
 * @returns {Array<{ rule: string, message: string }>} List of
 *   violations; empty array if all rules pass.
 */
export function validateTagSet(tags) {
  const violations = [];
  for (const rule of VALIDATION_RULES) {
    const msg = rule.check(tags);
    if (msg) violations.push({ rule: rule.name, message: msg });
  }
  return violations;
}

/**
 * Is a (namespace, value) pair known to the vocabulary?
 * Used by the import flow and the UI to flag unknown tag values
 * before they're persisted.
 */
export function isKnownTag(namespace, value) {
  const v = TAG_VOCABULARIES[namespace];
  if (!v) return false;
  return v.values.some((entry) => entry.value === value);
}

/**
 * Convert an array of tag rows ({ namespace, value }) into the
 * Set-keyed map that the validators expect.
 */
export function tagsArrayToMap(rows) {
  const out = {};
  for (const { namespace, value } of rows) {
    if (!out[namespace]) out[namespace] = new Set();
    out[namespace].add(value);
  }
  return out;
}
