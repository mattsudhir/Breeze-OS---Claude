-- Corporate accounting Day 1: legal entities.
--
-- A landlord rarely owns property in their personal name — they own
-- it through LLCs (often one per property, or one per portfolio of
-- properties). The platform needs to produce per-entity P&L,
-- per-entity tax statements (K-1s eventually), and a consolidated
-- view across all entities under the org. The schema model:
--
--   organizations  (1)
--      └── entities          (M)    LLC, partnership, sole prop, trust
--             └── properties (M)    each property belongs to one entity
--
-- Implementation: add an `entities` table; add `entity_id` as a
-- nullable dimension on `properties` and `journal_lines` so the
-- multi-dimensional tagging pattern that already powers
-- property/unit/tenant/vendor attribution extends to entity. Per-
-- entity reports = filter by entity_id; consolidated = aggregate
-- across entity_id, eliminate intercompany (later).
--
-- Why nullable: existing rows have no entity assigned. The admin UI
-- will let staff backfill entity_id on each property; journal_lines
-- created after the assignment get the entity_id at posting time
-- via the property → entity lookup or explicit override.
--
-- Tax id is encrypted with the same AES-256-GCM scheme as
-- owners.ein_encrypted and bank_accounts.routing_number_encrypted
-- (lib/encryption.js, "iv:tag:ciphertext" hex format). Last 4 are
-- unencrypted for display.

CREATE TYPE "entity_type" AS ENUM (
  'llc',
  'corp',
  'partnership',
  'sole_prop',
  'trust',
  'individual'
);

CREATE TABLE "entities" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "organization_id" uuid NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE,
  "name" text NOT NULL,
  "legal_name" text,
  "entity_type" "entity_type" NOT NULL,
  "tax_id_encrypted" text,
  "tax_id_last4" text,
  "formation_state" text,
  "formation_date" date,
  "fiscal_year_end_month" integer NOT NULL DEFAULT 12
    CHECK ("fiscal_year_end_month" BETWEEN 1 AND 12),
  "is_active" boolean NOT NULL DEFAULT true,
  "notes" text,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now()
);

CREATE INDEX "entities_org_idx" ON "entities"("organization_id");
-- Soft uniqueness on display name per-org. Two entities with the
-- same display_name under one org is almost always a typo / duplicate
-- creation. Different legal_name is allowed (lots of LLCs have
-- similar legal names).
CREATE UNIQUE INDEX "entities_org_name_uniq"
  ON "entities"("organization_id", lower("name"))
  WHERE "is_active" = true;

-- Add entity_id dimension to properties. Nullable because existing
-- properties haven't been assigned to entities yet — backfill via UI.
ALTER TABLE "properties"
  ADD COLUMN "entity_id" uuid REFERENCES "entities"("id") ON DELETE SET NULL;
CREATE INDEX "properties_entity_idx" ON "properties"("entity_id");

-- Add entity_id dimension to journal_lines, matching the existing
-- multi-dim pattern (property_id, unit_id, owner_id, tenant_id,
-- vendor_id). Per-entity P&L = filter on this column.
ALTER TABLE "journal_lines"
  ADD COLUMN "entity_id" uuid REFERENCES "entities"("id") ON DELETE SET NULL;
CREATE INDEX "journal_lines_org_entity_idx"
  ON "journal_lines"("organization_id", "entity_id");
