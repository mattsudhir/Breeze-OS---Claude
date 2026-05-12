// POST /api/webhooks/twilio/sms
//
// Twilio's inbound SMS webhook + status callbacks. The same endpoint
// handles both because we look at the params to decide which:
//   - Inbound message:  has Body + MessageSid + From + To
//   - Status callback:  has MessageStatus + MessageSid (no Body)
//
// What we do per event:
//
//   Inbound:
//     1. Verify signature.
//     2. Match `From` → tenant_phone_aliases → tenant_id.
//        If no match, insert into messages with tenant_id=null and
//        mark thread subject "Unmatched inbound" so staff can claim.
//     3. Detect STOP / HELP keywords and act:
//          STOP → write tenant_communication_consents.status='opted_out',
//                 reply with "You've been unsubscribed."
//          HELP → reply with help text.
//     4. Insert messages row with direction='inbound', status='delivered'.
//     5. Update message_threads.last_message_at.
//     6. (Future) trigger AI auto-response respecting autonomy +
//        staff_paused.
//
//   Status callback:
//     Update the matching messages row by external_id (Twilio SID).
//     Map MessageStatus → our status enum.
//
// Twilio expects either 200 with empty TwiML <Response/> for inbound
// (we don't send via TwiML; the response just acks) or 200 for status.

import { and, eq, sql } from 'drizzle-orm';
import { getDb, schema } from '../../../lib/db/index.js';
import { verifyTwilioWebhook, sendSms, isOptOutBody, isHelpBody } from '../../../lib/backends/twilio.js';

export const config = {
  api: { bodyParser: false },
};

async function readForm(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString('utf8');
  const params = {};
  const usp = new URLSearchParams(raw);
  for (const [k, v] of usp) params[k] = v;
  return { raw, params };
}

function statusMap(twilioStatus) {
  switch (twilioStatus) {
    case 'queued':       return 'queued';
    case 'accepted':     return 'queued';
    case 'sending':      return 'sending';
    case 'sent':         return 'sent';
    case 'delivered':    return 'delivered';
    case 'undelivered':  return 'failed';
    case 'failed':       return 'failed';
    case 'received':     return 'delivered';
    default:             return null;
  }
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'POST only' });
  }

  let raw, params;
  try {
    ({ raw, params } = await readForm(req));
  } catch (err) {
    console.error('twilio webhook: body read failed', err);
    return res.status(200).type('text/xml').send('<Response/>');
  }
  void raw;

  // Verify signature.
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  const fullUrl = `https://${host}${req.url.split('?')[0]}`;
  const verify = verifyTwilioWebhook({
    signatureHeader: req.headers['x-twilio-signature'],
    url: fullUrl,
    params,
  });
  if (!verify.valid && process.env.TWILIO_SKIP_VERIFY !== 'true') {
    console.warn(`twilio webhook: signature INVALID (${verify.reason})`);
    return res.status(200).type('text/xml').send('<Response/>');
  }

  const db = getDb();
  const messageSid = params.MessageSid || params.SmsMessageSid;
  const messageStatus = params.MessageStatus || params.SmsStatus;

  // Status callback path
  if (messageStatus && !params.Body) {
    const ourStatus = statusMap(messageStatus);
    if (ourStatus && messageSid) {
      await db
        .update(schema.messages)
        .set({
          status: ourStatus,
          deliveredAt: ourStatus === 'delivered' ? new Date() : undefined,
          updatedAt: new Date(),
        })
        .where(eq(schema.messages.externalId, messageSid));
    }
    return res.status(200).type('text/xml').send('<Response/>');
  }

  // Inbound message path
  const fromE164 = params.From;
  const toE164 = params.To;
  const body = params.Body || '';

  // Look up our phone_numbers row by To (so we know which org owns it).
  const [pn] = await db
    .select({
      id: schema.phoneNumbers.id,
      organizationId: schema.phoneNumbers.organizationId,
      propertyId: schema.phoneNumbers.propertyId,
    })
    .from(schema.phoneNumbers)
    .where(eq(schema.phoneNumbers.e164Number, toE164))
    .limit(1);
  if (!pn) {
    console.warn(`twilio webhook: inbound to unknown number ${toE164}`);
    return res.status(200).type('text/xml').send('<Response/>');
  }
  const organizationId = pn.organizationId;

  // Match the sender to a tenant via aliases.
  const [alias] = await db
    .select({ tenantId: schema.tenantPhoneAliases.tenantId })
    .from(schema.tenantPhoneAliases)
    .where(
      and(
        eq(schema.tenantPhoneAliases.organizationId, organizationId),
        eq(schema.tenantPhoneAliases.phoneE164, fromE164),
      ),
    )
    .limit(1);
  const tenantId = alias?.tenantId || null;

  // Find or create the thread (by tenant if matched, else fresh).
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
      .orderBy(sql`${schema.messageThreads.createdAt} DESC`)
      .limit(1);
    if (existing) {
      threadId = existing.id;
    } else {
      const [newThread] = await db
        .insert(schema.messageThreads)
        .values({
          organizationId,
          tenantId,
          propertyId: pn.propertyId,
          subject: 'SMS conversation',
          fromPhoneNumberId: pn.id,
          lastMessageAt: new Date(),
        })
        .returning({ id: schema.messageThreads.id });
      threadId = newThread.id;
    }
  } else {
    // Unmatched: create a thread without tenant_id; staff claims later.
    const [newThread] = await db
      .insert(schema.messageThreads)
      .values({
        organizationId,
        propertyId: pn.propertyId,
        subject: `Unmatched inbound from ${fromE164}`,
        fromPhoneNumberId: pn.id,
        lastMessageAt: new Date(),
      })
      .returning({ id: schema.messageThreads.id });
    threadId = newThread.id;
  }

  // Insert inbound message.
  const [inboundMsg] = await db
    .insert(schema.messages)
    .values({
      organizationId,
      threadId,
      channel: 'sms',
      direction: 'inbound',
      status: 'delivered',
      tenantId,
      propertyId: pn.propertyId,
      fromAddress: fromE164,
      toAddress: toE164,
      body,
      externalId: messageSid,
      deliveredAt: new Date(),
    })
    .returning({ id: schema.messages.id });

  // Bump thread's last_message_at.
  await db
    .update(schema.messageThreads)
    .set({ lastMessageAt: new Date(), updatedAt: new Date() })
    .where(eq(schema.messageThreads.id, threadId));

  // STOP / HELP keyword handling.
  if (isOptOutBody(body) && tenantId) {
    await db
      .insert(schema.tenantCommunicationConsents)
      .values({
        organizationId,
        tenantId,
        channel: 'sms',
        status: 'opted_out',
        optedOutAt: new Date(),
        optedOutViaMsg: inboundMsg.id,
      })
      .onConflictDoUpdate({
        target: [schema.tenantCommunicationConsents.tenantId, schema.tenantCommunicationConsents.channel],
        set: {
          status: 'opted_out',
          optedOutAt: new Date(),
          optedOutViaMsg: inboundMsg.id,
          updatedAt: new Date(),
        },
      });
    // Twilio auto-acknowledges STOP at the carrier level; we don't
    // need to send a confirmation (and shouldn't — Twilio sends its
    // own).
  } else if (isHelpBody(body)) {
    try {
      await sendSms({
        from: toE164,
        to: fromE164,
        body: 'Breeze OS — reply STOP to opt out of texts. Contact your property manager for assistance.',
      });
    } catch (err) {
      console.error('twilio webhook: HELP reply failed', err);
    }
  }

  return res.status(200).type('text/xml').send('<Response/>');
}
