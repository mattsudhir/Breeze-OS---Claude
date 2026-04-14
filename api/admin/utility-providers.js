// Vercel Serverless Function — CRUD for utility provider playbooks.
//
// GET    /api/admin/utility-providers              — list all
// GET    /api/admin/utility-providers?id=<uuid>    — fetch one
// POST   /api/admin/utility-providers              — create
// PATCH  /api/admin/utility-providers?id=<uuid>    — update
// DELETE /api/admin/utility-providers?id=<uuid>    — delete
//
// Writable columns:
//   name, phoneNumber, website, businessHours, expectedHoldMinutes,
//   callScriptNotes, requiredFields

import { eq } from 'drizzle-orm';
import { getDb, schema } from '../../lib/db/index.js';
import {
  withAdminHandler,
  getDefaultOrgId,
  parseBody,
} from '../../lib/adminHelpers.js';

const EDITABLE_FIELDS = [
  'name',
  'phoneNumber',
  'website',
  'businessHours',
  'expectedHoldMinutes',
  'callScriptNotes',
  'requiredFields',
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

  if (req.method === 'GET') {
    if (id) {
      const rows = await db
        .select()
        .from(schema.utilityProviders)
        .where(eq(schema.utilityProviders.id, id))
        .limit(1);
      if (rows.length === 0) {
        return res.status(404).json({ ok: false, error: 'Provider not found' });
      }
      return res.status(200).json({ ok: true, provider: rows[0] });
    }
    const rows = await db
      .select()
      .from(schema.utilityProviders)
      .where(eq(schema.utilityProviders.organizationId, orgId));
    return res.status(200).json({ ok: true, count: rows.length, providers: rows });
  }

  if (req.method === 'POST') {
    const body = parseBody(req);
    const editable = pickEditable(body);
    if (!editable.name) {
      return res.status(400).json({
        ok: false,
        error: 'name is required',
      });
    }
    const [created] = await db
      .insert(schema.utilityProviders)
      .values({
        organizationId: orgId,
        ...editable,
      })
      .returning();
    return res.status(201).json({ ok: true, provider: created });
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
      .update(schema.utilityProviders)
      .set({ ...editable, updatedAt: new Date() })
      .where(eq(schema.utilityProviders.id, id))
      .returning();
    if (!updated) {
      return res.status(404).json({ ok: false, error: 'Provider not found' });
    }
    return res.status(200).json({ ok: true, provider: updated });
  }

  if (req.method === 'DELETE') {
    if (!id) {
      return res.status(400).json({ ok: false, error: 'id query param required' });
    }
    const [deleted] = await db
      .delete(schema.utilityProviders)
      .where(eq(schema.utilityProviders.id, id))
      .returning();
    if (!deleted) {
      return res.status(404).json({ ok: false, error: 'Provider not found' });
    }
    return res.status(200).json({ ok: true, deleted });
  }

  return res.status(405).json({ ok: false, error: 'Method not allowed' });
});
