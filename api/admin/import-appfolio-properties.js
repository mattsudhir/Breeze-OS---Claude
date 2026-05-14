// POST /api/admin/import-appfolio-properties?secret=<TOKEN>
//
// Imports every property straight from AppFolio's /properties endpoint.
// Unlike the CSV bulk-import, source_property_id is AppFolio's own Id
// (a UUID) from the very first write — no backfill, no reconciliation,
// no dedupe ever needed downstream.
//
// Idempotent: upserts on (organization_id, source_property_id). Safe
// to re-run. Designed to run right after wipe-directory-data, but a
// re-run against existing data just updates in place.
//
// Every property is attached to the org's default owner ("Breeze
// (unassigned)" or the first owner). entity_id is left null — assign
// via the Entities UI afterward; posting flows resolve it lazily.

import { and, eq } from 'drizzle-orm';
import {
  withAdminHandler,
  getDefaultOrgId,
} from '../../lib/adminHelpers.js';
import { getDb, schema } from '../../lib/db/index.js';
import { fetchAllPages } from '../../lib/backends/appfolio.js';
import { recordHealth } from '../../lib/integrationHealth.js';

export const config = { maxDuration: 120 };

function isAppfolioConfigured() {
  return Boolean(
    process.env.APPFOLIO_CLIENT_ID &&
      process.env.APPFOLIO_CLIENT_SECRET &&
      process.env.APPFOLIO_DEVELOPER_ID,
  );
}

export default withAdminHandler(async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'POST only' });
  }
  if (!isAppfolioConfigured()) {
    return res.status(503).json({ ok: false, error: 'AppFolio not configured.' });
  }

  const db = getDb();
  const organizationId = await getDefaultOrgId();

  // Default owner — properties.owner_id is NOT NULL. Prefer one whose
  // name looks like the catch-all; otherwise the first owner.
  const owners = await db
    .select({ id: schema.owners.id, legalName: schema.owners.legalName })
    .from(schema.owners)
    .where(eq(schema.owners.organizationId, organizationId));
  if (owners.length === 0) {
    return res.status(400).json({
      ok: false,
      error: 'No owner exists. Create at least one owner (e.g. "Breeze (unassigned)") before importing.',
    });
  }
  const defaultOwner =
    owners.find((o) => /unassigned|breeze/i.test(o.legalName || '')) || owners[0];

  // Pull every AppFolio property.
  const startedAt = Date.now();
  const result = await fetchAllPages('/properties', {});
  if (result.error) {
    await recordHealth(organizationId, 'appfolio_database', 'AppFolio (Database API)', {
      ok: false, error: result.error,
    });
    return res.status(502).json({ ok: false, error: `AppFolio /properties: ${result.error}` });
  }
  const afProperties = (result.data || []).filter((p) => p && (p.Id || p.id));
  await recordHealth(organizationId, 'appfolio_database', 'AppFolio (Database API)', { ok: true });

  let inserted = 0;
  let updated = 0;
  let skipped = 0;
  const skippedExamples = [];

  for (const af of afProperties) {
    const sourcePropertyId = String(af.Id || af.id);
    const displayName =
      af.Name || af.PropertyName || af.Address1 || `Property ${sourcePropertyId}`;
    const serviceAddressLine1 = af.Address1 || '';
    const serviceCity = af.City || '';
    const serviceState = af.State || '';
    const serviceZip = af.PostalCode || af.Zip || '';

    // service address columns are NOT NULL; AppFolio almost always
    // has them, but guard so one bad row doesn't abort the import.
    if (!serviceAddressLine1 && !serviceCity) {
      skipped += 1;
      if (skippedExamples.length < 10) {
        skippedExamples.push({ source_property_id: sourcePropertyId, reason: 'no address' });
      }
      continue;
    }

    const values = {
      organizationId,
      ownerId: defaultOwner.id,
      entityId: null,
      sourcePropertyId,
      sourcePms: 'appfolio',
      displayName,
      serviceAddressLine1,
      serviceAddressLine2: af.Address2 || null,
      serviceCity,
      serviceState,
      serviceZip,
      updatedAt: new Date(),
    };

    const [existing] = await db
      .select({ id: schema.properties.id })
      .from(schema.properties)
      .where(
        and(
          eq(schema.properties.organizationId, organizationId),
          eq(schema.properties.sourcePropertyId, sourcePropertyId),
        ),
      )
      .limit(1);

    if (existing) {
      await db.update(schema.properties).set(values)
        .where(eq(schema.properties.id, existing.id));
      updated += 1;
    } else {
      await db.insert(schema.properties).values(values);
      inserted += 1;
    }
  }

  return res.status(200).json({
    ok: true,
    organization_id: organizationId,
    default_owner: defaultOwner.legalName,
    appfolio_properties_returned: afProperties.length,
    inserted,
    updated,
    skipped,
    skipped_examples: skippedExamples,
    elapsed_ms: Date.now() - startedAt,
  });
});
