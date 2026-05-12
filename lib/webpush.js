// Web push helper — sends a notification to every active
// subscription for a given user_id. Called by
// notifications.fanoutEvent right after creating a row in the
// notifications table, so a new bell-dropdown item AND a native
// browser notification both fire from the same trigger.
//
// VAPID config:
//   VAPID_PUBLIC_KEY      — base64url, exposed to the browser via
//                            /api/push-subscriptions GET
//   VAPID_PRIVATE_KEY     — base64url, server-only
//   VAPID_SUBJECT         — mailto:you@example.com
//
// Generate the keypair once via the admin endpoint
// /api/admin/generate-vapid-keys (or `npx web-push
// generate-vapid-keys` from a terminal). Paste each into Vercel →
// Settings → Environment Variables → Production.

import webpush from 'web-push';
import { and, eq } from 'drizzle-orm';
import { getDb, schema } from './db/index.js';
import { getDefaultOrgId } from './adminHelpers.js';

let vapidConfigured = false;

function configureVapid() {
  if (vapidConfigured) return true;
  const subject = process.env.VAPID_SUBJECT;
  const publicKey = process.env.VAPID_PUBLIC_KEY;
  const privateKey = process.env.VAPID_PRIVATE_KEY;
  if (!subject || !publicKey || !privateKey) return false;
  try {
    webpush.setVapidDetails(subject, publicKey, privateKey);
    vapidConfigured = true;
    return true;
  } catch (err) {
    console.warn('[web-push] VAPID config failed:', err.message);
    return false;
  }
}

export function getVapidPublicKey() {
  return process.env.VAPID_PUBLIC_KEY || null;
}

export function isVapidConfigured() {
  return Boolean(
    process.env.VAPID_SUBJECT &&
      process.env.VAPID_PUBLIC_KEY &&
      process.env.VAPID_PRIVATE_KEY,
  );
}

/**
 * Send a push notification to every active subscription belonging
 * to `userId`. Stale subscriptions (HTTP 404 / 410 from the push
 * service) are auto-pruned. Network / signing failures are
 * logged but never thrown — the caller (fanoutEvent) treats this
 * as fire-and-forget.
 *
 * @returns { sent, removed, skipped? }
 */
export async function sendPushToUser({
  userId,
  title,
  body = '',
  url = '/',
  tag = 'breeze-default',
}) {
  if (!configureVapid()) {
    return { sent: 0, removed: 0, skipped: 'vapid_not_configured' };
  }
  if (!userId || !title) return { sent: 0, removed: 0, skipped: 'missing_input' };

  const db = getDb();
  const orgId = await getDefaultOrgId();
  const subs = await db
    .select()
    .from(schema.pushSubscriptions)
    .where(
      and(
        eq(schema.pushSubscriptions.organizationId, orgId),
        eq(schema.pushSubscriptions.userId, userId),
      ),
    );

  if (subs.length === 0) {
    return { sent: 0, removed: 0, skipped: 'no_subscriptions' };
  }

  const payload = JSON.stringify({ title, body, url, tag });

  let sent = 0;
  let removed = 0;
  for (const sub of subs) {
    try {
      const subscription = {
        endpoint: sub.endpoint,
        keys: { p256dh: sub.p256dh, auth: sub.auth },
      };
      await webpush.sendNotification(subscription, payload);
      sent += 1;
    } catch (err) {
      // 404 = invalid endpoint, 410 = subscription gone. Both mean
      // the browser won't accept further pushes; clean up the row
      // so we don't waste cycles on it.
      const code = err?.statusCode;
      if (code === 404 || code === 410) {
        try {
          await db
            .delete(schema.pushSubscriptions)
            .where(eq(schema.pushSubscriptions.endpoint, sub.endpoint));
          removed += 1;
        } catch (delErr) {
          console.warn('[web-push] failed to prune dead sub:', delErr?.message || delErr);
        }
      } else {
        console.warn('[web-push] send failed:', code, err?.message || err);
      }
    }
  }
  return { sent, removed };
}
