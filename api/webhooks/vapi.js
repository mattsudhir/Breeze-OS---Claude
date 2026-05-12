// POST /api/webhooks/vapi
//
// Vapi webhook receiver. Vapi posts a "message" object describing the
// event:
//
//   type: 'function-call'        — assistant invoked a tool. We must
//                                  respond with { result: <data> } so
//                                  Vapi can relay it back to the
//                                  assistant mid-conversation.
//   type: 'status-update'        — call status changed (started,
//                                  ended, in-progress)
//   type: 'end-of-call-report'   — call finished. Includes transcript,
//                                  recording URL, duration, end reason
//   type: 'transcript'           — live transcript chunks (we ignore
//                                  these unless we want live UI)
//   type: 'hang'                 — caller hung up
//
// We round-trip metadata via the placeCall metadata field; Vapi
// echoes it back on every event so we know which message_id / tenant
// / workflow this call belongs to.

import { eq } from 'drizzle-orm';
import { getDb, schema } from '../../lib/db/index.js';
import { verifyVapiWebhook } from '../../lib/backends/vapi.js';

export const config = {
  api: { bodyParser: false },
};

async function readRawAndParsed(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks);
  const text = raw.toString('utf8');
  let parsed = {};
  if (text) { try { parsed = JSON.parse(text); } catch { parsed = {}; } }
  return { text, parsed };
}

function jsonOk(res, payload = {}) {
  return res.status(200).json({ ok: true, ...payload });
}

// ── Function-call dispatch ──────────────────────────────────────
//
// VAPI assistants can invoke registered tools. Each tool gets the
// parameters the LLM constructed plus the metadata we passed at call
// time (round-tripped via vapi). For now we register a handful of
// safe "lookup" tools; high-risk tools (commit_payment_plan,
// schedule_utility_transfer) will land in a follow-up that wires the
// approval queue.

async function dispatchFunctionCall(functionName, parameters, metadata) {
  switch (functionName) {
    case 'echo': {
      return { ok: true, echo: parameters };
    }
    case 'lookup_property_address': {
      const db = getDb();
      if (!metadata?.property_id) return { ok: false, error: 'no property_id in metadata' };
      const [p] = await db
        .select({
          line1: schema.properties.serviceAddressLine1,
          line2: schema.properties.serviceAddressLine2,
          city: schema.properties.serviceCity,
          state: schema.properties.serviceState,
          zip: schema.properties.serviceZip,
        })
        .from(schema.properties)
        .where(eq(schema.properties.id, metadata.property_id))
        .limit(1);
      if (!p) return { ok: false, error: 'property not found' };
      return {
        ok: true,
        address: `${p.line1}${p.line2 ? ' ' + p.line2 : ''}, ${p.city}, ${p.state} ${p.zip}`,
      };
    }
    default:
      return {
        ok: false,
        error: `unknown function: ${functionName}`,
      };
  }
}

// ── Status & report handling ────────────────────────────────────

async function applyStatusUpdate(message, msg) {
  const db = getDb();
  const callStatus = msg.call?.status || msg.status;
  const statusMap = {
    'queued':       'queued',
    'ringing':      'sending',
    'in-progress':  'sending',
    'forwarding':   'sending',
    'ended':        'sent',  // refined by end-of-call-report
  };
  const ourStatus = statusMap[callStatus] || message.status;
  if (ourStatus !== message.status) {
    await db
      .update(schema.messages)
      .set({ status: ourStatus, updatedAt: new Date() })
      .where(eq(schema.messages.id, message.id));
  }
}

async function applyEndOfCallReport(message, msg) {
  const db = getDb();
  const transcript = msg.transcript || msg.artifact?.transcript || null;
  const recordingUrl = msg.recordingUrl || msg.artifact?.recordingUrl || null;
  const durationSec = msg.durationSeconds || msg.call?.endedAt && msg.call?.startedAt
    ? Math.round((new Date(msg.call.endedAt) - new Date(msg.call.startedAt)) / 1000)
    : null;
  const endReason = msg.endedReason || msg.call?.endedReason || null;
  const costCents = msg.cost != null ? Math.round(msg.cost * 100) : null;

  // Function calls invoked during the call, if Vapi included a summary.
  const functionCalls = msg.functionCalls || msg.toolCalls || null;

  // Determine final status. If the call connected at all, mark
  // delivered; otherwise no_answer / failed.
  const noAnswerReasons = new Set(['customer-did-not-answer', 'customer-busy', 'no-answer']);
  let finalStatus = 'delivered';
  if (endReason && noAnswerReasons.has(endReason)) finalStatus = 'no_answer';
  if (endReason === 'pipeline-error' || endReason === 'twilio-failed-to-connect') finalStatus = 'failed';

  await db.transaction(async (tx) => {
    await tx
      .update(schema.messages)
      .set({
        status: finalStatus,
        deliveredAt: new Date(),
        body: transcriptToSummary(transcript) || message.body,
        updatedAt: new Date(),
      })
      .where(eq(schema.messages.id, message.id));

    await tx
      .update(schema.voiceCalls)
      .set({
        durationSec: durationSec || undefined,
        recordingUrl,
        transcriptJson: transcript,
        functionCallsJson: functionCalls,
        endReason,
        costCents,
      })
      .where(eq(schema.voiceCalls.messageId, message.id));
  });
}

function transcriptToSummary(transcript) {
  if (!transcript) return null;
  if (typeof transcript === 'string') return transcript.slice(0, 2000);
  if (Array.isArray(transcript)) {
    return transcript
      .map((t) => `${t.role || 'user'}: ${t.message || t.text || ''}`)
      .join('\n')
      .slice(0, 2000);
  }
  return null;
}

// ── Handler ─────────────────────────────────────────────────────

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'POST only' });
  }

  let raw;
  let body;
  try {
    const parsed = await readRawAndParsed(req);
    raw = parsed.text;
    body = parsed.parsed;
  } catch (err) {
    console.error('vapi webhook: body read failed', err);
    return jsonOk(res, { ignored: 'body_read_failed' });
  }

  // Optional signature verification (only if VAPI_WEBHOOK_SECRET is set).
  if (process.env.VAPI_WEBHOOK_SECRET) {
    const verify = await verifyVapiWebhook({
      rawBody: raw,
      signatureHeader: req.headers['x-vapi-signature'],
    });
    if (!verify.valid && verify.reason !== 'no_secret_configured') {
      console.error(`vapi webhook: signature INVALID (${verify.reason})`);
      return jsonOk(res, { ignored: 'signature_invalid' });
    }
  }

  const msg = body?.message || body;
  if (!msg || !msg.type) {
    console.warn('vapi webhook: missing message.type', body);
    return jsonOk(res, { ignored: 'missing_message_type' });
  }

  const metadata = msg.call?.metadata || msg.metadata || {};
  const breezeMessageId = metadata.breeze_message_id || null;

  console.log(`vapi webhook: ${msg.type} message_id=${breezeMessageId || '(none)'}`);

  // function-call: dispatch synchronously, respond inline.
  if (msg.type === 'function-call') {
    const fn = msg.functionCall || msg.toolCall;
    if (!fn || !fn.name) {
      return res.status(200).json({ result: 'error: missing functionCall.name' });
    }
    const result = await dispatchFunctionCall(fn.name, fn.parameters || {}, metadata);
    return res.status(200).json({ result });
  }

  // Other event types — locate the message row and update it.
  if (!breezeMessageId) {
    return jsonOk(res, { ignored: 'no_breeze_message_id' });
  }
  const db = getDb();
  const [message] = await db
    .select()
    .from(schema.messages)
    .where(eq(schema.messages.id, breezeMessageId))
    .limit(1);
  if (!message) {
    console.warn(`vapi webhook: unknown breeze_message_id ${breezeMessageId}`);
    return jsonOk(res, { ignored: 'unknown_breeze_message_id' });
  }

  if (msg.type === 'status-update') {
    await applyStatusUpdate(message, msg);
    return jsonOk(res, { applied: 'status-update' });
  }
  if (msg.type === 'end-of-call-report') {
    await applyEndOfCallReport(message, msg);
    return jsonOk(res, { applied: 'end-of-call-report' });
  }

  // transcript / hang / other — log only for now.
  return jsonOk(res, { acked: msg.type });
}
