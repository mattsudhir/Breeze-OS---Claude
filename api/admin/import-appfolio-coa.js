// Vercel Serverless Function — cutover importer for an org's
// AppFolio chart of accounts into Breeze OS gl_accounts.
//
// GET  /api/admin/import-appfolio-coa?secret=...&dry_run=true
//   Returns the would-be plan without writing anything. Useful for
//   reviewing classification decisions before committing.
//
// POST /api/admin/import-appfolio-coa?secret=...
//   Performs the import in a transaction, emitting an audit_events
//   row per inserted account. Idempotent: codes already present for
//   the org are returned in `skipped` instead of duplicating.
//
// Both methods require BREEZE_ADMIN_TOKEN. Hits the AppFolio Reports
// API to fetch the live chart, so APPFOLIO_REPORTS_CLIENT_ID and
// APPFOLIO_REPORTS_CLIENT_SECRET must be configured in env.
//
// Response shape (both modes):
//   {
//     ok: true,
//     dry_run: <bool>,
//     fetched_from_appfolio: <n>,
//     plan_summary: { drop, parked_bank, parked_credit_card,
//                     remap, import, total_to_insert },
//     dropped: [...],
//     parked_bank: [...],
//     parked_credit_card: [...],
//     remapped: [...],
//     -- non-dry-run only:
//     inserted_count, skipped_count, error_count,
//     inserted: [...], skipped: [...], errors: [...]
//   }

import {
  withAdminHandler,
  getDefaultOrgId,
} from '../../lib/adminHelpers.js';
import { getDb } from '../../lib/db/index.js';
import { importAppfolioCoa } from '../../lib/accounting/importAppfolioCoa.js';

export default withAdminHandler(async (req, res) => {
  if (req.method !== 'GET' && req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'GET or POST only' });
  }

  // GET defaults to dry_run=true (browsing the plan is safer than
  // implicitly executing it). POST defaults to dry_run=false. Either
  // method honors an explicit ?dry_run=... param.
  const explicitDryRun = req.query?.dry_run;
  let dryRun;
  if (explicitDryRun === 'true' || explicitDryRun === '1') dryRun = true;
  else if (explicitDryRun === 'false' || explicitDryRun === '0') dryRun = false;
  else dryRun = req.method === 'GET';

  const db = getDb();
  const organizationId = await getDefaultOrgId();
  const t0 = Date.now();
  const report = await importAppfolioCoa(db, organizationId, { dryRun });
  const elapsedMs = Date.now() - t0;

  return res.status(200).json({
    organization_id: organizationId,
    elapsed_ms: elapsedMs,
    ...report,
  });
});
