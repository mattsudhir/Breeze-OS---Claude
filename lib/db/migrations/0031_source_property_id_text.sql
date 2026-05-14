-- source_property_id was typed integer — a leftover from RentManager,
-- which used integer property IDs. AppFolio (and most other PMSs) use
-- UUID or otherwise non-integer external IDs. A "source system's ID"
-- should never have assumed integer; widen it to text.
--
-- USING ::text preserves every existing value (the old RentManager
-- integers just become their string form). Postgres rebuilds the
-- dependent indexes (properties_source_idx + the partial unique
-- org/source index) automatically as part of the type change.

ALTER TABLE "properties"
  ALTER COLUMN "source_property_id" TYPE text
  USING "source_property_id"::text;
