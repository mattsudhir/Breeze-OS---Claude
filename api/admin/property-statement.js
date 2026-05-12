// GET /api/admin/property-statement?secret=<TOKEN>
//   &property_id=<uuid>
//   &from=YYYY-MM-DD
//   &to=YYYY-MM-DD
//
// Owner-statement-style report for a single property over a date
// range. Returns income + expense lines grouped by GL account, with
// totals and net cash flow. Powers the per-property statement view
// on the Reports tab.

import { and, eq, sql, gte, lte } from 'drizzle-orm';
import {
  withAdminHandler,
  getDefaultOrgId,
} from '../../lib/adminHelpers.js';
import { getDb, schema } from '../../lib/db/index.js';

export default withAdminHandler(async (req, res) => {
  if (req.method !== 'GET') {
    return res.status(405).json({ ok: false, error: 'GET only' });
  }
  const propertyId = req.query?.property_id;
  if (!propertyId) {
    return res.status(400).json({ ok: false, error: 'property_id required' });
  }
  const from = req.query?.from;
  const to = req.query?.to;

  const db = getDb();
  const organizationId = await getDefaultOrgId();

  const [property] = await db
    .select({
      id: schema.properties.id,
      displayName: schema.properties.displayName,
      serviceAddressLine1: schema.properties.serviceAddressLine1,
      serviceCity: schema.properties.serviceCity,
      serviceState: schema.properties.serviceState,
      serviceZip: schema.properties.serviceZip,
      entityId: schema.properties.entityId,
      entityName: schema.entities.name,
    })
    .from(schema.properties)
    .leftJoin(schema.entities, eq(schema.properties.entityId, schema.entities.id))
    .where(
      and(
        eq(schema.properties.id, propertyId),
        eq(schema.properties.organizationId, organizationId),
      ),
    )
    .limit(1);
  if (!property) return res.status(404).json({ ok: false, error: 'property not found' });

  const whereClauses = [
    eq(schema.journalLines.organizationId, organizationId),
    eq(schema.journalLines.propertyId, propertyId),
    eq(schema.journalEntries.status, 'posted'),
  ];
  if (from) whereClauses.push(gte(schema.journalEntries.entryDate, from));
  if (to)   whereClauses.push(lte(schema.journalEntries.entryDate, to));

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

  const income = [];
  const expenses = [];
  let totalIncomeCents = 0;
  let totalExpenseCents = 0;

  for (const r of rows) {
    const dr = Number(r.debitCents) || 0;
    const cr = Number(r.creditCents) || 0;
    if (dr === 0 && cr === 0) continue;
    // For income accounts (credit-normal), positive = credit-debit.
    // For expense accounts (debit-normal), positive = debit-credit.
    const net = r.normalBalance === 'debit' ? dr - cr : cr - dr;
    const entry = {
      gl_account_id: r.glAccountId,
      code: r.code,
      name: r.name,
      debit_cents: dr,
      credit_cents: cr,
      net_cents: net,
    };
    if (r.accountType === 'income') {
      income.push(entry);
      totalIncomeCents += net;
    } else if (r.accountType === 'expense') {
      expenses.push(entry);
      totalExpenseCents += net;
    }
  }

  return res.status(200).json({
    ok: true,
    organization_id: organizationId,
    property: {
      id: property.id,
      display_name: property.displayName,
      service_address: `${property.serviceAddressLine1}, ${property.serviceCity}, ${property.serviceState} ${property.serviceZip}`,
      entity_id: property.entityId,
      entity_name: property.entityName,
    },
    period: { from: from || null, to: to || null },
    income,
    expenses,
    total_income_cents: totalIncomeCents,
    total_expense_cents: totalExpenseCents,
    net_cash_flow_cents: totalIncomeCents - totalExpenseCents,
  });
});
