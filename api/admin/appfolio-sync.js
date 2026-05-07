// Admin endpoint to bootstrap the AppFolio mirror.
//
// POST /api/admin/appfolio-sync
//   Triggers a full bulk sync of every mirrored resource type
//   (tenants, properties, units, work_orders) from AppFolio into
//   our appfolio_cache table. Run once after deploying the mirror;
//   webhooks keep things current after that.
//
// GET /api/admin/appfolio-sync
//   Returns mirror stats: per-resource-type row counts and the
//   most recent sync timestamp. Cheap, no AppFolio API calls.
//
// Auth: BREEZE_ADMIN_TOKEN, accepted via either an Authorization
// header (`Bearer <token>`), an x-breeze-admin-token header, or a
// `?secret=` query param. Same shape every other admin endpoint
// uses. If the env var isn't set, the endpoint is open (dev mode);
// in production set it.

import { bulkSyncAll, mirrorStats, getDefaultOrgIdForMirror } from '../../lib/appfolioMirror.js';

function isAuthorized(req) {
  const expected = process.env.BREEZE_ADMIN_TOKEN;
  if (!expected) return true; // dev / first-boot mode
  const provided =
    req.query?.secret ||
    req.headers['x-breeze-admin-token'] ||
    (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  return provided === expected;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader(
    'Access-Control-Allow-Headers',
    'Content-Type, x-breeze-admin-token, Authorization',
  );
  if (req.method === 'OPTIONS') return res.status(200).end();

  if (!isAuthorized(req)) {
    return res.status(401).json({ error: 'Unauthorized — missing or wrong admin token' });
  }

  try {
    const organizationId = await getDefaultOrgIdForMirror();

    if (req.method === 'GET') {
      const stats = await mirrorStats(organizationId);
      return res.status(200).json({ ok: true, organizationId, stats });
    }

    if (req.method === 'POST') {
      const startedAt = Date.now();
      const results = await bulkSyncAll(organizationId);
      return res.status(200).json({
        ok: true,
        organizationId,
        elapsed_ms: Date.now() - startedAt,
        results,
      });
    }

    return res.status(405).json({ error: 'GET or POST only' });
  } catch (err) {
    console.error('[appfolio-sync] handler error:', err);
    return res.status(500).json({ error: err.message || 'Unknown error' });
  }
}
