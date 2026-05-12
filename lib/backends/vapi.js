// VAPI backend — outbound + inbound voice agents.
//
// Wraps the Vapi.ai REST API:
//   - placeCall(...)    initiate an outbound phone call
//   - getCall(callId)   fetch a call's status, transcript, recording
//
// VAPI's webhook events are handled in api/webhooks/vapi.js, which
// invokes function-call tools defined in lib/voice/vapiTools.js (added
// alongside this file).
//
// Env vars:
//   VAPI_API_KEY          — required, found in Vapi.ai dashboard
//   VAPI_PHONE_NUMBER_ID  — required for outbound; the Vapi-managed
//                           phone-number resource to dial from
//
// Both are server-side only; never expose to the browser.

const BASE_URL = 'https://api.vapi.ai';

export function isVapiConfigured() {
  return Boolean(process.env.VAPI_API_KEY);
}

function authHeaders() {
  if (!process.env.VAPI_API_KEY) {
    throw new Error('VAPI_API_KEY not set');
  }
  return {
    'Authorization': `Bearer ${process.env.VAPI_API_KEY}`,
    'Content-Type': 'application/json',
  };
}

/**
 * Initiate an outbound phone call via Vapi.
 *
 * @param {object} params
 * @param {string} params.assistantId    Vapi assistant id (configured in
 *                                       Vapi dashboard) that drives the call
 * @param {string} params.phoneNumber    E.164 destination, e.g. '+14155551234'
 * @param {string} [params.customerName] caller-id-like label shown in
 *                                       Vapi's dashboard
 * @param {object} [params.metadata]     opaque object echoed back on every
 *                                       webhook event. Used to round-trip
 *                                       tenant_id / property_id / workflow_id
 *                                       so function-call handlers know
 *                                       which entities to operate on.
 * @param {object} [params.assistantOverrides] override system prompt,
 *                                       first message, etc. per call
 * @returns {Promise<{ id: string, status: string }>}
 */
export async function placeCall(params) {
  const {
    assistantId,
    phoneNumber,
    customerName,
    metadata,
    assistantOverrides,
  } = params;

  if (!assistantId) throw new Error('placeCall: assistantId required');
  if (!phoneNumber) throw new Error('placeCall: phoneNumber required');
  if (!process.env.VAPI_PHONE_NUMBER_ID) {
    throw new Error('VAPI_PHONE_NUMBER_ID not set');
  }

  const body = {
    phoneNumberId: process.env.VAPI_PHONE_NUMBER_ID,
    assistantId,
    customer: {
      number: phoneNumber,
      ...(customerName ? { name: customerName } : {}),
    },
  };
  if (metadata) body.metadata = metadata;
  if (assistantOverrides) body.assistantOverrides = assistantOverrides;

  const res = await fetch(`${BASE_URL}/call/phone`, {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Vapi placeCall failed: HTTP ${res.status} ${text.slice(0, 300)}`);
  }
  const json = await res.json();
  return { id: json.id, status: json.status, raw: json };
}

/**
 * Fetch a call by its Vapi id.
 *
 * @param {string} callId
 * @returns {Promise<object>} Vapi's call object (status, transcript,
 *                            duration, recording URL, etc.)
 */
export async function getCall(callId) {
  if (!callId) throw new Error('getCall: callId required');
  const res = await fetch(`${BASE_URL}/call/${callId}`, {
    method: 'GET',
    headers: authHeaders(),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Vapi getCall failed: HTTP ${res.status} ${text.slice(0, 300)}`);
  }
  return res.json();
}

/**
 * Verify a Vapi webhook request. Vapi signs payloads with HMAC-SHA256
 * using the server-side secret (VAPI_WEBHOOK_SECRET) in the
 * `X-Vapi-Signature` header. If no secret is configured we skip the
 * check and log a warning.
 *
 * @param {object} params
 * @param {string} params.rawBody         exact bytes from the request
 * @param {string} [params.signatureHeader] value of X-Vapi-Signature
 * @returns {{ valid: boolean, reason?: string }}
 */
export async function verifyVapiWebhook({ rawBody, signatureHeader }) {
  const secret = process.env.VAPI_WEBHOOK_SECRET;
  if (!secret) {
    return { valid: false, reason: 'no_secret_configured' };
  }
  if (!signatureHeader) {
    return { valid: false, reason: 'missing_signature_header' };
  }
  const crypto = await import('node:crypto');
  const computed = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
  if (computed !== signatureHeader) {
    return { valid: false, reason: 'signature_mismatch' };
  }
  return { valid: true };
}

// ── Live call intervention ──────────────────────────────────────

/**
 * Transfer an in-progress call to a different phone (typically a
 * staff member). VAPI's assistant drops off; the tenant is routed
 * to the destination.
 *
 * @param {string} callId
 * @param {string} destinationE164
 */
export async function transferCall(callId, destinationE164) {
  if (!callId) throw new Error('transferCall: callId required');
  if (!destinationE164) throw new Error('transferCall: destinationE164 required');

  const res = await fetch(`${BASE_URL}/call/${callId}/control`, {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify({
      type: 'transfer',
      destination: { type: 'number', number: destinationE164 },
    }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Vapi transferCall failed: HTTP ${res.status} ${text.slice(0, 300)}`);
  }
  return res.json();
}

/**
 * Inject a "steering" message into an active call's context. Used
 * for AI steering by staff — e.g. "max 14-day extension; confirm
 * payment plan if they want."
 *
 * The message is added as a system role so the assistant treats it
 * as authoritative guidance rather than user input.
 *
 * @param {string} callId
 * @param {string} directiveText
 */
export async function steerCall(callId, directiveText) {
  if (!callId) throw new Error('steerCall: callId required');
  if (!directiveText) throw new Error('steerCall: directiveText required');

  const res = await fetch(`${BASE_URL}/call/${callId}/control`, {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify({
      type: 'add-message',
      message: {
        role: 'system',
        content: `[SUPERVISOR DIRECTIVE]: ${directiveText}`,
      },
    }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Vapi steerCall failed: HTTP ${res.status} ${text.slice(0, 300)}`);
  }
  return res.json();
}
