-- 0038: units.non_revenue — Breeze-native "exclude from occupancy"
-- flag. AppFolio has its own NonRevenue field (per-unit) that we
-- partially honour at import time, but the property manager has
-- additional units they don't count toward occupancy that AppFolio
-- doesn't flag (specific addresses they've discontinued, common
-- areas with naming that doesn't match AppFolio's signal, etc.).
--
-- This column is the Breeze source of truth for "is this unit
-- countable in occupancy_pct?". Defaults to false (counted). The
-- migration ALSO backfills the known set so chat_metrics gets the
-- right denominator immediately on deploy:
--
--   1. Units whose property display_name matches the user's
--      maintained exclusion list ("631 Bryce", "510 Ohio",
--      "1413 7th Avenue", with "Seventh" alias).
--   2. Units whose source_unit_name contains "common" (case-ins)
--      — common areas like Common Laundry, Common Storage, etc.
--   3. Units whose AppFolio mirror row flags NonRevenue=true
--      (defence-in-depth; today there's no overlap because
--      NonRevenue units aren't imported, but future-proofs).
--
-- Editable per-unit via the units admin surface. See ADR 0006's
-- v1.1 follow-up on "user-defined custom metrics" for the broader
-- direction of letting users own these flags.

ALTER TABLE "units"
  ADD COLUMN IF NOT EXISTS "non_revenue" boolean NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS "units_non_revenue_idx"
  ON "units" ("organization_id", "non_revenue");

-- Backfill 1: named property exclusions.
UPDATE "units" u
SET "non_revenue" = true
FROM "properties" p
WHERE u."property_id" = p."id"
  AND (
       LOWER(p."display_name") LIKE '%631 bryce%'
    OR LOWER(p."display_name") LIKE '%510 ohio%'
    OR LOWER(p."display_name") LIKE '%1413 7th avenue%'
    OR LOWER(p."display_name") LIKE '%1413 seventh avenue%'
  );

-- Backfill 2: "common" in unit name (common laundry, common area, etc.)
UPDATE "units"
SET "non_revenue" = true
WHERE LOWER(COALESCE("source_unit_name", '')) LIKE '%common%';

-- Backfill 3: AppFolio mirror NonRevenue flag (defence-in-depth;
-- no overlap today but future-proofs against a reimport that
-- pulls NonRevenue units in).
UPDATE "units" u
SET "non_revenue" = true
FROM "appfolio_cache" ac
WHERE ac."organization_id" = u."organization_id"
  AND ac."resource_type" = 'unit'
  AND ac."resource_id" = u."source_unit_id"
  AND (ac."data"->>'non_revenue')::boolean = true;
