// GET /api/admin/list-posted-charges?secret=<TOKEN>
//   &status=open                  default: all non-voided
//   &limit=200                    default: 200, max 500
//   &include_voided=true          default: false
//
// Returns posted_charges joined with tenant + lease + gl_account
// info for the Receivables tab.

import { and, eq, ne, sql } from 'drizzle-orm';
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

  const status = req.query?.status || null;
  const tenantId = req.query?.tenant_id || null;
  const includeVoided =
    req.query?.include_voided === 'true' || req.query?.include_voided === '1';
  const limit = Math.min(
    Math.max(parseInt(req.query?.limit, 10) || 200, 1),
    500,
  );

  const whereClauses = [eq(schema.postedCharges.organizationId, organizationId)];
  if (status) {
    whereClauses.push(eq(schema.postedCharges.status, status));
  } else if (!includeVoided) {
    whereClauses.push(ne(schema.postedCharges.status, 'voided'));
  }
  if (tenantId) {
    whereClauses.push(eq(schema.postedCharges.tenantId, tenantId));
  }

  const rows = await db
    .select({
      id: schema.postedCharges.id,
      tenantId: schema.postedCharges.tenantId,
      leaseId: schema.postedCharges.leaseId,
      unitId: schema.postedCharges.unitId,
      propertyId: schema.postedCharges.propertyId,
      chargeType: schema.postedCharges.chargeType,
      description: schema.postedCharges.description,
      chargeDate: schema.postedCharges.chargeDate,
      dueDate: schema.postedCharges.dueDate,
      amountCents: schema.postedCharges.amountCents,
      balanceCents: schema.postedCharges.balanceCents,
      status: schema.postedCharges.status,
      journalEntryId: schema.postedCharges.journalEntryId,
      // joins
      tenantDisplay: schema.tenants.displayName,
      leaseNumber: schema.leases.leaseNumber,
      glCode: schema.glAccounts.code,
      glName: schema.glAccounts.name,
    })
    .from(schema.postedCharges)
    .leftJoin(schema.tenants, eq(schema.postedCharges.tenantId, schema.tenants.id))
    .leftJoin(schema.leases, eq(schema.postedCharges.leaseId, schema.leases.id))
    .leftJoin(schema.glAccounts, eq(schema.postedCharges.glAccountId, schema.glAccounts.id))
    .where(and(...whereClauses))
    .orderBy(sql`${schema.postedCharges.dueDate} ASC NULLS LAST`)
    .limit(limit);

  // Aggregate summary by status.
  const all = await db
    .select({
      status: schema.postedCharges.status,
      count: sql`COUNT(*)`.as('count'),
      totalAmountCents: sql`COALESCE(SUM(${schema.postedCharges.amountCents}), 0)`.as('total_amount_cents'),
      totalBalanceCents: sql`COALESCE(SUM(${schema.postedCharges.balanceCents}), 0)`.as('total_balance_cents'),
    })
    .from(schema.postedCharges)
    .where(eq(schema.postedCharges.organizationId, organizationId))
    .groupBy(schema.postedCharges.status);

  return res.status(200).json({
    ok: true,
    organization_id: organizationId,
    count: rows.length,
    limit,
    summary_by_status: all.map((r) => ({
      status: r.status,
      count: Number(r.count),
      total_amount_cents: Number(r.totalAmountCents),
      total_balance_cents: Number(r.totalBalanceCents),
    })),
    charges: rows.map((r) => ({
      id: r.id,
      tenant_id: r.tenantId,
      tenant_display: r.tenantDisplay,
      lease_id: r.leaseId,
      lease_number: r.leaseNumber,
      unit_id: r.unitId,
      property_id: r.propertyId,
      charge_type: r.chargeType,
      description: r.description,
      charge_date: r.chargeDate,
      due_date: r.dueDate,
      amount_cents: r.amountCents,
      balance_cents: r.balanceCents,
      status: r.status,
      gl_code: r.glCode,
      gl_name: r.glName,
      journal_entry_id: r.journalEntryId,
    })),
  });
});
