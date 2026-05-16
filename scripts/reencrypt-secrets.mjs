#!/usr/bin/env node
//
// Re-encrypt every `*_encrypted` column from the OLD encryption
// key to a NEW one. Idempotent: rows already re-encrypted will be
// detected (decryption with the OLD key fails) and skipped.
//
// Required env vars:
//   DATABASE_URL                 target Postgres connection string
//   BREEZE_ENCRYPTION_KEY        the CURRENT (old) key, used to
//                                 decrypt existing rows
//   BREEZE_ENCRYPTION_KEY_NEXT   the NEW key, used to re-encrypt
//
// Typical run:
//   DATABASE_URL=postgresql://... \
//   BREEZE_ENCRYPTION_KEY=<old hex> \
//   BREEZE_ENCRYPTION_KEY_NEXT=<new hex> \
//   node scripts/reencrypt-secrets.mjs
//
// Optional flags:
//   --dry-run     print what would change, don't write
//   --table=NAME  only re-encrypt the given table (default: all)
//
// See docs/runbooks/rotate-encryption-key.md for the full
// step-by-step rotation procedure. This script is Step 3.

import postgres from 'postgres';
import { createCipheriv, createDecipheriv, randomBytes } from 'crypto';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;
const KEY_LENGTH = 32;

// One row per `_encrypted` column in the schema. Update this list
// when you add new encrypted columns elsewhere.
const TARGETS = [
  { table: 'bank_accounts', pk: 'id', col: 'plaid_access_token_encrypted' },
];

function parseKey(envVar, label) {
  const hex = process.env[envVar];
  if (!hex) {
    console.error(`${envVar} not set. Aborting.`);
    process.exit(2);
  }
  const buf = Buffer.from(hex, 'hex');
  if (buf.length !== KEY_LENGTH) {
    console.error(
      `${envVar} must be ${KEY_LENGTH} bytes (${KEY_LENGTH * 2} hex chars); got ${buf.length} bytes (${label}).`,
    );
    process.exit(2);
  }
  return buf;
}

function decryptWithKey(key, packed) {
  if (packed == null) return null;
  const parts = String(packed).split(':');
  if (parts.length !== 3) throw new Error('malformed cipher (expected iv:tag:ciphertext)');
  const iv = Buffer.from(parts[0], 'hex');
  const tag = Buffer.from(parts[1], 'hex');
  const ct = Buffer.from(parts[2], 'hex');
  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(tag);
  const out = Buffer.concat([decipher.update(ct), decipher.final()]);
  return out.toString('utf8');
}

function encryptWithKey(key, plaintext) {
  if (plaintext == null) return null;
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString('hex')}:${tag.toString('hex')}:${ct.toString('hex')}`;
}

function parseFlags(argv) {
  const flags = { dryRun: false, onlyTable: null };
  for (const a of argv.slice(2)) {
    if (a === '--dry-run') flags.dryRun = true;
    else if (a.startsWith('--table=')) flags.onlyTable = a.slice('--table='.length);
    else {
      console.error(`Unknown flag: ${a}`);
      process.exit(2);
    }
  }
  return flags;
}

async function main() {
  const flags = parseFlags(process.argv);
  const url = process.env.DATABASE_URL || process.env.POSTGRES_URL;
  if (!url) {
    console.error('DATABASE_URL not set. Aborting.');
    process.exit(2);
  }

  const oldKey = parseKey('BREEZE_ENCRYPTION_KEY', 'OLD');
  const newKey = parseKey('BREEZE_ENCRYPTION_KEY_NEXT', 'NEW');

  if (oldKey.equals(newKey)) {
    console.error('OLD and NEW keys are identical — refusing to run. Generate a fresh key.');
    process.exit(2);
  }

  const sql = postgres(url, {
    max: 1,
    idle_timeout: 5,
    connect_timeout: 10,
    prepare: false,
  });

  console.log(
    `${flags.dryRun ? '[DRY RUN] ' : ''}Re-encrypting ${
      flags.onlyTable ? `table ${flags.onlyTable}` : `${TARGETS.length} target table(s)`
    } using new key.`,
  );

  const targets = flags.onlyTable
    ? TARGETS.filter((t) => t.table === flags.onlyTable)
    : TARGETS;
  if (targets.length === 0) {
    console.error(`No matching target for --table=${flags.onlyTable}.`);
    process.exit(2);
  }

  let totalProcessed = 0;
  let totalReencrypted = 0;
  let totalSkipped = 0;
  let totalErrored = 0;

  for (const t of targets) {
    console.log(`\n── ${t.table}.${t.col} (pk: ${t.pk}) ──`);
    const rows = await sql.unsafe(
      `SELECT ${t.pk} AS pk, ${t.col} AS cipher FROM ${t.table} WHERE ${t.col} IS NOT NULL`,
    );
    console.log(`  ${rows.length} row(s) to consider.`);

    for (const r of rows) {
      totalProcessed += 1;
      let plaintext;
      try {
        plaintext = decryptWithKey(oldKey, r.cipher);
      } catch (e) {
        // Probably already re-encrypted with the new key on a prior
        // run. Try decrypting with the NEW key to confirm; if THAT
        // succeeds, the row is fine and we can safely skip.
        let alreadyNew = false;
        try {
          decryptWithKey(newKey, r.cipher);
          alreadyNew = true;
        } catch { /* not already new either */ }
        if (alreadyNew) {
          totalSkipped += 1;
          console.log(`  · ${t.pk}=${r.pk}: already re-encrypted (skip)`);
        } else {
          totalErrored += 1;
          console.error(
            `  ! ${t.pk}=${r.pk}: decryption failed with BOTH keys — ${e.message}`,
          );
          console.error('    Row is unrecoverable from this script. Investigate manually.');
        }
        continue;
      }

      const reencrypted = encryptWithKey(newKey, plaintext);

      if (flags.dryRun) {
        console.log(`  ✓ ${t.pk}=${r.pk}: would re-encrypt (plaintext length ${plaintext.length})`);
        continue;
      }

      await sql.unsafe(
        `UPDATE ${t.table} SET ${t.col} = $1 WHERE ${t.pk} = $2`,
        [reencrypted, r.pk],
      );
      totalReencrypted += 1;
      console.log(`  ✓ ${t.pk}=${r.pk}: re-encrypted`);
    }
  }

  console.log('\n── Summary ──');
  console.log(`  processed:      ${totalProcessed}`);
  console.log(`  re-encrypted:   ${totalReencrypted}`);
  console.log(`  already-new:    ${totalSkipped}`);
  console.log(`  errored:        ${totalErrored}`);
  if (flags.dryRun) {
    console.log(
      '\n[DRY RUN] No rows were written. Re-run without --dry-run to apply.',
    );
  }

  await sql.end();
  process.exit(totalErrored > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
