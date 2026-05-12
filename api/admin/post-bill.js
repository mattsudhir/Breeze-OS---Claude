// POST /api/admin/post-bill?secret=<TOKEN>
// body: { bill_id }
//
// Promotes a draft bill to posted (debit lines, credit AP).

import {
  withAdminHandler,
  getDefaultOrgId,
  parseBody,
} from '../../lib/adminHelpers.js';
import { getDb } from '../../lib/db/index.js';
import { postBill } from '../../lib/accounting/apPostingFlows.js';

export default withAdminHandler(async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'POST only' });
  }
  const body = parseBody(req);
  if (!body.bill_id) return res.status(400).json({ ok: false, error: 'bill_id required' });

  const db = getDb();
  const organizationId = await getDefaultOrgId();

  let result;
  try {
    result = await db.transaction(async (tx) => postBill(tx, organizationId, body.bill_id));
  } catch (err) {
    return res.status(400).json({ ok: false, error: err.message || String(err) });
  }

  return res.status(200).json({
    ok: true,
    organization_id: organizationId,
    bill_id: body.bill_id,
    journal_entry_id: result.journalEntryId,
    entry_number: result.entryNumber,
  });
});
