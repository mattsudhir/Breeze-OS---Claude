# Session handoff notes

Living document — outstanding setup tasks, deferred work, and known caveats.
Update at the end of each session, prune when items are completed.

## Setup tasks for the human (one-time, in Vercel / AppFolio)

These were committed in code but require a manual action you haven't completed yet.

### Vercel

- [x] **Blob store created and connected** to `breeze-os-claude`. `BLOB_READ_WRITE_TOKEN` is auto-injected.
- [ ] **Apply DB migrations.** After the next deploy lands, hit `https://<your-domain>/api/db-migrate` once. This applies:
  - `0006_agent_actions` — every chat tool call gets logged. Without this, chat still works, but audit is silently dropped (the logger swallows errors).
  - `0007_notifications_and_follows` — required by `/api/notifications` and `/api/follows`. Calls to those endpoints will 500 until applied.

### AppFolio Developer Portal (when ready for PR B2 — webhook receiver)

- [ ] **Confirm webhooks are enabled** for your developer ID. AppFolio's docs say this is a one-time enablement by an AppFolio rep; if it's already done, skip.
- [ ] **Add the webhook URL** in Admin → Webhooks card: `https://<your-domain>/api/webhooks/appfolio` (we'll create that endpoint in PR B2 — don't add it until that PR ships).
- [ ] **Subscribe to topics**: `tenants`, `properties`, `units`, `charges`, `work_orders`.

## Deferred work — queued for upcoming sessions

In priority order:

1. **Data-source toggle migration — mostly complete.** Phase 1 (lift to app-wide context + move UI to TopBar), Phase 2A (`/api/data` dispatcher + `services/data.js`), Phase 2B (PropertiesPage, TenantsPage, ClassicDashboard, PropertiesDrilldown, MaintenancePage list-fetches) all shipped. `list_work_orders` and `count_work_orders` are wrapped on the AppFolio backend.

   Remaining gaps (not blocking):
   - **MaintenancePage filter dropdowns (categories / statuses / priorities) are still RM-only**. The edit drawer's status / priority dropdowns now have AppFolio enums, but the top-level filter bar's dropdowns degrade to inline strings under AppFolio. Wire equivalent AppFolio enums for the filter bar later.
   - **`updateTenant` is RM-only.** AppFolio's PATCH /tenants/{id} only takes CustomFields per docs. Surfaces a clear error in the edit form.
   - `PropertyDirectoryPage.jsx`, `TasksPage.jsx`, `MoveEventsPage.jsx` hit our own DB (`/api/admin/*`) and aren't toggle-able by design — no migration needed.

2. **PR B2 — AppFolio webhook receiver.** `/api/webhooks/appfolio` with JWS signature verification (add `jose`), topic→enricher mapping (fetch the resource from AppFolio so the notification has a meaningful title/body), fan out via `notifications.fanoutEvent`. ~1.5 hrs.

3. **PR B3 — Bell + follow UI.** Bell icon with unread badge in the top bar, dropdown listing latest notifications, follow/unfollow buttons on entity rows in Tenants / Properties / Maintenance. ~2-3 hrs.

4. **PR C — Web push.** Service worker + `push_subscriptions` table + browser permission prompt + integration into the notifications writer so bell items also fire a push. ~2 hrs.

5. **Roadmap items from the "Solution 1 · Breeze OS" slide.** Sub-PRs:
   - **PR D — read-only**: count_work_orders, list_leads, list_leases_expiring, list_late_fee_policies, list_vendors_by_trade. ~half day.
   - **PR E — write tools**: close_ticket (PATCH /work_orders), dispatch_work_order (POST /work_orders), schedule_showing (POST /showings), waive_charge (POST /charges with negative amount). Each follows the `charge_tenant` confirm-then-act pattern. ~1 day.
   - **PR F — bulk multi-step flows**: lease renewal sends, "get me 3 plumber quotes in Youngstown" RFQ workflow. Need draft → review → send UX and probably a `workflows` table.
   - **PR G — eviction workflow + external knowledge**: custom workflow tracker, Google Places for "what schools are near…".

## Known caveats / context

- **AI audit:** `agent_actions` table logs every chat tool call. The denormalised `appfolio_*_id` columns are populated opportunistically from input/output. If a query needs an id we don't currently denormalise, the row still has the full input/output in JSONB — backfill the column with a one-shot UPDATE.
- **Stop button:** the server function keeps running to completion when the user hits Stop (Vercel serverless has no upstream cancellation), so LLM tokens for the abandoned response are still spent. The win is purely UX. Move `/api/chat` to a streaming response someday for true cancellation.
- **Branch state:** production deploys from `main`. Stale branches (`claude/appfolio-api-toggle-N8VjG`, `claude/appfolio-gui-mockup-FHEaN`, `claude/update-menu-dummy-data-mAgx8`, the dozen `claude/db-*` branches) can be deleted at your leisure now that `main` is the trunk.
- **User identity:** Notifications/follows currently use `'default-user'` since auth isn't wired in. Schema is multi-user ready — when Clerk lands, the resolver becomes a session lookup with no DB migration.
