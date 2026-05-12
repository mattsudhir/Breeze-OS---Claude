// POST /api/admin/upsert-entity?secret=<TOKEN>
// body: {
//   id?:                    string  // present = update, absent = create
//   name:                   string  required on create
//   legal_name?:            string
//   entity_type?:           'llc' | 'corp' | 'partnership' | 'sole_prop' | 'trust' | 'individual'
//   tax_id?:                string  // plaintext, encrypted server-side
//   formation_state?:       string
//   formation_date?:        YYYY-MM-DD
//   fiscal_year_end_month?: 1-12
//   is_active?:             boolean // pass false to soft-deactivate
//   notes?:                 string
// }
//
// Encrypts tax_id with lib/encryption.js (AES-256-GCM,
// "iv:tag:ciphertext" hex). Stores last4 separately for display.

import { and, eq } from 'drizzle-orm';
import {
  withAdminHandler,
  getDefaultOrgId,
  parseBody,
} from '../../lib/adminHelpers.js';
import { getDb, schema } from '../../lib/db/index.js';
import { encryptText, isEncryptionConfigured } from '../../lib/encryption.js';

const VALID_TYPES = new Set([
  'llc',
  'corp',
  'partnership',
  'sole_prop',
  'trust',
  'individual',
]);

export default withAdminHandler(async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'POST only' });
  }
  const body = parseBody(req);
  const id = body.id || null;

  // Validate enum / range on whatever was provided.
  if (body.entity_type !== undefined && !VALID_TYPES.has(body.entity_type)) {
    return res.status(400).json({
      ok: false,
      error: `entity_type must be one of ${Array.from(VALID_TYPES).join(', ')}`,
    });
  }
  if (body.fiscal_year_end_month !== undefined) {
    const n = Number(body.fiscal_year_end_month);
    if (!Number.isInteger(n) || n < 1 || n > 12) {
      return res.status(400).json({
        ok: false,
        error: 'fiscal_year_end_month must be an integer 1-12',
      });
    }
  }
  if (!id) {
    if (!body.name || typeof body.name !== 'string' || body.name.trim().length === 0) {
      return res.status(400).json({ ok: false, error: 'name required on create' });
    }
    if (!body.entity_type) {
      return res.status(400).json({ ok: false, error: 'entity_type required on create' });
    }
  }

  // Build the patch / values object.
  const values = { updatedAt: new Date() };
  if (body.name !== undefined) values.name = String(body.name).trim();
  if (body.legal_name !== undefined) values.legalName = body.legal_name || null;
  if (body.entity_type !== undefined) values.entityType = body.entity_type;
  if (body.formation_state !== undefined) values.formationState = body.formation_state || null;
  if (body.formation_date !== undefined) values.formationDate = body.formation_date || null;
  if (body.fiscal_year_end_month !== undefined) {
    values.fiscalYearEndMonth = Number(body.fiscal_year_end_month);
  }
  if (body.is_active !== undefined) values.isActive = !!body.is_active;
  if (body.notes !== undefined) values.notes = body.notes || null;

  // tax_id is encrypted; only stored if explicitly provided. Pass
  // an empty string to clear (encrypted + last4 both set null).
  if (body.tax_id !== undefined) {
    if (body.tax_id === '' || body.tax_id === null) {
      values.taxIdEncrypted = null;
      values.taxIdLast4 = null;
    } else {
      if (!isEncryptionConfigured()) {
        return res.status(503).json({
          ok: false,
          error: 'BREEZE_ENCRYPTION_KEY not set; cannot store tax_id',
        });
      }
      const plain = String(body.tax_id).replace(/[^0-9A-Za-z]/g, '');
      values.taxIdEncrypted = encryptText(plain);
      values.taxIdLast4 = plain.slice(-4);
    }
  }

  const db = getDb();
  const organizationId = await getDefaultOrgId();

  let result;
  if (id) {
    const updated = await db
      .update(schema.entities)
      .set(values)
      .where(
        and(
          eq(schema.entities.id, id),
          eq(schema.entities.organizationId, organizationId),
        ),
      )
      .returning({ id: schema.entities.id });
    if (updated.length === 0) {
      return res.status(404).json({ ok: false, error: 'entity not found' });
    }
    result = { id: updated[0].id, created: false };
  } else {
    const created = await db
      .insert(schema.entities)
      .values({ organizationId, ...values })
      .returning({ id: schema.entities.id });
    result = { id: created[0].id, created: true };
  }

  return res.status(200).json({
    ok: true,
    organization_id: organizationId,
    entity: result,
  });
});
