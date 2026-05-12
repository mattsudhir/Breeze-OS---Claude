// One-shot helper: generates a VAPID keypair for web push and
// returns it on screen. The user pastes the three values into
// Vercel → Settings → Environment Variables (VAPID_PUBLIC_KEY,
// VAPID_PRIVATE_KEY, VAPID_SUBJECT), redeploys, and web push is
// live.
//
// IMPORTANT: this endpoint never persists the private key. The
// generated pair is one-time content shown in the response. Once
// you've copied the values into Vercel and redeployed, the keys
// only exist in env vars from that point on. Hitting this URL
// again generates a NEW pair (which would invalidate every
// existing subscription) — don't do that unless you mean to
// rotate.
//
// Auth: BREEZE_ADMIN_TOKEN via ?secret= or
// Authorization: Bearer <token>. Open in dev mode (no token
// configured).

import webpush from 'web-push';

function isAuthorized(req) {
  const expected = process.env.BREEZE_ADMIN_TOKEN;
  if (!expected) return true;
  const provided =
    req.query?.secret ||
    req.headers['x-breeze-admin-token'] ||
    (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  return provided === expected;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader(
    'Access-Control-Allow-Headers',
    'Content-Type, x-breeze-admin-token, Authorization',
  );
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' });

  if (!isAuthorized(req)) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  // Refuse to generate if VAPID is already configured. Rotating
  // requires explicit ?force=1 so a careless tap doesn't invalidate
  // every existing browser subscription.
  if (
    process.env.VAPID_PUBLIC_KEY &&
    process.env.VAPID_PRIVATE_KEY &&
    !req.query?.force
  ) {
    return res.status(409).json({
      error:
        'VAPID is already configured in this environment. Append &force=1 to ' +
        'this URL to rotate the keys (every existing browser subscription will ' +
        'be invalidated and users will need to opt back in).',
      currentPublicKey: process.env.VAPID_PUBLIC_KEY,
    });
  }

  const keys = webpush.generateVAPIDKeys();
  return res.status(200).json({
    ok: true,
    instructions: [
      '1. Copy these three values into Vercel → Settings → Environment Variables → Production:',
      `   VAPID_PUBLIC_KEY  = ${keys.publicKey}`,
      `   VAPID_PRIVATE_KEY = ${keys.privateKey}`,
      `   VAPID_SUBJECT     = mailto:you@your-domain.com`,
      '2. Redeploy (or trigger a new deploy by pushing any commit).',
      '3. Open the chat home page, click the bell icon, click "Enable browser notifications".',
      '4. Browser asks for permission. Grant it. Done.',
      '5. To verify: trigger a notification (e.g. follow a tenant in AppFolio + edit them) and watch the native popup fire.',
    ],
    keys: {
      VAPID_PUBLIC_KEY: keys.publicKey,
      VAPID_PRIVATE_KEY: keys.privateKey,
      VAPID_SUBJECT_example: 'mailto:partners@breezepropertygroup.com',
    },
    note:
      'Hitting this URL again will refuse unless you append &force=1. ' +
      'Rotating invalidates every existing subscription.',
  });
}
