// Service function: seed the default chart of accounts for an
// organization.
//
// Idempotent: re-running for the same org never inserts duplicates.
// Codes already present (regardless of who created them) are left
// alone and reported in the `skipped` list of the return value.
//
// Parent-child resolution is handled inside the same transaction:
// roots go in first, then children whose parentCode resolves to the
// row just inserted (or to a pre-existing row).
//
// Transactional: all-or-nothing. If any insert fails (e.g. the
// org doesn't exist, or a CHECK constraint trips), the whole call
// rolls back.

import { eq } from 'drizzle-orm';
import { glAccounts } from '../db/schema/accounting.js';
import { DEFAULT_CHART_OF_ACCOUNTS } from './defaultChartOfAccounts.js';
import { applyDefaultTagsForAccount } from './applyDefaultGlAccountTags.js';

/**
 * Seed the default chart of accounts for the given organization.
 *
 * @param {object} db - Drizzle db instance (from getDb()).
 * @param {string} organizationId - UUID of the target organization.
 * @returns {Promise<{
 *   created: Array<{ code: string, id: string, name: string }>,
 *   skipped: Array<{ code: string, reason: string }>,
 * }>}
 */
export async function seedDefaultChartOfAccounts(db, organizationId) {
  if (!organizationId) {
    throw new Error('seedDefaultChartOfAccounts: organizationId is required');
  }

  return await db.transaction(async (tx) => {
    // Snapshot existing accounts so we can resolve parentCode → id
    // for codes that already exist (the seed is idempotent and
    // expects to play nicely with prior partial seeds or manual
    // additions).
    const existing = await tx
      .select({
        id: glAccounts.id,
        code: glAccounts.code,
        name: glAccounts.name,
      })
      .from(glAccounts)
      .where(eq(glAccounts.organizationId, organizationId));

    const codeToId = new Map(existing.map((row) => [row.code, row.id]));
    const created = [];
    const skipped = [];

    // Process roots first, then children. Two-pass keeps the
    // dependency resolution simple and the SQL deterministic.
    const roots = DEFAULT_CHART_OF_ACCOUNTS.filter((a) => !a.parentCode);
    const children = DEFAULT_CHART_OF_ACCOUNTS.filter((a) => a.parentCode);

    for (const account of [...roots, ...children]) {
      if (codeToId.has(account.code)) {
        skipped.push({
          code: account.code,
          reason: 'already exists',
        });
        continue;
      }

      let parentId = null;
      if (account.parentCode) {
        parentId = codeToId.get(account.parentCode);
        if (!parentId) {
          skipped.push({
            code: account.code,
            reason: `parent ${account.parentCode} not present`,
          });
          continue;
        }
      }

      const [inserted] = await tx
        .insert(glAccounts)
        .values({
          organizationId,
          code: account.code,
          name: account.name,
          accountType: account.accountType,
          accountSubtype: account.accountSubtype || null,
          normalBalance: account.normalBalance,
          parentId,
          isActive: account.isActive !== undefined ? account.isActive : true,
          isSystem: !!account.isSystem,
          // is_bank stays false at seed time. The Stage 3 trigger
          // flips it true when a bank_account links here.
          isBank: false,
          currency: 'USD',
          notes: account.notes || null,
        })
        .returning({
          id: glAccounts.id,
          code: glAccounts.code,
          name: glAccounts.name,
        });

      codeToId.set(inserted.code, inserted.id);
      created.push(inserted);

      // Apply default classification tags (cost_class, tax_treatment,
      // functional, etc.) for this account, computed from
      // lib/accounting/defaultGlAccountTags.js rules. Idempotent
      // (onConflictDoNothing inside) so seed re-runs are safe.
      await applyDefaultTagsForAccount(tx, inserted.id, {
        code: account.code,
        name: account.name,
        accountType: account.accountType,
        accountSubtype: account.accountSubtype || null,
      });
    }

    return { created, skipped };
  });
}
