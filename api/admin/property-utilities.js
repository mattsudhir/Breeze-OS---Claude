// Vercel Serverless Function — CRUD for per-property utility config.
//
// GET    /api/admin/property-utilities?propertyId=<uuid>  — list for a property
// POST   /api/admin/property-utilities                    — create
// PATCH  /api/admin/property-utilities?id=<uuid>          — update
// DELETE /api/admin/property-utilities?id=<uuid>          — delete
//
// Writable columns:
//   propertyId, utilityType, providerId, accountHolder,
//   billbackTenant, currentAccountNumber, notes

import { eq } from 'drizzle-orm';
import { getDb, schema } from '../../lib/db/index.js';
import { withAdminHandler, parseBody } from '../../lib/adminHelpers.js';

const EDITABLE_FIELDS = [
  'propertyId',
  'utilityType',
  'providerId',
  'accountHolder',
  'billbackTenant',
  'currentAccountNumber',
  'notes',
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
  const id = req.query?.id || null;
  const propertyId = req.query?.propertyId || null;

  if (req.method === 'GET') {
    if (!propertyId) {
      return res.status(400).json({ ok: false, error: 'propertyId query param required' });
    }
    const rows = await db
      .select()
      .from(schema.propertyUtilities)
      .where(eq(schema.propertyUtilities.propertyId, propertyId));
    return res.status(200).json({ ok: true, count: rows.length, utilities: rows });
  }

  if (req.method === 'POST') {
    const body = parseBody(req);
    const editable = pickEditable(body);
    if (!editable.propertyId || !editable.utilityType || !editable.accountHolder) {
      return res.status(400).json({
        ok: false,
        error: 'propertyId, utilityType, and accountHolder are required',
      });
    }
    const [created] = await db
      .insert(schema.propertyUtilities)
      .values(editable)
      .returning();
    return res.status(201).json({ ok: true, utility: created });
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
      .update(schema.propertyUtilities)
      .set({ ...editable, updatedAt: new Date() })
      .where(eq(schema.propertyUtilities.id, id))
      .returning();
    if (!updated) {
      return res.status(404).json({ ok: false, error: 'Utility config not found' });
    }
    return res.status(200).json({ ok: true, utility: updated });
  }

  if (req.method === 'DELETE') {
    if (!id) {
      return res.status(400).json({ ok: false, error: 'id query param required' });
    }
    const [deleted] = await db
      .delete(schema.propertyUtilities)
      .where(eq(schema.propertyUtilities.id, id))
      .returning();
    if (!deleted) {
      return res.status(404).json({ ok: false, error: 'Utility config not found' });
    }
    return res.status(200).json({ ok: true, deleted });
  }

  return res.status(405).json({ ok: false, error: 'Method not allowed' });
});
