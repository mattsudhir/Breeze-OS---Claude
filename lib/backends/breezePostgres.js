// Breeze production Postgres backend.
//
// This is the chat backend that speaks to Breeze's own database — the
// real portfolio data imported from Appfolio (255 properties, 632 units,
// utility mappings, owners). Unlike the RM sandbox, Breeze's DB does
// NOT currently track tenants, leases, balances, or work orders. Tools
// for those concepts return honest "not tracked in Breeze yet" errors
// so the LLM surfaces an accurate answer instead of hallucinating.
//
// As the Breeze schema grows (tenants, leases, meters, work orders)
// this backend will gain tools in lockstep. Until then: properties,
// units, utilities, providers, owners, and move-events are the
// available surface area.

import { and, eq, ilike } from 'drizzle-orm';
import { getDb, schema } from '../db/index.js';
import { getDefaultOrgId } from '../adminHelpers.js';

export const name = 'breeze';
export const displayName = 'Breeze Production';
export const description =
  "Breeze's own Postgres database. Real portfolio data — 255 properties, " +
  '632 units, owners, utility providers, and move events. Tenants, ' +
  'leases, balances, and work orders are not tracked here yet.';

export const systemPromptAddendum = [
  'Data source: Breeze production Postgres.',
  '',
  'AVAILABLE data:',
  '- properties (id, display_name, service_city, service_state, property_type, owner)',
  '- units (per-property, with source_unit_name and bedrooms/bathrooms/sqft)',
  '- utility providers (name, phone, website)',
  '- property_utilities (which provider services each property/unit, who holds ' +
    'the account — owner_llc / tenant / none — and billback mode)',
  '- owners (LLC legal name, DBA, mailing address)',
  '- move events (in-progress utility transfers)',
  '',
  'NOT yet tracked in Breeze:',
  '- tenants, leases, rent balances, security deposits',
  '- maintenance work orders',
  '',
  'When the user asks about tenants, balances, or work orders, explain ' +
  'honestly that Breeze production does not track that data yet and ' +
  'suggest they switch to the RM Demo backend if they want to poke at ' +
  'sample data for that concept.',
].join('\n');

export async function getTools() {
  return TOOLS;
}

const TOOLS = [
  {
    name: 'list_properties',
    description:
      'List Breeze portfolio properties. Returns id, display_name, ' +
      'service_city, service_state, property_type, and owner legal_name. ' +
      'Optionally filter by city or a free-text match on display_name.',
    input_schema: {
      type: 'object',
      properties: {
        city: {
          type: 'string',
          description: 'Optional city filter (case-insensitive). E.g. "Toledo", "Lima".',
        },
        search: {
          type: 'string',
          description: 'Free-text match against display_name (case-insensitive substring).',
        },
      },
      required: [],
    },
  },
  {
    name: 'get_property_details',
    description:
      'Full details on a single Breeze property: addresses, owner info, ' +
      'all units, and utility configuration (who holds each account, ' +
      'which provider, billback mode). Use after list_properties when ' +
      'the user wants to drill into one record.',
    input_schema: {
      type: 'object',
      properties: {
        property_id: {
          type: 'string',
          description: 'UUID from list_properties results.',
        },
        name_match: {
          type: 'string',
          description:
            'Alternative to property_id — provide a display_name substring ' +
            'and the tool will match the first property whose name contains it.',
        },
      },
      required: [],
    },
  },
  {
    name: 'list_units',
    description:
      'List units in the Breeze portfolio. Optionally filter by property_id ' +
      '(UUID). Returns unit name, bedrooms, bathrooms, sqft, and the parent ' +
      'property name.',
    input_schema: {
      type: 'object',
      properties: {
        property_id: {
          type: 'string',
          description: 'Optional property UUID to filter units by. Omit for all units.',
        },
      },
      required: [],
    },
  },
  {
    name: 'list_utility_providers',
    description:
      'List utility providers configured in Breeze. Returns name, phone, ' +
      'website, and a flag for whether a verified phone number is on file.',
    input_schema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'list_owners',
    description:
      'List property owner LLCs configured in Breeze. Returns legal name, ' +
      'DBA, mailing address, and the count of properties owned.',
    input_schema: { type: 'object', properties: {}, required: [] },
  },
];

// Tools the LLM may reasonably try because they exist in the other
// backends. Respond with an honest "not available" message instead of
// failing opaquely.
const UNAVAILABLE_TOOL_MESSAGES = {
  search_tenants:
    'Breeze production database does not track tenants yet. Switch the ' +
    'chat data source to "RM Demo" if you want to query tenant data.',
  get_tenant_details:
    'Breeze production database does not track tenants yet. Switch the ' +
    'chat data source to "RM Demo" if you want to query tenant data.',
  list_work_orders:
    'Breeze production database does not track maintenance work orders ' +
    'yet. Switch the chat data source to "RM Demo" for sample work ' +
    'order data.',
};

export async function executeTool(toolName, input) {
  try {
    const db = getDb();
    const orgId = await getDefaultOrgId();

    switch (toolName) {
      case 'list_properties': {
        const conds = [eq(schema.properties.organizationId, orgId)];
        if (input.city) {
          conds.push(ilike(schema.properties.serviceCity, `%${input.city}%`));
        }
        if (input.search) {
          conds.push(ilike(schema.properties.displayName, `%${input.search}%`));
        }

        const rows = await db
          .select({
            id: schema.properties.id,
            name: schema.properties.displayName,
            city: schema.properties.serviceCity,
            state: schema.properties.serviceState,
            type: schema.properties.propertyType,
            ownerName: schema.owners.legalName,
          })
          .from(schema.properties)
          .leftJoin(schema.owners, eq(schema.properties.ownerId, schema.owners.id))
          .where(and(...conds))
          .limit(100);

        return {
          count: rows.length,
          note: rows.length === 100 ? 'Results truncated at 100. Use city/search filters to narrow.' : undefined,
          properties: rows,
        };
      }

      case 'get_property_details': {
        let propertyId = input.property_id;

        if (!propertyId && input.name_match) {
          const matches = await db
            .select({ id: schema.properties.id })
            .from(schema.properties)
            .where(
              and(
                eq(schema.properties.organizationId, orgId),
                ilike(schema.properties.displayName, `%${input.name_match}%`),
              ),
            )
            .limit(1);
          propertyId = matches[0]?.id;
        }

        if (!propertyId) {
          return { error: 'Provide property_id (UUID) or name_match (substring).' };
        }

        const propRows = await db
          .select({
            id: schema.properties.id,
            name: schema.properties.displayName,
            type: schema.properties.propertyType,
            serviceAddress1: schema.properties.serviceAddressLine1,
            serviceAddress2: schema.properties.serviceAddressLine2,
            serviceCity: schema.properties.serviceCity,
            serviceState: schema.properties.serviceState,
            serviceZip: schema.properties.serviceZip,
            sourcePropertyId: schema.properties.sourcePropertyId,
            sourcePms: schema.properties.sourcePms,
            notes: schema.properties.notes,
            ownerName: schema.owners.legalName,
            ownerDba: schema.owners.dba,
          })
          .from(schema.properties)
          .leftJoin(schema.owners, eq(schema.properties.ownerId, schema.owners.id))
          .where(eq(schema.properties.id, propertyId))
          .limit(1);

        if (propRows.length === 0) {
          return { error: `No property found with id ${propertyId}` };
        }
        const property = propRows[0];

        const unitRows = await db
          .select({
            id: schema.units.id,
            name: schema.units.sourceUnitName,
            bedrooms: schema.units.bedrooms,
            bathrooms: schema.units.bathrooms,
            sqft: schema.units.sqft,
          })
          .from(schema.units)
          .where(eq(schema.units.propertyId, propertyId));

        const utilRows = await db
          .select({
            utilityType: schema.propertyUtilities.utilityType,
            accountHolder: schema.propertyUtilities.accountHolder,
            billbackMode: schema.propertyUtilities.billbackMode,
            unitId: schema.propertyUtilities.unitId,
            providerName: schema.utilityProviders.name,
            providerPhone: schema.utilityProviders.phoneNumber,
          })
          .from(schema.propertyUtilities)
          .leftJoin(
            schema.utilityProviders,
            eq(schema.propertyUtilities.providerId, schema.utilityProviders.id),
          )
          .where(eq(schema.propertyUtilities.propertyId, propertyId));

        return {
          property,
          unit_count: unitRows.length,
          units: unitRows,
          utilities: utilRows.map((u) => ({
            utility_type: u.utilityType,
            account_holder: u.accountHolder,
            billback_mode: u.billbackMode,
            scope: u.unitId ? 'per_unit' : 'property_level',
            provider: u.providerName || null,
            provider_phone_on_file: !!u.providerPhone,
          })),
        };
      }

      case 'list_units': {
        const conds = [eq(schema.units.organizationId, orgId)];
        if (input.property_id) {
          conds.push(eq(schema.units.propertyId, input.property_id));
        }
        const rows = await db
          .select({
            id: schema.units.id,
            name: schema.units.sourceUnitName,
            bedrooms: schema.units.bedrooms,
            bathrooms: schema.units.bathrooms,
            sqft: schema.units.sqft,
            property_id: schema.units.propertyId,
            property_name: schema.properties.displayName,
          })
          .from(schema.units)
          .leftJoin(schema.properties, eq(schema.units.propertyId, schema.properties.id))
          .where(and(...conds))
          .limit(200);

        return {
          count: rows.length,
          note: rows.length === 200 ? 'Results truncated at 200. Filter by property_id to narrow.' : undefined,
          units: rows,
        };
      }

      case 'list_utility_providers': {
        const rows = await db
          .select({
            id: schema.utilityProviders.id,
            name: schema.utilityProviders.name,
            phone: schema.utilityProviders.phoneNumber,
            website: schema.utilityProviders.website,
          })
          .from(schema.utilityProviders)
          .where(eq(schema.utilityProviders.organizationId, orgId));

        return {
          count: rows.length,
          providers: rows.map((r) => ({
            ...r,
            phone_on_file: !!r.phone,
          })),
        };
      }

      case 'list_owners': {
        const rows = await db
          .select({
            id: schema.owners.id,
            legal_name: schema.owners.legalName,
            dba: schema.owners.dba,
            mailing_city: schema.owners.mailingCity,
            mailing_state: schema.owners.mailingState,
          })
          .from(schema.owners)
          .where(eq(schema.owners.organizationId, orgId));

        // Count properties per owner in a single roundtrip
        const propCounts = await db
          .select({
            ownerId: schema.properties.ownerId,
            id: schema.properties.id,
          })
          .from(schema.properties)
          .where(eq(schema.properties.organizationId, orgId));

        const countsByOwner = {};
        for (const p of propCounts) {
          countsByOwner[p.ownerId] = (countsByOwner[p.ownerId] || 0) + 1;
        }

        return {
          count: rows.length,
          owners: rows.map((o) => ({
            ...o,
            property_count: countsByOwner[o.id] || 0,
          })),
        };
      }

      default: {
        const unavailable = UNAVAILABLE_TOOL_MESSAGES[toolName];
        if (unavailable) return { error: unavailable };
        return { error: `breeze backend: unknown tool "${toolName}"` };
      }
    }
  } catch (err) {
    return { error: err.message || String(err) };
  }
}
