// Bank-account linking service.
//
// Two flavors:
//
//   linkBankAccount(tx, organizationId, params)
//     - Create a single bank_account row pointing at an existing
//       gl_account. The trigger from migration 0008 sets
//       gl_accounts.is_bank=true automatically. If the GL needs
//       reclassification (e.g. a parked credit-card GL that
//       AppFolio left as account_type=asset/cash but should be
//       account_type=liability/credit_card_payable), the caller
//       passes reclassify=true.
//
//   bulkConvertParkedAccounts(tx, organizationId, options)
//     - Find every gl_account flagged as "parked" by the AppFolio
//       importer (notes contain the parked marker) and create a
//       bank_account row for each, in one transaction. Optional
//       dryRun mode returns the plan without writing.
//
// Both helpers expect an open Drizzle transaction so the caller
// can compose them with other operations.

import { and, eq, sql } from 'drizzle-orm';
import {
  glAccounts,
  bankAccounts,
} from '../db/schema/accounting.js';
import { auditEvents } from '../db/schema/infrastructure.js';

// ── Helpers ──────────────────────────────────────────────────────

function inferAccountType(glAccount) {
  // The AppFolio importer encoded the eventual bank_account type
  // in the notes string. Look for the marker; fall back by
  // account_subtype.
  const notes = glAccount.notes || '';
  if (notes.includes("account_type='credit_card'")) return 'credit_card';
  if (glAccount.accountSubtype === 'credit_card_payable') return 'credit_card';
  if (glAccount.accountSubtype === 'cash') return 'checking';
  // Default — could be refined in the UI per row.
  return 'checking';
}

function inferBankAccountFromGl(glAccount) {
  // Strip parenthetical bank hints from the name for display.
  // "Operating Cash (Breeze - PNC)" → display_name "Operating Cash",
  // institution_name "Breeze - PNC". If no parenthetical, the full
  // name becomes display_name and institution_name stays null.
  const match = /^(.+?)\s*\(([^)]+)\)\s*$/.exec(glAccount.name);
  let displayName = glAccount.name;
  let institutionName = null;
  if (match) {
    displayName = match[1].trim();
    institutionName = match[2].trim();
  }
  return { displayName, institutionName };
}

// ── linkBankAccount ──────────────────────────────────────────────

/**
 * Create a bank_account row linked 1:1 to an existing gl_account.
 *
 * @param {object} tx
 * @param {string} organizationId
 * @param {object} params
 * @param {string} params.glAccountId           required
 * @param {string} [params.displayName]         falls back to gl_account.name
 * @param {string} [params.institutionName]
 * @param {string} [params.accountType]         bank_account_type enum;
 *                                              defaults inferred from GL
 * @param {string} [params.accountLast4]
 * @param {boolean} [params.reclassifyGl]       if true and the linked GL
 *                                              is currently classified
 *                                              as cash, leave it; if
 *                                              the target accountType is
 *                                              'credit_card', reclassify
 *                                              the GL to liability.
 * @param {boolean} [params.activate]           if true, also set the GL's
 *                                              is_active=true (default
 *                                              true — parked GLs were
 *                                              imported inactive).
 * @returns {Promise<{ bankAccountId: string, glAccountId: string }>}
 */
export async function linkBankAccount(tx, organizationId, params) {
  const { glAccountId, reclassifyGl = false, activate = true } = params;
  if (!glAccountId) throw new Error('linkBankAccount: glAccountId required');

  // Fetch the GL we're attaching to.
  const [gl] = await tx
    .select()
    .from(glAccounts)
    .where(
      and(
        eq(glAccounts.id, glAccountId),
        eq(glAccounts.organizationId, organizationId),
      ),
    )
    .limit(1);
  if (!gl) throw new Error(`linkBankAccount: gl_account ${glAccountId} not found for org`);

  // Don't double-link.
  const [existing] = await tx
    .select({ id: bankAccounts.id })
    .from(bankAccounts)
    .where(eq(bankAccounts.glAccountId, glAccountId))
    .limit(1);
  if (existing) {
    throw new Error(
      `linkBankAccount: gl_account ${glAccountId} is already linked to bank_account ${existing.id}`,
    );
  }

  const inferred = inferBankAccountFromGl(gl);
  const accountType = params.accountType || inferAccountType(gl);

  // Optional GL reclassification for credit cards. The AppFolio
  // import left these as account_type=asset / cash; correct shape
  // is liability / credit_card_payable.
  if (reclassifyGl && accountType === 'credit_card') {
    await tx
      .update(glAccounts)
      .set({
        accountType: 'liability',
        accountSubtype: 'credit_card_payable',
        normalBalance: 'credit',
        updatedAt: new Date(),
      })
      .where(eq(glAccounts.id, glAccountId));
  }

  // Re-activate the GL (parked GLs were imported inactive).
  if (activate && !gl.isActive) {
    await tx
      .update(glAccounts)
      .set({ isActive: true, updatedAt: new Date() })
      .where(eq(glAccounts.id, glAccountId));
  }

  // Insert the bank_account row. The is_bank trigger from 0008
  // will set gl_accounts.is_bank=true automatically.
  const [created] = await tx
    .insert(bankAccounts)
    .values({
      organizationId,
      glAccountId,
      displayName: params.displayName || inferred.displayName,
      institutionName: params.institutionName || inferred.institutionName,
      accountType,
      accountLast4: params.accountLast4 || null,
      plaidStatus: 'unlinked',
      notes: `Created via linkBankAccount${reclassifyGl ? ' (with GL reclassification)' : ''}`,
    })
    .returning({ id: bankAccounts.id });

  await tx.insert(auditEvents).values({
    organizationId,
    actorType: 'system',
    actorId: 'link-bank-account',
    subjectTable: 'bank_accounts',
    subjectId: created.id,
    eventType: 'bank_account_linked',
    beforeState: { gl_account: gl },
    afterState: {
      bank_account_id: created.id,
      gl_account_id: glAccountId,
      account_type: accountType,
      display_name: params.displayName || inferred.displayName,
      reclassified_gl: !!(reclassifyGl && accountType === 'credit_card'),
    },
  });

  return { bankAccountId: created.id, glAccountId };
}

// ── bulkConvertParkedAccounts ────────────────────────────────────

/**
 * Find every parked GL from the AppFolio import and create a
 * bank_account row for each. The importer marks parked GLs by
 * (a) is_active=false and (b) a notes string containing the
 * literal substring "imported from AppFolio".
 *
 * Plus we check the action in the audit_events row to distinguish
 * parked_bank vs parked_credit_card.
 *
 * @param {object} tx
 * @param {string} organizationId
 * @param {object} [options]
 * @param {boolean} [options.dryRun=false]
 * @returns {Promise<{
 *   processed: number,
 *   created: object[],
 *   skipped: object[],
 *   errors: object[],
 * }>}
 */
export async function bulkConvertParkedAccounts(tx, organizationId, options = {}) {
  const { dryRun = false } = options;

  // Find parked GLs via the audit_events trail rather than fuzzy
  // notes-matching — the importer wrote a row per parked GL with
  // event_type = 'coa_parked_bank' or 'coa_parked_credit_card'.
  const parkedAuditRows = await tx
    .select({
      subjectId: auditEvents.subjectId,
      eventType: auditEvents.eventType,
    })
    .from(auditEvents)
    .where(
      and(
        eq(auditEvents.organizationId, organizationId),
        eq(auditEvents.subjectTable, 'gl_accounts'),
        sql`${auditEvents.eventType} IN ('coa_parked_bank', 'coa_parked_credit_card')`,
      ),
    );

  const parkedGlIds = new Set(parkedAuditRows.map((r) => r.subjectId));
  const eventTypeByGl = new Map(parkedAuditRows.map((r) => [r.subjectId, r.eventType]));

  if (parkedGlIds.size === 0) {
    return { processed: 0, created: [], skipped: [], errors: [] };
  }

  // Pull the GL details + check which are already linked.
  const parkedGls = await tx
    .select()
    .from(glAccounts)
    .where(
      and(
        eq(glAccounts.organizationId, organizationId),
        sql`${glAccounts.id} IN ${Array.from(parkedGlIds)}`,
      ),
    );

  const alreadyLinked = await tx
    .select({ glAccountId: bankAccounts.glAccountId })
    .from(bankAccounts)
    .where(
      and(
        eq(bankAccounts.organizationId, organizationId),
        sql`${bankAccounts.glAccountId} IN ${Array.from(parkedGlIds)}`,
      ),
    );
  const linkedGlIds = new Set(alreadyLinked.map((r) => r.glAccountId));

  const created = [];
  const skipped = [];
  const errors = [];

  for (const gl of parkedGls) {
    if (linkedGlIds.has(gl.id)) {
      skipped.push({
        gl_account_id: gl.id,
        code: gl.code,
        name: gl.name,
        reason: 'already linked',
      });
      continue;
    }
    const eventType = eventTypeByGl.get(gl.id);
    const accountType =
      eventType === 'coa_parked_credit_card' ? 'credit_card' : 'checking';
    const inferred = inferBankAccountFromGl(gl);

    if (dryRun) {
      created.push({
        gl_account_id: gl.id,
        code: gl.code,
        name: gl.name,
        would_create_bank_account: {
          display_name: inferred.displayName,
          institution_name: inferred.institutionName,
          account_type: accountType,
          reclassify_gl: accountType === 'credit_card',
        },
      });
      continue;
    }

    try {
      const { bankAccountId } = await linkBankAccount(tx, organizationId, {
        glAccountId: gl.id,
        accountType,
        reclassifyGl: accountType === 'credit_card',
        activate: true,
      });
      created.push({
        gl_account_id: gl.id,
        bank_account_id: bankAccountId,
        code: gl.code,
        name: gl.name,
        account_type: accountType,
      });
    } catch (err) {
      errors.push({
        gl_account_id: gl.id,
        code: gl.code,
        name: gl.name,
        error: err.message || String(err),
      });
    }
  }

  return {
    processed: parkedGls.length,
    created,
    skipped,
    errors,
  };
}
