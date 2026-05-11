// Vercel Serverless Function (also mounted by server.js in Docker) —
// registers a push notification token from a Capacitor mobile shell or
// a Web Push subscription.
//
// Request body:
//   {
//     token: string         (required) FCM registration token
//     platform: 'ios' | 'android' | 'web'   (required)
//     userId?: uuid         (optional) authenticated user id
//     organizationId?: uuid (optional, defaults to single-tenant org)
//     deviceModel?: string  (optional) e.g. 'iPhone15,3'
//     appVersion?: string   (optional) e.g. '1.0.4'
//     locale?: string       (optional) e.g. 'en-US'
//   }
//
// Behaviour:
//   - Upserts on (organization_id, token). Re-registering the same
//     token updates last_seen_at instead of stacking duplicates.
//   - If no organization id is provided we attach to the first org
//     row (single-tenant for now). Once Clerk auth lands the org id
//     will come from the user session.
//
// Auth: This endpoint is intentionally unauthenticated for now so the
//       mobile shell can register before sign-in completes. The token
//       on its own isn't useful for anything except *receiving* pushes
//       on a device we already trust. Lock down once Clerk lands.

import { sql } from 'drizzle-orm';
import { getDb, schema } from '../../lib/db/index.js';

const VALID_PLATFORMS = new Set(['ios', 'android', 'web']);

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  const body = req.body || {};
  const { token, platform, userId, deviceModel, appVersion, locale } = body;
  let { organizationId } = body;

  if (!token || typeof token !== 'string') {
    return res.status(400).json({ error: 'token (string) is required' });
  }
  if (!VALID_PLATFORMS.has(platform)) {
    return res
      .status(400)
      .json({ error: `platform must be one of ${[...VALID_PLATFORMS].join(', ')}` });
  }

  let db;
  try {
    db = getDb();
  } catch (err) {
    return res.status(503).json({ error: err.message });
  }

  try {
    if (!organizationId) {
      const orgs = await db
        .select({ id: schema.organizations.id })
        .from(schema.organizations)
        .limit(1);
      if (orgs.length === 0) {
        return res.status(409).json({
          error:
            'No organization exists yet. Run the bootstrap seed (POST /api/admin/seed) before registering devices.',
        });
      }
      organizationId = orgs[0].id;
    }

    // Upsert on token: re-registering refreshes last_seen and metadata
    // without creating duplicates.
    const result = await db
      .insert(schema.deviceTokens)
      .values({
        organizationId,
        userId: userId || null,
        platform,
        token,
        deviceModel: deviceModel || null,
        appVersion: appVersion || null,
        locale: locale || null,
      })
      .onConflictDoUpdate({
        target: schema.deviceTokens.token,
        set: {
          lastSeenAt: sql`now()`,
          userId: userId || null,
          deviceModel: deviceModel || null,
          appVersion: appVersion || null,
          locale: locale || null,
        },
      })
      .returning({ id: schema.deviceTokens.id });

    return res.status(200).json({ ok: true, id: result[0]?.id });
  } catch (err) {
    console.error('[push/register]', err);
    return res.status(500).json({ error: err.message });
  }
}
