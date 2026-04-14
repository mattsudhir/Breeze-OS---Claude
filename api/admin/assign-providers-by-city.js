// Vercel Serverless Function — assign utility providers to existing
// property_utilities rows based on each property's service_city.
//
// POST /api/admin/assign-providers-by-city
// Body (all optional):
//   {
//     overwrite: false,     // if true, overwrite existing provider_id;
//                           // default false = only fill NULLs
//     cityFilter: 'Lima'    // if set, only touch properties in this city;
//                           // case-insensitive contains match
//   }
//
// Uses the CITY_PROVIDER_MAP below as the source of truth for which
// provider serves which utility in which city. Properties whose city
// isn't in the map are skipped and reported as "unmapped" so you can
// see what needs either a map entry or manual handling.
//
// Touches only property-level rows (unit_id IS NULL). Unit-level
// overrides are left alone.
//
// Idempotent: re-running with overwrite=false is safe; it only fills
// rows that don't already have a provider_id set.

import { and, eq, ilike, isNull, inArray } from 'drizzle-orm';
import { getDb, schema } from '../../lib/db/index.js';
import {
  withAdminHandler,
  getDefaultOrgId,
  parseBody,
} from '../../lib/adminHelpers.js';

// Source-of-truth map: city name (case-insensitive) → utility → provider name.
// Provider names must match what's in utility_providers exactly (same
// strings used in seed.js). Add new cities here as Breeze expands.
//
// 'none' utilities (sewer, trash, internet, cable) are not auto-assigned;
// they're handled via manual config or a future dedicated tool.
const CITY_PROVIDER_MAP = {
  toledo: {
    electric: 'Toledo Edison',
    gas:      'Columbia Gas of Ohio',
    water:    'Toledo Public Utilities',
  },
  lima: {
    electric: 'AEP Ohio',
    gas:      'Enbridge',
    water:    'City of Lima',
  },
  youngstown: {
    electric: 'Ohio Edison',
    gas:      'Enbridge',
    water:    'Youngstown Water Department',
  },
};

const UTILITY_TYPES = ['electric', 'gas', 'water'];

export default withAdminHandler(async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'POST only' });
  }

  const body = parseBody(req);
  const overwrite = !!body.overwrite;
  const cityFilter = (body.cityFilter || '').trim();

  const db = getDb();
  const orgId = await getDefaultOrgId();

  // Resolve the provider-name map to provider IDs. Any provider name
  // missing from the DB gets flagged and we continue with the rest.
  const providerNames = new Set();
  for (const cityMap of Object.values(CITY_PROVIDER_MAP)) {
    for (const name of Object.values(cityMap)) {
      if (name) providerNames.add(name);
    }
  }
  const providerNameList = [...providerNames];

  const providerRows = await db
    .select({ id: schema.utilityProviders.id, name: schema.utilityProviders.name })
    .from(schema.utilityProviders)
    .where(
      and(
        eq(schema.utilityProviders.organizationId, orgId),
        inArray(schema.utilityProviders.name, providerNameList),
      ),
    );
  const providerIdByName = new Map(providerRows.map((p) => [p.name, p.id]));

  // Missing-provider check — if a provider referenced in CITY_PROVIDER_MAP
  // isn't in the DB, tell the caller to run /api/admin/seed first.
  const missingProviders = providerNameList.filter((n) => !providerIdByName.has(n));
  if (missingProviders.length > 0) {
    return res.status(400).json({
      ok: false,
      error: `Missing providers in utility_providers: ${missingProviders.join(', ')}. Run /api/admin/seed first.`,
      missingProviders,
    });
  }

  // Pull all properties (optionally filtered by city). Small enough to
  // load in one query; Breeze's portfolio is ~250 properties total.
  const propFilter = [eq(schema.properties.organizationId, orgId)];
  if (cityFilter) {
    propFilter.push(ilike(schema.properties.serviceCity, `%${cityFilter}%`));
  }
  const allProps = await db
    .select({
      id: schema.properties.id,
      sourcePropertyId: schema.properties.sourcePropertyId,
      displayName: schema.properties.displayName,
      serviceCity: schema.properties.serviceCity,
      serviceState: schema.properties.serviceState,
    })
    .from(schema.properties)
    .where(and(...propFilter));

  // Group by lowercased city so we can count matched / unmapped.
  const mapped = [];
  const unmapped = [];
  for (const p of allProps) {
    const cityKey = (p.serviceCity || '').trim().toLowerCase();
    if (CITY_PROVIDER_MAP[cityKey]) {
      mapped.push({ ...p, cityKey });
    } else {
      unmapped.push({
        id: p.id,
        sourcePropertyId: p.sourcePropertyId,
        displayName: p.displayName,
        serviceCity: p.serviceCity,
        serviceState: p.serviceState,
      });
    }
  }

  // For each mapped property, update property_utilities rows where
  // the utility_type matches the city map AND (overwrite OR
  // provider_id IS NULL).
  let updateCount = 0;
  const perCity = {};

  try {
    await db.transaction(async (tx) => {
      for (const p of mapped) {
        const cityMap = CITY_PROVIDER_MAP[p.cityKey];
        for (const t of UTILITY_TYPES) {
          const providerName = cityMap[t];
          if (!providerName) continue;
          const providerId = providerIdByName.get(providerName);
          if (!providerId) continue;

          const whereClauses = [
            eq(schema.propertyUtilities.propertyId, p.id),
            eq(schema.propertyUtilities.utilityType, t),
            isNull(schema.propertyUtilities.unitId),
          ];
          if (!overwrite) {
            whereClauses.push(isNull(schema.propertyUtilities.providerId));
          }

          const result = await tx
            .update(schema.propertyUtilities)
            .set({
              providerId,
              updatedAt: new Date(),
            })
            .where(and(...whereClauses))
            .returning({ id: schema.propertyUtilities.id });

          const hits = result.length;
          if (hits > 0) {
            updateCount += hits;
            perCity[p.cityKey] = (perCity[p.cityKey] || 0) + hits;
          }
        }
      }
    });
  } catch (err) {
    console.error('[assign-providers-by-city] transaction failed:', err);
    return res.status(500).json({
      ok: false,
      error: `Assignment failed, no changes were committed: ${err.message}`,
    });
  }

  return res.status(200).json({
    ok: true,
    overwrite,
    cityFilter: cityFilter || null,
    propertiesScanned: allProps.length,
    propertiesMapped: mapped.length,
    propertiesUnmapped: unmapped.length,
    updateCount,
    perCity,
    unmapped: unmapped.slice(0, 50),
    cityMapUsed: Object.keys(CITY_PROVIDER_MAP),
    message: `Assigned providers to ${updateCount} property_utilities rows across ${mapped.length} properties.`,
  });
});
