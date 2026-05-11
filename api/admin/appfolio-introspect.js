// One-shot AppFolio introspection endpoint.
//
// GET /api/admin/appfolio-introspect?secret=...&days=30
//
// Pulls a representative snapshot of the org's AppFolio data so we can
// analyse the shape of the current chart of accounts, journal entries,
// bills, and receipts before designing the Breeze OS GL schema and the
// migration importers.
//
// Inputs (query string):
//   secret    — BREEZE_ADMIN_TOKEN (or via header per adminHelpers)
//   days      — lookback window in days for the transactional samples.
//               Defaults to 30. Capped at 365.
//   from_date / to_date — explicit window; overrides `days` when set.
//
// Returns: a JSON object with one section per call, each containing
//   { ok, count, sample, columns, error? } so partial failures don't
//   take down the whole report. The chart of accounts is the primary
//   payload; the transactional pulls are sized down to ~50 sample rows
//   per call to keep the response small and reviewable.
//
// Expected failure modes (all visible in the response, not thrown):
//   - 403 "Host not in allowlist" if Vercel egress isn't allowlisted
//     in the AppFolio Developer Space. See
//     docs/accounting/appfolio-access-setup.md.
//   - 404 if a Reports endpoint isn't enabled on the account.
//   - Empty results if the date range has no activity.

import { withAdminHandler } from '../../lib/adminHelpers.js';
import { executeTool, probeReportsEndpoints } from '../../lib/backends/appfolio.js';

function defaultDateRange(daysParam) {
  const days = Math.min(Math.max(parseInt(daysParam, 10) || 30, 1), 365);
  const to = new Date();
  const from = new Date(to.getTime() - days * 24 * 60 * 60 * 1000);
  return {
    from_date: from.toISOString().slice(0, 10),
    to_date: to.toISOString().slice(0, 10),
  };
}

function sampleSection(result, sampleSize = 50, sampleKey) {
  if (!result) return { ok: false, error: 'no result' };
  if (result.error) return { ok: false, error: result.error };
  const rows = result[sampleKey] || result.data || [];
  return {
    ok: true,
    count: rows.length,
    sample: rows.slice(0, sampleSize),
    columns: result.columns || null,
    truncated: rows.length > sampleSize,
  };
}

export default withAdminHandler(async (req, res) => {
  const { from_date: explicitFrom, to_date: explicitTo, days } = req.query || {};
  const range =
    explicitFrom && explicitTo
      ? { from_date: explicitFrom, to_date: explicitTo }
      : defaultDateRange(days);

  // Control test: hit Database API v0 (list_properties) with no filters
  // beyond the required LastUpdatedAtFrom. This API uses a different
  // host (api.appfolio.com) and a different auth/route pattern than the
  // Reports API, so it's an independent signal of whether the
  // credentials + IP allowlist are working at all. Useful diagnostic
  // when Reports API requests are returning 404 or 403 — distinguishes
  // "neither API works" from "v0 works but Reports doesn't".
  const [v0Properties, coa, gl, bills, receipts, urlProbe] = await Promise.all([
    executeTool('list_properties', {}),
    executeTool('list_gl_accounts', {}),
    executeTool('list_general_ledger', range),
    executeTool('list_bill_detail', { ...range, status: 'All' }),
    executeTool('list_income_register', range),
    probeReportsEndpoints(),
  ]);

  return res.status(200).json({
    ok: true,
    generated_at: new Date().toISOString(),
    date_range: range,
    appfolio_subdomain:
      process.env.APPFOLIO_DATABASE_SUBDOMAIN || '(default: breezepg)',
    database_api_v0_control: sampleSection(v0Properties, 3, 'properties'),
    chart_of_accounts: sampleSection(coa, 500, 'accounts'),
    general_ledger: sampleSection(gl, 50, 'entries'),
    bill_detail: sampleSection(bills, 50, 'bills'),
    income_register: sampleSection(receipts, 50, 'receipts'),
    _reports_url_probe: urlProbe,
    notes: [
      'database_api_v0_control is a diagnostic ping against the v0',
      'API at api.appfolio.com. If it succeeds while Reports calls',
      'fail, the issue is specifically with Reports API URL/scope,',
      'not with credentials or IP allowlisting in general.',
      '_reports_url_probe tries several URL/method combinations for',
      'the chart_of_accounts report and surfaces the raw HTTP status',
      'and body snippet for each — look for whichever variant',
      'returns a non-404 / non-403 status to identify the right URL',
      'shape for this account.',
      'Chart of accounts (Reports API) is returned in full when',
      'available (up to 500 rows).',
      'GL / bills / receipts are sampled to 50 rows each.',
    ],
  });
});
