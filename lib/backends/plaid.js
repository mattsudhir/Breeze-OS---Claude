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
  const { organizationId, clientName = 'Breeze OS', products } = params;
  if (!organizationId) throw new Error('createLinkToken: organizationId required');

  const productList = (products && products.length > 0
    ? products
    : ['transactions']
  ).map((p) => Products[p.toUpperCase()] || p);

  const client = getPlaidClient();
  const resp = await client.linkTokenCreate({
    client_name: clientName,
    user: { client_user_id: organizationId },
    country_codes: [CountryCode.Us],
    language: 'en',
    products: productList,
  });
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
