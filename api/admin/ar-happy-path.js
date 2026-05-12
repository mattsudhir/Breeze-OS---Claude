// Vercel Serverless Function — end-to-end AR smoke test.
//
// GET/POST /api/admin/ar-happy-path?secret=<TOKEN>&dry_run=true|false
//
// Exercises the full Stage 2 service layer in one transaction:
//
//   1. Create (or reuse) a test tenant: "Smoke Test Tenant".
//   2. Find a unit to attach a lease to (uses the first units row).
//   3. Create (or reuse) a test lease #SMOKE-TEST-LEASE.
//   4. Create (or reuse) a test scheduled_charge: $1,000 monthly rent
//      crediting AppFolio code 4000 Rents.
//   5. Fire postScheduledCharge() once — produces a posted_charges
//      row at $1,000 balance and a balanced JE
//      (Dr 1250 AR, Cr 4000 Rents).
//   6. recordReceipt() $1,000 with full allocation against the
//      just-posted charge — produces a JE (Dr 1110 Undeposited
//      Funds, Cr 1250 AR) and zeros the posted_charges balance.
//   7. buildDeposit() bundling that one receipt into a
//      check_batch deposit — produces a JE (Dr 1149 Operating
//      Cash, Cr 1110 Undeposited Funds) and sets receipts.deposit_id.
//
// Returns the journal_entries + posted_charges + receipts + deposits
// rows created. The whole thing is one transaction — if any step
// fails, the DB rolls back to a clean state. Repeated calls re-fire
// step 5 against a fresh due-date so subsequent invocations work
// (idempotency on (scheduled_charge_id, charge_date) means the
// scheduled_charge advances each call).
//
// Required Breeze account codes (from the AppFolio import):
//   1149  Operating Cash (Breeze - PNC)   [parked bank, inactive]
//   1250  Accounts Receivable
//   4000  Rents
//   2200  Prepaid Rent / Tenant Credits   — only if you allocate
//                                            less than the full amount
//
// And one Breeze-OS-specific account that AppFolio doesn't have:
//   1110  Undeposited Funds              — created on-demand by
//                                          this endpoint if missing.

import { and, eq } from 'drizzle-orm';
import {
  withAdminHandler,
  getDefaultOrgId,
} from '../../lib/adminHelpers.js';
import { getDb, schema } from '../../lib/db/index.js';
import {
  ensureAccountingPeriod,
  lookupGlAccountByCode,
} from '../../lib/accounting/posting.js';
import {
  postScheduledCharge,
  recordReceipt,
  buildDeposit,
} from '../../lib/accounting/arPostingFlows.js';
import { applyDefaultTagsForAccount } from '../../lib/accounting/applyDefaultGlAccountTags.js';

const RENT_AMOUNT_CENTS = 100000; // $1,000.00

async function findOrCreateUndepositedFunds(tx, organizationId) {
  // Try existing code 1110 first.
  const existing = await tx
    .select({ id: schema.glAccounts.id })
    .from(schema.glAccounts)
    .where(
      and(
        eq(schema.glAccounts.organizationId, organizationId),
        eq(schema.glAccounts.code, '1110'),
      ),
    )
    .limit(1);
  if (existing.length > 0) return existing[0].id;

  // Create it. Mark is_system so it can't be deleted by mistake.
  const [created] = await tx
    .insert(schema.glAccounts)
    .values({
      organizationId,
      code: '1110',
      name: 'Undeposited Funds',
      accountType: 'asset',
      accountSubtype: 'cash',
      normalBalance: 'debit',
      isActive: true,
      isSystem: true,
      isBank: false,
      currency: 'USD',
      notes:
        'Created by ar-happy-path smoke test. Receipts post here ' +
        'before being grouped into a deposit; the deposit then ' +
        'moves the balance to Cash. Required by the AR posting ' +
        'service helpers.',
    })
    .returning({ id: schema.glAccounts.id });

  await applyDefaultTagsForAccount(tx, created.id, {
    code: '1110',
    name: 'Undeposited Funds',
    accountType: 'asset',
    accountSubtype: 'cash',
  });

  return created.id;
}

async function findOrCreateTestTenant(tx, organizationId) {
  const existing = await tx
    .select({ id: schema.tenants.id })
    .from(schema.tenants)
    .where(
      and(
        eq(schema.tenants.organizationId, organizationId),
        eq(schema.tenants.displayName, 'Smoke Test Tenant'),
      ),
    )
    .limit(1);
  if (existing.length > 0) return existing[0].id;

  const [created] = await tx
    .insert(schema.tenants)
    .values({
      organizationId,
      firstName: 'Smoke',
      lastName: 'Test',
      displayName: 'Smoke Test Tenant',
      email: 'smoke-test@example.invalid',
      sourcePms: 'appfolio',
      notes: 'Created by /api/admin/ar-happy-path. Safe to delete after testing.',
    })
    .returning({ id: schema.tenants.id });

  return created.id;
}

async function findFirstUnitId(tx, organizationId) {
  const rows = await tx
    .select({ id: schema.units.id })
    .from(schema.units)
    .where(eq(schema.units.organizationId, organizationId))
    .limit(1);
  if (rows.length === 0) {
    throw new Error(
      'No units found for org. Run a property/unit import first.',
    );
  }
  return rows[0].id;
}

async function findOrCreateTestLease(tx, organizationId, unitId, tenantId) {
  const existing = await tx
    .select({ id: schema.leases.id })
    .from(schema.leases)
    .where(
      and(
        eq(schema.leases.organizationId, organizationId),
        eq(schema.leases.leaseNumber, 'SMOKE-TEST-LEASE'),
      ),
    )
    .limit(1);
  if (existing.length > 0) return existing[0].id;

  const today = new Date().toISOString().slice(0, 10);
  const [lease] = await tx
    .insert(schema.leases)
    .values({
      organizationId,
      unitId,
      leaseNumber: 'SMOKE-TEST-LEASE',
      status: 'active',
      startDate: today,
      rentCents: RENT_AMOUNT_CENTS,
      sourcePms: 'appfolio',
      notes: 'Created by /api/admin/ar-happy-path.',
    })
    .returning({ id: schema.leases.id });

  await tx
    .insert(schema.leaseTenants)
    .values({
      leaseId: lease.id,
      tenantId,
      role: 'primary',
    });

  return lease.id;
}

async function findOrCreateTestScheduledCharge(
  tx,
  organizationId,
  leaseId,
  unitId,
  glAccountId,
) {
  const existing = await tx
    .select({
      id: schema.scheduledCharges.id,
      nextDueDate: schema.scheduledCharges.nextDueDate,
      status: schema.scheduledCharges.status,
    })
    .from(schema.scheduledCharges)
    .where(
      and(
        eq(schema.scheduledCharges.organizationId, organizationId),
        eq(schema.scheduledCharges.leaseId, leaseId),
        eq(schema.scheduledCharges.chargeType, 'rent'),
      ),
    )
    .limit(1);
  if (existing.length > 0) return existing[0];

  const today = new Date().toISOString().slice(0, 10);
  const [sc] = await tx
    .insert(schema.scheduledCharges)
    .values({
      organizationId,
      leaseId,
      unitId,
      chargeType: 'rent',
      description: 'Smoke test monthly rent',
      amountCents: RENT_AMOUNT_CENTS,
      glAccountId,
      frequency: 'monthly',
      nextDueDate: today,
      status: 'active',
    })
    .returning({
      id: schema.scheduledCharges.id,
      nextDueDate: schema.scheduledCharges.nextDueDate,
      status: schema.scheduledCharges.status,
    });
  return sc;
}

export default withAdminHandler(async (req, res) => {
  if (req.method !== 'GET' && req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'GET or POST only' });
  }

  const db = getDb();
  const organizationId = await getDefaultOrgId();
  const t0 = Date.now();

  const result = await db.transaction(async (tx) => {
    // 0. Resolve required GL accounts.
    const arAccountId = await lookupGlAccountByCode(tx, organizationId, '1250');
    const rentIncomeAccountId = await lookupGlAccountByCode(tx, organizationId, '4000');
    const bankCashAccountId = await lookupGlAccountByCode(tx, organizationId, '1149');
    const undepositedFundsAccountId = await findOrCreateUndepositedFunds(
      tx,
      organizationId,
    );

    // 1-4. Set up test entities.
    const tenantId = await findOrCreateTestTenant(tx, organizationId);
    const unitId = await findFirstUnitId(tx, organizationId);
    const leaseId = await findOrCreateTestLease(tx, organizationId, unitId, tenantId);
    const sc = await findOrCreateTestScheduledCharge(
      tx,
      organizationId,
      leaseId,
      unitId,
      rentIncomeAccountId,
    );

    if (sc.status !== 'active') {
      throw new Error(
        `scheduled_charge ${sc.id} status=${sc.status}; re-create or change status to 'active'`,
      );
    }

    // 5. Fire the scheduled charge.
    const charge = await postScheduledCharge(
      tx,
      organizationId,
      sc.id,
      {
        arGlAccountId: arAccountId,
        tenantId,
      },
    );

    // 6. Record a receipt fully allocated against the just-posted
    // charge.
    const today = new Date().toISOString().slice(0, 10);
    const receipt = await recordReceipt(tx, organizationId, {
      undepositedFundsGlAccountId: undepositedFundsAccountId,
      tenantId,
      leaseId,
      receivedDate: today,
      amountCents: RENT_AMOUNT_CENTS,
      paymentMethod: 'check',
      externalReference: 'SMOKE-TEST-CHECK-1',
      allocations: [
        {
          postedChargeId: charge.postedChargeId,
          glAccountId: arAccountId,
          amountCents: RENT_AMOUNT_CENTS,
        },
      ],
    });

    // 7. Build a deposit containing that one receipt.
    const deposit = await buildDeposit(tx, organizationId, {
      bankCashGlAccountId: bankCashAccountId,
      undepositedFundsGlAccountId: undepositedFundsAccountId,
      depositDate: today,
      depositType: 'check_batch',
      receiptIds: [receipt.receiptId],
      externalReference: 'SMOKE-TEST-DEPOSIT-1',
    });

    return {
      tenant_id: tenantId,
      unit_id: unitId,
      lease_id: leaseId,
      scheduled_charge_id: sc.id,
      charge,
      receipt,
      deposit,
    };
  });

  return res.status(200).json({
    ok: true,
    organization_id: organizationId,
    elapsed_ms: Date.now() - t0,
    ...result,
  });
});
