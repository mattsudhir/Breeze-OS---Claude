// Human task queue ("things a person needs to do").
//
// Distinct from the existing tasks table which is a cron-worker
// retry queue for system async work. human_tasks is the user-facing
// inbox: payment allocations to apply in AppFolio, tenant requests
// needing PM review, vendor follow-ups, etc.
//
// Each task type carries its own SLA. dueAt is computed at create
// time from sla_hours; changing a task type's SLA later doesn't
// affect existing tasks. The Tasks page uses dueAt to render an
// SLA status pill (overdue / due soon / on track).
//
// Adding a new task type requires (a) entry in TASK_TYPES below,
// (b) an action renderer on the Tasks page that knows what button
// to render and where it should link.

import { and, eq, inArray, isNull, sql, desc, asc } from 'drizzle-orm';
import { getDb, schema } from './db/index.js';
import { getDefaultOrgId } from './adminHelpers.js';
import { createNotification } from './notifications.js';
import { sendPushToUser } from './webpush.js';

// Catalog of supported task types. Keep ids stable — they're stored
// in human_tasks.task_type and migrating values would require a
// data migration.
export const TASK_TYPES = {
  allocate_payment: {
    label: 'Allocate payment',
    slaHours: 72,
    description:
      'Apply a recorded receipt (check, money order, direct deposit, P2P) ' +
      'to specific charges in AppFolio per the tenant\'s payment-application ' +
      'order. The journal entry is already posted; this step settles the ' +
      'individual open charges.',
    actionLabel: 'Open in AppFolio',
  },
  charge_fee_review: {
    label: 'Review fee charged',
    slaHours: 168, // 7 days
    description:
      'A fee was charged to a tenant from Breeze. Verify amount, GL account, ' +
      'and supporting documentation are correct.',
    actionLabel: 'Open charge in AppFolio',
  },
  // Future: review_maintenance_request, follow_up_vendor,
  // quote_lease_renewal, respond_tenant_message, etc.
};

const VALID_TASK_TYPES = new Set(Object.keys(TASK_TYPES));
export function isValidTaskType(t) {
  return VALID_TASK_TYPES.has(t);
}

const VALID_PRIORITIES = new Set(['low', 'normal', 'high', 'urgent']);
const VALID_STATUSES = new Set(['open', 'in_progress', 'done', 'dismissed']);

// ── Create ─────────────────────────────────────────────────────────

/**
 * Create a human task. Computes dueAt automatically from the task
 * type's slaHours unless one is supplied explicitly. Fires a bell
 * notification + push to the assignee (or org-wide if unassigned).
 */
export async function createTask({
  taskType,
  title,
  description = null,
  relatedEntityType = null,
  relatedEntityId = null,
  assigneeUserId = null,
  priority = 'normal',
  payload = null,
  source = 'system',
  dueAt = null,
}) {
  if (!isValidTaskType(taskType)) {
    throw new Error(`Unknown task_type "${taskType}"`);
  }
  if (!title) throw new Error('title required');
  if (!VALID_PRIORITIES.has(priority)) priority = 'normal';

  const cfg = TASK_TYPES[taskType];
  const slaHours = cfg.slaHours;
  const computedDueAt =
    dueAt ||
    (slaHours ? new Date(Date.now() + slaHours * 3600_000) : null);

  const db = getDb();
  const orgId = await getDefaultOrgId();
  const [row] = await db
    .insert(schema.humanTasks)
    .values({
      organizationId: orgId,
      taskType,
      title,
      description,
      relatedEntityType,
      relatedEntityId,
      assigneeUserId,
      priority,
      status: 'open',
      dueAt: computedDueAt,
      slaHours,
      payload,
      source,
    })
    .returning();

  // Fire notification: bell row for the assignee (or default user
  // if unassigned), and a web push if they're subscribed.
  const recipientUserId = assigneeUserId || 'default-user';
  try {
    const linkUrl = '/'; // Frontend Tasks page is mounted under the app root
    const n = await createNotification({
      userId: recipientUserId,
      entityType: relatedEntityType,
      entityId: relatedEntityId,
      entityLabel: null,
      eventType: 'task_created',
      source: 'task',
      title: `Task: ${title}`,
      body: description || cfg.description,
      linkUrl,
      payload: { taskId: row.id, taskType },
      sourceEventId: `task-${row.id}`,
    });
    if (n) {
      sendPushToUser({
        userId: recipientUserId,
        title: `Task: ${title}`,
        body: description || cfg.description || '',
        url: linkUrl,
        tag: `task-${taskType}`,
      }).catch((err) => {
        console.warn('[human-tasks] push failed:', err?.message || err);
      });
    }
  } catch (err) {
    // Don't fail task creation if notification dispatch errors.
    console.warn('[human-tasks] notification fanout failed:', err?.message || err);
  }

  return row;
}

// ── Read ───────────────────────────────────────────────────────────

export async function listTasks({
  status = 'open',
  taskType = null,
  assigneeUserId = null,
  limit = 200,
} = {}) {
  const db = getDb();
  const orgId = await getDefaultOrgId();

  const conditions = [eq(schema.humanTasks.organizationId, orgId)];

  if (status === 'all') {
    // no filter
  } else if (status === 'active') {
    conditions.push(inArray(schema.humanTasks.status, ['open', 'in_progress']));
  } else if (VALID_STATUSES.has(status)) {
    conditions.push(eq(schema.humanTasks.status, status));
  }

  if (taskType) conditions.push(eq(schema.humanTasks.taskType, taskType));
  if (assigneeUserId) conditions.push(eq(schema.humanTasks.assigneeUserId, assigneeUserId));

  // Open / in_progress tasks: surface overdue / due-soon first via
  // dueAt asc with NULLs last. Done / dismissed: most recent first.
  const orderClauses =
    status === 'done' || status === 'dismissed'
      ? [desc(schema.humanTasks.completedAt), desc(schema.humanTasks.createdAt)]
      : [
          // PG default: NULLs sort LAST in asc; that's what we want
          // (no-due-date tasks fall below dated ones).
          asc(schema.humanTasks.dueAt),
          desc(schema.humanTasks.priority),
          desc(schema.humanTasks.createdAt),
        ];

  return db
    .select()
    .from(schema.humanTasks)
    .where(and(...conditions))
    .orderBy(...orderClauses)
    .limit(Math.min(Math.max(1, Number(limit) || 200), 500));
}

export async function getTask(id) {
  const db = getDb();
  const orgId = await getDefaultOrgId();
  const rows = await db
    .select()
    .from(schema.humanTasks)
    .where(and(
      eq(schema.humanTasks.organizationId, orgId),
      eq(schema.humanTasks.id, id),
    ))
    .limit(1);
  return rows[0] || null;
}

export async function openCounts() {
  const db = getDb();
  const orgId = await getDefaultOrgId();
  const rows = await db
    .select({
      taskType: schema.humanTasks.taskType,
      total: sql`count(*)::int`,
      overdue: sql`sum(case when ${schema.humanTasks.dueAt} < now() then 1 else 0 end)::int`,
    })
    .from(schema.humanTasks)
    .where(and(
      eq(schema.humanTasks.organizationId, orgId),
      inArray(schema.humanTasks.status, ['open', 'in_progress']),
    ))
    .groupBy(schema.humanTasks.taskType);
  return rows;
}

// ── Update ─────────────────────────────────────────────────────────

export async function setStatus(id, { status, completedBy = null }) {
  if (!VALID_STATUSES.has(status)) throw new Error(`Invalid status "${status}"`);
  const db = getDb();
  const orgId = await getDefaultOrgId();
  const isTerminal = status === 'done' || status === 'dismissed';
  const [row] = await db
    .update(schema.humanTasks)
    .set({
      status,
      completedAt: isTerminal ? new Date() : null,
      completedBy: isTerminal ? (completedBy || null) : null,
    })
    .where(and(
      eq(schema.humanTasks.organizationId, orgId),
      eq(schema.humanTasks.id, id),
    ))
    .returning();
  return row || null;
}

// ── SLA helper (frontend reuses this through the API response) ─────

export function slaStatus(task) {
  if (!task?.dueAt) return 'on_track';
  const due = new Date(task.dueAt).getTime();
  const now = Date.now();
  if (due < now) return 'overdue';
  if (due - now < 12 * 3600_000) return 'due_soon';
  return 'on_track';
}
