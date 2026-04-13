// Vercel Serverless Function — Postgres connectivity + migration health check.
//
// GET /api/db-health
//
// Returns 200 with a small status object if the DB is reachable and the
// schema is in place. Returns 500 with a diagnostic string otherwise.
//
// Useful after provisioning Vercel Postgres for the first time:
//   1. Attach the store to the project (Vercel → Storage → Create → Postgres)
//   2. Run `npm run db:migrate` (or the one-shot /api/db-migrate endpoint,
//      PR 2) so the tables exist
//   3. Hit /api/db-health — you should see {"ok": true, ...}
//
// Query params:
//   ?secret=<BREEZE_ADMIN_TOKEN>  — required unless env is unset
//
// Hidden behind the same admin token shared secret we use for the
// property-directory CRUD (PR 2). Until Clerk lands there is no other
// auth layer, so we shouldn't make internal state cheaply observable.

import { sql } from 'drizzle-orm';
import { getDb } from '../lib/db/index.js';

function isAuthorized(req) {
  const expected = process.env.BREEZE_ADMIN_TOKEN;
  if (!expected) return true; // no token set → open (dev / first boot)
  const provided =
    req.query?.secret ||
    req.headers['x-breeze-admin-token'] ||
    (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  return provided === expected;
}

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ ok: false, error: 'GET only' });
  }

  if (!isAuthorized(req)) {
    return res.status(401).json({ ok: false, error: 'Unauthorized' });
  }

  try {
    const db = getDb();

    // Cheapest query that exercises the real connection path.
    const ping = await db.execute(sql`select 1 as ok`);

    // Confirm at least one of our tables exists so we can tell migration
    // state apart from connectivity. `organizations` is the first one
    // created by the initial migration.
    let tables = [];
    let migrationApplied = false;
    try {
      const result = await db.execute(sql`
        select table_name
        from information_schema.tables
        where table_schema = 'public'
        order by table_name
      `);
      tables = Array.isArray(result) ? result.map((r) => r.table_name) : [];
      migrationApplied = tables.includes('organizations');
    } catch (err) {
      // If the information_schema query fails, we're connected but in a
      // very unhealthy state. Fall through and report it.
      return res.status(500).json({
        ok: false,
        connected: true,
        migrationApplied: false,
        error: `Schema introspection failed: ${err.message}`,
      });
    }

    return res.status(200).json({
      ok: true,
      connected: true,
      migrationApplied,
      tableCount: tables.length,
      tables,
      ping,
    });
  } catch (err) {
    return res.status(500).json({
      ok: false,
      error: err.message || String(err),
    });
  }
}
