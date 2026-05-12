// POST /api/messages/send-email?secret=<TOKEN>
// body: {
//   tenant_id?:       uuid
//   to:               string | string[]
//   subject:          string
//   html?:            string
//   text?:            string
//   reply_to?:        string
//   ai_workflow_id?:  uuid
// }
//
// Sends a transactional email via Resend. Persists the message in
// our messages table tagged by thread (lookup by tenant if provided).
// Consent gating respects tenant_communication_consents for email.

import { and, eq, desc } from 'drizzle-orm';
import {
  withAdminHandler,
  getDefaultOrgId,
  parseBody,
} from '../../lib/adminHelpers.js';
import { getDb, schema } from '../../lib/db/index.js';
import { sendEmail, isResendConfigured } from '../../lib/backends/resend.js';

export default withAdminHandler(async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'POST only' });
  }
  if (!isResendConfigured()) {
    return res.status(503).json({ ok: false, error: 'Resend not configured (set RESEND_API_KEY).' });
  }

  const body = parseBody(req);
  if (!body.to)      return res.status(400).json({ ok: false, error: 'to required' });
  if (!body.subject) return res.status(400).json({ ok: false, error: 'subject required' });
  if (!body.html && !body.text) {
    return res.status(400).json({ ok: false, error: 'html or text required' });
  }

  const db = getDb();
  const organizationId = await getDefaultOrgId();
  const tenantId = body.tenant_id || null;

  // Consent check.
  if (tenantId) {
    const [consent] = await db
      .select({ status: schema.tenantCommunicationConsents.status })
      .from(schema.tenantCommunicationConsents)
      .where(
        and(
          eq(schema.tenantCommunicationConsents.tenantId, tenantId),
          eq(schema.tenantCommunicationConsents.channel, 'email'),
        ),
      )
      .limit(1);
    if (consent?.status === 'opted_out') {
      return res.status(403).json({
        ok: false,
        error: 'Tenant has opted out of email. Sending blocked.',
      });
    }
  }

  // Find or create thread.
  let threadId = null;
  if (tenantId) {
    const [existing] = await db
      .select({ id: schema.messageThreads.id })
      .from(schema.messageThreads)
      .where(
        and(
          eq(schema.messageThreads.organizationId, organizationId),
          eq(schema.messageThreads.tenantId, tenantId),
        ),
      )
      .orderBy(desc(schema.messageThreads.createdAt))
      .limit(1);
    if (existing) threadId = existing.id;
  }
  if (!threadId) {
    const [t] = await db
      .insert(schema.messageThreads)
      .values({
        organizationId,
        tenantId,
        subject: body.subject,
        lastMessageAt: new Date(),
      })
      .returning({ id: schema.messageThreads.id });
    threadId = t.id;
  }

  // Insert queued message.
  const [msg] = await db
    .insert(schema.messages)
    .values({
      organizationId,
      threadId,
      channel: 'email',
      direction: 'outbound',
      status: 'queued',
      tenantId,
      toAddress: Array.isArray(body.to) ? body.to.join(', ') : body.to,
      subject: body.subject,
      body: body.text || body.html,
      aiWorkflowId: body.ai_workflow_id || null,
    })
    .returning({ id: schema.messages.id });

  let result;
  try {
    result = await sendEmail({
      to: body.to,
      subject: body.subject,
      html: body.html,
      text: body.text,
      replyTo: body.reply_to,
    });
  } catch (err) {
    await db
      .update(schema.messages)
      .set({ status: 'failed', errorMessage: err.message, updatedAt: new Date() })
      .where(eq(schema.messages.id, msg.id));
    return res.status(502).json({ ok: false, error: err.message, message_id: msg.id });
  }

  await db
    .update(schema.messages)
    .set({
      status: 'sent',
      externalId: result.id,
      sentAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(schema.messages.id, msg.id));

  await db
    .update(schema.messageThreads)
    .set({ lastMessageAt: new Date(), updatedAt: new Date() })
    .where(eq(schema.messageThreads.id, threadId));

  return res.status(200).json({
    ok: true,
    message_id: msg.id,
    resend_id: result.id,
  });
});
