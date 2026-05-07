// Notifications + follows data layer.
//
// All callers — the bell UI, the AppFolio webhook receiver, agent
// triggers — go through this module so dedup, fan-out, and access
// control live in one place.
//
// Auth note: the Breeze OS web app does not yet have authenticated
// sessions, so user_id is currently a free-form string passed by
// the caller (today: 'default-user' from the frontend). The schema
// is multi-user ready — once Clerk lands we replace the literal
// with the authenticated user's id.

import { and, eq, isNull, desc, inArray, sql } from 'drizzle-orm';
import { getDb, schema } from './db/index.js';
import { getDefaultOrgId } from './adminHelpers.js';
import { sendPushToUser } from './webpush.js';

export const DEFAULT_USER_ID = 'default-user';

const ENTITY_TYPES = new Set([
  'tenant',
  'property',
  'unit',
  'work_order',
  'charge',
  'lease',
  'lead',
]);

function assertEntityType(t) {
  if (!ENTITY_TYPES.has(t)) {
    throw new Error(`Unknown entity_type "${t}". Valid: ${[...ENTITY_TYPES].join(', ')}.`);
  }
}

// ── Follows ──────────────────────────────────────────────────────

export async function follow({ userId, entityType, entityId, entityLabel = null }) {
  assertEntityType(entityType);
  if (!entityId) throw new Error('entityId required');
  const db = getDb();
  const organizationId = await getDefaultOrgId();
  const [row] = await db
    .insert(schema.follows)
    .values({
      organizationId,
      userId: userId || DEFAULT_USER_ID,
      entityType,
      entityId,
      entityLabel,
    })
    .onConflictDoNothing({
      target: [
        schema.follows.organizationId,
        schema.follows.userId,
        schema.follows.entityType,
        schema.follows.entityId,
      ],
    })
    .returning();
  // If the row already existed, return it so the caller can render.
  if (row) return row;
  const existing = await db
    .select()
    .from(schema.follows)
    .where(
      and(
        eq(schema.follows.organizationId, organizationId),
        eq(schema.follows.userId, userId || DEFAULT_USER_ID),
        eq(schema.follows.entityType, entityType),
        eq(schema.follows.entityId, entityId),
      ),
    )
    .limit(1);
  return existing[0] || null;
}

export async function unfollow({ userId, entityType, entityId }) {
  assertEntityType(entityType);
  const db = getDb();
  const organizationId = await getDefaultOrgId();
  const result = await db
    .delete(schema.follows)
    .where(
      and(
        eq(schema.follows.organizationId, organizationId),
        eq(schema.follows.userId, userId || DEFAULT_USER_ID),
        eq(schema.follows.entityType, entityType),
        eq(schema.follows.entityId, entityId),
      ),
    );
  return { deleted: result.count ?? 0 };
}

export async function listFollows({ userId } = {}) {
  const db = getDb();
  const organizationId = await getDefaultOrgId();
  return db
    .select()
    .from(schema.follows)
    .where(
      and(
        eq(schema.follows.organizationId, organizationId),
        eq(schema.follows.userId, userId || DEFAULT_USER_ID),
      ),
    )
    .orderBy(desc(schema.follows.createdAt));
}

// ── Notifications ────────────────────────────────────────────────

export async function listNotifications({
  userId,
  limit = 50,
  unreadOnly = false,
} = {}) {
  const db = getDb();
  const organizationId = await getDefaultOrgId();
  const cap = Math.max(1, Math.min(Number(limit) || 50, 200));
  const conditions = [
    eq(schema.notifications.organizationId, organizationId),
    eq(schema.notifications.userId, userId || DEFAULT_USER_ID),
  ];
  if (unreadOnly) conditions.push(isNull(schema.notifications.readAt));
  return db
    .select()
    .from(schema.notifications)
    .where(and(...conditions))
    .orderBy(desc(schema.notifications.createdAt))
    .limit(cap);
}

export async function unreadCount({ userId } = {}) {
  const db = getDb();
  const organizationId = await getDefaultOrgId();
  const rows = await db
    .select({ c: sql`count(*)::int` })
    .from(schema.notifications)
    .where(
      and(
        eq(schema.notifications.organizationId, organizationId),
        eq(schema.notifications.userId, userId || DEFAULT_USER_ID),
        isNull(schema.notifications.readAt),
      ),
    );
  return Number(rows[0]?.c || 0);
}

export async function markRead({ userId, ids }) {
  if (!Array.isArray(ids) || ids.length === 0) return { updated: 0 };
  const db = getDb();
  const organizationId = await getDefaultOrgId();
  const result = await db
    .update(schema.notifications)
    .set({ readAt: new Date() })
    .where(
      and(
        eq(schema.notifications.organizationId, organizationId),
        eq(schema.notifications.userId, userId || DEFAULT_USER_ID),
        inArray(schema.notifications.id, ids),
        isNull(schema.notifications.readAt),
      ),
    );
  return { updated: result.count ?? 0 };
}

export async function markAllRead({ userId } = {}) {
  const db = getDb();
  const organizationId = await getDefaultOrgId();
  const result = await db
    .update(schema.notifications)
    .set({ readAt: new Date() })
    .where(
      and(
        eq(schema.notifications.organizationId, organizationId),
        eq(schema.notifications.userId, userId || DEFAULT_USER_ID),
        isNull(schema.notifications.readAt),
      ),
    );
  return { updated: result.count ?? 0 };
}

// Used by the AppFolio webhook receiver and by future agent triggers.
// dedup on (user_id, source_event_id) — webhook retries land as
// no-ops, so the bell never shows the same event twice for one user.
export async function createNotification({
  userId,
  entityType = null,
  entityId = null,
  entityLabel = null,
  eventType = null,
  source,
  title,
  body = null,
  linkUrl = null,
  payload = null,
  sourceEventId = null,
}) {
  if (!source) throw new Error('source required');
  if (!title) throw new Error('title required');

  const db = getDb();
  const organizationId = await getDefaultOrgId();
  try {
    const [row] = await db
      .insert(schema.notifications)
      .values({
        organizationId,
        userId: userId || DEFAULT_USER_ID,
        entityType,
        entityId,
        entityLabel,
        eventType,
        source,
        title,
        body,
        linkUrl,
        payload,
        sourceEventId,
      })
      .returning();
    return row;
  } catch (err) {
    // Postgres unique-violation on (user_id, source_event_id) =
    // duplicate webhook delivery; treat as a successful no-op.
    if (err?.code === '23505') return null;
    throw err;
  }
}

// Given an event on a single entity, find every user following it
// and create one notification per follower. Idempotent per
// (user, source_event_id) thanks to createNotification's dedup.
export async function fanoutEvent({
  entityType,
  entityId,
  entityLabel = null,
  eventType = null,
  source,
  title,
  body = null,
  linkUrl = null,
  payload = null,
  sourceEventId = null,
}) {
  assertEntityType(entityType);
  if (!entityId) throw new Error('entityId required');

  const db = getDb();
  const organizationId = await getDefaultOrgId();
  const followers = await db
    .select()
    .from(schema.follows)
    .where(
      and(
        eq(schema.follows.organizationId, organizationId),
        eq(schema.follows.entityType, entityType),
        eq(schema.follows.entityId, entityId),
      ),
    );

  let created = 0;
  for (const f of followers) {
    const n = await createNotification({
      userId: f.userId,
      entityType,
      entityId,
      entityLabel: entityLabel || f.entityLabel,
      eventType,
      source,
      title,
      body,
      linkUrl,
      payload,
      sourceEventId,
    });
    if (!n) continue;
    created += 1;
    // Fire web push (fire-and-forget). VAPID-not-configured /
    // no-subscription paths return cleanly; we don't await here so
    // the webhook receiver doesn't block on notification delivery.
    sendPushToUser({
      userId: f.userId,
      title: n.title,
      body: n.body || (entityLabel || f.entityLabel || ''),
      url: n.linkUrl || '/',
      tag: `${entityType}-${entityId}`,
    }).catch((err) => {
      console.warn('[notifications] push failed:', err?.message || err);
    });
  }
  return { followers: followers.length, created };
}
