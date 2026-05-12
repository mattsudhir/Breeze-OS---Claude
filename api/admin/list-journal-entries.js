// GET /api/admin/list-journal-entries?secret=<TOKEN>
//   &limit=100                   default: 100, max 500
//   &include_lines=true          default: false. Slower but includes
//                                 the per-entry lines for drill-down.
//   &status=posted               default: all
//
// Returns recent journal entries ordered by entry_date desc /
// entry_number desc. Includes basic metadata + counts of lines and
// total debit/credit.

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

  const limit = Math.min(
    Math.max(parseInt(req.query?.limit, 10) || 100, 1),
    500,
  );
  const status = req.query?.status || null;
  const includeLines =
    req.query?.include_lines === 'true' || req.query?.include_lines === '1';

  const whereClauses = [eq(schema.journalEntries.organizationId, organizationId)];
  if (status) whereClauses.push(eq(schema.journalEntries.status, status));

  const entries = await db
    .select()
    .from(schema.journalEntries)
    .where(and(...whereClauses))
    .orderBy(
      sql`${schema.journalEntries.entryDate} DESC, ${schema.journalEntries.entryNumber} DESC`,
    )
    .limit(limit);

  if (entries.length === 0) {
    return res.status(200).json({
      ok: true,
      organization_id: organizationId,
      count: 0,
      entries: [],
    });
  }

  // Get totals per entry in one round-trip.
  const entryIds = entries.map((e) => e.id);
  const totals = await db
    .select({
      journalEntryId: schema.journalLines.journalEntryId,
      totalDebit: sql`COALESCE(SUM(${schema.journalLines.debitCents}), 0)`.as('total_debit'),
      totalCredit: sql`COALESCE(SUM(${schema.journalLines.creditCents}), 0)`.as('total_credit'),
      lineCount: sql`COUNT(*)`.as('line_count'),
    })
    .from(schema.journalLines)
    .where(sql`${schema.journalLines.journalEntryId} IN ${entryIds}`)
    .groupBy(schema.journalLines.journalEntryId);
  const totalsByEntry = new Map(totals.map((t) => [t.journalEntryId, t]));

  // Optionally include the lines themselves.
  let linesByEntry = new Map();
  if (includeLines) {
    const lines = await db
      .select({
        id: schema.journalLines.id,
        journalEntryId: schema.journalLines.journalEntryId,
        glAccountId: schema.journalLines.glAccountId,
        debitCents: schema.journalLines.debitCents,
        creditCents: schema.journalLines.creditCents,
        lineNumber: schema.journalLines.lineNumber,
        memo: schema.journalLines.memo,
        unitId: schema.journalLines.unitId,
        propertyId: schema.journalLines.propertyId,
        leaseId: schema.journalLines.leaseId,
        tenantId: schema.journalLines.tenantId,
        glCode: schema.glAccounts.code,
        glName: schema.glAccounts.name,
      })
      .from(schema.journalLines)
      .leftJoin(schema.glAccounts, eq(schema.journalLines.glAccountId, schema.glAccounts.id))
      .where(sql`${schema.journalLines.journalEntryId} IN ${entryIds}`)
      .orderBy(
        schema.journalLines.journalEntryId,
        schema.journalLines.lineNumber,
      );
    for (const l of lines) {
      if (!linesByEntry.has(l.journalEntryId)) linesByEntry.set(l.journalEntryId, []);
      linesByEntry.get(l.journalEntryId).push({
        id: l.id,
        gl_account_id: l.glAccountId,
        gl_code: l.glCode,
        gl_name: l.glName,
        debit_cents: l.debitCents,
        credit_cents: l.creditCents,
        line_number: l.lineNumber,
        memo: l.memo,
        unit_id: l.unitId,
        property_id: l.propertyId,
        lease_id: l.leaseId,
        tenant_id: l.tenantId,
      });
    }
  }

  return res.status(200).json({
    ok: true,
    organization_id: organizationId,
    count: entries.length,
    entries: entries.map((e) => {
      const t = totalsByEntry.get(e.id);
      return {
        id: e.id,
        entry_number: e.entryNumber,
        entry_date: e.entryDate,
        entry_type: e.entryType,
        status: e.status,
        memo: e.memo,
        source_table: e.sourceTable,
        source_id: e.sourceId,
        posted_at: e.postedAt,
        line_count: t ? Number(t.lineCount) : 0,
        total_debit_cents: t ? Number(t.totalDebit) : 0,
        total_credit_cents: t ? Number(t.totalCredit) : 0,
        lines: includeLines ? linesByEntry.get(e.id) || [] : undefined,
      };
    }),
  });
});
