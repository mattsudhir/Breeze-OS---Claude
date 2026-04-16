// Frontend service layer for Zoho data via the MCP connector endpoint.
//
// Calls /api/zoho-data?entity=<type> which uses the Anthropic MCP
// connector to fetch data from the Zoho MCP server (CRM, Creator, etc.)
// and returns structured JSON.

const API_BASE = '/api';

async function zohoFetch(entity) {
  try {
    const res = await fetch(`${API_BASE}/zoho-data?entity=${encodeURIComponent(entity)}`);
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      console.warn(`[zohoData] ${entity} failed: ${body.error || res.status}`);
      return null;
    }
    const json = await res.json();
    if (!json.ok) {
      console.warn(`[zohoData] ${entity} error:`, json.error || json.warning);
      return json.data || null;
    }
    return json.data || [];
  } catch (err) {
    console.warn(`[zohoData] ${entity} fetch error:`, err.message);
    return null;
  }
}

// ── Tenants ────────────────────────────────────────────────────────

function mapTenant(raw) {
  if (!raw) return null;
  // Normalize fields — Zoho CRM uses different naming conventions
  // than Rent Manager. We accept whatever Claude returned and map
  // to the shape the frontend expects.
  const firstName = raw.firstName || raw.First_Name || raw.first_name || '';
  const lastName = raw.lastName || raw.Last_Name || raw.last_name || '';
  const name = raw.name || raw.Full_Name || raw.full_name ||
    [firstName, lastName].filter(Boolean).join(' ') || 'Unknown';
  const email = raw.email || raw.Email || raw.email_address || '';
  const phone = raw.phone || raw.Phone || raw.phone_number || raw.Mobile || raw.mobile || '';
  const status = raw.status || raw.Status || raw.Contact_Status || '';

  return {
    id: raw.id || raw.ID || raw.Contact_ID || raw.record_id || Math.random().toString(36).slice(2),
    displayId: raw.displayId || raw.Display_ID || raw.id || '',
    firstName,
    lastName,
    name,
    email,
    phone,
    homePhone: raw.homePhone || raw.Home_Phone || raw.home_phone || '',
    cellPhone: raw.cellPhone || raw.Mobile || raw.Cell_Phone || raw.cell_phone || phone,
    workPhone: raw.workPhone || raw.Work_Phone || raw.work_phone || raw.Other_Phone || '',
    status,
    comment: raw.comment || raw.Description || raw.Notes || raw.notes || '',
    propertyId: raw.propertyId || raw.Property_ID || raw.property_id || null,
    unitId: raw.unitId || raw.Unit_ID || raw.unit_id || null,
    addresses: [],
    primaryAddress: null,
    leases: [],
    currentLease: null,
    openCharges: [],
    balance: raw.balance || raw.Balance || 0,
    contacts: [],
    raw,
  };
}

export async function getTenants() {
  const data = await zohoFetch('tenants');
  if (!data || !Array.isArray(data)) return null;
  return data.map(mapTenant).filter(Boolean);
}

export async function getTenant(id) {
  // For now, fetch all and find by id. A future optimization would
  // pass a filter to the MCP query.
  const all = await getTenants();
  if (!all) return null;
  return all.find((t) => String(t.id) === String(id)) || null;
}

// ── Properties ─────────────────────────────────────────────────────

function mapProperty(raw) {
  if (!raw) return null;
  const name = raw.name || raw.Name || raw.Property_Name || raw.property_name || 'Unknown';
  const city = raw.city || raw.City || raw.city_name || '';
  const state = raw.state || raw.State || raw.state_code || '';
  const zip = raw.zip || raw.Zip || raw.Zip_Code || raw.zip_code || raw.Postal_Code || '';
  const address = raw.address || raw.Address || raw.Street || raw.street ||
    [raw.Address_Line_1, raw.Address_Line_2].filter(Boolean).join(', ') || '';

  return {
    id: raw.id || raw.ID || raw.Property_ID || raw.record_id || Math.random().toString(36).slice(2),
    name,
    shortName: raw.shortName || raw.Short_Name || '',
    address: [address, city, state, zip].filter(Boolean).join(', '),
    city,
    state,
    zip,
    type: raw.type || raw.Type || raw.Property_Type || raw.property_type || '',
    raw,
  };
}

export async function getProperties() {
  const data = await zohoFetch('properties');
  if (!data || !Array.isArray(data)) return null;
  return data.map(mapProperty).filter(Boolean);
}

// ── Units ──────────────────────────────────────────────────────────

function mapUnit(raw) {
  if (!raw) return null;
  return {
    id: raw.id || raw.ID || raw.Unit_ID || raw.record_id || Math.random().toString(36).slice(2),
    propertyId: raw.propertyId || raw.Property_ID || raw.property_id || null,
    name: raw.name || raw.Name || raw.Unit_Name || raw.unit_name || 'Unknown',
    type: raw.type || raw.Type || raw.Unit_Type || '',
    status: raw.status || raw.Status || raw.Occupancy_Status || '',
    bedrooms: raw.bedrooms || raw.Bedrooms || raw.Beds || null,
    bathrooms: raw.bathrooms || raw.Bathrooms || raw.Baths || null,
    sqft: raw.sqft || raw.Sqft || raw.Square_Feet || raw.square_feet || null,
    marketRent: raw.marketRent || raw.Market_Rent || raw.market_rent || raw.Rent || null,
    raw,
  };
}

export async function getUnits(propertyId) {
  const data = await zohoFetch('units');
  if (!data || !Array.isArray(data)) return null;
  let units = data.map(mapUnit).filter(Boolean);
  if (propertyId) {
    units = units.filter((u) => String(u.propertyId) === String(propertyId));
  }
  return units;
}
