// Vercel Serverless Function — seed the default Chart of Accounts.
//
// GET/POST /api/admin/seed-chart-of-accounts?secret=<BREEZE_ADMIN_TOKEN>
//
// Idempotent. Calls seedDefaultChartOfAccounts() against the default
// organization. Existing accounts are skipped (and listed in the
// response) so re-running is safe. Returns counts plus the full
// created/skipped lists for verification.
//
// Both GET and POST are accepted because seeding is idempotent and
// admin-authenticated — pasting the URL into a phone browser is a
// legitimate invocation pattern, the same as the migration runner.

import {
  withAdminHandler,
  getDefaultOrgId,
} from '../../lib/adminHelpers.js';
import { getDb } from '../../lib/db/index.js';
import { seedDefaultChartOfAccounts } from '../../lib/accounting/seedChartOfAccounts.js';

export default withAdminHandler(async (req, res) => {
  if (req.method !== 'GET' && req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'GET or POST only' });
  }

  const db = getDb();
  const organizationId = await getDefaultOrgId();
  const t0 = Date.now();
  const result = await seedDefaultChartOfAccounts(db, organizationId);
  const elapsedMs = Date.now() - t0;

  return res.status(200).json({
    ok: true,
    organization_id: organizationId,
    elapsed_ms: elapsedMs,
    summary: {
      created_count: result.created.length,
      skipped_count: result.skipped.length,
    },
    created: result.created,
    skipped: result.skipped,
  });
});
