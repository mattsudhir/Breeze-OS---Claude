// Zoho MCP (Model Context Protocol) backend.
//
// Connects to a Zoho-hosted MCP server that exposes tools over Zoho's
// products — Cliq, CRM, and whatever else your Zoho MCP admin panel
// enables. MCP is Anthropic's open protocol for connecting AI
// assistants to external tools/data; Zoho ships their own server at
// https://mcp.zoho.com/mcp-client. Once an MCP server is configured
// on their side and we have a connection URL + auth token, we can
// call its tools from Breeze's chat.
//
// ── Configuration ────────────────────────────────────────────────
//
// Environment variable:
//   ZOHO_MCP_SERVER_URL  — full connection URL provided by the Zoho
//                          MCP admin panel. This URL contains an
//                          embedded auth token in its path, so it
//                          IS a credential and must live in Vercel
//                          env vars, not in git. Example shape:
//                          https://<tenant>.zohomcp.com/mcp/<token>/message
//
// If the env var is missing, all tool calls return a clear "not
// configured" error and getTools() returns an empty list. This makes
// the backend safely selectable in the UI even before Zoho MCP is
// wired up — users just get an error message telling them what to
// do, rather than the chat crashing.
//
// ── Transport ────────────────────────────────────────────────────
//
// Zoho's MCP server uses HTTP POST for JSON-RPC requests. We send
// an MCP `initialize` handshake on first use, then `tools/list` to
// discover what tools the server offers, and pass those through to
// Claude as tool definitions. When Claude calls a tool, we forward
// the call via `tools/call`.
//
// The exact response format (plain JSON vs SSE stream) varies by
// server; this client handles both. If the server uses SSE, we read
// the stream and concatenate `data:` lines until we see `event: done`
// or the stream closes.
//
// ── State ────────────────────────────────────────────────────────
//
// Tool list and session initialization are cached in module scope.
// On Vercel this means "per serverless function instance": a cold
// start re-runs discovery, a warm instance reuses the cached list.
// This is the same lifetime pattern lib/rmClient.js uses for its
// session token and works fine in practice.

export const name = 'zoho-mcp';
export const displayName = 'Zoho MCP';
export const description =
  'Zoho MCP server (mcp.zoho.com). Exposes tools over Zoho CRM, Cliq, ' +
  'and other Zoho products via the Model Context Protocol. Requires ' +
  'ZOHO_MCP_SERVER_URL env var.';

export const systemPromptAddendum = [
  'Data source: Zoho MCP server.',
  '',
  'Tool set is discovered dynamically from the MCP server and may ' +
  'include Zoho CRM (contacts, deals, accounts) and Zoho Cliq (channels, ' +
  'messages), depending on what the admin has enabled. Tool names and ' +
  'inputs are authoritative from the MCP server.',
  '',
  'If a tool returns an error about missing Zoho scopes, surface it ' +
  'verbatim — those fix in the Zoho MCP admin panel, not in Breeze.',
].join('\n');

// ── Minimal JSON-RPC 2.0 client ──────────────────────────────────

let rpcId = 0;
function nextId() {
  rpcId += 1;
  return rpcId;
}

// Cached tool list + "initialize" handshake state. Reset on error.
let cachedToolList = null;
let initialized = false;

function getServerUrl() {
  const url = process.env.ZOHO_MCP_SERVER_URL;
  if (!url) {
    throw new Error(
      'ZOHO_MCP_SERVER_URL is not configured. Add it in Vercel → Settings → ' +
      'Environment Variables. The value is the full connection URL from the ' +
      'Zoho MCP admin panel (https://mcp.zoho.com/mcp-client).',
    );
  }
  return url;
}

async function rpcCall(method, params) {
  const url = getServerUrl();
  const body = {
    jsonrpc: '2.0',
    id: nextId(),
    method,
    params: params || {},
  };

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json, text/event-stream',
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(
      `Zoho MCP HTTP ${res.status} on ${method}: ${text.slice(0, 400)}`,
    );
  }

  const contentType = res.headers.get('content-type') || '';

  // Plain JSON response path.
  if (contentType.includes('application/json')) {
    const data = await res.json();
    if (data.error) {
      throw new Error(
        `Zoho MCP ${method} error ${data.error.code}: ${data.error.message}`,
      );
    }
    return data.result;
  }

  // SSE stream path. MCP over SSE emits each JSON-RPC response as a
  // `data: {...}` line. We read until we see a response matching our
  // request id, then bail.
  if (contentType.includes('text/event-stream')) {
    const text = await res.text();
    const lines = text.split(/\r?\n/);
    for (const line of lines) {
      if (!line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (!payload || payload === '[DONE]') continue;
      try {
        const parsed = JSON.parse(payload);
        if (parsed.id === body.id) {
          if (parsed.error) {
            throw new Error(
              `Zoho MCP ${method} error ${parsed.error.code}: ${parsed.error.message}`,
            );
          }
          return parsed.result;
        }
      } catch (err) {
        // Ignore malformed SSE frames — keep reading.
        if (err.message?.startsWith('Zoho MCP')) throw err;
      }
    }
    throw new Error(`Zoho MCP ${method}: SSE stream closed without a matching response`);
  }

  // Unknown content type — try to parse as JSON, fall back to text.
  const text = await res.text();
  try {
    const data = JSON.parse(text);
    if (data.error) {
      throw new Error(
        `Zoho MCP ${method} error ${data.error.code}: ${data.error.message}`,
      );
    }
    return data.result;
  } catch {
    throw new Error(
      `Zoho MCP ${method}: unexpected content-type "${contentType}". Body: ${text.slice(0, 200)}`,
    );
  }
}

async function ensureInitialized() {
  if (initialized) return;
  await rpcCall('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: {
      name: 'breeze-os',
      version: '0.1.0',
    },
  });
  initialized = true;
}

// ── Public backend interface ─────────────────────────────────────

export async function getTools() {
  // If the env var is missing, surface an empty list rather than
  // crashing. The LLM will have nothing to call, so it will fall back
  // to pure conversation and explain the situation.
  if (!process.env.ZOHO_MCP_SERVER_URL) return [];

  if (cachedToolList) return cachedToolList;

  try {
    await ensureInitialized();
    const result = await rpcCall('tools/list', {});
    const mcpTools = Array.isArray(result?.tools) ? result.tools : [];

    // Translate MCP tool shape → Anthropic tool shape. They're nearly
    // identical — both use JSON Schema for the input schema — the only
    // difference is the field name (`inputSchema` in MCP, `input_schema`
    // in Anthropic).
    cachedToolList = mcpTools.map((t) => ({
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
    // If discovery fails, return empty so the chat still works.
    // Cache null so the next call retries (don't pin the error).
    console.error('[zoho-mcp] tools/list failed:', err.message);
    cachedToolList = null;
    initialized = false;
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

  try {
    await ensureInitialized();
    const result = await rpcCall('tools/call', {
      name: toolName,
      arguments: input || {},
    });

    // MCP `tools/call` returns { content: [{ type, text, ... }], isError? }
    // We unwrap the content array to a flat result shape the LLM can
    // read. If the server flags an error, surface it explicitly.
    if (result?.isError) {
      return {
        error: flattenMcpContent(result.content) || 'Zoho MCP tool returned an error',
      };
    }

    return {
      result: flattenMcpContent(result?.content),
    };
  } catch (err) {
    return { error: err.message || String(err) };
  }
}

function flattenMcpContent(content) {
  if (!Array.isArray(content)) return content;
  // Most MCP servers return a single text block; concatenate any text
  // blocks and pass structured blocks through as-is.
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

// Test helpers — used by the /api/admin/zoho-mcp-ping diagnostic
// endpoint to verify connectivity without going through the agent loop.
export async function _diagnostic() {
  const hasUrl = !!process.env.ZOHO_MCP_SERVER_URL;
  if (!hasUrl) {
    return { configured: false, error: 'ZOHO_MCP_SERVER_URL not set' };
  }
  try {
    // Bust the cache so we always exercise the full path.
    cachedToolList = null;
    initialized = false;
    const tools = await getTools();
    return {
      configured: true,
      tool_count: tools.length,
      tool_names: tools.map((t) => t.name),
    };
  } catch (err) {
    return { configured: true, error: err.message };
  }
}
