// GET /api/admin/list-tenants?secret=<TOKEN>
//
// Tenant directory data — each tenant with their current (or most
// recent) lease, the unit + property it's attached to, rent, and a
// derived status ('current' | 'past' | 'future') for the
// TenantsPage filter pills.
//
// Returns:
//   {
//     ok: true,
//     count: N,
//     tenants: [
//       {
//         id,                      // AppFolio source_tenant_id (so
//                                  // the detail-view passthrough still
//                                  // resolves against AppFolio)
//         breeze_id,               // our internal UUID PK
//         name, first_name, last_name,
//         email, phone, mobile_phone,
//         status,                  // 'current' | 'past' | 'future' | 'unknown'
//         lease_id, lease_role,
//         lease_start_date, lease_end_date,
//         rent_cents, rent,        // rent in dollars for legacy callers
//         unit_id, unit_name,
//         property_id, property_name,
//       },
//       ...
//     ]
//   }
//
// One round-trip. Joins happen in JS after a small fixed number of
// SELECTs (cheaper than fanning out N+1 from the client).

import { eq, inArray } from 'drizzle-orm';
import { withAdminHandler, getDefaultOrgId } from '../../lib/adminHelpers.js';
import { getDb, schema } from '../../lib/db/index.js';

export const config = { maxDuration: 60 };

// Pick the "current" lease for a tenant out of their lease list:
//   1. Any active lease wins.
//   2. Otherwise the lease with the most recent start_date.
function pickCurrentLease(leases) {
  if (!leases.length) return null;
  const active = leases.filter((l) => l.status === 'active');
  if (active.length) {
    // Tiebreak by latest start_date.
    return active.slice().sort((a, b) => {
      const ad = String(a.startDate || '');
      const bd = String(b.startDate || '');
      return bd.localeCompare(ad);
    })[0];
  }
  return leases.slice().sort((a, b) => {
    const ad = String(a.startDate || '');
    const bd = String(b.startDate || '');
    return bd.localeCompare(ad);
  })[0];
}

// Map a lease + today's date to the tenant's filter-bucket status.
function deriveStatus(lease) {
  if (!lease) return 'unknown';
  if (lease.status === 'active') return 'current';
  const today = new Date().toISOString().slice(0, 10);
  if (lease.startDate && lease.startDate > today) return 'future';
  if (lease.endDate && lease.endDate < today) return 'past';
  if (lease.status === 'ended' || lease.status === 'terminated') return 'past';
  return 'unknown';
}

export default withAdminHandler(async (req, res) => {
  if (req.method !== 'GET' && req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'GET or POST only' });
  }

  const db = getDb();
  const organizationId = await getDefaultOrgId();

  // ── Tenants ─────────────────────────────────────────────────
  const tenantRows = await db
    .select({
      id: schema.tenants.id,
      sourceTenantId: schema.tenants.sourceTenantId,
      displayName: schema.tenants.displayName,
      firstName: schema.tenants.firstName,
      lastName: schema.tenants.lastName,
      email: schema.tenants.email,
      phone: schema.tenants.phone,
      mobilePhone: schema.tenants.mobilePhone,
    })
    .from(schema.tenants)
    .where(eq(schema.tenants.organizationId, organizationId))
    .orderBy(schema.tenants.displayName);

  if (tenantRows.length === 0) {
    return res.status(200).json({ ok: true, count: 0, tenants: [] });
  }
  const tenantIds = tenantRows.map((t) => t.id);

  // ── lease_tenants ───────────────────────────────────────────
  const linkRows = await db
    .select({
      leaseId: schema.leaseTenants.leaseId,
      tenantId: schema.leaseTenants.tenantId,
      role: schema.leaseTenants.role,
    })
    .from(schema.leaseTenants)
    .where(inArray(schema.leaseTenants.tenantId, tenantIds));

  const leasesByTenant = new Map(); // tenantId → [{leaseId, role}]
  const leaseIdSet = new Set();
  for (const l of linkRows) {
    leaseIdSet.add(l.leaseId);
    if (!leasesByTenant.has(l.tenantId)) leasesByTenant.set(l.tenantId, []);
    leasesByTenant.get(l.tenantId).push({ leaseId: l.leaseId, role: l.role });
  }

  // ── leases ──────────────────────────────────────────────────
  const leaseRows = leaseIdSet.size === 0 ? [] : await db
    .select({
      id: schema.leases.id,
      unitId: schema.leases.unitId,
      status: schema.leases.status,
      startDate: schema.leases.startDate,
      endDate: schema.leases.endDate,
      rentCents: schema.leases.rentCents,
    })
    .from(schema.leases)
    .where(inArray(schema.leases.id, [...leaseIdSet]));
  const leaseById = new Map(leaseRows.map((l) => [l.id, l]));

  // ── units + properties (one-shot join) ──────────────────────
  const unitIds = [...new Set(leaseRows.map((l) => l.unitId).filter(Boolean))];
  const unitRows = unitIds.length === 0 ? [] : await db
    .select({
      unitId: schema.units.id,
      unitName: schema.units.sourceUnitName,
      propertyId: schema.units.propertyId,
      propertyName: schema.properties.displayName,
    })
    .from(schema.units)
    .leftJoin(schema.properties, eq(schema.units.propertyId, schema.properties.id))
    .where(inArray(schema.units.id, unitIds));
  const unitById = new Map(unitRows.map((u) => [u.unitId, u]));

  // ── Assemble ────────────────────────────────────────────────
  const tenants = tenantRows.map((t) => {
    const links = leasesByTenant.get(t.id) || [];
    const leases = links
      .map((link) => leaseById.get(link.leaseId))
      .filter(Boolean);
    const currentLease = pickCurrentLease(leases);
    const role = links.find((l) => l.leaseId === currentLease?.id)?.role || null;
    const status = deriveStatus(currentLease);
    const unit = currentLease ? unitById.get(currentLease.unitId) : null;
    const rentCents = currentLease?.rentCents || 0;

    return {
      // AppFolio's id is what the legacy detail / edit passthrough
      // expects. Fall back to our internal id if a tenant somehow
      // lacks a source breadcrumb (shouldn't happen post-reimport).
      id: t.sourceTenantId || t.id,
      breeze_id: t.id,
      source_tenant_id: t.sourceTenantId,
      name: t.displayName,
      first_name: t.firstName,
      last_name: t.lastName,
      email: t.email,
      phone: t.phone,
      mobile_phone: t.mobilePhone,
      status,
      lease_id: currentLease?.id || null,
      lease_role: role,
      lease_start_date: currentLease?.startDate || null,
      lease_end_date: currentLease?.endDate || null,
      rent_cents: rentCents,
      rent: rentCents / 100,
      unit_id: unit?.unitId || null,
      unit_name: unit?.unitName || null,
      // Legacy callers used `unitName` (camelCase) — surface both
      // shapes so a switch-over doesn't require renaming every read.
      unitName: unit?.unitName || null,
      property_id: unit?.propertyId || null,
      property_name: unit?.propertyName || null,
      propertyName: unit?.propertyName || null,
      moveInDate: currentLease?.startDate || null,
    };
  });

  return res.status(200).json({
    ok: true,
    organization_id: organizationId,
    count: tenants.length,
    tenants,
  });
});
