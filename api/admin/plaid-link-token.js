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
    return res.status(502).json({
      ok: false,
      error: err.message || String(err),
    });
  }
});
