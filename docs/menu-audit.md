# Menu / page audit — Breeze OS

**Date:** 2026-05-16
**Author:** Claude session 01K478PwgTKC56Bwgg7nxFWR
**Scope:** every nav item in `src/components/Sidebar.jsx` and the
page it renders.

## TL;DR

| Status | Count | Pages |
|---|---|---|
| Real data, fully functional | 16 | Chat, Dashboard, Properties, Tenants, Leasing, Move Events, Maintenance, Tasks, AI Agents (+ 4 children), Reports, Property Directory, Settings, Accounting (Chart of Accounts + 12 other tabs) |
| Honest "Coming soon" placeholder | 5 | Mail Slapper hub + Snail Mail + Registered Agent + Email + Workflows |
| Static help / docs | 1 | Help |
| Broken / misleading | 0 | — (Workflows was fixed during this audit) |

Every menu endpoint loads a real, useful page. The five "Coming
soon" surfaces are explicit about their state — no faked numbers,
no fake telemetry, no fake data.

## Per-page status

### Primary

| Nav item | Component | Source of truth | Notes |
|---|---|---|---|
| Chat Home | `ChatHome` | `/api/chat`, `/api/notify`, `/api/upload` | AI chat interface |
| Dashboard | `ClassicDashboard` | `/api/admin/list-properties-summary`, `list-maintenance-tickets`, `list-tenants` | Migrated from passthrough this session; KPIs + activity feed + maintenance queue all from our DB |

### Manage

| Nav item | Component | Source of truth | Notes |
|---|---|---|---|
| Properties | `PropertiesPage` | `/api/admin/list-properties-summary` | Sidebar list view; reads our DB. Separate from the Drilldown reached via dashboard. |
| Tenants | `TenantsPage` | `/api/admin/list-tenants`, `/api/admin/get-tenant` | List + detail both on our DB. Edit form still flows through AppFolio passthrough — see `docs/tenants-write-architecture.md` for the migration plan. |
| Leasing | `LeasingPage` | `/api/admin/list-tenants` (derived) | Active leases + expiring-in-90-days queue from our DB. Applications/screening surface is a "Coming soon" stub. |
| Move Events | `MoveEventsPage` | `/api/admin/move-events`, `/api/admin/properties` | Real CRUD over `move_events` + `move_event_utilities` + AI call outcomes. |
| Accounting | `AccountingPage` (13 tabs) | many — see file header | All 13 tabs are live: COA, Entities, Vendors, Bills, Journal Entries, Receivables, Receipts, Deposits, Bank Accounts, Reconciliation, Bill.com, Rules, Reports. Plaid Link button uses display_message preference per Plaid audit fix. |
| Maintenance | `MaintenancePage` | `/api/admin/list-maintenance-tickets`, `upsert-maintenance-ticket`, `list-ticket-comments`, `add-ticket-comment`, `list-vendors`, `sync-appfolio-tickets` | Full CRUD on tickets + AppFolio sync button + comments timeline. Honours `initialFilters.ticketId` for dashboard click-through. |
| Tasks | `TasksPage` | `/api/human-tasks` | Real task queue; 4 task types defined (`allocate_payment`, `charge_fee_review`, `confirm_rent_received`, `renew_lease`). |
| Workflows | `WorkflowsPage` | — (planned automations catalogue) | **Coming soon** — feature preview with explicit "Coming soon" pill on every entry. Fixed during this audit to remove fake "47 runs / 2h ago" telemetry. |
| Mail Slapper | `MailSlapperPage` (+3 children) | — | **Coming soon** — Snail Mail, Registered Agent, Email all explicit stubs. Self-aware. |
| AI Agents | `AiAgentsPage` (+4 children) | `/api/admin/list-ai-workflows`, `list-active-calls`, `list-pending-approvals`, `list-message-threads`, `list-thread-messages`, `approve-queued-call`, `reject-queued-call`, `pause-thread`, `upsert-ai-workflow`, `ai-settings` | Inbox / Approval Queue / Switch Utilities / Payment Plan Followup; 2 workflows currently configured. |
| Reports | `ReportsPage` | `/api/admin/list-properties-summary` | KPIs, YTD income/expense, top-15 occupancy. "Saved reports" section is a stub with "Coming soon" pill. Rewrote this session to drop fabricated "Oakwood / 94.2%" demo. |
| Property Directory | `PropertyDirectoryPage` | the admin diagnostics surface | The dev/ops console — Reimport tab, diagnostics tab, bulk imports, etc. |

### Bottom

| Nav item | Component | Source of truth | Notes |
|---|---|---|---|
| Settings | `SettingsPage` | `/api/data`, `/api/category-subscriptions`, `/api/issue-gl-mappings`, `/api/db-migrate` | Data-source toggle, push subs, GL mappings, migration runner |
| Help | `HelpPage` | static | Help text + FAQs |

## What the audit caught

1. **WorkflowsPage rendered fabricated telemetry** (47 runs / 2h
   ago). Had a "Preview" banner but the per-row stats overrode it
   visually. **Fixed:** stripped runs + last-ran, added per-row
   "Not yet active" badges, disabled the New Workflow button,
   reworded the banner to be unambiguous.

2. **AccountingPage's header comment was stale**, claiming Journal
   Entries / Receivables / Receipts / Deposits / Bank Accounts
   were placeholders when each is a real implementation with
   endpoint calls. **Fixed:** comment rewritten to list all 13
   live tabs and their endpoints.

## Backend endpoint health

Probed via the GitHub-Actions ChatOps loop (`/run-diag GET ...`):

| Endpoint | Result |
|---|---|
| `/api/admin/list-ai-workflows` | ✓ 2 workflows |
| `/api/admin/list-bank-accounts` | ✓ 37 accounts + parked summary |
| `/api/admin/list-vendors` | ✓ empty (no vendors yet) |
| `/api/admin/list-gl-accounts` | ✓ 249 GL accounts |
| `/api/admin/list-message-threads` | ✓ empty |
| `/api/admin/onboarding-state` | ✓ state returned |
| `/api/human-tasks` | ✓ 0 tasks; types enum populated |

Also green: `smoke-test` (9/9 checks pass), `recent-errors` (zero
in last hour), `recent-audit` (zero — no writes have fired yet,
which is expected since no UI flow drives the new audit log).

## Outstanding work surfaced by the audit

None blocking. The honest "Coming soon" pages have clear
roadmap-level intent:

- **Workflows** needs a rules engine. Big project, not a quick fix.
- **Mail Slapper** needs three third-party integrations (Lob/PostGrid
  for snail, a registered-agent service partner, and a transactional-
  email provider). Each is its own multi-week project.
- **Tenants write side** needs the consistency-model decision per
  `docs/tenants-write-architecture.md`.

## Files modified during this audit

- `src/components/WorkflowsPage.jsx` — rewrote as honest catalogue
- `src/components/AccountingPage.jsx` — fixed stale header comment
- `docs/menu-audit.md` (this file)

Per-commit detail in the git log between the previous "Wire
recordAudit" commit and this one.
