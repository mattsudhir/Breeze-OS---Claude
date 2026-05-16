-- 0033: relax journal_lines immutability trigger.
--
-- The original trigger (added in 0013) blocked any INSERT/UPDATE/DELETE
-- on journal_lines whose parent journal_entry is posted or reversed.
-- That's too strict: when the directory layer (units, properties,
-- leases, tenants, owners) is wiped and re-imported, Postgres needs
-- to SET NULL the FK back-references on journal_lines. Nulling
-- unit_id / property_id / lease_id / tenant_id / owner_id /
-- vendor_id / beneficiary_id / beneficiary_type does NOT change the
-- financial content of the line — it just disconnects metadata.
-- Blocking those updates breaks the clean-slate re-import path.
--
-- This migration replaces the trigger function with one that:
--   * still blocks INSERT and DELETE on posted/reversed entries
--   * for UPDATE, blocks only when a *financial* column changes:
--     organization_id, journal_entry_id, gl_account_id,
--     debit_cents, credit_cents, line_number, memo, created_at
--   * allows UPDATE-only-of-back-references to pass (FK SET NULL
--     during a wipe, plus any future re-attribution flows).
--
-- The trigger name and table stay the same; only the function body
-- changes. The existing trigger is rebound automatically because
-- CREATE OR REPLACE updates the same function the trigger calls.

CREATE OR REPLACE FUNCTION "journal_line_reject_if_parent_finalized"()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  target_entry_id uuid;
  parent_status   journal_entry_status;
BEGIN
  IF TG_OP = 'DELETE' THEN
    target_entry_id := OLD."journal_entry_id";
  ELSE
    target_entry_id := NEW."journal_entry_id";
  END IF;

  SELECT "status" INTO parent_status
    FROM "journal_entries"
   WHERE "id" = target_entry_id;

  -- If the parent isn't finalized, nothing to enforce.
  IF parent_status NOT IN ('posted', 'reversed') THEN
    IF TG_OP = 'DELETE' THEN
      RETURN OLD;
    ELSE
      RETURN NEW;
    END IF;
  END IF;

  -- Parent is posted/reversed. INSERT and DELETE are still rejected —
  -- you cannot add or remove lines on a finalized entry.
  IF TG_OP = 'INSERT' OR TG_OP = 'DELETE' THEN
    RAISE EXCEPTION
      'cannot % journal_line: parent entry % is %',
      TG_OP, target_entry_id, parent_status
      USING ERRCODE = 'check_violation';
  END IF;

  -- UPDATE on a finalized entry: allow only if NO financial column
  -- changed. Back-reference columns (unit_id, property_id, lease_id,
  -- tenant_id, owner_id, vendor_id, beneficiary_*, updated_at) can
  -- change freely — they describe the line's attribution, not its
  -- ledger impact.
  IF
    NEW."organization_id"   IS DISTINCT FROM OLD."organization_id" OR
    NEW."journal_entry_id"  IS DISTINCT FROM OLD."journal_entry_id" OR
    NEW."gl_account_id"     IS DISTINCT FROM OLD."gl_account_id" OR
    NEW."debit_cents"       IS DISTINCT FROM OLD."debit_cents" OR
    NEW."credit_cents"      IS DISTINCT FROM OLD."credit_cents" OR
    NEW."line_number"       IS DISTINCT FROM OLD."line_number" OR
    NEW."memo"              IS DISTINCT FROM OLD."memo" OR
    NEW."created_at"        IS DISTINCT FROM OLD."created_at"
  THEN
    RAISE EXCEPTION
      'cannot UPDATE financial fields on journal_line: parent entry % is %',
      target_entry_id, parent_status
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$;
