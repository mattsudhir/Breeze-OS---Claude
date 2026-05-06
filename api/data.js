// Vercel Serverless Function — backend-agnostic data accessor.
//
// The web Chat Home goes through /api/chat → runAgent → executeTool.
// Menu pages (Properties, Tenants, etc.) need the same backend tool
// surface but without the LLM — they want structured rows, not chat.
//
// /api/data is that direct path. POST a body with the active source
// (matches the toggle in TopBar), the tool name, and an input
// object, and you get back the same shape executeTool returns to
// the agent. No orchestration tools (notify_team / make_call /
// charge_tenant) are exposed here — those are explicit user-action
// surfaces and shouldn't be invokable from a generic data fetch.
//
// Body schema:
//   { source: 'appfolio' | 'rm-demo' | ..., tool: 'list_tenants',
//     input: { ... } }
//
// Response:
//   { ok: true, data: <whatever the tool returned> }
//   { ok: false, error: <message> }
//
// Audit: every call lands in agent_actions with surface='data' so
// "what did Properties page just ask for" is queryable next to the
// chat tool calls.

import { getChatBackend } from '../lib/backends/index.js';
import { logAgentAction } from '../lib/agentAudit.js';

// Whitelist of tools callable from this surface. Read-only by
// design — write tools are reachable from chat (where the agent
// can confirm intent) but not from a menu-page data fetch.
const ALLOWED_TOOLS = new Set([
  'list_properties',
  'list_tenants',
  'search_tenants',
  'get_tenant_details',
  'list_units',
  'list_work_orders',
  'count_properties',
  'count_tenants',
  'count_units',
  'count_work_orders',
  'list_gl_accounts',
]);

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-breeze-user-id');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  const { source, tool, input } = req.body || {};
  if (!source) return res.status(400).json({ error: 'source required' });
  if (!tool) return res.status(400).json({ error: 'tool required' });
  if (!ALLOWED_TOOLS.has(tool)) {
    return res.status(403).json({
      error: `Tool "${tool}" is not callable from /api/data. Allowed: ${[...ALLOWED_TOOLS].join(', ')}.`,
    });
  }

  let backend;
  try {
    backend = getChatBackend(source);
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }

  const startedAt = Date.now();
  let result;
  let threwError = null;
  try {
    result = await backend.executeTool(tool, input || {});
  } catch (err) {
    threwError = err;
    result = { error: err?.message || String(err) };
  }
  const durationMs = Date.now() - startedAt;

  const success =
    !threwError && !(result && typeof result === 'object' && 'error' in result);

  // Audit the call. Same pattern as runAgent — fire-and-forget so
  // a slow/down DB doesn't block the response.
  logAgentAction({
    surface: 'data',
    userId: req.headers['x-breeze-user-id'] || null,
    backendName: backend.name || source,
    toolName: tool,
    toolInput: input || {},
    toolOutput: result,
    success,
    durationMs,
    errorText: threwError ? threwError.message : null,
  });

  if (!success) {
    return res.status(threwError ? 500 : 200).json({
      ok: false,
      error: result?.error || threwError?.message || 'Unknown error',
    });
  }

  return res.status(200).json({ ok: true, data: result });
}
