// GET /api/admin/list-properties-with-entity?secret=<TOKEN>
//
// Drives the property → entity assignment UI. Returns every property
// plus its assigned entity (or null) so staff can backfill
// properties.entity_id after migration 0019.

import { eq } from 'drizzle-orm';
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

  const rows = await db
    .select({
      id: schema.properties.id,
      displayName: schema.properties.displayName,
      propertyType: schema.properties.propertyType,
      serviceCity: schema.properties.serviceCity,
      serviceState: schema.properties.serviceState,
      entityId: schema.properties.entityId,
      entityName: schema.entities.name,
    })
    .from(schema.properties)
    .leftJoin(schema.entities, eq(schema.properties.entityId, schema.entities.id))
    .where(eq(schema.properties.organizationId, organizationId))
    .orderBy(schema.properties.displayName);

  return res.status(200).json({
    ok: true,
    organization_id: organizationId,
    count: rows.length,
    properties: rows.map((p) => ({
      id: p.id,
      display_name: p.displayName,
      property_type: p.propertyType,
      service_city: p.serviceCity,
      service_state: p.serviceState,
      entity_id: p.entityId,
      entity_name: p.entityName,
    })),
  });
});
