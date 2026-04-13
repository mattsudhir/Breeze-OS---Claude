// Vercel Serverless Function — one-shot seed for utility_providers.
//
// POST /api/admin/seed?secret=<BREEZE_ADMIN_TOKEN>
//
// Inserts a starter set of Ohio utility providers so the property
// directory has something to point at on day one. Skips providers that
// already exist (by name + organization) so hitting this multiple times
// is safe.
//
// Edit SEED_PROVIDERS below to tune phone numbers, hours, or script
// notes. After the first run, new providers land cleanly on top of the
// existing set; changes to existing providers don't propagate (use the
// normal PATCH endpoint for updates).

import { and, eq } from 'drizzle-orm';
import { getDb, schema } from '../../lib/db/index.js';
import {
  withAdminHandler,
  getDefaultOrgId,
} from '../../lib/adminHelpers.js';

// Ohio-focused starter set. Phone numbers and hours are from public
// customer-service pages; script notes are hints the AI will reference
// when building per-call prompts in PR 3. Tune these to taste.
const SEED_PROVIDERS = [
  {
    name: 'Columbia Gas of Ohio',
    phoneNumber: '+18003440573',
    website: 'https://www.columbiagasohio.com',
    businessHours: {
      timezone: 'America/New_York',
      mon: [7, 19],
      tue: [7, 19],
      wed: [7, 19],
      thu: [7, 19],
      fri: [7, 19],
      sat: null,
      sun: null,
    },
    expectedHoldMinutes: 8,
    callScriptNotes:
      'Main IVR: press 2 for existing business customer, then 1 for account changes. ' +
      'Often asks for last 4 of the business tax ID (EIN) and service address. ' +
      'Will ask whether transferring service or starting new account.',
    requiredFields: ['ein_last4', 'service_address', 'effective_date'],
  },
  {
    name: 'Toledo Edison (FirstEnergy)',
    phoneNumber: '+18884542245',
    website: 'https://www.firstenergycorp.com/toledo_edison',
    businessHours: {
      timezone: 'America/New_York',
      mon: [8, 18],
      tue: [8, 18],
      wed: [8, 18],
      thu: [8, 18],
      fri: [8, 18],
      sat: null,
      sun: null,
    },
    expectedHoldMinutes: 12,
    callScriptNotes:
      'Start in the IVR for "start, stop, or transfer service". Commercial accounts ' +
      'go through a dedicated commercial rep queue — be prepared for a longer hold. ' +
      'Ask for the effective date up front; they will also want the prior account ' +
      'number if transferring an existing account.',
    requiredFields: ['ein_last4', 'service_address', 'effective_date', 'prior_account_number'],
  },
  {
    name: 'City of Toledo Department of Public Utilities (Water)',
    phoneNumber: '+14192451800',
    website: 'https://toledo.oh.gov/services/public-utilities',
    businessHours: {
      timezone: 'America/New_York',
      mon: [8, 17],
      tue: [8, 17],
      wed: [8, 17],
      thu: [8, 17],
      fri: [8, 17],
      sat: null,
      sun: null,
    },
    expectedHoldMinutes: 6,
    callScriptNotes:
      'Toledo Water keeps billing under the property owner by default for SFRs. ' +
      'We rarely need to switch this account during a move; most calls are to verify ' +
      'the LLC is still the account holder after a tenant change, or to update the ' +
      'mailing address for billing.',
    requiredFields: ['service_address', 'account_number_if_known'],
  },
  {
    name: 'Republic Services (Trash)',
    phoneNumber: '+14194709000',
    website: 'https://www.republicservices.com',
    businessHours: {
      timezone: 'America/New_York',
      mon: [8, 17],
      tue: [8, 17],
      wed: [8, 17],
      thu: [8, 17],
      fri: [8, 17],
      sat: null,
      sun: null,
    },
    expectedHoldMinutes: 10,
    callScriptNotes:
      'Commercial service line only. For residential trash at SFRs, the city usually ' +
      'handles pickup at no extra cost to the LLC. Keep this row for multi-family ' +
      'properties that need private hauler contracts.',
    requiredFields: ['service_address', 'account_number_if_known'],
  },
];

export default withAdminHandler(async (req, res) => {
  if (req.method !== 'POST' && req.method !== 'GET') {
    return res.status(405).json({ ok: false, error: 'GET or POST only' });
  }

  const db = getDb();
  const orgId = await getDefaultOrgId();

  const results = [];
  for (const provider of SEED_PROVIDERS) {
    // Check for an existing provider with the same name in this org —
    // skip to stay idempotent.
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
        ...provider,
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
  });
});
