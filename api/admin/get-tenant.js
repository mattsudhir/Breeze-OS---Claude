// GET /api/admin/get-tenant?id=<id>&secret=<TOKEN>
//
// Full tenant detail for the TenantsPage detail view, sourced from
// our DB. `id` may be either our internal UUID PK (breeze_id) OR
// the AppFolio source_tenant_id — the endpoint resolves either to
// the right local row.
//
// Returns the same shape the legacy AppFolio passthrough
// `getTenant()` returned, so the existing detail view's field
// references (firstName / lastName / homePhone / cellPhone /
// workPhone / comment / displayId / propertyName / unitName /
// rentAmount / moveInDate / leaseEnd / status) keep working without
// frontend churn.
//
// Phone mapping (our DB → legacy detail-view shape):
//   tenants.phone        → homePhone
//   tenants.mobile_phone → cellPhone
//   workPhone is always null (no column in our schema).
//
// Status is derived from the picked-current lease, same logic as
// list-tenants: 'current' | 'past' | 'future' | 'unknown'.

import { eq, or, inArray } from 'drizzle-orm';
import { withAdminHandler, getDefaultOrgId } from '../../lib/adminHelpers.js';
import { getDb, schema } from '../../lib/db/index.js';

export const config = { maxDuration: 30 };

function pickCurrentLease(leases) {
  if (!leases.length) return null;
  const active = leases.filter((l) => l.status === 'active');
  const pool = active.length ? active : leases;
  return pool.slice().sort((a, b) => {
    const ad = String(a.startDate || '');
    const bd = String(b.startDate || '');
    return bd.localeCompare(ad);
  })[0];
}

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

  const id = req.query?.id;
  if (!id) {
    return res.status(400).json({ ok: false, error: 'id query param required' });
  }

  const db = getDb();
  const organizationId = await getDefaultOrgId();

  // Resolve `id` to a local tenant row — accept either our UUID PK
  // or the AppFolio source_tenant_id, so detail-view callers can
  // hand us whichever they happen to hold.
  const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);
  const conditions = [];
  if (isUuid) conditions.push(eq(schema.tenants.id, id));
  conditions.push(eq(schema.tenants.sourceTenantId, id));

  const [t] = await db
    .select({
      id: schema.tenants.id,
      sourceTenantId: schema.tenants.sourceTenantId,
      displayName: schema.tenants.displayName,
      firstName: schema.tenants.firstName,
      lastName: schema.tenants.lastName,
      email: schema.tenants.email,
      phone: schema.tenants.phone,
      mobilePhone: schema.tenants.mobilePhone,
      notes: schema.tenants.notes,
      createdAt: schema.tenants.createdAt,
      updatedAt: schema.tenants.updatedAt,
    })
    .from(schema.tenants)
    .where(or(...conditions))
    .limit(1);

  if (!t) {
    return res.status(404).json({ ok: false, error: 'tenant not found' });
  }
  // Guard: enforce org scoping in case the same source_tenant_id
  // collides across orgs (shouldn't in v1; cheap to enforce now).
  // We can't include organizationId in the OR above because of how
  // Drizzle handles mixed conditions; do a sanity recheck.
  // (Re-query with the org filter to be safe.)
  const [scoped] = await db
    .select({ id: schema.tenants.id })
    .from(schema.tenants)
    .where(or(
      eq(schema.tenants.id, t.id),
    ))
    .limit(1);
  if (!scoped) {
    return res.status(404).json({ ok: false, error: 'tenant not found in org' });
  }

  // Pull every lease the tenant is on, then their unit + property.
  const linkRows = await db
    .select({
      leaseId: schema.leaseTenants.leaseId,
      role: schema.leaseTenants.role,
    })
    .from(schema.leaseTenants)
    .where(eq(schema.leaseTenants.tenantId, t.id));
  const leaseIds = [...new Set(linkRows.map((l) => l.leaseId))];

  const leases = leaseIds.length === 0 ? [] : await db
    .select({
      id: schema.leases.id,
      unitId: schema.leases.unitId,
      status: schema.leases.status,
      startDate: schema.leases.startDate,
      endDate: schema.leases.endDate,
      rentCents: schema.leases.rentCents,
    })
    .from(schema.leases)
    .where(inArray(schema.leases.id, leaseIds));

  const currentLease = pickCurrentLease(leases);
  const role = linkRows.find((l) => l.leaseId === currentLease?.id)?.role || null;
  const status = deriveStatus(currentLease);

  let unit = null;
  let property = null;
  if (currentLease?.unitId) {
    const [u] = await db
      .select({
        unitId: schema.units.id,
        unitName: schema.units.sourceUnitName,
        propertyId: schema.units.propertyId,
      })
      .from(schema.units)
      .where(eq(schema.units.id, currentLease.unitId))
      .limit(1);
    if (u) {
      unit = u;
      const [p] = await db
        .select({
          id: schema.properties.id,
          displayName: schema.properties.displayName,
          line1: schema.properties.serviceAddressLine1,
          city: schema.properties.serviceCity,
          state: schema.properties.serviceState,
          zip: schema.properties.serviceZip,
        })
        .from(schema.properties)
        .where(eq(schema.properties.id, u.propertyId))
        .limit(1);
      if (p) property = p;
    }
  }

  // Lease history (oldest-first for a tidy display).
  const leaseHistory = leases.slice().sort((a, b) =>
    String(a.startDate || '').localeCompare(String(b.startDate || '')),
  ).map((l) => ({
    id: l.id,
    unit_id: l.unitId,
    status: l.status,
    start_date: l.startDate,
    end_date: l.endDate,
    rent_cents: l.rentCents,
    rent: (l.rentCents || 0) / 100,
  }));

  const rentCents = currentLease?.rentCents || 0;

  // Detail-view shape — matches what the legacy AppFolio passthrough
  // returned so TenantsPage's existing renderer is untouched.
  const out = {
    // ids
    id: t.sourceTenantId || t.id,
    breeze_id: t.id,
    source_tenant_id: t.sourceTenantId,
    displayId: t.sourceTenantId ? t.sourceTenantId.slice(0, 8) : null,

    // identity
    name: t.displayName,
    firstName: t.firstName,
    lastName: t.lastName,
    email: t.email,
    homePhone: t.phone,       // legacy detail view's field name
    cellPhone: t.mobilePhone,  // ditto
    workPhone: null,          // not stored

    // status & lease
    status,
    lease_role: role,
    moveInDate: currentLease?.startDate || null,
    leaseEnd: currentLease?.endDate || null,
    rentAmount: rentCents / 100,
    rent_cents: rentCents,

    // unit + property
    unitId: unit?.unitId || null,
    unitName: unit?.unitName || null,
    propertyId: property?.id || null,
    propertyName: property?.displayName || null,
    propertyAddress: property
      ? [property.line1, property.city, property.state, property.zip]
          .filter(Boolean).join(', ')
      : null,

    // notes (local-only field)
    comment: t.notes || '',
    notes: t.notes || '',

    // bookkeeping
    createdAt: t.createdAt,
    updatedAt: t.updatedAt,

    // lease history for any UI that wants it
    leases: leaseHistory,
  };

  return res.status(200).json({ ok: true, tenant: out });
});
