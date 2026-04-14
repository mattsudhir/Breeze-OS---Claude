// Vercel Serverless Function — bulk configure property_utilities.
//
// POST /api/admin/property-utilities-bulk
// Body:
//   {
//     filter: {                          // any combination; AND'd together
//       propertyIds: [uuid, ...],        // exact matches, takes precedence if present
//       rmPropertyIds: [int, ...],       // match by Rent Manager ID
//       city: "Toledo",                  // case-insensitive contains
//       state: "OH",                     // exact state code
//       zipPrefix: "445",                // zip startsWith
//       namePattern: "Ottawa",           // case-insensitive contains on displayName
//       allProperties: true,             // override — match every property in the org
//     },
//     utilityType: "electric",           // required; one of the enum values
//     accountHolder: "tenant",           // required; tenant | owner_llc
//     providerId: null | uuid,           // optional — set to a utility_provider FK
//     billbackTenant: false,             // optional
//     notes: null | string,              // optional
//     dryRun: false,                     // if true, only return the matched list
//                                        // without writing anything
//   }
//
// Behavior:
//   - Resolves the filter against the properties table, returning a
//     list of matched property_ids scoped to the default organization.
//   - For each matched property, upserts a property_utilities row on
//     (property_id, utility_type). Pre-existing rows for the same
//     (property, utility_type) are UPDATED rather than duplicated.
//   - Runs inside a transaction; any row-level failure rolls the whole
//     batch back.
//   - Returns { ok, matchedCount, insertedCount, updatedCount,
//                skippedCount, matchedPreview: [first 25 matches] }
//
// Intended to be called from the "Bulk Configure Utilities" tab in
// the Property Directory UI, but also useful as a one-shot script
// target for automated reconfigurations.

import { and, eq, inArray, ilike, sql } from 'drizzle-orm';
import { getDb, schema } from '../../lib/db/index.js';
import {
  withAdminHandler,
  getDefaultOrgId,
  parseBody,
} from '../../lib/adminHelpers.js';

// Valid enum values — keep in sync with schema.js.
const VALID_UTILITY_TYPES = [
  'electric', 'gas', 'water', 'sewer', 'trash', 'internet', 'cable',
];
const VALID_ACCOUNT_HOLDERS = ['tenant', 'owner_llc'];

function buildWhereClause(orgId, filter) {
  const clauses = [eq(schema.properties.organizationId, orgId)];

  if (filter.allProperties) {
    return and(...clauses);
  }

  if (filter.propertyIds && filter.propertyIds.length > 0) {
    clauses.push(inArray(schema.properties.id, filter.propertyIds));
  }

  if (filter.rmPropertyIds && filter.rmPropertyIds.length > 0) {
    clauses.push(inArray(schema.properties.rmPropertyId, filter.rmPropertyIds));
  }

  if (filter.city) {
    clauses.push(ilike(schema.properties.serviceCity, `%${filter.city}%`));
  }

  if (filter.state) {
    clauses.push(eq(schema.properties.serviceState, filter.state.toUpperCase()));
  }

  if (filter.zipPrefix) {
    clauses.push(ilike(schema.properties.serviceZip, `${filter.zipPrefix}%`));
  }

  if (filter.namePattern) {
    clauses.push(ilike(schema.properties.displayName, `%${filter.namePattern}%`));
  }

  return and(...clauses);
}

export default withAdminHandler(async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'POST only' });
  }

  const body = parseBody(req);
  const filter = body.filter || {};
  const utilityType = body.utilityType;
  const accountHolder = body.accountHolder;
  const providerId = body.providerId || null;
  const billbackTenant = !!body.billbackTenant;
  const notes = body.notes || null;
  const dryRun = !!body.dryRun;

  // Required-field validation.
  if (!utilityType || !VALID_UTILITY_TYPES.includes(utilityType)) {
    return res.status(400).json({
      ok: false,
      error: `utilityType is required and must be one of: ${VALID_UTILITY_TYPES.join(', ')}`,
    });
  }
  if (!accountHolder || !VALID_ACCOUNT_HOLDERS.includes(accountHolder)) {
    return res.status(400).json({
      ok: false,
      error: `accountHolder is required and must be one of: ${VALID_ACCOUNT_HOLDERS.join(', ')}`,
    });
  }

  // Filter must be non-empty to avoid "apply to everything by accident".
  const hasAnyFilter =
    filter.allProperties ||
    (Array.isArray(filter.propertyIds) && filter.propertyIds.length > 0) ||
    (Array.isArray(filter.rmPropertyIds) && filter.rmPropertyIds.length > 0) ||
    filter.city || filter.state || filter.zipPrefix || filter.namePattern;
  if (!hasAnyFilter) {
    return res.status(400).json({
      ok: false,
      error:
        'filter must include at least one of propertyIds, rmPropertyIds, ' +
        'city, state, zipPrefix, namePattern, or allProperties:true',
    });
  }

  const db = getDb();
  const orgId = await getDefaultOrgId();
  const whereClause = buildWhereClause(orgId, filter);

  // Resolve matching properties first so both dry-run and real runs
  // return the same preview list.
  const matched = await db
    .select({
      id: schema.properties.id,
      rmPropertyId: schema.properties.rmPropertyId,
      displayName: schema.properties.displayName,
      serviceCity: schema.properties.serviceCity,
      serviceState: schema.properties.serviceState,
      serviceZip: schema.properties.serviceZip,
    })
    .from(schema.properties)
    .where(whereClause);

  if (matched.length === 0) {
    return res.status(200).json({
      ok: true,
      matchedCount: 0,
      insertedCount: 0,
      updatedCount: 0,
      skippedCount: 0,
      matchedPreview: [],
      message: 'No properties matched the filter.',
    });
  }

  const preview = matched.slice(0, 25);

  if (dryRun) {
    return res.status(200).json({
      ok: true,
      dryRun: true,
      matchedCount: matched.length,
      matchedPreview: preview,
    });
  }

  let insertedCount = 0;
  let updatedCount = 0;

  try {
    await db.transaction(async (tx) => {
      for (const property of matched) {
        // Look up an existing property_utilities row at the property
        // level (unit_id IS NULL) for this utility_type. We don't want
        // to clobber any per-unit utility config the user has already
        // set up.
        const existing = await tx
          .select({ id: schema.propertyUtilities.id })
          .from(schema.propertyUtilities)
          .where(
            and(
              eq(schema.propertyUtilities.propertyId, property.id),
              eq(schema.propertyUtilities.utilityType, utilityType),
              sql`${schema.propertyUtilities.unitId} IS NULL`,
            ),
          )
          .limit(1);

        if (existing.length > 0) {
          await tx
            .update(schema.propertyUtilities)
            .set({
              accountHolder,
              providerId,
              billbackTenant,
              notes: notes || schema.propertyUtilities.notes, // only override if provided
              updatedAt: new Date(),
            })
            .where(eq(schema.propertyUtilities.id, existing[0].id));
          updatedCount += 1;
        } else {
          await tx.insert(schema.propertyUtilities).values({
            propertyId: property.id,
            utilityType,
            accountHolder,
            providerId,
            billbackTenant,
            notes,
          });
          insertedCount += 1;
        }
      }
    });
  } catch (err) {
    console.error('[property-utilities-bulk] transaction failed:', err);
    return res.status(500).json({
      ok: false,
      error: `Bulk apply failed, no changes were committed: ${err.message}`,
      matchedCount: matched.length,
    });
  }

  return res.status(200).json({
    ok: true,
    matchedCount: matched.length,
    insertedCount,
    updatedCount,
    skippedCount: 0,
    matchedPreview: preview,
    message: `Applied ${utilityType}=${accountHolder} to ${matched.length} properties.`,
  });
});
