// chat_metrics computers — the SQL queries that turn mirror rows
// into pre-aggregated answers.
//
// Every exported function takes (db, orgId, scopeId?) and returns
// a JSON-serialisable value of the metric's shape.
//
// All metrics in v1 read from `appfolio_cache` (the AppFolio mirror
// table). Switching a metric to a Breeze-native source later means
// changing only the function here — the registry, reader, and chat
// surface don't need to know.

import { and, eq, isNull, sql } from 'drizzle-orm';
import { schema } from '../db/index.js';

// ── Helpers ──────────────────────────────────────────────────────

const ACTIVE_TENANT_STATUSES = ['Past', 'Current']; // anything that's a real tenant
// Closed AppFolio work-order statuses — kept here so the open/closed
// split is consistent across metrics.
const CLOSED_WO_STATUSES = ['Completed', 'Work Completed', 'Canceled'];

// Convert AppFolio's balance strings (e.g. "1234.50", "$1,234.50") to
// integer cents. Returns 0 for empty / unparseable input.
function balanceToCents(raw) {
  if (raw == null) return 0;
  const s = String(raw).replace(/[$,\s]/g, '');
  const n = Number.parseFloat(s);
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 100);
}

// Categorise a work_order by VendorTrade / category text into a
// stable set of buckets. AppFolio's VendorTrade is free-form so we
// pattern-match. Unknowns fall into 'other'.
function categorise(rawCategory) {
  const c = (rawCategory || '').toLowerCase();
  if (!c) return 'uncategorized';
  if (/hvac|heat|cool|air condition|furnace|ac\b/.test(c)) return 'hvac';
  if (/plumb|leak|drain|toilet|sink|faucet|water/.test(c)) return 'plumbing';
  if (/electric|wire|outlet|circuit|breaker|light/.test(c)) return 'electrical';
  if (/appliance|fridge|stove|oven|dishwasher|washer|dryer|microwave/.test(c)) return 'appliance';
  if (/pest|bug|rodent|mouse|roach|ant\b/.test(c)) return 'pest';
  if (/roof|gutter|siding|window|door|fence/.test(c)) return 'exterior';
  if (/clean|paint|cosmetic|trash/.test(c)) return 'cosmetic';
  if (/lock|security|key|alarm/.test(c)) return 'security';
  return 'general';
}

// ── Org-scoped counts ────────────────────────────────────────────

export async function tenantCount(db, orgId) {
  const rows = await db
    .select({
      total: sql`COUNT(*)::int`.as('total'),
      hidden: sql`SUM(CASE WHEN ${schema.appfolioCache.hiddenAt} IS NOT NULL THEN 1 ELSE 0 END)::int`.as('hidden'),
    })
    .from(schema.appfolioCache)
    .where(
      and(
        eq(schema.appfolioCache.organizationId, orgId),
        eq(schema.appfolioCache.resourceType, 'tenant'),
      ),
    );
  const r = rows[0] || { total: 0, hidden: 0 };
  return {
    total: r.total || 0,
    active: (r.total || 0) - (r.hidden || 0),
    hidden: r.hidden || 0,
  };
}

export async function propertyCount(db, orgId) {
  const rows = await db
    .select({
      total: sql`COUNT(*)::int`.as('total'),
      hidden: sql`SUM(CASE WHEN ${schema.appfolioCache.hiddenAt} IS NOT NULL THEN 1 ELSE 0 END)::int`.as('hidden'),
    })
    .from(schema.appfolioCache)
    .where(
      and(
        eq(schema.appfolioCache.organizationId, orgId),
        eq(schema.appfolioCache.resourceType, 'property'),
      ),
    );
  const r = rows[0] || { total: 0, hidden: 0 };
  return {
    total: r.total || 0,
    active: (r.total || 0) - (r.hidden || 0),
    hidden: r.hidden || 0,
  };
}

export async function unitCount(db, orgId) {
  const rows = await db
    .select({
      status: schema.appfolioCache.status,
      hiddenAt: schema.appfolioCache.hiddenAt,
      // NonRevenue is in data — count it for filtering out non-rentable units.
      nonRevenue: sql`(${schema.appfolioCache.data}->>'non_revenue')::boolean`.as('non_revenue'),
      n: sql`COUNT(*)::int`.as('n'),
    })
    .from(schema.appfolioCache)
    .where(
      and(
        eq(schema.appfolioCache.organizationId, orgId),
        eq(schema.appfolioCache.resourceType, 'unit'),
      ),
    )
    .groupBy(
      schema.appfolioCache.status,
      schema.appfolioCache.hiddenAt,
      sql`(${schema.appfolioCache.data}->>'non_revenue')::boolean`,
    );

  let total = 0;
  let hidden = 0;
  let nonRevenue = 0;
  const byStatus = {};
  for (const r of rows) {
    const n = r.n || 0;
    total += n;
    if (r.hiddenAt) hidden += n;
    if (r.nonRevenue) nonRevenue += n;
    const s = (r.status || 'unknown').toString().toLowerCase();
    byStatus[s] = (byStatus[s] || 0) + n;
  }
  return {
    total,
    active: total - hidden,
    hidden,
    non_revenue: nonRevenue,
    by_status: byStatus,
  };
}

// Count rentable units = AppFolio mirror unit rows where the unit isn't
// hidden and isn't marked NonRevenue. This is the authoritative
// "denominator" for occupancy questions — schema.units (642) still
// includes non-revenue rows we want to exclude.
async function rentableUnitCount(db, orgId) {
  const rows = await db
    .select({ n: sql`COUNT(*)::int`.as('n') })
    .from(schema.appfolioCache)
    .where(
      and(
        eq(schema.appfolioCache.organizationId, orgId),
        eq(schema.appfolioCache.resourceType, 'unit'),
        isNull(schema.appfolioCache.hiddenAt),
        sql`COALESCE((${schema.appfolioCache.data}->>'non_revenue')::boolean, false) = false`,
      ),
    );
  return rows[0]?.n || 0;
}

// Count active tenancies = schema.leases.status='active'. One row per
// lease, so this counts UNIQUE leasing parties (not tenant records,
// which double-count co-signers / spouses / past renters).
async function activeTenancyCount(db, orgId) {
  const rows = await db
    .select({ n: sql`COUNT(*)::int`.as('n') })
    .from(schema.leases)
    .where(
      and(
        eq(schema.leases.organizationId, orgId),
        eq(schema.leases.status, 'active'),
      ),
    );
  return rows[0]?.n || 0;
}

export async function occupancyPct(db, orgId) {
  // Numerator: count of active leases (= active tenancies, the real
  // "how many tenants are renting from us right now" number).
  // Denominator: rentable units (excludes hidden + NonRevenue).
  // See ADR 0006's "Question reframing" section.
  const tenancies = await activeTenancyCount(db, orgId);
  const rentable = await rentableUnitCount(db, orgId);
  if (rentable === 0) {
    return { pct: 0, active_tenancies: tenancies, rentable_units: 0 };
  }
  const pct = Math.round((tenancies / rentable) * 1000) / 10;
  return {
    pct,
    active_tenancies: tenancies,
    rentable_units: rentable,
  };
}

export async function vacantUnitCount(db, orgId) {
  // Vacant = rentable units - active tenancies. Same definitional
  // anchor as occupancy_pct so the numbers can't disagree.
  const tenancies = await activeTenancyCount(db, orgId);
  const rentable = await rentableUnitCount(db, orgId);
  return {
    count: Math.max(0, rentable - tenancies),
    rentable_units: rentable,
    occupied_units: tenancies,
  };
}

// ── Maintenance ──────────────────────────────────────────────────

export async function openMaintCount(db, orgId) {
  const rows = await db
    .select({ n: sql`COUNT(*)::int`.as('n') })
    .from(schema.appfolioCache)
    .where(
      and(
        eq(schema.appfolioCache.organizationId, orgId),
        eq(schema.appfolioCache.resourceType, 'work_order'),
        sql`${schema.appfolioCache.status} IS NULL
          OR ${schema.appfolioCache.status} NOT IN (${sql.join(CLOSED_WO_STATUSES.map((s) => sql`${s}`), sql`, `)})`,
      ),
    );
  return { count: rows[0]?.n || 0 };
}

export async function urgentMaintCount(db, orgId) {
  // "Urgent" = AppFolio Priority='Urgent' or 'Emergency' ONLY. Most
  // AppFolio installs default work-order priority to 'High', which
  // makes 'high' a meaningless filter. Excluded by design — if the
  // user wants a high-priority count, they can ask for the
  // maint_by_priority breakdown.
  const rows = await db
    .select({ n: sql`COUNT(*)::int`.as('n') })
    .from(schema.appfolioCache)
    .where(
      and(
        eq(schema.appfolioCache.organizationId, orgId),
        eq(schema.appfolioCache.resourceType, 'work_order'),
        sql`LOWER(COALESCE(${schema.appfolioCache.data}->>'priority', '')) IN ('urgent', 'emergency')`,
        sql`${schema.appfolioCache.status} IS NULL
          OR ${schema.appfolioCache.status} NOT IN (${sql.join(CLOSED_WO_STATUSES.map((s) => sql`${s}`), sql`, `)})`,
      ),
    );
  return { count: rows[0]?.n || 0 };
}

export async function maintByPriority(db, orgId) {
  // Full breakdown of open work orders by priority. Lets chat answer
  // "how many high-priority tickets?" without conflating with urgent.
  const rows = await db
    .select({
      priority: sql`COALESCE(${schema.appfolioCache.data}->>'priority', '')`.as('priority'),
      n: sql`COUNT(*)::int`.as('n'),
    })
    .from(schema.appfolioCache)
    .where(
      and(
        eq(schema.appfolioCache.organizationId, orgId),
        eq(schema.appfolioCache.resourceType, 'work_order'),
        sql`${schema.appfolioCache.status} IS NULL
          OR ${schema.appfolioCache.status} NOT IN (${sql.join(CLOSED_WO_STATUSES.map((s) => sql`${s}`), sql`, `)})`,
      ),
    )
    .groupBy(sql`COALESCE(${schema.appfolioCache.data}->>'priority', '')`);

  const buckets = {};
  for (const r of rows) {
    const key = (r.priority || 'unset').toString().toLowerCase();
    buckets[key] = (buckets[key] || 0) + (r.n || 0);
  }
  return { by_priority: buckets };
}

export async function staleMaintCount(db, orgId) {
  // "Stale" = open AND reported >30 days ago. createdDate in the
  // mirror is the AppFolio CreatedAt timestamp (text — cast to date).
  const rows = await db
    .select({ n: sql`COUNT(*)::int`.as('n') })
    .from(schema.appfolioCache)
    .where(
      and(
        eq(schema.appfolioCache.organizationId, orgId),
        eq(schema.appfolioCache.resourceType, 'work_order'),
        sql`${schema.appfolioCache.status} IS NULL
          OR ${schema.appfolioCache.status} NOT IN (${sql.join(CLOSED_WO_STATUSES.map((s) => sql`${s}`), sql`, `)})`,
        sql`(${schema.appfolioCache.data}->>'createdDate')::timestamptz < (NOW() - INTERVAL '30 days')`,
      ),
    );
  return { count: rows[0]?.n || 0, threshold_days: 30 };
}

export async function maintByCategory(db, orgId) {
  // AppFolio's VendorTrade (mirror's `categoryName`) is sparse —
  // most rows are empty. Fall back to the work-order summary text
  // so we catch HVAC tickets that have no VendorTrade set. We pull
  // both fields and let JS pick the best signal.
  const rows = await db
    .select({
      category: sql`${schema.appfolioCache.data}->>'categoryName'`.as('category'),
      summary: sql`${schema.appfolioCache.data}->>'summary'`.as('summary'),
    })
    .from(schema.appfolioCache)
    .where(
      and(
        eq(schema.appfolioCache.organizationId, orgId),
        eq(schema.appfolioCache.resourceType, 'work_order'),
        sql`${schema.appfolioCache.status} IS NULL
          OR ${schema.appfolioCache.status} NOT IN (${sql.join(CLOSED_WO_STATUSES.map((s) => sql`${s}`), sql`, `)})`,
      ),
    );

  const buckets = {};
  for (const r of rows) {
    // Prefer the explicit category; fall back to scanning the summary
    // text so we don't lose the long tail of un-categorised rows.
    let b = categorise(r.category);
    if (b === 'uncategorized' || b === 'general') {
      const sb = categorise(r.summary);
      // Only override if summary actually classifies into something
      // specific (not uncategorized/general). Otherwise keep general.
      if (sb !== 'uncategorized' && sb !== 'general') b = sb;
      else if (b === 'uncategorized') b = sb; // pull general from summary
    }
    buckets[b] = (buckets[b] || 0) + 1;
  }
  return { by_category: buckets };
}

// ── Delinquency ──────────────────────────────────────────────────

export async function delinquentTenantCount(db, orgId) {
  const rows = await db
    .select({
      balance: sql`${schema.appfolioCache.data}->>'balance'`.as('balance'),
    })
    .from(schema.appfolioCache)
    .where(
      and(
        eq(schema.appfolioCache.organizationId, orgId),
        eq(schema.appfolioCache.resourceType, 'tenant'),
        isNull(schema.appfolioCache.hiddenAt),
      ),
    );

  let count = 0;
  for (const r of rows) {
    if (balanceToCents(r.balance) > 0) count += 1;
  }
  return { count };
}

export async function totalDelinquencyCents(db, orgId) {
  const rows = await db
    .select({
      balance: sql`${schema.appfolioCache.data}->>'balance'`.as('balance'),
    })
    .from(schema.appfolioCache)
    .where(
      and(
        eq(schema.appfolioCache.organizationId, orgId),
        eq(schema.appfolioCache.resourceType, 'tenant'),
        isNull(schema.appfolioCache.hiddenAt),
      ),
    );

  let totalCents = 0;
  for (const r of rows) {
    const c = balanceToCents(r.balance);
    if (c > 0) totalCents += c;
  }
  return { total_cents: totalCents, total_dollars: totalCents / 100 };
}

// ── Per-tenant ───────────────────────────────────────────────────

export async function tenantBalanceCents(db, orgId, scopeId) {
  if (!scopeId) return { error: 'scope_id (tenant id) required' };
  const rows = await db
    .select({
      balance: sql`${schema.appfolioCache.data}->>'balance'`.as('balance'),
      name: sql`${schema.appfolioCache.data}->>'name'`.as('name'),
    })
    .from(schema.appfolioCache)
    .where(
      and(
        eq(schema.appfolioCache.organizationId, orgId),
        eq(schema.appfolioCache.resourceType, 'tenant'),
        eq(schema.appfolioCache.resourceId, String(scopeId)),
      ),
    )
    .limit(1);
  const r = rows[0];
  if (!r) return { error: 'tenant not found in mirror', tenant_id: scopeId };
  return {
    tenant_id: scopeId,
    tenant_name: r.name || null,
    balance_cents: balanceToCents(r.balance),
  };
}

export async function tenantLeaseSummary(db, orgId, scopeId) {
  if (!scopeId) return { error: 'scope_id (tenant id) required' };
  const rows = await db
    .select({ data: schema.appfolioCache.data })
    .from(schema.appfolioCache)
    .where(
      and(
        eq(schema.appfolioCache.organizationId, orgId),
        eq(schema.appfolioCache.resourceType, 'tenant'),
        eq(schema.appfolioCache.resourceId, String(scopeId)),
      ),
    )
    .limit(1);
  const d = rows[0]?.data;
  if (!d) return { error: 'tenant not found in mirror', tenant_id: scopeId };
  return {
    tenant_id: scopeId,
    tenant_name: d.name || null,
    property_name: d.property_name || null,
    unit_name: d.unit_name || null,
    lease_start: d.lease_start || null,
    lease_end: d.lease_end || null,
    move_in_date: d.move_in_date || null,
    move_out_date: d.move_out_date || null,
    rent_cents: balanceToCents(d.rent),
    balance_cents: balanceToCents(d.balance),
    status: d.status || null,
  };
}
