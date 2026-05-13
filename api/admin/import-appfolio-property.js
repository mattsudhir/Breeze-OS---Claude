// POST /api/admin/import-appfolio-property?secret=<TOKEN>
// body: {
//   appfolio_property_id: number  // AppFolio's PropertyId
//   entity_id:            uuid    // owning entity in our org
//   owner_id:             uuid    // owners row (legal owner of the LLC)
//   dry_run?:             boolean (default false) — return parsed plan without writing
// }
//
// Imports one AppFolio property's directory tree (property → units →
// active leases via tenants) into Breeze. Idempotent via source_*
// columns; re-running updates in place.
//
// What's pulled:
//   - GET /properties?ids=<id>      → 1 property row
//   - GET /units?property_ids=<id>  → all units under the property
//   - GET /tenants?property_id=<id> → tenants, filtered to active
//                                     (LeaseToDate >= today OR null)
//
// What's NOT in this importer (separate endpoints, separate PRs):
//   - Opening balance journal entry (Reports API trial balance dump)
//   - Open AR snapshot (per-tenant unpaid charges)
//   - Vendors that have invoiced this property
//   - Historical bank transactions

import { and, eq } from 'drizzle-orm';
import {
  withAdminHandler,
  getDefaultOrgId,
  parseBody,
} from '../../lib/adminHelpers.js';
import { getDb, schema } from '../../lib/db/index.js';
import { fetchAllPages } from '../../lib/backends/appfolio.js';

function isAppfolioConfigured() {
  return Boolean(
    process.env.APPFOLIO_CLIENT_ID &&
      process.env.APPFOLIO_CLIENT_SECRET &&
      process.env.APPFOLIO_DEVELOPER_ID,
  );
}

export default withAdminHandler(async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'POST only' });
  }
  if (!isAppfolioConfigured()) {
    return res.status(503).json({
      ok: false,
      error: 'AppFolio not configured (APPFOLIO_DATABASE_API_URL / credentials).',
    });
  }

  const body = parseBody(req);
  const appfolioPropertyId = Number(body.appfolio_property_id);
  const entityId = body.entity_id || null;
  const ownerId = body.owner_id || null;
  const dryRun = !!body.dry_run;

  if (!Number.isInteger(appfolioPropertyId) || appfolioPropertyId <= 0) {
    return res.status(400).json({
      ok: false,
      error: 'appfolio_property_id must be a positive integer',
    });
  }
  if (!entityId) {
    return res.status(400).json({ ok: false, error: 'entity_id required' });
  }
  if (!ownerId) {
    return res.status(400).json({ ok: false, error: 'owner_id required' });
  }

  const db = getDb();
  const organizationId = await getDefaultOrgId();

  // Sanity: entity and owner must belong to the org.
  const [entity] = await db
    .select({ id: schema.entities.id, name: schema.entities.name })
    .from(schema.entities)
    .where(
      and(
        eq(schema.entities.id, entityId),
        eq(schema.entities.organizationId, organizationId),
      ),
    )
    .limit(1);
  if (!entity) return res.status(404).json({ ok: false, error: 'entity_id not in org' });

  const [owner] = await db
    .select({ id: schema.owners.id })
    .from(schema.owners)
    .where(
      and(
        eq(schema.owners.id, ownerId),
        eq(schema.owners.organizationId, organizationId),
      ),
    )
    .limit(1);
  if (!owner) return res.status(404).json({ ok: false, error: 'owner_id not in org' });

  // Pull from AppFolio.
  let afProperty;
  let afUnits;
  let afTenants;
  try {
    const propResult = await fetchAllPages('/properties', { property_ids: appfolioPropertyId });
    if (propResult.error) {
      return res.status(502).json({ ok: false, error: `AppFolio /properties: ${propResult.error}` });
    }
    const propRows = propResult.data || [];
    if (propRows.length === 0) {
      return res.status(404).json({
        ok: false,
        error: `AppFolio property ${appfolioPropertyId} not found`,
      });
    }
    afProperty = propRows[0];

    const unitsResult = await fetchAllPages('/units', { property_ids: appfolioPropertyId });
    if (unitsResult.error) {
      return res.status(502).json({ ok: false, error: `AppFolio /units: ${unitsResult.error}` });
    }
    afUnits = unitsResult.data || [];

    const tenantsResult = await fetchAllPages('/tenants', { property_id: appfolioPropertyId });
    if (tenantsResult.error) {
      return res.status(502).json({ ok: false, error: `AppFolio /tenants: ${tenantsResult.error}` });
    }
    afTenants = tenantsResult.data || [];
  } catch (err) {
    return res.status(502).json({
      ok: false,
      error: `AppFolio fetch failed: ${err.message || String(err)}`,
    });
  }

  // Filter to active tenants only — those with no end date or end date >= today.
  const today = new Date().toISOString().slice(0, 10);
  const activeTenants = afTenants.filter((t) => {
    const end = t.LeaseToDate || t.LeaseTo || null;
    return !end || end >= today;
  });

  const plan = {
    property: {
      source_property_id: afProperty.PropertyId,
      display_name: afProperty.PropertyName || `Property ${afProperty.PropertyId}`,
      service_address_line1: afProperty.Address1 || afProperty.AddressLine1 || '(unknown)',
      service_city: afProperty.City || '(unknown)',
      service_state: afProperty.State || '(unknown)',
      service_zip: afProperty.Zip || afProperty.PostalCode || '(unknown)',
    },
    units_count: afUnits.length,
    tenants_pulled: afTenants.length,
    active_tenants_count: activeTenants.length,
  };

  if (dryRun) {
    return res.status(200).json({
      ok: true,
      organization_id: organizationId,
      dry_run: true,
      plan,
    });
  }

  const summary = await db.transaction(async (tx) => {
    // ── 1. Upsert property ──────────────────────────────────────
    const [existingProperty] = await tx
      .select({ id: schema.properties.id })
      .from(schema.properties)
      .where(
        and(
          eq(schema.properties.organizationId, organizationId),
          eq(schema.properties.sourcePropertyId, afProperty.PropertyId),
        ),
      )
      .limit(1);

    const propertyValues = {
      organizationId,
      ownerId,
      entityId,
      sourcePropertyId: afProperty.PropertyId,
      sourcePms: 'appfolio',
      displayName: afProperty.PropertyName || `AppFolio property ${afProperty.PropertyId}`,
      serviceAddressLine1: afProperty.Address1 || afProperty.AddressLine1 || 'Unknown',
      serviceAddressLine2: afProperty.Address2 || afProperty.AddressLine2 || null,
      serviceCity: afProperty.City || 'Unknown',
      serviceState: afProperty.State || 'XX',
      serviceZip: afProperty.Zip || afProperty.PostalCode || '00000',
      updatedAt: new Date(),
    };

    let propertyId;
    if (existingProperty) {
      await tx
        .update(schema.properties)
        .set(propertyValues)
        .where(eq(schema.properties.id, existingProperty.id));
      propertyId = existingProperty.id;
    } else {
      const [inserted] = await tx
        .insert(schema.properties)
        .values(propertyValues)
        .returning({ id: schema.properties.id });
      propertyId = inserted.id;
    }

    // ── 2. Upsert units ─────────────────────────────────────────
    const unitIdsByAppfolioId = new Map();
    for (const u of afUnits) {
      const sourceUnitId = String(u.UnitId);
      const [existingUnit] = await tx
        .select({ id: schema.units.id })
        .from(schema.units)
        .where(
          and(
            eq(schema.units.organizationId, organizationId),
            eq(schema.units.sourceUnitId, sourceUnitId),
          ),
        )
        .limit(1);

      const unitValues = {
        organizationId,
        propertyId,
        sourceUnitId,
        sourceUnitName: u.UnitName || u.Address1 || null,
        sourcePms: 'appfolio',
        sqft: u.Sqft || u.SquareFeet || null,
        bedrooms: u.Bedrooms != null ? Number(u.Bedrooms) : null,
        bathrooms: u.Bathrooms != null ? String(u.Bathrooms) : null,
        updatedAt: new Date(),
      };

      if (existingUnit) {
        await tx
          .update(schema.units)
          .set(unitValues)
          .where(eq(schema.units.id, existingUnit.id));
        unitIdsByAppfolioId.set(u.UnitId, existingUnit.id);
      } else {
        const [inserted] = await tx
          .insert(schema.units)
          .values(unitValues)
          .returning({ id: schema.units.id });
        unitIdsByAppfolioId.set(u.UnitId, inserted.id);
      }
    }

    // ── 3. Upsert tenants + leases ──────────────────────────────
    let tenantsInserted = 0;
    let tenantsUpdated = 0;
    let leasesInserted = 0;
    let leasesUpdated = 0;
    let leasesSkippedNoUnit = 0;

    for (const t of activeTenants) {
      const sourceTenantId = String(t.TenantId || t.OccupancyId);
      const firstName = t.FirstName || null;
      const lastName = t.LastName || null;
      const displayName = [firstName, lastName].filter(Boolean).join(' ') || `Tenant ${sourceTenantId}`;

      const [existingTenant] = await tx
        .select({ id: schema.tenants.id })
        .from(schema.tenants)
        .where(
          and(
            eq(schema.tenants.organizationId, organizationId),
            eq(schema.tenants.sourceTenantId, sourceTenantId),
          ),
        )
        .limit(1);

      const tenantValues = {
        organizationId,
        firstName,
        lastName,
        displayName,
        email: t.Email || null,
        phone: t.PhoneNumber || t.Phone || null,
        mobilePhone: t.MobilePhone || null,
        sourceTenantId,
        sourcePms: 'appfolio',
        updatedAt: new Date(),
      };

      let tenantId;
      if (existingTenant) {
        await tx
          .update(schema.tenants)
          .set(tenantValues)
          .where(eq(schema.tenants.id, existingTenant.id));
        tenantId = existingTenant.id;
        tenantsUpdated += 1;
      } else {
        const [inserted] = await tx
          .insert(schema.tenants)
          .values(tenantValues)
          .returning({ id: schema.tenants.id });
        tenantId = inserted.id;
        tenantsInserted += 1;
      }

      // Lease: one per tenant's occupancy. Needs a unit.
      const unitId = unitIdsByAppfolioId.get(t.UnitId);
      if (!unitId) {
        leasesSkippedNoUnit += 1;
        continue;
      }

      const startDate = t.LeaseFromDate || t.LeaseFrom || null;
      const endDate = t.LeaseToDate || t.LeaseTo || null;
      const rent = t.Rent || t.MonthlyRent || 0;
      const rentCents = Math.round(Number(rent) * 100);

      if (!startDate) continue; // can't model a lease without a start date

      const sourceLeaseId = String(t.OccupancyId || t.TenantId);
      const [existingLease] = await tx
        .select({ id: schema.leases.id })
        .from(schema.leases)
        .where(
          and(
            eq(schema.leases.organizationId, organizationId),
            eq(schema.leases.sourceLeaseId, sourceLeaseId),
          ),
        )
        .limit(1);

      const leaseNumber = `AF-${sourceLeaseId}`;
      const leaseValues = {
        organizationId,
        unitId,
        leaseNumber,
        status: 'active',
        startDate,
        endDate: endDate || null,
        rentCents,
        rentDueDay: 1,
        securityDepositCents: Math.round(Number(t.SecurityDeposit || 0) * 100),
        sourceLeaseId,
        sourcePms: 'appfolio',
        updatedAt: new Date(),
      };

      let leaseId;
      if (existingLease) {
        await tx
          .update(schema.leases)
          .set(leaseValues)
          .where(eq(schema.leases.id, existingLease.id));
        leaseId = existingLease.id;
        leasesUpdated += 1;
      } else {
        const [inserted] = await tx
          .insert(schema.leases)
          .values(leaseValues)
          .returning({ id: schema.leases.id });
        leaseId = inserted.id;
        leasesInserted += 1;
      }

      // Lease-tenant link (m2m). Idempotent via primary key
      // (lease_id, tenant_id).
      await tx
        .insert(schema.leaseTenants)
        .values({ leaseId, tenantId })
        .onConflictDoNothing();
    }

    return {
      property_id: propertyId,
      units_count: afUnits.length,
      tenants_inserted: tenantsInserted,
      tenants_updated: tenantsUpdated,
      leases_inserted: leasesInserted,
      leases_updated: leasesUpdated,
      leases_skipped_no_unit: leasesSkippedNoUnit,
    };
  });

  return res.status(200).json({
    ok: true,
    organization_id: organizationId,
    entity_id: entityId,
    plan,
    result: summary,
  });
});
