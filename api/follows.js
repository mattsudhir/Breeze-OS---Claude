// Follows API — what the user has subscribed to.
//
// GET    /api/follows
//   List the current user's follows, newest first.
//
// POST   /api/follows
//   Body: { entity_type, entity_id, entity_label? }
//   Idempotent: re-following a row you already follow returns the
//   existing row instead of creating a duplicate.
//
// DELETE /api/follows
//   Body: { entity_type, entity_id }
//   Returns { deleted: <0|1> }. Vercel rewrite-style routing makes
//   path-param DELETE awkward, so we accept the entity in the body
//   for symmetry with POST.
//
// User identification: x-breeze-user-id header, falling back to
// 'default-user' until Clerk is in.

import {
  DEFAULT_USER_ID,
  listFollows,
  follow,
  unfollow,
} from '../lib/notifications.js';

function resolveUserId(req) {
  const headerVal = req.headers['x-breeze-user-id'];
  if (typeof headerVal === 'string' && headerVal.trim()) return headerVal.trim();
  return DEFAULT_USER_ID;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-breeze-user-id');

  if (req.method === 'OPTIONS') return res.status(200).end();

  const userId = resolveUserId(req);

  try {
    if (req.method === 'GET') {
      const items = await listFollows({ userId });
      return res.status(200).json({ ok: true, follows: items });
    }

    if (req.method === 'POST') {
      const { entity_type, entity_id, entity_label } = req.body || {};
      if (!entity_type || !entity_id) {
        return res.status(400).json({ error: 'entity_type and entity_id required' });
      }
      const row = await follow({
        userId,
        entityType: entity_type,
        entityId: entity_id,
        entityLabel: entity_label || null,
      });
      return res.status(200).json({ ok: true, follow: row });
    }

    if (req.method === 'DELETE') {
      const { entity_type, entity_id } = req.body || {};
      if (!entity_type || !entity_id) {
        return res.status(400).json({ error: 'entity_type and entity_id required' });
      }
      const result = await unfollow({
        userId,
        entityType: entity_type,
        entityId: entity_id,
      });
      return res.status(200).json({ ok: true, ...result });
    }

    return res.status(405).json({ error: 'GET, POST, or DELETE only' });
  } catch (err) {
    console.error('[/api/follows] handler error:', err);
    return res.status(err.status || 500).json({ error: err.message || 'Unknown error' });
  }
}
