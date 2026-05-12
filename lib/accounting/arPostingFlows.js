// AR posting workflows.
//
// Three exports — each one wraps postJournalEntry() with the
// domain-specific bookkeeping that AR cares about. Every function
// expects an open Drizzle transaction (`tx`) so multiple calls can
// compose atomically (e.g. record a receipt + allocate against
// open charges in one shot).
//
//   postScheduledCharge(tx, orgId, scheduledChargeId, opts)
//     - Read a due scheduled_charge, post a JE that debits AR and
//       credits the configured income GL, insert a posted_charges
//       row, advance scheduled_charges.next_due_date by frequency.
//
//   recordReceipt(tx, orgId, params)
//     - Insert a receipt row, post a JE that debits Undeposited
//       Funds and credits whatever the receipt allocates to (AR
//       per posted_charge, or Tenant Credit / Prepaid Rent for
//       unallocated remainder). Optionally takes a per-charge
//       allocation list which becomes receipt_allocations rows
//       and decrements posted_charges.balance_cents.
//
//   buildDeposit(tx, orgId, params)
//     - Bundle a list of receipts into a deposit. Insert deposits +
//       deposit_items rows, set receipts.deposit_id, post a JE that
//       debits Cash (the bank GL) and credits Undeposited Funds.

import { and, eq, inArray, sql } from 'drizzle-orm';
import {
  scheduledCharges,
  postedCharges,
  receipts,
  receiptAllocations,
  deposits,
  depositItems,
} from '../db/schema/accounting.js';
import { postJournalEntry } from './posting.js';

// ── Helpers ──────────────────────────────────────────────────────

function advanceDueDate(currentDateIso, frequency) {
  const d = new Date(currentDateIso + 'T00:00:00Z');
  switch (frequency) {
    case 'monthly': {
      const next = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate()));
      return next.toISOString().slice(0, 10);
    }
    case 'quarterly': {
      const next = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 3, d.getUTCDate()));
      return next.toISOString().slice(0, 10);
    }
    case 'annual': {
      const next = new Date(Date.UTC(d.getUTCFullYear() + 1, d.getUTCMonth(), d.getUTCDate()));
      return next.toISOString().slice(0, 10);
    }
    case 'one_time':
      return null; // signals end of recurrence
    default:
      throw new Error(`advanceDueDate: unknown frequency ${frequency}`);
  }
}

// ── postScheduledCharge ──────────────────────────────────────────

/**
 * Tick a scheduled_charge: post one posted_charge + JE, advance
 * the next_due_date by frequency. Idempotent at the "this exact
 * scheduled_charge has already posted for this due_date" level via
 * the (scheduled_charge_id, due_date) check at the start.
 *
 * @param {object} tx
 * @param {string} organizationId
 * @param {string} scheduledChargeId
 * @param {object} opts
 * @param {string} opts.arGlAccountId           gl_account.id to debit
 * @param {string} opts.tenantId               tenant uuid (from the lease)
 * @returns {Promise<{
 *   postedChargeId: string,
 *   journalEntryId: string,
 *   entryNumber: number,
 *   advancedDueDate: string|null,
 * }>}
 */
export async function postScheduledCharge(
  tx,
  organizationId,
  scheduledChargeId,
  opts = {},
) {
  const { arGlAccountId, tenantId = null } = opts;
  if (!arGlAccountId) throw new Error('postScheduledCharge: arGlAccountId required');

  const [sc] = await tx
    .select()
    .from(scheduledCharges)
    .where(
      and(
        eq(scheduledCharges.id, scheduledChargeId),
        eq(scheduledCharges.organizationId, organizationId),
      ),
    )
    .limit(1);

  if (!sc) throw new Error(`scheduled_charge not found: ${scheduledChargeId}`);
  if (sc.status !== 'active') {
    throw new Error(`scheduled_charge ${scheduledChargeId} status=${sc.status}, not active`);
  }

  // Idempotency: if a posted_charge already exists for this
  // scheduled_charge_id with the same charge_date, skip.
  const dup = await tx
    .select({ id: postedCharges.id })
    .from(postedCharges)
    .where(
      and(
        eq(postedCharges.scheduledChargeId, scheduledChargeId),
        eq(postedCharges.chargeDate, sc.nextDueDate),
      ),
    )
    .limit(1);
  if (dup.length > 0) {
    throw new Error(
      `scheduled_charge ${scheduledChargeId} already posted for charge_date ${sc.nextDueDate}`,
    );
  }

  // Post the JE: Dr AR, Cr Income.
  const { journalEntryId, entryNumber } = await postJournalEntry(
    tx,
    organizationId,
    {
      entryDate: sc.nextDueDate,
      entryType: 'recurring_charge_posting',
      memo: sc.description,
      sourceTable: 'scheduled_charges',
      sourceId: scheduledChargeId,
      lines: [
        {
          glAccountId: arGlAccountId,
          debitCents: sc.amountCents,
          creditCents: 0,
          memo: sc.description,
          unitId: sc.unitId,
          propertyId: sc.propertyId,
          leaseId: sc.leaseId,
          tenantId,
        },
        {
          glAccountId: sc.glAccountId,
          debitCents: 0,
          creditCents: sc.amountCents,
          memo: sc.description,
          unitId: sc.unitId,
          propertyId: sc.propertyId,
          leaseId: sc.leaseId,
          tenantId,
        },
      ],
    },
  );

  // Insert posted_charge.
  const [pc] = await tx
    .insert(postedCharges)
    .values({
      organizationId,
      scheduledChargeId,
      leaseId: sc.leaseId,
      unitId: sc.unitId,
      propertyId: sc.propertyId,
      tenantId,
      chargeType: sc.chargeType,
      description: sc.description,
      chargeDate: sc.nextDueDate,
      dueDate: sc.nextDueDate,
      amountCents: sc.amountCents,
      balanceCents: sc.amountCents,
      glAccountId: sc.glAccountId,
      journalEntryId,
      status: 'open',
    })
    .returning({ id: postedCharges.id });

  // Advance the schedule.
  const advancedDueDate = advanceDueDate(sc.nextDueDate, sc.frequency);
  const newStatus =
    advancedDueDate === null || (sc.endDate && advancedDueDate > sc.endDate)
      ? 'ended'
      : 'active';

  await tx
    .update(scheduledCharges)
    .set({
      nextDueDate: advancedDueDate || sc.nextDueDate,
      status: newStatus,
      updatedAt: new Date(),
    })
    .where(eq(scheduledCharges.id, scheduledChargeId));

  return {
    postedChargeId: pc.id,
    journalEntryId,
    entryNumber,
    advancedDueDate: newStatus === 'ended' ? null : advancedDueDate,
  };
}

// ── recordReceipt ────────────────────────────────────────────────

/**
 * Insert a receipt + JE, optionally allocating against open
 * posted_charges in the same call.
 *
 * The JE shape:
 *   Dr Undeposited Funds                 (total amount)
 *     Cr AR (per allocation, summed)     OR
 *     Cr Tenant Credit (unallocated remainder)
 *
 * @param {object} tx
 * @param {string} organizationId
 * @param {object} params
 * @param {string} params.undepositedFundsGlAccountId
 * @param {string} [params.tenantCreditGlAccountId]   required if
 *                  there will be unallocated remainder.
 * @param {string} [params.tenantId]
 * @param {string} [params.leaseId]
 * @param {string} params.receivedDate                YYYY-MM-DD
 * @param {number} params.amountCents
 * @param {string} params.paymentMethod
 * @param {string} [params.externalReference]
 * @param {Array} [params.allocations]                [{ postedChargeId, glAccountId, amountCents }]
 *
 * `allocations[i].glAccountId` must be the AR gl_account that the
 * matching posted_charge debited at creation time. The caller is
 * responsible for fetching that — usually it's the AR account
 * referenced on posted_charges (1200 family).
 *
 * @returns {Promise<{
 *   receiptId: string,
 *   journalEntryId: string,
 *   entryNumber: number,
 *   unallocatedCents: number,
 * }>}
 */
export async function recordReceipt(tx, organizationId, params) {
  const {
    undepositedFundsGlAccountId,
    tenantCreditGlAccountId = null,
    tenantId = null,
    leaseId = null,
    receivedDate,
    amountCents,
    paymentMethod,
    externalReference = null,
    allocations = [],
  } = params;

  if (!undepositedFundsGlAccountId) throw new Error('recordReceipt: undepositedFundsGlAccountId required');
  if (!receivedDate) throw new Error('recordReceipt: receivedDate required');
  if (!amountCents || amountCents <= 0) throw new Error('recordReceipt: amountCents must be positive');
  if (!paymentMethod) throw new Error('recordReceipt: paymentMethod required');

  const allocSum = allocations.reduce((s, a) => s + (a.amountCents || 0), 0);
  if (allocSum > amountCents) {
    throw new Error(
      `recordReceipt: allocations sum (${allocSum}) > amountCents (${amountCents})`,
    );
  }
  const unallocatedCents = amountCents - allocSum;
  if (unallocatedCents > 0 && !tenantCreditGlAccountId) {
    throw new Error(
      'recordReceipt: tenantCreditGlAccountId required when allocations do not cover full amount',
    );
  }

  // Build the JE lines.
  const lines = [
    {
      glAccountId: undepositedFundsGlAccountId,
      debitCents: amountCents,
      creditCents: 0,
      memo: `Receipt ${paymentMethod}${externalReference ? ' ' + externalReference : ''}`,
      tenantId,
      leaseId,
    },
  ];

  for (const a of allocations) {
    lines.push({
      glAccountId: a.glAccountId,
      debitCents: 0,
      creditCents: a.amountCents,
      memo: 'AR allocation',
      tenantId,
      leaseId,
    });
  }

  if (unallocatedCents > 0) {
    lines.push({
      glAccountId: tenantCreditGlAccountId,
      debitCents: 0,
      creditCents: unallocatedCents,
      memo: 'Unallocated prepayment',
      tenantId,
      leaseId,
    });
  }

  const { journalEntryId, entryNumber } = await postJournalEntry(
    tx,
    organizationId,
    {
      entryDate: receivedDate,
      entryType: 'receipt',
      memo: `Receipt: ${paymentMethod}` + (externalReference ? ` (${externalReference})` : ''),
      sourceTable: 'receipts',
      sourceId: null, // backfilled after insert below — chicken and egg
      lines,
    },
  );

  // Insert receipt row.
  const [r] = await tx
    .insert(receipts)
    .values({
      organizationId,
      tenantId,
      leaseId,
      receivedDate,
      amountCents,
      paymentMethod,
      externalReference,
      journalEntryId,
      status: 'pending',
    })
    .returning({ id: receipts.id });

  // Apply allocations (decrement posted_charges balance).
  for (const a of allocations) {
    await tx.insert(receiptAllocations).values({
      organizationId,
      receiptId: r.id,
      postedChargeId: a.postedChargeId,
      amountCents: a.amountCents,
    });

    // Decrement balance + transition status.
    await tx.execute(sql`
      UPDATE "posted_charges"
         SET "balance_cents" = "balance_cents" - ${a.amountCents},
             "status" = CASE
               WHEN "balance_cents" - ${a.amountCents} <= 0 THEN 'paid'::posted_charge_status
               WHEN "balance_cents" - ${a.amountCents} < "amount_cents" THEN 'partially_paid'::posted_charge_status
               ELSE "status"
             END,
             "updated_at" = now()
       WHERE "id" = ${a.postedChargeId}
    `);
  }

  return {
    receiptId: r.id,
    journalEntryId,
    entryNumber,
    unallocatedCents,
  };
}

// ── buildDeposit ─────────────────────────────────────────────────

/**
 * Bundle a list of receipts into a single deposit hitting one bank
 * account's GL. Posts a JE that debits Cash and credits Undeposited
 * Funds. Sets receipts.deposit_id and creates deposit_items rows.
 *
 * The DB triggers from migration 0007 catch over-allocation,
 * voided/nsf receipts, and cross-org references.
 *
 * @param {object} tx
 * @param {string} organizationId
 * @param {object} params
 * @param {string} params.bankCashGlAccountId         Dr account
 * @param {string} params.undepositedFundsGlAccountId Cr account
 * @param {string} params.depositDate                 YYYY-MM-DD
 * @param {string} params.depositType                 deposit_type enum
 * @param {string[]} params.receiptIds                 ids to bundle
 * @param {string} [params.externalReference]
 * @param {string} [params.bankAccountId]              FK target once
 *                                                     Stage 3 lands; ok null for now.
 *
 * @returns {Promise<{
 *   depositId: string,
 *   journalEntryId: string,
 *   entryNumber: number,
 *   amountCents: number,
 *   itemCount: number,
 * }>}
 */
export async function buildDeposit(tx, organizationId, params) {
  const {
    bankCashGlAccountId,
    undepositedFundsGlAccountId,
    depositDate,
    depositType,
    receiptIds = [],
    externalReference = null,
    bankAccountId = null,
  } = params;

  if (!bankCashGlAccountId) throw new Error('buildDeposit: bankCashGlAccountId required');
  if (!undepositedFundsGlAccountId) throw new Error('buildDeposit: undepositedFundsGlAccountId required');
  if (!depositDate) throw new Error('buildDeposit: depositDate required');
  if (!depositType) throw new Error('buildDeposit: depositType required');
  if (receiptIds.length === 0) throw new Error('buildDeposit: at least one receipt required');

  // Fetch the receipts we're bundling.
  const receiptRows = await tx
    .select({
      id: receipts.id,
      amountCents: receipts.amountCents,
      status: receipts.status,
      depositId: receipts.depositId,
      organizationId: receipts.organizationId,
    })
    .from(receipts)
    .where(inArray(receipts.id, receiptIds));

  if (receiptRows.length !== receiptIds.length) {
    throw new Error('buildDeposit: one or more receipt ids not found');
  }
  for (const r of receiptRows) {
    if (r.organizationId !== organizationId) {
      throw new Error(`buildDeposit: receipt ${r.id} belongs to a different org`);
    }
    if (r.depositId) {
      throw new Error(`buildDeposit: receipt ${r.id} is already in deposit ${r.depositId}`);
    }
    if (r.status === 'voided' || r.status === 'nsf_returned') {
      throw new Error(`buildDeposit: receipt ${r.id} has status=${r.status}`);
    }
  }

  const totalCents = receiptRows.reduce((s, r) => s + r.amountCents, 0);

  // Post the JE first: Dr Cash, Cr Undeposited Funds.
  const { journalEntryId, entryNumber } = await postJournalEntry(
    tx,
    organizationId,
    {
      entryDate: depositDate,
      entryType: 'transfer',
      memo: `Deposit ${depositType}${externalReference ? ' ' + externalReference : ''}`,
      sourceTable: 'deposits',
      sourceId: null, // backfilled below
      lines: [
        {
          glAccountId: bankCashGlAccountId,
          debitCents: totalCents,
          creditCents: 0,
          memo: `Deposit ${depositType}`,
        },
        {
          glAccountId: undepositedFundsGlAccountId,
          debitCents: 0,
          creditCents: totalCents,
          memo: `Deposit ${depositType}`,
        },
      ],
    },
  );

  // Insert deposits row.
  const [dep] = await tx
    .insert(deposits)
    .values({
      organizationId,
      bankAccountId,
      depositDate,
      amountCents: totalCents,
      depositType,
      externalReference,
      journalEntryId,
      status: 'pending',
    })
    .returning({ id: deposits.id });

  // Insert deposit_items + flag receipts.
  for (const r of receiptRows) {
    await tx.insert(depositItems).values({
      organizationId,
      depositId: dep.id,
      receiptId: r.id,
      amountCents: r.amountCents,
    });

    await tx
      .update(receipts)
      .set({ depositId: dep.id, updatedAt: new Date() })
      .where(eq(receipts.id, r.id));
  }

  return {
    depositId: dep.id,
    journalEntryId,
    entryNumber,
    amountCents: totalCents,
    itemCount: receiptRows.length,
  };
}
