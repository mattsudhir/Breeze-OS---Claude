// GET|POST /api/admin/backfill-appfolio-unit-ids?secret=<TOKEN>
//   &dry_run=true|false   (default true)
//   &limit=<n>&offset=<n> (property batch — UI loops until has_more=false)
//
// Reconciles our units to AppFolio units and writes source_unit_id.
//
// Why: bulk-import populated units from a CSV with only source_unit_name
// (no AppFolio UnitId). The lease sync name-matches as it goes, but a
// CSV unit name that doesn't line up with AppFolio's leaves the unit
// unmatched — and its tenant can't attach, so the unit looks vacant.
// This is a focused, idempotent reconciliation pass: better matching
// than the inline path, plus a clean report of anything it genuinely
// can't auto-match so it can be hand-mapped.
//
// Matching strategies, in priority order, scoped within each property:
//   1. source_unit_id already set + still valid          → skip
//   2. exact name  (our source_unit_name === AF name field)
//   3. normalized name (lowercased, punctuation/space-stripped)
//   4. unit-number token (trailing alnum token of each name)
//   5. SFR 1:1 (exactly one unit on each side)
//
// Defaults to dry_run — review the plan, then re-run with dry_run=false.

import { and, eq, isNotNull, asc } from 'drizzle-orm';
import {
  withAdminHandler,
  getDefaultOrgId,
  parseBody,
} from '../../lib/adminHelpers.js';
import { getDb, schema } from '../../lib/db/index.js';
import { fetchAllPages } from '../../lib/backends/appfolio.js';
import { recordHealth } from '../../lib/integrationHealth.js';

export const config = { maxDuration: 300 };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isAppfolioConfigured() {
  return Boolean(
    process.env.APPFOLIO_CLIENT_ID &&
      process.env.APPFOLIO_CLIENT_SECRET &&
      process.env.APPFOLIO_DEVELOPER_ID,
  );
}

// Lowercase, drop punctuation, collapse whitespace.
function normalize(s) {
  return (s || '')
    .toString()
    .trim()
    .toLowerCase()
    .replace(/[.,#/\\-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Trailing alphanumeric token — "2445-09" -> "09", "Apt B" -> "b",
// "Unit 12" -> "12". Used as a last-ditch match key.
function unitToken(s) {
  const parts = normalize(s).split(' ').filter(Boolean);
  return parts.length ? parts[parts.length - 1] : '';
}

// All the name-ish fields AppFolio puts on a /units row.
function afUnitNames(au) {
  return [au.Name, au.UnitNumber, au.Address1, au.Address2].filter(Boolean);
}

async function reconcileProperty(tx, organizationId, property) {
  const appfolioPropertyId = String(property.sourcePropertyId || '').trim();
  if (!UUID_RE.test(appfolioPropertyId)) {
    return { skipped: true, reason: 'source_property_id not a UUID' };
  }

  const unitsResult = await fetchAllPages('/units', {
    'filters[PropertyId]': appfolioPropertyId,
  });
  if (unitsResult.error) throw new Error(`AppFolio /units: ${unitsResult.error}`);
  const afUnits = (unitsResult.data || []).filter((u) => u && u.Id);

  const ourUnits = await tx
    .select({
      id: schema.units.id,
      sourceUnitId: schema.units.sourceUnitId,
      sourceUnitName: schema.units.sourceUnitName,
    })
    .from(schema.units)
    .where(
      and(
        eq(schema.units.organizationId, organizationId),
        eq(schema.units.propertyId, property.id),
      ),
    );

  // Index our units by every key we might match on.
  const ourBySourceId = new Map();
  const ourByExactName = new Map();
  const ourByNormName = new Map();
  const ourByToken = new Map();
  for (const u of ourUnits) {
    if (u.sourceUnitId) ourBySourceId.set(String(u.sourceUnitId), u);
    const name = u.sourceUnitName || '';
    if (name.trim()) ourByExactName.set(name.trim(), u);
    const n = normalize(name);
    if (n) ourByNormName.set(n, u);
    const tok = unitToken(name);
    if (tok) ourByToken.set(tok, u);
  }

  let alreadySet = 0;
  const conflicts = 0;
  const claimedOurIds = new Set();
  const claimedAfIds = new Set();
  const unmatchedAf = [];
  const matchPlan = [];

  for (const au of afUnits) {
    const afId = String(au.Id);
    if (claimedAfIds.has(afId)) continue;

    // 1. already correctly set?
    if (ourBySourceId.has(afId)) {
      alreadySet += 1;
      claimedOurIds.add(ourBySourceId.get(afId).id);
      claimedAfIds.add(afId);
      continue;
    }

    // 2-4. name strategies
    let ourMatch = null;
    let strategy = null;
    const names = afUnitNames(au);
    for (const nm of names) {
      const c = ourByExactName.get(String(nm).trim());
      if (c && !claimedOurIds.has(c.id)) { ourMatch = c; strategy = 'exact_name'; break; }
    }
    if (!ourMatch) {
      for (const nm of names) {
        const c = ourByNormName.get(normalize(nm));
        if (c && !claimedOurIds.has(c.id)) { ourMatch = c; strategy = 'normalized_name'; break; }
      }
    }
    if (!ourMatch) {
      for (const nm of names) {
        const c = ourByToken.get(unitToken(nm));
        if (c && !claimedOurIds.has(c.id)) { ourMatch = c; strategy = 'unit_token'; break; }
      }
    }

    if (ourMatch) {
      claimedOurIds.add(ourMatch.id);
      claimedAfIds.add(afId);
      matchPlan.push({ ourUnitId: ourMatch.id, afId, strategy });
    } else {
      unmatchedAf.push({
        appfolio_unit_id: afId,
        appfolio_name: au.Name || au.UnitNumber || au.Address1 || null,
        appfolio_address: [au.Address1, au.Address2].filter(Boolean).join(' ') || null,
        current_occupancy: au.CurrentOccupancyId ? 'occupied' : 'vacant',
      });
    }
  }

  // 5. SFR fallback — exactly one unmatched unit on each side.
  const unmatchedOur = ourUnits.filter(
    (u) => !claimedOurIds.has(u.id) && !u.sourceUnitId,
  );
  if (afUnits.length === 1 && ourUnits.length === 1 && unmatchedAf.length === 1
      && unmatchedOur.length === 1) {
    matchPlan.push({
      ourUnitId: unmatchedOur[0].id,
      afId: unmatchedAf[0].appfolio_unit_id,
      strategy: 'sfr_1to1',
    });
    claimedOurIds.add(unmatchedOur[0].id);
    claimedAfIds.add(unmatchedAf[0].appfolio_unit_id);
    unmatchedAf.length = 0;
  }

  // The caller applies match_plan (or not, for a dry run) — this
  // function just computes the plan.
  return {
    property_id: property.id,
    display_name: property.displayName,
    appfolio_units: afUnits.length,
    our_units: ourUnits.length,
    matched: matchPlan.length,
    already_set: alreadySet,
    conflicts,
    unmatched_appfolio: unmatchedAf,
    unmatched_our: unmatchedOur.map((u) => ({
      our_unit_id: u.id,
      source_unit_name: u.sourceUnitName,
    })),
    match_plan: matchPlan,
  };
}

export default withAdminHandler(async (req, res) => {
  if (req.method !== 'POST' && req.method !== 'GET') {
    return res.status(405).json({ ok: false, error: 'POST or GET only' });
  }
  if (!isAppfolioConfigured()) {
    return res.status(503).json({ ok: false, error: 'AppFolio not configured.' });
  }
  const body = req.method === 'POST' ? parseBody(req) : {};
  const queryDryRun = req.query?.dry_run;
  const dryRun =
    body.dry_run !== undefined
      ? body.dry_run !== false
      : queryDryRun !== undefined
        ? !(queryDryRun === 'false' || queryDryRun === '0')
        : true;
  const limit = Math.min(Math.max(parseInt(body.limit ?? req.query?.limit, 10) || 25, 1), 100);
  const offset = Math.max(parseInt(body.offset ?? req.query?.offset, 10) || 0, 0);

  const db = getDb();
  const organizationId = await getDefaultOrgId();

  const propFilter = and(
    eq(schema.properties.organizationId, organizationId),
    eq(schema.properties.sourcePms, 'appfolio'),
    isNotNull(schema.properties.sourcePropertyId),
  );
  const properties = await db
    .select({
      id: schema.properties.id,
      displayName: schema.properties.displayName,
      sourcePropertyId: schema.properties.sourcePropertyId,
    })
    .from(schema.properties)
    .where(propFilter)
    .orderBy(asc(schema.properties.displayName))
    .limit(limit)
    .offset(offset);
  const totalRows = await db
    .select({ id: schema.properties.id })
    .from(schema.properties)
    .where(propFilter);
  const total = totalRows.length;

  const startedAt = Date.now();
  const TIME_BUDGET_MS = 240_000;

  let totalMatched = 0;
  let totalAlreadySet = 0;
  let totalConflicts = 0;
  const unmatchedSamples = [];
  const errors = [];
  let timedOut = false;
  let processed = 0;

  for (const property of properties) {
    if (Date.now() - startedAt > TIME_BUDGET_MS) { timedOut = true; break; }
    try {
      // Each property runs in its own tx so a write failure on one
      // doesn't roll back the whole batch.
      const summary = await db.transaction(async (tx) => {
        const plan = await reconcileProperty(tx, organizationId, property);
        if (plan.skipped) return plan;
        if (!dryRun) {
          for (const m of plan.match_plan) {
            // collision guard
            const [collision] = await tx
              .select({ id: schema.units.id })
              .from(schema.units)
              .where(
                and(
                  eq(schema.units.organizationId, organizationId),
                  eq(schema.units.sourceUnitId, m.afId),
                ),
              )
              .limit(1);
            if (collision && collision.id !== m.ourUnitId) {
              plan.conflicts += 1;
              continue;
            }
            await tx
              .update(schema.units)
              .set({ sourceUnitId: m.afId, updatedAt: new Date() })
              .where(eq(schema.units.id, m.ourUnitId));
          }
        }
        return plan;
      });
      processed += 1;
      if (summary.skipped) continue;
      totalMatched += summary.matched;
      totalAlreadySet += summary.already_set;
      totalConflicts += summary.conflicts;
      for (const u of summary.unmatched_appfolio) {
        if (unmatchedSamples.length < 60) {
          unmatchedSamples.push({ property: summary.display_name, ...u });
        }
      }
    } catch (err) {
      errors.push({ property: property.displayName, error: err.message || String(err) });
      await recordHealth(organizationId, 'appfolio_database', 'AppFolio (Database API)', {
        ok: false, error: err.message || String(err),
      });
    }
  }
  if (processed > 0 && errors.length === 0) {
    await recordHealth(organizationId, 'appfolio_database', 'AppFolio (Database API)', { ok: true });
  }

  const nextOffset = offset + processed;
  return res.status(200).json({
    ok: true,
    dry_run: dryRun,
    organization_id: organizationId,
    processed,
    offset,
    next_offset: nextOffset,
    total_properties: total,
    has_more: !timedOut ? nextOffset < total : true,
    timed_out: timedOut,
    totals: {
      units_matched: totalMatched,
      units_already_set: totalAlreadySet,
      conflicts: totalConflicts,
      unmatched_appfolio_units: unmatchedSamples.length,
    },
    unmatched_samples: unmatchedSamples,
    errors,
  });
});
