// Shared Rent Manager API client used by both the /api/rentmanager proxy
// and /api/chat (LLM tool calls). Handles token auth + caching.

const RM_BASE = process.env.RM_BASE_URL || 'https://sample15.api.rentmanager.com';
const RM_USER = process.env.RM_USERNAME || 'admin';
const RM_PASS = process.env.RM_PASSWORD || 'Apr-07-sample15';

let cachedToken = null;
let tokenExpiry = 0;

export async function getToken() {
  if (cachedToken && Date.now() < tokenExpiry) return cachedToken;

  const res = await fetch(`${RM_BASE}/Authentication/AuthorizeUser`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ Username: RM_USER, Password: RM_PASS }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`RM auth failed (${res.status}): ${text}`);
  }

  let token = await res.text();
  token = token.replace(/^"|"$/g, '');

  cachedToken = token;
  tokenExpiry = Date.now() + 55 * 60 * 1000;
  return token;
}

// Generic call: rmCall('/Tenants', { method: 'GET' })
// Returns { ok, status, data } regardless of success
export async function rmCall(path, options = {}) {
  const token = await getToken();
  const url = `${RM_BASE}${path}`;
  const res = await fetch(url, {
    method: options.method || 'GET',
    headers: {
      'Content-Type': 'application/json',
      'X-RM12Api-ApiToken': token,
    },
    body: options.body,
  });

  const contentType = res.headers.get('content-type') || '';
  let data;
  if (contentType.includes('application/json')) {
    data = await res.json();
  } else {
    data = await res.text();
  }
  return { ok: res.ok, status: res.status, data };
}
