// AES-256-GCM symmetric encryption helper for storing secrets at
// rest in Postgres.
//
// The single env var BREEZE_ENCRYPTION_KEY holds a 32-byte hex
// string (64 hex chars). Generate one with:
//
//   node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
//
// Encrypted-at-rest fields use a `_encrypted` suffix in the schema
// (e.g. bank_accounts.plaid_access_token_encrypted). Application
// code writes plaintext into encryptText() and reads ciphertext
// out via decryptText(); the column itself stores the
// "iv:tag:ciphertext" hex-encoded string.
//
// AES-256-GCM provides:
//   - confidentiality (the secret isn't readable in DB dumps)
//   - authenticity (tampering with the ciphertext makes decryption
//     fail, not silently corrupt)
//   - random IV per encryption (same plaintext → different ciphertext)
//
// If you ever rotate the key, you need to re-encrypt every row.
// Not a v1 concern, but plan for it.

import { createCipheriv, createDecipheriv, randomBytes } from 'crypto';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12; // GCM standard
const KEY_LENGTH = 32; // 256 bits

function getKey() {
  const hex = process.env.BREEZE_ENCRYPTION_KEY;
  if (!hex) {
    throw new Error(
      'BREEZE_ENCRYPTION_KEY not set. Generate one with: ' +
        "node -e \"console.log(require('crypto').randomBytes(32).toString('hex'))\"",
    );
  }
  const buf = Buffer.from(hex, 'hex');
  if (buf.length !== KEY_LENGTH) {
    throw new Error(
      `BREEZE_ENCRYPTION_KEY must be ${KEY_LENGTH} bytes (${KEY_LENGTH * 2} hex chars); got ${buf.length}`,
    );
  }
  return buf;
}

/**
 * Encrypt a UTF-8 string. Returns a "iv:tag:ciphertext" hex string.
 * Returns null for null/undefined/empty input.
 */
export function encryptText(plaintext) {
  if (plaintext === null || plaintext === undefined || plaintext === '') {
    return null;
  }
  const key = getKey();
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([
    cipher.update(plaintext, 'utf8'),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return `${iv.toString('hex')}:${tag.toString('hex')}:${encrypted.toString('hex')}`;
}

/**
 * Decrypt a string previously produced by encryptText(). Returns
 * null for null/undefined input. Throws on tag/key mismatch.
 */
export function decryptText(packed) {
  if (packed === null || packed === undefined) return null;
  const parts = packed.split(':');
  if (parts.length !== 3) {
    throw new Error('decryptText: malformed input (expected "iv:tag:ciphertext")');
  }
  const key = getKey();
  const iv = Buffer.from(parts[0], 'hex');
  const tag = Buffer.from(parts[1], 'hex');
  const ct = Buffer.from(parts[2], 'hex');
  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(tag);
  const out = Buffer.concat([decipher.update(ct), decipher.final()]);
  return out.toString('utf8');
}

/**
 * Test whether the encryption key is configured correctly without
 * actually encrypting anything sensitive. Returns true/false.
 */
export function isEncryptionConfigured() {
  try {
    getKey();
    return true;
  } catch {
    return false;
  }
}
