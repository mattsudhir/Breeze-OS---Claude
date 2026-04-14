-- PR 8: wipe speculative provider scaffold data, allow nullable phone
--
-- Context: when I first seeded utility_providers (PR 2 and again in
-- PR 7), I populated phone numbers, business hours, expected hold
-- times, IVR script notes, and required_fields from plausible-looking
-- speculation rather than verified research. That's dangerous — a
-- wrong phone number or an invented IVR path can cause real Vapi
-- calls to land on the wrong business, fail mid-call, or damage the
-- caller's reputation.
--
-- This migration:
--   1. Drops the NOT NULL constraint on phone_number so providers can
--      exist in the DB without a verified number. Workers already
--      escalate to needs_human when phone is missing, so null values
--      are handled gracefully downstream.
--   2. Wipes speculative fields on the 9 seeded Ohio utility providers,
--      replacing callScriptNotes with a single honest line:
--      "Agent should be prepared to present owner name, mailing
--       address, EIN, and start date for service."
--
-- Matching by name is safe because these are the exact names the
-- seed endpoint inserts. User-added providers with real data are
-- untouched.
--
-- Idempotent: running this a second time is a no-op (phone_number
-- already null, other fields already the wiped values).

-- ── 1. Allow nullable phone_number ───────────────────────────────

ALTER TABLE "utility_providers"
  ALTER COLUMN "phone_number" DROP NOT NULL;

-- ── 2. Wipe speculative scaffold data on seeded providers ────────

UPDATE "utility_providers"
SET "phone_number"          = NULL,
    "business_hours"        = NULL,
    "expected_hold_minutes" = NULL,
    "call_script_notes"     = 'Agent should be prepared to present owner name, mailing address, EIN, and start date for service.',
    "required_fields"       = NULL,
    "updated_at"            = now()
WHERE "name" IN (
  'Toledo Edison',
  'Columbia Gas of Ohio',
  'Toledo Public Utilities',
  'AEP Ohio',
  'Enbridge',
  'City of Lima',
  'Ohio Edison',
  'Youngstown Water Department',
  'Republic Services'
);
