// POST /api/webhooks/bill-com
//
// Bill.com sends webhooks when payment state changes (Scheduled →
// Sent → Cleared → etc.). We match by their payment id and update
// our bill_payments row's bill_com_status + sync timestamp.
//
// Auth: Bill.com's webhook signing is HMAC-SHA256 over the raw body
// using a per-webhook secret you configure on their dashboard.
// Verified via BILL_COM_WEBHOOK_SECRET.

import crypto from 'node:crypto';
import { eq } from 'drizzle-orm';
import { getDb, schema } from '../../lib/db/index.js';

export const config = {
  api: { bodyParser: false },
};

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

function verify(rawBody, signatureHeader) {
  const secret = process.env.BILL_COM_WEBHOOK_SECRET;
  if (!secret) return { valid: false, reason: 'no_secret_configured' };
  if (!signatureHeader) return { valid: false, reason: 'missing_signature_header' };
  const computed = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
  if (computed !== signatureHeader) {
    return { valid: false, reason: 'signature_mismatch' };
  }
  return { valid: true };
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'POST only' });
  }

  const rawBody = await readBody(req);
  if (process.env.BILL_COM_WEBHOOK_SECRET) {
    const v = verify(rawBody, req.headers['x-bill-com-signature']);
    if (!v.valid) {
      console.warn(`bill.com webhook: signature INVALID (${v.reason})`);
      return res.status(200).json({ ok: true, ignored: 'signature_invalid' });
    }
  }

  let body;
  try { body = JSON.parse(rawBody); } catch {
    return res.status(200).json({ ok: true, ignored: 'parse_failed' });
  }

  // Bill.com's webhook payload shape varies by event; expect either
  // { entity: 'SentPay', id, paymentStatus, ... } or a similar
  // structure. Defensive lookup of the fields we care about.
  const billComPaymentId = body.id || body.entityId || body.sentPayId;
  const status = body.paymentStatus || body.status || body.eventStatus;

  if (!billComPaymentId) {
    return res.status(200).json({ ok: true, ignored: 'no_payment_id' });
  }

  const db = getDb();
  const [updated] = await db
    .update(schema.billPayments)
    .set({
      billComStatus: status || null,
      billComSyncedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(schema.billPayments.billComPaymentId, billComPaymentId))
    .returning({ id: schema.billPayments.id });

  return res.status(200).json({
    ok: true,
    bill_com_payment_id: billComPaymentId,
    status,
    matched: Boolean(updated),
  });
}
