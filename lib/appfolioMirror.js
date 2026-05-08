// AppFolio mirror — write/read helpers backed by the appfolio_cache
// table. Keeps a local copy of every resource we expose on menu
// pages so reads don't have to round-trip through AppFolio's slow
// list endpoints (1-3s per call) on every cold start.
//
// Lifecycle:
//   - Initial bulk sync: api/admin/appfolio-sync.js POSTs to
//     bulkSyncAll(), which paginates each resource type from
//     AppFolio and upserts into the cache. ~30-60s for a typical
//     portfolio. Run once after deploying this PR; idempotent.
//   - Per-record refresh: lib/appfolioWebhook.js calls syncOne()
//     after verifying a webhook payload, fetching the new state
//     from AppFolio with filters[Id]= and upserting.
//   - Reconciliation cron (TBD): hourly job hits each resource's
//     /list?filters[LastUpdatedAtFrom]= to backfill webhook drops.
//
// All functions take an organizationId so the mirror is multi-org
// ready (matches the rest of our schema). The default org resolver
// in lib/adminHelpers.js gives callers the right id when there's
// no auth context (today: every caller).

import { and, eq, isNull, sql } from 'drizzle-orm';
import { getDb, schema } from './db/index.js';
import { fetchAllPages } from './backends/appfolio.js';
import { getDefaultOrgId } from './adminHelpers.js';

// Configuration per resource type:
//   appfolioEndpoint  — the AppFolio /api/v0 path
//   listTool          — corresponding tool name on the chat backend
//                       (used by the read-fallback path so the chat
//                       agent and menu pages return identical
//                       shapes)
//   responseField     — top-level array key the listTool returns
//   listInput         — input we pass when bulk-syncing (asks the
//                       backend tool for everything, no truncation)
//   mapAppfolioToCanonical — converts AppFolio's PascalCase row
//                       directly to our canonical camelCase shape
//                       (the same shape mapTenant / mapProperty
//                       etc. produce in lib/backends/appfolio.js).
//                       Used for single-record syncs that go
//                       directly to AppFolio with filters[Id]= and
//                       skip the chat backend's tool dispatcher.
//
// The mapping helpers below intentionally mirror what
// lib/backends/appfolio.js's existing list_X executors produce, so
// the mirror reads come out identical to the live executor's
// reads. Any time those executors change shape, update here too.

function mapAppfolioTenantRow(t) {
  if (!t) return null;
  return {
    id: t.Id || t.id,
    occupancy_id: t.OccupancyId || null,
    unit_id: t.UnitId || null,
    property_id: t.PropertyId || null,
    first_name: t.FirstName || '',
    last_name: t.LastName || '',
    name: [t.FirstName, t.LastName].filter(Boolean).join(' ') || 'Unknown',
    email: t.Email || '',
    phone: t.Phone || t.HomePhone || '',
    mobile: t.MobilePhone || t.CellPhone || '',
    status: t.Status || '',
    property_name: t.PropertyName || '',
    unit_name: t.UnitName || '',
    move_in_date: t.MoveInDate || null,
    move_out_date: t.MoveOutDate || null,
    lease_start: t.LeaseFrom || null,
    lease_end: t.LeaseTo || null,
    rent: t.Rent || t.MonthlyRent || null,
    balance: t.Balance || t.CurrentBalance || null,
    hidden: !!t.HiddenAt,
    last_updated_at: t.LastUpdatedAt || null,
  };
}

function mapAppfolioPropertyRow(p) {
  if (!p) return null;
  return {
    id: p.Id || p.id,
    address: [p.Address1, p.Address2].filter(Boolean).join(', '),
    city: p.City,
    state: p.State,
    postal_code: p.PostalCode,
    type: p.Type,
    name: p.Name || p.Address1,
    hidden: !!p.HiddenAt,
    last_updated_at: p.LastUpdatedAt || null,
  };
}

function mapAppfolioUnitRow(u) {
  if (!u) return null;
  return {
    id: u.Id || u.id,
    property_id: u.PropertyId || null,
    unit_group_id: u.UnitGroupId || null,
    current_occupancy_id: u.CurrentOccupancyId || null,
    name: u.Name || u.UnitNumber || u.Address1,
    property_name: u.PropertyName || '',
    address: [u.Address1, u.Address2].filter(Boolean).join(', '),
    city: u.City,
    state: u.State,
    bedrooms: u.Bedrooms,
    bathrooms: u.Bathrooms,
    sqft: u.SquareFeet || u.SquareFootage,
    market_rent: u.MarketRent,
    status: u.Status,
    non_revenue: !!u.NonRevenue,
    hidden: !!u.HiddenAt,
    last_updated_at: u.LastUpdatedAt || null,
  };
}

function mapAppfolioWorkOrderRow(w) {
  if (!w) return null;
  const assigned = Array.isArray(w.AssignedUsers) ? w.AssignedUsers : [];
  const assignedTo =
    assigned[0]?.Name ||
    [assigned[0]?.FirstName, assigned[0]?.LastName].filter(Boolean).join(' ') ||
    '';
  const status = w.Status || '';
  return {
    id: w.Id || w.id,
    displayId: w.WorkOrderNumber ? `WO-${w.WorkOrderNumber}` : (w.Id || ''),
    summary: w.JobDescription || w.WorkOrderIssue || w.Description || '',
    description: w.Description || w.TenantRemarks || '',
    isClosed: status === 'Completed' || status === 'Work Completed' || status === 'Canceled',
    status,
    priority: w.Priority || '',
    categoryName: w.VendorTrade || '',
    propertyId: w.PropertyId || null,
    unitId: w.UnitId || null,
    tenantId: w.RequestingTenantId || null,
    occupancyId: w.OccupancyId || null,
    vendorId: w.VendorId || null,
    createdDate: w.CreatedAt || null,
    scheduledDate: w.ScheduledStart || null,
    completedDate: w.WorkCompletedOn || w.CompletedOn || null,
    assignedTo,
    link: w.Link || null,
    last_updated_at: w.LastUpdatedAt || null,
  };
}

const TYPE_CONFIG = {
  tenant: {
    appfolioEndpoint: '/tenants',
    listTool: 'list_tenants',
    responseField: 'tenants',
    listInput: { limit: 5000, active_only: false },
    mapAppfolioToCanonical: mapAppfolioTenantRow,
    extractIndex: (row) => ({
      propertyId: row.property_id || null,
      unitId: row.unit_id || null,
      occupancyId: row.occupancy_id || null,
      status: row.status || null,
      hiddenAt: row.hidden ? new Date() : null,
    }),
  },
  property: {
    appfolioEndpoint: '/properties',
    listTool: 'list_properties',
    responseField: 'properties',
    listInput: { limit: 5000, include_hidden: true },
    mapAppfolioToCanonical: mapAppfolioPropertyRow,
    extractIndex: (row) => ({
      propertyId: row.id || null,
      unitId: null,
      occupancyId: null,
      status: row.type || null,
      hiddenAt: row.hidden ? new Date() : null,
    }),
  },
  unit: {
    appfolioEndpoint: '/units',
    listTool: 'list_units',
    responseField: 'units',
    listInput: { limit: 5000, include_hidden: true },
    mapAppfolioToCanonical: mapAppfolioUnitRow,
    extractIndex: (row) => ({
      propertyId: row.property_id || null,
      unitId: row.id || null,
      occupancyId: row.current_occupancy_id || null,
      status: row.status || null,
      hiddenAt: row.hidden ? new Date() : null,
    }),
  },
  work_order: {
    appfolioEndpoint: '/work_orders',
    listTool: 'list_work_orders',
    responseField: 'work_orders',
    listInput: { status: 'all', limit: 10000 },
    mapAppfolioToCanonical: mapAppfolioWorkOrderRow,
    extractIndex: (row) => ({
      propertyId: row.propertyId || null,
      unitId: row.unitId || null,
      occupancyId: row.occupancyId || null,
      status: row.status || null,
      hiddenAt: null,
    }),
  },
};

export const MIRRORED_RESOURCE_TYPES = Object.keys(TYPE_CONFIG);

export function isMirrored(resourceType) {
  return Object.prototype.hasOwnProperty.call(TYPE_CONFIG, resourceType);
}

// ── Upsert ──────────────────────────────────────────────────────

async function upsertOne(organizationId, resourceType, canonicalRow) {
  const cfg = TYPE_CONFIG[resourceType];
  if (!cfg) throw new Error(`Unknown resource type: ${resourceType}`);
  if (!canonicalRow?.id) return; // nothing to key on; skip silently

  const idx = cfg.extractIndex(canonicalRow);
  const db = getDb();
  const now = new Date();
  const appfolioUpdatedAt = canonicalRow.last_updated_at
    ? new Date(canonicalRow.last_updated_at)
    : null;

  await db
    .insert(schema.appfolioCache)
    .values({
      organizationId,
      resourceType,
      resourceId: String(canonicalRow.id),
      propertyId: idx.propertyId,
      unitId: idx.unitId,
      occupancyId: idx.occupancyId,
      status: idx.status,
      hiddenAt: idx.hiddenAt,
      data: canonicalRow,
      appfolioUpdatedAt,
      syncedAt: now,
    })
    .onConflictDoUpdate({
      target: [
        schema.appfolioCache.organizationId,
        schema.appfolioCache.resourceType,
        schema.appfolioCache.resourceId,
      ],
      set: {
        propertyId: idx.propertyId,
        unitId: idx.unitId,
        occupancyId: idx.occupancyId,
        status: idx.status,
        hiddenAt: idx.hiddenAt,
        data: canonicalRow,
        appfolioUpdatedAt,
        syncedAt: now,
      },
    });
}

async function bulkUpsertList(organizationId, resourceType, rows) {
  let inserted = 0;
  for (const row of rows || []) {
    if (!row?.id) continue;
    try {
      await upsertOne(organizationId, resourceType, row);
      inserted += 1;
    } catch (err) {
      console.warn(`[mirror] upsert ${resourceType}/${row.id} failed:`, err?.message || err);
    }
  }
  return inserted;
}

// ── Sync from AppFolio ──────────────────────────────────────────

// Bulk-sync one resource type. Calls into the AppFolio chat
// backend's executeTool (for the canonical mapper) and upserts.
async function syncTypeFromAppfolio(organizationId, resourceType) {
  const cfg = TYPE_CONFIG[resourceType];
  if (!cfg) throw new Error(`Unknown resource type: ${resourceType}`);

  const { getChatBackend } = await import('./backends/index.js');
  const backend = getChatBackend('appfolio');

  const result = await backend.executeTool(cfg.listTool, cfg.listInput);
  if (result?.error) {
    return { error: result.error };
  }
  const rows = result?.[cfg.responseField] || [];
  const upserted = await bulkUpsertList(organizationId, resourceType, rows);
  return { fetched: rows.length, upserted };
}

// One-shot sync of every supported type. ~30-60s for typical
// portfolios — initial bootstrap only. Webhooks keep things current
// after that.
export async function bulkSyncAll(organizationId) {
  const results = {};
  for (const type of MIRRORED_RESOURCE_TYPES) {
    try {
      const start = Date.now();
      const r = await syncTypeFromAppfolio(organizationId, type);
      results[type] = { ...r, ms: Date.now() - start };
    } catch (err) {
      results[type] = { error: err?.message || String(err) };
    }
  }
  return results;
}

// Refresh a single record by AppFolio ID. Called by the webhook
// receiver after verifying X-JWS-Signature. Hits AppFolio's
// /resource?filters[Id]=<id> path directly via the exported
// fetchAllPages so we don't go through the chat-tool layer (which
// doesn't expose filter-by-id as input).
export async function syncOneFromAppfolio(organizationId, resourceType, resourceId) {
  const cfg = TYPE_CONFIG[resourceType];
  if (!cfg) return { skipped: true, reason: 'unknown_type' };
  if (!resourceId) return { skipped: true, reason: 'missing_id' };

  const result = await fetchAllPages(cfg.appfolioEndpoint, {
    'filters[Id]': resourceId,
  }, { maxPages: 1 });

  if (result?.error) return { error: result.error };
  const rows = result?.data || [];

  if (rows.length === 0) {
    // No row returned — likely deleted in AppFolio. Mirror it as
    // gone by removing the cached row.
    const db = getDb();
    await db.delete(schema.appfolioCache).where(
      and(
        eq(schema.appfolioCache.organizationId, organizationId),
        eq(schema.appfolioCache.resourceType, resourceType),
        eq(schema.appfolioCache.resourceId, String(resourceId)),
      ),
    );
    return { deleted: true };
  }

  const canonical = cfg.mapAppfolioToCanonical(rows[0]);
  await upsertOne(organizationId, resourceType, canonical);
  return { upserted: true };
}

// Webhook topic ('tenants', 'properties', etc.) → mirror resource
// type ('tenant', 'property', etc.). Webhook receiver passes the
// topic; mirror sync needs the singular type name.
const TOPIC_TO_TYPE = {
  tenants: 'tenant',
  properties: 'property',
  units: 'unit',
  work_orders: 'work_order',
};
export function topicToResourceType(topic) {
  return TOPIC_TO_TYPE[topic] || null;
}

// ── Read from mirror ────────────────────────────────────────────
//
// readListFromMirror returns the same response shape as the
// equivalent backend list tool, so /api/data can swap mirror for
// live without the consumer noticing.

export async function readListFromMirror(
  organizationId,
  resourceType,
  { limit = 5000, offset = 0, filters = {}, activeOnly = true } = {},
) {
  const cfg = TYPE_CONFIG[resourceType];
  if (!cfg) return null;

  const db = getDb();
  const conditions = [
    eq(schema.appfolioCache.organizationId, organizationId),
    eq(schema.appfolioCache.resourceType, resourceType),
  ];
  if (filters.propertyId) {
    conditions.push(eq(schema.appfolioCache.propertyId, filters.propertyId));
  }
  if (filters.unitId) {
    conditions.push(eq(schema.appfolioCache.unitId, filters.unitId));
  }
  if (filters.occupancyId) {
    conditions.push(eq(schema.appfolioCache.occupancyId, filters.occupancyId));
  }
  // Default: hide records AppFolio has flagged HiddenAt. The bulk
  // sync stores them anyway (so chat queries that explicitly look
  // for old / inactive records still work), but menu pages should
  // never see them unless the caller opts in.
  if (activeOnly) {
    conditions.push(isNull(schema.appfolioCache.hiddenAt));
  }

  const cap = Math.max(1, Math.min(Number(limit) || 5000, 5000));
  const skip = Math.max(0, Number(offset) || 0);

  // Pull cap+1 so we can compute has_more without a separate count.
  const rows = await db
    .select({ data: schema.appfolioCache.data })
    .from(schema.appfolioCache)
    .where(and(...conditions))
    .limit(cap + 1)
    .offset(skip);

  const records = rows.slice(0, cap).map((r) => r.data);
  const hasMore = rows.length > cap;

  return {
    [cfg.responseField]: records,
    total: records.length + (hasMore ? 1 : 0), // approximate; honest for paging
    offset: skip,
    limit: cap,
    has_more: hasMore,
    from_mirror: true,
  };
}

// Read a single canonical row from the mirror by id. Returns the
// stored data jsonb (canonical camelCase shape), or null if not
// present. Used by the webhook receiver to capture "before" state
// before it overwrites the cache, so payment-detection / status-
// change matchers in lib/categorySubscriptions can compare prior
// vs current.
export async function readOneFromMirror(organizationId, resourceType, resourceId) {
  const db = getDb();
  const rows = await db
    .select({ data: schema.appfolioCache.data })
    .from(schema.appfolioCache)
    .where(
      and(
        eq(schema.appfolioCache.organizationId, organizationId),
        eq(schema.appfolioCache.resourceType, resourceType),
        eq(schema.appfolioCache.resourceId, String(resourceId)),
      ),
    )
    .limit(1);
  return rows[0]?.data || null;
}

// ── Mirror availability check ───────────────────────────────────

export async function mirrorHasData(organizationId, resourceType) {
  const db = getDb();
  const rows = await db
    .select({ c: sql`count(*)::int` })
    .from(schema.appfolioCache)
    .where(
      and(
        eq(schema.appfolioCache.organizationId, organizationId),
        eq(schema.appfolioCache.resourceType, resourceType),
      ),
    )
    .limit(1);
  return Number(rows[0]?.c || 0) > 0;
}

export async function mirrorStats(organizationId) {
  const db = getDb();
  const rows = await db
    .select({
      type: schema.appfolioCache.resourceType,
      c: sql`count(*)::int`,
      latest: sql`max(${schema.appfolioCache.syncedAt})`,
    })
    .from(schema.appfolioCache)
    .where(eq(schema.appfolioCache.organizationId, organizationId))
    .groupBy(schema.appfolioCache.resourceType);
  return rows.map((r) => ({
    resource_type: r.type,
    count: Number(r.c),
    latest_sync: r.latest,
  }));
}

// ── Reconciliation ──────────────────────────────────────────────
//
// AppFolio's docs explicitly do NOT promise exactly-once webhook
// delivery — "in rare cases, webhooks can be delivered multiple
// times" and (implied) sometimes not at all. Reconciliation runs on
// a cron and asks AppFolio for everything modified since our last
// successful sync per resource type, then upserts. Catches drops
// without paying the cost of full bulk syncs.
//
// "Last sync time" per type is derived from max(synced_at) on
// existing cache rows. First reconcile after deploy walks back to
// 1970 (== full sync) and that's fine — it's idempotent.

export async function lastSyncedAtForType(organizationId, resourceType) {
  const db = getDb();
  const rows = await db
    .select({ t: sql`max(${schema.appfolioCache.syncedAt})` })
    .from(schema.appfolioCache)
    .where(
      and(
        eq(schema.appfolioCache.organizationId, organizationId),
        eq(schema.appfolioCache.resourceType, resourceType),
      ),
    )
    .limit(1);
  return rows[0]?.t || null;
}

// Reconcile one resource type by fetching everything AppFolio has
// updated since `since` and upserting. Returns counts.
async function reconcileType(organizationId, resourceType, since) {
  const cfg = TYPE_CONFIG[resourceType];
  if (!cfg) return { skipped: true, reason: 'unknown_type' };

  // AppFolio's filters[LastUpdatedAtFrom] expects ISO 8601 UTC. If
  // we have no prior sync we walk back far enough to get
  // everything on first run; the cap on fetchAllPages keeps it
  // bounded.
  const sinceIso = since
    ? new Date(since).toISOString()
    : '1970-01-01T00:00:00Z';

  const result = await fetchAllPages(cfg.appfolioEndpoint, {
    'filters[LastUpdatedAtFrom]': sinceIso,
  });
  if (result?.error) return { error: result.error, since: sinceIso };

  const rows = result?.data || [];
  let upserted = 0;
  for (const raw of rows) {
    try {
      const canonical = cfg.mapAppfolioToCanonical(raw);
      if (!canonical) continue;
      await upsertOne(organizationId, resourceType, canonical);
      upserted += 1;
    } catch (err) {
      console.warn(
        `[mirror reconcile] upsert ${resourceType}/${raw?.Id} failed:`,
        err?.message || err,
      );
    }
  }
  return { fetched: rows.length, upserted, since: sinceIso };
}

// Reconcile every mirrored type. The cron handler calls this.
export async function reconcileAll(organizationId) {
  const results = {};
  for (const type of MIRRORED_RESOURCE_TYPES) {
    try {
      const since = await lastSyncedAtForType(organizationId, type);
      const start = Date.now();
      const r = await reconcileType(organizationId, type, since);
      results[type] = { ...r, ms: Date.now() - start };
    } catch (err) {
      results[type] = { error: err?.message || String(err) };
    }
  }
  return results;
}

// Convenience: load default org id once for callers that don't
// already have one. Wraps adminHelpers' resolver.
export async function getDefaultOrgIdForMirror() {
  return getDefaultOrgId();
}
