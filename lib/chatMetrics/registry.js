// chat_metrics registry — one entry per metric_key.
//
// A registry entry describes how to compute a metric and what
// invalidates it. The reader, the invalidator, and the cron all
// look here.
//
// See ADR 0006.
//
// Fields:
//   key          — primary identifier (e.g. 'tenant_count')
//   scopeType    — 'org' | 'tenant' | 'property' | 'unit' | 'entity'
//   description  — human-readable; surfaced to chat + admin UI
//   dependsOn    — array of AppFolio webhook topics that should
//                  invalidate this metric. The invalidator dirties
//                  any metric whose dependsOn intersects the
//                  fired topic.
//   ttlSeconds   — hard staleness budget. The reader treats anything
//                  older than this as missing (recomputes inline).
//                  Pick this LOOSE — webhooks + cron should keep it
//                  fresh well within the TTL; TTL is the floor.
//   compute      — async (db, orgId, scopeId) => value (any json shape).
//                  scopeId is '' for org-scoped metrics.
//
// To add a new metric: add an entry below, add its compute function
// in ./computers.js, and (if topical) include its webhook topics in
// dependsOn. That's it — the cron + invalidator pick it up
// automatically.

import * as compute from './computers.js';

export const METRICS = {
  // ── Org-scoped counts (read from appfolio_cache mirror) ──────────

  tenant_count: {
    key: 'tenant_count',
    scopeType: 'org',
    description:
      'Total / active / hidden tenant count for the whole portfolio.',
    dependsOn: ['tenants'],
    ttlSeconds: 60 * 60, // 1 hour
    compute: compute.tenantCount,
  },

  property_count: {
    key: 'property_count',
    scopeType: 'org',
    description:
      'Total / active / hidden property count for the whole portfolio.',
    dependsOn: ['properties'],
    ttlSeconds: 60 * 60,
    compute: compute.propertyCount,
  },

  unit_count: {
    key: 'unit_count',
    scopeType: 'org',
    description:
      'Total / active / hidden unit count + a status breakdown.',
    dependsOn: ['units'],
    ttlSeconds: 60 * 60,
    compute: compute.unitCount,
  },

  occupancy_pct: {
    key: 'occupancy_pct',
    scopeType: 'org',
    description:
      'Active tenants ÷ active units, as a percentage (0-100).',
    dependsOn: ['tenants', 'units', 'leases'],
    ttlSeconds: 15 * 60,
    compute: compute.occupancyPct,
  },

  vacant_unit_count: {
    key: 'vacant_unit_count',
    scopeType: 'org',
    description: 'Count of active units with no current occupancy.',
    dependsOn: ['units', 'tenants', 'leases'],
    ttlSeconds: 15 * 60,
    compute: compute.vacantUnitCount,
  },

  // ── Maintenance tickets ──────────────────────────────────────────

  open_maint_count: {
    key: 'open_maint_count',
    scopeType: 'org',
    description:
      'Count of open work orders (status not in Completed/Canceled).',
    dependsOn: ['work_orders'],
    ttlSeconds: 5 * 60,
    compute: compute.openMaintCount,
  },

  urgent_maint_count: {
    key: 'urgent_maint_count',
    scopeType: 'org',
    description:
      'Count of OPEN Urgent + Emergency-priority work orders. Does NOT include "High" priority — AppFolio defaults most work orders to High, so it would be meaningless. Use maint_by_priority for the full breakdown.',
    dependsOn: ['work_orders'],
    ttlSeconds: 5 * 60,
    compute: compute.urgentMaintCount,
  },

  maint_by_priority: {
    key: 'maint_by_priority',
    scopeType: 'org',
    description:
      'Open work-order counts grouped by priority (urgent, emergency, high, medium, low, unset). Returns an object.',
    dependsOn: ['work_orders'],
    ttlSeconds: 5 * 60,
    compute: compute.maintByPriority,
  },

  stale_maint_count: {
    key: 'stale_maint_count',
    scopeType: 'org',
    description:
      'Count of open work orders reported >30 days ago (no movement).',
    dependsOn: ['work_orders'],
    ttlSeconds: 60 * 60,
    compute: compute.staleMaintCount,
  },

  maint_by_category: {
    key: 'maint_by_category',
    scopeType: 'org',
    description:
      'Open work-order counts grouped by category (HVAC, plumbing, ' +
      'electrical, appliance, general, …). Returns an object.',
    dependsOn: ['work_orders'],
    ttlSeconds: 15 * 60,
    compute: compute.maintByCategory,
  },

  // ── Delinquency (computed from mirror tenant balance) ────────────

  delinquent_tenant_count: {
    key: 'delinquent_tenant_count',
    scopeType: 'org',
    description:
      'Count of tenants whose current balance is > 0 (owes money). NOTE: returns 0 today — AppFolio tenant balance is not in the standard /tenants payload; needs a /balances pipeline pass. See ADR 0006 deferred list.',
    dependsOn: ['tenants', 'charges'],
    ttlSeconds: 15 * 60,
    compute: compute.delinquentTenantCount,
  },

  total_delinquency_cents: {
    key: 'total_delinquency_cents',
    scopeType: 'org',
    description:
      'Sum of positive tenant balances across the portfolio, in cents. NOTE: returns 0 today — same balance-pipeline gap as delinquent_tenant_count.',
    dependsOn: ['tenants', 'charges'],
    ttlSeconds: 15 * 60,
    compute: compute.totalDelinquencyCents,
  },

  // ── Per-tenant (scope_id = AppFolio tenant id) ───────────────────

  tenant_balance_cents: {
    key: 'tenant_balance_cents',
    scopeType: 'tenant',
    description:
      'Current balance owed by a single tenant, in cents. ' +
      'Pass scope_id = AppFolio tenant id.',
    dependsOn: ['tenants', 'charges'],
    ttlSeconds: 15 * 60,
    compute: compute.tenantBalanceCents,
  },

  tenant_lease_summary: {
    key: 'tenant_lease_summary',
    scopeType: 'tenant',
    description:
      'Snapshot for one tenant: { name, unit_name, lease_start, ' +
      'lease_end, rent_cents, balance_cents }. Pass scope_id = ' +
      'AppFolio tenant id.',
    dependsOn: ['tenants', 'leases'],
    ttlSeconds: 60 * 60,
    compute: compute.tenantLeaseSummary,
  },
};

export const METRIC_KEYS = Object.keys(METRICS);

/**
 * Map a webhook topic → metric_keys it invalidates.
 * Built lazily from the dependsOn fields.
 */
let TOPIC_TO_KEYS = null;
export function metricsForTopic(topic) {
  if (!TOPIC_TO_KEYS) {
    TOPIC_TO_KEYS = new Map();
    for (const m of Object.values(METRICS)) {
      for (const t of m.dependsOn || []) {
        if (!TOPIC_TO_KEYS.has(t)) TOPIC_TO_KEYS.set(t, []);
        TOPIC_TO_KEYS.get(t).push(m.key);
      }
    }
  }
  return TOPIC_TO_KEYS.get(topic) || [];
}

/**
 * Resolve a metric_key to its registry entry. Returns null if unknown.
 */
export function getMetricDef(key) {
  return METRICS[key] || null;
}
