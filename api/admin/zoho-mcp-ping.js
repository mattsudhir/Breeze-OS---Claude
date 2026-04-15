// Vercel Serverless Function — Zoho MCP connectivity diagnostic.
//
// GET /api/admin/zoho-mcp-ping?secret=<BREEZE_ADMIN_TOKEN>
//
// Walks the full Zoho MCP handshake (initialize → notifications/
// initialized → tools/list) using the OAuth bearer token in
// ZOHO_MCP_ACCESS_TOKEN, then reports:
//
//   status: 'ok'                    — connected, tools discovered
//   status: 'handshake_ok_no_tools' — connected but server exposed 0 tools
//   status: 'unconfigured'          — ZOHO_MCP_SERVER_URL missing
//   status: 'missing_token'         — ZOHO_MCP_ACCESS_TOKEN missing
//   status: 'auth_failed'           — 401 from Zoho (token expired/invalid)
//   status: 'error'                 — any other transport or protocol error
//
// Each status includes a `hint` pointing at the next action to take.

import { withAdminHandler } from '../../lib/adminHelpers.js';
import { _diagnostic } from '../../lib/backends/zohoMcp.js';

export default withAdminHandler(async (req, res) => {
  const result = await _diagnostic();
  // Map status → HTTP code so the response code alone is useful in
  // logs / uptime checks. Non-2xx means "something needs fixing."
  const httpStatus =
    result.status === 'ok' || result.status === 'handshake_ok_no_tools'
      ? 200
      : result.status === 'unconfigured' || result.status === 'missing_token'
      ? 412 // Precondition Failed — env vars not set
      : result.status === 'auth_failed'
      ? 401
      : 502; // Bad Gateway — Zoho returned something unexpected
  return res.status(httpStatus).json({
    ok: result.status === 'ok' || result.status === 'handshake_ok_no_tools',
    ...result,
  });
});
