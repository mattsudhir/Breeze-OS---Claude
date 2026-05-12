// GET /api/admin/list-vendors?secret=<TOKEN>&include_inactive=true
//
// Returns every vendor with default-GL info joined for display.

import { and, eq } from 'drizzle-orm';
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
    req.query?.include_inactive === 'true' || req.query?.include_inactive === '1';

  const whereClauses = [eq(schema.vendors.organizationId, organizationId)];
  if (!includeInactive) whereClauses.push(eq(schema.vendors.isActive, true));

  const rows = await db
    .select({
      id: schema.vendors.id,
      displayName: schema.vendors.displayName,
      legalName: schema.vendors.legalName,
      vendorType: schema.vendors.vendorType,
      contactEmail: schema.vendors.contactEmail,
      contactPhone: schema.vendors.contactPhone,
      remitCity: schema.vendors.remitCity,
      remitState: schema.vendors.remitState,
      taxIdLast4: schema.vendors.taxIdLast4,
      is1099Eligible: schema.vendors.is1099Eligible,
      paymentTermsDays: schema.vendors.paymentTermsDays,
      defaultGlAccountId: schema.vendors.defaultGlAccountId,
      defaultGlCode: schema.glAccounts.code,
      defaultGlName: schema.glAccounts.name,
      isActive: schema.vendors.isActive,
      sourceVendorId: schema.vendors.sourceVendorId,
      notes: schema.vendors.notes,
      createdAt: schema.vendors.createdAt,
    })
    .from(schema.vendors)
    .leftJoin(schema.glAccounts, eq(schema.vendors.defaultGlAccountId, schema.glAccounts.id))
    .where(and(...whereClauses))
    .orderBy(schema.vendors.displayName);

  return res.status(200).json({
    ok: true,
    organization_id: organizationId,
    count: rows.length,
    vendors: rows.map((v) => ({
      id: v.id,
      display_name: v.displayName,
      legal_name: v.legalName,
      vendor_type: v.vendorType,
      contact_email: v.contactEmail,
      contact_phone: v.contactPhone,
      remit_city: v.remitCity,
      remit_state: v.remitState,
      tax_id_last4: v.taxIdLast4,
      is_1099_eligible: v.is1099Eligible,
      payment_terms_days: v.paymentTermsDays,
      default_gl_account_id: v.defaultGlAccountId,
      default_gl_code: v.defaultGlCode,
      default_gl_name: v.defaultGlName,
      is_active: v.isActive,
      source_vendor_id: v.sourceVendorId,
      notes: v.notes,
      created_at: v.createdAt,
    })),
  });
});
