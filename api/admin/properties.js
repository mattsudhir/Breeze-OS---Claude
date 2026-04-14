// Vercel Serverless Function — CRUD for properties.
//
// GET    /api/admin/properties              — list all properties
// GET    /api/admin/properties?id=<uuid>    — fetch one with utilities
// GET    /api/admin/properties?ownerId=<uuid> — list by owner
// POST   /api/admin/properties              — create property
// PATCH  /api/admin/properties?id=<uuid>    — update property
// DELETE /api/admin/properties?id=<uuid>    — delete property
//
// Writable columns:
//   ownerId, sourcePropertyId, displayName, propertyType,
//   serviceAddressLine1..Zip, billingAddressLine1..Zip, notes

import { and, eq } from 'drizzle-orm';
import { getDb, schema } from '../../lib/db/index.js';
import {
  withAdminHandler,
  getDefaultOrgId,
  parseBody,
} from '../../lib/adminHelpers.js';

const EDITABLE_FIELDS = [
  'ownerId',
  'sourcePropertyId',
  'displayName',
  'propertyType',
  'serviceAddressLine1',
  'serviceAddressLine2',
  'serviceCity',
  'serviceState',
  'serviceZip',
  'billingAddressLine1',
  'billingAddressLine2',
  'billingCity',
  'billingState',
  'billingZip',
  'notes',
];

const REQUIRED_ON_CREATE = [
  'ownerId',
  'displayName',
  'serviceAddressLine1',
  'serviceCity',
  'serviceState',
  'serviceZip',
];

function pickEditable(body) {
  const out = {};
  for (const key of EDITABLE_FIELDS) {
    if (body[key] !== undefined) out[key] = body[key];
  }
  return out;
}

export default withAdminHandler(async (req, res) => {
  const db = getDb();
  const orgId = await getDefaultOrgId();
  const id = req.query?.id || null;
  const ownerId = req.query?.ownerId || null;

  if (req.method === 'GET') {
    if (id) {
      // Return property + its utility configs in one payload so the
      // detail page doesn't have to fan out across endpoints.
      const propRows = await db
        .select()
        .from(schema.properties)
        .where(eq(schema.properties.id, id))
        .limit(1);
      if (propRows.length === 0) {
        return res.status(404).json({ ok: false, error: 'Property not found' });
      }
      const utilityRows = await db
        .select()
        .from(schema.propertyUtilities)
        .where(eq(schema.propertyUtilities.propertyId, id));
      return res.status(200).json({
        ok: true,
        property: propRows[0],
        utilities: utilityRows,
      });
    }

    const whereClause = ownerId
      ? and(
          eq(schema.properties.organizationId, orgId),
          eq(schema.properties.ownerId, ownerId),
        )
      : eq(schema.properties.organizationId, orgId);

    const rows = await db.select().from(schema.properties).where(whereClause);
    return res.status(200).json({ ok: true, count: rows.length, properties: rows });
  }

  if (req.method === 'POST') {
    const body = parseBody(req);
    const editable = pickEditable(body);
    for (const field of REQUIRED_ON_CREATE) {
      if (!editable[field]) {
        return res.status(400).json({
          ok: false,
          error: `${field} is required`,
        });
      }
    }
    const [created] = await db
      .insert(schema.properties)
      .values({
        organizationId: orgId,
        ...editable,
      })
      .returning();
    return res.status(201).json({ ok: true, property: created });
  }

  if (req.method === 'PATCH') {
    if (!id) {
      return res.status(400).json({ ok: false, error: 'id query param required' });
    }
    const body = parseBody(req);
    const editable = pickEditable(body);
    if (Object.keys(editable).length === 0) {
      return res.status(400).json({ ok: false, error: 'No editable fields provided' });
    }
    const [updated] = await db
      .update(schema.properties)
      .set({ ...editable, updatedAt: new Date() })
      .where(eq(schema.properties.id, id))
      .returning();
    if (!updated) {
      return res.status(404).json({ ok: false, error: 'Property not found' });
    }
    return res.status(200).json({ ok: true, property: updated });
  }

  if (req.method === 'DELETE') {
    if (!id) {
      return res.status(400).json({ ok: false, error: 'id query param required' });
    }
    const [deleted] = await db
      .delete(schema.properties)
      .where(eq(schema.properties.id, id))
      .returning();
    if (!deleted) {
      return res.status(404).json({ ok: false, error: 'Property not found' });
    }
    return res.status(200).json({ ok: true, deleted });
  }

  return res.status(405).json({ ok: false, error: 'Method not allowed' });
});
