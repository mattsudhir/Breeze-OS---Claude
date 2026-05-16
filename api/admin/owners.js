// Vercel Serverless Function — CRUD for LLC owners.
//
// GET    /api/admin/owners              — list all owners
// GET    /api/admin/owners?id=<uuid>    — fetch one owner
// POST   /api/admin/owners              — create owner
// PATCH  /api/admin/owners?id=<uuid>    — update owner
// DELETE /api/admin/owners?id=<uuid>    — delete owner
//
// All methods require BREEZE_ADMIN_TOKEN via ?secret=, Authorization
// Bearer, or X-Breeze-Admin-Token header. CORS is permissive.
//
// Writable columns:
//   legalName, dba, mailingAddressLine1..Zip, billingEmail,
//   authorizedCallers (jsonb array of {name, title?, phone?})
//
// EIN is not exposed via this endpoint yet — once PR 3 introduces
// pgcrypto column encryption we'll add einEncrypted as a write-only
// field. For now every owner has ein_encrypted = NULL.

import { eq } from 'drizzle-orm';
import { getDb, schema } from '../../lib/db/index.js';
import {
  withAdminHandler,
  getDefaultOrgId,
  parseBody,
  recordAudit,
} from '../../lib/adminHelpers.js';

// Whitelist of columns clients are allowed to set. Rejects any other
// field silently so an over-eager POST can't inject into columns we
// consider internal.
const EDITABLE_FIELDS = [
  'legalName',
  'dba',
  'mailingAddressLine1',
  'mailingAddressLine2',
  'mailingCity',
  'mailingState',
  'mailingZip',
  'billingEmail',
  'authorizedCallers',
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
        .from(schema.owners)
        .where(eq(schema.owners.id, id))
        .limit(1);
      if (rows.length === 0) {
        return res.status(404).json({ ok: false, error: 'Owner not found' });
      }
      return res.status(200).json({ ok: true, owner: rows[0] });
    }
    const rows = await db
      .select()
      .from(schema.owners)
      .where(eq(schema.owners.organizationId, orgId));
    return res.status(200).json({ ok: true, count: rows.length, owners: rows });
  }

  if (req.method === 'POST') {
    const body = parseBody(req);
    const editable = pickEditable(body);
    if (!editable.legalName) {
      return res.status(400).json({
        ok: false,
        error: 'legalName is required',
      });
    }
    const [created] = await db
      .insert(schema.owners)
      .values({
        organizationId: orgId,
        ...editable,
      })
      .returning();
    await recordAudit(req, {
      action: 'CREATE', table: 'owners', id: created.id, after: created,
    });
    return res.status(201).json({ ok: true, owner: created });
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
    // Snapshot pre-change for the audit log.
    const [before] = await db
      .select().from(schema.owners).where(eq(schema.owners.id, id)).limit(1);
    const [updated] = await db
      .update(schema.owners)
      .set({ ...editable, updatedAt: new Date() })
      .where(eq(schema.owners.id, id))
      .returning();
    if (!updated) {
      return res.status(404).json({ ok: false, error: 'Owner not found' });
    }
    await recordAudit(req, {
      action: 'UPDATE', table: 'owners', id, before, after: updated, diff: editable,
    });
    return res.status(200).json({ ok: true, owner: updated });
  }

  if (req.method === 'DELETE') {
    if (!id) {
      return res.status(400).json({ ok: false, error: 'id query param required' });
    }
    const [deleted] = await db
      .delete(schema.owners)
      .where(eq(schema.owners.id, id))
      .returning();
    if (!deleted) {
      return res.status(404).json({ ok: false, error: 'Owner not found' });
    }
    await recordAudit(req, {
      action: 'DELETE', table: 'owners', id, before: deleted,
    });
    return res.status(200).json({ ok: true, deleted });
  }

  return res.status(405).json({ ok: false, error: 'Method not allowed' });
});
