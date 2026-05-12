// GET  /api/admin/plaid-link-token?secret=<TOKEN>
// POST /api/admin/plaid-link-token?secret=<TOKEN>
//        body: { bank_account_id }    // optional — re-link mode
//
// Returns a Plaid Link token. Two modes:
//
//   Default (new link)
//     Plaid's institution-selection flow. Used when adding a new bank.
//
//   Update mode (re-link)
//     If body.bank_account_id is provided, we look up the bank's
//     encrypted access_token, decrypt it, and create a Link token
//     scoped to the existing Item. Plaid Link skips institution
//     selection and prompts the user to re-authenticate. Required
//     when a bank flips to plaid_status='re_auth_required'.

import { and, eq } from 'drizzle-orm';
import {
  withAdminHandler,
  getDefaultOrgId,
  parseBody,
} from '../../lib/adminHelpers.js';
import { createLinkToken, isPlaidConfigured } from '../../lib/backends/plaid.js';
import { decryptText, isEncryptionConfigured } from '../../lib/encryption.js';
import { getDb, schema } from '../../lib/db/index.js';

export default withAdminHandler(async (req, res) => {
  if (req.method !== 'GET' && req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'GET or POST only' });
  }
  if (!isPlaidConfigured()) {
    return res.status(503).json({
      ok: false,
      error: 'Plaid not configured. Set PLAID_CLIENT_ID and PLAID_SECRET in Vercel env vars.',
    });
  }

  const organizationId = await getDefaultOrgId();

  // Detect re-link mode.
  const body = req.method === 'POST' ? parseBody(req) : {};
  const bankAccountId = body.bank_account_id || null;
  let accessToken = null;

  if (bankAccountId) {
    if (!isEncryptionConfigured()) {
      return res.status(503).json({
        ok: false,
        error: 'BREEZE_ENCRYPTION_KEY not set; cannot decrypt access_token for re-link.',
      });
    }
    const db = getDb();
    const [bank] = await db
      .select({
        id: schema.bankAccounts.id,
        tokenCipher: schema.bankAccounts.plaidAccessTokenEncrypted,
      })
      .from(schema.bankAccounts)
      .where(
        and(
          eq(schema.bankAccounts.id, bankAccountId),
          eq(schema.bankAccounts.organizationId, organizationId),
        ),
      )
      .limit(1);
    if (!bank) {
      return res.status(404).json({ ok: false, error: 'bank_account not found in org' });
    }
    if (!bank.tokenCipher) {
      return res.status(400).json({
        ok: false,
        error: 'bank_account has no Plaid access_token; cannot re-link an unlinked account',
      });
    }
    try {
      accessToken = decryptText(bank.tokenCipher);
    } catch (err) {
      return res.status(500).json({
        ok: false,
        error: `Failed to decrypt access_token: ${err.message}`,
      });
    }
  }

  try {
    const { link_token, expiration } = await createLinkToken({
      organizationId,
      clientName: 'Breeze OS',
      // Update-mode call omits products; the helper handles that.
      products: accessToken ? undefined : ['transactions'],
      accessToken,
    });
    return res.status(200).json({
      ok: true,
      link_token,
      expiration,
      mode: accessToken ? 'update' : 'new',
    });
  } catch (err) {
    // Plaid SDK errors come through Axios. The real Plaid error
    // (error_type / error_code / error_message) lives on
    // err.response.data — bubble it up instead of relaying just
    // the generic "Request failed with status code N" message.
    const plaid = err?.response?.data || {};
    return res.status(502).json({
      ok: false,
      error: plaid.error_message || err.message || String(err),
      error_type: plaid.error_type || null,
      error_code: plaid.error_code || null,
      display_message: plaid.display_message || null,
      // Env-var sanity check: helps localize "wrong env" vs "wrong key" vs
      // "wrong secret format" without revealing values.
      env_check: {
        PLAID_ENV: process.env.PLAID_ENV || '(unset)',
        PLAID_CLIENT_ID_present: Boolean(process.env.PLAID_CLIENT_ID),
        PLAID_CLIENT_ID_length: process.env.PLAID_CLIENT_ID?.length ?? 0,
        PLAID_SECRET_present: Boolean(process.env.PLAID_SECRET),
        PLAID_SECRET_length: process.env.PLAID_SECRET?.length ?? 0,
      },
    });
  }
});
