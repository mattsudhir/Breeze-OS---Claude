// Vercel Serverless Function — fetch structured data from Zoho via MCP.
//
// The frontend calls this endpoint to populate the Tenants, Properties,
// and Units pages. Under the hood it uses the Anthropic MCP connector:
// Claude connects to the Zoho MCP server, discovers available tools,
// calls the right ones, and returns structured JSON.
//
// Query params:
//   entity (required) – "tenants" | "properties" | "units"
//
// Environment variables:
//   ANTHROPIC_API_KEY – from console.anthropic.com
//   ZOHO_MCP_URL      – Zoho MCP server endpoint

import { queryZoho } from '../lib/zohoQuery.js';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' });

  const entity = (req.query.entity || '').toLowerCase().trim();
  if (!entity) {
    return res.status(400).json({ error: 'Missing ?entity= parameter. Valid: tenants, properties, units' });
  }

  try {
    const data = await queryZoho(entity);

    // If queryZoho returned a parse-error diagnostic, surface it
    if (data && data._parseError) {
      console.error(`[zoho-data] Parse error for entity="${entity}":`, data._parseError);
      return res.status(200).json({
        ok: true,
        data: [],
        warning: `Zoho returned data but it could not be parsed as JSON. Raw preview: ${(data._raw || '').slice(0, 200)}`,
      });
    }

    return res.status(200).json({
      ok: true,
      data,
      count: Array.isArray(data) ? data.length : 0,
    });
  } catch (err) {
    console.error(`[zoho-data] Error fetching entity="${entity}":`, err);
    return res.status(err.status || 500).json({
      error: err.message || 'Unknown error fetching Zoho data',
    });
  }
}
