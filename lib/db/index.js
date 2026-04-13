// Serverless-friendly Drizzle client factory.
//
// Vercel serverless functions cold-start a new instance for each
// concurrent request. Opening a fresh Postgres TCP connection per cold
// start is the fast path to exhausting the 5-minute connection limit
// on small DB tiers. We use `postgres` (porsager/postgres) in its
// connection-pool mode backed by Vercel Postgres / Neon's pgbouncer
// endpoint, which safely multiplexes many short-lived requests over a
// small number of real DB connections.
//
// Environment variables:
//   DATABASE_URL           — full connection string. Vercel Postgres
//                            injects this automatically when you attach
//                            the store to the project. Prefer the
//                            pooled URL (`...?pgbouncer=true`) when
//                            available.
//   POSTGRES_URL           — alternate name Vercel also injects; used as
//                            a fallback if DATABASE_URL isn't set.
//
// If neither env var is set, getDb() throws a clear error rather than
// returning a broken client, so serverless invocations fail fast with
// a readable message instead of crashing deep inside a query.

import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import * as schema from './schema.js';

let cachedDb = null;

function resolveConnectionString() {
  return (
    process.env.DATABASE_URL ||
    process.env.POSTGRES_URL ||
    process.env.POSTGRES_PRISMA_URL ||
    null
  );
}

// Lazy singleton — first caller inside a given serverless instance
// builds the client; later calls reuse it. Reset only on invalidation.
export function getDb() {
  if (cachedDb) return cachedDb;

  const url = resolveConnectionString();
  if (!url) {
    const err = new Error(
      'DATABASE_URL is not configured. Provision Vercel Postgres (Storage → ' +
        'Create → Postgres) and attach it to this project, or set DATABASE_URL ' +
        'manually in Settings → Environment Variables.',
    );
    err.status = 500;
    throw err;
  }

  // Connection pooling: `max: 1` is the serverless sweet spot. Each
  // function instance keeps one real TCP connection alive and lets
  // pgbouncer/Neon multiplex at the server side. Raising this doesn't
  // help throughput (we serve one request per instance) and costs
  // connection-limit headroom.
  const client = postgres(url, {
    max: 1,
    idle_timeout: 20,
    connect_timeout: 10,
    prepare: false, // pgbouncer transaction mode doesn't support prepared statements
  });

  cachedDb = drizzle(client, { schema });
  cachedDb.__rawClient = client; // expose for migrations / health checks
  return cachedDb;
}

// Expose the schema so callers can do
//   import { getDb, schema } from '../lib/db/index.js'
export { schema };
