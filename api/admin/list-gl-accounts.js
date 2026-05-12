// Vercel Serverless Function — list the org's chart of accounts.
//
// GET /api/admin/list-gl-accounts?secret=<TOKEN>
//
// Read-only listing used by the Accounting UI to render the Chart
// of Accounts tab. Returns every gl_accounts row for the default
// org, joined with the count of journal_line postings against it
// (so the UI can dim accounts that have never been touched) and a
// flattened tag map per row.
//
// Optional query params:
//   include_inactive=true    Include is_active=false rows
//                            (default: only active).
//   account_type=expense     Filter by accountType enum.
//
// Response shape:
//   {
//     ok: true,
//     count: <n>,
//     accounts: [
//       { id, code, name, account_type, account_subtype,
//         normal_balance, parent_id, parent_code, is_active,
//         is_system, is_bank, currency, notes,
//         posting_count, tags: { namespace: [value, ...] } }
//     ]
//   }

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

  const includeInactive =
    req.query?.include_inactive === 'true' ||
    req.query?.include_inactive === '1';
  const accountTypeFilter = req.query?.account_type || null;

  const db = getDb();
  const organizationId = await getDefaultOrgId();

  // Build the WHERE clauses.
  const whereClauses = [eq(schema.glAccounts.organizationId, organizationId)];
  if (!includeInactive) {
    whereClauses.push(eq(schema.glAccounts.isActive, true));
  }
  if (accountTypeFilter) {
    whereClauses.push(eq(schema.glAccounts.accountType, accountTypeFilter));
  }

  // Pull the accounts.
  const rows = await db
    .select({
      id: schema.glAccounts.id,
      code: schema.glAccounts.code,
      name: schema.glAccounts.name,
      accountType: schema.glAccounts.accountType,
      accountSubtype: schema.glAccounts.accountSubtype,
      normalBalance: schema.glAccounts.normalBalance,
      parentId: schema.glAccounts.parentId,
      isActive: schema.glAccounts.isActive,
      isSystem: schema.glAccounts.isSystem,
      isBank: schema.glAccounts.isBank,
      currency: schema.glAccounts.currency,
      notes: schema.glAccounts.notes,
    })
    .from(schema.glAccounts)
    .where(and(...whereClauses));

  // Resolve parent_id → parent_code lookup map.
  const codeById = new Map(rows.map((r) => [r.id, r.code]));

  // Get posting counts in one round-trip via aggregate.
  const counts = await db
    .select({
      glAccountId: schema.journalLines.glAccountId,
      count: sql`COUNT(*)`.as('count'),
    })
    .from(schema.journalLines)
    .where(eq(schema.journalLines.organizationId, organizationId))
    .groupBy(schema.journalLines.glAccountId);
  const countsById = new Map(
    counts.map((c) => [c.glAccountId, Number(c.count)]),
  );

  // Get all tags in one round-trip; group by gl_account_id.
  const tagRows = await db
    .select({
      glAccountId: schema.glAccountTags.glAccountId,
      namespace: schema.glAccountTags.namespace,
      value: schema.glAccountTags.value,
    })
    .from(schema.glAccountTags)
    .innerJoin(
      schema.glAccounts,
      eq(schema.glAccountTags.glAccountId, schema.glAccounts.id),
    )
    .where(eq(schema.glAccounts.organizationId, organizationId));

  const tagsByAccount = new Map();
  for (const t of tagRows) {
    if (!tagsByAccount.has(t.glAccountId)) {
      tagsByAccount.set(t.glAccountId, {});
    }
    const map = tagsByAccount.get(t.glAccountId);
    if (!map[t.namespace]) map[t.namespace] = [];
    map[t.namespace].push(t.value);
  }

  // Compose the response.
  const accounts = rows
    .map((r) => ({
      id: r.id,
      code: r.code,
      name: r.name,
      account_type: r.accountType,
      account_subtype: r.accountSubtype,
      normal_balance: r.normalBalance,
      parent_id: r.parentId,
      parent_code: r.parentId ? codeById.get(r.parentId) || null : null,
      is_active: r.isActive,
      is_system: r.isSystem,
      is_bank: r.isBank,
      currency: r.currency,
      notes: r.notes,
      posting_count: countsById.get(r.id) || 0,
      tags: tagsByAccount.get(r.id) || {},
    }))
    .sort((a, b) => a.code.localeCompare(b.code, undefined, { numeric: true }));

  return res.status(200).json({
    ok: true,
    organization_id: organizationId,
    count: accounts.length,
    accounts,
  });
});
