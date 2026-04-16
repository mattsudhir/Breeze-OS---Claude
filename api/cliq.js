// Vercel Serverless Function — Zoho Cliq bot handler.
//
// This is the *inbound* half of the Breeze ↔ Cliq integration. It lets
// Cliq users query Rent Manager from inside a Cliq chat without opening
// the PMS. Users DM the Breeze bot (or @mention it in a channel) and the
// bot replies with data fetched live from RM via the shared Breeze agent.
//
// The outbound half — Breeze AI posting notifications from the web UI
// into a Cliq channel — is the `notify_team` tool in lib/breezeAgent.js
// and uses the ZOHO_CLIQ_WEBHOOK_URL env var.
//
// ── Zoho Cliq configuration ──────────────────────────────────────
// In the Zoho Cliq bot Builder, point the "Message" handler (and
// optionally the "Welcome" handler) at:
//
//   POST https://<your-deployment>/api/cliq?token=<ZOHO_CLIQ_BOT_TOKEN>
//
// The token query-string parameter is how we verify the request came
// from the bot configuration we control. Cliq outgoing webhooks don't
// sign requests natively, so a shared secret in the URL is the standard
// approach. Alternatively the same token may be sent in an
// `X-Breeze-Cliq-Token` header.
//
// ── Environment variables ────────────────────────────────────────
//   ANTHROPIC_API_KEY     – from console.anthropic.com
//   RM_*                  – inherited via lib/rmClient.js
//   ZOHO_CLIQ_BOT_TOKEN   – shared secret validated on every request
//   ZOHO_CLIQ_WEBHOOK_URL – used by the notify_team tool (outbound only)

import { runAgent } from '../lib/breezeAgent.js';

// ── System prompt (Cliq bot) ─────────────────────────────────────
// Cliq-specific tweaks: no SHOWME markers (there's no UI to render
// them), single-asterisk bold per Cliq's markdown dialect, and a short
// reminder that responses are shown in a mobile chat bubble.

const CLIQ_SYSTEM_PROMPT = `You are Breeze AI, a friendly and efficient property-management assistant built on top of Rent Manager. You are replying inside a Zoho Cliq chat so that the property manager can query their portfolio — tenants, properties, units, leases, maintenance, and balances — without opening the PMS.

You have tools to query Rent Manager live. Use them whenever the user asks about real data. Prefer calling tools over guessing.

When a user asks about a specific tenant:
1. Call search_tenants first to find the right TenantID (it returns only name/id/status — no contact info).
2. For ANY question about that tenant's email, phone, lease, balance, or address, you MUST call get_tenant_details with that id. Do not answer contact or financial questions using only search_tenants — that data is not included there.

Style (Cliq-specific):
- Keep responses short and scannable. Aim for under ~250 words; Cliq messages are read on mobile.
- Use Cliq markdown: *bold* (single asterisks), _italic_, \`inline code\`. Do NOT use **double-asterisk** bold — it will render literally.
- When listing items (tenants, units, work orders), use a short bulleted list with "- " markers rather than long paragraphs.
- When you cite a person, use their full name. When you cite a unit, use its name (not just id).
- Format currency as $X,XXX.XX. Format dates naturally (e.g. "April 12, 2026").
- Never emit [SHOWME ...] markers — they only work in the Breeze web UI.

Error handling (important):
- If a tool returns an object containing an "error" field, do NOT paraphrase it. Report it verbatim prefixed with "Tool error:" so the user sees exactly what Rent Manager returned. Example: "Tool error: Could not fetch work orders (HTTP 404): No resource found at /ServiceManagerIssues". Do not retry the same tool call if it just errored.

Notifications from Cliq:
- If the user explicitly asks you to notify, ping, alert, or message another team from within Cliq (e.g. "notify the plumbing team about WO-57"), use the notify_team tool. It will post into the configured team channel — which may be a different channel than the one you're currently replying in. After it succeeds, confirm briefly (e.g. "Sent to the team channel.").
- Never auto-notify. If the intent is ambiguous, ask before sending.

Zoho tools (when available):
- You may also have access to Zoho tools (Cliq, CRM, Projects, Creator) via the Zoho MCP server. These are discovered automatically.
- Use Zoho CRM tools for leads, deals, contacts, or accounts. Use Zoho Projects tools for project tasks or milestones. Use Zoho Creator tools for custom Zoho Creator apps or forms.
- For simple Cliq notifications, prefer the local notify_team tool. Use Zoho Cliq MCP tools only for richer operations (listing teams, exporting messages, managing members, etc.).
- If a Zoho tool returns an error, surface it verbatim per the error-handling rule above.`;

// ── Helpers ──────────────────────────────────────────────────────

// Extract the raw user message text from whatever shape Cliq's
// outgoing webhook sent. The Message handler sends { message: "text" }
// in the common case, but some Cliq configurations wrap it as
// { message: { text: "..." } } or pass it inside `arguments`.
function extractMessageText(body = {}) {
  if (!body || typeof body !== 'object') return '';

  const raw =
    (typeof body.message === 'string' && body.message) ||
    (body.message && typeof body.message.text === 'string' && body.message.text) ||
    (typeof body.text === 'string' && body.text) ||
    (typeof body.arguments === 'string' && body.arguments) ||
    '';

  return raw.trim();
}

// Strip any lingering [SHOWME ...] marker in case the model emits one
// despite the system prompt telling it not to. Belt-and-braces.
function stripShowMeMarkers(text) {
  return text.replace(/\[SHOWME[^\]]*\]/g, '').replace(/\n{3,}/g, '\n\n').trim();
}

// Convert **double-asterisk** markdown (Claude's default) to *single* so
// it renders correctly in Cliq. This is a best-effort pass — only rewrite
// balanced pairs so stray asterisks aren't mangled.
function toCliqMarkdown(text) {
  return text.replace(/\*\*([^*\n]+?)\*\*/g, '*$1*');
}

// Verify the shared secret. Accepts either ?token= or X-Breeze-Cliq-Token
// header. If ZOHO_CLIQ_BOT_TOKEN is not configured, reject — we won't run
// open to the internet.
function verifyToken(req) {
  const expected = process.env.ZOHO_CLIQ_BOT_TOKEN;
  if (!expected) {
    return { ok: false, reason: 'ZOHO_CLIQ_BOT_TOKEN is not configured on the server.' };
  }
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const queryToken = url.searchParams.get('token');
  const headerToken =
    req.headers['x-breeze-cliq-token'] || req.headers['x-cliq-bot-token'] || '';
  const supplied = queryToken || headerToken;
  if (!supplied || supplied !== expected) {
    return { ok: false, reason: 'Invalid or missing bot token.' };
  }
  return { ok: true };
}

// Build a Cliq bot reply body. Cliq accepts `{ text, card, slides, bot }`,
// BUT the moment any of `card`, `slides`, or `bot` is present Cliq renders
// a card container and pulls the body out of `slides`. If there are no
// slides, Cliq drops our `text` on the floor and shows its built-in
// "<bot.name> didn't return a response" placeholder instead — which is
// exactly what we were seeing on every message.
//
// The reliable shape is the plain `{text}` form. Bot attribution still
// works because Cliq uses the bot name configured in the Bot Builder.
function cliqReply(text) {
  return { text };
}

// ── HTTP handler ─────────────────────────────────────────────────

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Breeze-Cliq-Token');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'POST only' });
  }

  const auth = verifyToken(req);
  if (!auth.ok) {
    console.warn('[cliq] rejected request:', auth.reason);
    return res.status(401).json({ error: auth.reason });
  }

  const body = req.body || {};
  // Accept both Cliq's native nested shape (body.handler.name) and a
  // flat `handler_name` field — Deluge's Map.toString() doesn't reliably
  // serialise nested maps as JSON, so the Deluge handlers we ship send
  // the field flat to avoid that hazard.
  const handlerName = body?.handler?.name || body?.handler_name || body?.name || '';
  const userName =
    body?.user?.first_name ||
    body?.user?.name ||
    body?.user?.email ||
    body?.user_name ||
    'there';

  // Welcome handler — Cliq fires this when a user first installs /
  // opens a chat with the bot. Return a friendly intro so they know
  // what to ask.
  if (handlerName === 'welcome') {
    return res.status(200).json(
      cliqReply(
        `Hi ${userName}! I'm *Breeze AI*, your property-management copilot. ` +
          `Ask me things like:\n` +
          `- "how many open urgent work orders?"\n` +
          `- "what's Marcia Clark's balance?"\n` +
          `- "list units at Oakwood"\n` +
          `- "notify the plumbing team about WO-57"\n\n` +
          `I pull data live from Rent Manager — no need to open the PMS.`,
      ),
    );
  }

  const userMessage = extractMessageText(body);
  if (!userMessage) {
    return res.status(200).json(
      cliqReply(
        `I didn't see any text in that message, ${userName}. Try asking me about a tenant, unit, or work order.`,
      ),
    );
  }

  try {
    // Each inbound Cliq message is treated as a single-turn conversation.
    // Multi-turn memory would need a shared store (e.g. Vercel KV) since
    // serverless instances don't share RAM — out of scope for v1.
    const { reply } = await runAgent(
      [{ role: 'user', content: userMessage }],
      { systemPrompt: CLIQ_SYSTEM_PROMPT },
    );

    const cleaned = toCliqMarkdown(stripShowMeMarkers(reply));
    return res.status(200).json(cliqReply(cleaned || 'No response.'));
  } catch (err) {
    console.error('Cliq handler error:', err);
    // Always return 200 with an error bubble so the user sees the message
    // in-channel rather than a silent failure. Cliq surfaces non-2xx
    // responses as a generic "bot failed" error.
    const msg =
      err?.status === 500 && err?.message
        ? `Breeze AI is misconfigured: ${err.message}`
        : `Sorry, something went wrong talking to Rent Manager: ${err?.message || 'unknown error'}`;
    return res.status(200).json(cliqReply(msg));
  }
}
