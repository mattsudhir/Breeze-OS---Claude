// Vercel Serverless Function — LLM chat with tool use.
//
// Takes a list of chat messages from the frontend and delegates to the
// shared Breeze agent in lib/breezeAgent.js. Returns the final natural-
// language answer. Accepts an optional `dataSource` field in the request
// body selecting which backend ('appfolio' | 'rm-demo' | 'breeze' |
// 'zoho-mcp') the agent should read from — defaults to 'appfolio'
// (Breeze Property Group production data via AppFolio Database API).
//
// Environment variables:
//   ANTHROPIC_API_KEY     – from console.anthropic.com
//   APPFOLIO_CLIENT_ID / APPFOLIO_CLIENT_SECRET / APPFOLIO_DEVELOPER_ID
//                         – used by the 'appfolio' backend (default)
//   RM_BASE_URL / RM_USERNAME / RM_PASSWORD – used by 'rm-demo'
//   DATABASE_URL          – used by the 'breeze' backend
//   ZOHO_MCP_SERVER_URL   – used by 'zoho-mcp'
//   ZOHO_CLIQ_WEBHOOK_URL – optional, used by the notify_team tool

import Anthropic from '@anthropic-ai/sdk';
import { runAgent } from '../lib/breezeAgent.js';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  if (!process.env.ANTHROPIC_API_KEY) {
    return res.status(500).json({
      error: 'ANTHROPIC_API_KEY not configured. Add it in Vercel → Settings → Environment Variables.',
    });
  }

  try {
    const { messages: inputMessages = [], dataSource } = req.body || {};
    if (!Array.isArray(inputMessages) || inputMessages.length === 0) {
      return res.status(400).json({ error: 'messages array required' });
    }

    const { reply, iterations } = await runAgent(inputMessages, { dataSource });

    return res.status(200).json({
      ok: true,
      reply,
      iterations,
      dataSource: dataSource || 'appfolio',
    });
  } catch (err) {
    console.error('Chat handler error:', err);
    if (err instanceof Anthropic.AuthenticationError) {
      return res.status(401).json({ error: 'Invalid Anthropic API key' });
    }
    if (err instanceof Anthropic.RateLimitError) {
      return res.status(429).json({ error: 'Rate limited — try again in a moment' });
    }
    if (err instanceof Anthropic.APIError) {
      return res.status(err.status || 500).json({ error: err.message });
    }
    return res.status(err.status || 500).json({ error: err.message || 'Unknown error' });
  }
}
