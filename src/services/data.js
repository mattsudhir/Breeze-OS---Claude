// Backend-agnostic data service for menu pages.
//
// Replaces src/services/rentManager.js for new code. Pages take the
// active dataSource from useDataSource() and pass it into each
// fetcher; the fetcher hits /api/data, which dispatches to the
// matching backend module under lib/backends/.
//
// Output shape: every list/detail function returns canonical
// camelCase fields (firstName, propertyName, etc.) regardless of
// which backend produced them. AppFolio's tools natively use
// snake_case, so we normalise here. Rent Manager's were already
// camelCase via rentManager.js's mappers — that work is replicated
// inside this module so menu pages have one source of truth.
//
// Returns null on transient failures, matching rentManager.js's
// error ergonomics. Throws only when given a backend it doesn't
// know how to talk to (programming error, not runtime).

const API_BASE = '/api';

async function dataFetch(source, tool, input = {}) {
  if (!source) throw new Error('dataFetch: source is required');
  if (!tool) throw new Error('dataFetch: tool is required');

  try {
    const res = await fetch(`${API_BASE}/data`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ source, tool, input }),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok || !json.ok) {
      console.warn(`[data] ${source}/${tool} failed:`, json.error || `HTTP ${res.status}`);
      return null;
    }
    return json.data;
  } catch (err) {
    console.warn(`[data] ${source}/${tool} threw:`, err.message);
    return null;
  }
}

// ── Normalisers ──────────────────────────────────────────────────
// One mapper per (entity × backend). All of them spit out the same
// canonical shape so the consumer page doesn't care which backend
// the row came from.

function normaliseAppfolioProperty(p) {
  if (!p) return null;
  return {
    id: p.id,
    name: p.name || p.address || `Property ${p.id}`,
    shortName: p.name || '',
    address: [p.address, p.city, p.state, p.postal_code].filter(Boolean).join(', '),
    city: p.city || '',
    state: p.state || '',
    zip: p.postal_code || '',
    type: p.type || '',
    raw: p,
  };
}

function normaliseAppfolioUnit(u) {
  if (!u) return null;
  return {
    id: u.id,
    propertyId: null, // AppFolio's list_units returns property_name; id mapping wired in Phase 3
    propertyName: u.property_name || '',
    name: u.name || `Unit ${u.id}`,
    type: '',
    status: u.status || '',
    bedrooms: u.bedrooms,
    bathrooms: u.bathrooms,
    sqft: u.sqft,
    marketRent: u.market_rent,
    raw: u,
  };
}

function normaliseAppfolioTenant(t) {
  if (!t) return null;
  return {
    id: t.id,
    displayId: t.id,
    firstName: t.first_name || '',
    lastName: t.last_name || '',
    salutation: '',
    name: t.name || `${t.first_name || ''} ${t.last_name || ''}`.trim() || 'Unknown',
    email: t.email || '',
    phone: t.phone || t.mobile || '',
    homePhone: t.phone || '',
    cellPhone: t.mobile || '',
    workPhone: '',
    status: t.status || '',
    propertyId: t.property_id || null,
    unitId: t.unit_id || null,
    occupancyId: t.occupancy_id || null,
    propertyName: t.property_name || '',
    unitName: t.unit_name || '',
    moveInDate: t.move_in_date || null,
    moveOutDate: t.move_out_date || null,
    leaseStart: t.lease_start || null,
    leaseEnd: t.lease_end || null,
    rent: t.rent || null,
    balance: t.balance || null,
    hidden: !!t.hidden,
    raw: t,
  };
}

// ── Public fetchers ──────────────────────────────────────────────
// Each function takes the dataSource string. The page calls
// useDataSource() and passes the value through, which means the
// page also auto-refetches when the toggle flips (just put
// dataSource in the useEffect dep list).

export async function getProperties(source) {
  if (source === 'appfolio') {
    // Big limit since this powers the full Properties list page; the
    // tool clamps to 2000 internally, which is more than any portfolio
    // we expect to see. Underlying paginated fetch handles it fine.
    const result = await dataFetch(source, 'list_properties', { limit: 2000 });
    if (!result) return null;
    return (result.properties || []).map(normaliseAppfolioProperty);
  }
  // Default: hit the legacy Rent Manager service. Keeps existing
  // behaviour for anyone still toggled to RM and avoids breaking
  // pages that haven't been migrated yet.
  const { getProperties: rmGetProperties } = await import('./rentManager.js');
  return rmGetProperties();
}

export async function getUnits(source, propertyId) {
  if (source === 'appfolio') {
    const result = await dataFetch(source, 'list_units', { limit: 5000 });
    if (!result) return null;
    let units = (result.units || []).map(normaliseAppfolioUnit);
    // AppFolio's list_units doesn't currently support propertyId
    // filtering — once we expose a filter we'll push it down. For
    // now, filter client-side by propertyName fallback (best effort).
    if (propertyId) {
      // No reliable client-side filter without property_id on the
      // unit row. Returning all and letting the page handle is
      // honest. Phase 3 will plumb property_id through list_units.
    }
    return units;
  }
  const { getUnits: rmGetUnits } = await import('./rentManager.js');
  return rmGetUnits(propertyId);
}

export async function getTenants(source) {
  if (source === 'appfolio') {
    // Default page-size of 30 was clamping menu views to a tiny
    // window — bumped to 5000 to cover full Breeze portfolios. The
    // underlying tool clamps at 5000 anyway. active_only=false so
    // the All/Current/Past tabs in TenantsPage have past tenants
    // available for the UI's own filtering.
    const result = await dataFetch(source, 'list_tenants', {
      limit: 5000,
      active_only: false,
    });
    if (!result) return null;
    return (result.tenants || []).map(normaliseAppfolioTenant);
  }
  const { getTenants: rmGetTenants } = await import('./rentManager.js');
  return rmGetTenants();
}

export async function getTenant(source, id) {
  if (!id) return null;
  if (source === 'appfolio') {
    const result = await dataFetch(source, 'get_tenant_details', { tenant_id: id });
    if (!result) return null;
    if (result.error) {
      console.warn(`[data] get_tenant_details error: ${result.error}`);
      return null;
    }
    return normaliseAppfolioTenant(result);
  }
  const { getTenant: rmGetTenant } = await import('./rentManager.js');
  return rmGetTenant(id);
}

// updateTenant is RM-only for now — AppFolio's PATCH /tenants/{id}
// only accepts CustomFields per the v0 docs, not the contact-info
// fields the Tenant edit form changes. Until we surface a write
// pathway that matches, AppFolio mode silently no-ops the update
// and surfaces a clear message to the caller.
export async function updateTenant(source, id, patch) {
  if (source === 'appfolio') {
    return {
      ok: false,
      error:
        'Editing tenant contact info is not yet supported when AppFolio is the active data source. ' +
        'Switch to Rent Manager to edit, or update the tenant directly in AppFolio.',
    };
  }
  const { updateTenant: rmUpdateTenant } = await import('./rentManager.js');
  return rmUpdateTenant(id, patch);
}

// Pages that need work orders / charges / etc. still go through
// rentManager.js. Once we wrap the matching AppFolio endpoints
// (list_work_orders, list_charges with PropertyId scope), they'll
// move into this file. Tracked in SESSION_NOTES.
