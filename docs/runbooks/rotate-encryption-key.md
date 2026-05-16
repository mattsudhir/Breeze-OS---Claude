# Runbook: rotate `BREEZE_ENCRYPTION_KEY`

**Status:** drafted, not yet exercised in production.
**When to run:** annual hygiene rotation, OR immediately if you
suspect the current key is compromised (laptop loss, contractor
offboarding, an accidental git commit, a leaked env-var dump).

## What this key protects

`BREEZE_ENCRYPTION_KEY` is the AES-256-GCM symmetric key used by
`lib/encryption.js` to encrypt secrets at rest in Postgres.
Today it protects:

| Table          | Column                            | What's inside                |
|----------------|-----------------------------------|------------------------------|
| `bank_accounts`| `plaid_access_token_encrypted`    | Plaid Item access token       |

If new `_encrypted` columns are added later (Bill.com tokens, AppFolio
OAuth refresh tokens, etc.), update this runbook so a rotation
re-encrypts those too.

If the key is lost, every encrypted value is unrecoverable. We
would have to re-link every Plaid Item (and any other linked
service) from scratch.

## Pre-flight (~5 min)

1. ☐ Schedule a low-traffic window. Active transaction syncs
   running during rotation will fail for the few seconds the cutover
   takes; pick a time when no cron will fire mid-rotation.
2. ☐ Confirm `/api/admin/smoke-test` is green (`/run-smoke` from the
   ops console). The `encryption_key` check should report
   `configured: true` and `key_length_bytes: 32`.
3. ☐ Take a fresh database backup. Vercel Postgres / Neon: use the
   provider's point-in-time / snapshot feature.
4. ☐ Sanity: run `/run-diag GET /api/admin/recent-errors` and confirm
   nothing is currently failing.

## Step 1 — generate the new key

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

That prints a 64-character hex string. **Treat it like a production
password from this moment on**: paste once into Vercel, never write
it to disk, never commit it.

## Step 2 — add the new key as a SECOND env var

In Vercel → Settings → Environment Variables, **add** a new var
named `BREEZE_ENCRYPTION_KEY_NEXT` with the value from Step 1.

Do NOT replace `BREEZE_ENCRYPTION_KEY` yet. The re-encryption
script in Step 3 reads `BREEZE_ENCRYPTION_KEY` (old) for decryption
and `BREEZE_ENCRYPTION_KEY_NEXT` (new) for re-encryption.

Trigger a Vercel redeploy so the new var is live. Confirm via
`/run-diag GET /api/admin/smoke-test` (the `encryption_key` check
should still pass; it's looking at the old key).

## Step 3 — run the re-encryption script

> ⚠️ This script does not exist yet — it needs to be written as
> `scripts/reencrypt-secrets.mjs` before the first rotation.
> Sketch below:

```js
// scripts/reencrypt-secrets.mjs
//
// Walks every _encrypted column, decrypts with the OLD key,
// re-encrypts with the NEW key, writes back. Idempotent: rows
// already encrypted with the new key would fail decryption with
// the old key, so we detect+skip them.
//
// Env required:
//   DATABASE_URL                   target DB
//   BREEZE_ENCRYPTION_KEY          OLD key (still in use)
//   BREEZE_ENCRYPTION_KEY_NEXT     NEW key (added above)

import postgres from 'postgres';
import { decryptText, encryptText } from '../lib/encryption.js';

// Override the encryption module to use the NEXT key for writes.
// (Implementation detail: factor encryption.js so it accepts an
// explicit key, or set process.env.BREEZE_ENCRYPTION_KEY temporarily
// inside re-encrypt for each row.)

const TARGETS = [
  { table: 'bank_accounts', pk: 'id', col: 'plaid_access_token_encrypted' },
  // Add new _encrypted columns here as the schema grows.
];

for (const t of TARGETS) {
  const rows = await sql`SELECT ${sql(t.pk)} AS pk, ${sql(t.col)} AS cipher
                         FROM ${sql(t.table)}
                         WHERE ${sql(t.col)} IS NOT NULL`;
  for (const r of rows) {
    try {
      const plaintext = decryptOld(r.cipher);
      const reencrypted = encryptNew(plaintext);
      await sql`UPDATE ${sql(t.table)} SET ${sql(t.col)} = ${reencrypted}
                WHERE ${sql(t.pk)} = ${r.pk}`;
      console.log(`✓ ${t.table}/${r.pk}`);
    } catch (e) {
      // If decryption with the old key fails, the row is probably
      // already re-encrypted from a prior run. Skip and warn.
      console.warn(`? skip ${t.table}/${r.pk}: ${e.message}`);
    }
  }
}
```

Run locally against production DB (set `DATABASE_URL` to the prod
connection string):

```bash
DATABASE_URL=... \
BREEZE_ENCRYPTION_KEY=<OLD> \
BREEZE_ENCRYPTION_KEY_NEXT=<NEW> \
node scripts/reencrypt-secrets.mjs
```

Expected output:

```
✓ bank_accounts/abc-uuid
✓ bank_accounts/def-uuid
...
```

If any row reports an error other than "already re-encrypted" → STOP
and investigate. Don't proceed to Step 4 until every row is either
re-encrypted or explicitly understood.

## Step 4 — promote the new key

In Vercel → Settings → Environment Variables:

1. **Edit** `BREEZE_ENCRYPTION_KEY` and set its value to the NEW
   key (the one in `BREEZE_ENCRYPTION_KEY_NEXT`).
2. Trigger a redeploy.
3. **Delete** `BREEZE_ENCRYPTION_KEY_NEXT` (or leave it harmlessly;
   nothing reads it after this).
4. Fire `/run-smoke` from the ops console. `encryption_key` check
   should still pass (different key value, same length).

## Step 5 — verify

1. Hit a Plaid-dependent endpoint that requires decryption, e.g.
   `/api/admin/plaid-sync-transactions` for a known-linked bank.
   It should succeed.
2. Confirm `linked_bank_count` in smoke is unchanged.
3. Confirm `/tail-errors` shows no decryption errors over the next
   ~10 minutes.

## Step 6 — destroy the old key

The OLD key value should now exist nowhere except in your local
shell history. Clear that:

```bash
history -d $(history | grep "BREEZE_ENCRYPTION_KEY=<OLD prefix>" | awk '{print $1}')
# or just: history -c   (nuclear option)
```

If you copy-pasted the old key into any other system (1Password
note, etc.), purge those too.

## Rollback plan (if Step 3 or 5 fails)

The OLD key is still in `BREEZE_ENCRYPTION_KEY` until Step 4. If
the re-encryption run fails partway, leave the env vars as they are
— the OLD key continues to work for unmodified rows. Investigate
the script error, fix, re-run (it's idempotent).

If Step 4 went through and Step 5 fails:
- Set `BREEZE_ENCRYPTION_KEY` back to the OLD value temporarily,
  redeploy, confirm reads work.
- Investigate. Likely candidates: an `_encrypted` column was missed
  in the TARGETS list, or a row was added between Step 3 and Step 4
  that's still encrypted with the OLD key.

## Cadence

- **Routine**: annual.
- **Triggered**: immediately on any of:
  - Laptop loss for anyone with prod access.
  - Suspected git commit of an env file containing the key.
  - Departure of an engineer or contractor who had prod access.
  - Vercel project transfer / account compromise.

Record each rotation in `docs/runbooks/rotation-log.md` (date, who
ran it, outcome) so the next rotation knows what changed.
