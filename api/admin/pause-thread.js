// POST /api/admin/pause-thread?secret=<TOKEN>
// body: { thread_id, paused: boolean }
//
// Toggles message_threads.staff_paused. When true, the AI auto-
// responder skips this thread. Staff replies still go through.

import { and, eq } from 'drizzle-orm';
import {
  withAdminHandler,
  getDefaultOrgId,
  parseBody,
} from '../../lib/adminHelpers.js';
import { getDb, schema } from '../../lib/db/index.js';

export default withAdminHandler(async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'POST only' });
  }
  const body = parseBody(req);
  if (!body.thread_id) return res.status(400).json({ ok: false, error: 'thread_id required' });
  const paused = body.paused !== false;

  const db = getDb();
  const organizationId = await getDefaultOrgId();

  const updated = await db
    .update(schema.messageThreads)
    .set({ staffPaused: paused, updatedAt: new Date() })
    .where(
      and(
        eq(schema.messageThreads.id, body.thread_id),
        eq(schema.messageThreads.organizationId, organizationId),
      ),
    )
    .returning({ id: schema.messageThreads.id, staffPaused: schema.messageThreads.staffPaused });

  if (updated.length === 0) {
    return res.status(404).json({ ok: false, error: 'thread not found' });
  }

  return res.status(200).json({
    ok: true,
    thread_id: updated[0].id,
    staff_paused: updated[0].staffPaused,
  });
});
