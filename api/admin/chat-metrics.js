// /api/admin/chat-metrics
//
//   GET  → list every cached metric for the org with computed_at,
//          stale flag, scope, and value. Useful for "what does the
//          cache currently know?" debugging.
//
//          ?key=tenant_count → only that metric.
//          ?key=tenant_balance_cents&scope_id=<tenant_id>
//             → read or compute on demand for a single scoped row.
//
//   POST → force a recompute.
//          { key: 'tenant_count' }                  → one org-scoped key
//          { key: 'tenant_balance_cents',           → one scoped row
//            scope_id: '<tenant_id>' }
//          { all: true }                            → run refreshAll()
//          { dirty: true }                          → run refreshDirty()
//
// See ADR 0006.

import { and, eq } from 'drizzle-orm';
import {
  withAdminHandler,
  getDefaultOrgId,
  parseBody,
} from '../../lib/adminHelpers.js';
import { getDb, schema } from '../../lib/db/index.js';
import { METRICS, METRIC_KEYS, getMetricDef } from '../../lib/chatMetrics/registry.js';
import { getMetric, recomputeMetric } from '../../lib/chatMetrics/read.js';
import { refreshAll, refreshDirty } from '../../lib/chatMetrics/refresh.js';

export default withAdminHandler(async (req, res) => {
  const orgId = await getDefaultOrgId();

  if (req.method === 'GET') {
    const key = req.query?.key || null;
    const scopeId = req.query?.scope_id || '';

    // Single-key read (with optional scope_id; runs read-through).
    if (key) {
      const out = await getMetric(orgId, String(key), String(scopeId || ''));
      return res.status(200).json(out);
    }

    // Bulk: every cached row + the registry so the UI knows what
    // metrics exist even if they've never been computed.
    const rows = await db()
      .select()
      .from(schema.chatMetrics)
      .where(eq(schema.chatMetrics.organizationId, orgId));

    const byKey = {};
    for (const r of rows) {
      const k = r.metricKey;
      if (!byKey[k]) byKey[k] = [];
      byKey[k].push({
        scope_type: r.scopeType,
        scope_id: r.scopeId,
        value: r.value,
        computed_at: r.computedAt,
        stale: r.stale,
        dirty_at: r.dirtyAt,
        compute_ms: r.computeMs,
        age_seconds: Math.round((Date.now() - new Date(r.computedAt).getTime()) / 1000),
      });
    }

    return res.status(200).json({
      ok: true,
      organization_id: orgId,
      registry: METRIC_KEYS.map((k) => {
        const def = METRICS[k];
        return {
          key: def.key,
          scope_type: def.scopeType,
          description: def.description,
          depends_on: def.dependsOn,
          ttl_seconds: def.ttlSeconds,
        };
      }),
      cached: byKey,
    });
  }

  if (req.method === 'POST') {
    const body = parseBody(req);

    if (body.all === true) {
      const out = await refreshAll(orgId);
      return res.status(200).json({ ok: true, organization_id: orgId, ...out });
    }
    if (body.dirty === true) {
      const out = await refreshDirty(orgId);
      return res.status(200).json({ ok: true, organization_id: orgId, ...out });
    }
    if (body.key) {
      const def = getMetricDef(body.key);
      if (!def) {
        return res.status(400).json({ ok: false, error: `Unknown metric_key: ${body.key}` });
      }
      const out = await recomputeMetric(orgId, body.key, body.scope_id || '');
      return res.status(200).json({ ok: true, key: body.key, ...out });
    }
    return res.status(400).json({
      ok: false,
      error: 'Provide one of: { all:true }, { dirty:true }, { key:"..." }',
    });
  }

  return res.status(405).json({ ok: false, error: 'GET or POST only' });
});

// Tiny db handle helper so we don't pull getDb at top-level scope
// (admin endpoints are sometimes cold-started in pre-init).
function db() {
  return getDb();
}
