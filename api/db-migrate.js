// Vercel Serverless Function — one-shot migration runner.
//
// POST /api/db-migrate?secret=<BREEZE_ADMIN_TOKEN>
//
// Applies any pending Drizzle migrations from lib/db/migrations against
// the configured DATABASE_URL. Idempotent — running it when everything
// is already applied is a no-op.
//
// This exists so you can migrate production (and preview) databases
// without installing Postgres tooling locally. The alternative is
// `npm run db:migrate` from a machine with `DATABASE_URL` in its
// environment; either works.
//
// Hidden behind the BREEZE_ADMIN_TOKEN shared-secret check because
// until Clerk lands in PR 4 there is no other auth on admin surfaces.
// Rotate the secret after Clerk is in.

import { migrate } from 'drizzle-orm/postgres-js/migrator';
import path from 'node:path';
import { getDb } from '../lib/db/index.js';

function isAuthorized(req) {
  const expected = process.env.BREEZE_ADMIN_TOKEN;
  if (!expected) {
    // No secret configured — allow. This keeps the very first provisioning
    // call unblocked. Set BREEZE_ADMIN_TOKEN immediately afterwards.
    return true;
  }
  const provided =
    req.query?.secret ||
    req.headers['x-breeze-admin-token'] ||
    (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  return provided === expected;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'POST only' });
  }
  if (!isAuthorized(req)) {
    return res.status(401).json({ ok: false, error: 'Unauthorized' });
  }

  try {
    const db = getDb();
    // Drizzle's migrator reads migration SQL files from this folder at
    // runtime. We bundle them as part of the deployment (Vercel ships
    // the full repo to each serverless function), so `process.cwd()` is
    // the project root.
    const migrationsFolder = path.join(process.cwd(), 'lib', 'db', 'migrations');
    const t0 = Date.now();
    await migrate(db, { migrationsFolder });
    const ms = Date.now() - t0;
    return res.status(200).json({
      ok: true,
      migrationsFolder,
      elapsedMs: ms,
      message: 'Migrations applied (or already up to date).',
    });
  } catch (err) {
    console.error('[db-migrate] failed:', err);
    return res.status(500).json({
      ok: false,
      error: err.message || String(err),
      stack: err.stack,
    });
  }
}
