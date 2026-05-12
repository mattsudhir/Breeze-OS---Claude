-- Inter-entity AR/AP plumbing (corporate accounting follow-up to
-- migration 0019 entities).
--
-- One column + two seed accounts. The column tracks the counterparty
-- entity on intercompany journal lines so consolidation can eliminate
-- the matching pair (lender's IC Receivable line + borrower's IC
-- Payable line). The accounts join the default chart for every org.
--
-- counterparty_entity_id is nullable because most lines don't have a
-- counterparty (only intercompany lines do). Same nullable + ON DELETE
-- SET NULL pattern as the other dimensions.

ALTER TABLE "journal_lines"
  ADD COLUMN "counterparty_entity_id" uuid
    REFERENCES "entities"("id") ON DELETE SET NULL;
CREATE INDEX "journal_lines_counterparty_entity_idx"
  ON "journal_lines"("counterparty_entity_id");

-- Seed Intercompany Receivable + Payable for every existing org.
-- Idempotent via the (organization_id, code) uniqueness on
-- gl_accounts. New orgs pick these up via the default-COA seeder.
INSERT INTO "gl_accounts" (
  "organization_id", "code", "name",
  "account_type", "account_subtype", "normal_balance",
  "is_system", "notes"
)
SELECT
  o.id, '1450', 'Intercompany Receivable',
  'asset', 'receivable_other', 'debit',
  true,
  'Amounts owed by another entity in the same org. Tag the lender as entity_id and the borrower as counterparty_entity_id. Eliminated on consolidation.'
FROM "organizations" o
ON CONFLICT ("organization_id", "code") DO NOTHING;

INSERT INTO "gl_accounts" (
  "organization_id", "code", "name",
  "account_type", "account_subtype", "normal_balance",
  "is_system", "notes"
)
SELECT
  o.id, '2050', 'Intercompany Payable',
  'liability', 'accounts_payable', 'credit',
  true,
  'Amounts owed to another entity in the same org. Tag the borrower as entity_id and the lender as counterparty_entity_id. Eliminated on consolidation.'
FROM "organizations" o
ON CONFLICT ("organization_id", "code") DO NOTHING;
