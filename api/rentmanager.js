// Vercel Serverless Function — proxies requests to Rent Manager API
// Keeps credentials server-side so they're never exposed to the browser.
//
// Environment variables (set in Vercel dashboard):
//   RM_BASE_URL  – e.g. https://sample15.api.rentmanager.com
//   RM_USERNAME  – e.g. admin
//   RM_PASSWORD  – e.g. Apr-07-sample15

const RM_BASE = process.env.RM_BASE_URL || 'https://sample15.api.rentmanager.com';
const RM_USER = process.env.RM_USERNAME || 'admin';
const RM_PASS = process.env.RM_PASSWORD || 'Apr-07-sample15';

// In-memory token cache (lives for the duration of the serverless instance)
let cachedToken = null;
let tokenExpiry = 0;

async function getToken() {
  if (cachedToken && Date.now() < tokenExpiry) {
    return cachedToken;
  }

  const res = await fetch(`${RM_BASE}/Authentication/AuthorizeUser`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      Username: RM_USER,
      Password: RM_PASS,
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Auth failed (${res.status}): ${text}`);
  }

  // Rent Manager returns the token as a plain string (with quotes)
  let token = await res.text();
  token = token.replace(/^"|"$/g, ''); // strip surrounding quotes if present

  cachedToken = token;
  // Cache for 55 minutes (tokens typically last 60 min)
  tokenExpiry = Date.now() + 55 * 60 * 1000;

  return token;
}

export default async function handler(req, res) {
  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  try {
    // Extract the Rent Manager endpoint path from the request URL
    // e.g. /api/Properties?filters=... → /Properties?filters=...
    const url = new URL(req.url, `http://${req.headers.host}`);
    const rmPath = url.pathname.replace(/^\/api/, '') || '/';
    const queryString = url.search || '';

    const token = await getToken();

    const rmUrl = `${RM_BASE}${rmPath}${queryString}`;

    const fetchOptions = {
      method: req.method,
      headers: {
        'Content-Type': 'application/json',
        'X-RM12Api-ApiToken': token,
      },
    };

    // Forward body for write methods
    if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method) && req.body) {
      fetchOptions.body = typeof req.body === 'string' ? req.body : JSON.stringify(req.body);
    }

    const rmRes = await fetch(rmUrl, fetchOptions);

    // Try to parse as JSON, fall back to text
    const contentType = rmRes.headers.get('content-type') || '';
    let data;
    if (contentType.includes('application/json')) {
      data = await rmRes.json();
    } else {
      data = await rmRes.text();
    }

    return res.status(rmRes.status).json({
      ok: rmRes.ok,
      status: rmRes.status,
      data,
    });
  } catch (err) {
    console.error('Rent Manager proxy error:', err);
    return res.status(500).json({
      ok: false,
      error: err.message,
    });
  }
}
