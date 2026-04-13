// Small helpers shared by every /api/admin/* endpoint.
//
// Until Clerk (or another real auth provider) lands, every admin-only
// endpoint is gated by a shared-secret BREEZE_ADMIN_TOKEN. This module
// centralises the check so we can't accidentally ship an admin route
// that forgot to authenticate.
//
// Every admin endpoint also needs a default organization_id to scope
// its writes against, since the schema enforces a foreign key to
// organizations. For now we look up (or lazily create) the first
// organization in the table and pretend it's "the" org — this will be
// replaced with a real org lookup once Clerk provides the user's org
// membership.

import { getDb, schema } from './db/index.js';

// ── Auth ─────────────────────────────────────────────────────────

/**
 * Returns true if the request carries a valid BREEZE_ADMIN_TOKEN.
 * Accepts the token via query param, Authorization: Bearer header,
 * or X-Breeze-Admin-Token header — whichever is most convenient for
 * the caller. If the env var itself is unset, this returns true so
 * that the very first provisioning calls work; set the env var
 * immediately afterwards to lock things down.
 */
export function isAdmin(req) {
  const expected = process.env.BREEZE_ADMIN_TOKEN;
  if (!expected) return true;
  const provided =
    req.query?.secret ||
    req.headers['x-breeze-admin-token'] ||
    (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  return provided === expected;
}

/**
 * Standard 401 response for unauthenticated admin calls.
 */
export function unauthorized(res) {
  return res.status(401).json({ ok: false, error: 'Unauthorized' });
}

// ── CORS ─────────────────────────────────────────────────────────

/**
 * Set permissive CORS headers so the React frontend (served from the
 * same Vercel domain) can call these endpoints without preflight pain.
 * Short-circuits OPTIONS preflights by returning 204.
 */
export function applyCors(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
  res.setHeader(
    'Access-Control-Allow-Headers',
    'Content-Type, Authorization, X-Breeze-Admin-Token',
  );
  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return true;
  }
  return false;
}

// ── Organisation context ─────────────────────────────────────────

// Cached per serverless instance after the first lookup.
let cachedDefaultOrgId = null;

/**
 * Resolve the organization_id all admin writes should belong to.
 *
 * Strategy: look for an existing row in `organizations` and return
 * its id. If none exists, create one called "Breeze" on the fly so
 * the first admin call has something to scope against. Once Clerk
 * ships with real multi-tenancy, this becomes a lookup against the
 * authenticated user's membership instead.
 */
export async function getDefaultOrgId() {
  if (cachedDefaultOrgId) return cachedDefaultOrgId;
  const db = getDb();
  const existing = await db.select().from(schema.organizations).limit(1);
  if (existing.length > 0) {
    cachedDefaultOrgId = existing[0].id;
    return cachedDefaultOrgId;
  }
  const [created] = await db
    .insert(schema.organizations)
    .values({ name: 'Breeze' })
    .returning();
  cachedDefaultOrgId = created.id;
  return cachedDefaultOrgId;
}

// ── Body parsing ─────────────────────────────────────────────────

/**
 * Vercel parses req.body for application/json automatically, but it
 * can arrive as undefined, a parsed object, or a raw string depending
 * on content type. This helper normalises to a plain object and
 * returns {} on anything unparseable.
 */
export function parseBody(req) {
  if (!req.body) return {};
  if (typeof req.body === 'object') return req.body;
  if (typeof req.body === 'string') {
    try {
      return JSON.parse(req.body);
    } catch {
      return {};
    }
  }
  return {};
}

// ── Error helpers ────────────────────────────────────────────────

/**
 * Wrap a handler so any thrown error returns a structured 500 JSON
 * response with the error message (and stack in dev-like mode).
 */
export function withAdminHandler(handlerFn) {
  return async (req, res) => {
    if (applyCors(req, res)) return;
    if (!isAdmin(req)) return unauthorized(res);
    try {
      await handlerFn(req, res);
    } catch (err) {
      console.error('[admin]', req.url, err);
      return res.status(500).json({
        ok: false,
        error: err.message || String(err),
      });
    }
  };
}
