// Fetch structured data from Zoho via Anthropic's MCP connector.
//
// The Anthropic API connects to the Zoho MCP server on our behalf,
// discovers tools (Cliq, CRM, Projects, Creator), calls the right
// ones, and returns structured JSON. This helper wraps that flow so
// API endpoints can ask for "tenants" or "properties" and get back
// a plain JS array the frontend can render.
//
// Environment variables:
//   ANTHROPIC_API_KEY    – from console.anthropic.com
//   ZOHO_MCP_SERVER_URL  – Zoho MCP server endpoint (streamable-HTTP).
//                          Falls back to ZOHO_MCP_URL for backward compat.
//   ZOHO_MCP_AUTH_TOKEN  – (optional) Bearer token for the MCP server.
//                          Only needed if the URL-embedded token isn't
//                          enough and Zoho requires an Authorization header.

import Anthropic from '@anthropic-ai/sdk';

const MODEL = 'claude-haiku-4-5';
const MCP_BETA = 'mcp-client-2025-11-20';
const MAX_TOKENS = 4096;

// ── Entity prompts ─────────────────────────────────────────────────
// Each entity type has a system prompt that tells Claude exactly what
// to fetch and what JSON shape to return. Claude discovers the
// available Zoho tools via MCP and picks the right ones.

const ENTITY_PROMPTS = {
  tenants: {
    system:
      'You are a data-fetching assistant. Your ONLY job is to call the available Zoho tools ' +
      'to retrieve tenant/contact/resident records and return them as a JSON array.\n\n' +
      'Instructions:\n' +
      '1. Use the available Zoho tools to list all contacts, tenants, or residents.\n' +
      '2. Return ONLY a raw JSON array — no markdown fences, no explanation, no prose.\n' +
      '3. Each object in the array MUST have these fields (use null for missing):\n' +
      '   { "id", "name", "firstName", "lastName", "email", "phone", "status" }\n' +
      '4. Include any additional fields the Zoho tool returns — map them with camelCase keys.\n' +
      '5. If no records are found, return an empty array: []\n' +
      '6. If a tool errors, return: []\n' +
      '7. Do NOT wrap the JSON in markdown code fences or add any text before/after it.',
    user: 'Fetch all tenant / contact / resident records from Zoho. Return JSON array only.',
  },

  properties: {
    system:
      'You are a data-fetching assistant. Your ONLY job is to call the available Zoho tools ' +
      'to retrieve property records and return them as a JSON array.\n\n' +
      'Instructions:\n' +
      '1. Use the available Zoho tools to list all properties, buildings, or locations.\n' +
      '2. Return ONLY a raw JSON array — no markdown fences, no explanation, no prose.\n' +
      '3. Each object in the array MUST have these fields (use null for missing):\n' +
      '   { "id", "name", "address", "city", "state", "zip", "type" }\n' +
      '4. Include any additional fields the Zoho tool returns — map them with camelCase keys.\n' +
      '5. If no records are found, return an empty array: []\n' +
      '6. If a tool errors, return: []\n' +
      '7. Do NOT wrap the JSON in markdown code fences or add any text before/after it.',
    user: 'Fetch all property / building / location records from Zoho. Return JSON array only.',
  },

  units: {
    system:
      'You are a data-fetching assistant. Your ONLY job is to call the available Zoho tools ' +
      'to retrieve unit / apartment / suite records and return them as a JSON array.\n\n' +
      'Instructions:\n' +
      '1. Use the available Zoho tools to list all units, apartments, or suites.\n' +
      '2. Return ONLY a raw JSON array — no markdown fences, no explanation, no prose.\n' +
      '3. Each object in the array MUST have these fields (use null for missing):\n' +
      '   { "id", "propertyId", "name", "status", "bedrooms", "bathrooms", "sqft", "marketRent" }\n' +
      '4. Include any additional fields the Zoho tool returns — map them with camelCase keys.\n' +
      '5. If no records are found, return an empty array: []\n' +
      '6. If a tool errors, return: []\n' +
      '7. Do NOT wrap the JSON in markdown code fences or add any text before/after it.',
    user: 'Fetch all unit / apartment / suite records from Zoho. Return JSON array only.',
  },
};

// ── Main query function ────────────────────────────────────────────

export async function queryZoho(entity) {
  const mcpUrl = process.env.ZOHO_MCP_SERVER_URL || process.env.ZOHO_MCP_URL;
  if (!mcpUrl) {
    throw Object.assign(
      new Error('ZOHO_MCP_SERVER_URL is not configured. Add it in Vercel → Settings → Environment Variables.'),
      { status: 500 },
    );
  }
  if (!process.env.ANTHROPIC_API_KEY) {
    throw Object.assign(
      new Error('ANTHROPIC_API_KEY not configured.'),
      { status: 500 },
    );
  }

  const prompts = ENTITY_PROMPTS[entity];
  if (!prompts) {
    throw Object.assign(
      new Error(`Unknown entity type: "${entity}". Valid types: ${Object.keys(ENTITY_PROMPTS).join(', ')}`),
      { status: 400 },
    );
  }

  const client = new Anthropic();

  console.log(`[zohoQuery] Fetching entity="${entity}" via MCP (${MCP_BETA}), url=${mcpUrl.slice(0, 60)}...`);

  const response = await client.beta.messages.create({
    model: MODEL,
    max_tokens: MAX_TOKENS,
    betas: [MCP_BETA],
    system: prompts.system,
    messages: [{ role: 'user', content: prompts.user }],
    mcp_servers: [
      {
        type: 'url',
        url: mcpUrl,
        name: 'zoho',
        ...(process.env.ZOHO_MCP_AUTH_TOKEN
          ? { authorization_token: process.env.ZOHO_MCP_AUTH_TOKEN }
          : {}),
      },
    ],
  });

  // Log the full response shape for diagnostics
  const blocks = response.content || [];
  const blockTypes = blocks.map((b) => b.type);
  console.log(`[zohoQuery] Response: stop_reason=${response.stop_reason}, blocks=[${blockTypes.join(', ')}]`);

  // Log any MCP tool use/result blocks for debugging
  for (const block of blocks) {
    if (block.type === 'mcp_tool_use') {
      console.log(`[zohoQuery] MCP tool called: ${block.name}`, JSON.stringify(block.input || {}).slice(0, 200));
    } else if (block.type === 'mcp_tool_result') {
      const preview = typeof block.content === 'string'
        ? block.content.slice(0, 300)
        : JSON.stringify(block.content).slice(0, 300);
      console.log(`[zohoQuery] MCP tool result (error=${!!block.is_error}):`, preview);
    }
  }

  // ── Extract data ─────────────────────────────────────────────────
  // Strategy:
  //   1. Prefer Claude's text summary (it should be JSON per our prompt)
  //   2. Fall back to raw mcp_tool_result content if no text block exists
  //      (Claude may call a tool and return the result without summarising)

  const text = blocks
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('\n')
    .trim();

  // If we got text, try to parse it as JSON
  if (text) {
    const cleaned = text
      .replace(/^```(?:json)?\s*/i, '')
      .replace(/\s*```\s*$/, '')
      .trim();
    try {
      const parsed = JSON.parse(cleaned);
      return Array.isArray(parsed) ? parsed : [parsed];
    } catch (e) {
      console.error(`[zohoQuery] Failed to parse text for entity="${entity}" (${e.message}):`, cleaned.slice(0, 500));
      // Fall through to mcp_tool_result extraction below
    }
  }

  // No parseable text — try to extract data directly from mcp_tool_result blocks
  const toolResults = blocks.filter((b) => b.type === 'mcp_tool_result' && !b.is_error);
  if (toolResults.length > 0) {
    console.log(`[zohoQuery] No text block; extracting from ${toolResults.length} mcp_tool_result block(s)`);
    for (const result of toolResults) {
      const raw = typeof result.content === 'string'
        ? result.content
        : Array.isArray(result.content)
          ? result.content.filter((c) => c.type === 'text').map((c) => c.text).join('\n')
          : JSON.stringify(result.content);
      try {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) return parsed;
        if (parsed && typeof parsed === 'object') {
          // Zoho tools often wrap results in { data: [...] } or { records: [...] }
          const inner = parsed.data || parsed.records || parsed.result || parsed.items;
          if (Array.isArray(inner)) return inner;
          return [parsed];
        }
      } catch {
        // Not JSON — continue to next result block
      }
    }
  }

  // Log errors from MCP tool results if any
  const errorResults = blocks.filter((b) => b.type === 'mcp_tool_result' && b.is_error);
  if (errorResults.length > 0) {
    for (const err of errorResults) {
      console.error(`[zohoQuery] MCP tool error:`, typeof err.content === 'string' ? err.content : JSON.stringify(err.content));
    }
  }

  // Nothing worked
  console.warn(`[zohoQuery] No data extracted for entity="${entity}". Text was: ${(text || '(empty)').slice(0, 300)}`);
  return { _raw: text || '(no text, no tool results)', _parseError: 'Could not extract structured data from response' };
}
