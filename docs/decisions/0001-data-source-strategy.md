# 0001. Data-source strategy

**Status:** Accepted
**Date:** 2026-05-17
**Deciders:** mattsudhir + Claude (this session)

## Context

Before this session, every page that showed property / tenant /
lease / work-order data had a "data source" toggle in the TopBar
that switched the page between two backends:

- **AppFolio passthrough** — every request from the browser
  fanned out to AppFolio's REST API in real time. Slow (1–3s
  per page), 401-prone, broke during AppFolio outages, capped
  by AppFolio's rate limit.
- **Rent Manager passthrough** — same shape, against a
  different PMS. Legacy from our pre-AppFolio prototype.

Neither read from our own Postgres. The user kept the toggle
because there was no third option that always worked.

In this session we:
1. Cleaned and re-imported all 287 properties / 642 units / 524
   leases / 1046 tenants / 9836 maintenance tickets directly from
   AppFolio into our Postgres via the `/api/admin/run-reimport`
   orchestrator.
2. Migrated every list / detail view (Properties, Tenants,
   Leasing, Move Events, Maintenance, Dashboard, Reports) to
   read from our DB through purpose-built admin endpoints
   (`list-properties-summary`, `list-tenants`, `get-tenant`,
   `list-maintenance-tickets`, etc).
3. Dropped the data-source toggle from every page that we
   migrated. The toggle context (`useDataSource`) is still
   imported by some components but no longer drives data fetching
   for the migrated surfaces.
4. Recorded — separately — that the *write* side (e.g.
   `updateTenant`) still flows through AppFolio passthrough
   pending a design decision (see `docs/tenants-write-architecture.md`).

The question this ADR answers: **when, if ever, do we re-introduce
a data-source toggle?**

## Decision

**Don't re-introduce a global toggle.** Instead:

1. **Our DB is the single read source for every UI surface.** Always.
   No per-page or per-user switch.
2. **AppFolio remains the write target for AppFolio-canonical
   fields** (tenant identity, lease terms, charges posted, etc).
   Writes go AppFolio-first; our DB is mirrored on success. See
   `docs/tenants-write-architecture.md`.
3. **Staleness is surfaced, not hidden.** Where freshness matters
   (e.g. account balance, lease status mid-month), show the
   "as-of" timestamp inline so the user can decide whether to
   trigger a refresh. Don't fork the UX.
4. **Surgical "refresh from AppFolio" actions** are allowed
   per-record when staleness is suspected — a single button on a
   specific tenant or property that re-fetches that one entity
   from AppFolio. This is a power-user escape hatch, not a
   default.

The two contexts where we'd revisit:

- **Multi-PMS support** — if Breeze OS adds a customer running on
  RentManager / Buildium / Yardi, the toggle resurfaces as a
  per-organization config (not a per-user UI control). The org
  picks its primary PMS at onboarding; the data layer adapts.
- **Standalone Breeze OS** — when Breeze OS sells without an
  AppFolio dependency, AppFolio falls away entirely and our DB
  becomes the sole system of record. The toggle becomes
  irrelevant.

## Consequences

**Good:**
- Page loads are fast (single Postgres query, indexed, joined
  server-side).
- Pages work offline from AppFolio's perspective — AppFolio
  outages don't take down read surfaces.
- We can augment AppFolio data with Breeze-native fields
  (maintenance comments, audit log, AI workflow state) without
  the toggle complicating reads.
- Onboarding a new property manager doesn't require choosing a
  data source — there's one source.

**Costs:**
- Sync drift is a real risk. If AppFolio updates a lease and our
  cron doesn't sync within minutes, our UI shows stale data.
  Mitigations:
  - Reimport orchestrator is idempotent; runnable on demand.
  - Per-record "refresh from AppFolio" actions for power users.
  - "Last synced at" badges on staleness-sensitive surfaces.
  - Eventual: AppFolio webhooks driving real-time delta sync
    (already wired at `api/webhooks/appfolio.js`).
- Writes require us to maintain AppFolio API client coverage
  for every editable field. Stale or missing PATCH support at
  AppFolio's end becomes a feature gap. Mitigated by the
  write-side ADR (TBD; see `tenants-write-architecture.md`).
- Onboarding a non-AppFolio customer requires a non-trivial
  data-import effort for them; we don't have a generic CSV path
  anymore (we tore the old one down — see git history for the
  CSV bulk-import deprecation).

## Alternatives considered

### A. Keep the global toggle
Status quo before this session. The toggle was a workaround for
not having a complete local mirror. With the mirror in place,
the toggle's value drops to ~zero and its cost (two code paths
for every read, confusing UX) stays the same.

### B. Toggle per page (URL param or page setting)
Localizes the failure mode but doubles the surface area. Every
page maintainer has to keep two paths working. Rejected for the
same reason as (A).

### C. AppFolio is the read source, our DB is just for things
AppFolio can't model (maintenance comments, audit log, AI state)
Reverses the model. Requires every page to fan out to AppFolio
(slow) and stitch in our DB fields. Loses the speed win and adds
join complexity. Rejected unless AppFolio's API gets dramatically
faster or we hit a freshness wall we can't paper over.

### D. Cache-then-revalidate (SWR style) over AppFolio
Show cached AppFolio response immediately, revalidate in
background. Hides staleness. Doesn't solve the offline-from-
AppFolio case. Doesn't help when we want to JOIN our augmentations.
Rejected; the cache-then-revalidate behavior is essentially what
our DB-first approach already does, just at a layer where joins
are possible.

## Revisit when

- A customer onboards on a non-AppFolio PMS → ADR to be authored
  for multi-PMS data shape.
- We notice >5% of pages show stale data on a regular basis →
  consider real-time webhook-driven sync.
- AppFolio publishes a new API tier with sub-100ms response → the
  speed argument weakens and (C) becomes viable.
