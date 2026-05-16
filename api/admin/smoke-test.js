// GET /api/admin/smoke-test?secret=<TOKEN>
//
// Cheap, read-only probe of every critical subsystem. Designed to be
// hit by the GitHub Actions `run-smoke` workflow on a schedule (or
// after deploys) to catch regressions before users see them.
//
// Each check returns { ok, duration_ms, detail?, error? }. The overall
// response is `ok` iff every check is `ok`. Status code is always 200
// so the workflow can parse the body — the workflow asserts on
// `ok: true` itself.
//
// Checks (intentionally narrow — only things that must always work):
//   1. db_connect         — `SELECT 1`
//   2. db_org             — getDefaultOrgId() resolves
//   3. db_table_counts    — read counts from properties/units/leases/tenants
//   4. appfolio_configured — env vars present (does NOT call AppFolio)
//   5. clerk_configured   — env var present (does NOT call Clerk)
//   6. integration_health — reads the integration_health table

import { sql, eq } from 'drizzle-orm';
import {
  withAdminHandler,
  getDefaultOrgId,
  isClerkConfigured,
} from '../../lib/adminHelpers.js';
import { getDb, schema } from '../../lib/db/index.js';

export const config = { maxDuration: 30 };

const BUILD = 'smoke-v1';

export default withAdminHandler(async (req, res) => {
  if (req.method !== 'GET' && req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'GET or POST only' });
  }

  const checks = [];

  async function check(name, fn) {
    const t0 = Date.now();
    try {
      const detail = await fn();
      checks.push({ name, ok: true, duration_ms: Date.now() - t0, detail: detail ?? null });
    } catch (err) {
      checks.push({
        name,
        ok: false,
        duration_ms: Date.now() - t0,
        error: err?.message || String(err),
        stack: err?.stack ? String(err.stack).slice(0, 2000) : null,
      });
    }
  }

  const db = getDb();

  await check('db_connect', async () => {
    const r = await db.execute(sql`SELECT 1 AS one`);
    return { one: r?.[0]?.one ?? r?.rows?.[0]?.one ?? null };
  });

  let orgId = null;
  await check('db_org', async () => {
    orgId = await getDefaultOrgId();
    return { organization_id: orgId };
  });

  await check('db_table_counts', async () => {
    async function c(table) {
      const rows = await db
        .select({ c: sql`COUNT(*)`.as('c') })
        .from(table)
        .where(eq(table.organizationId, orgId));
      return Number(rows[0].c);
    }
    return {
      properties: orgId ? await c(schema.properties) : null,
      units: orgId ? await c(schema.units) : null,
      leases: orgId ? await c(schema.leases) : null,
      tenants: orgId ? await c(schema.tenants) : null,
      maintenance_tickets: orgId ? await c(schema.maintenanceTickets) : null,
    };
  });

  await check('appfolio_configured', async () => {
    const ok = Boolean(
      process.env.APPFOLIO_CLIENT_ID &&
        process.env.APPFOLIO_CLIENT_SECRET &&
        process.env.APPFOLIO_DEVELOPER_ID,
    );
    if (!ok) throw new Error('Missing APPFOLIO_* env vars');
    return { configured: true };
  });

  await check('clerk_configured', async () => {
    return { configured: isClerkConfigured() };
  });

  await check('integration_health', async () => {
    if (!orgId) return { skipped: 'no org' };
    const rows = await db
      .select({
        name: schema.integrationHealth.name,
        status: schema.integrationHealth.status,
        lastErrorMessage: schema.integrationHealth.lastErrorMessage,
        lastProbeAt: schema.integrationHealth.lastProbeAt,
      })
      .from(schema.integrationHealth)
      .where(eq(schema.integrationHealth.organizationId, orgId));
    return { rows };
  });

  const allOk = checks.every((c) => c.ok);
  return res.status(200).json({
    ok: allOk,
    build: BUILD,
    timestamp: new Date().toISOString(),
    checks,
  });
});
