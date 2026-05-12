// POST /api/messages/send-sms?secret=<TOKEN>
// body: {
//   tenant_id?:        uuid     (preferred — we'll look up consent + thread)
//   to:                string   E.164
//   body:              string
//   from_phone_id?:    uuid     (override sticky-from; defaults to thread's
//                                from_phone_number_id or org_main)
//   ai_workflow_id?:   uuid     (tag the message with a workflow)
// }
//
// Sticky-from enforcement: if a thread already has from_phone_number_id
// set, we use that. Otherwise we pick the first active org_main number
// in the org and pin it to the thread.
//
// Consent enforcement: if tenant has opted out of SMS, we hard-reject.

import { and, eq, desc } from 'drizzle-orm';
import {
  withAdminHandler,
  getDefaultOrgId,
  parseBody,
} from '../../lib/adminHelpers.js';
import { getDb, schema } from '../../lib/db/index.js';
import { sendSms, isTwilioConfigured } from '../../lib/backends/twilio.js';

export default withAdminHandler(async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'POST only' });
  }
  if (!isTwilioConfigured()) {
    return res.status(503).json({ ok: false, error: 'Twilio not configured (set TWILIO_ACCOUNT_SID + TWILIO_AUTH_TOKEN).' });
  }

  const body = parseBody(req);
  if (!body.to) return res.status(400).json({ ok: false, error: 'to required (E.164)' });
  if (!body.body) return res.status(400).json({ ok: false, error: 'body required' });

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
          eq(schema.tenantCommunicationConsents.channel, 'sms'),
        ),
      )
      .limit(1);
    if (consent?.status === 'opted_out') {
      return res.status(403).json({
        ok: false,
        error: 'Tenant has opted out of SMS. Sending blocked at the API layer for TCPA compliance.',
      });
    }
  }

  // Find or create the thread.
  let threadId = null;
  let thread = null;
  if (tenantId) {
    const [existing] = await db
      .select()
      .from(schema.messageThreads)
      .where(
        and(
          eq(schema.messageThreads.organizationId, organizationId),
          eq(schema.messageThreads.tenantId, tenantId),
        ),
      )
      .orderBy(desc(schema.messageThreads.createdAt))
      .limit(1);
    if (existing) {
      thread = existing;
      threadId = existing.id;
    }
  }

  // Pick the from-phone-number.
  let fromPhone = null;
  if (body.from_phone_id) {
    const [pn] = await db
      .select()
      .from(schema.phoneNumbers)
      .where(
        and(
          eq(schema.phoneNumbers.id, body.from_phone_id),
          eq(schema.phoneNumbers.organizationId, organizationId),
        ),
      )
      .limit(1);
    fromPhone = pn;
  } else if (thread?.fromPhoneNumberId) {
    const [pn] = await db
      .select()
      .from(schema.phoneNumbers)
      .where(eq(schema.phoneNumbers.id, thread.fromPhoneNumberId))
      .limit(1);
    fromPhone = pn;
  }
  if (!fromPhone) {
    // Default: first active phone_number for the org.
    const [pn] = await db
      .select()
      .from(schema.phoneNumbers)
      .where(
        and(
          eq(schema.phoneNumbers.organizationId, organizationId),
          eq(schema.phoneNumbers.isActive, true),
        ),
      )
      .limit(1);
    fromPhone = pn;
  }
  if (!fromPhone) {
    return res.status(503).json({
      ok: false,
      error: 'No phone numbers provisioned in org. Use /api/admin/sync-twilio-numbers to import.',
    });
  }

  // Create thread if it didn't exist yet.
  if (!threadId) {
    const [newThread] = await db
      .insert(schema.messageThreads)
      .values({
        organizationId,
        tenantId,
        propertyId: fromPhone.propertyId || null,
        subject: 'SMS conversation',
        fromPhoneNumberId: fromPhone.id,
        lastMessageAt: new Date(),
      })
      .returning({ id: schema.messageThreads.id });
    threadId = newThread.id;
  } else if (!thread.fromPhoneNumberId) {
    // Stick it on.
    await db
      .update(schema.messageThreads)
      .set({ fromPhoneNumberId: fromPhone.id, updatedAt: new Date() })
      .where(eq(schema.messageThreads.id, threadId));
  }

  // Insert queued message row.
  const [msg] = await db
    .insert(schema.messages)
    .values({
      organizationId,
      threadId,
      channel: 'sms',
      direction: 'outbound',
      status: 'queued',
      tenantId,
      fromAddress: fromPhone.e164Number,
      toAddress: body.to,
      body: body.body,
      aiWorkflowId: body.ai_workflow_id || null,
    })
    .returning({ id: schema.messages.id });

  // Send via Twilio.
  let twilioResult;
  try {
    const host = req.headers['x-forwarded-host'] || req.headers.host;
    const statusCallback = host ? `https://${host}/api/webhooks/twilio/sms` : undefined;
    twilioResult = await sendSms({
      from: fromPhone.e164Number,
      to: body.to,
      body: body.body,
      statusCallback,
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
      externalId: twilioResult.sid,
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
    twilio_sid: twilioResult.sid,
    twilio_status: twilioResult.status,
    from: fromPhone.e164Number,
    to: body.to,
  });
});
