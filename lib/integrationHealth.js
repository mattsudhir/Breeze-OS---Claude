// Integration health helpers — every sync / probe writes to one
// central table so the topbar can flash a red dot when something
// breaks and the user can see at a glance what's wrong.
//
// recordHealth(orgId, name, displayName, { ok, error })
//   - bumps consecutive_failures / successes
//   - rolls status: 3+ failures in a row → 'down', otherwise
//     'degraded' if there was a recent failure, else 'ok'.
//   - upsert by (organization_id, name) so callers never have to
//     check if the row exists.
//
// getAllHealth(orgId)
//   - returns the row per integration in display order.
//
// All times in UTC ISO strings.

import { and, eq, sql } from 'drizzle-orm';
import { getDb, schema } from './db/index.js';

// Threshold for flipping to 'down'. Set to 3 so a single flaky
// network blip doesn't tank the dot — but a real outage / bad creds
// shows up fast.
const DOWN_THRESHOLD = 3;

export async function recordHealth(organizationId, name, displayName, { ok, error }) {
  if (!organizationId || !name) return null;
  const db = getDb();
  const now = new Date();
  const errorMessage = (error?.message || error || '').toString().slice(0, 500) || null;

  // Existing row?
  const [existing] = await db
    .select()
    .from(schema.integrationHealth)
    .where(
      and(
        eq(schema.integrationHealth.organizationId, organizationId),
        eq(schema.integrationHealth.name, name),
      ),
    )
    .limit(1);

  if (!existing) {
    const initialFailures = ok ? 0 : 1;
    const initialSuccesses = ok ? 1 : 0;
    const status = ok ? 'ok' : (initialFailures >= DOWN_THRESHOLD ? 'down' : 'degraded');
    await db.insert(schema.integrationHealth).values({
      organizationId,
      name,
      displayName: displayName || name,
      status,
      lastSuccessAt: ok ? now : null,
      lastFailureAt: ok ? null : now,
      lastErrorMessage: ok ? null : errorMessage,
      lastProbeAt: now,
      consecutiveFailures: initialFailures,
      consecutiveSuccesses: initialSuccesses,
      updatedAt: now,
    });
    return { name, status, action: 'created' };
  }

  const consecutiveFailures = ok ? 0 : existing.consecutiveFailures + 1;
  const consecutiveSuccesses = ok ? existing.consecutiveSuccesses + 1 : 0;
  let status;
  if (ok) {
    // One success after a streak of failures = degraded; sustained =
    // ok. Two-success window keeps the dot from oscillating on a
    // recovering integration.
    status = consecutiveSuccesses >= 2 || !existing.lastFailureAt ? 'ok' : 'degraded';
  } else {
    status = consecutiveFailures >= DOWN_THRESHOLD ? 'down' : 'degraded';
  }

  await db
    .update(schema.integrationHealth)
    .set({
      displayName: displayName || existing.displayName,
      status,
      lastSuccessAt: ok ? now : existing.lastSuccessAt,
      lastFailureAt: ok ? existing.lastFailureAt : now,
      lastErrorMessage: ok ? existing.lastErrorMessage : errorMessage,
      lastProbeAt: now,
      consecutiveFailures,
      consecutiveSuccesses,
      updatedAt: now,
    })
    .where(eq(schema.integrationHealth.id, existing.id));

  return { name, status, action: 'updated' };
}

export async function getAllHealth(organizationId) {
  if (!organizationId) return [];
  const db = getDb();
  return db
    .select()
    .from(schema.integrationHealth)
    .where(eq(schema.integrationHealth.organizationId, organizationId))
    .orderBy(sql`CASE
      WHEN ${schema.integrationHealth.status} = 'down' THEN 0
      WHEN ${schema.integrationHealth.status} = 'degraded' THEN 1
      WHEN ${schema.integrationHealth.status} = 'unknown' THEN 2
      ELSE 3
    END`, schema.integrationHealth.displayName);
}

// Cheap "is this integration alive" probes. Each returns
// { ok: boolean, error?: string }. Add new integrations here — the
// probe endpoint walks the registry and writes the result.

export const PROBES = {
  appfolio_database: {
    displayName: 'AppFolio (Database API)',
    skipIfUnconfigured: () => !process.env.APPFOLIO_CLIENT_ID,
    probe: async () => {
      const clientId = (process.env.APPFOLIO_CLIENT_ID || '').trim();
      const clientSecret = (process.env.APPFOLIO_CLIENT_SECRET || '').trim();
      const developerId = (process.env.APPFOLIO_DEVELOPER_ID || '').trim();
      const baseUrl =
        (process.env.APPFOLIO_DATABASE_API_URL || '').trim() ||
        'https://api.appfolio.com/api/v0';
      const auth = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
      try {
        const r = await fetch(`${baseUrl}/properties?page%5Bsize%5D=1`, {
          headers: {
            Authorization: `Basic ${auth}`,
            Accept: 'application/json',
            'X-AppFolio-Developer-ID': developerId,
          },
        });
        if (r.status === 200) return { ok: true };
        const body = await r.text();
        return { ok: false, error: `HTTP ${r.status}: ${body.slice(0, 200)}` };
      } catch (err) {
        return { ok: false, error: err.message || String(err) };
      }
    },
  },
  bill_com: {
    displayName: 'Bill.com',
    skipIfUnconfigured: () =>
      !process.env.BILL_COM_USERNAME ||
      !process.env.BILL_COM_PASSWORD ||
      !process.env.BILL_COM_DEV_KEY,
    probe: async () => {
      try {
        const { isBillComConfigured, listRecentPayments } = await import('./backends/billcom.js');
        if (!isBillComConfigured()) return { ok: false, error: 'not configured' };
        // Cheapest call that exercises auth — fetch one recent
        // payment. If session-id login fails this throws.
        await listRecentPayments({ maxResults: 1 });
        return { ok: true };
      } catch (err) {
        return { ok: false, error: err.message || String(err) };
      }
    },
  },
  postgres: {
    displayName: 'Postgres',
    skipIfUnconfigured: () => !process.env.DATABASE_URL,
    probe: async () => {
      try {
        const db = getDb();
        await db.execute(sql`SELECT 1`);
        return { ok: true };
      } catch (err) {
        return { ok: false, error: err.message || String(err) };
      }
    },
  },
};
