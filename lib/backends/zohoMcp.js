// Zoho MCP (Model Context Protocol) backend.
//
// Connects to a Zoho-hosted MCP server at <tenant>.zohomcp.com that
// exposes tools over Zoho's products — Cliq, CRM, and whatever the
// Zoho MCP admin (https://mcp.zoho.com/mcp-client) has enabled. MCP
// is Anthropic's open protocol for connecting AI assistants to
// external tools/data.
//
// ── Configuration ────────────────────────────────────────────────
//
// Environment variables:
//
//   ZOHO_MCP_SERVER_URL   — full connection URL from the Zoho MCP
//                           admin panel (https://mcp.zoho.com/mcp-client).
//                           Zoho uses two URL formats depending on
//                           tenant vintage:
//                             https://<tenant>.zohomcp.com/mcp/<token>/message
//                             https://<tenant>.zohomcp.com/mcp/message?key=<token>
//                           Both work — the token is a tenant identifier
//                           embedded in the URL (path or query). It is
//                           NOT sufficient for authentication on its
//                           own; Zoho requires OAuth 2.1 on every
//                           request (see ZOHO_MCP_ACCESS_TOKEN below).
//                           If Zoho returns "APIKey parsing Exception"
//                           the token has rotated or the MCP server
//                           was recreated — regenerate the URL in the
//                           admin panel.
//
//   ZOHO_MCP_ACCESS_TOKEN — short-lived OAuth access token. Sent as
//                           `Authorization: Bearer <token>` on every
//                           request. Access tokens expire ~1 hour so
//                           this is a manual-capture escape hatch for
//                           initial smoke testing; a proper refresh-
//                           token flow lives in a follow-up PR.
//
// How to get an access token for smoke testing:
//   1. On your laptop, `npx mcp-remote <ZOHO_MCP_SERVER_URL>`
//   2. mcp-remote opens a browser, walks you through Zoho's OAuth
//      dance (DCR + PKCE), and prints an access token in the shell.
//   3. Copy that token into Vercel env var ZOHO_MCP_ACCESS_TOKEN.
//   4. Redeploy. Access token is valid for about an hour.
//
// ── Transport ────────────────────────────────────────────────────
//
// Zoho uses MCP's Streamable HTTP transport (spec revision 2025-06-18).
// Single endpoint — whatever ZOHO_MCP_SERVER_URL points at:
//
//   POST <ZOHO_MCP_SERVER_URL>
//     Headers:
//       Content-Type: application/json
//       Accept: application/json, text/event-stream
//       Authorization: Bearer <access_token>
//       Mcp-Session-Id: <id-from-initialize-response>
//     Body: JSON-RPC 2.0 request
//     Response: either application/json or text/event-stream —
//               server picks per request. Our client handles both.
//
// Handshake:
//   1. POST `initialize` with protocolVersion "2025-06-18". Response
//      headers include Mcp-Session-Id — capture it.
//   2. POST `notifications/initialized` (no id, no response expected)
//      using the session id. This is required by spec.
//   3. POST `tools/list` to discover what the server offers. Pass
//      tools through to Claude as tool definitions.
//   4. POST `tools/call` for each tool the LLM invokes.
//
// ── State ────────────────────────────────────────────────────────
//
// Session state and cached tool list live in module scope. On Vercel
// this means "per serverless function instance": a cold start redoes
// the handshake, warm instances reuse the session. Access tokens are
// read from env on every call so rotating them only needs a redeploy,
// not a code change.

export const name = 'zoho-mcp';
export const displayName = 'Zoho MCP';
export const description =
  'Zoho MCP server (mcp.zoho.com). Exposes tools over Zoho CRM, Cliq, ' +
  'and other Zoho products via the Model Context Protocol. Requires ' +
  'ZOHO_MCP_SERVER_URL and ZOHO_MCP_ACCESS_TOKEN env vars.';

export const systemPromptAddendum = [
  'Data source: Zoho MCP server.',
  '',
  'Tool set is discovered dynamically from the MCP server. The primary',
  'data tool is ZohoCRM_getRecords — it queries ANY Zoho CRM module by',
  'passing the module name in path_variables.module.',
  '',
  'Available CRM modules in this Zoho instance:',
  '  Tenants        — tenant records (Name, Phone, Mobile, Email, Section_8, Past_due1, …)',
  '  Property_Group — property records (omit fields param to get all fields)',
  '  Contacts       — general contacts',
  '  Deals          — deals / opportunities',
  '  Accounts       — companies / organizations',
  '',
  'Calling pattern for ZohoCRM_getRecords:',
  '  {',
  '    "path_variables": { "module": "Tenants" },',
  '    "query_params": {',
  '      "per_page": 200,',
  '      "page": 1,',
  '      "fields": "Name,Phone,Mobile,Email,Section_8,Past_due1"',
  '    }',
  '  }',
  '',
  'Pagination: check info.more_records in the response. If true, increment',
  'page and call again. Maximum per_page is 200.',
  '',
  'For counting records, fetch page 1 with per_page=1 and read info.count',
  'from the response instead of iterating all pages.',
  '',
  'Other tools may include ZohoCRM_searchRecords (search by criteria),',
  'ZohoCRM_getRecord (single record by ID), and Zoho Cliq tools for',
  'channels and messages.',
  '',
  'If a tool returns an error about missing Zoho scopes, surface it ' +
  'verbatim — those fix in the Zoho MCP admin panel, not in Breeze.',
].join('\n');

// ── MCP protocol constants ───────────────────────────────────────

const MCP_PROTOCOL_VERSION = '2025-06-18';
const CLIENT_INFO = { name: 'breeze-os', version: '0.1.0' };
// Minimal capability set — we're a read-only/tool-invoking client.
const CLIENT_CAPABILITIES = {};

// ── Module-scope session state ───────────────────────────────────

let rpcId = 0;
function nextId() {
  rpcId += 1;
  return rpcId;
}

let cachedToolList = null;
let initialized = false;
let sessionId = null;

// OAuth token cache — survives across requests on a warm instance.
let cachedAccessToken = null;
let tokenExpiresAt = 0;

function resetSession() {
  cachedToolList = null;
  initialized = false;
  sessionId = null;
}

// ── OAuth token refresh ─────────────────────────────────────────
//
// When ZOHO_REFRESH_TOKEN, ZOHO_CLIENT_ID, and ZOHO_CLIENT_SECRET
// are configured, we can auto-refresh expired access tokens without
// manual intervention. The refresh token is long-lived (until
// revoked); the access token it produces lasts ~1 hour.
//
// Setup (one-time):
//   1. Go to https://api-console.zoho.com/ → Add Client → Server-based
//   2. Set redirect URI to https://breeze-os-claude.vercel.app/
//   3. Copy Client ID and Client Secret into Vercel env vars
//   4. Generate an authorization code:
//      https://accounts.zoho.com/oauth/v2/auth?scope=ZohoMCP.tools.ALL&client_id=<ID>&response_type=code&access_type=offline&redirect_uri=<URI>
//   5. Exchange the code for a refresh token:
//      curl -X POST "https://accounts.zoho.com/oauth/v2/token" \
//        -d "grant_type=authorization_code&client_id=<ID>&client_secret=<SECRET>&code=<CODE>&redirect_uri=<URI>"
//   6. Save the refresh_token from the response as ZOHO_REFRESH_TOKEN
//
// If these vars aren't set, we fall back to the static
// ZOHO_MCP_ACCESS_TOKEN env var (manual refresh, ~1 hour lifetime).

const ZOHO_ACCOUNTS_DOMAIN = process.env.ZOHO_ACCOUNTS_DOMAIN || 'accounts.zoho.com';

function canAutoRefresh() {
  return !!(
    process.env.ZOHO_REFRESH_TOKEN &&
    process.env.ZOHO_CLIENT_ID &&
    process.env.ZOHO_CLIENT_SECRET
  );
}

async function refreshAccessToken() {
  const refreshToken = process.env.ZOHO_REFRESH_TOKEN;
  const clientId = process.env.ZOHO_CLIENT_ID;
  const clientSecret = process.env.ZOHO_CLIENT_SECRET;

  if (!refreshToken || !clientId || !clientSecret) {
    throw new Error(
      'Cannot auto-refresh: ZOHO_REFRESH_TOKEN, ZOHO_CLIENT_ID, and ' +
      'ZOHO_CLIENT_SECRET must all be set in Vercel env vars.',
    );
  }

  const url = `https://${ZOHO_ACCOUNTS_DOMAIN}/oauth/v2/token`;
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: clientId,
    client_secret: clientSecret,
  });

  console.log('[zoho-mcp] refreshing access token...');
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });

  const data = await res.json();

  if (!res.ok || data.error) {
    const msg = data.error || `HTTP ${res.status}`;
    console.error('[zoho-mcp] token refresh failed:', msg);
    throw new Error(`Zoho OAuth refresh failed: ${msg}`);
  }

  cachedAccessToken = data.access_token;
  // Zoho tokens last ~3600s; refresh 5 minutes early to avoid races.
  const expiresIn = (data.expires_in || 3600) - 300;
  tokenExpiresAt = Date.now() + expiresIn * 1000;
  console.log(
    `[zoho-mcp] token refreshed, expires in ${expiresIn}s ` +
    `(at ${new Date(tokenExpiresAt).toISOString()})`,
  );
  return cachedAccessToken;
}

// ── Config helpers ───────────────────────────────────────────────

function getServerUrl() {
  const url = process.env.ZOHO_MCP_SERVER_URL;
  if (!url) {
    const err = new Error(
      'ZOHO_MCP_SERVER_URL is not configured. Add it in Vercel → Settings → ' +
      'Environment Variables. The value is the full connection URL from the ' +
      'Zoho MCP admin panel (https://mcp.zoho.com/mcp-client).',
    );
    err.code = 'ZOHO_MCP_URL_MISSING';
    throw err;
  }
  return url;
}

async function getAccessToken() {
  // 1. If we have a cached token that hasn't expired, use it.
  if (cachedAccessToken && Date.now() < tokenExpiresAt) {
    return cachedAccessToken;
  }

  // 2. If auto-refresh is configured, get a fresh token.
  if (canAutoRefresh()) {
    return refreshAccessToken();
  }

  // 3. Fall back to the static env var (manual refresh, ~1hr lifetime).
  const token = process.env.ZOHO_MCP_ACCESS_TOKEN;
  if (!token) {
    const err = new Error(
      'No Zoho access token available. Either:\n' +
      '  (a) Set ZOHO_REFRESH_TOKEN + ZOHO_CLIENT_ID + ZOHO_CLIENT_SECRET ' +
      'for automatic refresh, or\n' +
      '  (b) Set ZOHO_MCP_ACCESS_TOKEN manually (expires every ~1 hour).\n' +
      'See the Zoho MCP setup guide in lib/backends/zohoMcp.js.',
    );
    err.code = 'ZOHO_MCP_TOKEN_MISSING';
    throw err;
  }
  return token;
}

// ── Transport: Streamable HTTP POST with optional SSE response ───

// Sends a JSON-RPC message and returns { ok, status, headers, data }.
// For requests (have `id`), data is the parsed JSON-RPC response.
// For notifications (no `id`), data is null and a 2xx status means OK.
// On a 401, if auto-refresh is configured, refreshes the token and
// retries exactly once before throwing.
async function streamableHttpPost(payload, { expectResponse = true, _retried = false } = {}) {
  const url = getServerUrl();
  const token = await getAccessToken();

  const headers = {
    'Content-Type': 'application/json',
    'Accept': 'application/json, text/event-stream',
    'Authorization': `Bearer ${token}`,
    'MCP-Protocol-Version': MCP_PROTOCOL_VERSION,
  };
  if (sessionId) headers['Mcp-Session-Id'] = sessionId;

  const res = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(payload),
  });

  const returnedSessionId = res.headers.get('mcp-session-id');
  if (returnedSessionId && returnedSessionId !== sessionId) {
    sessionId = returnedSessionId;
  }

  if (!res.ok) {
    const text = await res.text().catch(() => '');

    // Auto-retry on 401 if we can refresh the token. Invalidate the
    // cached token, get a fresh one, and replay the request once.
    if (res.status === 401 && !_retried && canAutoRefresh()) {
      console.warn('[zoho-mcp] 401 — refreshing token and retrying...');
      cachedAccessToken = null;
      tokenExpiresAt = 0;
      resetSession();
      return streamableHttpPost(payload, { expectResponse, _retried: true });
    }

    const err = new Error(
      `Zoho MCP HTTP ${res.status}: ${text.slice(0, 600) || '(empty body)'}`,
    );
    err.status = res.status;
    err.body = text;
    throw err;
  }

  // Notifications: server returns 202 Accepted with no body. Nothing
  // to parse — our work is done.
  if (!expectResponse) {
    return { ok: true, status: res.status, data: null };
  }

  const contentType = res.headers.get('content-type') || '';

  // Plain JSON response path.
  if (contentType.includes('application/json')) {
    const data = await res.json();
    return { ok: true, status: res.status, data };
  }

  // SSE response path. Server sends one or more `data: {json}` lines
  // and closes the stream. We read the whole body (it's short-lived for
  // a single JSON-RPC call, not a long-lived stream), then extract the
  // response that matches our request id.
  if (contentType.includes('text/event-stream')) {
    const text = await res.text();
    const lines = text.split(/\r?\n/);
    for (const line of lines) {
      if (!line.startsWith('data:')) continue;
      const raw = line.slice(5).trim();
      if (!raw || raw === '[DONE]') continue;
      try {
        const parsed = JSON.parse(raw);
        // For requests we care about id match; for notifications
        // (which we don't send through this path anyway) any frame
        // is fine.
        if (!payload.id || parsed.id === payload.id) {
          return { ok: true, status: res.status, data: parsed };
        }
      } catch {
        // Ignore malformed frames — keep reading.
      }
    }
    throw new Error('Zoho MCP SSE stream closed without a matching response');
  }

  // Unknown content type — try JSON as a last resort.
  const text = await res.text();
  try {
    return { ok: true, status: res.status, data: JSON.parse(text) };
  } catch {
    throw new Error(
      `Zoho MCP: unexpected content-type "${contentType}". Body: ${text.slice(0, 200)}`,
    );
  }
}

// JSON-RPC request with response.
async function rpcCall(method, params) {
  const payload = {
    jsonrpc: '2.0',
    id: nextId(),
    method,
    params: params || {},
  };
  const { data } = await streamableHttpPost(payload, { expectResponse: true });
  if (data?.error) {
    const rpcErr = new Error(
      `Zoho MCP ${method} error ${data.error.code}: ${data.error.message}`,
    );
    rpcErr.rpcError = data.error;
    throw rpcErr;
  }
  return data?.result;
}

// JSON-RPC notification (no id, no response).
async function rpcNotify(method, params) {
  const payload = {
    jsonrpc: '2.0',
    method,
    params: params || {},
  };
  await streamableHttpPost(payload, { expectResponse: false });
}

// ── Handshake ────────────────────────────────────────────────────

async function ensureInitialized() {
  if (initialized) return;

  // Step 1: initialize
  await rpcCall('initialize', {
    protocolVersion: MCP_PROTOCOL_VERSION,
    capabilities: CLIENT_CAPABILITIES,
    clientInfo: CLIENT_INFO,
  });

  // Step 2: send the spec-required initialized notification.
  // Must happen BEFORE any other request. Server responds 202 with
  // no body; we don't need anything from it.
  await rpcNotify('notifications/initialized', {});

  initialized = true;
}

// ── Public backend interface ─────────────────────────────────────

export async function getTools() {
  if (!process.env.ZOHO_MCP_SERVER_URL) return [];
  if (!process.env.ZOHO_MCP_ACCESS_TOKEN) return [];

  if (cachedToolList) return cachedToolList;

  try {
    await ensureInitialized();

    // MCP tools/list supports pagination via cursors. Zoho may split
    // its tool catalog across pages (CRM, Cliq, etc. each contribute
    // tools). We loop until there's no nextCursor so we discover the
    // full set — previously we only read the first page, which is why
    // Manus (which handles pagination) saw more tools than we did.
    const allMcpTools = [];
    let cursor = undefined;
    let page = 0;
    do {
      page += 1;
      const params = cursor ? { cursor } : {};
      const result = await rpcCall('tools/list', params);
      const pageTools = Array.isArray(result?.tools) ? result.tools : [];
      allMcpTools.push(...pageTools);
      cursor = result?.nextCursor || null;
      console.log(
        `[zoho-mcp] tools/list page ${page}: ${pageTools.length} tools` +
        (cursor ? ` (nextCursor: ${cursor})` : ' (last page)'),
      );
    } while (cursor);

    console.log(
      `[zoho-mcp] discovered ${allMcpTools.length} tools total: ` +
      allMcpTools.map((t) => t.name).join(', '),
    );

    // Translate MCP tool shape → Anthropic tool shape. Nearly identical;
    // only the input-schema field name differs (`inputSchema` in MCP,
    // `input_schema` in Anthropic).
    cachedToolList = allMcpTools.map((t) => ({
      name: t.name,
      description: t.description || '',
      input_schema: t.inputSchema || {
        type: 'object',
        properties: {},
        required: [],
      },
    }));
    return cachedToolList;
  } catch (err) {
    console.error('[zoho-mcp] tools/list failed:', err.message);
    // Reset session state so a retry gets a fresh handshake.
    resetSession();
    return [];
  }
}

export async function executeTool(toolName, input) {
  if (!process.env.ZOHO_MCP_SERVER_URL) {
    return {
      error:
        'Zoho MCP is not configured. Set ZOHO_MCP_SERVER_URL in Vercel → ' +
        'Settings → Environment Variables (the full connection URL from the ' +
        'Zoho MCP admin panel).',
    };
  }
  if (!process.env.ZOHO_MCP_ACCESS_TOKEN && !canAutoRefresh()) {
    return {
      error:
        'Zoho MCP has no access token and auto-refresh is not configured. ' +
        'Either set ZOHO_REFRESH_TOKEN + ZOHO_CLIENT_ID + ZOHO_CLIENT_SECRET ' +
        'for automatic refresh, or set ZOHO_MCP_ACCESS_TOKEN manually ' +
        '(expires every ~1 hour).',
    };
  }

  try {
    await ensureInitialized();
    const result = await rpcCall('tools/call', {
      name: toolName,
      arguments: input || {},
    });

    if (result?.isError) {
      return {
        error: flattenMcpContent(result.content) || 'Zoho MCP tool returned an error',
      };
    }

    return { result: flattenMcpContent(result?.content) };
  } catch (err) {
    // Session may have expired mid-call — reset so the next invocation
    // redoes the handshake from scratch.
    if (err.status === 401 || err.status === 404) {
      resetSession();
    }
    return { error: err.message || String(err) };
  }
}

function flattenMcpContent(content) {
  if (!Array.isArray(content)) return content;
  const parts = [];
  for (const block of content) {
    if (block?.type === 'text' && typeof block.text === 'string') {
      parts.push(block.text);
    } else {
      parts.push(JSON.stringify(block));
    }
  }
  return parts.join('\n');
}

// ── Diagnostic ───────────────────────────────────────────────────
//
// Used by /api/admin/zoho-mcp-ping. Returns a clearly-labelled status
// object so you can tell at a glance whether the failure is config,
// auth, or something else.

export async function _diagnostic() {
  const hasUrl = !!process.env.ZOHO_MCP_SERVER_URL;
  const hasToken = !!process.env.ZOHO_MCP_ACCESS_TOKEN;
  const hasAutoRefresh = canAutoRefresh();

  if (!hasUrl) {
    return {
      status: 'unconfigured',
      url_set: false,
      token_set: false,
      hint: 'Set ZOHO_MCP_SERVER_URL in Vercel env vars (from https://mcp.zoho.com/mcp-client).',
    };
  }
  if (!hasToken && !hasAutoRefresh) {
    return {
      status: 'missing_token',
      url_set: true,
      token_set: false,
      auto_refresh: false,
      hint:
        'No access token and auto-refresh not configured. Either set ' +
        'ZOHO_REFRESH_TOKEN + ZOHO_CLIENT_ID + ZOHO_CLIENT_SECRET for ' +
        'automatic refresh, or set ZOHO_MCP_ACCESS_TOKEN manually.',
    };
  }

  try {
    // Bust cache so we exercise the full handshake.
    resetSession();
    const tools = await getTools();
    if (tools.length === 0) {
      return {
        status: 'handshake_ok_no_tools',
        url_set: true,
        token_set: true,
        session_id: sessionId,
        hint:
          'Handshake completed but tools/list returned no tools. The Zoho MCP ' +
          'admin panel probably has no services enabled for this client — ' +
          'enable CRM and/or Cliq tools in https://mcp.zoho.com/mcp-client.',
      };
    }
    return {
      status: 'ok',
      url_set: true,
      token_set: true,
      session_id: sessionId,
      tool_count: tools.length,
      tool_names: tools.map((t) => t.name),
    };
  } catch (err) {
    const status = err.status === 401 ? 'auth_failed' : 'error';
    return {
      status,
      url_set: true,
      token_set: true,
      http_status: err.status || null,
      error: err.message,
      hint:
        err.status === 401
          ? 'Access token is invalid or expired. Capture a fresh one with `npx mcp-remote` and update ZOHO_MCP_ACCESS_TOKEN in Vercel.'
          : 'Check Vercel function logs for the full error body.',
    };
  }
}
