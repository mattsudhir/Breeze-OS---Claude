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
//   ZOHO_CLIQ_WEBHOOK_URL – incoming webhook URL for the target channel.
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
  const webhookUrl = process.env.ZOHO_CLIQ_WEBHOOK_URL;
  if (!webhookUrl) {
    return {
      error:
        'ZOHO_CLIQ_WEBHOOK_URL is not configured. Add it in Vercel → Settings → Environment Variables.',
    };
  }

  const deliveredText = buildNotifyText(input);
  const body = (input.message || input.text || '').trim();
  if (!deliveredText || !body) {
    return { error: 'notify requires a non-empty message' };
  }

  try {
    const res = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
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
