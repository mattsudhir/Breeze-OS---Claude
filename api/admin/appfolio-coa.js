// AppFolio Chart of Accounts — slim, analyzable summary.
//
// GET /api/admin/appfolio-coa?secret=<BREEZE_ADMIN_TOKEN>
//
// The full chart_of_accounts blob from /appfolio-introspect is too big
// to read on a phone (most fields aren't relevant for designing the
// Breeze OS default COA template). This endpoint pulls the same data,
// then returns a focused view:
//
//   - total_count
//   - active_count (excluding hidden)
//   - by_account_type   { Cash: 4, Income: 12, Expense: 47, ... }
//   - by_fund_account   { Operating: 84, Reserve: 6, ... }
//   - hierarchy_summary { roots: N, with_parent: M, max_depth: D }
//   - sample_per_type   { Cash: [first 5 accounts], Income: [first 5], ... }
//   - all_accounts      [{number, account_name, account_type,
//                          sub_accountof, fund_account, hidden}]
//
// The all_accounts payload is intentionally slim (5 fields, no IDs,
// no flags we don't need) so the full chart fits in a few KB.

import { withAdminHandler } from '../../lib/adminHelpers.js';
import { executeTool } from '../../lib/backends/appfolio.js';

function pickField(account, candidates) {
  for (const k of candidates) {
    if (account[k] !== undefined && account[k] !== null) return account[k];
  }
  return null;
}

function slimAccount(a) {
  // AppFolio v1 returns PascalCase, v2 returns snake_case. Accept both.
  return {
    number: pickField(a, ['number', 'GlAccountNumber']),
    account_name: pickField(a, ['account_name', 'GlAccountName']),
    account_type: pickField(a, ['account_type', 'GlAccountType']),
    sub_accountof: pickField(a, ['sub_accountof', 'SubAccountOf']),
    fund_account: pickField(a, ['fund_account', 'FundAccount']),
    hidden: pickField(a, ['hidden', 'Hidden']),
  };
}

function summarize(accounts) {
  const byType = {};
  const byFund = {};
  const samplePerType = {};
  let activeCount = 0;
  let withParent = 0;

  for (const a of accounts) {
    if (!a.hidden) activeCount += 1;
    byType[a.account_type] = (byType[a.account_type] || 0) + 1;
    byFund[a.fund_account] = (byFund[a.fund_account] || 0) + 1;
    if (a.sub_accountof) withParent += 1;
    if (!samplePerType[a.account_type]) samplePerType[a.account_type] = [];
    if (samplePerType[a.account_type].length < 5) {
      samplePerType[a.account_type].push(a);
    }
  }

  // Sort by type counts descending so the largest categories surface first.
  const sortedByType = Object.fromEntries(
    Object.entries(byType).sort((a, b) => b[1] - a[1]),
  );
  const sortedByFund = Object.fromEntries(
    Object.entries(byFund).sort((a, b) => b[1] - a[1]),
  );

  return {
    total_count: accounts.length,
    active_count: activeCount,
    hidden_count: accounts.length - activeCount,
    by_account_type: sortedByType,
    by_fund_account: sortedByFund,
    hierarchy_summary: {
      roots: accounts.length - withParent,
      with_parent: withParent,
    },
    sample_per_type: samplePerType,
  };
}

export default withAdminHandler(async (req, res) => {
  const result = await executeTool('list_gl_accounts', {});
  if (result.error) {
    return res.status(502).json({ ok: false, error: result.error });
  }

  const rawAccounts = result.accounts || result.data || [];
  const slim = rawAccounts.map(slimAccount);
  const summary = summarize(slim);

  return res.status(200).json({
    ok: true,
    generated_at: new Date().toISOString(),
    summary,
    all_accounts: slim,
    columns_from_appfolio: result.columns || null,
  });
});
