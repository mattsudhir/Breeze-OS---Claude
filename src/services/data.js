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
    propertyId: u.property_id || null,
    propertyName: u.property_name || '',
    occupancyId: u.current_occupancy_id || null,
    unitGroupId: u.unit_group_id || null,
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
    // Filter client-side now that property_id is on each row. We
    // could push this to AppFolio if list_units gains a
    // filters[PropertyId] pass-through, but the client-side filter
    // is fine when the full list is already cached in memory.
    if (propertyId) {
      units = units.filter((u) => u.propertyId === propertyId);
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

function normaliseAppfolioWorkOrder(w) {
  if (!w) return null;
  // The AppFolio backend's list_work_orders already maps to camelCase
  // — we just pass it through plus a couple of derived fields the UI
  // expects (statusId/priorityId aren't in AppFolio's data, so they
  // stay null and consumer code falls back to the string).
  return {
    id: w.id,
    displayId: w.displayId || `WO-${w.id}`,
    summary: w.summary || '',
    description: w.description || '',
    isClosed: !!w.isClosed,
    status: w.status || '',
    statusId: null,
    priority: w.priority || '',
    priorityId: null,
    categoryId: null,
    categoryName: w.categoryName || '',
    propertyId: w.propertyId || null,
    unitId: w.unitId || null,
    tenantId: w.tenantId || null,
    createdDate: w.createdDate || null,
    updatedDate: null,
    scheduledDate: w.scheduledDate || null,
    completedDate: w.completedDate || null,
    assignedTo: w.assignedTo || '',
    link: w.link || null,
    raw: w,
  };
}

export async function getWorkOrders(source, opts = {}) {
  if (source === 'appfolio') {
    const result = await dataFetch(source, 'list_work_orders', {
      status: opts.status || 'all', // dashboard / lists want everything by default
      limit: opts.limit || 1000,
    });
    if (!result) return null;
    return (result.work_orders || []).map(normaliseAppfolioWorkOrder);
  }
  const { getWorkOrders: rmGetWorkOrders } = await import('./rentManager.js');
  return rmGetWorkOrders(opts);
}

// Edit a work order. Both backends support write — RM via its
// patchWorkOrder, AppFolio via PATCH /work_orders/{id}. The two
// backends take different shapes for status / priority (RM uses
// numeric IDs from its lookup tables, AppFolio uses string enums)
// so the caller passes a normalised patch and we translate per
// backend.
//
// `patch` shape (all optional, only pass what's changing):
//   status:           string ('Completed', 'Assigned', etc — AppFolio
//                     enum) OR number (RM statusId)
//   priority:         string ('Urgent' / 'Normal' / 'Low') OR number
//   summary / description: strings
//   scheduledDate:    ISO 8601
//   completedDate:    YYYY-MM-DD
//
// Returns { ok: true, work_order_id } on success or
// { ok: false, error } on failure.
export async function updateWorkOrder(source, id, patch = {}) {
  if (!id) return { ok: false, error: 'work order id required' };
  if (source === 'appfolio') {
    const body = { work_order_id: id };
    if (patch.status) body.status = String(patch.status);
    if (patch.priority) body.priority = String(patch.priority);
    if (patch.summary) body.job_description = patch.summary;
    if (patch.description) body.description = patch.description;
    if (patch.scheduledDate) body.scheduled_start = patch.scheduledDate;
    if (patch.completedDate) body.completed_on = patch.completedDate;
    if (patch.canceledDate) body.canceled_on = patch.canceledDate;
    if (patch.vendorId !== undefined) body.vendor_id = patch.vendorId;

    const result = await dataFetch(source, 'update_work_order', body);
    if (!result) return { ok: false, error: 'Update failed (network error)' };
    if (result.error) return { ok: false, error: result.error };
    return { ok: true, work_order_id: result.work_order_id };
  }
  // Rent Manager path. RM's existing service throws on failure,
  // so we wrap it here to return the same shape as the AppFolio path.
  const { updateWorkOrder: rmUpdate } = await import('./rentManager.js');
  try {
    await rmUpdate(id, patch);
    return { ok: true, work_order_id: id };
  } catch (err) {
    return { ok: false, error: err.message || 'Update failed' };
  }
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
