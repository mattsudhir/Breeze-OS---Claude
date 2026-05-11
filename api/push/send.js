// Vercel Serverless Function — sends a push notification to one or
// more registered devices via Firebase Cloud Messaging.
//
// Request body (one of `to`, `userId`, or `organizationId` required):
//   {
//     to?: string | string[]    explicit FCM token(s)
//     userId?: uuid             send to all devices owned by this user
//     organizationId?: uuid     send to every device in the org
//     title: string             notification title
//     body: string              notification body
//     data?: object             arbitrary key/value payload (strings)
//     badge?: number            iOS badge count
//     sound?: 'default' | null  iOS/Android sound
//   }
//
// Auth: requires BREEZE_ADMIN_TOKEN in `x-admin-token` header. This is
//       a privileged endpoint — anyone who can hit it can fan out
//       notifications to every user. Tighten further (per-org tokens,
//       Clerk session) before opening to non-admin code paths.
//
// Behaviour:
//   - Stale / invalid tokens (FCM `messaging/registration-token-not-registered`)
//     are deleted from the database so they don't keep failing.
//   - Returns per-token success/failure so callers can surface partial
//     delivery if they care.

import { eq, inArray } from 'drizzle-orm';
import { getDb, schema } from '../../lib/db/index.js';
import { getMessaging } from '../../lib/firebaseAdmin.js';

const STALE_FCM_ERRORS = new Set([
  'messaging/registration-token-not-registered',
  'messaging/invalid-registration-token',
  'messaging/invalid-argument',
]);

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-admin-token');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  const expectedToken = process.env.BREEZE_ADMIN_TOKEN;
  if (!expectedToken) {
    return res.status(500).json({
      error: 'BREEZE_ADMIN_TOKEN not configured — refusing to fan out pushes without auth',
    });
  }
  if (req.headers['x-admin-token'] !== expectedToken) {
    return res.status(401).json({ error: 'invalid admin token' });
  }

  const {
    to,
    userId,
    organizationId,
    title,
    body,
    data,
    badge,
    sound = 'default',
  } = req.body || {};

  if (!title || !body) {
    return res.status(400).json({ error: 'title and body are required' });
  }
  if (!to && !userId && !organizationId) {
    return res
      .status(400)
      .json({ error: 'one of to, userId, organizationId is required' });
  }

  let db;
  try {
    db = getDb();
  } catch (err) {
    return res.status(503).json({ error: err.message });
  }

  // Resolve the target token set.
  let tokens = [];
  if (to) {
    tokens = Array.isArray(to) ? to.filter(Boolean) : [to];
  } else {
    const condition = userId
      ? eq(schema.deviceTokens.userId, userId)
      : eq(schema.deviceTokens.organizationId, organizationId);
    const rows = await db
      .select({ token: schema.deviceTokens.token })
      .from(schema.deviceTokens)
      .where(condition);
    tokens = rows.map((r) => r.token);
  }

  if (tokens.length === 0) {
    return res.status(200).json({ ok: true, sent: 0, results: [] });
  }

  let messaging;
  try {
    messaging = await getMessaging();
  } catch (err) {
    return res.status(503).json({ error: err.message });
  }

  // FCM caps sendEach at 500 tokens per call. Chunk to be safe.
  const CHUNK = 450;
  const allResults = [];
  const staleTokens = [];

  for (let i = 0; i < tokens.length; i += CHUNK) {
    const chunk = tokens.slice(i, i + CHUNK);
    const messages = chunk.map((token) => ({
      token,
      notification: { title, body },
      data: stringifyData(data),
      apns: {
        payload: {
          aps: {
            sound: sound || undefined,
            badge: typeof badge === 'number' ? badge : undefined,
          },
        },
      },
      android: {
        priority: 'high',
        notification: { sound: sound || undefined },
      },
    }));

    let batch;
    try {
      batch = await messaging.sendEach(messages);
    } catch (err) {
      console.error('[push/send] sendEach threw', err);
      return res.status(502).json({ error: err.message });
    }

    batch.responses.forEach((r, idx) => {
      const token = chunk[idx];
      if (r.success) {
        allResults.push({ token, ok: true, id: r.messageId });
      } else {
        const code = r.error?.code;
        allResults.push({ token, ok: false, code, message: r.error?.message });
        if (STALE_FCM_ERRORS.has(code)) staleTokens.push(token);
      }
    });
  }

  // Garbage-collect tokens FCM told us are dead.
  if (staleTokens.length > 0) {
    try {
      await db
        .delete(schema.deviceTokens)
        .where(inArray(schema.deviceTokens.token, staleTokens));
      console.log(`[push/send] removed ${staleTokens.length} stale tokens`);
    } catch (err) {
      console.warn('[push/send] failed to prune stale tokens', err.message);
    }
  }

  const sentOk = allResults.filter((r) => r.ok).length;
  return res
    .status(200)
    .json({ ok: true, sent: sentOk, failed: allResults.length - sentOk, results: allResults });
}

// FCM `data` payloads must be flat string→string maps. Stringify any
// non-string values so callers can pass arbitrary JSON without
// thinking about it.
function stringifyData(data) {
  if (!data || typeof data !== 'object') return undefined;
  const out = {};
  for (const [k, v] of Object.entries(data)) {
    if (v === undefined || v === null) continue;
    out[k] = typeof v === 'string' ? v : JSON.stringify(v);
  }
  return out;
}
