// Service helpers for applying default classification tags to GL
// accounts.
//
// Two entry points:
//
//   applyDefaultTagsForAccount(tx, glAccountId, accountData)
//     — Called during INSERT (seedChartOfAccounts and
//       importAppfolioCoa) so newly created accounts pick up their
//       classification tags atomically inside the same transaction.
//
//   backfillDefaultTagsForOrg(db, organizationId)
//     — One-shot batch operation for existing rows. Reads every
//       gl_accounts row for the org, computes its default tags, and
//       inserts the missing ones. Idempotent. Used right after the
//       AppFolio import to tag the 245 just-imported accounts.

import { eq } from 'drizzle-orm';
import { glAccounts, glAccountTags } from '../db/schema/accounting.js';
import { computeDefaultTagsFor } from './defaultGlAccountTags.js';

/**
 * Insert default tags for a single GL account. Idempotent via
 * onConflictDoNothing — re-running for the same account is a no-op.
 *
 * @param {object} tx - Drizzle transaction (or db) instance.
 * @param {string} glAccountId - UUID of the gl_accounts row.
 * @param {object} accountData - { code, name, accountType, accountSubtype }
 *                               passed to computeDefaultTagsFor().
 * @returns {Promise<number>} number of tag rows that the call
 *                            attempted to insert (some may have been
 *                            no-ops if they already existed).
 */
export async function applyDefaultTagsForAccount(tx, glAccountId, accountData) {
  const tags = computeDefaultTagsFor(accountData);
  if (tags.length === 0) return 0;

  const rows = tags.map((t) => ({
    glAccountId,
    namespace: t.namespace,
    value: t.value,
    notes: t.notes || null,
  }));

  await tx
    .insert(glAccountTags)
    .values(rows)
    .onConflictDoNothing();

  return rows.length;
}

/**
 * Back-fill default tags for every gl_accounts row in an org.
 * Used after the AppFolio import to retroactively tag the rows it
 * inserted. Safe to re-run.
 *
 * @param {object} db - Drizzle db instance.
 * @param {string} organizationId - UUID of the target org.
 * @returns {Promise<object>} { processed, total_tags_inserted_attempts,
 *                              accounts_with_tags, accounts_without_tags }
 */
export async function backfillDefaultTagsForOrg(db, organizationId) {
  if (!organizationId) {
    throw new Error('backfillDefaultTagsForOrg: organizationId is required');
  }

  return await db.transaction(async (tx) => {
    const accounts = await tx
      .select({
        id: glAccounts.id,
        code: glAccounts.code,
        name: glAccounts.name,
        accountType: glAccounts.accountType,
        accountSubtype: glAccounts.accountSubtype,
      })
      .from(glAccounts)
      .where(eq(glAccounts.organizationId, organizationId));

    let totalAttempted = 0;
    let accountsWithTags = 0;
    let accountsWithoutTags = 0;

    for (const acct of accounts) {
      const attempted = await applyDefaultTagsForAccount(tx, acct.id, {
        code: acct.code,
        name: acct.name,
        accountType: acct.accountType,
        accountSubtype: acct.accountSubtype,
      });
      totalAttempted += attempted;
      if (attempted > 0) accountsWithTags += 1;
      else accountsWithoutTags += 1;
    }

    return {
      processed: accounts.length,
      total_tags_inserted_attempts: totalAttempted,
      accounts_with_tags: accountsWithTags,
      accounts_without_tags: accountsWithoutTags,
    };
  });
}
