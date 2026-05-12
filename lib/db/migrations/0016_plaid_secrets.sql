-- Stage 3 follow-up: encrypted Plaid access-token column on
-- bank_accounts.
--
-- The Plaid access_token is the credential that lets us pull
-- transactions, balances, and identity for a linked bank. It
-- needs to be stored encrypted at rest. We use AES-256-GCM via
-- lib/encryption.js (BREEZE_ENCRYPTION_KEY env var).
--
-- The column value format is "iv:tag:ciphertext" hex strings;
-- application code in lib/encryption.js handles wrapping/
-- unwrapping. The schema column is plain text — Postgres doesn't
-- need to interpret it.

ALTER TABLE "bank_accounts"
  ADD COLUMN "plaid_access_token_encrypted" text;
