// Category subscriptions API ("alert me on every X").
//
// GET /api/category-subscriptions
//   Returns { categories: [{id, label, description}], subscribed: ['rent_payments', ...] }
//   so the Settings page can render every available toggle and
//   know which ones are currently on.
//
// POST /api/category-subscriptions
//   Body: { category, enabled } — toggles a single category.
//   Idempotent: subscribing twice is a no-op; unsubscribing
//   when not subscribed is a no-op.
//
// User identification: x-breeze-user-id header, fallback
// 'default-user'. Mirrors the rest of our notification surfaces
// until Clerk lands.

import {
  CATEGORIES,
  isValidCategory,
  listSubscriptions,
  subscribe,
  unsubscribe,
} from '../lib/categorySubscriptions.js';

const DEFAULT_USER_ID = 'default-user';

function resolveUserId(req) {
  const headerVal = req.headers['x-breeze-user-id'];
  if (typeof headerVal === 'string' && headerVal.trim()) return headerVal.trim();
  return DEFAULT_USER_ID;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader(
    'Access-Control-Allow-Headers',
    'Content-Type, x-breeze-user-id',
  );
  if (req.method === 'OPTIONS') return res.status(200).end();

  const userId = resolveUserId(req);

  try {
    if (req.method === 'GET') {
      const subs = await listSubscriptions({ userId });
      return res.status(200).json({
        ok: true,
        categories: CATEGORIES,
        subscribed: subs.map((s) => s.category),
      });
    }

    if (req.method === 'POST') {
      const { category, enabled } = req.body || {};
      if (!category) {
        return res.status(400).json({ error: 'category required' });
      }
      if (!isValidCategory(category)) {
        return res.status(400).json({
          error: `Unknown category "${category}". Valid: ${CATEGORIES.map((c) => c.id).join(', ')}.`,
        });
      }
      if (enabled) {
        await subscribe({ userId, category });
      } else {
        await unsubscribe({ userId, category });
      }
      return res.status(200).json({ ok: true, category, enabled: !!enabled });
    }

    return res.status(405).json({ error: 'GET or POST only' });
  } catch (err) {
    console.error('[/api/category-subscriptions] error:', err);
    return res.status(err.status || 500).json({ error: err.message || 'Unknown error' });
  }
}
