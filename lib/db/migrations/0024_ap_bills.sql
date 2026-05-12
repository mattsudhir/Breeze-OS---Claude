-- Stage 5 AP — bills + payments.
--
-- Bills are vendor invoices we owe. They live in three states:
--   draft     editable, no GL impact
--   posted    immutable, debit-expense / credit-AP journal entry
--             written; balance_cents tracks what's still owed
--   voided    posted then reversed (with a reversing JE)
--
-- Bills can have multiple GL lines (one bill, multiple expense codes
-- or property attributions). bill_lines mirrors journal_lines'
-- multi-dim pattern — property_id, unit_id, entity_id.
--
-- bill_payments are "we paid the vendor." Many-to-many with bills
-- via bill_payment_allocations: one $5,000 wire can settle two
-- $2,500 bills, or one $7,500 bill across two checks.

CREATE TYPE "bill_status" AS ENUM ('draft', 'posted', 'voided');
CREATE TYPE "bill_payment_status" AS ENUM ('pending', 'cleared', 'voided');
CREATE TYPE "bill_payment_method" AS ENUM (
  'check',
  'ach',
  'wire',
  'credit_card',
  'bill_pay_provider',
  'cash',
  'other'
);

-- ── bills ───────────────────────────────────────────────────────

CREATE TABLE "bills" (
  "id"                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "organization_id"   uuid NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE,
  "vendor_id"         uuid NOT NULL REFERENCES "vendors"("id") ON DELETE RESTRICT,
  "bill_number"       text,             -- vendor-supplied invoice no.
  "bill_date"         date NOT NULL,
  "due_date"          date NOT NULL,
  "amount_cents"      bigint NOT NULL CHECK ("amount_cents" >= 0),
  "balance_cents"     bigint NOT NULL,
  "ap_gl_account_id"  uuid NOT NULL REFERENCES "gl_accounts"("id") ON DELETE RESTRICT,
  "status"            "bill_status" NOT NULL DEFAULT 'draft',
  "memo"              text,
  "journal_entry_id"  uuid REFERENCES "journal_entries"("id") ON DELETE SET NULL,
  "source_bill_id"    text,
  "source_pms"        text NOT NULL DEFAULT 'appfolio',
  "posted_at"         timestamp with time zone,
  "voided_at"         timestamp with time zone,
  "created_at"        timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at"        timestamp with time zone NOT NULL DEFAULT now()
);

CREATE INDEX "bills_org_idx"       ON "bills"("organization_id");
CREATE INDEX "bills_vendor_idx"    ON "bills"("vendor_id");
CREATE INDEX "bills_status_idx"    ON "bills"("organization_id", "status");
CREATE INDEX "bills_due_idx"       ON "bills"("organization_id", "due_date");
CREATE INDEX "bills_source_idx"    ON "bills"("source_bill_id");

-- ── bill_lines ──────────────────────────────────────────────────

CREATE TABLE "bill_lines" (
  "id"               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "organization_id"  uuid NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE,
  "bill_id"          uuid NOT NULL REFERENCES "bills"("id") ON DELETE CASCADE,
  "line_number"      integer NOT NULL,
  "gl_account_id"    uuid NOT NULL REFERENCES "gl_accounts"("id") ON DELETE RESTRICT,
  "amount_cents"     bigint NOT NULL CHECK ("amount_cents" > 0),
  "memo"             text,
  -- Multi-dim attribution; mirrors journal_lines.
  "property_id"      uuid REFERENCES "properties"("id") ON DELETE SET NULL,
  "unit_id"          uuid REFERENCES "units"("id") ON DELETE SET NULL,
  "entity_id"        uuid REFERENCES "entities"("id") ON DELETE SET NULL,
  "created_at"       timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "bill_lines_line_number_uniq" UNIQUE ("bill_id", "line_number")
);

CREATE INDEX "bill_lines_bill_idx"     ON "bill_lines"("bill_id");
CREATE INDEX "bill_lines_org_idx"      ON "bill_lines"("organization_id");
CREATE INDEX "bill_lines_property_idx" ON "bill_lines"("property_id");
CREATE INDEX "bill_lines_entity_idx"   ON "bill_lines"("entity_id");

-- ── bill_payments ───────────────────────────────────────────────

CREATE TABLE "bill_payments" (
  "id"                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "organization_id"     uuid NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE,
  "vendor_id"           uuid NOT NULL REFERENCES "vendors"("id") ON DELETE RESTRICT,
  "payment_date"        date NOT NULL,
  "amount_cents"        bigint NOT NULL CHECK ("amount_cents" > 0),
  "payment_method"      "bill_payment_method" NOT NULL,
  "bank_account_id"     uuid REFERENCES "bank_accounts"("id") ON DELETE SET NULL,
  "external_reference"  text,   -- check #, ACH trace, wire ref
  "journal_entry_id"    uuid NOT NULL REFERENCES "journal_entries"("id") ON DELETE RESTRICT,
  "status"              "bill_payment_status" NOT NULL DEFAULT 'cleared',
  "memo"                text,
  "created_at"          timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at"          timestamp with time zone NOT NULL DEFAULT now()
);

CREATE INDEX "bill_payments_org_idx"      ON "bill_payments"("organization_id");
CREATE INDEX "bill_payments_vendor_idx"   ON "bill_payments"("vendor_id");
CREATE INDEX "bill_payments_bank_idx"     ON "bill_payments"("bank_account_id");
CREATE INDEX "bill_payments_status_idx"   ON "bill_payments"("organization_id", "status");
CREATE INDEX "bill_payments_date_idx"     ON "bill_payments"("organization_id", "payment_date");
CREATE INDEX "bill_payments_ref_idx"      ON "bill_payments"("external_reference");

-- ── bill_payment_allocations ────────────────────────────────────

CREATE TABLE "bill_payment_allocations" (
  "id"                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "organization_id"   uuid NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE,
  "bill_payment_id"   uuid NOT NULL REFERENCES "bill_payments"("id") ON DELETE CASCADE,
  "bill_id"           uuid NOT NULL REFERENCES "bills"("id") ON DELETE RESTRICT,
  "amount_cents"      bigint NOT NULL CHECK ("amount_cents" > 0),
  "created_at"        timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "bill_payment_allocations_uniq" UNIQUE ("bill_payment_id", "bill_id")
);

CREATE INDEX "bpa_payment_idx" ON "bill_payment_allocations"("bill_payment_id");
CREATE INDEX "bpa_bill_idx"    ON "bill_payment_allocations"("bill_id");
