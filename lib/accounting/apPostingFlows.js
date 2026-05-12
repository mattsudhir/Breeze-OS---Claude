// AP posting flows — bills + bill payments.
//
//   postBill(tx, orgId, billId)
//     Promote a draft bill to posted. Creates a 'bill' journal_entry
//     debiting the line GLs and crediting AP for the total. Tags
//     each JE line with the bill_line's property/unit/entity dim.
//
//   payBill(tx, orgId, params)
//     Create a bill_payment, allocate to one or more bills,
//     decrement each bill's balance_cents, post a 'bill_payment' JE
//     (debit AP, credit cash/bank), and write allocation rows.

import { and, eq, sql } from 'drizzle-orm';
import {
  bills,
  billLines,
  billPayments,
  billPaymentAllocations,
  vendors,
} from '../db/schema/ap.js';
import { bankAccounts } from '../db/schema/accounting.js';
import { postJournalEntry } from './posting.js';

export async function postBill(tx, organizationId, billId) {
  const [bill] = await tx
    .select()
    .from(bills)
    .where(
      and(
        eq(bills.id, billId),
        eq(bills.organizationId, organizationId),
      ),
    )
    .limit(1);
  if (!bill) throw new Error(`bill not found: ${billId}`);
  if (bill.status !== 'draft') {
    throw new Error(`bill ${billId} is in status '${bill.status}', expected 'draft'`);
  }

  const lines = await tx
    .select()
    .from(billLines)
    .where(eq(billLines.billId, billId));
  if (lines.length === 0) {
    throw new Error(`bill ${billId} has no lines`);
  }
  const linesTotal = lines.reduce((s, l) => s + Number(l.amountCents), 0);
  if (linesTotal !== Number(bill.amountCents)) {
    throw new Error(
      `bill ${billId}: line total ${linesTotal} doesn't match header amount ${bill.amountCents}`,
    );
  }

  const [vendor] = await tx
    .select({ displayName: vendors.displayName })
    .from(vendors)
    .where(eq(vendors.id, bill.vendorId))
    .limit(1);
  const memo = bill.memo || `${vendor?.displayName || 'Vendor'} bill ${bill.billNumber || ''}`.trim();

  // Compose JE lines: one debit per bill_line, one credit on AP.
  const jeLines = [];
  for (const bl of lines) {
    jeLines.push({
      glAccountId: bl.glAccountId,
      debitCents: Number(bl.amountCents),
      creditCents: 0,
      memo: bl.memo || memo,
      propertyId: bl.propertyId,
      unitId: bl.unitId,
      entityId: bl.entityId,
    });
  }
  jeLines.push({
    glAccountId: bill.apGlAccountId,
    debitCents: 0,
    creditCents: Number(bill.amountCents),
    memo,
    vendorId: bill.vendorId,
  });

  const je = await postJournalEntry(tx, organizationId, {
    entryDate: bill.billDate,
    entryType: 'bill',
    memo,
    sourceTable: 'bills',
    sourceId: bill.id,
    lines: jeLines,
  });

  await tx
    .update(bills)
    .set({
      status: 'posted',
      journalEntryId: je.journalEntryId,
      balanceCents: bill.amountCents,
      postedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(bills.id, billId));

  return { journalEntryId: je.journalEntryId, entryNumber: je.entryNumber };
}

/**
 * Pay one or more bills with a single bill_payment.
 *
 * @param {object} tx
 * @param {string} organizationId
 * @param {object} params
 * @param {string} params.vendorId
 * @param {string} params.bankAccountId   bank that paid (its GL is credited)
 * @param {string} params.paymentDate     YYYY-MM-DD
 * @param {string} params.paymentMethod   'check' | 'ach' | 'wire' | etc.
 * @param {string} [params.externalReference]
 * @param {string} [params.memo]
 * @param {Array<{billId: string, amountCents: number}>} params.allocations
 */
export async function payBill(tx, organizationId, params) {
  const {
    vendorId, bankAccountId, paymentDate,
    paymentMethod, externalReference, memo,
    allocations = [],
  } = params;
  if (!vendorId) throw new Error('payBill: vendorId required');
  if (!bankAccountId) throw new Error('payBill: bankAccountId required');
  if (!paymentDate) throw new Error('payBill: paymentDate required');
  if (allocations.length === 0) throw new Error('payBill: allocations required');

  // Validate bank account belongs to org, get its GL.
  const [bank] = await tx
    .select({ id: bankAccounts.id, glAccountId: bankAccounts.glAccountId })
    .from(bankAccounts)
    .where(
      and(
        eq(bankAccounts.id, bankAccountId),
        eq(bankAccounts.organizationId, organizationId),
      ),
    )
    .limit(1);
  if (!bank) throw new Error(`bank_account ${bankAccountId} not found in org`);

  // Validate each bill, check it's posted + same vendor + has enough balance.
  let totalCents = 0;
  const billRows = [];
  let apGlAccountId = null;
  for (const a of allocations) {
    if (!a.billId) throw new Error('allocation missing billId');
    if (!Number.isInteger(a.amountCents) || a.amountCents <= 0) {
      throw new Error(`allocation for bill ${a.billId} has invalid amount_cents`);
    }
    const [b] = await tx
      .select()
      .from(bills)
      .where(
        and(
          eq(bills.id, a.billId),
          eq(bills.organizationId, organizationId),
        ),
      )
      .limit(1);
    if (!b) throw new Error(`bill ${a.billId} not found`);
    if (b.vendorId !== vendorId) {
      throw new Error(`bill ${a.billId} belongs to a different vendor`);
    }
    if (b.status !== 'posted') {
      throw new Error(`bill ${a.billId} is not posted`);
    }
    if (Number(b.balanceCents) < a.amountCents) {
      throw new Error(
        `allocation ${a.amountCents} exceeds bill ${a.billId} balance ${b.balanceCents}`,
      );
    }
    if (apGlAccountId && apGlAccountId !== b.apGlAccountId) {
      throw new Error('allocations span multiple AP accounts; not yet supported');
    }
    apGlAccountId = b.apGlAccountId;
    totalCents += a.amountCents;
    billRows.push(b);
  }

  // Post the bill_payment JE: debit AP, credit cash.
  const je = await postJournalEntry(tx, organizationId, {
    entryDate: paymentDate,
    entryType: 'bill_payment',
    memo: memo || `Bill payment to vendor ${vendorId}`,
    sourceTable: 'bill_payments',
    sourceId: null,
    lines: [
      {
        glAccountId: apGlAccountId,
        debitCents: totalCents,
        creditCents: 0,
        memo: memo || 'AP payment',
        vendorId,
      },
      {
        glAccountId: bank.glAccountId,
        debitCents: 0,
        creditCents: totalCents,
        memo: memo || 'AP payment',
      },
    ],
  });

  // Insert the bill_payment row.
  const [payment] = await tx
    .insert(billPayments)
    .values({
      organizationId,
      vendorId,
      paymentDate,
      amountCents: totalCents,
      paymentMethod,
      bankAccountId,
      externalReference: externalReference || null,
      journalEntryId: je.journalEntryId,
      status: 'cleared',
      memo: memo || null,
    })
    .returning({ id: billPayments.id });

  // Allocation rows + decrement balances.
  for (const a of allocations) {
    await tx.insert(billPaymentAllocations).values({
      organizationId,
      billPaymentId: payment.id,
      billId: a.billId,
      amountCents: a.amountCents,
    });
    await tx
      .update(bills)
      .set({
        balanceCents: sql`${bills.balanceCents} - ${a.amountCents}`,
        updatedAt: new Date(),
      })
      .where(eq(bills.id, a.billId));
  }

  return {
    billPaymentId: payment.id,
    journalEntryId: je.journalEntryId,
    entryNumber: je.entryNumber,
    totalCents,
  };
}
