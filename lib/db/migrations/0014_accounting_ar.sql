-- Stage 2 of the accounting platform — AR + multi-dimensional tags.
--
-- Adds the receivables, lease, tenant, and deposit/receipt machinery
-- on top of the Stage 1 GL core (migration 0006). Also lands the
-- tag tables that the design doc
-- (docs/accounting/multi-dimensional-tagging.md) commits to.
--
-- Tables created:
--   tenants                lightweight contact records
--   leases                 unit-level lease (joined to units by FK)
--   lease_tenants          m2m roles between leases and tenants
--   lease_rent_changes     append-only audit of rent_cents changes
--   deposits               groups of receipts hitting a bank account
--   scheduled_charges      forward-looking recurring obligations
--   receipts               "money in" records (post to undeposited
--                          funds, not directly to cash)
--   posted_charges         receivables on the books
--   receipt_allocations    how a receipt pays down posted_charges
--   deposit_items          which receipts belong to a deposit
--   gl_account_tags        account-level default tag set
--   journal_line_tags      per-line materialised tag set
--
-- Triggers added:
--   - deposit_items totals validate against deposits.amount_cents
--   - receipt_allocations totals can't exceed receipts.amount_cents
--   - posted_charges.balance_cents can't go negative or exceed
--     amount_cents
--   - voided / nsf_returned receipts can't be added to a deposit
--
-- FK constraints retroactively added to journal_lines:
--   - lease_id   → leases.id   ON DELETE SET NULL
--   - tenant_id  → tenants.id  ON DELETE SET NULL
--   (vendor_id stays unconstrained; Stage 5 adds the FK with vendors)

-- ── Enums ────────────────────────────────────────────────────────

CREATE TYPE "lease_status" AS ENUM (
  'draft', 'active', 'notice_given', 'ended', 'evicted'
);
CREATE TYPE "lease_tenant_role" AS ENUM (
  'primary', 'co_signer', 'occupant', 'guarantor'
);
CREATE TYPE "charge_frequency" AS ENUM (
  'monthly', 'quarterly', 'annual', 'one_time'
);
CREATE TYPE "scheduled_charge_status" AS ENUM (
  'active', 'paused', 'ended'
);
CREATE TYPE "posted_charge_status" AS ENUM (
  'open', 'partially_paid', 'paid', 'voided'
);
CREATE TYPE "payment_method" AS ENUM (
  'ach', 'check', 'credit_card', 'cash', 'money_order',
  'paynearme', 'section_8', 'other'
);
CREATE TYPE "receipt_status" AS ENUM (
  'pending', 'cleared', 'nsf_returned', 'voided'
);
CREATE TYPE "deposit_type" AS ENUM (
  'check_batch', 'ach_batch', 'cash', 'wire',
  'section_8_omnibus', 'other'
);
CREATE TYPE "deposit_status" AS ENUM (
  'pending', 'cleared', 'nsf_returned', 'voided'
);
CREATE TYPE "tag_source" AS ENUM (
  'account_default', 'posting_explicit', 'staff_override',
  'rule_engine'
);

-- ── tenants ──────────────────────────────────────────────────────

CREATE TABLE "tenants" (
  "id"                uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organization_id"   uuid NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE,
  "first_name"        text,
  "last_name"         text,
  "display_name"      text NOT NULL,
  "email"             text,
  "phone"             text,
  "mobile_phone"      text,
  "source_tenant_id"  text,
  "source_pms"        text NOT NULL DEFAULT 'appfolio',
  "notes"             text,
  "created_at"        timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at"        timestamp with time zone NOT NULL DEFAULT now()
);

CREATE INDEX "tenants_org_idx"           ON "tenants" ("organization_id");
CREATE INDEX "tenants_source_idx"        ON "tenants" ("source_tenant_id");
CREATE INDEX "tenants_email_idx"         ON "tenants" ("email");
CREATE INDEX "tenants_display_name_idx"  ON "tenants" ("display_name");

-- ── leases ───────────────────────────────────────────────────────

CREATE TABLE "leases" (
  "id"                       uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organization_id"          uuid NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE,
  "unit_id"                  uuid NOT NULL REFERENCES "units"("id") ON DELETE RESTRICT,
  "lease_number"             text NOT NULL,
  "status"                   "lease_status" NOT NULL DEFAULT 'draft',
  "start_date"               date NOT NULL,
  "end_date"                 date,
  "rent_cents"               bigint NOT NULL,
  "rent_due_day"             integer NOT NULL DEFAULT 1,
  "late_fee_cents"           bigint,
  "late_fee_grace_days"      integer,
  "security_deposit_cents"   bigint NOT NULL DEFAULT 0,
  "source_lease_id"          text,
  "source_pms"               text NOT NULL DEFAULT 'appfolio',
  "notes"                    text,
  "created_at"               timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at"               timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "leases_rent_non_negative" CHECK ("rent_cents" >= 0),
  CONSTRAINT "leases_security_deposit_non_negative" CHECK ("security_deposit_cents" >= 0),
  CONSTRAINT "leases_due_day_range" CHECK ("rent_due_day" BETWEEN 1 AND 31),
  CONSTRAINT "leases_date_ordered" CHECK ("end_date" IS NULL OR "end_date" >= "start_date")
);

CREATE UNIQUE INDEX "leases_org_lease_number_uniq" ON "leases" ("organization_id", "lease_number");
CREATE INDEX "leases_org_status_idx" ON "leases" ("organization_id", "status");
CREATE INDEX "leases_unit_idx"       ON "leases" ("unit_id");
CREATE INDEX "leases_source_idx"     ON "leases" ("source_lease_id");

-- ── lease_tenants (M2M) ──────────────────────────────────────────

CREATE TABLE "lease_tenants" (
  "lease_id"    uuid NOT NULL REFERENCES "leases"("id")  ON DELETE CASCADE,
  "tenant_id"   uuid NOT NULL REFERENCES "tenants"("id") ON DELETE RESTRICT,
  "role"        "lease_tenant_role" NOT NULL DEFAULT 'primary',
  "created_at"  timestamp with time zone NOT NULL DEFAULT now(),
  PRIMARY KEY ("lease_id", "tenant_id")
);

CREATE INDEX "lease_tenants_tenant_idx" ON "lease_tenants" ("tenant_id");
CREATE INDEX "lease_tenants_role_idx"   ON "lease_tenants" ("role");

-- ── lease_rent_changes ───────────────────────────────────────────

CREATE TABLE "lease_rent_changes" (
  "id"                   uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organization_id"      uuid NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE,
  "lease_id"             uuid NOT NULL REFERENCES "leases"("id") ON DELETE CASCADE,
  "effective_date"       date NOT NULL,
  "old_rent_cents"       bigint NOT NULL,
  "new_rent_cents"       bigint NOT NULL,
  "changed_by_user_id"   uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "reason"               text,
  "created_at"           timestamp with time zone NOT NULL DEFAULT now()
);

CREATE INDEX "lease_rent_changes_lease_date_idx" ON "lease_rent_changes" ("lease_id", "effective_date");
CREATE INDEX "lease_rent_changes_org_idx" ON "lease_rent_changes" ("organization_id");

-- ── deposits ─────────────────────────────────────────────────────
--
-- bank_account_id is uuid without an FK constraint. The bank_accounts
-- table lands in Stage 3 (next migration after this one); a follow-up
-- migration will ALTER TABLE deposits ADD CONSTRAINT then.

CREATE TABLE "deposits" (
  "id"                  uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organization_id"     uuid NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE,
  "bank_account_id"     uuid,
  "deposit_date"        date NOT NULL,
  "amount_cents"        bigint NOT NULL,
  "deposit_type"        "deposit_type" NOT NULL,
  "external_reference"  text,
  "journal_entry_id"    uuid NOT NULL REFERENCES "journal_entries"("id") ON DELETE RESTRICT,
  "status"              "deposit_status" NOT NULL DEFAULT 'pending',
  "notes"               text,
  "created_at"          timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at"          timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "deposits_amount_non_negative" CHECK ("amount_cents" >= 0)
);

CREATE INDEX "deposits_org_date_idx"            ON "deposits" ("organization_id", "deposit_date");
CREATE INDEX "deposits_bank_status_idx"         ON "deposits" ("bank_account_id", "status");
CREATE INDEX "deposits_external_reference_idx"  ON "deposits" ("external_reference");

-- ── scheduled_charges ────────────────────────────────────────────

CREATE TABLE "scheduled_charges" (
  "id"                uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organization_id"   uuid NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE,
  "lease_id"          uuid REFERENCES "leases"("id") ON DELETE CASCADE,
  "unit_id"           uuid REFERENCES "units"("id") ON DELETE SET NULL,
  "property_id"       uuid REFERENCES "properties"("id") ON DELETE SET NULL,
  "charge_type"       text NOT NULL,
  "description"       text NOT NULL,
  "amount_cents"      bigint NOT NULL,
  "gl_account_id"     uuid NOT NULL REFERENCES "gl_accounts"("id") ON DELETE RESTRICT,
  "frequency"         "charge_frequency" NOT NULL,
  "next_due_date"     date NOT NULL,
  "end_date"          date,
  "status"            "scheduled_charge_status" NOT NULL DEFAULT 'active',
  "notes"             text,
  "created_at"        timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at"        timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "scheduled_charges_amount_non_negative" CHECK ("amount_cents" >= 0),
  CONSTRAINT "scheduled_charges_end_after_start"
    CHECK ("end_date" IS NULL OR "end_date" >= "next_due_date" - INTERVAL '1 day'),
  CONSTRAINT "scheduled_charges_attribution_present"
    CHECK ("lease_id" IS NOT NULL
        OR "unit_id" IS NOT NULL
        OR "property_id" IS NOT NULL)
);

CREATE INDEX "scheduled_charges_due_idx" ON "scheduled_charges" ("organization_id", "next_due_date", "status");
CREATE INDEX "scheduled_charges_lease_idx"    ON "scheduled_charges" ("lease_id");
CREATE INDEX "scheduled_charges_unit_idx"     ON "scheduled_charges" ("unit_id");
CREATE INDEX "scheduled_charges_property_idx" ON "scheduled_charges" ("property_id");

-- ── receipts ─────────────────────────────────────────────────────

CREATE TABLE "receipts" (
  "id"                  uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organization_id"     uuid NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE,
  "tenant_id"           uuid REFERENCES "tenants"("id") ON DELETE SET NULL,
  "lease_id"            uuid REFERENCES "leases"("id")  ON DELETE SET NULL,
  "received_date"       date NOT NULL,
  "amount_cents"        bigint NOT NULL,
  "payment_method"      "payment_method" NOT NULL,
  "external_reference"  text,
  "deposit_id"          uuid REFERENCES "deposits"("id") ON DELETE SET NULL,
  "journal_entry_id"    uuid NOT NULL REFERENCES "journal_entries"("id") ON DELETE RESTRICT,
  "status"              "receipt_status" NOT NULL DEFAULT 'pending',
  "notes"               text,
  "created_at"          timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at"          timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "receipts_amount_positive" CHECK ("amount_cents" > 0)
);

CREATE INDEX "receipts_org_date_idx"            ON "receipts" ("organization_id", "received_date");
CREATE INDEX "receipts_tenant_idx"              ON "receipts" ("tenant_id");
CREATE INDEX "receipts_lease_idx"               ON "receipts" ("lease_id");
CREATE INDEX "receipts_deposit_idx"             ON "receipts" ("deposit_id");
CREATE INDEX "receipts_external_reference_idx"  ON "receipts" ("external_reference");
CREATE INDEX "receipts_je_idx"                  ON "receipts" ("journal_entry_id");

-- ── posted_charges ───────────────────────────────────────────────

CREATE TABLE "posted_charges" (
  "id"                    uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organization_id"       uuid NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE,
  "scheduled_charge_id"   uuid REFERENCES "scheduled_charges"("id") ON DELETE SET NULL,
  "lease_id"              uuid REFERENCES "leases"("id")    ON DELETE SET NULL,
  "unit_id"               uuid REFERENCES "units"("id")     ON DELETE SET NULL,
  "property_id"           uuid REFERENCES "properties"("id") ON DELETE SET NULL,
  "tenant_id"             uuid REFERENCES "tenants"("id")   ON DELETE SET NULL,
  "charge_type"           text NOT NULL,
  "description"           text NOT NULL,
  "charge_date"           date NOT NULL,
  "due_date"              date NOT NULL,
  "amount_cents"          bigint NOT NULL,
  "balance_cents"         bigint NOT NULL,
  "gl_account_id"         uuid NOT NULL REFERENCES "gl_accounts"("id") ON DELETE RESTRICT,
  "journal_entry_id"      uuid NOT NULL REFERENCES "journal_entries"("id") ON DELETE RESTRICT,
  "status"                "posted_charge_status" NOT NULL DEFAULT 'open',
  "notes"                 text,
  "created_at"            timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at"            timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "posted_charges_amount_positive" CHECK ("amount_cents" > 0),
  CONSTRAINT "posted_charges_balance_bounds"
    CHECK ("balance_cents" >= 0 AND "balance_cents" <= "amount_cents"),
  CONSTRAINT "posted_charges_status_balance_consistent"
    CHECK (
      ("status" = 'paid'           AND "balance_cents" = 0) OR
      ("status" = 'open'           AND "balance_cents" = "amount_cents") OR
      ("status" = 'partially_paid' AND "balance_cents" > 0 AND "balance_cents" < "amount_cents") OR
      ("status" = 'voided')
    )
);

CREATE INDEX "posted_charges_status_due_idx" ON "posted_charges" ("organization_id", "status", "due_date");
CREATE INDEX "posted_charges_lease_idx"      ON "posted_charges" ("lease_id");
CREATE INDEX "posted_charges_tenant_idx"     ON "posted_charges" ("tenant_id");
CREATE INDEX "posted_charges_unit_idx"       ON "posted_charges" ("unit_id");
CREATE INDEX "posted_charges_scheduled_idx"  ON "posted_charges" ("scheduled_charge_id");
CREATE INDEX "posted_charges_je_idx"         ON "posted_charges" ("journal_entry_id");

-- ── receipt_allocations ──────────────────────────────────────────

CREATE TABLE "receipt_allocations" (
  "id"                uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organization_id"   uuid NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE,
  "receipt_id"        uuid NOT NULL REFERENCES "receipts"("id") ON DELETE CASCADE,
  "posted_charge_id"  uuid NOT NULL REFERENCES "posted_charges"("id") ON DELETE RESTRICT,
  "amount_cents"      bigint NOT NULL,
  "created_at"        timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "receipt_allocations_amount_positive" CHECK ("amount_cents" > 0)
);

CREATE INDEX "receipt_allocations_receipt_idx" ON "receipt_allocations" ("receipt_id");
CREATE INDEX "receipt_allocations_charge_idx"  ON "receipt_allocations" ("posted_charge_id");

-- ── deposit_items ────────────────────────────────────────────────

CREATE TABLE "deposit_items" (
  "id"                uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organization_id"   uuid NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE,
  "deposit_id"        uuid NOT NULL REFERENCES "deposits"("id") ON DELETE CASCADE,
  "receipt_id"        uuid NOT NULL REFERENCES "receipts"("id") ON DELETE RESTRICT,
  "amount_cents"      bigint NOT NULL,
  "created_at"        timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "deposit_items_amount_positive" CHECK ("amount_cents" > 0)
);

CREATE UNIQUE INDEX "deposit_items_receipt_uniq" ON "deposit_items" ("receipt_id");
CREATE INDEX        "deposit_items_deposit_idx"  ON "deposit_items" ("deposit_id");

-- ── gl_account_tags ──────────────────────────────────────────────

CREATE TABLE "gl_account_tags" (
  "gl_account_id"  uuid NOT NULL REFERENCES "gl_accounts"("id") ON DELETE CASCADE,
  "namespace"      text NOT NULL,
  "value"          text NOT NULL,
  "notes"          text,
  "created_at"     timestamp with time zone NOT NULL DEFAULT now(),
  PRIMARY KEY ("gl_account_id", "namespace", "value"),
  CONSTRAINT "gl_account_tags_namespace_non_empty" CHECK (length(trim("namespace")) > 0),
  CONSTRAINT "gl_account_tags_value_non_empty"     CHECK (length(trim("value")) > 0)
);

CREATE INDEX "gl_account_tags_ns_value_idx" ON "gl_account_tags" ("namespace", "value");

-- ── journal_line_tags ────────────────────────────────────────────

CREATE TABLE "journal_line_tags" (
  "journal_line_id"  uuid NOT NULL REFERENCES "journal_lines"("id") ON DELETE CASCADE,
  "organization_id"  uuid NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE,
  "namespace"        text NOT NULL,
  "value"            text NOT NULL,
  "source"           "tag_source" NOT NULL DEFAULT 'account_default',
  "created_at"       timestamp with time zone NOT NULL DEFAULT now(),
  PRIMARY KEY ("journal_line_id", "namespace", "value"),
  CONSTRAINT "journal_line_tags_namespace_non_empty" CHECK (length(trim("namespace")) > 0),
  CONSTRAINT "journal_line_tags_value_non_empty"     CHECK (length(trim("value")) > 0)
);

CREATE INDEX "journal_line_tags_reporting_idx"
  ON "journal_line_tags" ("organization_id", "namespace", "value");
CREATE INDEX "journal_line_tags_line_idx"
  ON "journal_line_tags" ("journal_line_id");

-- ── Retroactive FK constraints on journal_lines ──────────────────
--
-- Stage 1 created journal_lines.lease_id / tenant_id as nullable
-- uuid columns without FK constraints (the target tables didn't
-- exist yet). Now that leases and tenants exist, add the FKs.
-- vendor_id stays uncovered until Stage 5.

ALTER TABLE "journal_lines"
  ADD CONSTRAINT "journal_lines_lease_id_fk"
  FOREIGN KEY ("lease_id") REFERENCES "leases"("id") ON DELETE SET NULL;

ALTER TABLE "journal_lines"
  ADD CONSTRAINT "journal_lines_tenant_id_fk"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE SET NULL;

-- ── Triggers: deposit / receipt / charge consistency ────────────

-- Trigger 1: deposit_items.amount_cents must sum to
-- deposits.amount_cents (deferred until commit so a deposit can be
-- built up line-by-line in a transaction without intermediate
-- violations).
--
-- This is checked on INSERT/UPDATE/DELETE of deposit_items.

CREATE OR REPLACE FUNCTION "deposit_items_validate_sum"()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  target_deposit_id uuid;
  declared_total    bigint;
  items_total       bigint;
BEGIN
  IF TG_OP = 'DELETE' THEN
    target_deposit_id := OLD."deposit_id";
  ELSE
    target_deposit_id := NEW."deposit_id";
  END IF;

  SELECT "amount_cents" INTO declared_total
    FROM "deposits" WHERE "id" = target_deposit_id;
  SELECT COALESCE(SUM("amount_cents"), 0) INTO items_total
    FROM "deposit_items" WHERE "deposit_id" = target_deposit_id;

  -- After the in-progress write, items_total reflects post-write state.
  -- We allow building up the deposit (items_total < declared_total) and
  -- only reject when items_total > declared_total — over-allocation is
  -- the bug we care about.
  IF items_total > declared_total THEN
    RAISE EXCEPTION
      'deposit % over-allocated: items_total=% > deposits.amount_cents=%',
      target_deposit_id, items_total, declared_total
      USING ERRCODE = 'check_violation';
  END IF;

  IF TG_OP = 'DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
END;
$$;
--> statement-breakpoint

CREATE TRIGGER "deposit_items_sum_check"
AFTER INSERT OR UPDATE OR DELETE ON "deposit_items"
FOR EACH ROW EXECUTE FUNCTION "deposit_items_validate_sum"();

-- Trigger 2: receipt_allocations totals can't exceed
-- receipts.amount_cents.

CREATE OR REPLACE FUNCTION "receipt_allocations_validate_sum"()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  target_receipt_id  uuid;
  receipt_total      bigint;
  alloc_total        bigint;
BEGIN
  IF TG_OP = 'DELETE' THEN
    target_receipt_id := OLD."receipt_id";
  ELSE
    target_receipt_id := NEW."receipt_id";
  END IF;

  SELECT "amount_cents" INTO receipt_total
    FROM "receipts" WHERE "id" = target_receipt_id;
  SELECT COALESCE(SUM("amount_cents"), 0) INTO alloc_total
    FROM "receipt_allocations" WHERE "receipt_id" = target_receipt_id;

  IF alloc_total > receipt_total THEN
    RAISE EXCEPTION
      'receipt % over-allocated: alloc_total=% > receipts.amount_cents=%',
      target_receipt_id, alloc_total, receipt_total
      USING ERRCODE = 'check_violation';
  END IF;

  IF TG_OP = 'DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
END;
$$;
--> statement-breakpoint

CREATE TRIGGER "receipt_allocations_sum_check"
AFTER INSERT OR UPDATE OR DELETE ON "receipt_allocations"
FOR EACH ROW EXECUTE FUNCTION "receipt_allocations_validate_sum"();

-- Trigger 3: voided / nsf_returned receipts cannot be added to a
-- deposit (joining a bad receipt to a clean deposit would corrupt
-- the deposit's status semantics).

CREATE OR REPLACE FUNCTION "deposit_items_reject_bad_receipts"()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  receipt_status_v receipt_status;
BEGIN
  SELECT "status" INTO receipt_status_v
    FROM "receipts" WHERE "id" = NEW."receipt_id";
  IF receipt_status_v IN ('voided', 'nsf_returned') THEN
    RAISE EXCEPTION
      'cannot add receipt % to deposit: status is %',
      NEW."receipt_id", receipt_status_v
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint

CREATE TRIGGER "deposit_items_no_bad_receipts"
BEFORE INSERT OR UPDATE ON "deposit_items"
FOR EACH ROW EXECUTE FUNCTION "deposit_items_reject_bad_receipts"();

-- Trigger 4: same-organization integrity between deposits and
-- their items' receipts. Defends against a developer error /
-- malicious cross-org write.

CREATE OR REPLACE FUNCTION "deposit_items_same_org"()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  deposit_org_id uuid;
  receipt_org_id uuid;
BEGIN
  SELECT "organization_id" INTO deposit_org_id FROM "deposits" WHERE "id" = NEW."deposit_id";
  SELECT "organization_id" INTO receipt_org_id FROM "receipts" WHERE "id" = NEW."receipt_id";

  IF deposit_org_id IS NULL OR receipt_org_id IS NULL THEN
    RAISE EXCEPTION 'deposit_items: deposit or receipt not found'
      USING ERRCODE = 'check_violation';
  END IF;
  IF deposit_org_id <> receipt_org_id THEN
    RAISE EXCEPTION
      'deposit_items: cross-org reference (deposit org=%, receipt org=%)',
      deposit_org_id, receipt_org_id
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."organization_id" IS DISTINCT FROM deposit_org_id THEN
    RAISE EXCEPTION
      'deposit_items: organization_id (%) must match deposit/receipt org (%)',
      NEW."organization_id", deposit_org_id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint

CREATE TRIGGER "deposit_items_org_check"
BEFORE INSERT OR UPDATE ON "deposit_items"
FOR EACH ROW EXECUTE FUNCTION "deposit_items_same_org"();
