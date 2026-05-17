// GET /api/admin/list-properties?secret=<TOKEN>
//
// Compact property list for human review — used when picking
// which properties belong on the non_revenue exclusion list.
// Returns id, display_name, unit_count, active_unit_count
// (non_revenue=false), and the count currently flagged as
// non_revenue. Sorted by display_name.

import { and, asc, eq, sql } from 'drizzle-orm';
import { withAdminHandler, getDefaultOrgId } from '../../lib/adminHelpers.js';
import { getDb, schema } from '../../lib/db/index.js';

export default withAdminHandler(async (req, res) => {
  const db = getDb();
  const orgId = await getDefaultOrgId();

  const rows = await db
    .select({
      id: schema.properties.id,
      name: schema.properties.displayName,
      total: sql`COUNT(${schema.units.id})::int`.as('total'),
      flagged: sql`SUM(CASE WHEN ${schema.units.nonRevenue} THEN 1 ELSE 0 END)::int`.as('flagged'),
    })
    .from(schema.properties)
    .leftJoin(schema.units, eq(schema.units.propertyId, schema.properties.id))
    .where(eq(schema.properties.organizationId, orgId))
    .groupBy(schema.properties.id, schema.properties.displayName)
    .orderBy(asc(schema.properties.displayName));

  const summary = {
    total_properties: rows.length,
    with_units: rows.filter((r) => r.total > 0).length,
    empty_properties: rows.filter((r) => r.total === 0).length,
    total_units: rows.reduce((s, r) => s + r.total, 0),
    flagged_units: rows.reduce((s, r) => s + (r.flagged || 0), 0),
    countable_units: rows.reduce((s, r) => s + (r.total - (r.flagged || 0)), 0),
  };

  return res.status(200).json({
    ok: true,
    summary,
    properties: rows.map((r) => ({
      name: r.name,
      total: r.total,
      flagged: r.flagged || 0,
      countable: r.total - (r.flagged || 0),
    })),
  });
});
