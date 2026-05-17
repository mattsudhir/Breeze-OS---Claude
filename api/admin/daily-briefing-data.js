// GET /api/admin/daily-briefing-data?secret=<TOKEN>
//   &window_start=<ISO>     optional; defaults to last briefing's
//                            window_end, or 30 days ago if none
//   &entity_id=<uuid>       optional; scope to one LLC
//   &dry_run=true           do not record a briefing_run
//
// Read-only signal collector for the daily briefing feature
// (ADR 0005). Returns a structured snapshot of what's happened
// in the window plus current-state snapshots of the things an
// owner / PM needs to act on today.
//
// Also records a `briefing_runs` row so the NEXT briefing knows
// when this one's window ended. Pass dry_run=true to preview
// without bookkeeping.

import { and, eq, gte, ne, sql, isNotNull, desc, lt } from 'drizzle-orm';
import {
  withAdminHandler,
  getDefaultOrgId,
} from '../../lib/adminHelpers.js';
import { getDb, schema } from '../../lib/db/index.js';

export const config = { maxDuration: 30 };

const DEFAULT_WINDOW_DAYS = 30;
const STALE_TICKET_DAYS = 7;
const RENEWAL_LOOKAHEAD_DAYS = 90;
const EXAMPLES_PER_SIGNAL = 5;

// Resolve the actor for briefing_runs bookkeeping. Mirrors the
// admin_audit_log convention.
function resolveActor(req) {
  if (req.__clerkSession?.userId) {
    return { actorType: 'clerk_user', actorId: req.__clerkSession.userId };
  }
  if (req.__isAdmin) return { actorType: 'admin_token', actorId: null };
  return { actorType: 'unknown', actorId: null };
}

export default withAdminHandler(async (req, res) => {
  if (req.method !== 'GET' && req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'GET or POST only' });
  }

  const db = getDb();
  const organizationId = await getDefaultOrgId();
  const { actorType, actorId } = resolveActor(req);
  const entityId = req.query?.entity_id || null;
  const dryRun = req.query?.dry_run === 'true';

  // Resolve window_start: explicit param > prev briefing's window_end > 30 days ago.
  const now = new Date();
  let windowStart;
  let prevBriefingId = null;
  if (req.query?.window_start) {
    windowStart = new Date(req.query.window_start);
    if (Number.isNaN(windowStart.getTime())) {
      return res.status(400).json({ ok: false, error: 'window_start must be a valid ISO date' });
    }
  } else {
    // Look up the most recent briefing for this actor.
    const prevConditions = [eq(schema.briefingRuns.actorType, actorType)];
    if (actorId) prevConditions.push(eq(schema.briefingRuns.actorId, actorId));
    if (entityId) prevConditions.push(eq(schema.briefingRuns.entityId, entityId));
    const [prev] = await db
      .select({
        id: schema.briefingRuns.id,
        windowEnd: schema.briefingRuns.windowEnd,
      })
      .from(schema.briefingRuns)
      .where(and(...prevConditions))
      .orderBy(desc(schema.briefingRuns.createdAt))
      .limit(1);
    if (prev) {
      windowStart = prev.windowEnd;
      prevBriefingId = prev.id;
    } else {
      windowStart = new Date(now.getTime() - DEFAULT_WINDOW_DAYS * 86400 * 1000);
    }
  }

  // ── Signal: new tickets in window ─────────────────────────────
  const newTicketRows = await db
    .select({
      id: schema.maintenanceTickets.id,
      title: schema.maintenanceTickets.title,
      priority: schema.maintenanceTickets.priority,
      status: schema.maintenanceTickets.status,
      reportedAt: schema.maintenanceTickets.reportedAt,
      createdAt: schema.maintenanceTickets.createdAt,
      propertyName: schema.properties.displayName,
      unitName: schema.units.sourceUnitName,
    })
    .from(schema.maintenanceTickets)
    .leftJoin(schema.properties, eq(schema.maintenanceTickets.propertyId, schema.properties.id))
    .leftJoin(schema.units, eq(schema.maintenanceTickets.unitId, schema.units.id))
    .where(and(
      eq(schema.maintenanceTickets.organizationId, organizationId),
      gte(schema.maintenanceTickets.createdAt, windowStart),
    ))
    .orderBy(desc(schema.maintenanceTickets.createdAt));

  const newTicketsByPriority = { emergency: 0, high: 0, medium: 0, low: 0 };
  for (const t of newTicketRows) {
    newTicketsByPriority[t.priority] = (newTicketsByPriority[t.priority] || 0) + 1;
  }
  // Examples: prioritize emergency + high.
  const PRIORITY_RANK = { emergency: 4, high: 3, medium: 2, low: 1 };
  const newTicketExamples = newTicketRows
    .slice()
    .sort((a, b) => (PRIORITY_RANK[b.priority] || 0) - (PRIORITY_RANK[a.priority] || 0))
    .slice(0, EXAMPLES_PER_SIGNAL)
    .map((t) => ({
      id: t.id,
      title: t.title,
      priority: t.priority,
      status: t.status,
      property: t.propertyName,
      unit: t.unitName,
      reported_at: t.reportedAt,
    }));

  // ── Signal: stale open tickets (no movement in >= 7 days) ────
  const staleThreshold = new Date(now.getTime() - STALE_TICKET_DAYS * 86400 * 1000);
  const staleTicketRows = await db
    .select({
      id: schema.maintenanceTickets.id,
      title: schema.maintenanceTickets.title,
      priority: schema.maintenanceTickets.priority,
      status: schema.maintenanceTickets.status,
      updatedAt: schema.maintenanceTickets.updatedAt,
      reportedAt: schema.maintenanceTickets.reportedAt,
      propertyName: schema.properties.displayName,
    })
    .from(schema.maintenanceTickets)
    .leftJoin(schema.properties, eq(schema.maintenanceTickets.propertyId, schema.properties.id))
    .where(and(
      eq(schema.maintenanceTickets.organizationId, organizationId),
      sql`${schema.maintenanceTickets.status} NOT IN ('completed', 'cancelled')`,
      lt(schema.maintenanceTickets.updatedAt, staleThreshold),
    ))
    .orderBy(schema.maintenanceTickets.updatedAt)
    .limit(EXAMPLES_PER_SIGNAL);
  const staleTicketCountRows = await db
    .select({ c: sql`COUNT(*)`.as('c') })
    .from(schema.maintenanceTickets)
    .where(and(
      eq(schema.maintenanceTickets.organizationId, organizationId),
      sql`${schema.maintenanceTickets.status} NOT IN ('completed', 'cancelled')`,
      lt(schema.maintenanceTickets.updatedAt, staleThreshold),
    ));
  const staleTicketCount = Number(staleTicketCountRows[0]?.c || 0);
  const staleExamples = staleTicketRows.map((t) => {
    const days = Math.floor((now - new Date(t.updatedAt)) / (86400 * 1000));
    return {
      id: t.id, title: t.title, priority: t.priority, status: t.status,
      property: t.propertyName, days_since_movement: days,
    };
  });

  // ── Signal: expiring leases in next 90 days ───────────────────
  const renewalEnd = new Date(now.getTime() + RENEWAL_LOOKAHEAD_DAYS * 86400 * 1000);
  const todayIso = now.toISOString().slice(0, 10);
  const renewalIso = renewalEnd.toISOString().slice(0, 10);
  const expiringRows = await db
    .select({
      id: schema.leases.id,
      endDate: schema.leases.endDate,
      rentCents: schema.leases.rentCents,
      unitId: schema.leases.unitId,
      unitName: schema.units.sourceUnitName,
      propertyName: schema.properties.displayName,
    })
    .from(schema.leases)
    .leftJoin(schema.units, eq(schema.leases.unitId, schema.units.id))
    .leftJoin(schema.properties, eq(schema.units.propertyId, schema.properties.id))
    .where(and(
      eq(schema.leases.organizationId, organizationId),
      eq(schema.leases.status, 'active'),
      isNotNull(schema.leases.endDate),
      sql`${schema.leases.endDate} BETWEEN ${todayIso} AND ${renewalIso}`,
    ))
    .orderBy(schema.leases.endDate);
  const expiringBuckets = { in_30d: 0, in_60d: 0, in_90d: 0 };
  for (const l of expiringRows) {
    const days = Math.floor((new Date(l.endDate) - now) / (86400 * 1000));
    if (days <= 30) expiringBuckets.in_30d += 1;
    else if (days <= 60) expiringBuckets.in_60d += 1;
    else expiringBuckets.in_90d += 1;
  }
  // Look up primary tenants for the soonest-expiring examples.
  const examplesSrc = expiringRows.slice(0, EXAMPLES_PER_SIGNAL);
  const exampleLeaseIds = examplesSrc.map((l) => l.id);
  const primaryTenantRows = exampleLeaseIds.length === 0 ? [] : await db
    .select({
      leaseId: schema.leaseTenants.leaseId,
      tenantName: schema.tenants.displayName,
    })
    .from(schema.leaseTenants)
    .leftJoin(schema.tenants, eq(schema.leaseTenants.tenantId, schema.tenants.id))
    .where(and(
      eq(schema.leaseTenants.role, 'primary'),
      sql`${schema.leaseTenants.leaseId} IN ${exampleLeaseIds}`,
    ));
  const tenantByLease = new Map(primaryTenantRows.map((r) => [r.leaseId, r.tenantName]));
  const expiringExamples = examplesSrc.map((l) => ({
    lease_id: l.id,
    tenant: tenantByLease.get(l.id) || null,
    unit: l.unitName,
    property: l.propertyName,
    end_date: l.endDate,
    rent_cents: l.rentCents,
    days_until_end: Math.floor((new Date(l.endDate) - now) / (86400 * 1000)),
  }));

  // ── Signal: past-due tenants (current snapshot) ───────────────
  const pastDueRows = await db
    .select({
      tenantId: schema.postedCharges.tenantId,
      total: sql`SUM(${schema.postedCharges.balanceCents})`.as('total'),
    })
    .from(schema.postedCharges)
    .where(and(
      eq(schema.postedCharges.organizationId, organizationId),
      eq(schema.postedCharges.status, 'open'),
      sql`${schema.postedCharges.balanceCents} > 0`,
      isNotNull(schema.postedCharges.tenantId),
    ))
    .groupBy(schema.postedCharges.tenantId);
  const pastDueTotal = pastDueRows.reduce((s, r) => s + Number(r.total || 0), 0);
  const sortedPastDue = pastDueRows
    .map((r) => ({ tenantId: r.tenantId, balance: Number(r.total || 0) }))
    .sort((a, b) => b.balance - a.balance)
    .slice(0, EXAMPLES_PER_SIGNAL);
  const pastDueTenantIds = sortedPastDue.map((r) => r.tenantId);
  const pastDueTenants = pastDueTenantIds.length === 0 ? [] : await db
    .select({
      id: schema.tenants.id,
      displayName: schema.tenants.displayName,
    })
    .from(schema.tenants)
    .where(sql`${schema.tenants.id} IN ${pastDueTenantIds}`);
  const tenantById = new Map(pastDueTenants.map((t) => [t.id, t.displayName]));
  const pastDueExamples = sortedPastDue.map((r) => ({
    tenant_id: r.tenantId,
    tenant: tenantById.get(r.tenantId) || '(unknown)',
    balance_cents: r.balance,
  }));

  // ── Signal: pending agent approvals (queued messages) ────────
  let pendingApprovalsCount = 0;
  try {
    const [row] = await db
      .select({ c: sql`COUNT(*)`.as('c') })
      .from(schema.messages)
      .where(and(
        eq(schema.messages.organizationId, organizationId),
        eq(schema.messages.status, 'queued'),
      ));
    pendingApprovalsCount = Number(row?.c || 0);
  } catch {
    // Messages table may not exist in some envs. Default to 0.
  }

  // ── Signal: recent move events in window ─────────────────────
  let moveEventsCount = 0;
  try {
    const [row] = await db
      .select({ c: sql`COUNT(*)`.as('c') })
      .from(schema.moveEvents)
      .where(and(
        eq(schema.moveEvents.organizationId, organizationId),
        gte(schema.moveEvents.createdAt, windowStart),
      ));
    moveEventsCount = Number(row?.c || 0);
  } catch { /* table may not exist */ }

  // ── Signal: recon queue depth (match candidates pending) ─────
  let reconQueueCount = 0;
  try {
    const [row] = await db
      .select({ c: sql`COUNT(*)`.as('c') })
      .from(schema.matchCandidates)
      .where(and(
        eq(schema.matchCandidates.organizationId, organizationId),
        eq(schema.matchCandidates.status, 'pending_review'),
      ));
    reconQueueCount = Number(row?.c || 0);
  } catch { /* table may not exist */ }

  // ── Signal: integration health (any non-ok rows) ─────────────
  const integrationRows = await db
    .select({
      name: schema.integrationHealth.name,
      status: schema.integrationHealth.status,
      lastErrorMessage: schema.integrationHealth.lastErrorMessage,
      consecutiveFailures: schema.integrationHealth.consecutiveFailures,
    })
    .from(schema.integrationHealth)
    .where(eq(schema.integrationHealth.organizationId, organizationId));
  const integrationsDegraded = integrationRows.filter((r) => r.status !== 'ok');

  // ── Assemble the snapshot ────────────────────────────────────
  const signals = {
    new_tickets: {
      count: newTicketRows.length,
      by_priority: newTicketsByPriority,
      examples: newTicketExamples,
    },
    stale_tickets: {
      count: staleTicketCount,
      threshold_days: STALE_TICKET_DAYS,
      examples: staleExamples,
    },
    expiring_leases: {
      ...expiringBuckets,
      examples: expiringExamples,
    },
    past_due: {
      tenant_count: pastDueRows.length,
      total_cents: pastDueTotal,
      examples: pastDueExamples,
    },
    pending_approvals: { count: pendingApprovalsCount },
    move_events: { count_in_window: moveEventsCount },
    recon_queue: { count: reconQueueCount },
    integrations_degraded: {
      count: integrationsDegraded.length,
      examples: integrationsDegraded.slice(0, EXAMPLES_PER_SIGNAL),
    },
  };

  // ── Record the briefing_run (unless dry-run) ─────────────────
  let briefingRunId = null;
  if (!dryRun) {
    const [created] = await db
      .insert(schema.briefingRuns)
      .values({
        organizationId,
        actorType,
        actorId,
        entityId,
        windowStart,
        windowEnd: now,
        signals,
      })
      .returning({ id: schema.briefingRuns.id });
    briefingRunId = created.id;
  }

  return res.status(200).json({
    ok: true,
    organization_id: organizationId,
    scope: { entity_id: entityId },
    actor: { type: actorType, id: actorId },
    window: {
      start: windowStart,
      end: now,
      prev_briefing_id: prevBriefingId,
      default_used: !req.query?.window_start && !prevBriefingId,
    },
    signals,
    briefing_run_id: briefingRunId,
    dry_run: dryRun,
  });
});
