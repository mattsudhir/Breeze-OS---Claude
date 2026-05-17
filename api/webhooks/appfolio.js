// AppFolio webhook receiver.
//
// AppFolio POSTs here when a subscribed-to topic (tenants,
// properties, units, charges, work_orders, leases, leads, etc.)
// has a create / update / destroy event. We:
//   1. Read the RAW body (no parsing — JWS verification needs the
//      exact bytes AppFolio signed)
//   2. Verify the X-JWS-Signature against AppFolio's JWKS
//   3. Fan out to follows/notifications via fanoutEvent — every
//      user who's following the resource gets one row in the
//      notifications table
//   4. Always return 200 (after signature verify) so AppFolio
//      doesn't retry on app-side processing errors. Verification
//      failures return 401 — those SHOULD retry / alert.
//
// Setup once (see SESSION_NOTES.md):
//   - In AppFolio's Webhook URL admin card, add this endpoint:
//     https://<your-domain>/api/webhooks/appfolio
//   - Subscribe to topics: tenants, properties, units, charges,
//     work_orders, leases, leads.
//
// Audit: this surface DOES NOT log to agent_actions (that table is
// for agent tool calls). When we want a webhook audit trail we'll
// add a separate webhook_events table — for v1 we rely on Vercel
// function logs and the notifications table itself.

import {
  verifyWebhookSignature,
  TOPIC_TO_ENTITY_TYPE,
  describeEventType,
  defaultTitle,
} from '../../lib/appfolioWebhook.js';
import { fanoutEvent } from '../../lib/notifications.js';
import {
  syncOneFromAppfolio,
  readOneFromMirror,
  topicToResourceType,
  getDefaultOrgIdForMirror,
} from '../../lib/appfolioMirror.js';
import {
  categoriesForEvent,
  fanoutCategoryEvent,
} from '../../lib/categorySubscriptions.js';
import { markDirtyForTopic } from '../../lib/chatMetrics/invalidate.js';

// Vercel Node functions parse JSON by default; we need the raw
// bytes for JWS verification. Disabling the body parser lets us
// consume req as a Readable stream.
export const config = {
  api: { bodyParser: false },
};

async function readRawBody(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks);
}

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'POST only' });
  }

  let rawBody;
  try {
    rawBody = await readRawBody(req);
  } catch (err) {
    console.error('[appfolio-webhook] failed to read body:', err);
    return res.status(400).json({ error: 'Could not read request body' });
  }

  // ── Step 1: verify the signature ──
  const sigHeader =
    req.headers['x-jws-signature'] || req.headers['X-JWS-Signature'];
  try {
    await verifyWebhookSignature(rawBody, sigHeader);
  } catch (err) {
    // 401 so AppFolio retries — bad signatures probably mean a
    // transient JWKS rotation issue, not a malformed permanent
    // failure.
    console.warn('[appfolio-webhook] signature verification failed:', err.message);
    return res.status(401).json({ error: `Signature verification failed: ${err.message}` });
  }

  // ── Step 2: parse the (now-trusted) payload ──
  let event;
  try {
    event = JSON.parse(rawBody.toString('utf-8'));
  } catch (err) {
    console.error('[appfolio-webhook] body is not valid JSON after verify:', err);
    return res.status(400).json({ error: 'Body is not valid JSON' });
  }

  const {
    topic,
    resource_id: resourceId,
    event_type: eventType,
    event_id: eventId,
  } = event || {};

  // Always log the receipt — useful when debugging "why didn't I
  // see a notification" later.
  console.log(
    `[appfolio-webhook] verified ${topic || '?'} ${eventType || '?'} ` +
    `(event ${eventId || '?'} resource ${resourceId || '?'})`,
  );

  if (!resourceId) {
    return res.status(200).json({ ok: true, fanned_out: false, reason: 'missing_resource_id' });
  }

  // ── Step 3: refresh the mirror + capture prior state ──
  //
  // We need BOTH the prior cached state and the new state to drive
  // payment-detection style category matchers (compared
  // amount_due before/after). So:
  //   1. Read prior from mirror.
  //   2. Run the AppFolio fetch + upsert (overwrites prior).
  //   3. Read current from mirror (== what was just written).
  //
  // If the mirror has no record of this resource yet, prior is null;
  // matchers handle that gracefully (a fresh create is a valid
  // signal on its own).
  const mirrorType = topicToResourceType(topic);
  let mirrorResult = null;
  let priorState = null;
  let currentState = null;
  let orgId = null;
  if (mirrorType) {
    try {
      orgId = await getDefaultOrgIdForMirror();
      priorState = await readOneFromMirror(orgId, mirrorType, resourceId);
      mirrorResult = await syncOneFromAppfolio(orgId, mirrorType, resourceId);
      currentState = await readOneFromMirror(orgId, mirrorType, resourceId);
    } catch (err) {
      console.warn('[appfolio-webhook] mirror sync failed:', err?.message || err);
    }
  }

  // ── Step 3a: invalidate dependent chat_metrics ──
  // The mirror just updated, so any pre-computed answer derived from
  // it is now stale. The cron sweep recomputes; we just mark dirty.
  // Best-effort: failures here must never block the webhook response.
  if (orgId) {
    try {
      await markDirtyForTopic(orgId, topic, resourceId);
    } catch (err) {
      console.warn('[appfolio-webhook] chat_metrics invalidate failed:', err?.message || err);
    }
  }

  // ── Step 3b: category subscriptions ("alert me on every X") ──
  //
  // For each category that matches this event, fan out to every
  // user subscribed to that category. Independent of the per-entity
  // follow fan-out below — both can fire on the same event.
  const categoryMatches = categoriesForEvent({
    topic,
    eventType,
    prior: priorState,
    current: currentState,
  });
  const categoryResults = [];
  for (const m of categoryMatches) {
    try {
      const r = await fanoutCategoryEvent({
        category: m.category,
        title: m.title,
        body: m.body,
        payload: event,
        sourceEventId: eventId,
      });
      categoryResults.push({ category: m.category, ...r });
    } catch (err) {
      console.warn(
        `[appfolio-webhook] category fanout (${m.category}) failed:`,
        err?.message || err,
      );
      categoryResults.push({ category: m.category, error: err?.message || String(err) });
    }
  }

  // ── Step 4: fan out notifications, if this is a topic we follow ──
  const entityType = TOPIC_TO_ENTITY_TYPE[topic];
  if (!entityType) {
    // Recognised payload, just not a topic we expose for following
    // yet. Ack so AppFolio stops retrying.
    return res.status(200).json({
      ok: true,
      fanned_out: false,
      reason: 'unmapped_topic',
      mirror: mirrorResult,
      categories: categoryResults,
    });
  }

  try {
    const result = await fanoutEvent({
      entityType,
      entityId: resourceId,
      // entity_label intentionally null for v1 — fanoutEvent will
      // fall back to whatever label the follow row stored when it
      // was created (e.g. "Frank Strehl" if the user followed a
      // tenant by that label). Phase 2 will fetch the resource
      // from AppFolio for a fresh title, but the follow-row label
      // is good enough for v1.
      entityLabel: null,
      eventType: describeEventType(eventType),
      source: 'appfolio_webhook',
      title: defaultTitle(topic, eventType),
      body: null,
      linkUrl: null,
      payload: event,
      sourceEventId: eventId || null,
    });
    return res.status(200).json({
      ok: true,
      fanned_out: true,
      mirror: mirrorResult,
      categories: categoryResults,
      ...result,
    });
  } catch (err) {
    // App-side processing error — surface to logs but ack so
    // AppFolio doesn't retry the same event in a loop.
    console.error('[appfolio-webhook] fanout failed:', err);
    return res.status(200).json({
      ok: false,
      fanned_out: false,
      mirror: mirrorResult,
      categories: categoryResults,
      error: err.message,
    });
  }
}
