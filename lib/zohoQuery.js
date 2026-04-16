// Fetch structured data from Zoho via Anthropic's MCP connector.
//
// The Anthropic API connects to the Zoho MCP server on our behalf,
// discovers tools (Cliq, CRM, Projects, Creator), calls the right
// ones, and returns structured JSON. This helper wraps that flow so
// API endpoints can ask for "tenants" or "properties" and get back
// a plain JS array the frontend can render.
//
// Environment variables:
//   ANTHROPIC_API_KEY – from console.anthropic.com
//   ZOHO_MCP_URL      – Zoho MCP server endpoint (streamable-HTTP)

import Anthropic from '@anthropic-ai/sdk';

const MODEL = 'claude-haiku-4-5';
const MCP_BETA = 'mcp-client-2025-04-04';
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
  const mcpUrl = process.env.ZOHO_MCP_URL;
  if (!mcpUrl) {
    throw Object.assign(
      new Error('ZOHO_MCP_URL is not configured. Add it in Vercel → Settings → Environment Variables.'),
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
      },
    ],
  });

  // Extract text from the response
  const text = (response.content || [])
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('\n')
    .trim();

  if (!text) {
    console.warn(`[zohoQuery] Empty response for entity="${entity}"`);
    return [];
  }

  // Strip markdown code fences if Claude added them despite instructions
  const cleaned = text
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```\s*$/, '')
    .trim();

  try {
    const parsed = JSON.parse(cleaned);
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch (err) {
    console.error(`[zohoQuery] Failed to parse response for entity="${entity}":`, cleaned.slice(0, 500));
    // Return the raw text wrapped in a diagnostic object so the caller
    // can decide how to surface it.
    return { _raw: cleaned, _parseError: err.message };
  }
}
