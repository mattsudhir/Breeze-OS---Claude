# 0003. Cache vs source-of-truth labeling

**Status:** Accepted
**Date:** 2026-05-17
**Deciders:** mattsudhir + Claude (this session)

## Context

ADR 0002 split our schema into three buckets — AppFolio-canonical
(A), Breeze-canonical (B), Joint (C) — and gave a registry of
which fields fall into each. But the language in 0002 conflates
two different things in Bucket A:

- **Pure caches.** A copy of an AppFolio field that we keep locally
  for speed and offline-from-AppFolio reads. If we delete the row,
  the next sync re-creates it byte-for-byte. AppFolio is the only
  place the value exists in any meaningful sense.
- **Mirrors with augmentation.** A row that started life from
  AppFolio (so AppFolio is canonical for *some* columns) but has
  Breeze-only fields glued on (notes, audit-log entries, vendor
  assignment, etc.). Deleting the row destroys those augmentations
  — they can't be re-synced from AppFolio because AppFolio never
  knew about them.

The distinction matters for three operations:

1. **Wipe-and-reimport** (the `/api/admin/run-reimport` orchestrator
   we used to clean-slate the directory data). A pure-cache table
   can be truncated and refilled with no data loss. A mirror-with-
   augmentation table loses the augmentations on truncate. Today
   the orchestrator wipes both classes the same way — we got lucky
   because the augmentation tables (`maintenance_ticket_comments`)
   were nullable; in a future schema they might not be.

2. **Conflict resolution during sync.** If AppFolio's value for a
   column changes and our local value differs, who wins? For
   pure-cache fields, AppFolio always wins (last-write-wins is
   safe). For mirrored fields where the *row* mixes both sources,
   the answer is per-column and needs explicit logic.

3. **Reasoning about edits.** When a Breeze user edits a value
   that turns out to be a cache field, the edit is meaningless —
   it'll get blown away on next sync. We should either disallow
   the edit or surface "this field is canonical at AppFolio" in
   the UI.

## Decision

Adopt a three-label convention at the **schema-file level** (not
per-column), and tag each table accordingly:

- **`CACHE`** — every field is a copy of an AppFolio (or other
  upstream) value. The table can be truncated at any time and
  re-synced with no data loss.
- **`MIRROR`** — some fields are AppFolio-canonical, others are
  Breeze-canonical augmentations on the same row. Truncating
  destroys the augmentations.
- **`BREEZE`** — every field is Breeze-canonical. No upstream
  sync touches this table.

The label lives as the first line of the doc comment at the top of
each `lib/db/schema/*.js` file:

```js
// CACHE — AppFolio-mirrored directory data. Safe to truncate and
// re-sync via /api/admin/run-reimport. See ADR 0002 for the
// per-field ownership table.
```

```js
// MIRROR — base columns are AppFolio-canonical (source_ticket_id,
// title, status, priority, etc.) but vendor_id, internal_notes,
// and assigned_to are Breeze-only. Truncating loses those.
//
// Wipe with care; the run-reimport orchestrator is allowed to
// truncate this table because the Breeze augmentations are
// nullable today, but tighten this if that ever changes.
```

```js
// BREEZE — append-only audit trail. No upstream sync. Safe to
// edit / extend without coordination.
```

Reflect the same label in ADR 0002's registry — split Bucket A
into A-CACHE and A-MIRROR.

## Consequences

**Good:**
- Anyone reading `lib/db/schema/maintenance.js` for the first
  time sees immediately that wiping the table has consequences,
  without needing to grep the codebase or open the ADR.
- The wipe-and-reimport orchestrator becomes auditable against
  the label: it should only `TRUNCATE` `CACHE` tables; for
  `MIRROR` tables it should explicitly null-out the upstream
  columns and leave the augmentations. (Today we don't do this;
  this ADR creates the convention so future work can enforce
  it.)
- New tables get classified at creation time, not later when
  someone trips on the wrong assumption.

**Costs:**
- Discipline. The label only helps if it's accurate. Drift
  between the comment and the schema needs to be caught in
  review.
- We have to retrofit existing schema files. Mostly a one-time
  cost (about 12 files in `lib/db/schema/`).

## Action items

1. Add the label header to every file in `lib/db/schema/`.
2. Update ADR 0002's Bucket-A table to split into A-CACHE and
   A-MIRROR.
3. (Future) Teach `/api/admin/run-reimport` to refuse to truncate
   a `MIRROR` table without an explicit `--lose-augmentations`
   flag.
4. (Future) Add a schema-test that asserts every Drizzle table
   file has one of `CACHE` / `MIRROR` / `BREEZE` in its header.

## Alternatives considered

### A. Column-level labels (per-field metadata)
Tag each column with `appfolio` / `breeze` / `cached_at`. More
precise but verbose and hard to keep in sync — every column needs
a tag, and Drizzle's `pgTable` schema isn't a natural home for
free-form column docs. Rejected for noise.

### B. Naming convention only
Prefix columns with `af_` (AppFolio) or `bz_` (Breeze). Rejected
— would require renaming dozens of existing columns and breaks
SQL ergonomics ("af_first_name" reads worse than "first_name").

### C. Separate tables per source
Split `tenants` into `appfolio_tenants` (cache) and
`breeze_tenant_extensions` (augmentations) joined on
source_tenant_id. Cleaner from a labeling standpoint but doubles
the join count on every read. Rejected; the current shape is
fine, we just need to label it.

## Revisit when

- We add a non-AppFolio upstream PMS — the label may need to be
  `CACHE-APPFOLIO` / `CACHE-RM` / etc. to disambiguate.
- We outgrow the file-level label and need column-level
  precision — e.g., if a single column starts as AppFolio-canonical
  and graduates to Breeze-canonical (or vice versa). Then revisit
  alternative (A).
