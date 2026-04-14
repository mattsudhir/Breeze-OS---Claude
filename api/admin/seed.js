// Vercel Serverless Function — one-shot seed for utility_providers.
//
// POST /api/admin/seed?secret=<BREEZE_ADMIN_TOKEN>
//
// Inserts (or skips if already present) the utility providers Breeze
// needs for its Ohio market — Toledo, Lima, and Youngstown. Safe to
// re-run: matches on (organization_id, name), so re-running adds only
// net-new providers.
//
// After seeding, hit /api/admin/assign-providers-by-city to wire up
// existing property_utilities rows to the right provider based on
// the property's service_city.

import { and, eq } from 'drizzle-orm';
import { getDb, schema } from '../../lib/db/index.js';
import {
  withAdminHandler,
  getDefaultOrgId,
} from '../../lib/adminHelpers.js';

// Ohio market seed set — Toledo, Lima, Youngstown. Phone numbers and
// hours are from public customer-service pages; script notes are
// hints the AI references when building per-call prompts. Tune as
// you discover real IVR paths during live calls.
const SEED_PROVIDERS = [
  // ── Toledo ─────────────────────────────────────────────────────
  {
    name: 'Toledo Edison',
    phoneNumber: '+18884542245',
    website: 'https://www.firstenergycorp.com/toledo_edison',
    businessHours: {
      timezone: 'America/New_York',
      mon: [8, 18], tue: [8, 18], wed: [8, 18], thu: [8, 18], fri: [8, 18],
      sat: null, sun: null,
    },
    expectedHoldMinutes: 12,
    callScriptNotes:
      'FirstEnergy-owned electric utility for Toledo. IVR path for ' +
      'start/stop/transfer service leads to a commercial rep queue. ' +
      'Ask for effective date up front; they will also want the prior ' +
      'account number if transferring an existing account.',
    requiredFields: ['ein_last4', 'service_address', 'effective_date', 'prior_account_number'],
  },
  {
    name: 'Columbia Gas of Ohio',
    phoneNumber: '+18003440573',
    website: 'https://www.columbiagasohio.com',
    businessHours: {
      timezone: 'America/New_York',
      mon: [7, 19], tue: [7, 19], wed: [7, 19], thu: [7, 19], fri: [7, 19],
      sat: null, sun: null,
    },
    expectedHoldMinutes: 8,
    callScriptNotes:
      'Main IVR: press 2 for existing business customer, then 1 for ' +
      'account changes. Often asks for last 4 of EIN and service ' +
      'address. Will ask whether transferring service or starting new.',
    requiredFields: ['ein_last4', 'service_address', 'effective_date'],
  },
  {
    name: 'Toledo Public Utilities',
    phoneNumber: '+14192451800',
    website: 'https://toledo.oh.gov/services/public-utilities',
    businessHours: {
      timezone: 'America/New_York',
      mon: [8, 17], tue: [8, 17], wed: [8, 17], thu: [8, 17], fri: [8, 17],
      sat: null, sun: null,
    },
    expectedHoldMinutes: 6,
    callScriptNotes:
      'City of Toledo water utility. Keeps billing under the property ' +
      'owner by default for SFRs. Rarely needs a switch during a move; ' +
      'most calls are to verify the LLC is still the account holder or ' +
      'update the mailing address for billing.',
    requiredFields: ['service_address', 'account_number_if_known'],
  },
  // ── Lima ───────────────────────────────────────────────────────
  {
    name: 'AEP Ohio',
    phoneNumber: '+18006723600',
    website: 'https://www.aepohio.com',
    businessHours: {
      timezone: 'America/New_York',
      mon: [7, 19], tue: [7, 19], wed: [7, 19], thu: [7, 19], fri: [7, 19],
      sat: null, sun: null,
    },
    expectedHoldMinutes: 10,
    callScriptNotes:
      'American Electric Power subsidiary serving Lima and other parts ' +
      'of Ohio outside the FirstEnergy footprint. Standard IVR path ' +
      'for start/stop/transfer service.',
    requiredFields: ['ein_last4', 'service_address', 'effective_date'],
  },
  {
    name: 'Enbridge',
    phoneNumber: '+18776472383',
    website: 'https://www.enbridgegas.com',
    businessHours: {
      timezone: 'America/New_York',
      mon: [7, 19], tue: [7, 19], wed: [7, 19], thu: [7, 19], fri: [7, 19],
      sat: [8, 17], sun: null,
    },
    expectedHoldMinutes: 10,
    callScriptNotes:
      'Gas utility serving Lima and Youngstown (Enbridge acquired the ' +
      'former Dominion Energy Ohio footprint). IVR: press 1 for ' +
      'business customer. Often asks for last 4 of EIN and service ' +
      'address. Confirm the account will list the LLC as account holder.',
    requiredFields: ['ein_last4', 'service_address', 'effective_date'],
  },
  {
    name: 'City of Lima',
    phoneNumber: '+14192216015',
    website: 'https://www.cityhall.lima.oh.us',
    businessHours: {
      timezone: 'America/New_York',
      mon: [8, 17], tue: [8, 17], wed: [8, 17], thu: [8, 17], fri: [8, 17],
      sat: null, sun: null,
    },
    expectedHoldMinutes: 5,
    callScriptNotes:
      'City of Lima utility billing office. Handles municipal water ' +
      'service. For duplexes with shared meters, confirm the meter ID ' +
      'and current account holder — bill will still be in LLC name but ' +
      'we want to verify.',
    requiredFields: ['service_address', 'account_number_if_known'],
  },
  // ── Youngstown ─────────────────────────────────────────────────
  {
    name: 'Ohio Edison',
    phoneNumber: '+18006333267',
    website: 'https://www.firstenergycorp.com/ohio_edison',
    businessHours: {
      timezone: 'America/New_York',
      mon: [8, 18], tue: [8, 18], wed: [8, 18], thu: [8, 18], fri: [8, 18],
      sat: null, sun: null,
    },
    expectedHoldMinutes: 12,
    callScriptNotes:
      'FirstEnergy-owned electric utility for Youngstown and northeast ' +
      'Ohio. Same call flow as Toledo Edison — different phone number.',
    requiredFields: ['ein_last4', 'service_address', 'effective_date', 'prior_account_number'],
  },
  {
    name: 'Youngstown Water Department',
    phoneNumber: '+13307424636',
    website: 'https://www.youngstownohio.gov/water',
    businessHours: {
      timezone: 'America/New_York',
      mon: [8, 16], tue: [8, 16], wed: [8, 16], thu: [8, 16], fri: [8, 16],
      sat: null, sun: null,
    },
    expectedHoldMinutes: 5,
    callScriptNotes:
      'City of Youngstown water department. Service typically stays ' +
      'under the LLC for SFRs. Confirmation-only calls are short; ' +
      'opening a new account may require a visit to city hall.',
    requiredFields: ['service_address', 'account_number_if_known'],
  },
  // ── Still seeded for multi-family trash contracts ──────────────
  {
    name: 'Republic Services',
    phoneNumber: '+14194709000',
    website: 'https://www.republicservices.com',
    businessHours: {
      timezone: 'America/New_York',
      mon: [8, 17], tue: [8, 17], wed: [8, 17], thu: [8, 17], fri: [8, 17],
      sat: null, sun: null,
    },
    expectedHoldMinutes: 10,
    callScriptNotes:
      'Commercial waste hauler for multi-family buildings. Not used ' +
      'for SFR trash in Ohio (those go to city pickup bundled with ' +
      'water billing).',
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
    hint: createdCount > 0
      ? 'Providers created. Next: hit /api/admin/assign-providers-by-city (or click "Assign by city" in the Utility Providers tab) to wire existing property_utilities rows to the right provider based on each property\'s service_city.'
      : null,
  });
});
