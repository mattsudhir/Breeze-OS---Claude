// POST /api/admin/backfill-appfolio-property-ids?secret=<TOKEN>
// body: { dry_run?: boolean (default true) }
//
// Pulls every property from AppFolio /properties, tries to match
// each one to a property in our DB by normalized address line 1
// + city, then updates source_property_id to AppFolio's PropertyId.
//
// Why: bulk-import populated source_property_id from the user's CSV,
// which didn't contain AppFolio PropertyIds. Result: every downstream
// sync (work orders, tenants, leases) couldn't join AppFolio rows to
// our property rows.
//
// Defaults to dry_run so you can review the match plan before
// committing. Pass { dry_run: false } to apply.

import { and, eq, ne } from 'drizzle-orm';
import {
  withAdminHandler,
  getDefaultOrgId,
  parseBody,
} from '../../lib/adminHelpers.js';
import { getDb, schema } from '../../lib/db/index.js';
import { fetchAllPages } from '../../lib/backends/appfolio.js';
import { recordHealth } from '../../lib/integrationHealth.js';

export const config = { maxDuration: 120 };

function normalize(s) {
  return (s || '')
    .toString()
    .trim()
    .toLowerCase()
    .replace(/[.,#]/g, '')
    .replace(/\s+/g, ' ');
}

export default withAdminHandler(async (req, res) => {
  if (req.method !== 'POST' && req.method !== 'GET') {
    return res.status(405).json({ ok: false, error: 'POST or GET only' });
  }
  // Body wins, then query string. Default dry_run=true for safety.
  const body = req.method === 'POST' ? parseBody(req) : {};
  const queryDryRun = req.query?.dry_run;
  const dryRun =
    body.dry_run !== undefined
      ? body.dry_run !== false
      : queryDryRun !== undefined
        ? !(queryDryRun === 'false' || queryDryRun === '0')
        : true;
  const db = getDb();
  const organizationId = await getDefaultOrgId();

  // ── 1. Pull AppFolio /properties ──────────────────────────────
  const t0 = Date.now();
  const result = await fetchAllPages('/properties', {});
  if (result.error) {
    await recordHealth(organizationId, 'appfolio_database', 'AppFolio (Database API)', { ok: false, error: result.error });
    return res.status(502).json({ ok: false, stage: 'appfolio_fetch', error: result.error });
  }
  const afProperties = result.data || [];
  await recordHealth(organizationId, 'appfolio_database', 'AppFolio (Database API)', { ok: true });

  // ── 2. Pull our properties ────────────────────────────────────
  const ourProps = await db
    .select({
      id: schema.properties.id,
      displayName: schema.properties.displayName,
      addressLine1: schema.properties.serviceAddressLine1,
      city: schema.properties.serviceCity,
      sourcePropertyId: schema.properties.sourcePropertyId,
    })
    .from(schema.properties)
    .where(eq(schema.properties.organizationId, organizationId));

  // Index ours by normalized (address1 + city) AND by normalized displayName.
  const byAddrCity = new Map();
  const byName = new Map();
  for (const p of ourProps) {
    const addrKey = normalize(`${p.addressLine1} ${p.city}`);
    if (addrKey.trim()) byAddrCity.set(addrKey, p);
    const nameKey = normalize(p.displayName);
    if (nameKey) byName.set(nameKey, p);
  }

  // ── 3. Match AppFolio rows ────────────────────────────────────
  const matches = [];
  const unmatched = [];
  const seenOurIds = new Set();
  for (const af of afProperties) {
    const afPropertyId = String(af.PropertyId);
    const afAddrKey = normalize(`${af.Address1 || ''} ${af.City || ''}`);
    const afNameKey = normalize(af.PropertyName || af.Name || '');

    let ourMatch = null;
    let matchType = null;
    if (afAddrKey && byAddrCity.has(afAddrKey)) {
      ourMatch = byAddrCity.get(afAddrKey);
      matchType = 'address';
    } else if (afNameKey && byName.has(afNameKey)) {
      ourMatch = byName.get(afNameKey);
      matchType = 'name';
    }

    if (!ourMatch) {
      unmatched.push({
        appfolio_property_id: afPropertyId,
        appfolio_address: af.Address1,
        appfolio_city: af.City,
        appfolio_name: af.PropertyName || af.Name,
      });
      continue;
    }
    if (seenOurIds.has(ourMatch.id)) {
      // Two AppFolio properties matched the same one of ours — skip
      // the duplicate and report it.
      unmatched.push({
        appfolio_property_id: afPropertyId,
        reason: `duplicate match — our property ${ourMatch.id} already claimed`,
        appfolio_name: af.PropertyName || af.Name,
      });
      continue;
    }
    seenOurIds.add(ourMatch.id);
    matches.push({
      our_property_id: ourMatch.id,
      our_display_name: ourMatch.displayName,
      our_current_source_property_id: ourMatch.sourcePropertyId,
      appfolio_property_id: afPropertyId,
      match_type: matchType,
      will_update: ourMatch.sourcePropertyId !== afPropertyId,
    });
  }

  // ── 4. Apply updates (unless dry_run) ────────────────────────
  let updated = 0;
  let conflicts = 0;
  const conflictExamples = [];
  if (!dryRun) {
    for (const m of matches) {
      if (!m.will_update) continue;
      // Guard: don't blow away an existing matching id with a different
      // value if some other property already has the AppFolio id we're
      // about to assign.
      const [collision] = await db
        .select({ id: schema.properties.id, displayName: schema.properties.displayName })
        .from(schema.properties)
        .where(
          and(
            eq(schema.properties.organizationId, organizationId),
            eq(schema.properties.sourcePropertyId, m.appfolio_property_id),
            ne(schema.properties.id, m.our_property_id),
          ),
        )
        .limit(1);
      if (collision) {
        conflicts += 1;
        if (conflictExamples.length < 5) {
          conflictExamples.push({
            our_property_id: m.our_property_id,
            collides_with_property_id: collision.id,
            collides_with_name: collision.displayName,
            appfolio_property_id: m.appfolio_property_id,
          });
        }
        continue;
      }
      await db
        .update(schema.properties)
        .set({ sourcePropertyId: m.appfolio_property_id, updatedAt: new Date() })
        .where(eq(schema.properties.id, m.our_property_id));
      updated += 1;
    }
  }

  // Properties in our DB that have no AppFolio match at all.
  const ourUnmatched = ourProps.filter((p) => !seenOurIds.has(p.id));

  return res.status(200).json({
    ok: true,
    organization_id: organizationId,
    dry_run: dryRun,
    fetch_ms: Date.now() - t0,
    appfolio_properties_returned: afProperties.length,
    our_properties_total: ourProps.length,
    matches_count: matches.length,
    matches_will_update_count: matches.filter((m) => m.will_update).length,
    matches_already_correct_count: matches.filter((m) => !m.will_update).length,
    appfolio_unmatched_count: unmatched.length,
    our_db_unmatched_count: ourUnmatched.length,
    updated,
    conflicts,
    conflict_examples: conflictExamples,
    sample_matches: matches.slice(0, 5),
    sample_appfolio_unmatched: unmatched.slice(0, 10),
    sample_db_unmatched: ourUnmatched.slice(0, 10).map((p) => ({
      id: p.id,
      display_name: p.displayName,
      address1: p.addressLine1,
      city: p.city,
      current_source_property_id: p.sourcePropertyId,
    })),
    next_step: dryRun
      ? 'Looks right? POST again with { "dry_run": false } to apply the updates.'
      : 'Done. Re-run Sync from AppFolio (Maintenance) and Sync Leases (Property Directory).',
  });
});
