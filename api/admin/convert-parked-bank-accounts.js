// Vercel Serverless Function — convert AppFolio "parked" GL
// accounts to real bank_account rows.
//
// GET  /api/admin/convert-parked-bank-accounts?secret=<TOKEN>
//   Dry-run: show what would be created without writing.
//
// POST /api/admin/convert-parked-bank-accounts?secret=<TOKEN>
//   or  ...?dry_run=false
//   Execute the conversion in one transaction.
//
// The AppFolio COA importer flagged 35 GLs as parked
// (24 bank accounts + 11 credit cards). This endpoint walks the
// audit_events trail to find them, then creates a bank_account
// row per parked GL with the 1:1 link to the GL. The is_bank
// trigger flips gl_accounts.is_bank=true on link. For credit
// cards, the GL is also reclassified asset/cash → liability/
// credit_card_payable to align with proper accounting.

import {
  withAdminHandler,
  getDefaultOrgId,
} from '../../lib/adminHelpers.js';
import { getDb } from '../../lib/db/index.js';
import { bulkConvertParkedAccounts } from '../../lib/accounting/bankAccountLinking.js';

export default withAdminHandler(async (req, res) => {
  if (req.method !== 'GET' && req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'GET or POST only' });
  }

  // GET defaults to dry-run; POST defaults to execute. Either can
  // be overridden with ?dry_run=true|false.
  const explicit = req.query?.dry_run;
  let dryRun;
  if (explicit === 'true' || explicit === '1') dryRun = true;
  else if (explicit === 'false' || explicit === '0') dryRun = false;
  else dryRun = req.method === 'GET';

  const db = getDb();
  const organizationId = await getDefaultOrgId();
  const t0 = Date.now();

  const result = await db.transaction(async (tx) => {
    return await bulkConvertParkedAccounts(tx, organizationId, { dryRun });
  });

  return res.status(200).json({
    ok: true,
    dry_run: dryRun,
    organization_id: organizationId,
    elapsed_ms: Date.now() - t0,
    summary: {
      processed: result.processed,
      created_count: result.created.length,
      skipped_count: result.skipped.length,
      error_count: result.errors.length,
    },
    created: result.created,
    skipped: result.skipped,
    errors: result.errors,
  });
});
