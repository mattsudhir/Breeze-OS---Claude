// Hourly reconciliation cron for the AppFolio mirror.
//
// Fan-out via webhooks (api/webhooks/appfolio.js) keeps the cache
// near-realtime, but AppFolio's docs explicitly don't promise
// exactly-once delivery — drops happen. This cron asks AppFolio
// for everything modified since each resource type's last cached
// row's synced_at, and upserts whatever comes back. Catches drops
// without paying for a full bulk re-sync.
//
// API budget: each run hits ~4 endpoints (tenants / properties /
// units / work_orders) once with filters[LastUpdatedAtFrom]= and
// paginates. Most hours that's 4-12 AppFolio calls — well under
// the 4096/hr rate limit.
//
// Schedule: hourly, configured in vercel.json. Vercel cron sends
// Authorization: Bearer ${CRON_SECRET}; we accept that or the
// admin token for manual invocation.

import { reconcileAll, getDefaultOrgIdForMirror } from '../../lib/appfolioMirror.js';

function isAuthorizedCron(req) {
  // Vercel modern cron auth: Authorization: Bearer ${CRON_SECRET}
  const bearer = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (process.env.CRON_SECRET && bearer === process.env.CRON_SECRET) return true;
  // Legacy header (older Vercel cron deployments).
  if (req.headers['x-vercel-cron']) return true;
  // Manual invocation: BREEZE_ADMIN_TOKEN via bearer / header / query.
  const adminToken = process.env.BREEZE_ADMIN_TOKEN;
  if (!adminToken && !process.env.CRON_SECRET) return true; // dev mode
  if (adminToken) {
    const provided =
      req.query?.secret ||
      req.headers['x-breeze-admin-token'] ||
      bearer;
    if (provided === adminToken) return true;
  }
  return false;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');

  if (!isAuthorizedCron(req)) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    const organizationId = await getDefaultOrgIdForMirror();
    const startedAt = Date.now();
    const results = await reconcileAll(organizationId);
    return res.status(200).json({
      ok: true,
      organizationId,
      elapsed_ms: Date.now() - startedAt,
      results,
    });
  } catch (err) {
    console.error('[cron/appfolio-reconcile] handler error:', err);
    return res.status(500).json({ error: err.message || 'Unknown error' });
  }
}
