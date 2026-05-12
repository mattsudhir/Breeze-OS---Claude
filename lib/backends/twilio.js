// Twilio backend — SMS sender, webhook verification, message
// reconciliation poll.
//
// Env vars:
//   TWILIO_ACCOUNT_SID    required
//   TWILIO_AUTH_TOKEN     required
//   TWILIO_MESSAGING_SERVICE_SID  optional (if using a Messaging Service
//                                  for routing instead of raw from-numbers)

import crypto from 'node:crypto';

const BASE_URL = 'https://api.twilio.com';

export function isTwilioConfigured() {
  return Boolean(process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN);
}

function basicAuth() {
  const creds = `${process.env.TWILIO_ACCOUNT_SID}:${process.env.TWILIO_AUTH_TOKEN}`;
  return `Basic ${Buffer.from(creds).toString('base64')}`;
}

function apiUrl(path) {
  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  return `${BASE_URL}/2010-04-01/Accounts/${accountSid}${path}`;
}

/**
 * Send an SMS via Twilio.
 *
 * @param {object} params
 * @param {string} params.from   E.164 sender number (must be a number on the account)
 * @param {string} params.to     E.164 recipient
 * @param {string} params.body   message text
 * @param {string} [params.statusCallback] our webhook URL for status updates
 * @returns {Promise<{ sid: string, status: string, raw: object }>}
 */
export async function sendSms(params) {
  const { from, to, body, statusCallback } = params;
  if (!from) throw new Error('sendSms: from required');
  if (!to) throw new Error('sendSms: to required');
  if (!body) throw new Error('sendSms: body required');
  if (!isTwilioConfigured()) throw new Error('Twilio not configured');

  const form = new URLSearchParams({ From: from, To: to, Body: body });
  if (statusCallback) form.append('StatusCallback', statusCallback);

  const res = await fetch(apiUrl('/Messages.json'), {
    method: 'POST',
    headers: {
      'Authorization': basicAuth(),
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: form.toString(),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Twilio sendSms failed: HTTP ${res.status} ${text.slice(0, 300)}`);
  }
  const json = await res.json();
  return { sid: json.sid, status: json.status, raw: json };
}

/**
 * List recent messages (for reconciliation poll).
 *
 * @param {object} opts
 * @param {string} opts.dateSentAfter   ISO timestamp; only messages after this
 * @param {number} [opts.pageSize]      default 50, max 1000
 */
export async function listMessages(opts = {}) {
  const { dateSentAfter, pageSize = 50 } = opts;
  if (!isTwilioConfigured()) throw new Error('Twilio not configured');
  const url = new URL(apiUrl('/Messages.json'));
  url.searchParams.set('PageSize', String(Math.min(pageSize, 1000)));
  if (dateSentAfter) url.searchParams.set('DateSent>', dateSentAfter);

  const res = await fetch(url.toString(), {
    method: 'GET',
    headers: { 'Authorization': basicAuth() },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Twilio listMessages failed: HTTP ${res.status} ${text.slice(0, 300)}`);
  }
  return (await res.json()).messages || [];
}

/**
 * List the IncomingPhoneNumbers on the account.
 */
export async function listIncomingPhoneNumbers() {
  if (!isTwilioConfigured()) throw new Error('Twilio not configured');
  const res = await fetch(apiUrl('/IncomingPhoneNumbers.json?PageSize=200'), {
    headers: { 'Authorization': basicAuth() },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Twilio listIncomingPhoneNumbers failed: HTTP ${res.status} ${text.slice(0, 300)}`);
  }
  return (await res.json()).incoming_phone_numbers || [];
}

/**
 * Verify the Twilio webhook signature.
 *
 * Twilio signs requests with HMAC-SHA1 over the URL + sorted POST params.
 * https://www.twilio.com/docs/usage/webhooks/webhooks-security
 *
 * @param {object} params
 * @param {string} params.signatureHeader  X-Twilio-Signature header value
 * @param {string} params.url              the full URL Twilio called
 * @param {object} params.params           the POSTed parameters (as object)
 */
export function verifyTwilioWebhook({ signatureHeader, url, params }) {
  if (!signatureHeader) return { valid: false, reason: 'missing_signature_header' };
  const token = process.env.TWILIO_AUTH_TOKEN;
  if (!token) return { valid: false, reason: 'no_token' };

  // Twilio signature: HMAC-SHA1(authToken, url + sorted_param_pairs)
  const keys = Object.keys(params || {}).sort();
  let toSign = url;
  for (const k of keys) toSign += k + (params[k] ?? '');
  const computed = crypto.createHmac('sha1', token).update(toSign).digest('base64');
  if (computed !== signatureHeader) {
    return { valid: false, reason: 'signature_mismatch' };
  }
  return { valid: true };
}

/**
 * Detect STOP / UNSUBSCRIBE / END / etc. keywords per TCPA-style
 * convention. Returns true if the inbound body indicates opt-out.
 */
export function isOptOutBody(body) {
  if (!body) return false;
  const cleaned = body.trim().toUpperCase();
  return [
    'STOP', 'STOPALL', 'UNSUBSCRIBE', 'CANCEL', 'END', 'QUIT', 'REVOKE',
  ].includes(cleaned);
}

/**
 * Detect HELP / INFO keywords (we'd auto-reply with help text).
 */
export function isHelpBody(body) {
  if (!body) return false;
  const cleaned = body.trim().toUpperCase();
  return ['HELP', 'INFO'].includes(cleaned);
}
