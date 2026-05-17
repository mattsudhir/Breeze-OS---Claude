# 0008. Move-in / move-out / turnover checklists

**Status:** Proposed
**Date:** 2026-05-17
**Deciders:** mattsudhir + Claude (this session)

## Context

A property turnover is a multi-week, multi-actor workflow with
real legal teeth (state-mandated security-deposit return deadlines,
disclosure requirements, inspection-photo evidence). Today Breeze
tracks `move_events` but has no enforcement layer underneath —
items get missed, deadlines get missed, photo evidence lives in
phones, and the system can't tell a manager what's still
outstanding.

The user laid it out:

> "I think we need the construct of a move-in / move-out checklist
> that can be customized by property. Ideally, the system will have
> this shit on its own. For example, change over utilities, move
> out pics, turnover punch list (possibly AI generated based on
> Company Cam pics), key transfer, Codebox addition / removal,
> move out accounting, security deposit return, mailbox key
> exchange, list / delist, send move in packet..."

There are three distinct phases (with overlap):

1. **Move-out** — current tenant leaves. Photos, key counts,
   deposit reconciliation, deadline-tracked refund/itemization.
2. **Turnover** — vacancy work. Punch list, cleaning, repairs,
   re-key, photo-confirmed completion.
3. **Move-in** — new tenant arrives. Lease execution, key
   issuance, insurance proof, walkthrough, welcome packet.

Each has 10-15 items the company does the same way every time,
plus a few items that vary per property (mailbox, garage opener,
codebox, HOA).

## Decision

Three-table pattern: **templates → instances → items**.

```
checklist_templates       (org-level + per-property override)
  id, organization_id, scope ('org'|'property'),
  property_id (null for org default),
  phase ('move_out'|'turnover'|'move_in'),
  name, version, is_active

checklist_template_items  (the canonical list — one row per item)
  id, template_id, sort_order,
  code (stable identifier — 'collect_keys', 'rotate_codebox', etc.),
  title, description, default_assignee_role,
  evidence_required ('photo'|'document'|'signature'|null),
  deadline_offset_days (null = no deadline; positive = days from
                        event start; negative = days before event end),
  legal_basis (null | 'state_deposit_deadline' | 'lease_required'),
  conditional_on (jsonb — e.g. {has_codebox: true}, evaluated against
                  property attributes at instantiation time)

checklist_instances       (one per move_event)
  id, move_event_id, template_id, template_version,
  property_id, phase, status, started_at, completed_at

checklist_items           (the live items for this instance)
  id, instance_id, template_item_id, code,
  status ('pending'|'in_progress'|'done'|'skipped'|'blocked'),
  assignee_user_id, assignee_vendor_id,
  due_at, completed_at, completed_by,
  evidence_url, evidence_type, notes,
  parent_task_id (link to human_tasks for ones that became calls)
```

Per ADR 0003 (cache labeling), the template_items + items live in
the BREEZE-OWNED bucket — fully ours, source-of-truth.

## Instantiation

When a `move_event` is created (manually or via the voice macro
in ADR 0007), the system:

1. Selects the right template: per-property override if it exists,
   otherwise org default for that phase.
2. Snapshots the version (so editing the template later doesn't
   mutate live instances).
3. For each `checklist_template_item`, evaluates `conditional_on`
   against the property's known attributes. Skipped items are not
   created — keeps the live checklist tight.
4. Computes `due_at` from `deadline_offset_days` + the move event
   anchor date.
5. Returns the instance + items to the UI / chat for review.

## Starter template (move-out, Ohio default)

These are the items shipping in v1 — the canonical Breeze list,
derived from current ops:

| code | title | evidence | deadline_offset_days | legal_basis |
|---|---|---|---|---|
| `final_walkthrough_scheduled` | Schedule final walkthrough + send tenant notice | — | -7 | lease_required |
| `move_out_inspection_photos` | Move-out inspection photo set | photo | 0 | — |
| `damage_assessment` | Damage assessment vs. move-in baseline | document | 1 | — |
| `forwarding_address_captured` | Capture tenant forwarding address | — | 0 | state_deposit_deadline |
| `keys_collected` | Keys returned (count vs. issued) | document | 0 | — |
| `mailbox_key_collected` | Mailbox key returned | — | 0 | — |
| `garage_opener_collected` | Garage opener / fob returned | — | 0 | — |
| `codebox_rotated` | Codebox / smart-lock code rotated | — | 1 | — |
| `utilities_to_ll_name` | Utilities flipped to landlord name | document | 2 | — |
| `final_rent_reconciled` | Final rent + prorate + allocation reconciled | — | 1 | — |
| `deposit_reconciliation` | Security deposit reconciliation drafted | document | 3 | — |
| `deposit_letter_mailed` | Itemized deposit-return letter + refund mailed | document | (state-specific) | state_deposit_deadline |
| `lease_status_ended` | Mark lease ended in system | — | 0 | — |

Conditional items use `conditional_on`:
- `mailbox_key_collected`: `{has_mailbox: true}` (most SFRs, no
  multi-family with package room)
- `garage_opener_collected`: `{has_garage: true}`
- `codebox_rotated`: `{has_codebox: true}`

Turnover + move-in templates ship similarly with their own item
sets; see the appendix below for the v1 list.

## State-aware deposit deadline

The single most legally-exposed item is the deposit return
deadline. Ohio Rev. Code §5321.16 mandates 30 days from
surrender of premises with an itemized statement; violation
doubles the wrongfully-withheld portion + attorney fees. Other
states differ (NY 14 days, CA 21).

The template's `deadline_offset_days` for `deposit_letter_mailed`
is resolved from a per-state lookup at instantiation:

```js
const DEPOSIT_DEADLINE_DAYS = {
  OH: 30,
  CA: 21,
  NY: 14,
  // …
  _default: 30,
};
```

The state comes from the property's `service_state`. Wrong default
preferred over wrong specific value, so `_default` is the most
restrictive value we trust.

When a `deposit_letter_mailed` item's `due_at` is within 5 days
and it's still `pending`, the daily-briefing tool (ADR 0005)
surfaces it as a critical signal. When it's within 24 hours, it
fires a notification. When it's overdue, it fires a high-priority
notification AND blocks marking the move-event as complete.

## AI punch-list generation

For the turnover phase, the user mentioned:

> "turnover punch list (possibly AI generated based on Company Cam
> pics)"

Pipeline:
1. Photos uploaded to CompanyCam tagged with the property + event.
2. Cron pulls new photos for any open turnover instance.
3. Each photo + move-in baseline goes to Claude with a "compare,
   list damage / wear / repair items" prompt.
4. Each returned item becomes a `checklist_items` row in the
   turnover instance (template_item_id = null, code = 'ai_punch_*',
   evidence_url = the photo).
5. Items are flagged `requires_review` so a human approves before
   they go to vendors.

This is the same opt-in / human-approval pattern from ADR 0004
(AI ticket-title summaries). v1 ships the data path + manual
trigger; cron + auto-pull is v1.1.

## Customization UX

Per-property override creation:
1. User opens Property Detail → Settings → Checklists.
2. Shows the org default for each phase with toggles per item
   ("include in this property's move-out checklist?").
3. Saves a `checklist_templates` row with `scope='property'` and
   `property_id=<this one>`.
4. The included items are a subset of the org default's items
   (new items can be added later via "Add custom item").

Bulk edits to the org default propagate to per-property templates
unless the per-property row explicitly overrides that item.

## Consequences

- One unified "what's left to do" surface across move-in, move-out,
  and turnover. Every screen that surfaces a move_event can show
  its checklist progress without N+1 queries.
- The voice macro from ADR 0007 (`start_utility_changeover`)
  becomes a checklist-item creator — it queues `utilities_to_ll_name`
  + sub-tasks per provider as `parent_task_id`-linked human_tasks.
- Deposit-deadline missing becomes a system-prevented event, not a
  manager-vigilance event. That alone justifies the build.
- The AI punch-list pipeline gives us a second high-value Claude
  use after the ticket-title summarizer.

## Trade-offs we accept

- **Template versioning vs. snapshot.** We snapshot template
  version into the instance so editing a template doesn't retroactively
  change live checklists. Means "edit the org default and have
  everyone in flight get the update" requires an explicit
  "re-apply template" action. Acceptable: in-flight checklists
  are usually <2 weeks old.
- **State law beyond Ohio**. v1 ships Ohio rules + a `_default`
  fallback. Adding states is incremental config, not engineering.
  A full multi-state rule engine (different mandatory disclosures,
  different inspection notice periods, different proration rules)
  is deferred until we sign a client outside Ohio.
- **CompanyCam integration burden**. Their API requires a per-org
  OAuth grant. v1 ships a "manual photo URL" path so the AI punch
  list works regardless; CompanyCam OAuth is a separate ticket.

## Related ADRs

- 0001 (data source) — checklists are Breeze-native; no AppFolio
  mirror.
- 0003 (cache labels) — checklist_templates + checklist_items are
  BREEZE bucket.
- 0004 (AI ticket titles) — same opt-in / human-approval pattern
  used for the AI punch list.
- 0005 (daily briefing) — deposit-deadline-soon items become
  briefing signals.
- 0007 (voice + macros) — `start_utility_changeover` macro creates
  a checklist item under the hood.

## Appendix: starter turnover + move-in items

**Turnover (vacancy work):**
- AI punch list from move-out photos (`ai_punch_*`)
- Re-key locks
- Deep clean
- Smoke + CO detector test + batteries
- HVAC filter swap
- Touch-up paint
- Yard reset (if `has_yard`)
- Photo-confirmed completion before relist

**Move-in:**
- Lease executed + signed
- Security deposit + first month collected
- Renters insurance proof on file
- Move-in walkthrough + signed inspection + baseline photos
- Keys / mailbox key / garage opener issued (signed receipt)
- Codebox code set for new tenant
- Utilities into tenant name (proof of transfer)
- ACH autopay enrolled
- Tenant portal account created
- Welcome packet sent (parking, trash, contacts)
- Pet addendum + pet deposit (if `pet_allowed` AND tenant has pet)
- Move-in event posted to accounting
