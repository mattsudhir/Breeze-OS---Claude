// POST /api/webhooks/resend
//
// Receives Resend's email delivery events:
//   email.sent | email.delivered | email.delivery_delayed |
//   email.bounced | email.complained | email.opened | email.clicked
//
// We update the matching messages row's status by external_id.
// Bounce / complaint flips status='failed' and writes errorMessage.

import { eq } from 'drizzle-orm';
import { getDb, schema } from '../../lib/db/index.js';
import { verifyResendWebhook } from '../../lib/backends/resend.js';

export const config = {
  api: { bodyParser: false },
};

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

function eventToStatus(eventType) {
  switch (eventType) {
    case 'email.sent':              return 'sent';
    case 'email.delivered':         return 'delivered';
    case 'email.delivery_delayed':  return 'sending';
    case 'email.bounced':           return 'failed';
    case 'email.complained':        return 'failed';
    default:                        return null;
  }
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'POST only' });
  }

  const rawBody = await readBody(req);

  // Verify signature if configured.
  if (process.env.RESEND_WEBHOOK_SECRET) {
    const v = verifyResendWebhook({
      rawBody,
      signatureHeader: req.headers['svix-signature'],
      svixId: req.headers['svix-id'],
      svixTimestamp: req.headers['svix-timestamp'],
    });
    if (!v.valid) {
      console.warn(`resend webhook: signature INVALID (${v.reason})`);
      return res.status(200).json({ ok: true, ignored: 'signature_invalid' });
    }
  }

  let body;
  try { body = JSON.parse(rawBody); } catch {
    return res.status(200).json({ ok: true, ignored: 'parse_failed' });
  }

  const eventType = body.type;
  const emailId = body.data?.email_id || body.data?.id;
  if (!eventType || !emailId) {
    return res.status(200).json({ ok: true, ignored: 'missing_fields' });
  }

  const db = getDb();
  const ourStatus = eventToStatus(eventType);
  if (!ourStatus) {
    // Opened / clicked events — record but don't change status.
    return res.status(200).json({ ok: true, acked: eventType });
  }

  const updates = { status: ourStatus, updatedAt: new Date() };
  if (ourStatus === 'delivered') updates.deliveredAt = new Date();
  if (ourStatus === 'failed') {
    updates.errorMessage = body.data?.reason || eventType;
  }

  await db
    .update(schema.messages)
    .set(updates)
    .where(eq(schema.messages.externalId, emailId));

  // Complaint → flag as opted_out for email channel.
  if (eventType === 'email.complained') {
    const [row] = await db
      .select({ tenantId: schema.messages.tenantId, organizationId: schema.messages.organizationId })
      .from(schema.messages)
      .where(eq(schema.messages.externalId, emailId))
      .limit(1);
    if (row?.tenantId) {
      await db
        .insert(schema.tenantCommunicationConsents)
        .values({
          organizationId: row.organizationId,
          tenantId: row.tenantId,
          channel: 'email',
          status: 'opted_out',
          optedOutAt: new Date(),
        })
        .onConflictDoUpdate({
          target: [
            schema.tenantCommunicationConsents.tenantId,
            schema.tenantCommunicationConsents.channel,
          ],
          set: {
            status: 'opted_out',
            optedOutAt: new Date(),
            updatedAt: new Date(),
          },
        });
    }
  }

  return res.status(200).json({ ok: true, event: eventType, status: ourStatus });
}
