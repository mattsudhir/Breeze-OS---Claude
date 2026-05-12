// Vercel build hook — runs pending migrations before bundling the
// React app. Vercel auto-detects this script (preferring it over
// "build") so every deploy keeps the DB schema in sync with the
// code being shipped.
//
// Silently skips when DATABASE_URL isn't set so local builds (and
// Preview deploys without a DB attached) don't fail.
//
// Failure modes:
//   - DATABASE_URL set but unreachable → exits non-zero (build fails
//     loudly so we don't ship code that can't talk to its DB).
//   - Migrations error mid-apply → drizzle's __drizzle_migrations
//     table records what already applied, so the next deploy picks
//     up from there.

import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';

const url =
  process.env.DATABASE_URL ||
  process.env.POSTGRES_URL ||
  process.env.POSTGRES_PRISMA_URL;

if (!url) {
  console.log('[build-migrate] No DATABASE_URL set — skipping migrations.');
  process.exit(0);
}

console.log('[build-migrate] Applying pending migrations…');
const client = postgres(url, {
  max: 1,
  idle_timeout: 5,
  connect_timeout: 10,
  prepare: false,
});
const db = drizzle(client);

try {
  await migrate(db, { migrationsFolder: './lib/db/migrations' });
  console.log('[build-migrate] Migrations applied (or already up-to-date).');
} catch (err) {
  console.error('[build-migrate] Migration failed:', err.message || err);
  await client.end();
  process.exit(1);
}

await client.end();
