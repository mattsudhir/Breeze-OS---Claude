// POST /api/admin/run-reimport?secret=<TOKEN>
//
// One-call orchestrator for the clean-slate AppFolio re-import. Runs:
//   1. wipe-directory-data           (apply, not dry-run)
//   2. import-appfolio-properties
//   3. import-appfolio-units
//   4. sync-appfolio-leases-all       (looped until has_more=false)
//   5. sync-appfolio-tickets
//
// Calls each step via fetch back to this same host so each gets its
// own Vercel function invocation (and its own maxDuration budget).
// Wraps every call in try/catch and captures err.stack so the
// response always self-identifies which step blew up and why.
//
// Wall-clock budget is 270s, leaving 30s headroom under maxDuration=300.
// If we run out of clock during the leases loop, the response says
// `resumable_from: { step: 'leases', offset: N }` — caller can POST
// again with `?resume_from_offset=N` to continue without re-wiping.
//
// Response shape (always 200 unless auth fails):
//   {
//     ok: <every step ok?>,
//     build: 'orchestrator-v1',
//     elapsed_ms,
//     steps: [{ name, ok, status, duration_ms, result | error | stack }, ...],
//     completed: true | false,
//     failed_at: <step name> | null,
//     resumable_from: { step, offset } | null,
//   }

import { withAdminHandler } from '../../lib/adminHelpers.js';

export const config = { maxDuration: 300 };

const BUILD = 'orchestrator-v1';
const WALL_CLOCK_BUDGET_MS = 270_000;
const LEASES_BATCH_LIMIT = 10;
const LEASES_MAX_ITERATIONS = 200; // hard ceiling so a misbehaving has_more never loops forever

export default withAdminHandler(async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, build: BUILD, error: 'POST only' });
  }

  // Reconstruct the base URL from request headers — works on Vercel
  // production, preview, and local `vercel dev`.
  const host = req.headers.host;
  const proto = req.headers['x-forwarded-proto'] || 'https';
  const baseUrl = `${proto}://${host}`;

  // The token the caller used — re-attach to every sub-call so each
  // /api/admin/* endpoint passes its own isAdmin() check.
  const token =
    req.query?.secret ||
    req.headers['x-breeze-admin-token'] ||
    (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (!token) {
    return res.status(401).json({ ok: false, build: BUILD, error: 'Missing admin token' });
  }

  const resumeFromOffset = Number(req.query?.resume_from_offset ?? -1);
  const skipWipe = req.query?.skip_wipe === 'true' || resumeFromOffset >= 0;

  const startedAt = Date.now();
  const steps = [];

  function overBudget() {
    return Date.now() - startedAt > WALL_CLOCK_BUDGET_MS;
  }

  async function callStep(name, path, { method = 'POST', body = null } = {}) {
    const t0 = Date.now();
    try {
      const url = new URL(path, baseUrl);
      url.searchParams.set('secret', token);
      const resp = await fetch(url.toString(), {
        method,
        headers: {
          'Content-Type': 'application/json',
          'X-Breeze-Admin-Token': token,
        },
        body: body ? JSON.stringify(body) : undefined,
      });
      const text = await resp.text();
      let data;
      try {
        data = JSON.parse(text);
      } catch {
        data = { ok: false, error: 'non-JSON response', body_snippet: text.slice(0, 500) };
      }
      const ok = resp.ok && data.ok !== false;
      steps.push({
        name,
        ok,
        status: resp.status,
        duration_ms: Date.now() - t0,
        result: data,
      });
      return { ok, data };
    } catch (err) {
      steps.push({
        name,
        ok: false,
        duration_ms: Date.now() - t0,
        error: err.message || String(err),
        stack: err.stack || null,
      });
      return { ok: false, data: null };
    }
  }

  function respond(extra = {}) {
    const allOk = steps.every((s) => s.ok);
    return res.status(200).json({
      ok: allOk,
      build: BUILD,
      elapsed_ms: Date.now() - startedAt,
      steps,
      completed: extra.completed === true,
      failed_at: extra.failed_at || null,
      resumable_from: extra.resumable_from || null,
      ...extra,
    });
  }

  // ── 1. Wipe ────────────────────────────────────────────────────
  if (!skipWipe) {
    const wipe = await callStep('wipe', '/api/admin/wipe-directory-data', {
      body: { dry_run: false },
    });
    if (!wipe.ok) return respond({ failed_at: 'wipe' });
    if (overBudget()) return respond({ failed_at: 'wall_clock', resumable_from: { step: 'import_properties' } });
  }

  // ── 2. Import properties ───────────────────────────────────────
  if (resumeFromOffset < 0) {
    const props = await callStep('import_properties', '/api/admin/import-appfolio-properties');
    if (!props.ok) return respond({ failed_at: 'import_properties' });
    if (overBudget()) return respond({ failed_at: 'wall_clock', resumable_from: { step: 'import_units' } });
  }

  // ── 3. Import units ────────────────────────────────────────────
  if (resumeFromOffset < 0) {
    const units = await callStep('import_units', '/api/admin/import-appfolio-units');
    if (!units.ok) return respond({ failed_at: 'import_units' });
    if (overBudget()) return respond({ failed_at: 'wall_clock', resumable_from: { step: 'leases', offset: 0 } });
  }

  // ── 4. Loop sync leases until has_more=false ───────────────────
  let offset = resumeFromOffset >= 0 ? resumeFromOffset : 0;
  let iter = 0;
  while (true) {
    if (overBudget()) {
      return respond({
        failed_at: 'wall_clock',
        resumable_from: { step: 'leases', offset },
      });
    }
    if (iter >= LEASES_MAX_ITERATIONS) {
      return respond({
        failed_at: 'leases_iteration_ceiling',
        resumable_from: { step: 'leases', offset },
      });
    }
    iter += 1;
    const r = await callStep(`leases_batch_${iter}_offset_${offset}`, '/api/admin/sync-appfolio-leases-all', {
      body: { offset, limit: LEASES_BATCH_LIMIT },
    });
    if (!r.ok) {
      return respond({
        failed_at: `leases_batch_${iter}`,
        resumable_from: { step: 'leases', offset },
      });
    }
    const d = r.data || {};
    if (!d.has_more) break;
    offset = typeof d.next_offset === 'number' ? d.next_offset : offset + LEASES_BATCH_LIMIT;
  }

  // ── 5. Sync tickets ────────────────────────────────────────────
  if (overBudget()) {
    return respond({ failed_at: 'wall_clock', resumable_from: { step: 'tickets' } });
  }
  const tickets = await callStep('sync_tickets', '/api/admin/sync-appfolio-tickets', {
    body: { status: 'all' },
  });
  if (!tickets.ok) return respond({ failed_at: 'sync_tickets' });

  return respond({ completed: true });
});
