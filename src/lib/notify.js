// Frontend helper for posting notifications into the team Zoho Cliq
// channel via /api/notify. Any React component can import this and fire
// a notification without needing to know about the webhook or the payload
// shape.
//
// Usage:
//
//   import { notifyCliq } from '../lib/notify';
//
//   // Pre-formatted text:
//   await notifyCliq({ text: '🚀 Someone just clicked "Request Breeze OS"' });
//
//   // Structured (lets the server format the header line):
//   await notifyCliq({
//     recipient: 'the sales team',
//     message: 'Acme Realty requested a Breeze OS demo',
//     context: 'via Chat Home',
//   });
//
// Returns { success: true, sent_to, delivered_text } on success or
// { error } on failure. Never throws — safe to call fire-and-forget.

export async function notifyCliq(payload) {
  try {
    const res = await fetch('/api/notify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload || {}),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      return { error: data.error || `HTTP ${res.status}` };
    }
    return data;
  } catch (err) {
    return { error: err.message || 'Network error' };
  }
}
