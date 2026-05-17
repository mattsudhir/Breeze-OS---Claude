// Refresh the chat_metrics cache. Run on two schedules from
// vercel.json:
//   */5 * * * *  — pass mode=dirty (default): recompute anything
//                  marked stale by the webhook invalidator.
//   0    * * * * — pass mode=all: hourly full recompute as a
//                  safety net for missed webhooks.
//
// Auth model matches api/cron/appfolio-reconcile.js: Vercel cron
// bearer, x-vercel-cron header, or BREEZE_ADMIN_TOKEN for manual
// invocation.
//
// See ADR 0006.

import { refreshDirty, refreshAll } from '../../lib/chatMetrics/refresh.js';
import { getDefaultOrgIdForMirror } from '../../lib/appfolioMirror.js';

function isAuthorized(req) {
  const bearer = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (process.env.CRON_SECRET && bearer === process.env.CRON_SECRET) return true;
  if (req.headers['x-vercel-cron']) return true;
  const adminToken = process.env.BREEZE_ADMIN_TOKEN;
  if (!adminToken && !process.env.CRON_SECRET) return true;
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
  if (!isAuthorized(req)) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  // Default to dirty mode (cheap, runs every 5 min). Pass ?mode=all
  // for the hourly full sweep.
  const mode = (req.query?.mode || 'dirty').toString().toLowerCase();

  try {
    const organizationId = await getDefaultOrgIdForMirror();
    const startedAt = Date.now();
    const out = mode === 'all'
      ? await refreshAll(organizationId)
      : await refreshDirty(organizationId);
    return res.status(200).json({
      ok: true,
      organizationId,
      elapsed_ms: Date.now() - startedAt,
      ...out,
    });
  } catch (err) {
    console.error('[cron/refresh-chat-metrics] handler error:', err);
    return res.status(500).json({ error: err.message || 'Unknown error' });
  }
}
