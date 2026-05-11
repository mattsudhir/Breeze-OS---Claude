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

const SLEEP = (ms) => new Promise((r) => setTimeout(r, ms));

export default withAdminHandler(async (req, res) => {
  const {
    from_date: explicitFrom,
    to_date: explicitTo,
    days,
    probe,
  } = req.query || {};
  const range =
    explicitFrom && explicitTo
      ? { from_date: explicitFrom, to_date: explicitTo }
      : defaultDateRange(days);

  // Hit the v0 control in parallel — it's a different host with its
  // own rate budget, no impact on Reports throttling.
  const v0Properties = executeTool('list_properties', {});

  // Reports API calls run SEQUENTIALLY with a small delay between
  // them. AppFolio's Reports API rate-limits aggressively and 429s
  // entire bursts even for distinct endpoints. Keep us comfortably
  // under whatever the limit is.
  const REPORTS_DELAY_MS = 750;

  const coa = await executeTool('list_gl_accounts', {});
  await SLEEP(REPORTS_DELAY_MS);
  const gl = await executeTool('list_general_ledger', range);
  await SLEEP(REPORTS_DELAY_MS);
  const bills = await executeTool('list_bill_detail', { ...range, status: 'All' });
  await SLEEP(REPORTS_DELAY_MS);
  const receipts = await executeTool('list_income_register', range);

  // The URL probe is now opt-in via ?probe=1. It's served its
  // purpose; running it on every call wastes Reports-API rate budget
  // and slows the response.
  let urlProbe = null;
  if (probe) {
    await SLEEP(REPORTS_DELAY_MS);
    urlProbe = await probeReportsEndpoints();
  }

  const v0Result = await v0Properties;

  return res.status(200).json({
    ok: true,
    generated_at: new Date().toISOString(),
    date_range: range,
    appfolio_subdomain:
      process.env.APPFOLIO_DATABASE_SUBDOMAIN || '(default: breezepg)',
    deployment_diagnostics: {
      vercel_env: process.env.VERCEL_ENV || null,
      vercel_git_commit_sha: process.env.VERCEL_GIT_COMMIT_SHA
        ? process.env.VERCEL_GIT_COMMIT_SHA.slice(0, 12)
        : null,
      vercel_url: process.env.VERCEL_URL || null,
      appfolio_env_vars_present: {
        APPFOLIO_CLIENT_ID: Boolean(process.env.APPFOLIO_CLIENT_ID),
        APPFOLIO_CLIENT_SECRET: Boolean(process.env.APPFOLIO_CLIENT_SECRET),
        APPFOLIO_DEVELOPER_ID: Boolean(process.env.APPFOLIO_DEVELOPER_ID),
        APPFOLIO_DATABASE_SUBDOMAIN: Boolean(
          process.env.APPFOLIO_DATABASE_SUBDOMAIN,
        ),
        APPFOLIO_REPORTS_CLIENT_ID: Boolean(
          process.env.APPFOLIO_REPORTS_CLIENT_ID,
        ),
        APPFOLIO_REPORTS_CLIENT_SECRET: Boolean(
          process.env.APPFOLIO_REPORTS_CLIENT_SECRET,
        ),
        BREEZE_ADMIN_TOKEN: Boolean(process.env.BREEZE_ADMIN_TOKEN),
      },
    },
    database_api_v0_control: sampleSection(v0Result, 3, 'properties'),
    chart_of_accounts: sampleSection(coa, 500, 'accounts'),
    general_ledger: sampleSection(gl, 50, 'entries'),
    bill_detail: sampleSection(bills, 50, 'bills'),
    income_register: sampleSection(receipts, 50, 'receipts'),
    _reports_url_probe: urlProbe,
    notes: [
      'Reports API calls now run sequentially with a 750ms delay',
      'between them, and postReport() retries 429s with exponential',
      'backoff (2s, 4s, 8s, capped at 4 attempts).',
      'The URL probe is opt-in via ?probe=1 — running it on every',
      'call wasted Reports-API rate budget unnecessarily once we',
      'knew which URL pattern works (v2 POST).',
    ],
  });
});
