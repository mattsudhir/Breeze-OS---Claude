// Push subscription management for the bell UI.
//
// GET /api/push-subscriptions
//   Returns { vapidPublicKey, subscriptionCount, supported }.
//   Frontend uses vapidPublicKey to subscribe. supported=false when
//   the server doesn't have VAPID env vars set, in which case the
//   "Enable notifications" button stays hidden.
//
// POST /api/push-subscriptions
//   Body: { endpoint, keys: { p256dh, auth }, userAgent? }
//   Idempotent upsert by endpoint — re-subscribing the same browser
//   refreshes lastSeenAt instead of creating a duplicate row.
//
// DELETE /api/push-subscriptions
//   Body: { endpoint }
//   Removes the matching row. Frontend also calls subscription.unsubscribe()
//   on the browser side so the push service knows to drop it.

import { and, eq } from 'drizzle-orm';
import { getDb, schema } from '../lib/db/index.js';
import { getDefaultOrgId } from '../lib/adminHelpers.js';
import { getVapidPublicKey, isVapidConfigured } from '../lib/webpush.js';

const DEFAULT_USER_ID = 'default-user';

function resolveUserId(req) {
  const headerVal = req.headers['x-breeze-user-id'];
  if (typeof headerVal === 'string' && headerVal.trim()) return headerVal.trim();
  return DEFAULT_USER_ID;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader(
    'Access-Control-Allow-Headers',
    'Content-Type, x-breeze-user-id',
  );
  if (req.method === 'OPTIONS') return res.status(200).end();

  const userId = resolveUserId(req);

  try {
    if (req.method === 'GET') {
      // Frontend gating: the bell UI only shows the "Enable
      // notifications" button when VAPID is configured AND the
      // user isn't already subscribed.
      const vapidPublicKey = getVapidPublicKey();
      const supported = isVapidConfigured();
      let subscriptionCount = 0;
      if (supported) {
        const db = getDb();
        const orgId = await getDefaultOrgId();
        const subs = await db
          .select({ id: schema.pushSubscriptions.id })
          .from(schema.pushSubscriptions)
          .where(
            and(
              eq(schema.pushSubscriptions.organizationId, orgId),
              eq(schema.pushSubscriptions.userId, userId),
            ),
          );
        subscriptionCount = subs.length;
      }
      return res.status(200).json({
        ok: true,
        supported,
        vapidPublicKey: supported ? vapidPublicKey : null,
        subscriptionCount,
      });
    }

    if (req.method === 'POST') {
      const { endpoint, keys, userAgent } = req.body || {};
      if (!endpoint || !keys?.p256dh || !keys?.auth) {
        return res.status(400).json({
          error: 'endpoint and keys (p256dh + auth) required',
        });
      }
      const db = getDb();
      const orgId = await getDefaultOrgId();
      const now = new Date();
      await db
        .insert(schema.pushSubscriptions)
        .values({
          organizationId: orgId,
          userId,
          endpoint,
          p256dh: keys.p256dh,
          auth: keys.auth,
          userAgent: userAgent || null,
          createdAt: now,
          lastSeenAt: now,
        })
        .onConflictDoUpdate({
          target: schema.pushSubscriptions.endpoint,
          set: {
            userId,
            p256dh: keys.p256dh,
            auth: keys.auth,
            userAgent: userAgent || null,
            lastSeenAt: now,
          },
        });
      return res.status(200).json({ ok: true });
    }

    if (req.method === 'DELETE') {
      const { endpoint } = req.body || {};
      if (!endpoint) return res.status(400).json({ error: 'endpoint required' });
      const db = getDb();
      await db
        .delete(schema.pushSubscriptions)
        .where(eq(schema.pushSubscriptions.endpoint, endpoint));
      return res.status(200).json({ ok: true });
    }

    return res.status(405).json({ error: 'GET, POST, or DELETE only' });
  } catch (err) {
    console.error('[/api/push-subscriptions] error:', err);
    return res.status(err.status || 500).json({ error: err.message || 'Unknown error' });
  }
}
