// POST /api/admin/sync-appfolio-tickets?secret=<TOKEN>
// body: {
//   status?: 'open' | 'completed' | 'canceled' | 'all'   default 'all'
//   limit?:  integer    AppFolio rows per call (default 1000, max 10000)
//   offset?: integer    pagination cursor on AppFolio's side
// }
//
// Pulls AppFolio work orders, maps them to our maintenance_tickets
// schema, and upserts via source_ticket_id (idempotent). Resolves
// foreign keys (property / unit / vendor) by looking up our DB
// rows via source_property_id / source_unit_id / source_vendor_id.
//
// AppFolio status flow → our enum:
//   New                       → 'new'
//   Assigned / Scheduled      → 'assigned'
//   Waiting / Estimate*       → 'awaiting_parts'
//   Completed / Work Completed→ 'completed'
//   Canceled                  → 'cancelled'

import { and, eq, isNotNull } from 'drizzle-orm';
import {
  withAdminHandler,
  getDefaultOrgId,
  parseBody,
} from '../../lib/adminHelpers.js';
import { getDb, schema } from '../../lib/db/index.js';
import { fetchAllPages } from '../../lib/backends/appfolio.js';
import { recordHealth } from '../../lib/integrationHealth.js';

export const config = { maxDuration: 300 };

function isAppfolioConfigured() {
  return Boolean(
    process.env.APPFOLIO_CLIENT_ID &&
      process.env.APPFOLIO_CLIENT_SECRET &&
      process.env.APPFOLIO_DEVELOPER_ID,
  );
}

function mapStatus(appfolioStatus) {
  const s = (appfolioStatus || '').toLowerCase();
  if (s === 'completed' || s === 'work completed') return 'completed';
  if (s === 'canceled' || s === 'cancelled') return 'cancelled';
  if (s === 'new') return 'new';
  if (s === 'assigned' || s === 'scheduled') return 'assigned';
  if (s === 'in progress') return 'in_progress';
  if (s === 'waiting' || s === 'estimate requested' || s === 'estimated') {
    return 'awaiting_parts';
  }
  return 'new';
}

function mapPriority(appfolioPriority) {
  const p = (appfolioPriority || '').toLowerCase();
  if (p === 'urgent' || p === 'emergency') return 'emergency';
  if (p === 'high') return 'high';
  if (p === 'low') return 'low';
  return 'medium';
}

export default withAdminHandler(async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'POST only' });
  }
  if (!isAppfolioConfigured()) {
    return res.status(503).json({
      ok: false,
      error: 'AppFolio not configured (APPFOLIO_CLIENT_ID / APPFOLIO_CLIENT_SECRET / APPFOLIO_DEVELOPER_ID).',
    });
  }

  const body = parseBody(req);
  const statusFilterRaw = (body.status || 'all').toString().toLowerCase();

  const db = getDb();
  const organizationId = await getDefaultOrgId();

  // ── 1. Pull from AppFolio ─────────────────────────────────────
  const params = {};
  if (statusFilterRaw === 'completed') {
    params['filters[Status]'] = 'Completed,Work Completed';
  } else if (statusFilterRaw === 'canceled') {
    params['filters[Status]'] = 'Canceled';
  } else if (statusFilterRaw === 'open') {
    params['filters[Status]'] =
      'New,Assigned,Scheduled,Waiting,Estimate Requested,Estimated';
  } // else 'all' — no filter

  let afRows;
  const startedAt = Date.now();
  try {
    const result = await fetchAllPages('/work_orders', params);
    if (result.error) {
      await recordHealth(organizationId, 'appfolio_database', 'AppFolio (Database API)', { ok: false, error: result.error });
      return res.status(502).json({ ok: false, error: `AppFolio: ${result.error}` });
    }
    afRows = result.data || [];
    await recordHealth(organizationId, 'appfolio_database', 'AppFolio (Database API)', { ok: true });
  } catch (err) {
    await recordHealth(organizationId, 'appfolio_database', 'AppFolio (Database API)', { ok: false, error: err.message || String(err) });
    return res.status(502).json({
      ok: false,
      error: `AppFolio fetch failed: ${err.message || String(err)}`,
    });
  }
  const fetchMs = Date.now() - startedAt;

  if (afRows.length === 0) {
    return res.status(200).json({
      ok: true,
      organization_id: organizationId,
      fetched: 0,
      fetch_ms: fetchMs,
      message: 'AppFolio returned 0 work orders for that filter.',
    });
  }

  // ── 2. Build foreign-key lookup maps ──────────────────────────
  const propRows = await db
    .select({
      id: schema.properties.id,
      sourcePropertyId: schema.properties.sourcePropertyId,
    })
    .from(schema.properties)
    .where(
      and(
        eq(schema.properties.organizationId, organizationId),
        isNotNull(schema.properties.sourcePropertyId),
      ),
    );
  const propertyIdBySource = new Map(
    propRows.map((p) => [String(p.sourcePropertyId), p.id]),
  );

  const unitRows = await db
    .select({
      id: schema.units.id,
      sourceUnitId: schema.units.sourceUnitId,
    })
    .from(schema.units)
    .where(
      and(
        eq(schema.units.organizationId, organizationId),
        isNotNull(schema.units.sourceUnitId),
      ),
    );
  const unitIdBySource = new Map(
    unitRows.map((u) => [String(u.sourceUnitId), u.id]),
  );

  const vendorRows = await db
    .select({
      id: schema.vendors.id,
      sourceVendorId: schema.vendors.sourceVendorId,
    })
    .from(schema.vendors)
    .where(
      and(
        eq(schema.vendors.organizationId, organizationId),
        isNotNull(schema.vendors.sourceVendorId),
      ),
    );
  const vendorIdBySource = new Map(
    vendorRows.map((v) => [String(v.sourceVendorId), v.id]),
  );

  // ── 3. Upsert tickets ─────────────────────────────────────────
  let inserted = 0;
  let updated = 0;
  let skippedNoProperty = 0;
  const skippedExamples = [];

  for (const w of afRows) {
    const sourceTicketId = String(w.Id || w.id || '');
    if (!sourceTicketId) continue;

    const afPropertyId = w.PropertyId != null ? String(w.PropertyId) : null;
    const propertyId = afPropertyId ? propertyIdBySource.get(afPropertyId) || null : null;

    if (!propertyId) {
      skippedNoProperty += 1;
      if (skippedExamples.length < 5) {
        skippedExamples.push({
          source_ticket_id: sourceTicketId,
          appfolio_property_id: afPropertyId,
          summary: w.JobDescription || w.Description || null,
        });
      }
      continue;
    }

    const afUnitId = w.UnitId != null ? String(w.UnitId) : null;
    const unitId = afUnitId ? unitIdBySource.get(afUnitId) || null : null;

    const afVendorId = w.VendorId != null ? String(w.VendorId) : null;
    const vendorId = afVendorId ? vendorIdBySource.get(afVendorId) || null : null;

    const status = mapStatus(w.Status);
    const priority = mapPriority(w.Priority);
    const title = (w.JobDescription || w.WorkOrderIssue || w.Description || `Work Order ${sourceTicketId}`).slice(0, 500);
    const description = w.Description || w.TenantRemarks || null;
    const category = w.VendorTrade || null;
    const reportedAt = w.CreatedAt ? new Date(w.CreatedAt) : new Date();
    const scheduledAt = w.ScheduledStart ? new Date(w.ScheduledStart) : null;
    const completedAt = (w.WorkCompletedOn || w.CompletedOn)
      ? new Date(w.WorkCompletedOn || w.CompletedOn)
      : (status === 'completed' ? new Date() : null);

    const values = {
      organizationId,
      propertyId,
      unitId,
      vendorId,
      title,
      description,
      category,
      priority,
      status,
      reportedAt,
      scheduledAt,
      completedAt,
      sourceTicketId,
      sourcePms: 'appfolio',
      updatedAt: new Date(),
    };

    const [existing] = await db
      .select({ id: schema.maintenanceTickets.id })
      .from(schema.maintenanceTickets)
      .where(
        and(
          eq(schema.maintenanceTickets.organizationId, organizationId),
          eq(schema.maintenanceTickets.sourceTicketId, sourceTicketId),
          eq(schema.maintenanceTickets.sourcePms, 'appfolio'),
        ),
      )
      .limit(1);

    if (existing) {
      await db
        .update(schema.maintenanceTickets)
        .set(values)
        .where(eq(schema.maintenanceTickets.id, existing.id));
      updated += 1;
    } else {
      await db.insert(schema.maintenanceTickets).values(values);
      inserted += 1;
    }
  }

  return res.status(200).json({
    ok: true,
    organization_id: organizationId,
    fetched: afRows.length,
    fetch_ms: fetchMs,
    inserted,
    updated,
    skipped_no_property: skippedNoProperty,
    skipped_examples: skippedExamples,
  });
});
