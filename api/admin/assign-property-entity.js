// POST /api/admin/assign-property-entity?secret=<TOKEN>
// body: { property_id, entity_id | null }
//
// Sets or clears properties.entity_id. Future postings against this
// property inherit the new entity. Past journal_lines keep their
// recorded entity_id (whatever it was at posting time) — that's the
// right call for audit (re-tagging historical entries would change
// closed-period reports).

import { and, eq } from 'drizzle-orm';
import {
  withAdminHandler,
  getDefaultOrgId,
  parseBody,
} from '../../lib/adminHelpers.js';
import { getDb, schema } from '../../lib/db/index.js';

export default withAdminHandler(async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'POST only' });
  }
  const body = parseBody(req);
  const propertyId = body.property_id;
  const entityId = body.entity_id === undefined ? undefined : body.entity_id;
  if (!propertyId) {
    return res.status(400).json({ ok: false, error: 'property_id required' });
  }
  if (entityId === undefined) {
    return res.status(400).json({
      ok: false,
      error: 'entity_id required (pass null to unassign)',
    });
  }

  const db = getDb();
  const organizationId = await getDefaultOrgId();

  // If assigning to an entity, sanity-check it belongs to the same org.
  if (entityId !== null) {
    const [e] = await db
      .select({ id: schema.entities.id })
      .from(schema.entities)
      .where(
        and(
          eq(schema.entities.id, entityId),
          eq(schema.entities.organizationId, organizationId),
        ),
      )
      .limit(1);
    if (!e) {
      return res.status(404).json({ ok: false, error: 'entity not found in org' });
    }
  }

  const updated = await db
    .update(schema.properties)
    .set({ entityId, updatedAt: new Date() })
    .where(
      and(
        eq(schema.properties.id, propertyId),
        eq(schema.properties.organizationId, organizationId),
      ),
    )
    .returning({ id: schema.properties.id, entityId: schema.properties.entityId });

  if (updated.length === 0) {
    return res.status(404).json({ ok: false, error: 'property not found in org' });
  }

  return res.status(200).json({
    ok: true,
    organization_id: organizationId,
    property_id: updated[0].id,
    entity_id: updated[0].entityId,
  });
});
