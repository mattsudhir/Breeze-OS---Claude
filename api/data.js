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
import {
  readListFromMirror,
  mirrorHasData,
  isMirrored,
  getDefaultOrgIdForMirror,
} from '../lib/appfolioMirror.js';

// Tools whose reads can come from the AppFolio mirror in
// appfolio_cache instead of round-tripping through AppFolio's slow
// list API. Webhook + reconciliation cron keep the mirror current.
// Maps the chat tool name → resourceType used by the mirror.
const MIRROR_BACKED_TOOLS = {
  list_tenants: 'tenant',
  list_properties: 'property',
  list_units: 'unit',
  list_work_orders: 'work_order',
};

// Whitelist of tools callable from this surface. Mostly read-only,
// plus a small set of write tools where the menu-page form itself
// is the user's explicit confirmation (no AI interpretation needed).
//
// charge_tenant + update_work_order are write tools but reachable
// here because the menu form is the user's explicit confirmation
// (dropdown choices + Submit click). When the AI initiates a
// charge from chat, it still goes through runAgent's tool path
// where the system prompt mandates a recap-before-action.
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
  'update_work_order',
  'charge_tenant',
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
  let servedFrom = 'live';

  // Mirror fast path: if this is a list tool we cache locally AND
  // we're on the AppFolio backend AND the mirror has data for the
  // type, read from Postgres instead of round-tripping AppFolio.
  // Falls through to the live path on mirror miss / error so the
  // first request after a deploy still works (just slow until the
  // bulk sync runs).
  const mirrorType = MIRROR_BACKED_TOOLS[tool];
  if (mirrorType && source === 'appfolio' && isMirrored(mirrorType)) {
    try {
      const orgId = await getDefaultOrgIdForMirror();
      if (await mirrorHasData(orgId, mirrorType)) {
        const filters = {};
        if (input?.property_id) filters.propertyId = input.property_id;
        if (input?.unit_id) filters.unitId = input.unit_id;
        if (input?.occupancy_id) filters.occupancyId = input.occupancy_id;
        // Hidden / inactive records stay in the mirror but menu
        // pages don't want them. Default to active-only and let
        // explicit `include_hidden: true` (properties / units) or
        // `active_only: false` (tenants) opt in.
        const activeOnly =
          mirrorType === 'tenant'
            ? input?.active_only !== false
            : input?.include_hidden !== true;
        result = await readListFromMirror(orgId, mirrorType, {
          limit: input?.limit,
          offset: input?.offset,
          filters,
          activeOnly,
        });
        servedFrom = 'mirror';
      }
    } catch (err) {
      console.warn('[/api/data] mirror read failed, falling back to live:', err?.message || err);
    }
  }

  if (!result) {
    try {
      result = await backend.executeTool(tool, input || {});
    } catch (err) {
      threwError = err;
      result = { error: err?.message || String(err) };
    }
  }
  const durationMs = Date.now() - startedAt;

  const success =
    !threwError && !(result && typeof result === 'object' && 'error' in result);

  // Audit the call. Same pattern as runAgent — fire-and-forget so
  // a slow/down DB doesn't block the response. servedFrom records
  // whether the response came from the mirror or a live fetch, so
  // the audit log lets us see how often the mirror is being used.
  logAgentAction({
    surface: servedFrom === 'mirror' ? 'data-mirror' : 'data',
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
