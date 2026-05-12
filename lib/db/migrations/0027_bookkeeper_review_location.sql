-- Bookkeeper review surface preference.
--
-- Three customer modes:
--   'breeze'   — bookkeeper reviews categorizations in Breeze OS.
--                Default. The strategic long-term home — Breeze becomes
--                the single source of truth for categorization decisions.
--   'bill_com' — bookkeeper reviews in Bill.com. Breeze writes the
--                GL coding back to Bill.com (status='Reviewed') and
--                stops touching the row. Bill.com's webhook back to us
--                reflects the bookkeeper's final approval.
--   'both'     — categorize in Breeze, also sync to Bill.com. Useful
--                for the transition period when bookkeepers are not
--                yet on board with moving entirely off Bill.com.
--
-- This only matters for orgs with a Bill.com connection. Customers
-- on the standalone Breeze tier (Plaid only, no Bill.com) get the
-- 'breeze' behavior regardless.

ALTER TABLE "organizations"
  ADD COLUMN "bookkeeper_review_location" text NOT NULL DEFAULT 'breeze';

ALTER TABLE "organizations"
  ADD CONSTRAINT "organizations_bookkeeper_review_location_check"
    CHECK ("bookkeeper_review_location" IN ('breeze', 'bill_com', 'both'));
