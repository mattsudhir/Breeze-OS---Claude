-- Stage 1 of the accounting platform — GL core.
--
-- Implements the four load-bearing tables documented in
-- docs/accounting/data-model.md plus a per-organization
-- entry-number counter:
--
--   gl_accounts              chart of accounts
--   accounting_periods       open / closed reporting periods
--   journal_entries          header for every money-moving event
--   journal_lines            the actual debits and credits
--   journal_entry_counters   per-org monotonic entry-number source
--
-- Three integrity invariants are enforced at the database level (NOT
-- at the application layer) so they cannot be bypassed:
--
--   I1. Per-line: exactly one of debit_cents / credit_cents is
--       non-zero, both non-negative. (CHECK constraints.)
--   I2. On post: when a journal_entry transitions to status='posted',
--       its lines must sum to a balanced, non-zero entry.
--       (BEFORE UPDATE trigger.)
--   I3. Immutability: once a journal_entry is 'posted' or 'reversed',
--       its lines cannot be INSERTed, UPDATEd, or DELETEd.
--       (BEFORE INSERT/UPDATE/DELETE trigger.)
--
-- Trust-accounting columns (gl_accounts.is_trust / trust_purpose,
-- journal_lines.beneficiary_type / beneficiary_id) are declared
-- nullable so trust accounting v2 is additive — a follow-up migration
-- will add a CHECK requiring beneficiary fields whenever the line
-- touches an is_trust GL account.
--
-- This migration also enforces that gl_accounts.currency='USD' for v1
-- via a CHECK constraint; multi-currency v2 will relax it.

-- ── Enums ────────────────────────────────────────────────────────

CREATE TYPE "gl_account_type" AS ENUM ('asset', 'liability', 'equity', 'income', 'expense');
CREATE TYPE "gl_normal_balance" AS ENUM ('debit', 'credit');
CREATE TYPE "accounting_period_status" AS ENUM ('open', 'soft_closed', 'hard_closed');
CREATE TYPE "journal_entry_type" AS ENUM (
  'receipt', 'disbursement', 'bill', 'bill_payment',
  'recurring_charge_posting', 'adjustment', 'transfer',
  'opening_balance', 'period_close'
);
CREATE TYPE "journal_entry_status" AS ENUM ('draft', 'posted', 'reversed');

-- ── gl_accounts ──────────────────────────────────────────────────

CREATE TABLE "gl_accounts" (
  "id"                uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organization_id"   uuid NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE,
  "code"              text NOT NULL,
  "name"              text NOT NULL,
  "account_type"      "gl_account_type" NOT NULL,
  "account_subtype"   text,
  "normal_balance"    "gl_normal_balance" NOT NULL,
  "parent_id"         uuid REFERENCES "gl_accounts"("id") ON DELETE RESTRICT,
  "is_active"         boolean NOT NULL DEFAULT true,
  "is_system"         boolean NOT NULL DEFAULT false,
  "is_bank"           boolean NOT NULL DEFAULT false,
  "currency"          text NOT NULL DEFAULT 'USD',
  "is_trust"          boolean NOT NULL DEFAULT false,
  "trust_purpose"     text,
  "notes"             text,
  "created_at"        timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at"        timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "gl_accounts_currency_usd_only_v1" CHECK ("currency" = 'USD')
);

CREATE UNIQUE INDEX "gl_accounts_org_code_uniq"
  ON "gl_accounts" ("organization_id", "code");
CREATE INDEX "gl_accounts_org_type_idx"
  ON "gl_accounts" ("organization_id", "account_type");
CREATE INDEX "gl_accounts_parent_idx"
  ON "gl_accounts" ("parent_id");
CREATE INDEX "gl_accounts_active_idx"
  ON "gl_accounts" ("organization_id", "is_active");

-- ── accounting_periods ───────────────────────────────────────────

CREATE TABLE "accounting_periods" (
  "id"                  uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organization_id"     uuid NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE,
  "period_start"        date NOT NULL,
  "period_end"          date NOT NULL,
  "fiscal_year"         integer NOT NULL,
  "status"              "accounting_period_status" NOT NULL DEFAULT 'open',
  "closed_at"           timestamp with time zone,
  "closed_by_user_id"   uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "notes"               text,
  "created_at"          timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at"          timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "accounting_periods_range_ordered" CHECK ("period_end" >= "period_start")
);

CREATE UNIQUE INDEX "accounting_periods_org_range_uniq"
  ON "accounting_periods" ("organization_id", "period_start", "period_end");
CREATE INDEX "accounting_periods_org_status_idx"
  ON "accounting_periods" ("organization_id", "status");
CREATE INDEX "accounting_periods_fiscal_idx"
  ON "accounting_periods" ("organization_id", "fiscal_year");

-- ── journal_entry_counters ───────────────────────────────────────

-- Per-organization sequence source. The service layer takes a
-- FOR UPDATE lock on the org's row inside the same transaction that
-- inserts the JE, so concurrent posts serialize cleanly.

CREATE TABLE "journal_entry_counters" (
  "organization_id" uuid PRIMARY KEY REFERENCES "organizations"("id") ON DELETE CASCADE,
  "next_value"      bigint NOT NULL DEFAULT 1,
  "updated_at"      timestamp with time zone NOT NULL DEFAULT now()
);

-- ── journal_entries ──────────────────────────────────────────────

CREATE TABLE "journal_entries" (
  "id"                     uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organization_id"        uuid NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE,
  "entry_number"           bigint NOT NULL,
  "entry_date"             date NOT NULL,
  "period_id"              uuid NOT NULL REFERENCES "accounting_periods"("id") ON DELETE RESTRICT,
  "entry_type"             "journal_entry_type" NOT NULL,
  "source_table"           text,
  "source_id"              uuid,
  "memo"                   text,
  "status"                 "journal_entry_status" NOT NULL DEFAULT 'draft',
  "posted_at"              timestamp with time zone,
  "posted_by_user_id"      uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "reversed_by_entry_id"   uuid REFERENCES "journal_entries"("id") ON DELETE SET NULL,
  "reverses_entry_id"      uuid REFERENCES "journal_entries"("id") ON DELETE SET NULL,
  "notes"                  text,
  "created_at"             timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at"             timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "journal_entries_posted_has_timestamp" CHECK (
    ("status" <> 'posted') OR ("posted_at" IS NOT NULL)
  ),
  -- Reversal pairing is symmetric and exclusive: a row that IS a
  -- reversal cannot also have been reversed by another entry.
  CONSTRAINT "journal_entries_reversal_exclusive" CHECK (
    NOT ("reverses_entry_id" IS NOT NULL AND "reversed_by_entry_id" IS NOT NULL)
  )
);

CREATE UNIQUE INDEX "journal_entries_org_number_uniq"
  ON "journal_entries" ("organization_id", "entry_number");
CREATE INDEX "journal_entries_org_date_idx"
  ON "journal_entries" ("organization_id", "entry_date");
CREATE INDEX "journal_entries_period_idx"
  ON "journal_entries" ("period_id");
CREATE INDEX "journal_entries_source_idx"
  ON "journal_entries" ("source_table", "source_id");
CREATE INDEX "journal_entries_org_status_idx"
  ON "journal_entries" ("organization_id", "status");

-- ── journal_lines ────────────────────────────────────────────────

CREATE TABLE "journal_lines" (
  "id"                 uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organization_id"    uuid NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE,
  "journal_entry_id"   uuid NOT NULL REFERENCES "journal_entries"("id") ON DELETE RESTRICT,
  "gl_account_id"      uuid NOT NULL REFERENCES "gl_accounts"("id") ON DELETE RESTRICT,
  "debit_cents"        bigint NOT NULL DEFAULT 0,
  "credit_cents"       bigint NOT NULL DEFAULT 0,
  "line_number"        integer NOT NULL,
  "memo"               text,
  "unit_id"            uuid REFERENCES "units"("id") ON DELETE SET NULL,
  "property_id"        uuid REFERENCES "properties"("id") ON DELETE SET NULL,
  "owner_id"           uuid REFERENCES "owners"("id") ON DELETE SET NULL,
  -- lease_id / tenant_id / vendor_id are declared without FK
  -- constraints here because their target tables don't exist yet
  -- (Stage 2 for leases/tenants, Stage 5 for vendors). The follow-up
  -- migrations ALTER these to add the FKs once the parent tables land.
  "lease_id"           uuid,
  "tenant_id"          uuid,
  "vendor_id"          uuid,
  -- Trust accounting v2 reserved.
  "beneficiary_type"   text,
  "beneficiary_id"     uuid,
  "created_at"         timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at"         timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "journal_lines_one_side_non_zero" CHECK (
    ("debit_cents" = 0) <> ("credit_cents" = 0)
  ),
  CONSTRAINT "journal_lines_non_negative" CHECK (
    "debit_cents" >= 0 AND "credit_cents" >= 0
  )
);

-- Line numbers are unique within an entry so the UI can render them
-- deterministically and so allocations / matchers can target them.
CREATE UNIQUE INDEX "journal_lines_entry_line_uniq"
  ON "journal_lines" ("journal_entry_id", "line_number");

CREATE INDEX "journal_lines_org_account_entry_idx"
  ON "journal_lines" ("organization_id", "gl_account_id", "journal_entry_id");
CREATE INDEX "journal_lines_entry_idx"
  ON "journal_lines" ("journal_entry_id");
CREATE INDEX "journal_lines_org_unit_idx"
  ON "journal_lines" ("organization_id", "unit_id");
CREATE INDEX "journal_lines_org_property_idx"
  ON "journal_lines" ("organization_id", "property_id");
CREATE INDEX "journal_lines_org_owner_idx"
  ON "journal_lines" ("organization_id", "owner_id");
CREATE INDEX "journal_lines_lease_idx"
  ON "journal_lines" ("lease_id");
CREATE INDEX "journal_lines_tenant_idx"
  ON "journal_lines" ("tenant_id");
CREATE INDEX "journal_lines_vendor_idx"
  ON "journal_lines" ("vendor_id");

-- ── Trigger: enforce balanced + non-zero on transition to posted ──

CREATE OR REPLACE FUNCTION "journal_entry_validate_balanced"()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  total_debit  bigint;
  total_credit bigint;
BEGIN
  SELECT COALESCE(SUM("debit_cents"),  0),
         COALESCE(SUM("credit_cents"), 0)
    INTO total_debit, total_credit
    FROM "journal_lines"
   WHERE "journal_entry_id" = NEW."id";

  IF total_debit <> total_credit THEN
    RAISE EXCEPTION
      'journal entry % cannot be posted: debits=% credits=%',
      NEW."id", total_debit, total_credit
      USING ERRCODE = 'check_violation';
  END IF;

  IF total_debit = 0 THEN
    RAISE EXCEPTION
      'journal entry % cannot be posted: no lines',
      NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$;
--> statement-breakpoint

CREATE TRIGGER "journal_entries_validate_on_post"
BEFORE UPDATE OF "status" ON "journal_entries"
FOR EACH ROW
WHEN (NEW."status" = 'posted' AND OLD."status" <> 'posted')
EXECUTE FUNCTION "journal_entry_validate_balanced"();

-- Also run the validation when a row is INSERTed directly as 'posted'
-- (rare — most posting flows go draft → posted, but the service layer
-- may shortcut for system-generated entries like opening balances).

CREATE TRIGGER "journal_entries_validate_on_insert_posted"
BEFORE INSERT ON "journal_entries"
FOR EACH ROW
WHEN (NEW."status" = 'posted')
EXECUTE FUNCTION "journal_entry_validate_balanced"();

-- ── Trigger: posted/reversed entries are immutable at line level ─

CREATE OR REPLACE FUNCTION "journal_line_reject_if_parent_finalized"()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  target_entry_id uuid;
  parent_status   journal_entry_status;
BEGIN
  IF TG_OP = 'DELETE' THEN
    target_entry_id := OLD."journal_entry_id";
  ELSE
    target_entry_id := NEW."journal_entry_id";
  END IF;

  SELECT "status" INTO parent_status
    FROM "journal_entries"
   WHERE "id" = target_entry_id;

  IF parent_status IN ('posted', 'reversed') THEN
    RAISE EXCEPTION
      'cannot % journal_line: parent entry % is %',
      TG_OP, target_entry_id, parent_status
      USING ERRCODE = 'check_violation';
  END IF;

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  ELSE
    RETURN NEW;
  END IF;
END;
$$;
--> statement-breakpoint

CREATE TRIGGER "journal_lines_immutable_when_finalized"
BEFORE INSERT OR UPDATE OR DELETE ON "journal_lines"
FOR EACH ROW
EXECUTE FUNCTION "journal_line_reject_if_parent_finalized"();
