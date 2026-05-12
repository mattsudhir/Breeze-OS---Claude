// Category subscriptions — "alert me on every X" notifications.
//
// Sits next to lib/notifications.js's per-entity fanout. The
// AppFolio webhook receiver invokes both: per-entity follows
// (Frank Strehl's tenant record changed) AND category fan-out
// (any tenant just paid rent). Both write into the same
// notifications table and trigger the same web push.

import { and, eq } from 'drizzle-orm';
import { getDb, schema } from './db/index.js';
import { getDefaultOrgId } from './adminHelpers.js';
import { createNotification } from './notifications.js';
import { sendPushToUser } from './webpush.js';

// Catalog of categories shown in Settings → Notifications. Adding
// a new entry requires (a) entry here, (b) a matcher in
// categoriesForEvent below.
//
// id is what's stored in category_subscriptions.category. Stable
// — don't rename without a migration. label / description are
// frontend-facing.
export const CATEGORIES = [
  {
    id: 'rent_payments',
    label: 'Rent payments received',
    description: 'Notify me whenever a tenant pays rent or any open charge is paid.',
  },
  {
    id: 'new_work_orders',
    label: 'New maintenance requests',
    description: 'Notify me whenever a new work order is opened in AppFolio.',
  },
  {
    id: 'urgent_work_orders',
    label: 'Urgent work orders',
    description: 'Notify me whenever a work order is created or escalated to Urgent priority.',
  },
  {
    id: 'new_tenants',
    label: 'New tenants',
    description: 'Notify me whenever a new tenant is added in AppFolio.',
  },
  {
    id: 'lease_signed',
    label: 'New leases signed',
    description: 'Notify me whenever a new lease is signed.',
  },
];

const VALID_CATEGORY_IDS = new Set(CATEGORIES.map((c) => c.id));

export function isValidCategory(id) {
  return VALID_CATEGORY_IDS.has(id);
}

const DEFAULT_USER_ID = 'default-user';

// ── CRUD ────────────────────────────────────────────────────────

export async function listSubscriptions({ userId } = {}) {
  const db = getDb();
  const orgId = await getDefaultOrgId();
  const rows = await db
    .select()
    .from(schema.categorySubscriptions)
    .where(
      and(
        eq(schema.categorySubscriptions.organizationId, orgId),
        eq(schema.categorySubscriptions.userId, userId || DEFAULT_USER_ID),
      ),
    );
  return rows;
}

export async function subscribe({ userId, category, criteria = null }) {
  if (!isValidCategory(category)) {
    throw new Error(`Unknown category "${category}"`);
  }
  const db = getDb();
  const orgId = await getDefaultOrgId();
  await db
    .insert(schema.categorySubscriptions)
    .values({
      organizationId: orgId,
      userId: userId || DEFAULT_USER_ID,
      category,
      criteria,
    })
    .onConflictDoNothing({
      target: [
        schema.categorySubscriptions.organizationId,
        schema.categorySubscriptions.userId,
        schema.categorySubscriptions.category,
      ],
    });
}

export async function unsubscribe({ userId, category }) {
  const db = getDb();
  const orgId = await getDefaultOrgId();
  await db
    .delete(schema.categorySubscriptions)
    .where(
      and(
        eq(schema.categorySubscriptions.organizationId, orgId),
        eq(schema.categorySubscriptions.userId, userId || DEFAULT_USER_ID),
        eq(schema.categorySubscriptions.category, category),
      ),
    );
}

// ── Event detection ─────────────────────────────────────────────
//
// Given a webhook event + the prior + current canonical states
// from the mirror, return zero or more category matches with the
// title/body that should appear in each subscriber's bell row.
//
// Note: "prior" is the mirrored row BEFORE we ran syncOneFromAppfolio
// for this webhook. It's null on the first time we ever see this
// resource (a fresh create event). "current" is the row AFTER
// that sync. The webhook receiver coordinates the order.

export function categoriesForEvent({ topic, eventType, prior, current }) {
  const matches = [];
  const evt = (eventType || '').toLowerCase();

  // ── Work orders ──
  if (topic === 'work_orders' && (evt === 'create' || evt.endsWith('_created'))) {
    const summary = current?.summary || current?.displayId || 'New work order';
    const where = current?.propertyName ? ` at ${current.propertyName}` : '';
    matches.push({
      category: 'new_work_orders',
      title: `New work order: ${summary}`,
      body: where.trim() ? where.trim() : null,
    });
    if ((current?.priority || '').toLowerCase() === 'urgent') {
      matches.push({
        category: 'urgent_work_orders',
        title: `Urgent: ${summary}`,
        body: where.trim() ? where.trim() : null,
      });
    }
  }

  if (topic === 'work_orders' && (evt === 'update' || evt.endsWith('_updated'))) {
    const wasUrgent = (prior?.priority || '').toLowerCase() === 'urgent';
    const isUrgent = (current?.priority || '').toLowerCase() === 'urgent';
    if (isUrgent && !wasUrgent) {
      matches.push({
        category: 'urgent_work_orders',
        title: `Escalated to Urgent: ${current?.summary || current?.displayId || 'Work order'}`,
        body: current?.propertyName || null,
      });
    }
  }

  // ── Charges (rent payments) ──
  // AppFolio doesn't fire a `payments` webhook topic. A tenant
  // paying down a charge surfaces here as a `charges` update where
  // amount_due decreased, or a destroy when the charge is cleared
  // entirely.
  if (topic === 'charges') {
    const priorAmount = parseFloat(
      prior?.amount_due ?? prior?.AmountDue ?? prior?.amountDue,
    );
    const currentAmount = parseFloat(
      current?.amount_due ?? current?.AmountDue ?? current?.amountDue,
    );

    if (
      (evt === 'update' || evt.endsWith('_updated')) &&
      Number.isFinite(priorAmount) &&
      Number.isFinite(currentAmount) &&
      currentAmount < priorAmount
    ) {
      const paid = (priorAmount - currentAmount).toFixed(2);
      matches.push({
        category: 'rent_payments',
        title: `Payment received: $${paid}`,
        body: current?.description || prior?.description || null,
      });
    } else if (
      (evt === 'destroy' || evt.endsWith('_destroyed')) &&
      Number.isFinite(priorAmount) &&
      priorAmount > 0
    ) {
      matches.push({
        category: 'rent_payments',
        title: `Charge cleared: $${priorAmount.toFixed(2)}`,
        body: prior?.description || null,
      });
    }
  }

  // ── Tenants ──
  if (topic === 'tenants' && (evt === 'create' || evt.endsWith('_created'))) {
    const name = current?.name || `${current?.first_name || ''} ${current?.last_name || ''}`.trim();
    matches.push({
      category: 'new_tenants',
      title: `New tenant: ${name || 'Unknown'}`,
      body: current?.property_name || null,
    });
  }

  // ── Leases ──
  if (topic === 'leases' && (evt === 'create' || evt.endsWith('_created'))) {
    matches.push({
      category: 'lease_signed',
      title: 'New lease signed',
      body: null,
    });
  }

  return matches;
}

// ── Fanout ──────────────────────────────────────────────────────
//
// For each subscriber to the matched category, write a notifications
// row + fire a web push. Dedup is per (user, source_event_id +
// category) so the same AppFolio event matching multiple categories
// produces one row per category per user (never duplicates within
// one category).

export async function fanoutCategoryEvent({
  category,
  title,
  body = null,
  payload = null,
  sourceEventId = null,
  entityType = null,
  entityId = null,
  entityLabel = null,
  linkUrl = null,
}) {
  if (!isValidCategory(category)) return { subscribers: 0, created: 0 };

  const db = getDb();
  const orgId = await getDefaultOrgId();
  const subs = await db
    .select()
    .from(schema.categorySubscriptions)
    .where(
      and(
        eq(schema.categorySubscriptions.organizationId, orgId),
        eq(schema.categorySubscriptions.category, category),
      ),
    );

  let created = 0;
  // Suffix the source_event_id with the category so the same
  // AppFolio event matching multiple categories (e.g. new + urgent
  // work order) lands as separate dedup keys per user.
  const dedupId = sourceEventId ? `${sourceEventId}__${category}` : null;

  for (const sub of subs) {
    const n = await createNotification({
      userId: sub.userId,
      entityType,
      entityId,
      entityLabel,
      eventType: category,
      source: 'category_subscription',
      title,
      body,
      linkUrl,
      payload,
      sourceEventId: dedupId,
    });
    if (!n) continue;
    created += 1;
    sendPushToUser({
      userId: sub.userId,
      title,
      body: body || '',
      url: linkUrl || '/',
      tag: `category-${category}`,
    }).catch((err) => {
      console.warn('[category-fanout] push failed:', err?.message || err);
    });
  }
  return { subscribers: subs.length, created };
}
