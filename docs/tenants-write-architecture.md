# TenantsPage write architecture — design sketch

**Status:** draft for review. No code shipped yet.
**Author:** Claude session 01K478PwgTKC56Bwgg7nxFWR
**Date:** 2026-05-16

## The problem

The TenantsPage list view now reads from our DB (via
`/api/admin/list-tenants`). Two surfaces still go through the AppFolio
passthrough chain:

1. **Detail view** — `getTenant(dataSource, id)` calls
   AppFolio's `/tenants/:id` and renders the result.
2. **Edit / save** — `updateTenant(dataSource, id, form)` calls
   AppFolio's PATCH `/tenants/:id` to mutate the tenant.

Read-side migration is easy. Write-side has a real consistency
question: where is the source of truth, and how do the two stores
stay in sync?

## Three plausible models

### A. AppFolio-first (write-through cache)

```
UI → POST /api/admin/update-tenant
       ↓ AppFolio PATCH /tenants/:id   ← source of truth
       ↓ on 2xx → UPDATE local tenants SET … WHERE source_tenant_id = …
       ↓ return updated row
UI ← rerender
```

- **Pros**
  - AppFolio remains canonical. No drift; if the cron-sync ever runs,
    nothing fights.
  - Single failure mode: if AppFolio rejects, we don't touch our DB,
    user sees the AppFolio error.
- **Cons**
  - User-visible latency = AppFolio API latency (300ms–2s typical,
    occasionally worse).
  - We need a working AppFolio connection just to edit a tenant.
  - If AppFolio's `PATCH /tenants/:id` doesn't support all the
    fields we expose, we can't surface those writes at all.
- **Failure modes**
  - AppFolio down → edits blocked. Display "AppFolio unreachable, try
    again in a moment."
  - AppFolio accepts but our local UPDATE fails (rare) → next sync
    cron reconciles.

### B. Local-first (eventual consistency)

```
UI → POST /api/admin/update-tenant
       ↓ UPDATE local tenants SET … RETURNING …
       ↓ ENQUEUE async push job (write-behind queue)
       ↓ return updated row immediately
UI ← rerender
       background: drain queue → AppFolio PATCH → mark synced
```

- **Pros**
  - Instant feedback. UI is fast regardless of AppFolio.
  - Works offline / during AppFolio outages.
  - Write queue is reusable for other writes (units, leases, etc).
- **Cons**
  - Drift is real. If a push job fails permanently (validation reject),
    the local row diverges from AppFolio.
  - Need: a queue (table), a retry loop (cron), a dead-letter status
    on rows that fail repeatedly, a UI indicator "pending sync".
  - Conflict handling: if AppFolio's sync also updates the tenant
    before our push lands, who wins? (Usually: last-write-wins by
    timestamp; document explicitly.)
- **Failure modes**
  - Validation fail at AppFolio after local-success → tenant carries
    a sync_error_message, UI flags it; user must fix and resubmit.
  - Network drop mid-push → retry from queue.

### C. Both-at-once (two-phase, no queue)

```
UI → POST /api/admin/update-tenant
       ↓ AppFolio PATCH /tenants/:id   (Phase 1)
       ↓ on 2xx, UPDATE local tenants   (Phase 2)
       ↓ on Phase 2 fail → background reconciliation, return ok=true
       ↓ on Phase 1 fail → return error, don't touch local
       ↓ return updated row
UI ← rerender
```

- Basically AppFolio-first (A) with explicit reconciliation if local
  write fails (which is rare).
- Behaves identically to (A) for the user; the difference is internal
  bookkeeping about what local writes failed.

## Recommendation: **AppFolio-first (A)**

Reasoning:
1. **AppFolio is the legal source of truth today** — checks get cut
   from there, the property manager's existing workflows already
   trust AppFolio. We become a faster UI on top, not a parallel
   system of record.
2. **No queue infrastructure to maintain.** Queues sound simple but
   come with retry / dead-letter / observability tax that's not
   worth it for the v1 ledger-of-record case.
3. **Latency is acceptable.** Tenant edits aren't a hot path — a
   user might edit a tenant a few times a day. 800ms once isn't a UX
   killer.
4. **Migrating later is easy.** If we ever flip Breeze to source-of-
   truth (when we sell Breeze OS standalone, no AppFolio in the
   loop), the write endpoint just stops calling AppFolio. UI doesn't
   change.

The local-first (B) model becomes attractive ONLY when:
- AppFolio is no longer the source of truth, OR
- We have multiple downstream systems to push to (not just AppFolio),
  in which case the queue is justified.

Neither is true today.

## Implementation sketch (model A)

### New endpoint: `POST /api/admin/update-tenant`

```js
// body: { id, patch: { first_name?, last_name?, email?, phone?,
//                       mobile_phone?, notes? } }
//   `id` may be either:
//     - our internal UUID (breeze_id from list-tenants), or
//     - the AppFolio source_tenant_id
//   The endpoint resolves either to the local row + source id.

import { ... } from 'drizzle-orm';
import { withAdminHandler, getDefaultOrgId } from '...';
import { patchTenant as appfolioPatchTenant } from '...';

export default withAdminHandler(async (req, res) => {
  if (req.method !== 'POST') return res.status(405)...

  const { id, patch } = parseBody(req);
  // Validate patch keys against our whitelist; reject unknown fields.
  // Translate patch keys: our `mobile_phone` → AppFolio's `MobilePhone`.

  // Resolve `id` to our local row.
  const local = await db.select(...).from(tenants).where(
    or(eq(tenants.id, id), eq(tenants.sourceTenantId, id))
  ).limit(1);
  if (!local) return res.status(404)...

  // Phase 1: AppFolio.
  let afResult;
  try {
    afResult = await appfolioPatchTenant(local.sourceTenantId, patch);
  } catch (err) {
    return res.status(502).json({ ok: false, error: err.message });
  }

  // Phase 2: our DB. If this fails, log + persist a sync_error_message
  // on the row but still return ok=true (AppFolio is canonical).
  try {
    await db.update(tenants).set({
      ...mapPatchToLocalSchema(patch),
      updatedAt: new Date(),
    }).where(eq(tenants.id, local.id));
  } catch (err) {
    persistAdminError(req, err, 500).catch(() => {});
  }

  return res.status(200).json({ ok: true, source_tenant_id: local.sourceTenantId });
});
```

### New endpoint: `GET /api/admin/get-tenant?id=X`

Reads the tenant + their leases + units + properties + recent
payments (last 24mo) from our DB. Returns a shape that matches what
the existing detail view consumes.

Detail view is read-only against our DB. Edit form posts to the
write endpoint above.

### Frontend changes

In `TenantsPage.jsx`:

```js
// Detail view:
const full = await fetchOurDb('/api/admin/get-tenant', { id });

// Save:
await fetchOurDb('/api/admin/update-tenant', {
  method: 'POST',
  body: { id: tenant.id, patch: form },
});
```

Drop `getTenant` and `updateTenant` imports from `services/data`.

### Field whitelist (initial cut)

Editable by Breeze:
- first_name, last_name → drives display_name re-derivation
- email
- phone, mobile_phone
- notes (local-only field; not pushed to AppFolio)

NOT editable from Breeze (read-only):
- source_tenant_id (managed by AppFolio)
- status / lease assignment (managed via Leasing flow)
- balance / charges (managed via Accounting flow)

## Open questions

1. **Does AppFolio's `PATCH /tenants/:id` support all the fields we
   want to edit?** Need to verify against AppFolio API docs (or test
   in sandbox if available). If not, those fields become local-only.
2. **What about creating new tenants?** Same write-through pattern,
   but POST to `/api/admin/create-tenant`. Defer to a separate
   ticket — list/edit is the immediate need.
3. **What about soft-deleting tenants?** AppFolio doesn't support
   delete; tenants just become 'past'. So our delete is also a no-op
   in practice. Surface a "remove from list" UI hint instead.
4. **Audit log.** When a tenant is edited, who edited what when?
   Out of scope for this design but worth a follow-up. The
   `admin_error_log` table is a reasonable pattern to extend
   (`admin_audit_log` with before/after JSON columns).

## Estimated effort

- New endpoints (`get-tenant`, `update-tenant`): ~3 hours
- Frontend rewrite of detail + edit views: ~3 hours
- AppFolio backend client extension for PATCH: ~1 hour
- Testing in sandbox: ~1 hour
- **Total: ~1 working day**

## Go / no-go

This sketch is for your review. If you approve model A, I'll build
both endpoints + the frontend in a follow-up session. If you want a
different model, swap in (B) or (C) above and I'll re-scope.
