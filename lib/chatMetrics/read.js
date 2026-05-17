// chat_metrics reader — the read path used by chat tools and by the
// admin "show me everything" endpoint.
//
// getMetric(orgId, key, scopeId?) returns the cached value if it's
// fresh enough, else recomputes inline and writes back. Either way
// the caller gets a value in O(50ms-2s).

import { and, eq } from 'drizzle-orm';
import { getDb, schema } from '../db/index.js';
import { getMetricDef } from './registry.js';

const STALE_SOFT_MS = 60 * 1000; // anything <1 min old is always good

/**
 * Read a metric. If missing OR older than its TTL, recompute inline
 * and persist. Always returns:
 *   { ok, value, computed_at, age_seconds, source }
 * source ∈ 'cache' | 'inline_compute' | 'fallback_compute'
 *
 * On unknown metric_key returns { ok: false, error }.
 * On compute error returns { ok: false, error }.
 */
export async function getMetric(orgId, metricKey, scopeId = '') {
  const def = getMetricDef(metricKey);
  if (!def) {
    return { ok: false, error: `Unknown metric_key: ${metricKey}` };
  }
  const db = getDb();
  const sid = scopeId || '';

  const existing = await db
    .select()
    .from(schema.chatMetrics)
    .where(
      and(
        eq(schema.chatMetrics.organizationId, orgId),
        eq(schema.chatMetrics.metricKey, metricKey),
        eq(schema.chatMetrics.scopeType, def.scopeType),
        eq(schema.chatMetrics.scopeId, sid),
      ),
    )
    .limit(1);

  const now = Date.now();
  const row = existing[0];

  if (row) {
    const ageMs = now - new Date(row.computedAt).getTime();
    const ttlMs = (def.ttlSeconds || 3600) * 1000;
    const fresh = ageMs < ttlMs && (ageMs < STALE_SOFT_MS || !row.stale);
    if (fresh) {
      return {
        ok: true,
        value: row.value,
        computed_at: row.computedAt,
        age_seconds: Math.round(ageMs / 1000),
        scope_type: def.scopeType,
        scope_id: sid,
        source: 'cache',
      };
    }
  }

  // Cache miss or stale → compute inline.
  try {
    const t0 = Date.now();
    const value = await def.compute(db, orgId, sid);
    const computeMs = Date.now() - t0;
    await persist(orgId, def, sid, value, computeMs);
    return {
      ok: true,
      value,
      computed_at: new Date(),
      age_seconds: 0,
      scope_type: def.scopeType,
      scope_id: sid,
      source: row ? 'inline_compute' : 'fallback_compute',
      compute_ms: computeMs,
    };
  } catch (err) {
    return { ok: false, error: err.message || String(err) };
  }
}

/**
 * Force a recompute regardless of cache state. Used by the cron and
 * the admin "refresh" endpoint.
 */
export async function recomputeMetric(orgId, metricKey, scopeId = '') {
  const def = getMetricDef(metricKey);
  if (!def) return { ok: false, error: `Unknown metric_key: ${metricKey}` };
  const db = getDb();
  const sid = scopeId || '';
  try {
    const t0 = Date.now();
    const value = await def.compute(db, orgId, sid);
    const computeMs = Date.now() - t0;
    await persist(orgId, def, sid, value, computeMs);
    return { ok: true, value, compute_ms: computeMs };
  } catch (err) {
    return { ok: false, error: err.message || String(err) };
  }
}

async function persist(orgId, def, scopeId, value, computeMs) {
  const db = getDb();
  await db
    .insert(schema.chatMetrics)
    .values({
      organizationId: orgId,
      metricKey: def.key,
      scopeType: def.scopeType,
      scopeId,
      value,
      computedAt: new Date(),
      stale: false,
      dirtyAt: null,
      computeMs,
    })
    .onConflictDoUpdate({
      target: [
        schema.chatMetrics.organizationId,
        schema.chatMetrics.metricKey,
        schema.chatMetrics.scopeType,
        schema.chatMetrics.scopeId,
      ],
      set: {
        value,
        computedAt: new Date(),
        stale: false,
        dirtyAt: null,
        computeMs,
      },
    });
}
