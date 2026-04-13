// Shared helper for posting messages into the team Zoho Cliq channel.
//
// Two callers live on top of this:
//   1. The `notify_team` tool in lib/breezeAgent.js — triggered when a
//      chat user (web or Cliq) asks Breeze AI to notify someone.
//   2. /api/notify — a plain HTTP endpoint for programmatic callers
//      (e.g. the frontend firing a notification when Breeze OS is
//      requested somewhere in the UI, or a background job posting a
//      status update).
//
// Environment variables:
//   ZOHO_CLIQ_WEBHOOK_URL – outbound endpoint for the target Cliq bot or
//     channel. Two supported shapes:
//       1. Bot incoming endpoint:
//            https://cliq.zoho.com/api/v2/bots/<botname>/incoming
//          These require an OAuth token in the Authorization header —
//          we read it from ZOHO_CLIQ_BOT_TOKEN and send it as
//            Authorization: Zoho-oauthtoken <token>
//       2. Channel incoming webhook (legacy Zapier-style):
//            https://cliq.zoho.com/api/v2/channelsbyname/<channel>/message?zapikey=xxx
//          These authenticate entirely through the zapikey query param,
//          so we send the request verbatim with no Authorization header.
//     The helper auto-detects which shape the URL is.
//   ZOHO_CLIQ_BOT_TOKEN – Zoho OAuth access token for the bot. Shared
//     with the inbound /api/cliq verification path. Only used as an
//     Authorization header — NOT appended to the URL (Cliq's bot
//     endpoints reject zapikey query params with 401
//     "Invalid OAuth token passed").
//
// The helper returns a plain { success, error?, delivered_text?, sent_to? }
// shape so both callers can surface a consistent result.

// Build the delivered message text. If the caller passes a pre-formatted
// `text`, it wins. Otherwise we compose a standard "📢 Notify <recipient>"
// header + body + attribution line.
export function buildNotifyText({ text, recipient, message, context }) {
  if (typeof text === 'string' && text.trim()) return text.trim();

  const who = (recipient || 'the team').trim();
  const body = (message || '').trim();
  const ctx = context ? ` · ${context}` : '';
  return `📢 *Notify ${who}*${ctx}\n${body}\n\n_Sent via Breeze AI_`;
}

// Resolve the outbound request config (URL + headers) from env. Exported
// for tests; regular callers use postToCliq.
//
// Returns { url, headers } on success or { error } if the config is
// missing/inconsistent. Never mutates the URL — Cliq's bot /incoming
// endpoints reject ?zapikey= query params with 401 "Invalid OAuth token
// passed", so the token goes in the Authorization header instead.
export function resolveWebhookRequest() {
  const base = process.env.ZOHO_CLIQ_WEBHOOK_URL;
  if (!base) {
    return {
      error:
        'ZOHO_CLIQ_WEBHOOK_URL is not configured. Add it in Vercel → Settings → Environment Variables.',
    };
  }

  const headers = { 'Content-Type': 'application/json' };

  // Channel incoming webhook: auth lives in the ?zapikey=... query param
  // that the URL itself already carries. Send the request as-is.
  if (/[?&]zapikey=/.test(base)) {
    return { url: base, headers };
  }

  // Bot incoming endpoint: authenticate with OAuth bearer header.
  const token = process.env.ZOHO_CLIQ_BOT_TOKEN;
  if (token) {
    headers.Authorization = `Zoho-oauthtoken ${token}`;
  }
  return { url: base, headers };
}

// Post a notification to the configured Zoho Cliq channel.
//
// Accepts either:
//   { text }                                     – raw pre-formatted text
//   { recipient, message, context }              – structured, we format it
//
// Returns { success: true, sent_to, delivered_text } on success, or
// { error: '...' } on any failure. Never throws — callers can surface the
// error field verbatim to the user.
export async function postToCliq(input = {}) {
  const resolved = resolveWebhookRequest();
  if (resolved.error) return { error: resolved.error };
  const { url, headers } = resolved;

  const deliveredText = buildNotifyText(input);
  const body = (input.message || input.text || '').trim();
  if (!deliveredText || !body) {
    return { error: 'notify requires a non-empty message' };
  }

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        text: deliveredText,
        bot: { name: 'Breeze AI' },
      }),
    });
    if (!res.ok) {
      const errText = await res.text();
      return {
        error: `Zoho Cliq webhook failed (HTTP ${res.status}): ${errText.slice(0, 400)}`,
      };
    }
    return {
      success: true,
      sent_to: (input.recipient || 'the team').trim(),
      delivered_text: deliveredText,
    };
  } catch (err) {
    return { error: `Zoho Cliq request failed: ${err.message}` };
  }
}
