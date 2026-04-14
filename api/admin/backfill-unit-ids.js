// Vercel Serverless Function — backfill Appfolio (or other PMS) Unit
// IDs onto existing unit rows.
//
// POST /api/admin/backfill-unit-ids
// Body:
//   {
//     tsv: "<raw tab-separated text pasted from Appfolio export>",
//     sourcePms: "appfolio"   // optional; default "appfolio"
//   }
//
// Expected TSV columns (header row optional, first column is Property
// ID, second is Unit ID, third is Unit Name):
//
//   Property ID  Unit ID  Unit Name
//   688          3667     Unit 1
//   688          3668     Unit 2
//   ...
//
// The handler:
//   1. Parses the TSV, deduping on (propertyId, unitName) so two
//      pastes that overlap are a no-op.
//   2. Looks up our properties by (organization_id, source_property_id).
//   3. Looks up each unit by (property_id, source_unit_name).
//   4. Sets units.source_unit_id + source_pms on matches.
//   5. Returns a detailed breakdown: total rows, deduped rows,
//      matched, set, not-found (with the unmatched rows so you can
//      verify).

import { and, eq } from 'drizzle-orm';
import { getDb, schema } from '../../lib/db/index.js';
import {
  withAdminHandler,
  getDefaultOrgId,
  parseBody,
} from '../../lib/adminHelpers.js';

function parseMapping(tsv) {
  const lines = (tsv || '').split(/\r?\n/);
  const rows = [];
  const parseErrors = [];
  let sawHeader = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) continue;

    const cols = line.split('\t').map((c) => c.trim());
    if (cols.length < 3) {
      parseErrors.push({ lineNumber: i + 1, error: `row has only ${cols.length} columns` });
      continue;
    }

    const [rawPid, rawUid, rawName] = cols;

    // Skip a header row if the first column isn't numeric.
    const pid = parseInt(rawPid, 10);
    if (!Number.isFinite(pid)) {
      if (!sawHeader && rawPid.toLowerCase().includes('property id')) {
        sawHeader = true;
        continue;
      }
      parseErrors.push({ lineNumber: i + 1, error: `invalid property id "${rawPid}"` });
      continue;
    }

    if (!rawUid) {
      parseErrors.push({ lineNumber: i + 1, error: 'missing unit id' });
      continue;
    }
    if (!rawName) {
      parseErrors.push({ lineNumber: i + 1, error: 'missing unit name' });
      continue;
    }

    rows.push({
      sourcePropertyId: pid,
      sourceUnitId: rawUid,
      sourceUnitName: rawName,
    });
  }

  // Dedupe on (sourcePropertyId, sourceUnitName) — if the same pair
  // appears twice, keep the first occurrence.
  const seen = new Set();
  const deduped = [];
  for (const r of rows) {
    const key = `${r.sourcePropertyId}::${r.sourceUnitName}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(r);
  }

  return { rows: deduped, totalLines: rows.length, parseErrors };
}

export default withAdminHandler(async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'POST only' });
  }

  const body = parseBody(req);
  const tsv = body.tsv || '';
  const sourcePms = body.sourcePms || 'appfolio';

  if (!tsv.trim()) {
    return res.status(400).json({ ok: false, error: 'tsv body field is required' });
  }

  const db = getDb();
  const orgId = await getDefaultOrgId();

  const { rows, totalLines, parseErrors } = parseMapping(tsv);

  if (rows.length === 0) {
    return res.status(400).json({
      ok: false,
      error: 'No valid rows parsed',
      parseErrors,
    });
  }

  // Pre-load all our properties for this org so we can match property
  // IDs in memory rather than N queries.
  const allProps = await db
    .select({
      id: schema.properties.id,
      sourcePropertyId: schema.properties.sourcePropertyId,
    })
    .from(schema.properties)
    .where(eq(schema.properties.organizationId, orgId));
  const propIdBySource = new Map();
  for (const p of allProps) {
    if (p.sourcePropertyId != null) propIdBySource.set(p.sourcePropertyId, p.id);
  }

  // Pre-load all units so we can match (property_id, source_unit_name).
  const allUnits = await db
    .select({
      id: schema.units.id,
      propertyId: schema.units.propertyId,
      sourceUnitName: schema.units.sourceUnitName,
      sourceUnitId: schema.units.sourceUnitId,
    })
    .from(schema.units)
    .where(eq(schema.units.organizationId, orgId));
  const unitByKey = new Map();
  for (const u of allUnits) {
    if (u.sourceUnitName != null) {
      const k = `${u.propertyId}::${u.sourceUnitName}`;
      unitByKey.set(k, u);
    }
  }

  let setCount = 0;
  let alreadySetCount = 0;
  const notFound = [];

  try {
    await db.transaction(async (tx) => {
      for (const r of rows) {
        const propertyRowId = propIdBySource.get(r.sourcePropertyId);
        if (!propertyRowId) {
          notFound.push({ ...r, reason: 'property not found' });
          continue;
        }
        const unit = unitByKey.get(`${propertyRowId}::${r.sourceUnitName}`);
        if (!unit) {
          notFound.push({ ...r, reason: 'unit not found (name mismatch)' });
          continue;
        }

        if (unit.sourceUnitId === r.sourceUnitId) {
          alreadySetCount += 1;
          continue;
        }

        await tx
          .update(schema.units)
          .set({
            sourceUnitId: r.sourceUnitId,
            sourcePms,
            updatedAt: new Date(),
          })
          .where(eq(schema.units.id, unit.id));
        setCount += 1;
      }
    });
  } catch (err) {
    console.error('[backfill-unit-ids] transaction failed:', err);
    return res.status(500).json({
      ok: false,
      error: `Backfill failed, no changes were committed: ${err.message}`,
    });
  }

  return res.status(200).json({
    ok: true,
    sourcePms,
    totalLinesParsed: totalLines,
    dedupedRowCount: rows.length,
    parseErrorCount: parseErrors.length,
    parseErrors: parseErrors.slice(0, 50),
    setCount,
    alreadySetCount,
    notFoundCount: notFound.length,
    notFound: notFound.slice(0, 100),
    message: `Set source_unit_id on ${setCount} units (${alreadySetCount} already correct, ${notFound.length} unmatched).`,
  });
});
