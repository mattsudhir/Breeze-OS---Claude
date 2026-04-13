// Shared Rent Manager API client used by both the /api/rentmanager proxy
// and /api/chat (LLM tool calls). Handles token auth + caching.
//
// TODO(later): replace the per-instance token cache below with a shared
// Vercel KV store. Each cold Vercel serverless instance currently creates
// its own RM session via /Authentication/AuthorizeUser, and the demo
// account has a concurrent-session cap. With KV, all instances would
// share a single cached token and we'd stop burning sessions on cold
// starts. See auth retry workaround in getToken() for the current band-aid.

const RM_BASE = process.env.RM_BASE_URL || 'https://sample15.api.rentmanager.com';
const RM_USER = process.env.RM_USERNAME || 'admin';
const RM_PASS = process.env.RM_PASSWORD || 'Apr-07-sample15';

let cachedToken = null;
let tokenExpiry = 0;

const MAX_SESSIONS_RE = /already logged in maximum number/i;
const TOKEN_TTL_MS = 55 * 60 * 1000; // 55 minutes

async function authOnce() {
  const res = await fetch(`${RM_BASE}/Authentication/AuthorizeUser`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ Username: RM_USER, Password: RM_PASS }),
  });
  const text = await res.text();
  if (!res.ok) {
    const err = new Error(`RM auth failed (${res.status}): ${text}`);
    err.status = res.status;
    err.body = text;
    err.isMaxSessions = MAX_SESSIONS_RE.test(text);
    throw err;
  }
  return text.replace(/^"|"$/g, '');
}

export async function getToken() {
  if (cachedToken && Date.now() < tokenExpiry) return cachedToken;

  // Retry logic for the "already logged in maximum number of times" error.
  // The RM demo account has a concurrent session cap and we hit it when
  // multiple Vercel serverless instances cold-start around the same time.
  // Waiting a few seconds lets earlier sessions expire / allows another
  // warm instance to succeed and share its token.
  const maxAttempts = 4;
  const backoffs = [0, 1500, 3500, 6000]; // ms delay before each attempt
  let lastErr;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (backoffs[attempt]) {
      await new Promise((r) => setTimeout(r, backoffs[attempt]));
    }
    try {
      const token = await authOnce();
      cachedToken = token;
      tokenExpiry = Date.now() + TOKEN_TTL_MS;
      return token;
    } catch (err) {
      lastErr = err;
      // Only retry the max-sessions error. 401/invalid password etc. fail fast.
      if (!err.isMaxSessions) throw err;
      console.warn(`[rmAuth] max sessions, attempt ${attempt + 1}/${maxAttempts}, will retry`);
    }
  }
  throw lastErr;
}

// Called after a successful API call that returned 401 mid-request —
// forces a fresh auth on next call.
export function invalidateToken() {
  cachedToken = null;
  tokenExpiry = 0;
}

// Generic call: rmCall('/Tenants', { method: 'GET' })
// Returns { ok, status, data } regardless of success.
//
// If RM returns 401 mid-request, we assume the cached token has gone
// stale (RM can invalidate sessions before our local 55-min TTL expires
// — e.g. a concurrent login booted us, or the demo-account password
// rotated). We invalidate the cache, force a fresh auth, and retry once
// before surfacing the error to the caller.
export async function rmCall(path, options = {}) {
  const doFetch = async () => {
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
  };

  let result = await doFetch();
  if (result.status === 401) {
    invalidateToken();
    result = await doFetch();
  }
  return result;
}
