-- Bill.com payment method.
--
-- Adds a payment method enum value + two columns on bill_payments
-- so we can track Bill.com's payment id + status alongside our own.
--
-- Why a separate id: Bill.com's payment lifecycle is asynchronous —
-- you schedule a payment, Bill.com batches ACH runs, the actual
-- bank movement happens days later. Their webhook tells us when
-- each state changes. Our `bill_payments.status` ('cleared') marks
-- "we committed the JE"; `bill_com_status` tracks Bill.com's view.

ALTER TYPE "bill_payment_method" ADD VALUE IF NOT EXISTS 'bill_com';

ALTER TABLE "bill_payments"
  ADD COLUMN "bill_com_payment_id" text,
  ADD COLUMN "bill_com_status"     text,
  ADD COLUMN "bill_com_synced_at"  timestamp with time zone;

CREATE INDEX "bill_payments_bill_com_id_idx"
  ON "bill_payments"("bill_com_payment_id");

-- Vendor + bank-account id mapping so the scheduler can translate
-- our internal ids to Bill.com's. Both nullable: Bill.com setup is
-- per-vendor (and per-bank-account), happens after onboarding.

ALTER TABLE "vendors"
  ADD COLUMN "bill_com_vendor_id" text;
CREATE INDEX "vendors_bill_com_id_idx" ON "vendors"("bill_com_vendor_id");

ALTER TABLE "bank_accounts"
  ADD COLUMN "bill_com_bank_account_id" text;
CREATE INDEX "bank_accounts_bill_com_id_idx" ON "bank_accounts"("bill_com_bank_account_id");
