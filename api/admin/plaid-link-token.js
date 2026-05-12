// GET /api/admin/plaid-link-token?secret=<TOKEN>
//
// Returns a one-shot Plaid Link token for the frontend's Plaid Link
// initialization. The token is short-lived (30 minutes) and tied
// to the org's id, so re-link flows can match back to existing
// Items.

import {
  withAdminHandler,
  getDefaultOrgId,
} from '../../lib/adminHelpers.js';
import { createLinkToken, isPlaidConfigured } from '../../lib/backends/plaid.js';

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
  try {
    const { link_token, expiration } = await createLinkToken({
      organizationId,
      clientName: 'Breeze OS',
      products: ['transactions'],
    });
    return res.status(200).json({
      ok: true,
      link_token,
      expiration,
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
