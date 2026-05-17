// chat_metrics refresher — called by the cron sweep. Two modes:
//
//   refreshDirty(orgId)  — recompute every row marked stale=true.
//                          The fast 5-minute path; cheap most runs.
//   refreshAll(orgId)    — recompute every org-scoped metric
//                          unconditionally. Hourly safety net for
//                          missed webhooks and forgotten dependsOn.
//
// Per-resource scoped metrics (`tenant_balance_cents`, …) are NOT
// included in refreshAll because we don't enumerate every tenant
// pre-emptively. They live on read-through + dirty-from-webhook.

import { and, eq } from 'drizzle-orm';
import { getDb, schema } from '../db/index.js';
import { METRICS, METRIC_KEYS } from './registry.js';
import { recomputeMetric } from './read.js';

export async function refreshDirty(orgId) {
  const db = getDb();
  const dirtyRows = await db
    .select({
      metricKey: schema.chatMetrics.metricKey,
      scopeType: schema.chatMetrics.scopeType,
      scopeId: schema.chatMetrics.scopeId,
    })
    .from(schema.chatMetrics)
    .where(
      and(
        eq(schema.chatMetrics.organizationId, orgId),
        eq(schema.chatMetrics.stale, true),
      ),
    );

  const results = [];
  for (const r of dirtyRows) {
    const t0 = Date.now();
    const res = await recomputeMetric(orgId, r.metricKey, r.scopeId);
    results.push({
      key: r.metricKey,
      scope_type: r.scopeType,
      scope_id: r.scopeId,
      ok: res.ok,
      error: res.ok ? undefined : res.error,
      compute_ms: Date.now() - t0,
    });
  }
  return { mode: 'dirty', refreshed: results.length, results };
}

export async function refreshAll(orgId) {
  // Org-scoped metrics only. Scoped metrics are read-through; we
  // don't pre-warm them.
  const orgKeys = METRIC_KEYS.filter((k) => METRICS[k].scopeType === 'org');
  const results = [];
  for (const key of orgKeys) {
    const t0 = Date.now();
    const res = await recomputeMetric(orgId, key, '');
    results.push({
      key,
      ok: res.ok,
      error: res.ok ? undefined : res.error,
      compute_ms: Date.now() - t0,
    });
  }
  return { mode: 'all', refreshed: results.length, results };
}
