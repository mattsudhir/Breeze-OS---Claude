// Vercel Serverless Function — Zoho Cliq Message Handler endpoint.
//
// This is the "Cliq → Breeze" direction of the two-way integration.
// Register this function's public URL as the external Message Handler
// on the `executiveassistant` bot in Zoho Cliq. When a Cliq user mentions
// or DMs the bot, Zoho POSTs a JSON payload here; we verify it, run the
// shared Breeze agent, and return the reply in Cliq's expected shape.
//
// Environment variables:
//   ANTHROPIC_API_KEY     – from console.anthropic.com
//   ZOHO_CLIQ_BOT_TOKEN   – shared secret. Configure the SAME token in
//                           Zoho Cliq → Bot → Edit Configuration → Message
//                           Handler → (pass it via Authorization header or
//                           ?token= query param). Any request without it
//                           gets 401'd.
//   RM_BASE_URL, RM_USERNAME, RM_PASSWORD – inherited via lib/rmClient.js
//   ZOHO_CLIQ_WEBHOOK_URL – optional, enables notify_team from Cliq too
//
// Zoho Cliq request shape (simplified):
//   {
//     "handler": { "name": "...", "type": "..." },
//     "message": "the user's text",            // or message.text
//     "user":    { "id", "first_name", ... },
//     "chat":    { "id", "title", "type" },
//     ...
//   }
//
// Zoho Cliq response shape (what we return):
//   { "text": "the bot's reply" }
// Optional richer replies can use { text, card, slides, buttons } — we
// keep it simple for now since Cliq renders markdown-ish formatting in
// the `text` field directly.

import Anthropic from '@anthropic-ai/sdk';
import { runAgent, stripShowMe } from '../lib/breezeAgent.js';

// Reply Cliq accepts even on error paths — the user sees this in-chat.
function cliqReply(text) {
  return { text };
}

// Pull the user's text out of whatever Cliq sent. Different handler types
// put the message in slightly different places; check the common ones.
function extractMessage(body) {
  if (!body || typeof body !== 'object') return '';
  if (typeof body.message === 'string') return body.message;
  if (body.message && typeof body.message.text === 'string') return body.message.text;
  if (typeof body.text === 'string') return body.text;
  // Mention handler sends the content under `message.content` on some plans
  if (body.message && typeof body.message.content === 'string') return body.message.content;
  return '';
}

// Verify the request is actually from Zoho Cliq. We accept the shared
// secret in either an Authorization header or a ?token= query param, so
// it works whichever way the bot handler is configured.
function verifyAuth(req) {
  const expected = process.env.ZOHO_CLIQ_BOT_TOKEN;
  if (!expected) {
    return { ok: false, reason: 'ZOHO_CLIQ_BOT_TOKEN not configured on the server' };
  }

  const auth = req.headers['authorization'] || req.headers['Authorization'] || '';
  // Zoho typically sends "Zoho-oauthtoken <token>" — accept both that and
  // a plain "Bearer <token>" just in case.
  const authMatch = auth.match(/^(?:Zoho-oauthtoken|Bearer)\s+(.+)$/i);
  const headerToken = authMatch ? authMatch[1].trim() : null;

  const queryToken =
    (req.query && req.query.token) ||
    (req.url && new URL(req.url, 'http://x').searchParams.get('token'));

  const provided = headerToken || queryToken;
  if (!provided) return { ok: false, reason: 'Missing bot token' };
  if (provided !== expected) return { ok: false, reason: 'Invalid bot token' };
  return { ok: true };
}

export default async function handler(req, res) {
  // Cliq will POST; allow OPTIONS for any smoke-test tooling.
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') {
    return res.status(405).json(cliqReply('This endpoint only accepts POST requests.'));
  }

  // 1. Auth — reject unsigned requests so randos can't hit Rent Manager
  //    through our Anthropic budget.
  const auth = verifyAuth(req);
  if (!auth.ok) {
    console.warn('[cliq-bot] auth rejected:', auth.reason);
    return res.status(401).json(cliqReply(`Unauthorized: ${auth.reason}`));
  }

  // 2. Extract the user's message from Cliq's payload.
  const userText = extractMessage(req.body).trim();
  if (!userText) {
    return res.status(200).json(
      cliqReply("I didn't catch a message there. Ask me something like \"show me open work orders\" or \"what's Marcia Clark's balance?\""),
    );
  }

  // Optional: log who's asking, for debugging. No PII beyond what Cliq
  // already has.
  const userName =
    req.body?.user?.first_name ||
    req.body?.user?.name ||
    req.body?.user?.email ||
    'unknown';
  console.log(`[cliq-bot] ${userName}: ${userText.slice(0, 200)}`);

  // 3. Run the shared Breeze agent. Each Cliq turn is stateless for now —
  //    we don't persist per-chat history across requests. If we want
  //    multi-turn memory later, key a KV store by chat.id + user.id.
  try {
    const { reply } = await runAgent([{ role: 'user', content: userText }]);
    // Cliq users don't have the Breeze UI to drill into, so strip any
    // SHOWME marker before sending.
    const cleaned = stripShowMe(reply);
    return res.status(200).json(cliqReply(cleaned));
  } catch (err) {
    console.error('[cliq-bot] agent error:', err);
    if (err instanceof Anthropic.AuthenticationError) {
      return res.status(200).json(cliqReply('Tool error: Anthropic API key is invalid.'));
    }
    if (err instanceof Anthropic.RateLimitError) {
      return res.status(200).json(cliqReply('Rate limited — try again in a moment.'));
    }
    // Always return 200 + a cliqReply so the user sees the error in-chat
    // instead of Cliq showing a generic "bot failed" warning.
    return res.status(200).json(
      cliqReply(`Tool error: ${err.message || 'Unknown error running the Breeze agent.'}`),
    );
  }
}
