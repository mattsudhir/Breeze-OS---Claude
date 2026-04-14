-- PR 5: PMS abstraction + unit-level external IDs + uniqueness guarantees
--
-- Three concerns in one migration:
--
-- 1. PMS-neutral column names. The original columns were named rm_*
--    on the assumption that Rent Manager was the source of truth, but
--    the bulk-imported property+unit data actually comes from Appfolio.
--    Rename to source_* so the column names aren't lying.
--
-- 2. Source-PMS tracking. Add source_pms text columns to rows that
--    carry external IDs, so future multi-PMS support knows which
--    system owns each row. All existing data is from Appfolio, so
--    default to 'appfolio'.
--
-- 3. Stable Appfolio Unit ID. Add source_unit_id to units so we can
--    join back to Appfolio on a stable external key instead of the
--    brittle (property_id, unit_name) composite.
--
-- Plus: uniqueness guarantees on property_utilities so the Grid Import
-- upsert path is duplicate-safe at the DB level regardless of bugs
-- anywhere in the app code.
--
-- Everything IF [NOT] EXISTS guarded so re-running is safe.

-- ── 1. Column renames (metadata-only, no data movement) ──────────

ALTER TABLE "properties"   RENAME COLUMN "rm_property_id" TO "source_property_id";
ALTER TABLE "units"        RENAME COLUMN "rm_unit_name"   TO "source_unit_name";
ALTER TABLE "move_events"  RENAME COLUMN "rm_tenant_id"   TO "source_tenant_id";

-- Rename the index that referenced the old column name. Partial unique
-- indexes can't be altered to rename the target column cleanly, so
-- drop + recreate.
DROP INDEX IF EXISTS "properties_rm_idx";
CREATE INDEX IF NOT EXISTS "properties_source_idx" ON "properties" ("source_property_id");

DROP INDEX IF EXISTS "move_events_rm_tenant_idx";
CREATE INDEX IF NOT EXISTS "move_events_source_tenant_idx"
  ON "move_events" ("source_tenant_id");

DROP INDEX IF EXISTS "properties_org_rm_unique";
CREATE UNIQUE INDEX IF NOT EXISTS "properties_org_source_unique"
  ON "properties" ("organization_id", "source_property_id")
  WHERE "source_property_id" IS NOT NULL;

-- ── 2. source_pms tracking column ────────────────────────────────

ALTER TABLE "properties"
  ADD COLUMN IF NOT EXISTS "source_pms" text NOT NULL DEFAULT 'appfolio';
ALTER TABLE "units"
  ADD COLUMN IF NOT EXISTS "source_pms" text NOT NULL DEFAULT 'appfolio';
ALTER TABLE "move_events"
  ADD COLUMN IF NOT EXISTS "source_pms" text NOT NULL DEFAULT 'appfolio';

-- ── 3. source_unit_id (stable Appfolio Unit ID) ──────────────────

ALTER TABLE "units"
  ADD COLUMN IF NOT EXISTS "source_unit_id" text;

-- Unique per-org-per-PMS so each external ID maps to exactly one unit
-- in our DB. Partial so pre-backfill NULLs don't participate.
CREATE UNIQUE INDEX IF NOT EXISTS "units_org_source_unit_unique"
  ON "units" ("organization_id", "source_unit_id")
  WHERE "source_unit_id" IS NOT NULL;

-- ── 4. property_utilities uniqueness (tonight's Grid Import safety) ──

-- If any duplicate property-level rows already exist (from a buggy
-- manual path), keep the most recently updated one and delete the
-- rest so the unique index creation below can proceed.
WITH duplicates AS (
  SELECT id,
         ROW_NUMBER() OVER (
           PARTITION BY property_id, utility_type
           ORDER BY updated_at DESC, created_at DESC, id
         ) AS rn
  FROM "property_utilities"
  WHERE unit_id IS NULL
)
DELETE FROM "property_utilities"
WHERE id IN (SELECT id FROM duplicates WHERE rn > 1);

WITH duplicates AS (
  SELECT id,
         ROW_NUMBER() OVER (
           PARTITION BY property_id, unit_id, utility_type
           ORDER BY updated_at DESC, created_at DESC, id
         ) AS rn
  FROM "property_utilities"
  WHERE unit_id IS NOT NULL
)
DELETE FROM "property_utilities"
WHERE id IN (SELECT id FROM duplicates WHERE rn > 1);

CREATE UNIQUE INDEX IF NOT EXISTS "property_utilities_prop_type_unique"
  ON "property_utilities" ("property_id", "utility_type")
  WHERE "unit_id" IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS "property_utilities_prop_unit_type_unique"
  ON "property_utilities" ("property_id", "unit_id", "utility_type")
  WHERE "unit_id" IS NOT NULL;
