// POST /api/admin/run-migrations?secret=<TOKEN>
//
// Applies any pending SQL migration files in lib/db/migrations
// against the live database. Drizzle tracks state in the
// __drizzle_migrations system table; this endpoint is idempotent —
// running it when everything's up-to-date is a no-op.
//
// Why this exists: Vercel auto-deploys code but does not run DB
// migrations. When a schema change ships (e.g. a new column on
// `organizations`), the code's SELECT expects that column while the
// DB still doesn't have it, and every query touching the table
// returns "column does not exist". This endpoint closes the gap so
// migrations can be run from the browser (or curl) without a
// terminal + DATABASE_URL on hand.
//
// Returns the list of migration tags applied this run plus the
// full list now present in the journal. The drizzle-orm migrator
// applies any unapplied migrations in journal order and ignores
// the rest, so the "newly applied" list shows exactly what changed.

import path from 'node:path';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { sql } from 'drizzle-orm';
import { withAdminHandler } from '../../lib/adminHelpers.js';
import { getDb } from '../../lib/db/index.js';

async function listAppliedMigrations(db) {
  try {
    const result = await db.execute(sql`
      SELECT hash, created_at
      FROM drizzle.__drizzle_migrations
      ORDER BY created_at ASC
    `);
    const rows = result.rows ?? result;
    return rows.map((r) => ({
      hash: r.hash,
      created_at: r.created_at,
    }));
  } catch {
    // Table doesn't exist yet on a virgin DB — that's fine, migrator
    // will create it.
    return [];
  }
}

export default withAdminHandler(async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'POST only' });
  }

  const db = getDb();
  const migrationsFolder = path.resolve(process.cwd(), 'lib/db/migrations');

  const beforeRows = await listAppliedMigrations(db);
  const before = new Set(beforeRows.map((r) => r.hash));

  let migrateError = null;
  try {
    await migrate(db, { migrationsFolder });
  } catch (err) {
    migrateError = err;
  }

  const afterRows = await listAppliedMigrations(db);
  const newlyApplied = afterRows.filter((r) => !before.has(r.hash));

  if (migrateError) {
    return res.status(500).json({
      ok: false,
      error: migrateError.message || String(migrateError),
      newly_applied: newlyApplied.length,
      newly_applied_hashes: newlyApplied.map((r) => r.hash),
      total_applied: afterRows.length,
    });
  }

  return res.status(200).json({
    ok: true,
    migrations_folder: migrationsFolder,
    newly_applied: newlyApplied.length,
    newly_applied_hashes: newlyApplied.map((r) => r.hash),
    total_applied: afterRows.length,
    message:
      newlyApplied.length === 0
        ? 'Database is up to date — no migrations needed.'
        : `Applied ${newlyApplied.length} migration(s).`,
  });
});
