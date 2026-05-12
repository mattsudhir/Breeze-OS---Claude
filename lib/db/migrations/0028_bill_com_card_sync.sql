-- Bill.com charge-card sync columns.
--
-- bank_accounts.bill_com_card_account_id: identifies the card on
--   Bill.com's side so the sync endpoint knows which account to pull
--   transactions from.
--
-- bank_transactions.bill_com_transaction_id: the swipe transaction
--   id on Bill.com. Lets us upsert idempotently and lets the match-
--   engine confirm hook write categorization back to the same row.
--
-- gl_accounts.bill_com_chart_of_accounts_id: maps our internal GL
--   to Bill.com's. When a rule's target GL is confirmed, we look up
--   this id to tell Bill.com what to code the transaction as.

ALTER TABLE "bank_accounts"
  ADD COLUMN "bill_com_card_account_id" text;
CREATE INDEX "bank_accounts_bill_com_card_idx"
  ON "bank_accounts"("bill_com_card_account_id");

ALTER TABLE "bank_transactions"
  ADD COLUMN "bill_com_transaction_id" text;
CREATE UNIQUE INDEX "bank_transactions_bill_com_id_uniq"
  ON "bank_transactions"("bill_com_transaction_id")
  WHERE "bill_com_transaction_id" IS NOT NULL;

ALTER TABLE "gl_accounts"
  ADD COLUMN "bill_com_chart_of_accounts_id" text;
CREATE INDEX "gl_accounts_bill_com_coa_idx"
  ON "gl_accounts"("bill_com_chart_of_accounts_id");
