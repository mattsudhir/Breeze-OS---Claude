// POST /api/admin/upsert-vendor?secret=<TOKEN>
// body: {
//   id?:                   uuid
//   display_name:          string  required on create
//   legal_name?:           string
//   vendor_type?:          'individual'|'business'|'government'|'utility'|'insurance'|'other'
//   contact_email?:        string
//   contact_phone?:        string
//   remit_address_line1?:  string
//   remit_address_line2?:  string
//   remit_city?:           string
//   remit_state?:          string
//   remit_zip?:            string
//   tax_id?:               string (plaintext; encrypted server-side; pass '' to clear)
//   is_1099_eligible?:     boolean
//   payment_terms_days?:   integer >= 0
//   default_gl_account_id?: uuid | null
//   is_active?:            boolean
//   notes?:                string
// }

import { and, eq } from 'drizzle-orm';
import {
  withAdminHandler,
  getDefaultOrgId,
  parseBody,
} from '../../lib/adminHelpers.js';
import { getDb, schema } from '../../lib/db/index.js';
import { encryptText, isEncryptionConfigured } from '../../lib/encryption.js';

const VALID_TYPES = new Set([
  'individual', 'business', 'government', 'utility', 'insurance', 'other',
]);

export default withAdminHandler(async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'POST only' });
  }
  const body = parseBody(req);
  const id = body.id || null;

  if (body.vendor_type !== undefined && !VALID_TYPES.has(body.vendor_type)) {
    return res.status(400).json({
      ok: false,
      error: `vendor_type must be one of ${Array.from(VALID_TYPES).join(', ')}`,
    });
  }
  if (body.payment_terms_days !== undefined) {
    const n = Number(body.payment_terms_days);
    if (!Number.isInteger(n) || n < 0) {
      return res.status(400).json({ ok: false, error: 'payment_terms_days must be a non-negative integer' });
    }
  }
  if (!id && (!body.display_name || !String(body.display_name).trim())) {
    return res.status(400).json({ ok: false, error: 'display_name required on create' });
  }

  const values = { updatedAt: new Date() };
  if (body.display_name !== undefined) values.displayName = String(body.display_name).trim();
  if (body.legal_name !== undefined) values.legalName = body.legal_name || null;
  if (body.vendor_type !== undefined) values.vendorType = body.vendor_type;
  if (body.contact_email !== undefined) values.contactEmail = body.contact_email || null;
  if (body.contact_phone !== undefined) values.contactPhone = body.contact_phone || null;
  if (body.remit_address_line1 !== undefined) values.remitAddressLine1 = body.remit_address_line1 || null;
  if (body.remit_address_line2 !== undefined) values.remitAddressLine2 = body.remit_address_line2 || null;
  if (body.remit_city !== undefined) values.remitCity = body.remit_city || null;
  if (body.remit_state !== undefined) values.remitState = body.remit_state || null;
  if (body.remit_zip !== undefined) values.remitZip = body.remit_zip || null;
  if (body.is_1099_eligible !== undefined) values.is1099Eligible = !!body.is_1099_eligible;
  if (body.payment_terms_days !== undefined) values.paymentTermsDays = Number(body.payment_terms_days);
  if (body.default_gl_account_id !== undefined) values.defaultGlAccountId = body.default_gl_account_id || null;
  if (body.is_active !== undefined) values.isActive = !!body.is_active;
  if (body.notes !== undefined) values.notes = body.notes || null;

  if (body.tax_id !== undefined) {
    if (body.tax_id === '' || body.tax_id === null) {
      values.taxIdEncrypted = null;
      values.taxIdLast4 = null;
    } else {
      if (!isEncryptionConfigured()) {
        return res.status(503).json({ ok: false, error: 'BREEZE_ENCRYPTION_KEY not set' });
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
      .update(schema.vendors)
      .set(values)
      .where(
        and(
          eq(schema.vendors.id, id),
          eq(schema.vendors.organizationId, organizationId),
        ),
      )
      .returning({ id: schema.vendors.id });
    if (updated.length === 0) {
      return res.status(404).json({ ok: false, error: 'vendor not found' });
    }
    result = { id: updated[0].id, created: false };
  } else {
    const created = await db
      .insert(schema.vendors)
      .values({ organizationId, ...values })
      .returning({ id: schema.vendors.id });
    result = { id: created[0].id, created: true };
  }

  return res.status(200).json({ ok: true, organization_id: organizationId, vendor: result });
});
