// Vercel Serverless Function — back-fill default classification
// tags onto existing GL accounts.
//
// GET/POST /api/admin/backfill-gl-account-tags?secret=<TOKEN>
//
// Iterates every gl_accounts row in the default org, computes its
// default tag set (via the rules in lib/accounting/defaultGlAccountTags.js
// and the vocabularies in lib/accounting/tagVocabularies.js), and
// INSERTs the missing tags. Idempotent — re-running is safe.
//
// Use right after the AppFolio COA import or after any bulk gl_account
// changes that should pick up the default tag mapping.

import {
  withAdminHandler,
  getDefaultOrgId,
} from '../../lib/adminHelpers.js';
import { getDb } from '../../lib/db/index.js';
import { backfillDefaultTagsForOrg } from '../../lib/accounting/applyDefaultGlAccountTags.js';

export default withAdminHandler(async (req, res) => {
  if (req.method !== 'GET' && req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'GET or POST only' });
  }

  const db = getDb();
  const organizationId = await getDefaultOrgId();
  const t0 = Date.now();
  const result = await backfillDefaultTagsForOrg(db, organizationId);
  const elapsedMs = Date.now() - t0;

  return res.status(200).json({
    ok: true,
    organization_id: organizationId,
    elapsed_ms: elapsedMs,
    ...result,
  });
});
