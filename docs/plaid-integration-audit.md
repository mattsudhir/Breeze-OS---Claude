# Plaid integration audit

**Status:** draft for review. No code shipped from this doc.
**Author:** Claude session 01K478PwgTKC56Bwgg7nxFWR
**Date:** 2026-05-16

This is a pre-production checklist for promoting the Plaid
integration from sandbox/development to production. It covers
security, error handling, operational readiness, and the Plaid
production application review.

## TL;DR — what's already solid

- ✅ **Access token at rest**: AES-256-GCM with a per-deploy key
  (`BREEZE_ENCRYPTION_KEY`). 32-byte hex, random IV per
  encryption, authenticated tag stops silent corruption.
  See `lib/encryption.js`.
- ✅ **Token never reaches the browser.** All Plaid API calls happen
  server-side; only the short-lived `link_token` is shipped to the
  client.
- ✅ **Re-link flow** exists and uses the same encrypted token store.
  When a bank flips to `plaid_status='re_auth_required'`, the UI
  can request an update-mode link token without losing the Item.
- ✅ **Per-account encryption** — each linked Item's access_token is
  stored only on the bank_account rows that came in via that link
  session. No global access_token, no shared secrets across orgs.
- ✅ **Webhook signature verification** is implemented
  (`lib/backends/plaid.js` `verifyPlaidWebhook`). JWT signed by
  Plaid's webhook key, validated against the kid's public key.
- ✅ **Incremental transaction sync** via `/transactions/sync` with a
  per-item cursor — efficient, no full-history re-pulls.
- ✅ **Auto-match** triggers on every newly inserted transaction so
  matched candidates surface in the recon queue without a separate
  cron.
- ✅ **`onConflictDoNothing`** on `bank_transactions` insert by
  `external_id` — repeated syncs are idempotent.

## Gaps to close before going production

### 1. Webhook signing key rotation handling

`verifyPlaidWebhook` caches the kid's public key. If Plaid rotates
the key mid-burst, cached older keys still verify until cache TTL.
Confirm the TTL is short enough (Plaid's recommendation: re-fetch
on cache miss + every 24h) and that we re-fetch on
`WEBHOOK_VERIFICATION_KEY_ROTATED` events.

**Action**: read through the cache logic in `lib/backends/plaid.js`
~lines 230-280, document expected behavior, add a probe that the
cache TTL matches Plaid's published guidance.

### 2. PLAID_ENV is the deploy-time switch

A single misconfigured env var sends production credentials to the
sandbox endpoint (or vice versa). Add a startup health check:

- If `PLAID_ENV=production`, assert that `PLAID_CLIENT_ID` and
  `PLAID_SECRET` look like production-format strings.
- On every Plaid API call, log the env used (to function logs only,
  not to clients).
- The smoke endpoint should surface `PLAID_ENV` in its checks
  output so the GitHub Actions `run-smoke` job catches accidental
  env drift across deploys.

**Action**: extend `/api/admin/smoke-test` with a `plaid_env` check.

### 3. Encryption key rotation runbook

The README notes "If you ever rotate the key, you need to re-encrypt
every row. Not a v1 concern, but plan for it." Production is when
that plan needs to exist.

**Action**: write `docs/runbooks/rotate-encryption-key.md` with:
- How to generate a new key
- How to add it alongside the old one (env var `BREEZE_ENCRYPTION_KEY_NEXT`)
- A re-encryption script that walks every `_encrypted` column,
  decrypts with old key, re-encrypts with new key
- Cutover: swap env vars
- Drop old key after re-encryption verification

This doesn't have to ship before production, but it has to exist
before the first time a key is suspected compromised.

### 4. Webhook idempotency

If Plaid retries a webhook (network drop, our 200 was slow), our
handler should be safe. `bank_transactions` `onConflictDoNothing`
handles the transaction-insert case. Other webhook types
(`ITEM_LOGIN_REQUIRED`, `WEBHOOK_UPDATE_ACKNOWLEDGED`, etc) should
be reviewed for repeat-safety.

**Action**: read `api/webhooks/plaid.js` end-to-end, list every
side-effect by webhook code, confirm each is idempotent or
explicitly tolerates duplicates.

### 5. Plaid error surfacing to the user

`plaid-link-token.js` surfaces `error_type` / `error_code` /
`display_message` to the client. Good for debugging, but
`display_message` is the only Plaid-blessed user-facing string.
The frontend should prefer it when present.

**Action**: in `SetupWizard.jsx` (where Plaid Link is mounted),
confirm that when the link token endpoint returns an error, we show
`display_message` and not the raw `error_message` or stack.

### 6. PII handling for sandbox-to-prod data

In sandbox/development, Plaid returns synthetic test data. In
production, real account holder names, real transaction
descriptions (which can include merchant + memo), real account
numbers (we only store the last 4 in `bank_accounts.account_last4`,
not the full number — good).

Audit fields stored:
- ✅ `account_last4` only, never full number
- ✅ `currentBalanceCents` — fine, that's the user's own data
- ✅ `bank_transactions.description` / `merchant_name` — same
- ⚠️ `bank_transactions.raw_payload` — JSONB of the full Plaid
  transaction. Contains the description and amount but NOT the
  full account number (Plaid doesn't return it post-Auth). Keep an
  eye on this; if Plaid ever adds new fields, they land here
  unredacted.

**Action**: document the `raw_payload` contract: "Plaid transaction
fields, AS-RECEIVED. We rely on Plaid not returning account
numbers; if that ever changes, redact at ingest." Add a unit-test
fixture that fails if `raw_payload` ever contains a 9+ digit
sequence resembling an account number.

### 7. Production application review (Plaid's side)

Plaid requires every production app to pass their review:
- Privacy policy URL — must be live, must mention Plaid by name
- Terms of service URL — same
- Use case description — "Property management ACH reconciliation
  and bank balance display for Breeze OS."
- Data minimization explanation — "We use `transactions` product
  only; we do not use `auth` (full account numbers), `identity`,
  `assets`, or `liabilities`."
- Production access request form in the Plaid dashboard

**Action**: complete `docs/legal/privacy-policy.md` + `terms-of-
service.md` (drafted separately), get them reviewed by counsel,
host them at a stable URL, then submit the production access form.

### 8. Test account documentation

For Plaid's review and our own sandbox testing, document:
- The sandbox Item IDs we use for repeated tests
- Username/password for the sandbox bank (`user_good` /
  `pass_good` for most institutions)
- A known-good transaction set we can replay

**Action**: `docs/runbooks/plaid-sandbox-testing.md` with the
above plus the curl recipe to provision a test Item.

## Smoke checks worth adding to `/api/admin/smoke-test`

- `plaid_env`: `PLAID_ENV` value + whether `PLAID_CLIENT_ID` + 
  `PLAID_SECRET` are present.
- `encryption_key`: `isEncryptionConfigured()` returns true, key is
  exactly 32 bytes.
- `webhook_route`: HEAD `/api/webhooks/plaid` returns 405 (POST
  only) — confirms the route is wired through Vercel and not
  catching the catch-all RM rewrite.
- `linked_bank_count`: SELECT COUNT(*) FROM bank_accounts WHERE
  plaid_status='linked'. Mostly informational; nonzero in
  production, zero in sandbox would be a flag.

## Pre-launch checklist (in order)

1. ☐ Add `plaid_env` + `encryption_key` + `webhook_route` checks
   to `/api/admin/smoke-test`. Confirm green via `/run-smoke`.
2. ☐ Privacy policy + ToS drafted, reviewed by counsel, hosted at
   a stable URL.
3. ☐ Webhook signing key cache verified against Plaid guidance.
4. ☐ Webhook handler audit (every code path idempotent).
5. ☐ `raw_payload` redaction contract documented, test fixture
   added.
6. ☐ Sandbox testing runbook published.
7. ☐ Encryption key rotation runbook published.
8. ☐ Plaid production access form submitted with the URLs and
   use-case description.
9. ☐ Plaid approves → flip `PLAID_ENV=production` + production
   `PLAID_SECRET` in Vercel.
10. ☐ Smoke check confirms `plaid_env: production`.
11. ☐ Link one real bank account in production. Verify it appears
    in the COA browser with the right GL classification.
12. ☐ Run `/api/admin/plaid-sync-transactions` once manually,
    confirm transactions land and auto-match candidates are
    generated.
13. ☐ Wire the nightly sync cron (if not already wired).

## Estimated time to production-ready

- Items 1-7: ~1 day of engineering + ~3-5 days waiting for legal
  review (parallel).
- Item 8: 5-14 days for Plaid's review SLA.
- Items 9-13: ~half a day for cutover + smoke.

**Realistic timeline: 2 weeks from "start the legal review" to
"first real-bank transactions auto-reconciling in production"**,
assuming counsel doesn't push major changes to the privacy policy.
