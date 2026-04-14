-- PR 6: add billback_mode enum to property_utilities
--
-- Replaces the coarse boolean billback_tenant with a richer enum that
-- can distinguish "full billback" (one tenant gets the whole bill)
-- from "split meter billback" (a shared meter's bill is split across
-- multiple units, typical of duplexes where only one water account
-- exists for two rental units).
--
-- billback_tenant stays as a shadow column for backward compatibility
-- with existing code paths. New code should read billback_mode; reads
-- of billback_tenant remain correct because every write syncs both
-- columns. A future PR can drop billback_tenant once all readers have
-- been migrated.
--
-- Value mapping:
--
--   billback_mode = 'none'         → billback_tenant = false
--   billback_mode = 'full'         → billback_tenant = true
--   billback_mode = 'split_meter'  → billback_tenant = true
--
-- Future enum extensions (not added yet):
--   'split_by_sqft'  — proportional to unit square footage
--   'split_by_occupancy' — proportional to number of occupants
--   'custom'         — manually entered amounts per unit
--
-- Everything IF [NOT] EXISTS-guarded so re-running is safe.

-- ── 1. Create the enum type ──────────────────────────────────────

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'billback_mode') THEN
    CREATE TYPE "billback_mode" AS ENUM ('none', 'full', 'split_meter');
  END IF;
END$$;

-- ── 2. Add the column with a safe default ────────────────────────

ALTER TABLE "property_utilities"
  ADD COLUMN IF NOT EXISTS "billback_mode" "billback_mode" NOT NULL DEFAULT 'none';

-- ── 3. Backfill from existing billback_tenant values ─────────────
--
-- Any row that currently has billback_tenant=true becomes 'full'.
-- Rows with billback_tenant=false stay at the default 'none'. After
-- this migration, reads of billback_mode reflect the same semantics
-- as the boolean.

UPDATE "property_utilities"
SET "billback_mode" = 'full'
WHERE "billback_tenant" = true
  AND "billback_mode" = 'none';

-- ── 4. Index for future billback-accounting queries ──────────────
--
-- Helps filter "which property_utilities rows need tenant ledger
-- charges this month" without a full scan. Cheap partial index,
-- only covers the interesting rows (billback happening).

CREATE INDEX IF NOT EXISTS "property_utilities_billback_mode_idx"
  ON "property_utilities" ("billback_mode")
  WHERE "billback_mode" != 'none';
