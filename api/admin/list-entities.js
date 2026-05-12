// GET /api/admin/list-entities?secret=<TOKEN>&include_inactive=true
//
// Returns every entity for the org with its tax id last 4 (never
// the encrypted value), formation info, and a count of properties
// currently assigned. Drives the Entities tab in the Accounting UI.

import { and, eq, sql } from 'drizzle-orm';
import {
  withAdminHandler,
  getDefaultOrgId,
} from '../../lib/adminHelpers.js';
import { getDb, schema } from '../../lib/db/index.js';

export default withAdminHandler(async (req, res) => {
  if (req.method !== 'GET') {
    return res.status(405).json({ ok: false, error: 'GET only' });
  }
  const db = getDb();
  const organizationId = await getDefaultOrgId();
  const includeInactive =
    req.query?.include_inactive === 'true' ||
    req.query?.include_inactive === '1';

  const whereClauses = [eq(schema.entities.organizationId, organizationId)];
  if (!includeInactive) whereClauses.push(eq(schema.entities.isActive, true));

  const rows = await db
    .select({
      id: schema.entities.id,
      name: schema.entities.name,
      legalName: schema.entities.legalName,
      entityType: schema.entities.entityType,
      taxIdLast4: schema.entities.taxIdLast4,
      formationState: schema.entities.formationState,
      formationDate: schema.entities.formationDate,
      fiscalYearEndMonth: schema.entities.fiscalYearEndMonth,
      isActive: schema.entities.isActive,
      notes: schema.entities.notes,
      createdAt: schema.entities.createdAt,
      propertyCount: sql`(
        SELECT COUNT(*) FROM ${schema.properties}
        WHERE ${schema.properties.entityId} = ${schema.entities.id}
      )`.as('property_count'),
    })
    .from(schema.entities)
    .where(and(...whereClauses))
    .orderBy(schema.entities.name);

  return res.status(200).json({
    ok: true,
    organization_id: organizationId,
    count: rows.length,
    entities: rows.map((e) => ({
      id: e.id,
      name: e.name,
      legal_name: e.legalName,
      entity_type: e.entityType,
      tax_id_last4: e.taxIdLast4,
      formation_state: e.formationState,
      formation_date: e.formationDate,
      fiscal_year_end_month: e.fiscalYearEndMonth,
      is_active: e.isActive,
      notes: e.notes,
      created_at: e.createdAt,
      property_count: Number(e.propertyCount),
    })),
  });
});
