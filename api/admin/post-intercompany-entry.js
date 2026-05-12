// POST /api/admin/post-intercompany-entry?secret=<TOKEN>
// body: {
//   from_entity_id, to_entity_id,
//   amount_cents,
//   from_account_code, to_account_code,
//   entry_date, memo?
// }
//
// Posts a balanced 4-line journal_entry crossing two entities. See
// lib/accounting/intercompany.js for the canonical layout. The
// transaction wraps the entire post so a malformed entry rolls back
// cleanly (e.g. missing GL account code).

import {
  withAdminHandler,
  getDefaultOrgId,
  parseBody,
} from '../../lib/adminHelpers.js';
import { getDb } from '../../lib/db/index.js';
import { postIntercompanyEntry } from '../../lib/accounting/intercompany.js';

export default withAdminHandler(async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'POST only' });
  }
  const body = parseBody(req);
  const required = [
    'from_entity_id',
    'to_entity_id',
    'amount_cents',
    'from_account_code',
    'to_account_code',
    'entry_date',
  ];
  for (const k of required) {
    if (body[k] === undefined || body[k] === null || body[k] === '') {
      return res.status(400).json({ ok: false, error: `${k} required` });
    }
  }
  const amountCents = Number(body.amount_cents);
  if (!Number.isInteger(amountCents) || amountCents <= 0) {
    return res.status(400).json({
      ok: false,
      error: 'amount_cents must be a positive integer',
    });
  }

  const db = getDb();
  const organizationId = await getDefaultOrgId();

  let result;
  try {
    result = await db.transaction(async (tx) => {
      return await postIntercompanyEntry(tx, organizationId, {
        fromEntityId: body.from_entity_id,
        toEntityId: body.to_entity_id,
        amountCents,
        fromAccountCode: String(body.from_account_code),
        toAccountCode: String(body.to_account_code),
        entryDate: body.entry_date,
        memo: body.memo || null,
      });
    });
  } catch (err) {
    return res.status(400).json({ ok: false, error: err.message || String(err) });
  }

  return res.status(200).json({
    ok: true,
    organization_id: organizationId,
    journal_entry_id: result.journalEntryId,
    entry_number: result.entryNumber,
    line_count: result.lineIds.length,
  });
});
