// POST /api/admin/sync-twilio-numbers?secret=<TOKEN>
//
// Pulls every IncomingPhoneNumber from our Twilio account and
// upserts a phone_numbers row per number. Run once after wiring
// Twilio creds, then whenever a number is added/removed in the
// Twilio console.

import { eq } from 'drizzle-orm';
import {
  withAdminHandler,
  getDefaultOrgId,
} from '../../lib/adminHelpers.js';
import { getDb, schema } from '../../lib/db/index.js';
import { listIncomingPhoneNumbers, isTwilioConfigured } from '../../lib/backends/twilio.js';

export default withAdminHandler(async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'POST only' });
  }
  if (!isTwilioConfigured()) {
    return res.status(503).json({ ok: false, error: 'Twilio not configured' });
  }

  const db = getDb();
  const organizationId = await getDefaultOrgId();

  let twilioNumbers;
  try {
    twilioNumbers = await listIncomingPhoneNumbers();
  } catch (err) {
    return res.status(502).json({ ok: false, error: err.message });
  }

  let inserted = 0;
  let updated = 0;
  for (const tn of twilioNumbers) {
    const [existing] = await db
      .select({ id: schema.phoneNumbers.id })
      .from(schema.phoneNumbers)
      .where(eq(schema.phoneNumbers.e164Number, tn.phone_number))
      .limit(1);
    const values = {
      organizationId,
      twilioSid: tn.sid,
      e164Number: tn.phone_number,
      capabilities: tn.capabilities || null,
      updatedAt: new Date(),
    };
    if (existing) {
      await db
        .update(schema.phoneNumbers)
        .set(values)
        .where(eq(schema.phoneNumbers.id, existing.id));
      updated += 1;
    } else {
      await db.insert(schema.phoneNumbers).values({
        ...values,
        purpose: 'org_main',
        isActive: true,
      });
      inserted += 1;
    }
  }

  return res.status(200).json({
    ok: true,
    organization_id: organizationId,
    twilio_count: twilioNumbers.length,
    inserted,
    updated,
  });
});
