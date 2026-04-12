// Frontend service layer for Rent Manager data via our API proxy.
// All calls go through /api/* which Vercel routes to the serverless function.

const API_BASE = '/api';

async function rmFetch(endpoint) {
  try {
    const res = await fetch(`${API_BASE}${endpoint}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    if (!json.ok) throw new Error(json.error || `API error ${json.status}`);
    return json.data;
  } catch (err) {
    console.warn(`Rent Manager API call failed (${endpoint}):`, err.message);
    return null;
  }
}

// ── Properties ──────────────────────────────────────────────────

export async function getProperties() {
  const data = await rmFetch('/Properties');
  if (!data || !Array.isArray(data)) return null;

  return data.map((p) => ({
    id: p.PropertyID,
    name: p.Name || p.ShortName || `Property ${p.PropertyID}`,
    shortName: p.ShortName || '',
    address: [p.Address, p.City, p.State, p.Zip].filter(Boolean).join(', '),
    city: p.City || '',
    state: p.State || '',
    zip: p.Zip || '',
    type: p.PropertyType || '',
    raw: p,
  }));
}

// ── Units ───────────────────────────────────────────────────────

export async function getUnits(propertyId) {
  const endpoint = propertyId
    ? `/Units?filters=PropertyID,eq,${propertyId}`
    : '/Units';
  const data = await rmFetch(endpoint);
  if (!data || !Array.isArray(data)) return null;

  return data.map((u) => ({
    id: u.UnitID,
    propertyId: u.PropertyID,
    name: u.Name || `Unit ${u.UnitID}`,
    type: u.UnitTypeName || u.UnitType || '',
    status: u.Status || '',
    bedrooms: u.Bedrooms,
    bathrooms: u.Bathrooms,
    sqft: u.SquareFeet || u.SQFT,
    marketRent: u.MarketRent,
    raw: u,
  }));
}

// ── Tenants ─────────────────────────────────────────────────────

export async function getTenants() {
  const data = await rmFetch('/Tenants');
  if (!data || !Array.isArray(data)) return null;

  return data.map((t) => ({
    id: t.TenantID,
    firstName: t.FirstName || '',
    lastName: t.LastName || '',
    name: [t.FirstName, t.LastName].filter(Boolean).join(' ') || `Tenant ${t.TenantID}`,
    email: t.Email || '',
    phone: t.Phone || t.CellPhone || '',
    status: t.Status || '',
    raw: t,
  }));
}

// ── Service Manager (Maintenance / Work Orders) ─────────────────

export async function getWorkOrders() {
  const data = await rmFetch('/ServiceManagerOrders');
  if (!data || !Array.isArray(data)) return null;

  return data.map((wo) => ({
    id: wo.ServiceManagerOrderID || wo.OrderID,
    summary: wo.Summary || wo.Description || '',
    status: wo.Status || '',
    priority: wo.Priority || '',
    propertyId: wo.PropertyID,
    unitId: wo.UnitID,
    createdDate: wo.CreateDate || wo.DateCreated,
    raw: wo,
  }));
}

// ── Charges / Accounting ────────────────────────────────────────

export async function getCharges() {
  const data = await rmFetch('/Charges');
  if (!data || !Array.isArray(data)) return null;

  return data.map((c) => ({
    id: c.ChargeID,
    amount: c.Amount,
    date: c.Date || c.TransactionDate,
    description: c.Description || '',
    tenantId: c.TenantID,
    type: c.ChargeType || '',
    raw: c,
  }));
}

// ── Generic search (for chat) ───────────────────────────────────

export async function searchEntity(entity, filters) {
  const filterStr = filters ? `?filters=${filters}` : '';
  return rmFetch(`/${entity}${filterStr}`);
}
