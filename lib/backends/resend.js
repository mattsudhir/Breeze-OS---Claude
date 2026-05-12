// Resend email backend.
//
// Sends transactional email (rent reminders, owner statements, lease
// notices) via Resend's REST API. Inbound is handled via Resend's
// "Inbound emails" feature OR a forwarding rule on a custom domain;
// either way the webhook lands at /api/webhooks/resend.
//
// Env vars:
//   RESEND_API_KEY              required
//   RESEND_FROM_DOMAIN          required (e.g. 'breeze-os.dev'; the verified domain)
//   RESEND_DEFAULT_FROM_EMAIL   optional ('hello@breeze-os.dev' default)
//   RESEND_WEBHOOK_SECRET       optional, for signature verification
//
// Reference: https://resend.com/docs/api-reference

import crypto from 'node:crypto';

const BASE_URL = 'https://api.resend.com';

export function isResendConfigured() {
  return Boolean(process.env.RESEND_API_KEY);
}

function authHeaders() {
  if (!isResendConfigured()) throw new Error('Resend not configured');
  return {
    'Authorization': `Bearer ${process.env.RESEND_API_KEY}`,
    'Content-Type': 'application/json',
  };
}

function defaultFrom() {
  const explicit = process.env.RESEND_DEFAULT_FROM_EMAIL;
  if (explicit) return explicit;
  const domain = process.env.RESEND_FROM_DOMAIN;
  if (!domain) throw new Error('RESEND_FROM_DOMAIN not set');
  return `noreply@${domain}`;
}

/**
 * Send a transactional email.
 *
 * @param {object} params
 * @param {string} [params.from]     defaults to RESEND_DEFAULT_FROM_EMAIL
 * @param {string} params.to         recipient (or array of recipients)
 * @param {string} params.subject
 * @param {string} [params.html]
 * @param {string} [params.text]
 * @param {string} [params.replyTo]
 * @param {Array}  [params.attachments]
 * @returns {Promise<{ id: string, raw: object }>}
 */
export async function sendEmail(params) {
  const { from, to, subject, html, text, replyTo, attachments } = params;
  if (!to) throw new Error('sendEmail: to required');
  if (!subject) throw new Error('sendEmail: subject required');
  if (!html && !text) throw new Error('sendEmail: html or text required');

  const body = {
    from: from || defaultFrom(),
    to: Array.isArray(to) ? to : [to],
    subject,
  };
  if (html) body.html = html;
  if (text) body.text = text;
  if (replyTo) body.reply_to = replyTo;
  if (attachments) body.attachments = attachments;

  const res = await fetch(`${BASE_URL}/emails`, {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Resend sendEmail failed: HTTP ${res.status} ${text.slice(0, 300)}`);
  }
  const json = await res.json();
  return { id: json.id, raw: json };
}

/**
 * Fetch an email by id — for reconciliation / debugging.
 */
export async function getEmail(id) {
  if (!id) throw new Error('getEmail: id required');
  const res = await fetch(`${BASE_URL}/emails/${id}`, {
    method: 'GET',
    headers: authHeaders(),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Resend getEmail failed: HTTP ${res.status} ${text.slice(0, 300)}`);
  }
  return res.json();
}

/**
 * Verify the webhook signature using HMAC-SHA256 over the raw body.
 * Resend uses Svix-style signatures: header is 'svix-signature',
 * format is 'v1,<base64-hmac>' (potentially multiple v-pairs).
 *
 * @param {object} params
 * @param {string} params.rawBody
 * @param {string} params.signatureHeader  value of `svix-signature`
 * @param {string} params.svixId           value of `svix-id`
 * @param {string} params.svixTimestamp    value of `svix-timestamp`
 */
export function verifyResendWebhook({ rawBody, signatureHeader, svixId, svixTimestamp }) {
  const secret = process.env.RESEND_WEBHOOK_SECRET;
  if (!secret) return { valid: false, reason: 'no_secret_configured' };
  if (!signatureHeader || !svixId || !svixTimestamp) {
    return { valid: false, reason: 'missing_svix_headers' };
  }
  // Svix secrets are prefixed with 'whsec_'; strip and base64-decode.
  const rawSecret = secret.startsWith('whsec_') ? secret.slice(6) : secret;
  const keyBytes = Buffer.from(rawSecret, 'base64');
  const signedPayload = `${svixId}.${svixTimestamp}.${rawBody}`;
  const computed = 'v1,' + crypto.createHmac('sha256', keyBytes).update(signedPayload).digest('base64');

  // Header may include multiple space-separated signatures.
  const sigs = signatureHeader.split(' ');
  if (!sigs.includes(computed)) {
    return { valid: false, reason: 'signature_mismatch' };
  }
  return { valid: true };
}
