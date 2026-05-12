// Admin-gated test trigger for the notifications system.
//
// AppFolio's Database API v0 doesn't expose a write endpoint for
// payment receipts (only for new charges), so we can't actually
// post a real test payment from here. This endpoint stands in for
// that — it fires a synthetic event into fanoutCategoryEvent so we
// can verify the in-app bell + web push delivery path end-to-end
// without depending on a real AppFolio user action.
//
// GET /api/admin/test-notification?secret=<TOKEN>
//                                 &category=rent_payments
//                                 &title=Test+payment+received
//                                 &body=optional+body
//                                 &amount=1500
//
// Defaults are useful for the rent-receipt test case:
//   category=rent_payments
//   title=Payment received: $1,500.00
//   body=Test payment via /api/admin/test-notification
//
// Auth: BREEZE_ADMIN_TOKEN via ?secret= or
// Authorization: Bearer <token>. Open in dev mode (no token set).

import {
  CATEGORIES,
  isValidCategory,
  fanoutCategoryEvent,
} from '../../lib/categorySubscriptions.js';

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

  const category = String(req.query?.category || 'rent_payments');
  if (!isValidCategory(category)) {
    return res.status(400).json({
      error: `Unknown category "${category}". Valid: ${CATEGORIES.map((c) => c.id).join(', ')}.`,
    });
  }

  // Default copy varies per category so the test reads naturally.
  const amount = req.query?.amount;
  const defaults = {
    rent_payments: {
      title: amount
        ? `Payment received: $${Number(amount).toFixed(2)}`
        : 'Payment received: $1,500.00',
      body: 'Test payment via /api/admin/test-notification',
    },
    new_work_orders: {
      title: 'New work order: Leaky kitchen faucet',
      body: 'Test work order at 892 Monroe',
    },
    urgent_work_orders: {
      title: 'Urgent: HVAC failure',
      body: 'Test urgent work order',
    },
    new_tenants: {
      title: 'New tenant: Test Tenant',
      body: 'Test tenant added',
    },
    lease_signed: {
      title: 'New lease signed',
      body: 'Test lease',
    },
  };
  const fallback = { title: 'Test notification', body: 'Test event' };
  const d = defaults[category] || fallback;
  const title = String(req.query?.title || d.title);
  const body = req.query?.body !== undefined ? String(req.query.body) : d.body;

  try {
    const result = await fanoutCategoryEvent({
      category,
      title,
      body,
      sourceEventId: `test-${Date.now()}`,
      payload: {
        synthetic: true,
        triggered_via: '/api/admin/test-notification',
        category,
      },
    });
    return res.status(200).json({
      ok: true,
      category,
      title,
      body,
      result,
      hint:
        result.subscribers === 0
          ? `No users subscribed to "${category}". Toggle it on in Settings → Notifications first.`
          : `Fired ${result.created} notification(s) to ${result.subscribers} subscriber(s). Check the bell + your phone.`,
    });
  } catch (err) {
    console.error('[test-notification] error:', err);
    return res.status(500).json({ error: err.message || 'Unknown error' });
  }
}
