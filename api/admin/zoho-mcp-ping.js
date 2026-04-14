// Vercel Serverless Function — Zoho MCP connectivity diagnostic.
//
// GET /api/admin/zoho-mcp-ping?secret=<BREEZE_ADMIN_TOKEN>
//
// Verifies that ZOHO_MCP_SERVER_URL is set, opens an MCP session,
// and calls tools/list. Returns the tool names so you can confirm the
// server is exposing what you expect before switching the chat toggle
// to Zoho MCP.

import { withAdminHandler } from '../../lib/adminHelpers.js';
import { _diagnostic } from '../../lib/backends/zohoMcp.js';

export default withAdminHandler(async (req, res) => {
  const result = await _diagnostic();
  const status = result.error ? 500 : 200;
  return res.status(status).json({ ok: !result.error, ...result });
});
