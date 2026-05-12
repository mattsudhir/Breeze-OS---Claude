// GET /api/admin/list-thread-messages?secret=<TOKEN>&thread_id=<uuid>
//
// Returns every message in a thread, oldest first, for the
// conversation pane.

import { and, asc, eq } from 'drizzle-orm';
import {
  withAdminHandler,
  getDefaultOrgId,
} from '../../lib/adminHelpers.js';
import { getDb, schema } from '../../lib/db/index.js';

export default withAdminHandler(async (req, res) => {
  if (req.method !== 'GET') {
    return res.status(405).json({ ok: false, error: 'GET only' });
  }
  const threadId = req.query?.thread_id;
  if (!threadId) return res.status(400).json({ ok: false, error: 'thread_id required' });

  const db = getDb();
  const organizationId = await getDefaultOrgId();

  const [thread] = await db
    .select()
    .from(schema.messageThreads)
    .where(
      and(
        eq(schema.messageThreads.id, threadId),
        eq(schema.messageThreads.organizationId, organizationId),
      ),
    )
    .limit(1);
  if (!thread) return res.status(404).json({ ok: false, error: 'thread not found' });

  const messages = await db
    .select({
      id: schema.messages.id,
      channel: schema.messages.channel,
      direction: schema.messages.direction,
      status: schema.messages.status,
      fromAddress: schema.messages.fromAddress,
      toAddress: schema.messages.toAddress,
      subject: schema.messages.subject,
      body: schema.messages.body,
      externalId: schema.messages.externalId,
      errorMessage: schema.messages.errorMessage,
      sentAt: schema.messages.sentAt,
      deliveredAt: schema.messages.deliveredAt,
      createdAt: schema.messages.createdAt,
      aiWorkflowId: schema.messages.aiWorkflowId,
    })
    .from(schema.messages)
    .where(eq(schema.messages.threadId, threadId))
    .orderBy(asc(schema.messages.createdAt));

  return res.status(200).json({
    ok: true,
    thread: {
      id: thread.id,
      tenant_id: thread.tenantId,
      property_id: thread.propertyId,
      subject: thread.subject,
      staff_paused: thread.staffPaused,
      from_phone_number_id: thread.fromPhoneNumberId,
      last_message_at: thread.lastMessageAt,
    },
    messages: messages.map((m) => ({
      id: m.id,
      channel: m.channel,
      direction: m.direction,
      status: m.status,
      from_address: m.fromAddress,
      to_address: m.toAddress,
      subject: m.subject,
      body: m.body,
      external_id: m.externalId,
      error_message: m.errorMessage,
      sent_at: m.sentAt,
      delivered_at: m.deliveredAt,
      created_at: m.createdAt,
      ai_workflow_id: m.aiWorkflowId,
    })),
  });
});
