// Property directory — owners (LLCs), properties, units, and the
// per-property utility configuration that drives move-event workflows.
//
// All tables here FK back to organizations via organization_id.

import {
  pgTable,
  pgEnum,
  uuid,
  text,
  timestamp,
  integer,
  boolean,
  jsonb,
  index,
} from 'drizzle-orm/pg-core';

import { organizations, entities } from './core.js';

// ── Enums ────────────────────────────────────────────────────────

export const propertyTypeEnum = pgEnum('property_type', [
  'sfr',
  'multi_family',
  'commercial',
  'mixed',
]);

export const utilityTypeEnum = pgEnum('utility_type', [
  'electric',
  'gas',
  'water',
  'sewer',
  'trash',
  'internet',
  'cable',
]);

// Who's supposed to hold the account for this utility at this property
// in the steady state (tenant-occupied).
//
//   owner_llc — LLC keeps the account; Breeze-managed
//   tenant    — tenant is expected to have it in their own name
//   none      — this utility isn't supplied at the property at all
//                (no gas service, no municipal sewer, etc.).
//                Stored explicitly so "no gas here" is distinguishable
//                from "haven't configured gas yet."
export const accountHolderEnum = pgEnum('account_holder', [
  'owner_llc',
  'tenant',
  'none',
]);

// How a billed-back utility is distributed to tenants.
//
//   none         — no billback (either tenant pays directly, or LLC absorbs)
//   full         — the full bill is charged to one tenant's ledger
//   split_meter  — one shared meter covers multiple units; bill is split
//                  evenly across units (typical of duplex water when the
//                  utility only provides a single meter for both sides)
//
// Future values the enum may grow into:
//   split_by_sqft       — proportional to each unit's square footage
//   split_by_occupancy  — proportional to number of occupants
//   custom              — manual per-unit amounts, entered by staff
//
// billback_tenant (the legacy boolean) stays in sync as a shadow for
// backward-compat with existing code paths. New code should prefer
// reading billback_mode.
export const billbackModeEnum = pgEnum('billback_mode', [
  'none',
  'full',
  'split_meter',
]);

// ── Tables ───────────────────────────────────────────────────────

// The LLC that owns one or more properties. Utility accounts for
// LLC-held utilities (water, trash, sometimes electric/gas) live under
// this entity's legal name.
export const owners = pgTable(
  'owners',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    legalName: text('legal_name').notNull(), // "Breeze Holdings Toledo Ohio LLC"
    dba: text('dba'), // doing-business-as, optional
    // EIN stored via pgcrypto's pgp_sym_encrypt. We write/read this via
    // the db helpers in lib/db/encryption.js so plaintext never touches
    // application code. See the column initialiser for details.
    einEncrypted: text('ein_encrypted'),
    mailingAddressLine1: text('mailing_address_line1'),
    mailingAddressLine2: text('mailing_address_line2'),
    mailingCity: text('mailing_city'),
    mailingState: text('mailing_state'), // 2-char postal code
    mailingZip: text('mailing_zip'),
    billingEmail: text('billing_email'),
    // Authorised caller list: people the utility has on file as allowed
    // to speak for the LLC. The AI references these by name, never
    // impersonates them.
    //   [{ name: string, title?: string, phone?: string }, ...]
    authorizedCallers: jsonb('authorized_callers'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    orgIdx: index('owners_org_idx').on(t.organizationId),
  }),
);

export const properties = pgTable(
  'properties',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    ownerId: uuid('owner_id')
      .notNull()
      .references(() => owners.id, { onDelete: 'restrict' }),
    // Owning legal entity (LLC, partnership, etc.). Nullable —
    // backfilled via the entities admin UI after migration 0019.
    // Posting flows resolve this lazily when building journal lines
    // so a property's books still flow to the right entity once the
    // assignment lands.
    entityId: uuid('entity_id').references(() => entities.id, { onDelete: 'set null' }),
    // Stable external property ID from the source PMS (originally the
    // Appfolio property ID for Breeze's imported data). The column was
    // renamed from rm_property_id in migration 0003.
    sourcePropertyId: integer('source_property_id'),
    // Which PMS the source_property_id came from. Defaults to
    // 'appfolio' for all existing data; future imports from other
    // systems set this explicitly.
    sourcePms: text('source_pms').notNull().default('appfolio'),
    displayName: text('display_name').notNull(),
    propertyType: propertyTypeEnum('property_type').notNull().default('sfr'),
    // Service address — where the meters are.
    serviceAddressLine1: text('service_address_line1').notNull(),
    serviceAddressLine2: text('service_address_line2'),
    serviceCity: text('service_city').notNull(),
    serviceState: text('service_state').notNull(),
    serviceZip: text('service_zip').notNull(),
    // Billing address — where utility bills are mailed / emailed to.
    // Often differs from the service address for LLC-held utilities
    // (bills go to the LLC's mailing PO box, not the rental unit).
    // Leave blank to fall back to the owner's mailing address.
    billingAddressLine1: text('billing_address_line1'),
    billingAddressLine2: text('billing_address_line2'),
    billingCity: text('billing_city'),
    billingState: text('billing_state'),
    billingZip: text('billing_zip'),
    notes: text('notes'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    orgIdx: index('properties_org_idx').on(t.organizationId),
    ownerIdx: index('properties_owner_idx').on(t.ownerId),
    entityIdx: index('properties_entity_idx').on(t.entityId),
    sourceIdx: index('properties_source_idx').on(t.sourcePropertyId),
  }),
);

// Individual rentable units within a property. For SFRs this is usually
// a single row whose name mirrors the street address; for multi-family
// buildings it's one row per unit. Move-events, utility accounts, and
// tenants all ultimately attach to units rather than properties when
// the data granularity supports it.
export const units = pgTable(
  'units',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    propertyId: uuid('property_id')
      .notNull()
      .references(() => properties.id, { onDelete: 'cascade' }),
    // Human label — "Unit 101", "Apt 3", "Upper", "1111 Orchard St" for
    // SFRs. Not globally unique; scoped by property_id. Renamed from
    // rm_unit_name in migration 0003.
    sourceUnitName: text('source_unit_name'),
    // Stable external unit ID from the source PMS (Appfolio Unit ID for
    // Breeze's imported data). Nullable until backfilled; populated via
    // /api/admin/backfill-unit-ids for existing rows, set at insert
    // time for new imports.
    sourceUnitId: text('source_unit_id'),
    // Which PMS the source IDs came from. See notes on properties.sourcePms.
    sourcePms: text('source_pms').notNull().default('appfolio'),
    sqft: integer('sqft'),
    bedrooms: integer('bedrooms'),
    // Bathrooms can be decimal (1.5, 2.5) — stored as text to preserve
    // whatever fractional format the source system used without having
    // to pick a numeric precision up front.
    bathrooms: text('bathrooms'),
    notes: text('notes'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    propertyIdx: index('units_property_idx').on(t.propertyId),
    orgIdx: index('units_org_idx').on(t.organizationId),
  }),
);

// Per-property (optionally per-unit) utility configuration — the source
// of truth for "who's supposed to hold this utility" and "which provider
// services it".
//
// unit_id is nullable: NULL means the utility row applies to the whole
// property (shared meter, LLC-level account). A set unit_id scopes the
// row to that specific unit (individually-metered apartment building).
export const propertyUtilities = pgTable(
  'property_utilities',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    propertyId: uuid('property_id')
      .notNull()
      .references(() => properties.id, { onDelete: 'cascade' }),
    unitId: uuid('unit_id').references(() => units.id, { onDelete: 'cascade' }),
    utilityType: utilityTypeEnum('utility_type').notNull(),
    providerId: uuid('provider_id').references(() => utilityProviders.id, {
      onDelete: 'set null',
    }),
    accountHolder: accountHolderEnum('account_holder').notNull(),
    // Legacy boolean — kept in sync with billback_mode for backward
    // compatibility. True whenever billback_mode is 'full' or
    // 'split_meter'. New code should read billback_mode instead;
    // this column will be dropped once all callers are migrated.
    billbackTenant: boolean('billback_tenant').notNull().default(false),
    // Richer billback classification. See billbackModeEnum docs above.
    // The Grid Import parser accepts 'none' / 'full' / 'split_meter'
    // as well as the friendlier aliases 'n' / 'y' / 'yes-meter_split'.
    billbackMode: billbackModeEnum('billback_mode').notNull().default('none'),
    // The current account number as known to us. Updated by workflows
    // when transfers succeed; editable manually for initial seeding.
    currentAccountNumber: text('current_account_number'),
    notes: text('notes'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    propertyIdx: index('property_utilities_property_idx').on(t.propertyId),
    unitIdx: index('property_utilities_unit_idx').on(t.unitId),
    providerIdx: index('property_utilities_provider_idx').on(t.providerId),
  }),
);

// Per-utility-company playbook. The AI calls these directly; the
// call_script_notes + required_fields shape the per-call system prompt.
export const utilityProviders = pgTable(
  'utility_providers',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    name: text('name').notNull(), // "Columbia Gas of Ohio"
    // Nullable — providers can be seeded without a verified phone
    // number. The move-event worker escalates to needs_human when a
    // call is attempted against a provider without a phone on file.
    phoneNumber: text('phone_number'), // E.164 when set
    website: text('website'),
    // Business hours as { mon: [openHour, closeHour], ... } in the
    // provider's local timezone. null entries mean "closed that day".
    //   { timezone, mon: [8, 17], tue: [8, 17], ..., sat: null, sun: null }
    businessHours: jsonb('business_hours'),
    expectedHoldMinutes: integer('expected_hold_minutes').default(5),
    callScriptNotes: text('call_script_notes'), // free text prompt hints
    // Data the agent must provide for this provider, e.g.
    //   ["ein_last4", "prior_account_number", "service_address"]
    requiredFields: jsonb('required_fields'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    orgIdx: index('utility_providers_org_idx').on(t.organizationId),
  }),
);
