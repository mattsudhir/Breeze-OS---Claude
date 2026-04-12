// Vercel Serverless Function — proxies requests to Rent Manager API
// Keeps credentials server-side so they're never exposed to the browser.
//
// Environment variables (set in Vercel dashboard):
//   RM_BASE_URL  – e.g. https://sample15.api.rentmanager.com
//   RM_USERNAME  – e.g. admin
//   RM_PASSWORD  – e.g. Apr-07-sample15

import { rmCall } from '../lib/rmClient.js';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  const startedAt = Date.now();
  try {
    // Extract the Rent Manager endpoint path from the request URL
    // e.g. /api/Properties?filters=... → /Properties?filters=...
    const url = new URL(req.url, `http://${req.headers.host}`);
    const rmPath = url.pathname.replace(/^\/api/, '') || '/';
    const queryString = url.search || '';
    const fullPath = `${rmPath}${queryString}`;

    let body;
    if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method) && req.body) {
      body = typeof req.body === 'string' ? req.body : JSON.stringify(req.body);
    }

    console.log(`[rmProxy] → ${req.method} ${fullPath}`);
    const result = await rmCall(fullPath, { method: req.method, body });
    const ms = Date.now() - startedAt;
    console.log(
      `[rmProxy] ← ${req.method} ${fullPath} ${result.status} (${ms}ms)` +
      (Array.isArray(result.data) ? ` [${result.data.length} items]` : ''),
    );

    return res.status(result.status).json(result);
  } catch (err) {
    const ms = Date.now() - startedAt;
    console.error(`[rmProxy] ✗ ${req.method} ${req.url} failed after ${ms}ms:`, err);
    return res.status(500).json({ ok: false, error: err.message });
  }
}
