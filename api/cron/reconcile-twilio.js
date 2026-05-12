// POST /api/cron/reconcile-twilio?secret=<TOKEN>
//
// Periodic poll (target: every 5 min via Vercel Cron) that asks
// Twilio "give me all messages on my account in the last 15 min"
// and cross-checks against our messages table. Anything we missed
// (webhook dropped) gets inserted. The window is intentionally
// wider than the cron interval so a single missed run doesn't lose
// messages.
//
// We don't try to be exhaustive — the goal is drift detection +
// late catch-up, not full re-sync. Each run logs to
// phone_provider_reconciliations.

import { eq } from 'drizzle-orm';
import {
  withAdminHandler,
  getDefaultOrgId,
} from '../../lib/adminHelpers.js';
import { getDb, schema } from '../../lib/db/index.js';
import { listMessages, isTwilioConfigured } from '../../lib/backends/twilio.js';

const RECONCILE_WINDOW_MIN = 15;

export default withAdminHandler(async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'POST only' });
  }
  if (!isTwilioConfigured()) {
    return res.status(503).json({ ok: false, error: 'Twilio not configured' });
  }

  const db = getDb();
  const organizationId = await getDefaultOrgId();
  const now = new Date();
  const windowStart = new Date(now.getTime() - RECONCILE_WINDOW_MIN * 60 * 1000);

  let twilioMessages;
  try {
    twilioMessages = await listMessages({
      dateSentAfter: windowStart.toISOString(),
      pageSize: 200,
    });
  } catch (err) {
    return res.status(502).json({ ok: false, error: err.message });
  }

  let matched = 0;
  let inserted = 0;
  const anomalies = [];

  for (const tm of twilioMessages) {
    const [existing] = await db
      .select({ id: schema.messages.id })
      .from(schema.messages)
      .where(eq(schema.messages.externalId, tm.sid))
      .limit(1);
    if (existing) {
      matched += 1;
      continue;
    }
    // Webhook missed this one. Insert a shadow row.
    const direction = tm.direction === 'inbound' ? 'inbound' : 'outbound';
    const statusMap = {
      'queued': 'queued', 'accepted': 'queued', 'sending': 'sending',
      'sent': 'sent', 'delivered': 'delivered', 'received': 'delivered',
      'undelivered': 'failed', 'failed': 'failed',
    };
    const ourStatus = statusMap[tm.status] || 'sent';

    await db.insert(schema.messages).values({
      organizationId,
      channel: 'sms',
      direction,
      status: ourStatus,
      fromAddress: tm.from,
      toAddress: tm.to,
      body: tm.body || '',
      externalId: tm.sid,
      sentAt: tm.date_sent ? new Date(tm.date_sent) : null,
    });
    inserted += 1;
    anomalies.push({
      sid: tm.sid,
      direction,
      status: ourStatus,
      from: tm.from,
      to: tm.to,
    });
  }

  await db.insert(schema.phoneProviderReconciliations).values({
    organizationId,
    provider: 'twilio',
    scannedWindowStart: windowStart,
    scannedWindowEnd: now,
    matchedCount: matched,
    insertedCount: inserted,
    anomalies: anomalies.length > 0 ? anomalies : null,
  });

  return res.status(200).json({
    ok: true,
    organization_id: organizationId,
    window_min: RECONCILE_WINDOW_MIN,
    twilio_returned: twilioMessages.length,
    matched_count: matched,
    inserted_count: inserted,
    anomalies_count: anomalies.length,
  });
});
