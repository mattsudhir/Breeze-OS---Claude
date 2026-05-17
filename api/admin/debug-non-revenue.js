// GET  /api/admin/debug-non-revenue?secret=<TOKEN>
//
// Shows what migration 0038's backfill matched and what it missed.
//   - flagged: current count of units.non_revenue = true
//   - candidates: property + unit name samples that look related to
//     the user's exclusion list, so we can see exact text shapes.
//
// POST /api/admin/debug-non-revenue?secret=<TOKEN>
//   body: { property_name_patterns: ["bryce","ohio","7th","seventh"] }
//
// Re-runs the property-name backfill with the supplied substrings
// (case-insensitive, matched anywhere in display_name). Useful when
// the literal patterns in migration 0038 didn't match the actual
// data shape.
//
// Read-only by default. The POST path writes — runs the same
// UPDATE pattern as migration 0038's backfill #1.

import { and, eq, ilike, or, sql } from 'drizzle-orm';
import {
  withAdminHandler,
  getDefaultOrgId,
  parseBody,
} from '../../lib/adminHelpers.js';
import { getDb, schema } from '../../lib/db/index.js';

export default withAdminHandler(async (req, res) => {
  const db = getDb();
  const orgId = await getDefaultOrgId();

  if (req.method === 'GET') {
    // 1. Total flagged.
    const [{ n: flagged }] = await db
      .select({ n: sql`COUNT(*)::int`.as('n') })
      .from(schema.units)
      .where(
        and(
          eq(schema.units.organizationId, orgId),
          eq(schema.units.nonRevenue, true),
        ),
      );

    // 2. Properties matching the exclusion seeds.
    const seeds = ['bryce', 'ohio', '7th', 'seventh', '631', '510', '1413'];
    const propRows = await db
      .select({
        id: schema.properties.id,
        name: schema.properties.displayName,
      })
      .from(schema.properties)
      .where(
        and(
          eq(schema.properties.organizationId, orgId),
          or(...seeds.map((s) => ilike(schema.properties.displayName, `%${s}%`))),
        ),
      )
      .limit(60);

    // 3. For each candidate property, how many units it has + non_revenue count.
    const propIds = propRows.map((p) => p.id);
    const unitsByProp = propIds.length
      ? await db
          .select({
            propertyId: schema.units.propertyId,
            total: sql`COUNT(*)::int`.as('total'),
            flagged: sql`SUM(CASE WHEN ${schema.units.nonRevenue} THEN 1 ELSE 0 END)::int`.as('flagged'),
          })
          .from(schema.units)
          .where(
            and(
              eq(schema.units.organizationId, orgId),
              sql`${schema.units.propertyId} IN (${sql.join(propIds.map((id) => sql`${id}`), sql`, `)})`,
            ),
          )
          .groupBy(schema.units.propertyId)
      : [];

    const unitCountByProp = new Map(
      unitsByProp.map((r) => [r.propertyId, { total: r.total, flagged: r.flagged }]),
    );

    const propertyMatches = propRows.map((p) => ({
      id: p.id,
      name: p.name,
      total_units: unitCountByProp.get(p.id)?.total || 0,
      flagged_units: unitCountByProp.get(p.id)?.flagged || 0,
    }));

    // 4. Sample of units with "common" in name.
    const commonUnits = await db
      .select({
        id: schema.units.id,
        name: schema.units.sourceUnitName,
        nonRevenue: schema.units.nonRevenue,
      })
      .from(schema.units)
      .where(
        and(
          eq(schema.units.organizationId, orgId),
          ilike(schema.units.sourceUnitName, '%common%'),
        ),
      )
      .limit(20);

    return res.status(200).json({
      ok: true,
      flagged_count: flagged,
      property_candidates: propertyMatches,
      common_named_units: commonUnits,
      hint:
        'POST with { "property_name_patterns": [...] } to re-run the backfill with different substrings.',
    });
  }

  if (req.method === 'POST') {
    const body = parseBody(req);
    // Accept multiple key names because the GitHub Actions slash-command
    // workflow strips underscores from comment bodies (so
    // "property_name_patterns" arrives as "propertynamepatterns").
    const raw =
      body.property_name_patterns ||
      body.propertynamepatterns ||
      body.patterns ||
      [];
    const patterns = Array.isArray(raw)
      ? raw.filter((s) => typeof s === 'string' && s.trim())
      : [];
    // If no patterns supplied (or the slash-command body got mangled),
    // fall back to the maintained Breeze exclusion seed list. Lets us
    // POST with an empty body and still do the right thing.
    const effectivePatterns = patterns.length
      ? patterns
      : ['1413 7th', 'brice', '510 ohio', 'common'];

    // Re-run the property-name backfill with the supplied substrings.
    const result = await db.execute(sql`
      UPDATE "units" u
      SET "non_revenue" = true
      FROM "properties" p
      WHERE u."property_id" = p."id"
        AND u."organization_id" = ${orgId}
        AND (
          ${sql.join(
            effectivePatterns.map((p) => sql`LOWER(p."display_name") LIKE ${'%' + p.toLowerCase() + '%'}`),
            sql` OR `,
          )}
        )
        AND u."non_revenue" = false
    `);
    const updated = result.rowCount ?? (result.rows ? result.rows.length : null);

    const [{ n: nowFlagged }] = await db
      .select({ n: sql`COUNT(*)::int`.as('n') })
      .from(schema.units)
      .where(
        and(
          eq(schema.units.organizationId, orgId),
          eq(schema.units.nonRevenue, true),
        ),
      );

    return res.status(200).json({
      ok: true,
      patterns_used: effectivePatterns,
      defaulted: !patterns.length,
      rows_updated: updated,
      total_flagged_now: nowFlagged,
    });
  }

  return res.status(405).json({ ok: false, error: 'GET or POST only' });
});
