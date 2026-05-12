// POST /api/admin/post-opening-balance?secret=<TOKEN>
// body: {
//   entry_date:  "YYYY-MM-DD"   // cutover date (last day of prior period)
//   entity_id:   uuid           // which entity these balances belong to
//   memo?:       string
//   lines: [
//     {
//       gl_account_code: "1100",
//       debit_cents:     123456,   // or
//       credit_cents:    123456,   // exactly one non-zero
//       property_id?:    uuid,
//       unit_id?:        uuid,
//       tenant_id?:      uuid,
//       memo?:           string
//     }, ...
//   ]
// }
//
// Posts a single balanced journal_entry of type 'opening_balance'
// that establishes the starting trial balance for an entity at a
// cutover date. Typical use: take AppFolio's trial balance report
// as of cutover and pipe the numbers through this endpoint.
//
// All lines inherit the entity_id (caller-supplied at the entry
// level rather than per-line for ergonomics). property_id et al
// are still per-line so per-property opening balances tag right.
//
// The DB trigger validates balance + non-zero at the moment of
// posting — a malformed trial balance rolls back cleanly.

import { eq, and } from 'drizzle-orm';
import {
  withAdminHandler,
  getDefaultOrgId,
  parseBody,
} from '../../lib/adminHelpers.js';
import { getDb, schema } from '../../lib/db/index.js';
import { lookupGlAccountByCode, postJournalEntry } from '../../lib/accounting/posting.js';

export default withAdminHandler(async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'POST only' });
  }
  const body = parseBody(req);
  const entryDate = body.entry_date;
  const entityId = body.entity_id || null;
  const memo = body.memo || 'Opening balance';
  const lines = Array.isArray(body.lines) ? body.lines : [];

  if (!entryDate || !/^\d{4}-\d{2}-\d{2}$/.test(entryDate)) {
    return res.status(400).json({
      ok: false,
      error: 'entry_date required (YYYY-MM-DD)',
    });
  }
  if (!entityId) {
    return res.status(400).json({ ok: false, error: 'entity_id required' });
  }
  if (lines.length === 0) {
    return res.status(400).json({ ok: false, error: 'lines required' });
  }

  // Validate each line shape before opening a transaction.
  for (const [i, l] of lines.entries()) {
    if (!l.gl_account_code) {
      return res.status(400).json({ ok: false, error: `lines[${i}].gl_account_code required` });
    }
    const dr = Number(l.debit_cents || 0);
    const cr = Number(l.credit_cents || 0);
    if (!Number.isInteger(dr) || dr < 0) {
      return res.status(400).json({ ok: false, error: `lines[${i}].debit_cents must be a non-negative integer` });
    }
    if (!Number.isInteger(cr) || cr < 0) {
      return res.status(400).json({ ok: false, error: `lines[${i}].credit_cents must be a non-negative integer` });
    }
    if ((dr > 0) === (cr > 0)) {
      return res.status(400).json({ ok: false, error: `lines[${i}] must have exactly one of debit_cents or credit_cents non-zero` });
    }
  }

  const db = getDb();
  const organizationId = await getDefaultOrgId();

  // Verify entity belongs to org.
  const [entity] = await db
    .select({ id: schema.entities.id })
    .from(schema.entities)
    .where(
      and(
        eq(schema.entities.id, entityId),
        eq(schema.entities.organizationId, organizationId),
      ),
    )
    .limit(1);
  if (!entity) return res.status(404).json({ ok: false, error: 'entity_id not in org' });

  let result;
  try {
    result = await db.transaction(async (tx) => {
      // Resolve account codes once. lookupGlAccountByCode throws if
      // a code is missing — that fails the whole entry, which is the
      // right behavior (don't post half a trial balance).
      const resolvedLines = [];
      for (const l of lines) {
        const glAccountId = await lookupGlAccountByCode(
          tx,
          organizationId,
          String(l.gl_account_code),
        );
        resolvedLines.push({
          glAccountId,
          debitCents: Number(l.debit_cents || 0),
          creditCents: Number(l.credit_cents || 0),
          memo: l.memo || null,
          entityId,
          propertyId: l.property_id || null,
          unitId: l.unit_id || null,
          tenantId: l.tenant_id || null,
        });
      }

      return await postJournalEntry(tx, organizationId, {
        entryDate,
        entryType: 'opening_balance',
        memo,
        sourceTable: 'opening_balance_import',
        sourceId: null,
        lines: resolvedLines,
      });
    });
  } catch (err) {
    return res.status(400).json({ ok: false, error: err.message || String(err) });
  }

  return res.status(200).json({
    ok: true,
    organization_id: organizationId,
    entity_id: entityId,
    journal_entry_id: result.journalEntryId,
    entry_number: result.entryNumber,
    line_count: result.lineIds.length,
  });
});
