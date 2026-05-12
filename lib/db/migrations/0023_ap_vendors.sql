-- Stage 5 AP — vendors table (first slice; bills + payments follow
-- in 0024 / 0025).
--
-- A vendor is anyone we pay: plumber, lawn-care, utility company,
-- city tax authority, insurance carrier. Vendors carry default GL
-- routing so a bill from "Toledo Edison" auto-codes to a utilities
-- expense unless overridden.
--
-- Tax-id columns mirror entities and owners: encrypted via
-- lib/encryption.js, with last-4 unencrypted for display + 1099
-- reporting.

CREATE TYPE "vendor_type" AS ENUM (
  'individual',     -- 1099-eligible sole prop / contractor
  'business',       -- LLC / corp / partnership
  'government',     -- city / county / state taxing authority
  'utility',        -- power, gas, water, internet
  'insurance',
  'other'
);

CREATE TABLE "vendors" (
  "id"                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "organization_id"       uuid NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE,
  "display_name"          text NOT NULL,
  "legal_name"            text,
  "vendor_type"           "vendor_type" NOT NULL DEFAULT 'business',
  -- Contact
  "contact_email"         text,
  "contact_phone"         text,
  "remit_address_line1"   text,
  "remit_address_line2"   text,
  "remit_city"            text,
  "remit_state"           text,
  "remit_zip"             text,
  -- Tax / 1099 reporting
  "tax_id_encrypted"      text,    -- EIN or SSN
  "tax_id_last4"          text,
  "is_1099_eligible"      boolean NOT NULL DEFAULT false,
  -- Bookkeeping defaults
  "payment_terms_days"    integer NOT NULL DEFAULT 30,
  "default_gl_account_id" uuid REFERENCES "gl_accounts"("id") ON DELETE SET NULL,
  -- Source breadcrumb (AppFolio migration)
  "source_vendor_id"      text,
  "source_pms"            text NOT NULL DEFAULT 'appfolio',
  "is_active"             boolean NOT NULL DEFAULT true,
  "notes"                 text,
  "created_at"            timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at"            timestamp with time zone NOT NULL DEFAULT now()
);

CREATE INDEX "vendors_org_idx"            ON "vendors"("organization_id");
CREATE INDEX "vendors_org_active_idx"     ON "vendors"("organization_id", "is_active");
CREATE INDEX "vendors_source_idx"         ON "vendors"("source_vendor_id");
CREATE INDEX "vendors_display_name_idx"   ON "vendors"("display_name");
-- Soft uniqueness on active display name per-org.
CREATE UNIQUE INDEX "vendors_org_name_uniq"
  ON "vendors"("organization_id", lower("display_name"))
  WHERE "is_active" = true;
