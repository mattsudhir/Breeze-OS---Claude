// Vercel Serverless Function — Vapi event webhook receiver.
//
// Vapi POSTs call lifecycle events here: assistant-request, status-update,
// tool-calls, end-of-call-report, and function-call. For PR 1 this is a
// stub that verifies the signature, logs the event, and returns 200. PR 3
// (the workflow engine) adds the real dispatch logic — parsing end-of-call
// structured output, updating the `calls` table, and scheduling follow-up
// tasks in the `tasks` queue.
//
// ── Configuration in Vapi dashboard ──────────────────────────────
//
//   Vapi → Organisation Settings → Server URL → https://<your-deploy>/api/vapi-webhook
//   Vapi → Organisation Settings → Server URL Secret → <random string>
//
// Copy the secret into Vercel env as VAPI_WEBHOOK_SECRET. Vapi signs each
// request with HMAC-SHA256 using this secret and sends the hex digest in
// the `x-vapi-secret` header (Vapi's current format) or `x-vapi-signature`
// (older format). We accept either and reject anything else.
//
// ── Environment variables ────────────────────────────────────────
//   VAPI_WEBHOOK_SECRET — HMAC shared secret for request verification.
//                        If unset, the handler rejects every request
//                        with 503 rather than silently accepting
//                        unauthenticated webhooks.

import crypto from 'node:crypto';

// Constant-time comparison to avoid timing oracles when checking HMAC
// digests. Buffer lengths must match; we normalise and bail out if not.
function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const ba = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

function verifySignature(rawBody, headerSig, secret) {
  if (!secret || !headerSig) return false;
  const hex = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
  return safeEqual(hex, headerSig);
}

// Vercel parses req.body for us, but HMAC has to run over the exact
// bytes Vapi hashed. We re-stringify after parsing with the same
// serialization — fine for Vapi's JSON, which uses a stable form.
function getRawBody(req) {
  if (typeof req.body === 'string') return req.body;
  if (Buffer.isBuffer(req.body)) return req.body.toString('utf8');
  return JSON.stringify(req.body ?? {});
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'POST only' });
  }

  const secret = process.env.VAPI_WEBHOOK_SECRET;
  if (!secret) {
    // Fail closed: an unconfigured webhook must never accept traffic.
    console.error('[vapi-webhook] VAPI_WEBHOOK_SECRET not configured — rejecting');
    return res
      .status(503)
      .json({ error: 'Webhook not configured. Set VAPI_WEBHOOK_SECRET.' });
  }

  const headerSig =
    req.headers['x-vapi-secret'] ||
    req.headers['x-vapi-signature'] ||
    '';
  const rawBody = getRawBody(req);

  // Vapi's current dashboard uses a literal shared-secret match (header
  // value === secret) rather than HMAC. We accept BOTH shapes: either
  // a matching plaintext secret header, or a valid HMAC hex digest.
  // That keeps us compatible across Vapi's signing modes.
  const plaintextOk = safeEqual(headerSig, secret);
  const hmacOk = verifySignature(rawBody, headerSig, secret);
  if (!plaintextOk && !hmacOk) {
    console.warn('[vapi-webhook] invalid signature');
    return res.status(401).json({ error: 'Invalid signature' });
  }

  const body = req.body || {};
  const msg = body?.message || body; // Vapi wraps events in `message` but older formats are flat
  const type = msg?.type || body?.type || 'unknown';
  const vapiCallId = msg?.call?.id || body?.call?.id || null;

  // PR 1 stub: structured logging only. PR 3 replaces this with a real
  // dispatcher that writes to the `calls` table and enqueues follow-up
  // tasks in the `tasks` queue.
  console.log('[vapi-webhook] received', JSON.stringify({
    type,
    vapiCallId,
    hasTranscript: !!msg?.transcript,
    hasStructuredOutput: !!msg?.analysis?.structuredData,
    hasEndedReason: !!msg?.endedReason,
  }));

  return res.status(200).json({ ok: true, received: type });
}
