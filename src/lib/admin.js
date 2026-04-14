// Frontend client for the /api/admin/* CRUD endpoints.
//
// Until Clerk lands, every admin call carries the BREEZE_ADMIN_TOKEN
// shared secret. The token is read from a single localStorage key so
// the user can paste it in once and have it stick across reloads.
//
//   localStorage.setItem('breezeAdminToken', '<token>')
//
// The Property Directory page exposes a one-time prompt/input to set
// this if it's not already set. No token, no admin calls — every
// request returns { ok: false, error: '...' } locally rather than
// firing against the server.
//
// This is a deliberate stop-gap. Once Clerk is wired up, this file
// goes away in favour of Clerk session tokens.

const TOKEN_KEY = 'breezeAdminToken';

export function getAdminToken() {
  try {
    return localStorage.getItem(TOKEN_KEY) || '';
  } catch {
    return '';
  }
}

export function setAdminToken(token) {
  try {
    if (!token) localStorage.removeItem(TOKEN_KEY);
    else localStorage.setItem(TOKEN_KEY, token);
  } catch {
    // noop — private browsing mode etc.
  }
}

export function hasAdminToken() {
  return !!getAdminToken();
}

async function adminFetch(path, { method = 'GET', body = null, query = {} } = {}) {
  const token = getAdminToken();
  if (!token) {
    return { ok: false, error: 'No admin token set. Open the Property Directory settings to paste one.' };
  }

  const qs = new URLSearchParams(query);
  qs.set('secret', token);
  const url = `${path}?${qs.toString()}`;

  try {
    const res = await fetch(url, {
      method,
      headers: {
        'Content-Type': 'application/json',
        'X-Breeze-Admin-Token': token,
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await res.json().catch(() => ({ ok: false, error: `HTTP ${res.status}` }));
    if (!res.ok) return { ok: false, error: data.error || `HTTP ${res.status}`, status: res.status };
    return data;
  } catch (err) {
    return { ok: false, error: err.message || 'Network error' };
  }
}

// ── Owners ───────────────────────────────────────────────────────

export const owners = {
  list: () => adminFetch('/api/admin/owners'),
  get: (id) => adminFetch('/api/admin/owners', { query: { id } }),
  create: (body) => adminFetch('/api/admin/owners', { method: 'POST', body }),
  update: (id, body) =>
    adminFetch('/api/admin/owners', { method: 'PATCH', query: { id }, body }),
  delete: (id) => adminFetch('/api/admin/owners', { method: 'DELETE', query: { id } }),
};

// ── Properties ───────────────────────────────────────────────────

export const properties = {
  list: (ownerId) =>
    adminFetch('/api/admin/properties', { query: ownerId ? { ownerId } : {} }),
  get: (id) => adminFetch('/api/admin/properties', { query: { id } }),
  create: (body) => adminFetch('/api/admin/properties', { method: 'POST', body }),
  update: (id, body) =>
    adminFetch('/api/admin/properties', { method: 'PATCH', query: { id }, body }),
  delete: (id) => adminFetch('/api/admin/properties', { method: 'DELETE', query: { id } }),
};

// ── Property utilities ───────────────────────────────────────────

export const propertyUtilities = {
  list: (propertyId) =>
    adminFetch('/api/admin/property-utilities', { query: { propertyId } }),
  create: (body) =>
    adminFetch('/api/admin/property-utilities', { method: 'POST', body }),
  update: (id, body) =>
    adminFetch('/api/admin/property-utilities', { method: 'PATCH', query: { id }, body }),
  delete: (id) =>
    adminFetch('/api/admin/property-utilities', { method: 'DELETE', query: { id } }),
};

// ── Utility providers ────────────────────────────────────────────

export const utilityProviders = {
  list: () => adminFetch('/api/admin/utility-providers'),
  get: (id) => adminFetch('/api/admin/utility-providers', { query: { id } }),
  create: (body) => adminFetch('/api/admin/utility-providers', { method: 'POST', body }),
  update: (id, body) =>
    adminFetch('/api/admin/utility-providers', { method: 'PATCH', query: { id }, body }),
  delete: (id) =>
    adminFetch('/api/admin/utility-providers', { method: 'DELETE', query: { id } }),
};

// ── Seed ─────────────────────────────────────────────────────────

export const seed = {
  run: () => adminFetch('/api/admin/seed', { method: 'POST' }),
};

// ── Bulk import ──────────────────────────────────────────────────

export const bulkImport = {
  run: (body) => adminFetch('/api/admin/bulk-import', { method: 'POST', body }),
};

// ── Bulk utility config ─────────────────────────────────────────

export const bulkUtilityConfig = {
  // Preview + apply share the same endpoint. Pass dryRun:true for
  // preview, dryRun:false (or omit) to actually write.
  apply: (body) =>
    adminFetch('/api/admin/property-utilities-bulk', { method: 'POST', body }),
};

// ── Grid import ──────────────────────────────────────────────────

export const gridImport = {
  preview: (tsv) =>
    adminFetch('/api/admin/grid-import', { method: 'POST', body: { tsv, dryRun: true } }),
  commit: (tsv) =>
    adminFetch('/api/admin/grid-import', { method: 'POST', body: { tsv, dryRun: false } }),
};

// ── Backfill unit IDs ────────────────────────────────────────────

export const backfillUnitIds = {
  run: (tsv) =>
    adminFetch('/api/admin/backfill-unit-ids', { method: 'POST', body: { tsv } }),
};

// ── Move events ──────────────────────────────────────────────────

export const moveEvents = {
  list: () => adminFetch('/api/admin/move-events'),
  get: (id) => adminFetch('/api/admin/move-events', { query: { id } }),
  create: (body) => adminFetch('/api/admin/move-events', { method: 'POST', body }),
  update: (id, body) =>
    adminFetch('/api/admin/move-events', { method: 'PATCH', query: { id }, body }),
  delete: (id) => adminFetch('/api/admin/move-events', { method: 'DELETE', query: { id } }),
};
