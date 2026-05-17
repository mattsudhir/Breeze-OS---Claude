# 0002. AppFolio vs Breeze data ownership

**Status:** Accepted (lives + grows over time as we learn more)
**Date:** 2026-05-17
**Deciders:** mattsudhir + Claude (this session)

## Context

ADR 0001 establishes that our Postgres mirrors AppFolio and the UI
reads from us. That ADR is silent on a more practical question:
**which fields does AppFolio actually own (and we mirror), versus
which fields exist only in Breeze and have no AppFolio analogue?**

When we get that mapping wrong, two failure modes show up:

- **Lost edits.** Breeze user edits a field; we save it locally; the
  next AppFolio sync overwrites it because AppFolio is canonical.
- **Stale truth.** AppFolio user (or AppFolio itself, via its own
  automations) changes a field; Breeze keeps showing the old value
  until the next sync — or worse, the Breeze user edits the stale
  value and the change pushes back to AppFolio overwriting the
  real one.

This ADR is the **registry** that documents who owns what. It
should be updated whenever we add a new field or integration —
treat it like a CHANGELOG for the data model's authority boundaries.

## Decision

Every field belongs to one of three buckets:

### Bucket A — AppFolio canonical
AppFolio is the source of truth. We mirror via the sync
endpoints. Writes go AppFolio-first, mirror to our DB on success.
Our sync jobs treat AppFolio's value as authoritative and
overwrite our mirror when they differ.

### Bucket B — Breeze canonical
The field exists only in Breeze; AppFolio has no equivalent.
Writes go to our DB directly. No sync overwrites possible.

### Bucket C — Joint (caveat)
The field has a representation in both systems but they capture
different facets. We pick which one the UI shows and document
why. These are the most dangerous to mishandle.

## The registry

### Bucket A — AppFolio canonical (we mirror, AppFolio wins on conflict)

| Table              | Field                  | AppFolio source                | Notes |
|--------------------|------------------------|--------------------------------|-------|
| `properties`       | `source_property_id`   | `Property.Id`                  | UUID; never changes once assigned |
| `properties`       | `display_name`         | `Property.Name`                | |
| `properties`       | `service_address_*`    | `Property.Address1/City/State/Zip` | |
| `units`            | `source_unit_id`       | `Unit.Id`                      | |
| `units`            | `source_unit_name`     | `Unit.Name`                    | |
| `units`            | `bedrooms` / `bathrooms` / `sqft` | `Unit.Bedrooms/Bathrooms/SquareFeet` | |
| `units`            | (NonRevenue filter)    | `Unit.NonRevenue`              | We skip rows where this is true; common-area / model units don't appear in our DB |
| `leases`           | `source_lease_id`      | `Tenant.OccupancyId`           | Each occupancy = one lease in our model |
| `leases`           | `start_date` / `end_date` | `Tenant.LeaseStartDate/LeaseEndDate` | |
| `leases`           | `rent_cents`           | `Tenant.CurrentRent`           | Refreshed on every sync |
| `leases`           | `status`               | derived from `Tenant.Status` + `CurrentOccupancyId` match | See `sync-appfolio-leases-all.js` for the derivation |
| `tenants`          | `source_tenant_id`     | `Tenant.Id`                    | |
| `tenants`          | `first_name` / `last_name` / `display_name` | `Tenant.FirstName/LastName` | |
| `tenants`          | `email` / `phone` / `mobile_phone` | `Tenant.Email/Phone/MobilePhone` | |
| `lease_tenants`    | role (primary/cosigner/etc) | `Tenant.LeaseHolder` | |
| `maintenance_tickets` | `source_ticket_id`  | `WorkOrder.Id`                 | |
| `maintenance_tickets` | `priority` / `status` | mapped from AppFolio's enums  | See `sync-appfolio-tickets.js` |
| `maintenance_tickets` | `title` / `description` | derived from `JobDescription` / `WorkOrderIssue` / `Description` | Title is the first sentence; description is the full narrative (see commit `a495b96`) |
| `maintenance_tickets` | `reported_at`        | `WorkOrder.CreatedAt`          | |
| `maintenance_tickets` | `scheduled_at` / `completed_at` | `WorkOrder.ScheduledStart` / `WorkCompletedOn` | |

### Bucket B — Breeze canonical (only exists here)

These fields have no AppFolio analogue. Edits are safe; syncs
don't touch them.

| Table                  | Field                     | Why Breeze-only |
|------------------------|---------------------------|----------------|
| `maintenance_ticket_comments` | (whole table)      | AppFolio doesn't have an internal-vs-tenant-facing comment timeline |
| `maintenance_tickets`  | `vendor_id`               | Our vendor table is separate from AppFolio's; we may assign before AppFolio has a record |
| `maintenance_tickets`  | `assigned_to`             | Internal staff assignment |
| `maintenance_tickets`  | `internal_notes`          | Staff-only field |
| `entities` (whole table) | LLC structure            | AppFolio doesn't model entity-level reporting |
| `intercompany_journal_entries` (whole) | cross-LLC bookkeeping | Not in AppFolio |
| `move_events`, `move_event_utilities` | move-in/out + utility switch workflows | Drives AI calls to providers |
| `calls` (whole table)  | AI call outcomes          | We make calls, we own the transcripts |
| `match_rules` / `match_candidates` | bank reconciliation rules | Plaid-side; AppFolio has no equivalent |
| `journal_entries` / `journal_lines` | our GL | Parallels AppFolio's GL but is independent |
| `bank_accounts` / `bank_transactions` | Plaid + manual import | We connect directly via Plaid |
| `bills` (AP) — write side | bill approval state | Inherits some metadata from Bill.com but our approval workflow is local |
| `messaging_threads` / `messages` | cross-channel (SMS / email / voice) | Owned by our messaging layer |
| `notifications` / `push_subscriptions` | in-app notifications | Owned by us |
| `human_tasks`          | task queue (allocate_payment, charge_fee_review, etc.) | Our async work coordination |
| `agent_actions` / `ai_workflows` | AI agent state machines | Owned by us |
| `integration_health`   | uptime monitoring         | Cross-cuts every backend |
| `admin_audit_log` / `admin_error_log` | ops trails       | Owned by us |
| `onboarding_state`     | customer onboarding wizard progress | Owned by us |
| `tenants`              | `notes`                   | Local-only; safe to edit, never pushed to AppFolio |
| `properties`           | `notes`                   | Same |
| `properties`           | `entity_id`               | Our LLC mapping |
| `property_utilities`   | utility-provider config   | Drives the move-event automation; AppFolio doesn't model per-property utility account numbers |

### Bucket C — Joint (different facet in each system)

The dangerous ones. Document the caveat for each.

| Field | AppFolio facet | Breeze facet | Resolution |
|-------|---------------|--------------|------------|
| Tenant payment history | AppFolio's `Receivable` records | Our `journal_lines` keyed to a receipt | We show AppFolio's view in the receipts tab; our GL records the bookkeeping side. They should reconcile but don't have to be byte-equal. |
| Lease balance | AppFolio computes net rent owed | Our `posted_charges` + `bank_transactions` reconciliation | Same — separate views of the same money. AppFolio's view is the legal one (what we'd send a tenant a notice based on); ours is the accounting truth. |
| Work order status | AppFolio's status enum (more granular for inspections, etc.) | Our `maintenance_ticket_status` enum (new/triage/assigned/in_progress/awaiting_parts/awaiting_tenant/completed/cancelled) | We map on ingest; round-trip is lossy. If a power user changes status in AppFolio to a value our enum can't represent, the next sync coerces it. Documented at `sync-appfolio-tickets.js#mapStatus`. |
| Vendor identity | AppFolio's vendor record | Our `vendors` table | We can have vendors that don't exist in AppFolio (local automations); the cross-reference column is sparse on purpose. |

## Consequences

**Good:**
- Anybody adding a new field or integration knows where to write
  the entry and how the field will be treated by sync.
- Edits to Bucket B fields are safe; the Tenant write-side ADR
  doesn't need to worry about overwriting `notes` because no sync
  touches it.
- Failure modes are predictable. If you see a Breeze edit reverting
  after a sync, the field is Bucket A and we forgot to add the
  write-through path. Open this doc; fix it.

**Costs:**
- This registry has to be maintained. If we add a new column and
  don't update the registry, we re-introduce the lost-edits class
  of bug.
- "Bucket C" entries grow over time as we discover new joint
  facets. There's no clean way to enforce the documentation —
  it's a discipline.

**Mitigation:**
- PR template should ask "does this PR add or change a field in
  `lib/db/schema/`? If yes, update `docs/decisions/0002-...`".
  (Optional follow-up.)
- The audit-log infrastructure (admin_audit_log) gives us a way
  to detect lost edits after the fact — if `before`/`after`
  snapshots show a value flipping back and forth, that's a
  Bucket-A field someone wrote without going through the
  AppFolio-first path.

## Alternatives considered

### A. Make every field Breeze-canonical
Treat AppFolio as just another sync target. Means we'd have to
write a full PMS internally — leases, charges, statements, late
fees, eviction filings, all of it. Multi-year scope. Rejected for
v1.

### B. Make every field AppFolio-canonical
Hide our augmentations (comments, audit log, etc.) inside
"context-only" columns that never get edited. Means the UI can't
show those augmentations as first-class — they'd be metadata
overlays. Rejected — the augmentations ARE the product
differentiator.

### C. Eventual-consistency queue between us and AppFolio
Every write enters a queue; a background job pushes to AppFolio
when feasible. Lets writes succeed offline-from-AppFolio.
Considered for the Tenant write-side and rejected (see
`docs/tenants-write-architecture.md`) — too much queue
infrastructure for the value.

## Revisit when

- AppFolio publishes a new product or field that overlaps with
  one of our Bucket B fields → re-classify; document the merge.
- We add a non-AppFolio PMS → this registry forks per-PMS, or we
  abstract into a generic PMS adapter layer.
- We add a new write-side endpoint and the bucket isn't obvious
  → use this ADR + the Tenants write-architecture doc as the
  template for resolving the question.
