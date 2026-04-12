// Frontend service layer for Rent Manager data via our API proxy.
// All calls go through /api/* which Vercel routes to the serverless function.

const API_BASE = '/api';

async function rmFetch(endpoint, options = {}) {
  try {
    const res = await fetch(`${API_BASE}${endpoint}`, options);
    if (!res.ok) {
      // Try to read error body so callers can surface it
      let errMsg = `HTTP ${res.status}`;
      try {
        const body = await res.json();
        if (body?.error) errMsg = body.error;
        else if (body?.data) errMsg = typeof body.data === 'string' ? body.data : JSON.stringify(body.data);
      } catch {}
      throw new Error(errMsg);
    }
    const json = await res.json();
    if (!json.ok) throw new Error(json.error || `API error ${json.status}`);
    return json.data;
  } catch (err) {
    console.warn(`Rent Manager API call failed (${endpoint}):`, err.message);
    if (options.throwOnError) throw err;
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

function mapTenant(t) {
  if (!t) return null;
  // Rent Manager sometimes returns PhoneNumbers as an array of typed entries
  const phoneEntries = Array.isArray(t.PhoneNumbers) ? t.PhoneNumbers : [];
  const findPhone = (typeName) => {
    const match = phoneEntries.find((p) => {
      const tn = (p.PhoneNumberType?.Name || p.PhoneNumberTypeName || p.Type || '').toLowerCase();
      return tn.includes(typeName);
    });
    return match?.PhoneNumber || match?.Number || '';
  };

  const homePhone = findPhone('home') || t.Phone || '';
  const cellPhone = findPhone('cell') || findPhone('mobile') || t.CellPhone || '';
  const workPhone = findPhone('work') || findPhone('business') || t.WorkPhone || '';

  // Addresses
  const addresses = Array.isArray(t.Addresses) ? t.Addresses : [];
  const primaryAddress = addresses[0] || null;

  // Current lease — prefer one with no end date or latest
  const leases = Array.isArray(t.Leases) ? t.Leases : [];
  const currentLease =
    leases.find((l) => !l.MoveOutDate && !l.EndDate) ||
    leases.slice().sort((a, b) => new Date(b.StartDate || 0) - new Date(a.StartDate || 0))[0] ||
    null;

  // Balance / open charges
  const openCharges = Array.isArray(t.OpenCharges) ? t.OpenCharges : [];
  const balance =
    typeof t.Balance === 'number'
      ? t.Balance
      : openCharges.reduce((sum, c) => sum + (Number(c.Amount) || 0) - (Number(c.AmountPaid) || 0), 0);

  // Contacts (emergency, co-signers)
  const contacts = Array.isArray(t.Contacts) ? t.Contacts : [];

  return {
    id: t.TenantID,
    displayId: t.TenantDisplayID || `t${t.TenantID}`,
    firstName: t.FirstName || '',
    lastName: t.LastName || '',
    salutation: t.Salutation || '',
    name: [t.FirstName, t.LastName].filter(Boolean).join(' ') || `Tenant ${t.TenantID}`,
    email: t.Email || '',
    phone: homePhone || cellPhone || workPhone,
    homePhone,
    cellPhone,
    workPhone,
    status: t.Status || '',
    comment: t.Comment || '',
    propertyId: t.PropertyID || currentLease?.PropertyID || null,
    unitId: t.UnitID || currentLease?.UnitID || null,
    rentDueDay: t.RentDueDay,
    postCharges: t.PostCharges,
    createDate: t.CreateDate || null,
    updateDate: t.UpdateDate || null,
    addresses,
    primaryAddress,
    leases,
    currentLease,
    openCharges,
    balance,
    contacts,
    raw: t,
  };
}

export async function getTenants() {
  const data = await rmFetch('/Tenants');
  if (!data || !Array.isArray(data)) return null;
  return data.map(mapTenant);
}

// Fetch a single tenant with embeds for the detail view.
// Rent Manager supports `embeds=` to expand related collections.
export async function getTenant(id) {
  if (!id) return null;
  const embeds = 'Addresses,Leases,Contacts,OpenCharges,PhoneNumbers';
  const data = await rmFetch(`/Tenants/${id}?embeds=${embeds}`);
  if (!data) return null;
  // Some RM endpoints return an array even for /{id}
  const tenant = Array.isArray(data) ? data[0] : data;
  return mapTenant(tenant);
}

// Update a tenant. `patch` is a plain object of the fields to change.
// Rent Manager typically accepts PUT with a partial object keyed by its API field names.
export async function updateTenant(id, patch) {
  if (!id) throw new Error('updateTenant requires an id');
  // Build the RM-shaped payload from our camelCase patch
  const body = { TenantID: id };
  if ('firstName' in patch) body.FirstName = patch.firstName;
  if ('lastName' in patch) body.LastName = patch.lastName;
  if ('email' in patch) body.Email = patch.email;
  if ('homePhone' in patch) body.Phone = patch.homePhone;
  if ('cellPhone' in patch) body.CellPhone = patch.cellPhone;
  if ('workPhone' in patch) body.WorkPhone = patch.workPhone;
  if ('status' in patch) body.Status = patch.status;
  if ('comment' in patch) body.Comment = patch.comment;

  return rmFetch(`/Tenants/${id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    throwOnError: true,
  });
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
