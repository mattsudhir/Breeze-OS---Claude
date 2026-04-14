-- PR 2.5: units table + unit_id on property_utilities + upsert index
--
-- Adds per-unit granularity to the property directory so multi-family
-- buildings can track individual units (and, eventually, per-unit
-- utility accounts). Also introduces the unique index the bulk
-- importer needs for ON CONFLICT upsert.
--
-- Safe to run on a populated DB: CREATE TABLE is a no-op if already
-- present and ALTER TABLE ADD COLUMN IF NOT EXISTS is idempotent.

CREATE TABLE IF NOT EXISTS "units" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "organization_id" uuid NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE,
  "property_id" uuid NOT NULL REFERENCES "properties"("id") ON DELETE CASCADE,
  "rm_unit_name" text,
  "sqft" integer,
  "bedrooms" integer,
  "bathrooms" text,
  "notes" text,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "units_property_idx" ON "units" ("property_id");
CREATE INDEX IF NOT EXISTS "units_org_idx" ON "units" ("organization_id");

ALTER TABLE "property_utilities"
  ADD COLUMN IF NOT EXISTS "unit_id" uuid REFERENCES "units"("id") ON DELETE CASCADE;
CREATE INDEX IF NOT EXISTS "property_utilities_unit_idx" ON "property_utilities" ("unit_id");

-- The bulk importer upserts properties keyed on (organization_id, rm_property_id).
-- Without a unique constraint, ON CONFLICT can't match and the insert errors.
-- Partial index (WHERE rm_property_id IS NOT NULL) so manually-created
-- properties without an RM ID can still exist without fighting the constraint.
CREATE UNIQUE INDEX IF NOT EXISTS "properties_org_rm_unique"
  ON "properties" ("organization_id", "rm_property_id")
  WHERE "rm_property_id" IS NOT NULL;
