// GET /api/admin/entity-trial-balance?secret=<TOKEN>&entity_id=<uuid>&as_of=YYYY-MM-DD
//
// Returns a trial balance for one entity (or all entities if
// entity_id is omitted), as of the given date (inclusive). Sums
// posted journal_lines's debits and credits per gl_account, then
// reports the net balance with normal-balance sign convention.
//
// Result is ordered by gl_account.code. Zero-balance accounts are
// omitted to keep the response tight.

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
  const entityId = req.query?.entity_id || null;
  const asOf = req.query?.as_of || null;

  const whereClauses = [
    eq(schema.journalLines.organizationId, organizationId),
    eq(schema.journalEntries.status, 'posted'),
  ];
  if (entityId) whereClauses.push(eq(schema.journalLines.entityId, entityId));
  if (asOf) whereClauses.push(sql`${schema.journalEntries.entryDate} <= ${asOf}`);

  const rows = await db
    .select({
      glAccountId: schema.journalLines.glAccountId,
      code: schema.glAccounts.code,
      name: schema.glAccounts.name,
      accountType: schema.glAccounts.accountType,
      normalBalance: schema.glAccounts.normalBalance,
      debitCents: sql`SUM(${schema.journalLines.debitCents})`.as('debit_cents'),
      creditCents: sql`SUM(${schema.journalLines.creditCents})`.as('credit_cents'),
    })
    .from(schema.journalLines)
    .innerJoin(
      schema.journalEntries,
      eq(schema.journalLines.journalEntryId, schema.journalEntries.id),
    )
    .innerJoin(
      schema.glAccounts,
      eq(schema.journalLines.glAccountId, schema.glAccounts.id),
    )
    .where(and(...whereClauses))
    .groupBy(
      schema.journalLines.glAccountId,
      schema.glAccounts.code,
      schema.glAccounts.name,
      schema.glAccounts.accountType,
      schema.glAccounts.normalBalance,
    )
    .orderBy(schema.glAccounts.code);

  let totalDebits = 0;
  let totalCredits = 0;
  const accounts = [];
  for (const r of rows) {
    const dr = Number(r.debitCents) || 0;
    const cr = Number(r.creditCents) || 0;
    const net = r.normalBalance === 'debit' ? dr - cr : cr - dr;
    if (dr === 0 && cr === 0) continue;
    totalDebits += dr;
    totalCredits += cr;
    accounts.push({
      gl_account_id: r.glAccountId,
      code: r.code,
      name: r.name,
      account_type: r.accountType,
      normal_balance: r.normalBalance,
      debit_cents: dr,
      credit_cents: cr,
      net_cents: net,
    });
  }

  return res.status(200).json({
    ok: true,
    organization_id: organizationId,
    entity_id: entityId,
    as_of: asOf,
    total_debit_cents: totalDebits,
    total_credit_cents: totalCredits,
    in_balance: totalDebits === totalCredits,
    accounts,
  });
});
