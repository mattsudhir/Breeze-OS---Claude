-- Stage 3 of the accounting platform — banking + Plaid scaffold +
-- match-candidate queue.
--
-- Adds the real-world banking layer on top of the GL core (0006)
-- and AR module (0007). Closes the loop on the 35 "parked" GL
-- accounts the AppFolio importer flagged as bank accounts / credit
-- cards: a follow-up bulk-convert service creates a bank_account
-- row per parked GL with the proper 1:1 link.
--
-- Tables added:
--   bank_accounts          1:1 with a gl_account; Plaid integration
--                          columns; trust-accounting reserved.
--   bank_transactions      immutable raw feed from Plaid (or manual
--                          import).
--   match_candidates       fuzzy-recon queue between bank_transactions
--                          and journal_entries.
--   match_rules            learnable rules powering auto-match.
--
-- Migrations on existing tables:
--   - ALTER deposits.bank_account_id  → ADD FK to bank_accounts.id
--                                       (Stage 2 left this as uuid
--                                        without constraint).
--   - Trigger: when bank_accounts is INSERTed / UPDATEd with a new
--             gl_account_id, set the corresponding gl_account.is_bank
--             = true. When DELETEd, set the orphaned gl_account.is_bank
--             = false.

-- ── Enums ────────────────────────────────────────────────────────

CREATE TYPE "bank_account_type" AS ENUM (
  'checking', 'savings', 'money_market', 'credit_card', 'investment'
);
CREATE TYPE "plaid_link_status" AS ENUM (
  'unlinked', 'linked', 're_auth_required', 'disconnected'
);
CREATE TYPE "match_candidate_status" AS ENUM (
  'auto_matched', 'pending_review', 'confirmed', 'rejected'
);

-- ── bank_accounts ────────────────────────────────────────────────

CREATE TABLE "bank_accounts" (
  "id"                         uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organization_id"            uuid NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE,
  "gl_account_id"              uuid NOT NULL REFERENCES "gl_accounts"("id") ON DELETE RESTRICT,
  "display_name"               text NOT NULL,
  "institution_name"           text,
  "account_type"               "bank_account_type" NOT NULL,
  "routing_number_encrypted"   text,
  "account_number_encrypted"   text,
  "account_last4"              text,
  "current_balance_cents"      bigint,
  "balance_as_of"              timestamp with time zone,
  "plaid_item_id"              text,
  "plaid_account_id"           text,
  "plaid_cursor"               text,
  "plaid_status"               "plaid_link_status" NOT NULL DEFAULT 'unlinked',
  "is_trust"                   boolean NOT NULL DEFAULT false,
  "trust_purpose"              text,
  "notes"                      text,
  "created_at"                 timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at"                 timestamp with time zone NOT NULL DEFAULT now()
);

-- 1:1 with gl_accounts.
CREATE UNIQUE INDEX "bank_accounts_gl_account_uniq" ON "bank_accounts" ("gl_account_id");
CREATE INDEX "bank_accounts_org_idx"           ON "bank_accounts" ("organization_id");
CREATE INDEX "bank_accounts_plaid_item_idx"    ON "bank_accounts" ("plaid_item_id");
CREATE INDEX "bank_accounts_plaid_account_idx" ON "bank_accounts" ("plaid_account_id");

-- ── bank_transactions ────────────────────────────────────────────

CREATE TABLE "bank_transactions" (
  "id"                uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organization_id"   uuid NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE,
  "bank_account_id"   uuid NOT NULL REFERENCES "bank_accounts"("id") ON DELETE CASCADE,
  "external_id"       text NOT NULL,
  "posted_date"       date NOT NULL,
  "amount_cents"      bigint NOT NULL,
  "description"       text,
  "merchant_name"     text,
  "pending"           boolean NOT NULL DEFAULT false,
  "raw_payload"       jsonb,
  "notes"             text,
  "created_at"        timestamp with time zone NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX "bank_transactions_external_uniq"
  ON "bank_transactions" ("bank_account_id", "external_id");
CREATE INDEX "bank_transactions_org_posted_idx"
  ON "bank_transactions" ("organization_id", "posted_date");
CREATE INDEX "bank_transactions_pending_idx"
  ON "bank_transactions" ("bank_account_id", "pending");

-- ── match_candidates ─────────────────────────────────────────────

CREATE TABLE "match_candidates" (
  "id"                      uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organization_id"         uuid NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE,
  "bank_transaction_id"     uuid NOT NULL REFERENCES "bank_transactions"("id") ON DELETE CASCADE,
  "journal_entry_id"        uuid REFERENCES "journal_entries"("id") ON DELETE SET NULL,
  "confidence_score"        real,
  "match_reason_codes"      text[],
  "status"                  "match_candidate_status" NOT NULL DEFAULT 'pending_review',
  "confirmed_by_user_id"    uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "confirmed_at"            timestamp with time zone,
  "notes"                   text,
  "created_at"              timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "match_candidates_score_range"
    CHECK ("confidence_score" IS NULL OR ("confidence_score" >= 0 AND "confidence_score" <= 1))
);

CREATE INDEX "match_candidates_org_status_idx"
  ON "match_candidates" ("organization_id", "status");
CREATE INDEX "match_candidates_bank_txn_idx"
  ON "match_candidates" ("bank_transaction_id");
CREATE INDEX "match_candidates_je_idx"
  ON "match_candidates" ("journal_entry_id");

-- Only one confirmed match per bank transaction. Partial unique
-- index — Postgres-only feature, perfect for this constraint.
CREATE UNIQUE INDEX "match_candidates_one_confirmed_per_txn"
  ON "match_candidates" ("bank_transaction_id")
  WHERE "status" = 'confirmed';

-- ── match_rules ──────────────────────────────────────────────────

CREATE TABLE "match_rules" (
  "id"                  uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organization_id"     uuid NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE,
  "name"                text NOT NULL,
  "pattern_type"        text NOT NULL,
  "pattern_payload"     jsonb NOT NULL,
  "target"              jsonb NOT NULL,
  "confidence_score"    real NOT NULL,
  "times_used"          integer NOT NULL DEFAULT 0,
  "times_rejected"      integer NOT NULL DEFAULT 0,
  "is_active"           boolean NOT NULL DEFAULT true,
  "notes"               text,
  "created_at"          timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at"          timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "match_rules_confidence_range"
    CHECK ("confidence_score" >= 0 AND "confidence_score" <= 1)
);

CREATE INDEX "match_rules_org_active_idx"
  ON "match_rules" ("organization_id", "is_active");

-- ── Retroactive FK on deposits.bank_account_id ───────────────────

ALTER TABLE "deposits"
  ADD CONSTRAINT "deposits_bank_account_id_fk"
  FOREIGN KEY ("bank_account_id") REFERENCES "bank_accounts"("id") ON DELETE SET NULL;

-- ── Trigger: maintain gl_accounts.is_bank flag ───────────────────

CREATE OR REPLACE FUNCTION "bank_accounts_maintain_is_bank_flag"()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    UPDATE "gl_accounts" SET "is_bank" = true, "updated_at" = now()
     WHERE "id" = NEW."gl_account_id";
    RETURN NEW;
  ELSIF TG_OP = 'UPDATE' THEN
    -- If the gl_account_id changed, flip the old one to false (if
    -- no other bank_account references it) and the new one to true.
    IF NEW."gl_account_id" <> OLD."gl_account_id" THEN
      IF NOT EXISTS (
        SELECT 1 FROM "bank_accounts"
         WHERE "gl_account_id" = OLD."gl_account_id"
           AND "id" <> NEW."id"
      ) THEN
        UPDATE "gl_accounts" SET "is_bank" = false, "updated_at" = now()
         WHERE "id" = OLD."gl_account_id";
      END IF;
      UPDATE "gl_accounts" SET "is_bank" = true, "updated_at" = now()
       WHERE "id" = NEW."gl_account_id";
    END IF;
    RETURN NEW;
  ELSIF TG_OP = 'DELETE' THEN
    IF NOT EXISTS (
      SELECT 1 FROM "bank_accounts"
       WHERE "gl_account_id" = OLD."gl_account_id"
         AND "id" <> OLD."id"
    ) THEN
      UPDATE "gl_accounts" SET "is_bank" = false, "updated_at" = now()
       WHERE "id" = OLD."gl_account_id";
    END IF;
    RETURN OLD;
  END IF;
END;
$$;
--> statement-breakpoint

CREATE TRIGGER "bank_accounts_is_bank_flag_sync"
AFTER INSERT OR UPDATE OR DELETE ON "bank_accounts"
FOR EACH ROW EXECUTE FUNCTION "bank_accounts_maintain_is_bank_flag"();
