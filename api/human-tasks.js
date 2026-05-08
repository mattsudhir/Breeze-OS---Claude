// Human tasks API.
//
// GET /api/human-tasks
//   Query: ?status=open|in_progress|done|dismissed|active|all
//          &type=<task_type>
//          &assignee=<user_id>
//          &limit=<n>
//   Returns { tasks, taskTypes, counts } so the Tasks page can
//   render the inbox + the task-type catalog (labels, SLAs) + the
//   per-type counts (badge "X open" on the menu) in one round trip.
//
// POST /api/human-tasks
//   Body: { task_type, title, description?, related_entity_type?,
//           related_entity_id?, assignee_user_id?, priority?,
//           payload?, due_at? (override SLA-computed) }
//   Creates a task; fires bell + push to the assignee.
//
// PATCH /api/human-tasks
//   Body: { id, status }     (status in: in_progress | done | dismissed)
//   Updates a task.

import {
  TASK_TYPES,
  isValidTaskType,
  createTask,
  listTasks,
  setStatus,
  openCounts,
} from '../lib/humanTasks.js';

const DEFAULT_USER_ID = 'default-user';
function resolveUserId(req) {
  const headerVal = req.headers['x-breeze-user-id'];
  if (typeof headerVal === 'string' && headerVal.trim()) return headerVal.trim();
  return DEFAULT_USER_ID;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, OPTIONS');
  res.setHeader(
    'Access-Control-Allow-Headers',
    'Content-Type, x-breeze-user-id',
  );
  if (req.method === 'OPTIONS') return res.status(200).end();

  const userId = resolveUserId(req);

  try {
    if (req.method === 'GET') {
      const status = req.query?.status || 'active';
      const taskType = req.query?.type || null;
      const assigneeUserId = req.query?.assignee || null;
      const limit = Number(req.query?.limit) || 200;

      const [tasks, counts] = await Promise.all([
        listTasks({ status, taskType, assigneeUserId, limit }),
        openCounts(),
      ]);

      return res.status(200).json({
        ok: true,
        tasks,
        taskTypes: TASK_TYPES,
        counts,
      });
    }

    if (req.method === 'POST') {
      const body = req.body || {};
      if (!body.task_type) {
        return res.status(400).json({ error: 'task_type required' });
      }
      if (!isValidTaskType(body.task_type)) {
        return res.status(400).json({
          error: `Unknown task_type "${body.task_type}". Valid: ${Object.keys(TASK_TYPES).join(', ')}.`,
        });
      }
      if (!body.title) return res.status(400).json({ error: 'title required' });

      const task = await createTask({
        taskType: body.task_type,
        title: body.title,
        description: body.description || null,
        relatedEntityType: body.related_entity_type || null,
        relatedEntityId: body.related_entity_id || null,
        assigneeUserId: body.assignee_user_id || null,
        priority: body.priority || 'normal',
        payload: body.payload || null,
        source: body.source || 'manual',
        dueAt: body.due_at ? new Date(body.due_at) : null,
      });
      return res.status(200).json({ ok: true, task });
    }

    if (req.method === 'PATCH') {
      const { id, status } = req.body || {};
      if (!id) return res.status(400).json({ error: 'id required' });
      if (!status) return res.status(400).json({ error: 'status required' });
      const task = await setStatus(id, { status, completedBy: userId });
      if (!task) return res.status(404).json({ error: 'Task not found' });
      return res.status(200).json({ ok: true, task });
    }

    return res.status(405).json({ error: 'GET, POST, or PATCH only' });
  } catch (err) {
    console.error('[/api/human-tasks] error:', err);
    return res.status(err.status || 500).json({ error: err.message || 'Unknown error' });
  }
}
