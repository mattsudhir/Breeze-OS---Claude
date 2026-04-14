-- PR 3.1: add 'none' to the account_holder enum
--
-- Adds a new enum value so property_utilities rows can explicitly
-- record "this utility doesn't exist at the property" rather than
-- leaving the row absent (which means "not yet configured").
--
-- Postgres's `ALTER TYPE ... ADD VALUE` cannot run inside a
-- transaction block, so we take the transaction-safe path: create
-- a new enum that includes the new value, swap the column over to
-- it, drop the old enum, rename the new one back.
--
-- Idempotent guard: check if 'none' is already present before
-- running the swap, so re-running this migration is a no-op.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_enum e
    JOIN pg_type t ON t.oid = e.enumtypid
    WHERE t.typname = 'account_holder'
      AND e.enumlabel = 'none'
  ) THEN
    CREATE TYPE "account_holder_new" AS ENUM ('owner_llc', 'tenant', 'none');

    ALTER TABLE "property_utilities"
      ALTER COLUMN "account_holder" TYPE "account_holder_new"
      USING ("account_holder"::text::"account_holder_new");

    DROP TYPE "account_holder";
    ALTER TYPE "account_holder_new" RENAME TO "account_holder";
  END IF;
END$$;
