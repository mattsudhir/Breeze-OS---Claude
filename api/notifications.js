// Notifications API — read/write surface for the bell UI.
//
// GET  /api/notifications?unread=true&limit=50
//   List the current user's notifications, newest first. Optional
//   `unread=true` filters to unread only. Optional `limit` capped
//   at 200, default 50. Includes a top-level unread_count so the
//   bell badge can be updated from the same response.
//
// POST /api/notifications
//   Body: { action: 'mark_read', ids: [<uuid>...] }
//        or { action: 'mark_all_read' }
//   Returns { updated: <int> } in either case.
//
// User identification: until Clerk is wired in we accept the user
// id via `x-breeze-user-id` header and fall back to 'default-user'.
// The schema already supports multi-user, so when auth lands this
// becomes a session lookup with no DB migration.

import {
  DEFAULT_USER_ID,
  listNotifications,
  unreadCount,
  markRead,
  markAllRead,
} from '../lib/notifications.js';

function resolveUserId(req) {
  const headerVal = req.headers['x-breeze-user-id'];
  if (typeof headerVal === 'string' && headerVal.trim()) return headerVal.trim();
  return DEFAULT_USER_ID;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-breeze-user-id');

  if (req.method === 'OPTIONS') return res.status(200).end();

  const userId = resolveUserId(req);

  try {
    if (req.method === 'GET') {
      const unreadOnly = req.query?.unread === 'true' || req.query?.unread === '1';
      const limit = Number(req.query?.limit) || 50;
      const [items, unread] = await Promise.all([
        listNotifications({ userId, unreadOnly, limit }),
        unreadCount({ userId }),
      ]);
      return res.status(200).json({
        ok: true,
        unread_count: unread,
        notifications: items,
      });
    }

    if (req.method === 'POST') {
      const body = req.body || {};
      const action = body.action;
      if (action === 'mark_read') {
        const result = await markRead({ userId, ids: body.ids || [] });
        return res.status(200).json({ ok: true, ...result });
      }
      if (action === 'mark_all_read') {
        const result = await markAllRead({ userId });
        return res.status(200).json({ ok: true, ...result });
      }
      return res.status(400).json({
        error: 'action must be "mark_read" or "mark_all_read"',
      });
    }

    return res.status(405).json({ error: 'GET or POST only' });
  } catch (err) {
    console.error('[/api/notifications] handler error:', err);
    return res.status(err.status || 500).json({ error: err.message || 'Unknown error' });
  }
}
