// POST /api/admin/probe-integrations?secret=<TOKEN>
//
// Walks every probe in PROBES, runs it, and writes the result to
// integration_health via recordHealth. Cron-friendly (also a manual
// "test all" trigger from the UI). Per-probe failures don't stop the
// loop — each probe gets at least 10s before we give up.
//
// Returns one summary object per probe:
//   { name, display_name, ok, error?, ms, status_after }

import { withAdminHandler, getDefaultOrgId } from '../../lib/adminHelpers.js';
import { PROBES, recordHealth } from '../../lib/integrationHealth.js';

export const config = { maxDuration: 60 };

const PROBE_TIMEOUT_MS = 10_000;

async function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`probe timed out after ${ms}ms`)), ms),
    ),
  ]);
}

export default withAdminHandler(async (req, res) => {
  if (req.method !== 'POST' && req.method !== 'GET') {
    return res.status(405).json({ ok: false, error: 'POST or GET only' });
  }
  const organizationId = await getDefaultOrgId();

  const results = [];
  for (const [name, def] of Object.entries(PROBES)) {
    if (def.skipIfUnconfigured && def.skipIfUnconfigured()) {
      results.push({
        name,
        display_name: def.displayName,
        skipped: true,
        reason: 'env vars not configured',
      });
      continue;
    }
    const start = Date.now();
    let outcome;
    try {
      outcome = await withTimeout(def.probe(), PROBE_TIMEOUT_MS);
    } catch (err) {
      outcome = { ok: false, error: err.message || String(err) };
    }
    const ms = Date.now() - start;
    const update = await recordHealth(organizationId, name, def.displayName, outcome);
    results.push({
      name,
      display_name: def.displayName,
      ok: outcome.ok,
      error: outcome.error || null,
      ms,
      status_after: update?.status || null,
    });
  }

  return res.status(200).json({
    ok: true,
    organization_id: organizationId,
    probed_at: new Date().toISOString(),
    results,
  });
});
