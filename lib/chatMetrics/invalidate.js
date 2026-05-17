// chat_metrics invalidator — called by the AppFolio webhook handler
// after a successful mirror upsert. Marks dependent metrics dirty so
// the cron sweep recomputes them.
//
// For org-scoped metrics: marks the (org, key) row dirty.
// For per-resource scoped metrics: marks ONE row dirty (the
// resource_id that the webhook fired for), not the entire metric_key.
//
// See ADR 0006.

import { and, eq, inArray } from 'drizzle-orm';
import { getDb, schema } from '../db/index.js';
import { metricsForTopic, getMetricDef } from './registry.js';

const SCOPE_FOR_TOPIC = {
  tenants: 'tenant',
  properties: 'property',
  units: 'unit',
  work_orders: 'work_order',
  // charges has no scoped metric in v1 — only invalidates org-scoped
  // delinquency totals; the per-tenant balance is keyed on tenant_id
  // which the charge webhook doesn't carry directly. Fall back to
  // org-scoped invalidation for charges (and rely on the hourly sweep
  // to catch per-tenant balance staleness).
};

/**
 * Mark every metric that depends on this topic as dirty.
 *
 *   topic       — AppFolio webhook topic ('tenants', 'work_orders', …)
 *   resourceId  — the affected AppFolio resource id (string).
 *                 For org-scoped metrics this is informational only;
 *                 for scoped metrics it determines which row dirties.
 */
export async function markDirtyForTopic(orgId, topic, resourceId) {
  const keys = metricsForTopic(topic);
  if (!keys.length) return { dirtied: 0, keys: [] };

  const db = getDb();
  let dirtied = 0;

  for (const key of keys) {
    const def = getMetricDef(key);
    if (!def) continue;

    // For per-resource scope, dirty only the matching row.
    if (def.scopeType !== 'org') {
      // Only dirty when the topic's natural scope matches this metric's.
      const topicScope = SCOPE_FOR_TOPIC[topic];
      if (topicScope !== def.scopeType) continue;
      if (!resourceId) continue;

      const res = await db
        .update(schema.chatMetrics)
        .set({ stale: true, dirtyAt: new Date() })
        .where(
          and(
            eq(schema.chatMetrics.organizationId, orgId),
            eq(schema.chatMetrics.metricKey, key),
            eq(schema.chatMetrics.scopeType, def.scopeType),
            eq(schema.chatMetrics.scopeId, String(resourceId)),
          ),
        );
      dirtied += res?.rowCount || 0;
      continue;
    }

    // Org-scoped: dirty the single (org, key, 'org', '') row.
    const res = await db
      .update(schema.chatMetrics)
      .set({ stale: true, dirtyAt: new Date() })
      .where(
        and(
          eq(schema.chatMetrics.organizationId, orgId),
          eq(schema.chatMetrics.metricKey, key),
          eq(schema.chatMetrics.scopeType, 'org'),
          eq(schema.chatMetrics.scopeId, ''),
        ),
      );
    dirtied += res?.rowCount || 0;
  }

  return { dirtied, keys };
}

/**
 * Mark a specific metric_key dirty across all its rows. Useful for
 * "schema-of-this-metric changed, force refresh" admin actions.
 */
export async function markDirtyByKey(orgId, metricKey) {
  const db = getDb();
  const res = await db
    .update(schema.chatMetrics)
    .set({ stale: true, dirtyAt: new Date() })
    .where(
      and(
        eq(schema.chatMetrics.organizationId, orgId),
        eq(schema.chatMetrics.metricKey, metricKey),
      ),
    );
  return { dirtied: res?.rowCount || 0 };
}

/**
 * Convenience: dirty every metric of the given keys, irrespective of
 * topic. Used by the admin "refresh all" path.
 */
export async function markAllDirty(orgId, keys = null) {
  const db = getDb();
  if (keys && keys.length) {
    const res = await db
      .update(schema.chatMetrics)
      .set({ stale: true, dirtyAt: new Date() })
      .where(
        and(
          eq(schema.chatMetrics.organizationId, orgId),
          inArray(schema.chatMetrics.metricKey, keys),
        ),
      );
    return { dirtied: res?.rowCount || 0 };
  }
  const res = await db
    .update(schema.chatMetrics)
    .set({ stale: true, dirtyAt: new Date() })
    .where(eq(schema.chatMetrics.organizationId, orgId));
  return { dirtied: res?.rowCount || 0 };
}
