// Vercel Serverless Function — Vapi event webhook receiver.
//
// This is the state-transition side of the move-event workflow. Vapi
// POSTs lifecycle events here for every call; we care most about:
//
//   - status-update         → track the call going through the ringing/
//                             in_progress/ended states, write to calls.status
//   - end-of-call-report    → the BIG one — transcript, recording, duration,
//                             cost, and most importantly the assistant's
//                             structured-data outcome. Drives the move-event
//                             state machine forward.
//
// For move_event_utility calls, end-of-call-report triggers:
//   - calls row updated with full transcript / recording / outcome
//   - related move_event_utilities row transitioned:
//       success       → 'completed' (+ store confirmation numbers)
//       closed        → stays 'pending' + schedule retry task at callback_at
//       hold_timeout  → stays 'pending' + schedule retry task in 2 hours
//       voicemail     → stays 'pending' + schedule retry task in 4 hours
//       needs_human   → 'needs_human' + Cliq escalation notification
//       failed        → 'failed' + Cliq escalation notification
//   - move_events rollup: if every meu is completed → move_events.status =
//     'completed'; if every meu is in a terminal state and at least one is
//     'needs_human' or 'failed' → 'escalated'
//
// ── Environment variables ─────────────────────────────────────────
//   VAPI_WEBHOOK_SECRET   — HMAC shared secret (or plain match)
//   ZOHO_CLIQ_WEBHOOK_URL — used for escalation notifications
//   BREEZE_ADMIN_TOKEN    — unused here but kept in the ecosystem

import crypto from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import { getDb, schema } from '../lib/db/index.js';
import { postToCliq } from '../lib/cliqNotify.js';

// ── Signature verification ───────────────────────────────────────

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

function getRawBody(req) {
  if (typeof req.body === 'string') return req.body;
  if (Buffer.isBuffer(req.body)) return req.body.toString('utf8');
  return JSON.stringify(req.body ?? {});
}

// ── Event extraction ─────────────────────────────────────────────

// Normalise the Vapi event shape so the rest of the handler can
// read flat fields regardless of whether the event arrived as
// { message: {...} } (modern) or flat (older format).
function unwrapMessage(body) {
  const msg = body?.message || body;
  return {
    type: msg?.type || body?.type || 'unknown',
    call: msg?.call || body?.call || null,
    endedReason: msg?.endedReason || msg?.endedReason || null,
    transcript: msg?.transcript || null,
    recordingUrl: msg?.recordingUrl || msg?.call?.recordingUrl || null,
    durationSeconds: msg?.durationSeconds ?? msg?.call?.duration ?? null,
    cost: msg?.cost ?? null,
    // end-of-call-report carries the analysis block with the
    // structured data the assistant extracted at call end.
    analysis: msg?.analysis || null,
    // status-update events have a status field like 'ringing' or
    // 'in-progress' on the call object.
    status: msg?.status || msg?.call?.status || null,
  };
}

// Map Vapi status values to our calls.status enum.
function mapVapiStatus(vapiStatus) {
  if (!vapiStatus) return null;
  const s = vapiStatus.toLowerCase();
  if (s.includes('queue')) return 'queued';
  if (s.includes('ring')) return 'ringing';
  if (s.includes('progress') || s === 'in-progress') return 'in_progress';
  if (s.includes('hold')) return 'on_hold';
  if (s.includes('end') || s === 'completed' || s === 'ended') return 'completed';
  if (s.includes('fail') || s === 'failed') return 'failed';
  if (s.includes('no-answer') || s === 'no_answer') return 'no_answer';
  return null;
}

// ── Outcome → retry policy ───────────────────────────────────────

function plusHours(base, hours) {
  return new Date(base.getTime() + hours * 3600 * 1000);
}

// Decide what to do when a move_event_utility's call finishes.
// Returns { nextStatus, scheduleRetryAt?, escalate?, notes? }.
function planOutcomeTransition(outcome, structured, attempts, maxAttempts) {
  const notes = structured?.notes || '';

  if (outcome === 'success') {
    return { nextStatus: 'completed', notes };
  }

  if (attempts >= maxAttempts) {
    return {
      nextStatus: 'needs_human',
      escalate: true,
      notes: `Max attempts (${maxAttempts}) exhausted after outcome '${outcome}'. ${notes}`,
    };
  }

  if (outcome === 'closed') {
    const when = structured?.callback_at
      ? new Date(structured.callback_at)
      : plusHours(new Date(), 12);
    // Don't schedule in the past.
    const safeWhen = when > new Date() ? when : plusHours(new Date(), 1);
    return {
      nextStatus: 'pending',
      scheduleRetryAt: safeWhen,
      notes: `Closed. Callback scheduled for ${safeWhen.toISOString()}. ${notes}`,
    };
  }

  if (outcome === 'hold_timeout') {
    return {
      nextStatus: 'pending',
      scheduleRetryAt: plusHours(new Date(), 2),
      notes: `Hold timeout — will retry in 2 hours. ${notes}`,
    };
  }

  if (outcome === 'voicemail') {
    return {
      nextStatus: 'pending',
      scheduleRetryAt: plusHours(new Date(), 4),
      notes: `Left voicemail — will retry in 4 hours. ${notes}`,
    };
  }

  if (outcome === 'needs_human') {
    return {
      nextStatus: 'needs_human',
      escalate: true,
      notes: `Rep flagged for human follow-up. ${notes}`,
    };
  }

  if (outcome === 'failed') {
    return {
      nextStatus: 'failed',
      escalate: true,
      notes: `Call failed. ${notes}`,
    };
  }

  // Unknown outcome — treat as retry-once with escalation on exhaust.
  return {
    nextStatus: 'pending',
    scheduleRetryAt: plusHours(new Date(), 1),
    notes: `Unknown outcome '${outcome}' — will retry in 1 hour. ${notes}`,
  };
}

// ── Roll-up: decide if a move_event is done ──────────────────────

async function rollupMoveEventStatus(db, moveEventId) {
  const utilities = await db
    .select({ status: schema.moveEventUtilities.status })
    .from(schema.moveEventUtilities)
    .where(eq(schema.moveEventUtilities.moveEventId, moveEventId));

  if (utilities.length === 0) return;

  const terminal = new Set(['completed', 'failed', 'needs_human']);
  const allTerminal = utilities.every((u) => terminal.has(u.status));
  if (!allTerminal) return;

  const anyEscalated = utilities.some(
    (u) => u.status === 'needs_human' || u.status === 'failed',
  );
  const newStatus = anyEscalated ? 'escalated' : 'completed';

  await db
    .update(schema.moveEvents)
    .set({ status: newStatus, updatedAt: new Date() })
    .where(eq(schema.moveEvents.id, moveEventId));
}

// ── Event handlers ───────────────────────────────────────────────

async function handleStatusUpdate(db, event) {
  const vapiCallId = event.call?.id;
  if (!vapiCallId) return { handled: false, reason: 'no call id' };
  const mappedStatus = mapVapiStatus(event.status);
  if (!mappedStatus) return { handled: false, reason: `unmapped status '${event.status}'` };

  await db
    .update(schema.calls)
    .set({ status: mappedStatus })
    .where(eq(schema.calls.vapiCallId, vapiCallId));
  return { handled: true };
}

async function handleEndOfCallReport(db, event) {
  const vapiCallId = event.call?.id;
  if (!vapiCallId) return { handled: false, reason: 'no call id' };

  // Find our calls row by the Vapi call id.
  const callRows = await db
    .select()
    .from(schema.calls)
    .where(eq(schema.calls.vapiCallId, vapiCallId))
    .limit(1);
  if (callRows.length === 0) {
    console.warn('[vapi-webhook] end-of-call for unknown vapiCallId:', vapiCallId);
    return { handled: false, reason: 'call row not found' };
  }
  const call = callRows[0];

  // Extract structured data if present.
  const structured = event.analysis?.structuredData || null;
  const outcome = structured?.outcome || 'failed';

  // Update the calls row with everything the webhook provides.
  await db
    .update(schema.calls)
    .set({
      status: 'completed',
      outcome,
      endedAt: new Date(),
      durationSeconds: event.durationSeconds ?? null,
      costCents: typeof event.cost === 'number' ? Math.round(event.cost * 100) : null,
      transcript: event.transcript || null,
      recordingUrl: event.recordingUrl || null,
      structuredOutput: structured,
    })
    .where(eq(schema.calls.id, call.id));

  // If this call was for a move_event_utility, drive the state machine.
  if (call.relatedTable === 'move_event_utilities' && call.relatedId) {
    const meuRows = await db
      .select()
      .from(schema.moveEventUtilities)
      .where(eq(schema.moveEventUtilities.id, call.relatedId))
      .limit(1);
    if (meuRows.length === 0) {
      return { handled: true, warning: 'related meu not found' };
    }
    const meu = meuRows[0];

    const plan = planOutcomeTransition(
      outcome,
      structured,
      meu.attempts,
      meu.max_attempts ?? meu.maxAttempts ?? 5,
    );

    // Apply fields that we know from the structured output.
    const updatePayload = {
      status: plan.nextStatus,
      updatedAt: new Date(),
    };
    if (structured?.new_account_number) {
      updatePayload.toAccountNumber = structured.new_account_number;
    }
    if (structured?.confirmation_number) {
      updatePayload.confirmationNumber = structured.confirmation_number;
    }
    if (plan.scheduleRetryAt) {
      updatePayload.nextAttemptAt = plan.scheduleRetryAt;
    }
    if (plan.notes) {
      // Append rather than overwrite so human-added notes survive.
      updatePayload.notes = sql`coalesce(notes, '') || E'\n' || ${plan.notes}`;
    }

    await db
      .update(schema.moveEventUtilities)
      .set(updatePayload)
      .where(eq(schema.moveEventUtilities.id, meu.id));

    // If the plan says "retry at scheduleRetryAt", enqueue the task.
    if (plan.scheduleRetryAt) {
      await db.insert(schema.tasks).values({
        organizationId: call.organizationId,
        kind: 'retry_move_event_utility',
        payload: { moveEventUtilityId: meu.id },
        scheduledFor: plan.scheduleRetryAt,
        status: 'pending',
      });
    }

    // Audit the state transition.
    await db.insert(schema.auditEvents).values({
      organizationId: call.organizationId,
      actorType: 'vapi_webhook',
      subjectTable: 'move_event_utilities',
      subjectId: meu.id,
      eventType: 'outcome_applied',
      beforeState: { status: meu.status, attempts: meu.attempts },
      afterState: {
        status: plan.nextStatus,
        outcome,
        scheduleRetryAt: plan.scheduleRetryAt?.toISOString() || null,
      },
    });

    // Cliq escalation on terminal-bad outcomes.
    if (plan.escalate) {
      try {
        await postToCliq({
          recipient: 'the team',
          message: `Move-event utility needs human attention. outcome=${outcome}, meu=${meu.id}. ${plan.notes}`,
          context: `move_event_utility=${meu.id}`,
        });
      } catch (err) {
        console.error('[vapi-webhook] Cliq escalation failed:', err);
      }
    }

    // Roll up parent move_event status.
    await rollupMoveEventStatus(db, meu.moveEventId);
  }

  return { handled: true };
}

// ── HTTP handler ─────────────────────────────────────────────────

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'POST only' });
  }

  const secret = process.env.VAPI_WEBHOOK_SECRET;
  if (!secret) {
    console.error('[vapi-webhook] VAPI_WEBHOOK_SECRET not configured — rejecting');
    return res.status(503).json({ error: 'Webhook not configured' });
  }

  const headerSig =
    req.headers['x-vapi-secret'] ||
    req.headers['x-vapi-signature'] ||
    '';
  const rawBody = getRawBody(req);

  const plaintextOk = safeEqual(headerSig, secret);
  const hmacOk = verifySignature(rawBody, headerSig, secret);
  if (!plaintextOk && !hmacOk) {
    console.warn('[vapi-webhook] invalid signature');
    return res.status(401).json({ error: 'Invalid signature' });
  }

  const event = unwrapMessage(req.body || {});
  const db = getDb();

  try {
    if (event.type === 'status-update') {
      const r = await handleStatusUpdate(db, event);
      return res.status(200).json({ ok: true, type: event.type, ...r });
    }
    if (event.type === 'end-of-call-report') {
      const r = await handleEndOfCallReport(db, event);
      return res.status(200).json({ ok: true, type: event.type, ...r });
    }

    // Unhandled event types are logged but return 200 so Vapi doesn't
    // retry them forever.
    console.log('[vapi-webhook] unhandled event', event.type);
    return res.status(200).json({ ok: true, received: event.type, handled: false });
  } catch (err) {
    console.error('[vapi-webhook] handler error:', err);
    // Return 200 to prevent Vapi from retrying a broken handler in a
    // tight loop — we'd rather drop the event and look at logs.
    return res.status(200).json({ ok: false, error: err.message });
  }
}
