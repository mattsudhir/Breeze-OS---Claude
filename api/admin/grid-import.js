// Vercel Serverless Function — wide-format utility config grid import.
//
// POST /api/admin/grid-import
// Body:
//   {
//     tsv: "<raw wide-format TSV pasted from spreadsheet>"
//   }
//
// Expected TSV header (case-insensitive, extra columns ignored):
//
//   source_property_id  display_name  unit_name  city  state  zip  electric  gas  water  sewer  trash  electric_billback  gas_billback  water_billback  sewer_billback  trash_billback
//
// Only source_property_id is required. The unit_name column is
// optional: if present and non-blank, the row produces unit-level
// property_utilities overrides (unit_id = <that unit>); if blank,
// the row produces property-level defaults (unit_id = NULL).
//
// Cell semantics:
//   - Utility columns accept 'tenant' | 'owner_llc' | 'none' | ''.
//     Blank means "leave alone — don't upsert this column for this row".
//   - Billback columns accept 'y' | 'n' | ''.
//     Blank means "leave alone". On insert (new row) defaults to 'n'.
//
// Upsert semantics:
//   - For each (property_id, unit_id, utility_type) tuple in the paste,
//     SELECT existing → UPDATE if found, else INSERT.
//   - Rows in the DB that aren't mentioned in the paste are untouched.
//   - Duplicate rows in the paste for the same key are rejected up
//     front as a parse error.
//
// Wrapped in a transaction so mid-import failures roll back.

import { and, eq, inArray } from 'drizzle-orm';
import { getDb, schema } from '../../lib/db/index.js';
import {
  withAdminHandler,
  getDefaultOrgId,
  parseBody,
} from '../../lib/adminHelpers.js';

const UTILITY_TYPES = ['electric', 'gas', 'water', 'sewer', 'trash'];
const VALID_HOLDERS = new Set(['tenant', 'owner_llc', 'none']);

// Billback cell value → { mode, tenantBool } lookup. Accepts friendly
// aliases (y/n/split) alongside canonical enum values so the spreadsheet
// stays human-readable.
const BILLBACK_VALUE_MAP = {
  'n':                { mode: 'none',        tenant: false },
  'no':               { mode: 'none',        tenant: false },
  'none':             { mode: 'none',        tenant: false },
  'y':                { mode: 'full',        tenant: true },
  'yes':              { mode: 'full',        tenant: true },
  'full':             { mode: 'full',        tenant: true },
  'split':            { mode: 'split_meter', tenant: true },
  'split_meter':      { mode: 'split_meter', tenant: true },
  'meter_split':      { mode: 'split_meter', tenant: true },
  'yes-meter_split':  { mode: 'split_meter', tenant: true },
  'y-split':          { mode: 'split_meter', tenant: true },
};

// ── Parser ───────────────────────────────────────────────────────

function parseGrid(tsv) {
  const lines = (tsv || '').split(/\r?\n/).filter((l) => l.trim());
  if (lines.length === 0) {
    return { error: 'No data provided' };
  }

  // Parse the header row. Accept any superset of our expected columns
  // plus reference columns we ignore (display_name, city, state, zip).
  const header = lines[0].split('\t').map((c) => c.trim().toLowerCase());
  const colIdx = {};
  for (let i = 0; i < header.length; i++) {
    colIdx[header[i]] = i;
  }

  // source_property_id is required; also accept rm_property_id for
  // pre-rename spreadsheets.
  const pidCol = colIdx['source_property_id'] ?? colIdx['rm_property_id'];
  if (pidCol === undefined) {
    return { error: 'Header must include "source_property_id" column (or legacy "rm_property_id")' };
  }
  const unitNameCol = colIdx['unit_name'] ?? colIdx['source_unit_name'] ?? colIdx['rm_unit_name'];

  const parsed = [];
  const parseErrors = [];
  const seenKeys = new Set();

  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split('\t').map((c) => c.trim());
    const sourcePropertyId = parseInt(cols[pidCol], 10);
    if (!Number.isFinite(sourcePropertyId)) {
      parseErrors.push({ lineNumber: i + 1, error: `invalid source_property_id "${cols[pidCol] || ''}"` });
      continue;
    }

    const unitName =
      unitNameCol !== undefined && cols[unitNameCol] ? cols[unitNameCol] : null;

    const row = {
      sourcePropertyId,
      unitName,
      lineNumber: i + 1,
      holders: {},
      billbacks: {},
    };

    let hasAnyValue = false;

    for (const t of UTILITY_TYPES) {
      const hc = colIdx[t];
      const bc = colIdx[`${t}_billback`];
      if (hc !== undefined && cols[hc]) {
        const v = cols[hc].toLowerCase();
        if (!VALID_HOLDERS.has(v)) {
          parseErrors.push({
            lineNumber: i + 1,
            error: `${t}: invalid value "${cols[hc]}" (expected tenant, owner_llc, none, or blank)`,
          });
          continue;
        }
        row.holders[t] = v;
        hasAnyValue = true;
      }
      if (bc !== undefined && cols[bc]) {
        const v = cols[bc].toLowerCase();
        const mapped = BILLBACK_VALUE_MAP[v];
        if (!mapped) {
          parseErrors.push({
            lineNumber: i + 1,
            error: `${t}_billback: invalid value "${cols[bc]}" (expected n, y, split/yes-meter_split, or blank)`,
          });
          continue;
        }
        row.billbacks[t] = mapped; // { mode, tenant }
        hasAnyValue = true;
      }
    }

    if (!hasAnyValue) continue; // Skip rows with no utility values

    // Dedup check: (propertyId, unitName, utility_type) must be unique
    // within this paste for each utility the row touches.
    for (const t of Object.keys(row.holders)) {
      const key = `${sourcePropertyId}::${unitName || ''}::${t}`;
      if (seenKeys.has(key)) {
        parseErrors.push({
          lineNumber: i + 1,
          error: `Duplicate row for property ${sourcePropertyId} / unit ${unitName || '(property-level)'} / utility ${t}`,
        });
        continue;
      }
      seenKeys.add(key);
    }

    parsed.push(row);
  }

  return { rows: parsed, parseErrors };
}

// ── Handler ──────────────────────────────────────────────────────

export default withAdminHandler(async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'POST only' });
  }

  const body = parseBody(req);
  const tsv = body.tsv || '';
  const dryRun = !!body.dryRun;

  const { rows, parseErrors = [], error } = parseGrid(tsv);
  if (error) {
    return res.status(400).json({ ok: false, error, parseErrors });
  }
  if (parseErrors.length > 0) {
    return res.status(400).json({
      ok: false,
      error: `${parseErrors.length} parse errors — fix the sheet and re-submit`,
      parseErrors: parseErrors.slice(0, 50),
    });
  }
  if (rows.length === 0) {
    return res.status(400).json({ ok: false, error: 'No value-bearing rows found' });
  }

  const db = getDb();
  const orgId = await getDefaultOrgId();

  // Resolve source_property_id → property.id for every unique property
  // in the paste.
  const uniquePids = [...new Set(rows.map((r) => r.sourcePropertyId))];
  const propRows = await db
    .select({
      id: schema.properties.id,
      sourcePropertyId: schema.properties.sourcePropertyId,
    })
    .from(schema.properties)
    .where(
      and(
        eq(schema.properties.organizationId, orgId),
        inArray(schema.properties.sourcePropertyId, uniquePids),
      ),
    );
  const propIdBySource = new Map(
    propRows.map((p) => [p.sourcePropertyId, p.id]),
  );

  // For unit-scoped rows, resolve (property_id, unit_name) → unit.id.
  const unitLookupNeeded = rows.some((r) => r.unitName);
  let unitByKey = new Map();
  if (unitLookupNeeded) {
    const propertyIds = [...propIdBySource.values()];
    if (propertyIds.length > 0) {
      const us = await db
        .select({
          id: schema.units.id,
          propertyId: schema.units.propertyId,
          sourceUnitName: schema.units.sourceUnitName,
        })
        .from(schema.units)
        .where(inArray(schema.units.propertyId, propertyIds));
      for (const u of us) {
        if (u.sourceUnitName) {
          unitByKey.set(`${u.propertyId}::${u.sourceUnitName}`, u.id);
        }
      }
    }
  }

  // Plan the diff: for each row, build the set of (property_id, unit_id,
  // utility_type) upserts. Preview mode returns the plan without writing.
  const planned = [];
  const planErrors = [];

  for (const row of rows) {
    const propertyRowId = propIdBySource.get(row.sourcePropertyId);
    if (!propertyRowId) {
      planErrors.push({
        lineNumber: row.lineNumber,
        error: `property ${row.sourcePropertyId} not found in DB`,
      });
      continue;
    }
    let unitRowId = null;
    if (row.unitName) {
      unitRowId = unitByKey.get(`${propertyRowId}::${row.unitName}`) || null;
      if (!unitRowId) {
        planErrors.push({
          lineNumber: row.lineNumber,
          error: `unit "${row.unitName}" not found at property ${row.sourcePropertyId}`,
        });
        continue;
      }
    }

    for (const t of UTILITY_TYPES) {
      if (row.holders[t] == null && row.billbacks[t] == null) continue;
      const bb = row.billbacks[t]; // { mode, tenant } | undefined
      planned.push({
        propertyRowId,
        unitRowId,
        utilityType: t,
        accountHolder: row.holders[t] ?? null,
        billbackMode: bb ? bb.mode : null,
        billbackTenant: bb ? bb.tenant : null,
        lineNumber: row.lineNumber,
      });
    }
  }

  if (dryRun) {
    return res.status(200).json({
      ok: true,
      dryRun: true,
      plannedCount: planned.length,
      planErrorCount: planErrors.length,
      planErrors: planErrors.slice(0, 50),
      planPreview: planned.slice(0, 25),
    });
  }

  if (planErrors.length > 0) {
    return res.status(400).json({
      ok: false,
      error: `${planErrors.length} rows reference properties/units not in the DB`,
      planErrors: planErrors.slice(0, 50),
    });
  }

  let insertedCount = 0;
  let updatedCount = 0;

  try {
    await db.transaction(async (tx) => {
      for (const p of planned) {
        // Look for an existing row with the same (property, unit, type).
        const existing = await tx
          .select({ id: schema.propertyUtilities.id })
          .from(schema.propertyUtilities)
          .where(
            and(
              eq(schema.propertyUtilities.propertyId, p.propertyRowId),
              p.unitRowId
                ? eq(schema.propertyUtilities.unitId, p.unitRowId)
                : eq(schema.propertyUtilities.unitId, null),
              eq(schema.propertyUtilities.utilityType, p.utilityType),
            ),
          )
          .limit(1);

        if (existing.length > 0) {
          // Only touch columns explicitly set in the paste. billback_mode
          // and billback_tenant are written as a pair so the shadow
          // column stays in sync.
          const updates = { updatedAt: new Date() };
          if (p.accountHolder != null) updates.accountHolder = p.accountHolder;
          if (p.billbackMode != null) {
            updates.billbackMode = p.billbackMode;
            updates.billbackTenant = p.billbackTenant;
          }
          await tx
            .update(schema.propertyUtilities)
            .set(updates)
            .where(eq(schema.propertyUtilities.id, existing[0].id));
          updatedCount += 1;
        } else {
          // Insert requires account_holder (NOT NULL in schema). If the
          // paste didn't set it for a new row, skip with a plan error.
          if (p.accountHolder == null) {
            planErrors.push({
              lineNumber: p.lineNumber,
              error: `cannot create new property_utilities row for ${p.utilityType} without account_holder`,
            });
            continue;
          }
          await tx.insert(schema.propertyUtilities).values({
            propertyId: p.propertyRowId,
            unitId: p.unitRowId,
            utilityType: p.utilityType,
            accountHolder: p.accountHolder,
            billbackMode: p.billbackMode ?? 'none',
            billbackTenant: p.billbackTenant ?? false,
          });
          insertedCount += 1;
        }
      }
    });
  } catch (err) {
    console.error('[grid-import] transaction failed:', err);
    return res.status(500).json({
      ok: false,
      error: `Grid import failed, no changes were committed: ${err.message}`,
    });
  }

  return res.status(200).json({
    ok: true,
    plannedCount: planned.length,
    insertedCount,
    updatedCount,
    planErrorCount: planErrors.length,
    planErrors: planErrors.slice(0, 50),
    message: `Upserted ${insertedCount + updatedCount} utility rows (${insertedCount} new, ${updatedCount} updated).`,
  });
});
