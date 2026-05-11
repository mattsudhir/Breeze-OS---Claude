// Service function: import a Breeze customer's AppFolio chart of
// accounts into Breeze OS, applying the cutover rules from
// docs/accounting/appfolio-coa-analysis.md (declared in
// lib/accounting/appfolioImportRules.js).
//
// Use case: an org migrating from AppFolio to Breeze OS. Run this
// AFTER the org row exists in Breeze OS but BEFORE any journal
// entries get posted — the resulting gl_accounts table preserves
// AppFolio's codes (so the customer's muscle memory is intact)
// while fixing the bank/GL conflation, the credit-card misuse,
// and the misclassified Tenant Credit / contra-income accounts.
//
// Idempotent: codes that already exist for the org are skipped.
// Re-running is safe. Dry-run mode (`{ dryRun: true }`) returns
// the would-be plan without writing.

import { eq } from 'drizzle-orm';
import { glAccounts } from '../db/schema/accounting.js';
import { auditEvents } from '../db/schema/infrastructure.js';
import { executeTool } from '../backends/appfolio.js';
import {
  APPFOLIO_DROP_CODES,
  APPFOLIO_BANK_ACCOUNT_CODES,
  APPFOLIO_CREDIT_CARD_CODES,
  APPFOLIO_REMAP_RULES,
  assertRulesDisjoint,
  mapAppfolioType,
  defaultNormalBalance,
  parseSubAccountOfCode,
} from './appfolioImportRules.js';

// ── Plan-item builders ───────────────────────────────────────────

// Build a per-account plan item. Pure function — takes an AppFolio
// account row, returns an object describing what to do with it.
//
// Plan item shape:
//   { action, code, ... }
//
// action ∈ {
//   'drop',               -- skip; in DROP_CODES
//   'parked_bank',        -- import as inactive Cash GL (Stage 3 will
//                            create the real bank_account row)
//   'parked_credit_card', -- import as inactive Liability GL (Stage 3)
//   'remap',              -- import with classification overrides
//   'import',             -- import as-is with default mapping
// }
function buildPlanItem(appfolioAccount) {
  const code = String(appfolioAccount.number || '').trim();
  const name = appfolioAccount.account_name || '(unnamed)';
  const appfolioType = appfolioAccount.account_type;
  const subAccountOfCode = parseSubAccountOfCode(appfolioAccount.sub_accountof);
  const fundAccount = appfolioAccount.fund_account || null;
  const hidden = !!appfolioAccount.hidden;

  // 1. Drop list.
  if (APPFOLIO_DROP_CODES.has(code)) {
    return {
      action: 'drop',
      code,
      name,
      reason: 'in APPFOLIO_DROP_CODES (legacy / junk / deprecated)',
      original: appfolioAccount,
    };
  }

  // 2. Bank-account parking.
  if (APPFOLIO_BANK_ACCOUNT_CODES.has(code)) {
    return {
      action: 'parked_bank',
      code,
      name,
      accountType: 'asset',
      accountSubtype: 'cash',
      normalBalance: 'debit',
      parentCode: subAccountOfCode,
      isActive: false,
      notes:
        'Imported as inactive placeholder. Stage 3 bank-account import ' +
        'creates the canonical bank_account row pointed at GL 1100 Cash; ' +
        'historical entries against this code remain queryable.',
      original: appfolioAccount,
    };
  }

  // 3. Credit-card parking.
  if (APPFOLIO_CREDIT_CARD_CODES.has(code)) {
    return {
      action: 'parked_credit_card',
      code,
      name,
      accountType: 'liability',
      accountSubtype: 'credit_card_payable',
      normalBalance: 'credit',
      parentCode: subAccountOfCode,
      isActive: false,
      notes:
        'Imported as inactive placeholder. Stage 3 bank-account import ' +
        'creates the canonical bank_account row with ' +
        "account_type='credit_card' pointed at GL 2410 Credit Card - " +
        'Operating; historical entries against this code remain queryable.',
      original: appfolioAccount,
    };
  }

  // 4. Default mapping from AppFolio type → Breeze OS type.
  const typed = mapAppfolioType(appfolioType);
  const defaultBalance = defaultNormalBalance(typed.accountType);

  // 5. Per-code remap overrides.
  const remap = APPFOLIO_REMAP_RULES[code];
  if (remap) {
    return {
      action: 'remap',
      code,
      name: remap.name || name,
      accountType: remap.accountType || typed.accountType,
      accountSubtype:
        remap.accountSubtype !== undefined
          ? remap.accountSubtype
          : typed.accountSubtype,
      normalBalance: remap.normalBalance || defaultBalance,
      parentCode: subAccountOfCode,
      isActive: !hidden,
      notes:
        (remap.notes ? `[remap] ${remap.notes} ` : '') +
        `[imported from AppFolio: ${appfolioType}` +
        (fundAccount ? ` / ${fundAccount}` : '') +
        ']',
      original: appfolioAccount,
    };
  }

  // 6. Default import.
  return {
    action: 'import',
    code,
    name,
    accountType: typed.accountType,
    accountSubtype: typed.accountSubtype,
    normalBalance: defaultBalance,
    parentCode: subAccountOfCode,
    isActive: !hidden,
    notes:
      `[imported from AppFolio: ${appfolioType}` +
      (fundAccount ? ` / ${fundAccount}` : '') +
      ']',
    original: appfolioAccount,
  };
}

// Build the full ordered insert list from a flat plan. Two-pass:
// roots first, then children. Cascades parent-drop: if a child's
// parent is in the drop list (or its parent isn't in the plan), the
// child is moved to errors with a clear reason.
function reorderForInsert(plan) {
  const planByCode = new Map(plan.map((p) => [p.code, p]));
  const willInsert = (p) =>
    p.action === 'import' ||
    p.action === 'remap' ||
    p.action === 'parked_bank' ||
    p.action === 'parked_credit_card';
  const insertable = plan.filter(willInsert);
  const roots = insertable.filter((p) => !p.parentCode);
  const children = insertable.filter((p) => p.parentCode);
  return { roots, children, planByCode };
}

// ── Main entry ───────────────────────────────────────────────────

/**
 * Import an organization's AppFolio chart of accounts into Breeze OS.
 *
 * @param {object} db - Drizzle db instance.
 * @param {string} organizationId - UUID of the target org.
 * @param {object} options
 * @param {boolean} [options.dryRun=false] - If true, return the plan
 *                                            without writing.
 * @returns {Promise<object>} Report with summary + per-action lists.
 */
export async function importAppfolioCoa(db, organizationId, options = {}) {
  if (!organizationId) {
    throw new Error('importAppfolioCoa: organizationId is required');
  }
  const { dryRun = false } = options;

  // Verify the rules file is well-formed before doing any work.
  assertRulesDisjoint();

  // 1. Pull live AppFolio chart.
  const fetched = await executeTool('list_gl_accounts', {});
  if (fetched.error) {
    throw new Error(`AppFolio fetch failed: ${fetched.error}`);
  }
  const appfolioAccounts = fetched.accounts || fetched.data || [];

  // 2. Build the plan (pure).
  const plan = appfolioAccounts.map(buildPlanItem);
  const { roots, children, planByCode } = reorderForInsert(plan);

  // Categorize for summary regardless of dryRun.
  const dropped = plan.filter((p) => p.action === 'drop');
  const parkedBank = plan.filter((p) => p.action === 'parked_bank');
  const parkedCreditCard = plan.filter((p) => p.action === 'parked_credit_card');
  const remapped = plan.filter((p) => p.action === 'remap');
  const standard = plan.filter((p) => p.action === 'import');

  const baseReport = {
    fetched_from_appfolio: appfolioAccounts.length,
    plan_summary: {
      drop: dropped.length,
      parked_bank: parkedBank.length,
      parked_credit_card: parkedCreditCard.length,
      remap: remapped.length,
      import: standard.length,
      total_to_insert: roots.length + children.length,
    },
    dropped: dropped.map((p) => ({
      code: p.code,
      name: p.name,
      reason: p.reason,
    })),
    parked_bank: parkedBank.map((p) => ({ code: p.code, name: p.name })),
    parked_credit_card: parkedCreditCard.map((p) => ({
      code: p.code,
      name: p.name,
    })),
    remapped: remapped.map((p) => ({
      code: p.code,
      name: p.name,
      account_type: p.accountType,
      account_subtype: p.accountSubtype,
      normal_balance: p.normalBalance,
      notes: p.notes,
    })),
  };

  if (dryRun) {
    return {
      ok: true,
      dry_run: true,
      ...baseReport,
      inserted: [],
      skipped: [],
      errors: [],
    };
  }

  // 3. Insert in a transaction.
  const inserted = [];
  const skipped = [];
  const errors = [];

  await db.transaction(async (tx) => {
    // Snapshot existing codes to handle re-runs and cross-references.
    const existing = await tx
      .select({ id: glAccounts.id, code: glAccounts.code })
      .from(glAccounts)
      .where(eq(glAccounts.organizationId, organizationId));
    const codeToId = new Map(existing.map((r) => [r.code, r.id]));

    // Pass 1: roots. Pass 2: children (resolves parent_id from
    // either pre-existing rows or rows we just inserted).
    for (const item of [...roots, ...children]) {
      // Already exists?
      if (codeToId.has(item.code)) {
        skipped.push({
          code: item.code,
          name: item.name,
          reason: 'code already exists',
        });
        continue;
      }

      let parentId = null;
      if (item.parentCode) {
        // If parent was dropped, surface as an error so the operator
        // notices (the child needs a different parent or a manual
        // re-parent).
        if (APPFOLIO_DROP_CODES.has(item.parentCode)) {
          errors.push({
            code: item.code,
            name: item.name,
            reason: `parent ${item.parentCode} is in DROP list; orphaning the child`,
          });
          continue;
        }
        parentId = codeToId.get(item.parentCode);
        if (!parentId) {
          // Parent missing entirely — could be a typo in AppFolio or
          // a parent that's not in this fetch. Skip with error.
          errors.push({
            code: item.code,
            name: item.name,
            reason: `parent ${item.parentCode} not found`,
          });
          continue;
        }
      }

      const [row] = await tx
        .insert(glAccounts)
        .values({
          organizationId,
          code: item.code,
          name: item.name,
          accountType: item.accountType,
          accountSubtype: item.accountSubtype || null,
          normalBalance: item.normalBalance,
          parentId,
          isActive: item.isActive !== undefined ? item.isActive : true,
          isSystem: false,
          isBank: false,
          currency: 'USD',
          notes: item.notes || null,
        })
        .returning({
          id: glAccounts.id,
          code: glAccounts.code,
          name: glAccounts.name,
        });

      codeToId.set(row.code, row.id);
      inserted.push({ ...row, action: item.action });

      await tx.insert(auditEvents).values({
        organizationId,
        actorType: 'system',
        actorId: 'appfolio-coa-importer',
        subjectTable: 'gl_accounts',
        subjectId: row.id,
        eventType: `coa_${item.action}`, // coa_import / coa_remap / coa_parked_bank / coa_parked_credit_card
        beforeState: item.original,
        afterState: {
          code: item.code,
          name: item.name,
          account_type: item.accountType,
          account_subtype: item.accountSubtype,
          normal_balance: item.normalBalance,
          parent_code: item.parentCode || null,
          is_active: item.isActive !== undefined ? item.isActive : true,
          notes: item.notes,
        },
      });
    }
  });

  return {
    ok: true,
    dry_run: false,
    ...baseReport,
    inserted_count: inserted.length,
    skipped_count: skipped.length,
    error_count: errors.length,
    inserted,
    skipped,
    errors,
  };
}
