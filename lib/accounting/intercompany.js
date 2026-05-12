// Intercompany transactions.
//
// In a multi-entity org, money frequently flows between entities:
//   - Operating LLC charges a property LLC a management fee.
//   - Property LLC pays a bill that should land on the operating
//     LLC's books (or vice versa).
//   - Owner takes a distribution that crosses entities.
//
// Every such transaction touches FOUR GL lines in one balanced
// journal_entry: the lender's revenue/expense + IC Receivable on
// one side, and the borrower's expense/revenue + IC Payable on the
// other.
//
// Example: Operating LLC (entity A) bills Property LLC (entity B)
// a $1,000 management fee.
//
//   Line 1: 1450 Intercompany Receivable    DR 1000   entity=A, counterparty=B
//   Line 2: 4xxx Management Fee Income      CR 1000   entity=A
//   Line 3: 6xxx Management Fee Expense     DR 1000   entity=B
//   Line 4: 2050 Intercompany Payable       CR 1000   entity=B, counterparty=A
//
// Sum DR = sum CR = 2000. Per-entity P&L for A shows +1000 revenue;
// for B shows -1000 expense. On consolidation, lines 1+4 net to
// zero (matching IC AR/AP pair), lines 2+3 are intercompany —
// either eliminated or kept depending on the report. By default,
// the consolidated P&L includes only lines whose
// counterparty_entity_id is NULL.

import { eq } from 'drizzle-orm';
import { entities } from '../db/schema/core.js';
import { lookupGlAccountByCode, postJournalEntry } from './posting.js';

const IC_RECEIVABLE_CODE = '1450';
const IC_PAYABLE_CODE = '2050';

/**
 * Post a 4-line intercompany journal entry.
 *
 * @param {object} tx                Drizzle transaction
 * @param {string} organizationId
 * @param {object} params
 * @param {string} params.fromEntityId      lender / billing entity
 * @param {string} params.toEntityId        borrower / billed entity
 * @param {number} params.amountCents       positive integer
 * @param {string} params.fromAccountCode   revenue (or contra) GL on lender side
 * @param {string} params.toAccountCode     expense (or contra) GL on borrower side
 * @param {string} params.entryDate         YYYY-MM-DD
 * @param {string} [params.memo]
 * @param {string} [params.postedByUserId]
 * @returns {Promise<{
 *   journalEntryId: string,
 *   entryNumber: number,
 *   lineIds: string[],
 * }>}
 */
export async function postIntercompanyEntry(tx, organizationId, params) {
  const {
    fromEntityId,
    toEntityId,
    amountCents,
    fromAccountCode,
    toAccountCode,
    entryDate,
    memo = null,
    postedByUserId = null,
  } = params;

  if (!fromEntityId || !toEntityId) {
    throw new Error('postIntercompanyEntry: fromEntityId and toEntityId required');
  }
  if (fromEntityId === toEntityId) {
    throw new Error('postIntercompanyEntry: from and to entity must differ');
  }
  if (!Number.isInteger(amountCents) || amountCents <= 0) {
    throw new Error('postIntercompanyEntry: amountCents must be a positive integer');
  }
  if (!fromAccountCode || !toAccountCode) {
    throw new Error('postIntercompanyEntry: both account codes required');
  }

  // Verify both entities belong to the org. Fail loud rather than
  // post a JE that references a stranger entity.
  const orgEntities = await tx
    .select({ id: entities.id })
    .from(entities)
    .where(eq(entities.organizationId, organizationId));
  const orgEntityIds = new Set(orgEntities.map((e) => e.id));
  if (!orgEntityIds.has(fromEntityId)) {
    throw new Error(`postIntercompanyEntry: fromEntityId ${fromEntityId} not in org`);
  }
  if (!orgEntityIds.has(toEntityId)) {
    throw new Error(`postIntercompanyEntry: toEntityId ${toEntityId} not in org`);
  }

  const icReceivableId = await lookupGlAccountByCode(tx, organizationId, IC_RECEIVABLE_CODE);
  const icPayableId = await lookupGlAccountByCode(tx, organizationId, IC_PAYABLE_CODE);
  const fromAccountId = await lookupGlAccountByCode(tx, organizationId, fromAccountCode);
  const toAccountId = await lookupGlAccountByCode(tx, organizationId, toAccountCode);

  return postJournalEntry(tx, organizationId, {
    entryDate,
    entryType: 'transfer',
    memo,
    postedByUserId,
    lines: [
      // Lender side
      {
        glAccountId: icReceivableId,
        debitCents: amountCents,
        creditCents: 0,
        entityId: fromEntityId,
        counterpartyEntityId: toEntityId,
        memo,
      },
      {
        glAccountId: fromAccountId,
        debitCents: 0,
        creditCents: amountCents,
        entityId: fromEntityId,
        memo,
      },
      // Borrower side
      {
        glAccountId: toAccountId,
        debitCents: amountCents,
        creditCents: 0,
        entityId: toEntityId,
        memo,
      },
      {
        glAccountId: icPayableId,
        debitCents: 0,
        creditCents: amountCents,
        entityId: toEntityId,
        counterpartyEntityId: fromEntityId,
        memo,
      },
    ],
  });
}
