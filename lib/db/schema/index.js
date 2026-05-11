// Breeze OS database schema (Drizzle / Postgres) — barrel re-exports.
//
// Every user-facing table carries an organization_id so we can enforce
// tenancy isolation at the query layer from day one. Adding it later is
// painful — every row already has it now.
//
// Multi-tenancy is optional at the app level for now (only one org will
// exist), but the constraint exists so no code can forget about it.
//
// Modules:
//   core.js           — organizations, users
//   directory.js      — owners, properties, units, propertyUtilities,
//                       utilityProviders + related enums
//   move-events.js    — moveEvents, moveEventUtilities + related enums
//   infrastructure.js — calls, tasks, auditEvents + related enums
//   accounting.js     — GL, AR, AP, banking, payments (added in stages
//                       1+ per docs/accounting/architecture.md)
//
// External consumers should import named tables from this index, OR
// import the whole module via `import * as schema from '.../schema'`
// (as lib/db/index.js does for Drizzle's schema option).

export * from './core.js';
export * from './directory.js';
export * from './move-events.js';
export * from './infrastructure.js';
