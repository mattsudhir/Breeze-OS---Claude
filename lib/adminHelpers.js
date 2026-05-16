// Small helpers shared by every /api/admin/* endpoint.
//
// Auth model is in transition. Two valid auth sources, either grants
// admin access:
//
//   1. Clerk session — the React app's signed-in user. Verified
//      server-side via @clerk/backend's authenticateRequest(). Becomes
//      the only acceptable source once we drop the shared-token path.
//
//   2. BREEZE_ADMIN_TOKEN — the legacy shared-secret model. Accepted
//      via ?secret= query param, X-Breeze-Admin-Token header, or
//      Authorization: Bearer. Useful for ops scripts and curl while
//      Clerk is still being rolled out. Disabled (so only Clerk
//      counts) once CLERK_REQUIRED=true is set.
//
// Either check returning true → allow. The fallback to BREEZE_ADMIN_TOKEN
// is intentional during the transition; once every UI surface uses
// Clerk we'll remove it.
//
// Every admin endpoint also needs a default organization_id to scope
// its writes against. We look up (or lazily create) the first row in
// organizations and pretend it's "the" org. Future multi-tenant
// support resolves the user's actual org from the Clerk session.

import { getDb, schema } from './db/index.js';
import { createClerkClient } from '@clerk/backend';

// ── Clerk client ──────────────────────────────────────────────────────

// Cached per cold start. The constructor is light — the real I/O
// happens lazily inside authenticateRequest.
let cachedClerkClient = null;
function getClerkClient() {
  if (cachedClerkClient) return cachedClerkClient;
  const secretKey = process.env.CLERK_SECRET_KEY;
  const publishableKey = process.env.CLERK_PUBLISHABLE_KEY ||
    process.env.VITE_CLERK_PUBLISHABLE_KEY;
  if (!secretKey) return null;
  cachedClerkClient = createClerkClient({ secretKey, publishableKey });
  return cachedClerkClient;
}

export function isClerkConfigured() {
  return Boolean(process.env.CLERK_SECRET_KEY);
}

// ── Auth ──────────────────────────────────────────────────────────────

/**
 * Validate the request's Clerk session, if any.
 * @returns {Promise<{userId: string, sessionId: string} | null>}
 */
async function checkClerkSession(req) {
  const client = getClerkClient();
  if (!client) return null;
  try {
    // authenticateRequest accepts a standard Request object. Vercel's
    // Node API hands us a Node-style req — adapt by reconstructing
    // headers + URL.
    const url = new URL(
      req.url || '/',
      `https://${req.headers.host || 'localhost'}`,
    );
    const standardRequest = new Request(url, {
      method: req.method,
      headers: new Headers(req.headers),
    });
    const authState = await client.authenticateRequest(standardRequest);
    if (authState.status !== 'signed-in') return null;
    const claims = authState.toAuth();
    return { userId: claims.userId, sessionId: claims.sessionId };
  } catch (err) {
    console.warn('[admin] Clerk authenticateRequest threw', err.message);
    return null;
  }
}

/**
 * Returns true if the request carries a valid Clerk session OR a
 * valid BREEZE_ADMIN_TOKEN. When CLERK_REQUIRED=true is set, the
 * shared-token fallback is disabled and only Clerk sessions pass.
 *
 * BREEZE_ADMIN_TOKEN sources, any one:
 *   - ?secret=<token> query string
 *   - X-Breeze-Admin-Token header
 *   - Authorization: Bearer <token>
 *
 * If neither auth env var is set, isAdmin returns true (open mode)
 * so the very first provisioning call works on a fresh deployment.
 * Set at least one of (CLERK_SECRET_KEY, BREEZE_ADMIN_TOKEN) to
 * lock the surface down.
 */
export async function isAdmin(req) {
  // Cache the result on the request for handlers that re-check
  // downstream (e.g. composing helpers).
  if (req.__isAdmin !== undefined) return req.__isAdmin;

  // Clerk path first — if a session exists we accept it regardless of
  // the admin-token state.
  if (isClerkConfigured()) {
    const session = await checkClerkSession(req);
    if (session) {
      req.__clerkSession = session;
      req.__isAdmin = true;
      return true;
    }
  }

  // Optional kill switch for the legacy token path.
  if (process.env.CLERK_REQUIRED === 'true') {
    req.__isAdmin = false;
    return false;
  }

  const expected = process.env.BREEZE_ADMIN_TOKEN;
  if (!expected && !isClerkConfigured()) {
    // No auth configured at all → open mode. Cold-start convenience
    // for fresh deployments.
    req.__isAdmin = true;
    return true;
  }
  if (!expected) {
    req.__isAdmin = false;
    return false;
  }
  const provided =
    req.query?.secret ||
    req.headers['x-breeze-admin-token'] ||
    (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  req.__isAdmin = provided === expected;
  return req.__isAdmin;
}

/**
 * Standard 401 response for unauthenticated admin calls.
 */
export function unauthorized(res) {
  return res.status(401).json({ ok: false, error: 'Unauthorized' });
}

// ── CORS ──────────────────────────────────────────────────────────────

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

// ── Organisation context ──────────────────────────────────────────────

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

// ── Body parsing ──────────────────────────────────────────────────────

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

// ── Error helpers ─────────────────────────────────────────────────────

/**
 * Wrap a handler so any thrown error returns a structured 500 JSON
 * response with the error message (and stack in dev-like mode).
 *
 * Also persists every failure to admin_error_log so ops (and the
 * GitHub Actions diagnostic workflow) can pull the last N errors
 * with full stack traces — no Vercel-log spelunking required. The
 * persist is best-effort and never throws back into the handler.
 */
export function withAdminHandler(handlerFn) {
  return async (req, res) => {
    if (applyCors(req, res)) return;
    if (!(await isAdmin(req))) return unauthorized(res);
    try {
      await handlerFn(req, res);
    } catch (err) {
      console.error('[admin]', req.url, err);
      // Fire-and-forget — never block the response on logging.
      persistAdminError(req, err, 500).catch(() => {});
      return res.status(500).json({
        ok: false,
        error: err.message || String(err),
      });
    }
  };
}

/**
 * Append-only audit-log write. Call from any admin endpoint that
 * mutates state. Best-effort: failures are logged + swallowed
 * (audit logging must never break the underlying operation).
 *
 * Usage:
 *
 *   await recordAudit(req, {
 *     action: 'UPDATE',                 // CREATE | UPDATE | DELETE | CUSTOM:<name>
 *     table: 'tenants',                 // target_table
 *     id: tenant.id,                    // target_id (text-coerced)
 *     before: { email: oldEmail, ... }, // optional pre-change snapshot
 *     after:  { email: newEmail, ... }, // optional post-change snapshot
 *     diff:   { email: { from: oldEmail, to: newEmail } }, // optional
 *     context: { reason: 'user-edit' }, // optional structured extra
 *   });
 *
 * Actor resolution:
 *   - Clerk session attached by isAdmin() → 'clerk_user' + userId
 *   - Admin token only → 'admin_token'
 *   - Neither (cron, internal) → 'unknown'
 */
export async function recordAudit(req, entry) {
  try {
    const db = getDb();
    let actorType = 'unknown';
    let actorId = null;
    if (req.__clerkSession?.userId) {
      actorType = 'clerk_user';
      actorId = req.__clerkSession.userId;
    } else if (req.__isAdmin) {
      actorType = 'admin_token';
    }
    await db.insert(schema.adminAuditLog).values({
      actorType,
      actorId,
      path: req.url || req.originalUrl || 'unknown',
      method: req.method || 'unknown',
      action: entry.action,
      targetTable: entry.table || null,
      targetId: entry.id != null ? String(entry.id) : null,
      before: entry.before ?? null,
      after: entry.after ?? null,
      diff: entry.diff ?? null,
      ipAddress: (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || null,
      userAgent: req.headers['user-agent'] || null,
      context: entry.context ?? null,
    });
  } catch (err) {
    // Audit logging must never throw. Log to function logs and move on.
    console.warn('[recordAudit] failed:', err?.message || err);
  }
}

// Best-effort write to admin_error_log. Swallows its own errors so a
// broken log table never masks the actual handler error.
async function persistAdminError(req, err, status) {
  try {
    const db = getDb();
    await db.insert(schema.adminErrorLog).values({
      path: req.url || req.originalUrl || 'unknown',
      method: req.method || 'unknown',
      status,
      message: (err && err.message) ? String(err.message).slice(0, 2000) : String(err).slice(0, 2000),
      stack: err && err.stack ? String(err.stack).slice(0, 8000) : null,
      context: {
        query: req.query || null,
        // body is intentionally NOT captured — it may contain secrets
        // (admin tokens in body, PII, etc.). Path + query is enough
        // for diagnosis; the stack trace gives us the rest.
      },
    });
  } catch {
    // noop — logging must never throw.
  }
}
