// Vercel Serverless Function — one-shot seed for utility_providers.
//
// POST /api/admin/seed?secret=<BREEZE_ADMIN_TOKEN>
//
// Inserts (or skips if already present) the utility providers Breeze
// needs for its Ohio market. **Only the provider name and a generic
// call-script reminder** are seeded — phone numbers, business hours,
// IVR paths, and required fields are left NULL because they should
// be filled in by humans after actual calls have been made and the
// data verified. An earlier version of this seed populated those
// fields with plausible-looking but unverified guesses, which was
// dangerous; PR 8 wiped them.
//
// After running this seed, providers need real phone numbers before
// the move-event worker can actually dial them. Add phone numbers
// via the utility_providers PATCH endpoint or directly in Neon.
//
// After seeding, hit /api/admin/assign-providers-by-city to wire up
// existing property_utilities rows to the right provider based on
// the property's service_city. That endpoint matches providers by
// NAME only, so it works correctly regardless of phone-number state.

import { and, eq } from 'drizzle-orm';
import { getDb, schema } from '../../lib/db/index.js';
import {
  withAdminHandler,
  getDefaultOrgId,
} from '../../lib/adminHelpers.js';

// Single honest script note for every seeded provider. Replace or
// extend per-provider as you gather real IVR paths from actual calls.
const GENERIC_SCRIPT_NOTES =
  'Agent should be prepared to present owner name, mailing address, EIN, and start date for service.';

// Ohio market seed set. Just names — all other fields stay NULL
// until verified data is gathered.
const SEED_PROVIDERS = [
  // Toledo
  { name: 'Toledo Edison' },
  { name: 'Columbia Gas of Ohio' },
  { name: 'Toledo Public Utilities' },
  // Lima
  { name: 'AEP Ohio' },
  { name: 'Enbridge' },
  { name: 'City of Lima' },
  // Youngstown
  { name: 'Ohio Edison' },
  { name: 'Youngstown Water Department' },
  // Multi-family trash (kept for future use)
  { name: 'Republic Services' },
];

export default withAdminHandler(async (req, res) => {
  if (req.method !== 'POST' && req.method !== 'GET') {
    return res.status(405).json({ ok: false, error: 'GET or POST only' });
  }

  const db = getDb();
  const orgId = await getDefaultOrgId();

  const results = [];
  for (const provider of SEED_PROVIDERS) {
    // Match by name so re-runs don't duplicate.
    const existing = await db
      .select()
      .from(schema.utilityProviders)
      .where(
        and(
          eq(schema.utilityProviders.organizationId, orgId),
          eq(schema.utilityProviders.name, provider.name),
        ),
      )
      .limit(1);

    if (existing.length > 0) {
      results.push({ name: provider.name, status: 'skipped_existing', id: existing[0].id });
      continue;
    }

    const [created] = await db
      .insert(schema.utilityProviders)
      .values({
        organizationId: orgId,
        name: provider.name,
        callScriptNotes: GENERIC_SCRIPT_NOTES,
        // phoneNumber, businessHours, expectedHoldMinutes, requiredFields
        // intentionally left NULL — fill in after real calls verify them.
      })
      .returning();

    results.push({ name: provider.name, status: 'created', id: created.id });
  }

  const createdCount = results.filter((r) => r.status === 'created').length;
  const skippedCount = results.filter((r) => r.status === 'skipped_existing').length;

  return res.status(200).json({
    ok: true,
    organizationId: orgId,
    createdCount,
    skippedCount,
    results,
    note:
      'Providers created with name + generic script note only. Phone ' +
      'numbers and other per-provider details must be added manually ' +
      'before the move-event worker can fire real calls.',
  });
});
