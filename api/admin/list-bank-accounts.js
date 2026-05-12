// Vercel Serverless Function — list bank accounts for the org.
//
// GET /api/admin/list-bank-accounts?secret=<TOKEN>
//
// Returns every bank_account with its linked GL info, current
// balance, Plaid status, and a count of unmatched bank_transactions
// awaiting reconciliation. Used by the Bank Accounts tab in the
// Accounting page.

import { and, eq, sql } from 'drizzle-orm';
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

  // Bank accounts joined to gl_accounts (for code + name).
  const rows = await db
    .select({
      id: schema.bankAccounts.id,
      displayName: schema.bankAccounts.displayName,
      institutionName: schema.bankAccounts.institutionName,
      accountType: schema.bankAccounts.accountType,
      accountLast4: schema.bankAccounts.accountLast4,
      currentBalanceCents: schema.bankAccounts.currentBalanceCents,
      balanceAsOf: schema.bankAccounts.balanceAsOf,
      plaidItemId: schema.bankAccounts.plaidItemId,
      plaidAccountId: schema.bankAccounts.plaidAccountId,
      plaidStatus: schema.bankAccounts.plaidStatus,
      isTrust: schema.bankAccounts.isTrust,
      trustPurpose: schema.bankAccounts.trustPurpose,
      billComBankAccountId: schema.bankAccounts.billComBankAccountId,
      glAccountId: schema.bankAccounts.glAccountId,
      glCode: schema.glAccounts.code,
      glName: schema.glAccounts.name,
      glAccountType: schema.glAccounts.accountType,
      glIsActive: schema.glAccounts.isActive,
      createdAt: schema.bankAccounts.createdAt,
    })
    .from(schema.bankAccounts)
    .leftJoin(
      schema.glAccounts,
      eq(schema.bankAccounts.glAccountId, schema.glAccounts.id),
    )
    .where(eq(schema.bankAccounts.organizationId, organizationId));

  // Count parked GLs that haven't been linked yet (so the UI can
  // surface the "Convert N parked accounts" CTA).
  const parkedAudit = await db
    .select({
      subjectId: schema.auditEvents.subjectId,
      eventType: schema.auditEvents.eventType,
    })
    .from(schema.auditEvents)
    .where(
      and(
        eq(schema.auditEvents.organizationId, organizationId),
        eq(schema.auditEvents.subjectTable, 'gl_accounts'),
        sql`${schema.auditEvents.eventType} IN ('coa_parked_bank', 'coa_parked_credit_card')`,
      ),
    );

  const parkedIds = new Set(parkedAudit.map((r) => r.subjectId));
  const linkedGlIds = new Set(rows.map((r) => r.glAccountId));
  const unlinkedParked = [...parkedIds].filter((id) => !linkedGlIds.has(id));
  const parkedSummary = {
    total: parkedAudit.length,
    bank: parkedAudit.filter((r) => r.eventType === 'coa_parked_bank').length,
    credit_card: parkedAudit.filter((r) => r.eventType === 'coa_parked_credit_card').length,
    still_unlinked: unlinkedParked.length,
  };

  const bankAccounts = rows
    .map((r) => ({
      id: r.id,
      display_name: r.displayName,
      institution_name: r.institutionName,
      account_type: r.accountType,
      account_last4: r.accountLast4,
      current_balance_cents: r.currentBalanceCents,
      balance_as_of: r.balanceAsOf,
      plaid_item_id: r.plaidItemId,
      plaid_account_id: r.plaidAccountId,
      plaid_status: r.plaidStatus,
      is_trust: r.isTrust,
      trust_purpose: r.trustPurpose,
      bill_com_bank_account_id: r.billComBankAccountId,
      gl_account_id: r.glAccountId,
      gl_code: r.glCode,
      gl_name: r.glName,
      gl_account_type: r.glAccountType,
      gl_is_active: r.glIsActive,
      created_at: r.createdAt,
    }))
    .sort((a, b) => (a.gl_code || '').localeCompare(b.gl_code || '', undefined, { numeric: true }));

  return res.status(200).json({
    ok: true,
    organization_id: organizationId,
    count: bankAccounts.length,
    bank_accounts: bankAccounts,
    parked_summary: parkedSummary,
  });
});
