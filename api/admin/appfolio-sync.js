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
import { getDb, schema } from '../../lib/db/index.js';
import { eq, and } from 'drizzle-orm';

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

    // Browser-friendly: GET ?action=sync triggers a sync so the
    // bootstrap can be kicked off by pasting a URL into Safari on a
    // phone. Side-effecting GET is technically a semantics
    // violation, but for a one-off admin bootstrap (gated by the
    // admin token) it's the right ergonomics call. Bare GET still
    // returns stats with no side effects.
    const isSyncTrigger =
      req.method === 'POST' || req.query?.action === 'sync';

    if (isSyncTrigger) {
      const startedAt = Date.now();
      const results = await bulkSyncAll(organizationId);
      return res.status(200).json({
        ok: true,
        organizationId,
        elapsed_ms: Date.now() - startedAt,
        results,
      });
    }

    if (req.method === 'GET') {
      // Diagnostic: ?inspect=tenant|property|unit|work_order returns
      // a tiny sample of stored canonical rows so we can see what
      // fields are actually populated without dumping the whole
      // table. Useful when the UI is rendering blanks for fields
      // we expected the bootstrap to fill in.
      const inspectType = req.query?.inspect;
      if (inspectType) {
        const valid = ['tenant', 'property', 'unit', 'work_order'];
        if (!valid.includes(inspectType)) {
          return res.status(400).json({
            error: `inspect must be one of ${valid.join(', ')}`,
          });
        }
        const db = getDb();
        const rows = await db
          .select({ data: schema.appfolioCache.data })
          .from(schema.appfolioCache)
          .where(and(
            eq(schema.appfolioCache.organizationId, organizationId),
            eq(schema.appfolioCache.resourceType, inspectType),
          ))
          .limit(3);
        const samples = rows.map((r) => r.data);
        // Surface which keys are present + non-empty across the
        // sample so we can eyeball at a glance whether unit_name /
        // rent / move_in_date etc. came through.
        const presentKeys = {};
        for (const row of samples) {
          for (const [k, v] of Object.entries(row || {})) {
            if (v == null || v === '' || (Array.isArray(v) && v.length === 0)) continue;
            presentKeys[k] = (presentKeys[k] || 0) + 1;
          }
        }
        return res.status(200).json({
          ok: true,
          resourceType: inspectType,
          sampleCount: samples.length,
          presentKeysAcrossSamples: presentKeys,
          samples,
        });
      }

      const stats = await mirrorStats(organizationId);
      return res.status(200).json({
        ok: true,
        organizationId,
        stats,
        hint:
          'Add ?action=sync (and your admin token) to this URL to ' +
          'trigger a bulk re-sync from AppFolio. ' +
          'Add ?inspect=tenant|property|unit|work_order to see a 3-row ' +
          'sample of what the mirror stores.',
      });
    }

    return res.status(405).json({ error: 'GET or POST only' });
  } catch (err) {
    console.error('[appfolio-sync] handler error:', err);
    return res.status(500).json({ error: err.message || 'Unknown error' });
  }
}
