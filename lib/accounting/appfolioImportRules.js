// AppFolio → Breeze OS chart-of-accounts import rules.
//
// Declares the per-account overrides applied during a cutover import
// (see lib/accounting/importAppfolioCoa.js). Three categories of rule:
//
//   1. APPFOLIO_DROP_CODES — codes that should not migrate. The
//      analysis (docs/accounting/appfolio-coa-analysis.md) lists
//      these as "Junk (Do Not Use)", LEGACY mortgage workarounds,
//      and deprecated overhead rows.
//
//   2. APPFOLIO_BANK_ACCOUNT_CODES — AppFolio "Cash" accounts that
//      should become bank_account rows in Stage 3, not GL accounts.
//      We import them as inactive GL placeholders so historical
//      journal entries that reference them still resolve, then the
//      Stage 3 bank_account import creates the canonical bank_account
//      rows linked 1:1 to a single shared Cash GL (1100).
//
//   3. APPFOLIO_CREDIT_CARD_CODES — same idea as bank accounts but
//      with account_type='credit_card' and linked to Liability GL
//      2400 Credit Cards Payable instead of Cash.
//
//   4. APPFOLIO_REMAP_RULES — per-code overrides for accounts that
//      DO migrate but with corrected classification (Tenant Credit
//      → Liability, Mgmt Held Holding Deposits → Liability, etc.).
//
// All rule sets keyed by AppFolio's `number` field (the customer's
// own account code, e.g. "1149", "6600"). Adding a code to multiple
// rule sets is a config error — the importer asserts disjointness.

// ── Drop list ────────────────────────────────────────────────────
//
// These codes are skipped entirely during import. Historical entries
// referencing them are left orphaned (Stage 3+ migrations of journal
// entries handle the rollover plug-to-suspense if needed).
export const APPFOLIO_DROP_CODES = new Set([
  '1140', // Junk 2 (Do Not Use)
  '1141', // Junk (Do Not Use)
  '1153', // Misplaced Funds 2
  '1190', // Misplaced Funds
  '6125', // LEGACY - Mortgage Principal and Interest due to depreciation
  '9030', // LEGACY - Mortgage P&I due to depreciation
  '9090', // LEGACY - Mortgage P&I + Escrow due to depreciation
  '9990', // Portfolio Overhead - Deprecated
  '7056', // Short Term Rental Furnishings - Unnecessary
]);

// ── Bank-account codes ───────────────────────────────────────────
//
// Imported as inactive GL placeholders. The Stage 3 bank-account
// importer will create real bank_account rows pointed at canonical
// Cash GLs (1100 etc.) and the on-link trigger will flip is_bank=true
// on the canonical GL.
//
// Clearing-style AppFolio accounts (1142, 1143, 1199, 1200, 9991)
// are deliberately NOT in this set — they're imported as normal
// (active) clearing GLs because Breeze OS still needs them for
// rent / deposit / settlement clearing workflows.
export const APPFOLIO_BANK_ACCOUNT_CODES = new Set([
  // Breeze main operating banks.
  '1149', '1150', '1151', '1152',
  // Per-property / per-entity LLC banks.
  '1179', '1180', '1181', '1182', '1183', '1184', '1185', '1186',
  '1187', '1188', '1189',
  // Per-LLC and reserve banks.
  '1212', '1213', '1214', '1215', '1216', '1217', '1218', '1220', '1221',
]);

// ── Credit-card codes ────────────────────────────────────────────
//
// Same idea as bank-account codes, but classified as the
// credit_card_payable subtype on a Liability GL rather than cash
// on an Asset GL. In Breeze OS these become bank_account rows with
// account_type='credit_card' linked 1:1 to the (Liability) Credit
// Card GL.
export const APPFOLIO_CREDIT_CARD_CODES = new Set([
  '1191', // Chase (Strehl)
  '1192', // PNC
  '1193', // Chase (Farmer)
  '1194', // Chase (STauro)
  '1195', // Chase (Rader)
  '1196', // Chase (Dion)
  '1197', // Chase (LTauro)
  '1198', // Jones Chase Ink
  '1210', // Chase Ink (Brown)
  '1211', // Bill.com
  '1219', // Strehl Amex
]);

// ── Per-code overrides ───────────────────────────────────────────
//
// For accounts that migrate (not dropped, not bank/credit-card)
// but whose AppFolio classification is wrong. Each entry may set
// any combination of:
//
//   accountType      override the type (e.g. Tenant Credit:
//                    Expense → Liability)
//   accountSubtype   override / set the subtype tag
//   normalBalance    override the implied normal balance (use
//                    when a contra account doesn't follow the
//                    default rule for its accountType)
//   name             optional rename (use sparingly — preserves
//                    customer muscle memory by keeping codes)
//   notes            free-text reason for the remap
//
// The importer applies these AFTER the default classification
// mapping, so an empty override = "import as-is with default
// classification".
export const APPFOLIO_REMAP_RULES = {
  // Tenant credit is money owed back to a tenant — a liability,
  // not an expense as AppFolio classifies it.
  '6600': {
    accountType: 'liability',
    accountSubtype: 'tenant_credit',
    normalBalance: 'credit',
    notes:
      'Reclassified from Expense to Liability — tenant credits are ' +
      'obligations owed back, not operating expenses.',
  },
  '6610': {
    accountType: 'liability',
    accountSubtype: 'tenant_credit',
    normalBalance: 'credit',
    notes: 'Reclassified from Expense to Liability (same as 6600).',
  },
  // 4905 is in the Income code range but classified Liability with
  // parent 2100 Security Deposits. We honor the classification (it
  // IS a liability) but the numbering is anomalous. Keep the code
  // for customer continuity; note the anomaly.
  '4905': {
    accountType: 'liability',
    accountSubtype: 'security_deposits_held',
    normalBalance: 'credit',
    notes:
      'Number is in 4xxx (Income) range but the account is a ' +
      'Liability under 2100. Code preserved; classification ' +
      'corrected. Consider renumbering to a 2xxx code later.',
  },
  // 8003 Misplaced Charges classified as Capital, but it's a plug
  // account — treat as Suspense (Asset) in our system.
  '8003': {
    accountType: 'asset',
    accountSubtype: 'suspense',
    normalBalance: 'debit',
    notes:
      'Reclassified from Capital to Suspense Asset. Used by ' +
      'AppFolio as a plug; lands in Suspense for review in ' +
      'Breeze OS.',
  },
  // Contra-income accounts: AppFolio classifies as Income with
  // credit normal balance, but they SHOULD be debit normal because
  // they reduce gross potential rent.
  '4210': { normalBalance: 'debit', accountSubtype: 'contra_income',
    notes: 'Contra-income (reduces rent income).' },
  '4211': { normalBalance: 'debit', accountSubtype: 'contra_income',
    notes: 'Contra-income (Section 8 abatement, reduces rent income).' },
  '4220': { normalBalance: 'debit', accountSubtype: 'contra_income',
    notes: 'Contra-income (delinquency, reduces rent income).' },
  '4230': { normalBalance: 'debit', accountSubtype: 'contra_income',
    notes: 'Contra-income (vacancy, reduces rent income).' },
  '4120': { normalBalance: 'debit', accountSubtype: 'contra_income',
    notes: 'Contra-income (loss to market, reduces rent income).' },
};

// ── Sanity: disjointness ────────────────────────────────────────
//
// Throws at import time if any code appears in more than one rule
// set. Prevents subtle bugs where, e.g., a code added to both
// DROP and BANK_ACCOUNT lists silently picks one.
export function assertRulesDisjoint() {
  const sets = {
    drop: APPFOLIO_DROP_CODES,
    bank: APPFOLIO_BANK_ACCOUNT_CODES,
    credit: APPFOLIO_CREDIT_CARD_CODES,
    remap: new Set(Object.keys(APPFOLIO_REMAP_RULES)),
  };
  const offending = [];
  const seen = new Map(); // code -> first set name
  for (const [name, codes] of Object.entries(sets)) {
    for (const code of codes) {
      const prior = seen.get(code);
      if (prior) offending.push({ code, sets: [prior, name] });
      else seen.set(code, name);
    }
  }
  if (offending.length) {
    throw new Error(
      'AppFolio import rules overlap (code in multiple sets): ' +
        JSON.stringify(offending),
    );
  }
}

// ── AppFolio type → Breeze OS type mapping ───────────────────────
//
// Breeze OS uses a strict 5-type enum (asset / liability / equity /
// income / expense). AppFolio's 8 types collapse:
//
//   Cash           → asset, subtype: cash
//   Asset          → asset
//   Liability      → liability
//   Capital        → equity
//   Income         → income
//   Other Income   → income, subtype: other_income
//   Expense        → expense
//   Other Expense  → expense, subtype: other_expense
export function mapAppfolioType(appfolioType) {
  switch (appfolioType) {
    case 'Cash':
      return { accountType: 'asset', accountSubtype: 'cash' };
    case 'Asset':
      return { accountType: 'asset', accountSubtype: null };
    case 'Liability':
      return { accountType: 'liability', accountSubtype: null };
    case 'Capital':
      return { accountType: 'equity', accountSubtype: null };
    case 'Income':
      return { accountType: 'income', accountSubtype: null };
    case 'Other Income':
      return { accountType: 'income', accountSubtype: 'other_income' };
    case 'Expense':
      return { accountType: 'expense', accountSubtype: null };
    case 'Other Expense':
      return { accountType: 'expense', accountSubtype: 'other_expense' };
    default:
      throw new Error(`Unknown AppFolio account_type: ${appfolioType}`);
  }
}

// Default normal balance for a given Breeze OS account_type. Used
// when neither AppFolio nor a remap rule overrides it.
export function defaultNormalBalance(accountType) {
  switch (accountType) {
    case 'asset':
    case 'expense':
      return 'debit';
    case 'liability':
    case 'equity':
    case 'income':
      return 'credit';
    default:
      throw new Error(`Unknown accountType: ${accountType}`);
  }
}

// AppFolio stores sub_accountof as "<code> <name>" concatenated
// ("2100 SECURITY DEPOSITS"). Extract just the code (first
// whitespace-separated token) for parent lookup. Returns null for
// null / empty / "null" string input.
export function parseSubAccountOfCode(subAccountOf) {
  if (!subAccountOf) return null;
  if (subAccountOf === 'null') return null;
  const trimmed = String(subAccountOf).trim();
  if (!trimmed) return null;
  const firstToken = trimmed.split(/\s+/)[0];
  return firstToken || null;
}
