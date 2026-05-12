// Plaid backend wrapper.
//
// Wraps the official `plaid` npm SDK with the Breeze-specific
// helpers our endpoints need:
//
//   getPlaidClient()           -> configured PlaidApi instance
//   createLinkToken(userId)    -> { link_token, expiration }
//   exchangePublicToken(pt)    -> { access_token, item_id }
//   getAccounts(accessToken)   -> [{ account_id, name, mask, type, subtype, balances }]
//   syncTransactions(accessToken, cursor) -> { added, modified, removed, next_cursor }
//
// Env vars required:
//   PLAID_CLIENT_ID      from Plaid dashboard
//   PLAID_SECRET         per-environment secret (sandbox/dev/prod)
//   PLAID_ENV            'sandbox' | 'development' | 'production'
//                        (defaults to 'sandbox')
//
// If any of those aren't set, the helpers throw a clear error; the
// admin endpoints surface this so the UI knows Plaid isn't
// configured yet.
//
// Why we wrap the SDK rather than using it directly: cleaner
// testing surface, single place to add caching/retry/observability
// later, and the SDK's Configuration object is annoying enough that
// we don't want every endpoint repeating it.

import {
  Configuration,
  PlaidApi,
  PlaidEnvironments,
  Products,
  CountryCode,
} from 'plaid';

const VALID_ENVS = new Set(['sandbox', 'development', 'production']);

let cachedClient = null;

export function isPlaidConfigured() {
  return Boolean(process.env.PLAID_CLIENT_ID && process.env.PLAID_SECRET);
}

export function getPlaidEnv() {
  const env = (process.env.PLAID_ENV || 'sandbox').toLowerCase();
  if (!VALID_ENVS.has(env)) {
    throw new Error(
      `PLAID_ENV must be one of sandbox / development / production; got "${env}"`,
    );
  }
  return env;
}

export function getPlaidClient() {
  if (cachedClient) return cachedClient;
  if (!isPlaidConfigured()) {
    throw new Error(
      'Plaid not configured. Set PLAID_CLIENT_ID and PLAID_SECRET in Vercel env vars.',
    );
  }
  const env = getPlaidEnv();
  const configuration = new Configuration({
    basePath: PlaidEnvironments[env],
    baseOptions: {
      headers: {
        'PLAID-CLIENT-ID': process.env.PLAID_CLIENT_ID,
        'PLAID-SECRET': process.env.PLAID_SECRET,
      },
    },
  });
  cachedClient = new PlaidApi(configuration);
  return cachedClient;
}

// ── Link tokens ──────────────────────────────────────────────────

/**
 * Create a Plaid Link token for the frontend's Link initialization.
 * Returns { link_token, expiration } — the link_token is short-lived
 * (30 minutes) and used once.
 *
 * @param {object} params
 * @param {string} params.organizationId   stable Breeze org id; used
 *                                          as Plaid's client_user_id
 *                                          so re-link flows can match
 *                                          back to the right Items
 * @param {string} [params.clientName]     defaults to "Breeze OS"
 * @param {string[]} [params.products]     defaults to ['transactions']
 */
export async function createLinkToken(params) {
  const {
    organizationId,
    clientName = 'Breeze OS',
    products,
    // Re-link / update mode: pass an existing access_token to put
    // Plaid Link into update mode. Plaid skips institution selection
    // and prompts the user to re-authenticate for the existing Item.
    // Required when a bank flips to ITEM_LOGIN_REQUIRED. `products`
    // MUST be omitted when access_token is set (Plaid rejects both).
    accessToken,
    // Optional webhook URL to register for this Item.
    webhookUrl,
  } = params;
  if (!organizationId) throw new Error('createLinkToken: organizationId required');

  const productList = (products && products.length > 0
    ? products
    : ['transactions']
  ).map((p) => Products[p.toUpperCase()] || p);

  const client = getPlaidClient();

  const request = {
    client_name: clientName,
    user: { client_user_id: organizationId },
    country_codes: [CountryCode.Us],
    language: 'en',
  };
  if (accessToken) {
    request.access_token = accessToken;
  } else {
    request.products = productList;
  }
  if (webhookUrl) request.webhook = webhookUrl;

  const resp = await client.linkTokenCreate(request);
  return {
    link_token: resp.data.link_token,
    expiration: resp.data.expiration,
  };
}

// ── Token exchange ───────────────────────────────────────────────

/**
 * Exchange a one-time Plaid public_token (from the Link flow) for
 * a long-lived access_token and the item_id.
 *
 * @param {string} publicToken
 * @returns {Promise<{ access_token: string, item_id: string }>}
 */
export async function exchangePublicToken(publicToken) {
  if (!publicToken) throw new Error('exchangePublicToken: publicToken required');
  const client = getPlaidClient();
  const resp = await client.itemPublicTokenExchange({
    public_token: publicToken,
  });
  return {
    access_token: resp.data.access_token,
    item_id: resp.data.item_id,
  };
}

// ── Account list ─────────────────────────────────────────────────

/**
 * Fetch the accounts belonging to a linked Plaid Item.
 *
 * @param {string} accessToken
 */
export async function getAccounts(accessToken) {
  if (!accessToken) throw new Error('getAccounts: accessToken required');
  const client = getPlaidClient();
  const resp = await client.accountsGet({ access_token: accessToken });
  return resp.data.accounts.map((a) => ({
    account_id: a.account_id,
    name: a.name,
    official_name: a.official_name,
    mask: a.mask,
    type: a.type,
    subtype: a.subtype,
    balances: a.balances,
  }));
}

// ── Sync transactions (incremental) ──────────────────────────────

/**
 * Pull the next batch of transactions for a Plaid Item using the
 * /transactions/sync incremental endpoint.
 *
 * @param {string} accessToken
 * @param {string|null} cursor   null on first call
 * @param {object} [options]
 * @param {number} [options.maxPages=10]   safety cap
 * @returns {Promise<{
 *   added:    Array,
 *   modified: Array,
 *   removed:  Array,
 *   next_cursor: string,
 *   has_more: boolean,
 * }>}
 */
export async function syncTransactions(accessToken, cursor, options = {}) {
  if (!accessToken) throw new Error('syncTransactions: accessToken required');
  const { maxPages = 10 } = options;
  const client = getPlaidClient();

  let nextCursor = cursor || null;
  let added = [];
  let modified = [];
  let removed = [];
  let pages = 0;

  while (pages < maxPages) {
    pages += 1;
    const resp = await client.transactionsSync({
      access_token: accessToken,
      cursor: nextCursor || undefined,
    });
    added = added.concat(resp.data.added);
    modified = modified.concat(resp.data.modified);
    removed = removed.concat(resp.data.removed);
    nextCursor = resp.data.next_cursor;
    if (!resp.data.has_more) break;
  }

  return {
    added,
    modified,
    removed,
    next_cursor: nextCursor,
    has_more: pages >= maxPages, // ran out of attempts
  };
}

// ── Webhook signature verification ──────────────────────────────

import crypto from 'node:crypto';
import { importJWK, jwtVerify, decodeProtectedHeader } from 'jose';

// Cache verification keys per kid in-memory. They rotate ~daily, so
// the cache is short-lived but worth keeping during high-volume
// webhook bursts.
const verificationKeyCache = new Map(); // kid -> { jwk, fetchedAt }
const KEY_CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24h

async function fetchVerificationKey(kid) {
  const cached = verificationKeyCache.get(kid);
  if (cached && Date.now() - cached.fetchedAt < KEY_CACHE_TTL_MS) {
    return cached.jwk;
  }
  const client = getPlaidClient();
  const resp = await client.webhookVerificationKeyGet({ key_id: kid });
  const jwk = resp.data.key;
  // Plaid rotates keys; expired_at !== null means we should refresh.
  // For our purposes (verifying webhooks Plaid just sent), even an
  // expired-flagged key is acceptable as long as the JWT itself
  // hasn't aged past our skew tolerance.
  verificationKeyCache.set(kid, { jwk, fetchedAt: Date.now() });
  return jwk;
}

/**
 * Verify a Plaid webhook request.
 *
 *   - Decodes the Plaid-Verification JWT header
 *   - Fetches the kid's public key from Plaid's webhook verification API
 *   - Verifies the JWT signature (ES256)
 *   - Computes SHA-256 of the raw body and confirms it matches the
 *     request_body_sha256 claim
 *   - Rejects JWTs older than 5 minutes (clock skew + Plaid retry window)
 *
 * Returns { valid: true } on success, or { valid: false, reason: string }
 * on any check failure. Never throws — webhook handlers should still
 * return 200 (Plaid retries on non-2xx, and we don't want signature
 * failures to cause retry storms; just log and ignore the body).
 *
 * @param {object} params
 * @param {string} params.jwtHeader     value of the Plaid-Verification HTTP header
 * @param {string|Buffer} params.rawBody  raw request body (the exact bytes Plaid sent)
 */
export async function verifyPlaidWebhook({ jwtHeader, rawBody }) {
  if (!jwtHeader) return { valid: false, reason: 'missing_plaid_verification_header' };
  if (rawBody === undefined || rawBody === null) {
    return { valid: false, reason: 'missing_body' };
  }

  let kid;
  try {
    const header = decodeProtectedHeader(jwtHeader);
    kid = header.kid;
    if (!kid) return { valid: false, reason: 'jwt_missing_kid' };
  } catch (err) {
    return { valid: false, reason: `jwt_header_decode_failed: ${err.message}` };
  }

  let jwk;
  try {
    jwk = await fetchVerificationKey(kid);
  } catch (err) {
    return { valid: false, reason: `verification_key_fetch_failed: ${err.message}` };
  }

  let key;
  try {
    key = await importJWK(jwk, 'ES256');
  } catch (err) {
    return { valid: false, reason: `jwk_import_failed: ${err.message}` };
  }

  let payload;
  try {
    const verified = await jwtVerify(jwtHeader, key, {
      algorithms: ['ES256'],
      // 5-minute skew: Plaid's docs say verify iat within 5 minutes;
      // jose handles iat enforcement internally when we pass maxTokenAge.
      maxTokenAge: '5m',
    });
    payload = verified.payload;
  } catch (err) {
    return { valid: false, reason: `jwt_signature_invalid: ${err.message}` };
  }

  const expectedHash = payload.request_body_sha256;
  if (!expectedHash) {
    return { valid: false, reason: 'jwt_missing_request_body_sha256_claim' };
  }

  const bodyBuf = typeof rawBody === 'string' ? Buffer.from(rawBody, 'utf8') : rawBody;
  const actualHash = crypto.createHash('sha256').update(bodyBuf).digest('hex');
  if (actualHash !== expectedHash) {
    return {
      valid: false,
      reason: `body_hash_mismatch: expected=${expectedHash.slice(0, 12)}... actual=${actualHash.slice(0, 12)}...`,
    };
  }

  return { valid: true, payload };
}
