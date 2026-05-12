// Foundational posting primitives.
//
// Three exports:
//
//   ensureAccountingPeriod(tx, orgId, date)
//     - Find (or auto-create) the monthly period that contains `date`.
//       Required because journal_entries.period_id is NOT NULL and
//       the period must be 'open' at post time.
//
//   lookupGlAccountByCode(tx, orgId, code)
//     - Resolve a chart-of-accounts code to its gl_account uuid.
//       Throws if not found, so callers fail loud instead of writing
//       a NULL FK that the DB would reject anyway.
//
//   postJournalEntry(tx, orgId, params)
//     - The load-bearing helper. Acquires the next entry_number via
//       FOR UPDATE on journal_entry_counters, inserts the entry as
//       draft, inserts every line, materialises tags (account
//       defaults + explicit overrides), then flips to 'posted'.
//       The DB trigger validates balance + non-zero at the moment
//       of transition. Caller passes a Drizzle transaction so the
//       whole sequence is one atomic unit.
//
// Everything in this module assumes it's running inside a Drizzle
// transaction (`tx`) — callers must wrap. There's no convenience
// "auto-transact" wrapper because the AR flows almost always need
// to compose multiple posting calls in one transaction (e.g. record
// a receipt + allocate against open charges in one shot).

import { and, eq, sql } from 'drizzle-orm';
import {
  glAccounts,
  glAccountTags,
  accountingPeriods,
  journalEntries,
  journalLines,
  journalLineTags,
} from '../db/schema/accounting.js';
import { properties } from '../db/schema/directory.js';
import { validateTagSet, tagsArrayToMap } from './tagVocabularies.js';

// ── ensureAccountingPeriod ───────────────────────────────────────

/**
 * Find or auto-create the monthly accounting_period that contains
 * the given calendar date. Returns the period's uuid id.
 *
 * Throws if the matching period exists but is `hard_closed` — no
 * posting can land in a hard-closed period under any circumstances.
 * `soft_closed` is silently allowed; the calling workflow is
 * responsible for any override + audit_event logic.
 *
 * @param {object} tx
 * @param {string} organizationId
 * @param {string|Date} dateIso  YYYY-MM-DD or Date
 * @returns {Promise<string>} period_id
 */
export async function ensureAccountingPeriod(tx, organizationId, dateIso) {
  if (!organizationId) throw new Error('ensureAccountingPeriod: organizationId required');
  const d = typeof dateIso === 'string' ? new Date(dateIso + 'T00:00:00Z') : new Date(dateIso);
  if (isNaN(d.getTime())) throw new Error(`ensureAccountingPeriod: invalid date ${dateIso}`);

  const year = d.getUTCFullYear();
  const month = d.getUTCMonth(); // 0-11
  const periodStart = new Date(Date.UTC(year, month, 1)).toISOString().slice(0, 10);
  const periodEndDate = new Date(Date.UTC(year, month + 1, 0)); // last day of month
  const periodEnd = periodEndDate.toISOString().slice(0, 10);

  // Try fetch first.
  const existing = await tx
    .select({
      id: accountingPeriods.id,
      status: accountingPeriods.status,
    })
    .from(accountingPeriods)
    .where(
      and(
        eq(accountingPeriods.organizationId, organizationId),
        eq(accountingPeriods.periodStart, periodStart),
        eq(accountingPeriods.periodEnd, periodEnd),
      ),
    )
    .limit(1);

  if (existing.length > 0) {
    const p = existing[0];
    if (p.status === 'hard_closed') {
      throw new Error(
        `Cannot post into hard-closed period ${periodStart}..${periodEnd}`,
      );
    }
    return p.id;
  }

  // Insert monthly period with status='open'.
  const [created] = await tx
    .insert(accountingPeriods)
    .values({
      organizationId,
      periodStart,
      periodEnd,
      fiscalYear: year,
      status: 'open',
    })
    .returning({ id: accountingPeriods.id });

  return created.id;
}

// ── lookupGlAccountByCode ────────────────────────────────────────

/**
 * Resolve a chart-of-accounts code (e.g. "1100", "4010") to its
 * gl_account uuid for the given org. Throws if not found.
 *
 * @param {object} tx
 * @param {string} organizationId
 * @param {string} code
 * @returns {Promise<string>} gl_account.id
 */
export async function lookupGlAccountByCode(tx, organizationId, code) {
  if (!code) throw new Error('lookupGlAccountByCode: code required');
  const rows = await tx
    .select({ id: glAccounts.id })
    .from(glAccounts)
    .where(
      and(
        eq(glAccounts.organizationId, organizationId),
        eq(glAccounts.code, code),
      ),
    )
    .limit(1);
  if (rows.length === 0) {
    throw new Error(`gl_account not found: code=${code} org=${organizationId}`);
  }
  return rows[0].id;
}

// ── nextEntryNumber ──────────────────────────────────────────────

// Internal: take the FOR UPDATE lock on journal_entry_counters,
// increment, return the previous value. First call for the org
// creates the row at value 2 (and returns 1).
async function nextEntryNumber(tx, organizationId) {
  // Upsert pattern: try increment; if no row exists, insert one and
  // return 1. Postgres-specific raw SQL keeps it in one round-trip.
  //
  // We use SELECT ... FOR UPDATE first so concurrent posters
  // serialise on the row lock, then INSERT ... ON CONFLICT DO
  // UPDATE for the increment.
  const upsert = await tx.execute(sql`
    INSERT INTO "journal_entry_counters" ("organization_id", "next_value", "updated_at")
    VALUES (${organizationId}, 2, now())
    ON CONFLICT ("organization_id") DO UPDATE
      SET "next_value" = "journal_entry_counters"."next_value" + 1,
          "updated_at" = now()
    RETURNING "next_value"
  `);
  // RETURNING gives the NEW value. Subtract 1 to get the value we
  // assign to THIS entry.
  const row = upsert.rows ? upsert.rows[0] : upsert[0];
  const nextValue = Number(row.next_value);
  return nextValue - 1;
}

// ── postJournalEntry ─────────────────────────────────────────────

/**
 * Post a journal entry to the GL.
 *
 * The entry is created as `draft`, lines + tags are inserted, then
 * status flips to `posted` — at which point the BEFORE UPDATE
 * trigger from migration 0006 validates that sum(debits) =
 * sum(credits) > 0. If the entry doesn't balance, the whole
 * transaction rolls back.
 *
 * Caller is responsible for providing a Drizzle transaction (`tx`).
 *
 * @param {object} tx
 * @param {string} organizationId
 * @param {object} params
 * @param {string} params.entryDate           YYYY-MM-DD accounting date
 * @param {string} params.entryType           journal_entry_type enum
 * @param {string} [params.memo]              entry-level description
 * @param {string} [params.sourceTable]       polymorphic source ref
 * @param {string} [params.sourceId]          polymorphic source ref
 * @param {string} [params.postedByUserId]    user uuid that posted
 * @param {Array<object>} params.lines        debits/credits (see below)
 *
 * line shape: {
 *   glAccountId, debitCents, creditCents, memo?,
 *   unitId?, propertyId?, ownerId?, entityId?,
 *   leaseId?, tenantId?, vendorId?,
 *   beneficiaryType?, beneficiaryId?,
 *   explicitTags?: [{ namespace, value, source? }]
 * }
 *
 * entityId resolution: if a line omits entityId but provides
 * propertyId, the posting helper fills entityId from
 * properties.entity_id. Explicit l.entityId always wins, so
 * intercompany lines (no property attribution) can still set the
 * entity directly.
 *
 * Exactly one of debitCents / creditCents must be non-zero per line
 * (DB CHECK enforces this; we just pass through). Both non-negative.
 *
 * @returns {Promise<{
 *   journalEntryId: string,
 *   entryNumber: number,
 *   lineIds: string[],
 * }>}
 */
export async function postJournalEntry(tx, organizationId, params) {
  if (!organizationId) throw new Error('postJournalEntry: organizationId required');
  const {
    entryDate,
    entryType,
    memo = null,
    sourceTable = null,
    sourceId = null,
    postedByUserId = null,
    lines = [],
  } = params;

  if (!entryDate) throw new Error('postJournalEntry: entryDate required');
  if (!entryType) throw new Error('postJournalEntry: entryType required');
  if (!Array.isArray(lines) || lines.length === 0) {
    throw new Error('postJournalEntry: at least one line required');
  }

  // Pre-flight: balance check (defensive — the DB trigger also
  // catches this, but we'd rather fail before opening the lock).
  const totalDebit = lines.reduce((s, l) => s + (l.debitCents || 0), 0);
  const totalCredit = lines.reduce((s, l) => s + (l.creditCents || 0), 0);
  if (totalDebit !== totalCredit) {
    throw new Error(
      `postJournalEntry: lines do not balance — debit=${totalDebit} credit=${totalCredit}`,
    );
  }
  if (totalDebit === 0) {
    throw new Error('postJournalEntry: zero-amount entry not allowed');
  }

  // 1. Resolve period.
  const periodId = await ensureAccountingPeriod(tx, organizationId, entryDate);

  // 2. Acquire next entry_number via the upsert+lock pattern.
  const entryNumber = await nextEntryNumber(tx, organizationId);

  // 3. Insert journal_entries as draft.
  const [entry] = await tx
    .insert(journalEntries)
    .values({
      organizationId,
      entryNumber,
      entryDate,
      periodId,
      entryType,
      sourceTable,
      sourceId,
      memo,
      status: 'draft',
      postedByUserId,
    })
    .returning({ id: journalEntries.id });
  const journalEntryId = entry.id;

  // 4. Resolve entity_id per line.
  //
  // Resolution order: explicit l.entityId wins; otherwise inherit
  // from the line's property → property.entity_id (one batched lookup
  // per unique property to avoid N+1).
  const propertyIdsNeedingEntity = Array.from(
    new Set(
      lines
        .filter((l) => !l.entityId && l.propertyId)
        .map((l) => l.propertyId),
    ),
  );
  const entityByProperty = new Map();
  if (propertyIdsNeedingEntity.length > 0) {
    const rows = await tx
      .select({ id: properties.id, entityId: properties.entityId })
      .from(properties)
      .where(sql`${properties.id} IN ${propertyIdsNeedingEntity}`);
    for (const r of rows) entityByProperty.set(r.id, r.entityId);
  }

  // 5. Insert lines.
  const lineRows = [];
  let lineNumber = 0;
  for (const l of lines) {
    lineNumber += 1;
    const resolvedEntityId =
      l.entityId ||
      (l.propertyId ? entityByProperty.get(l.propertyId) || null : null);
    const [row] = await tx
      .insert(journalLines)
      .values({
        organizationId,
        journalEntryId,
        glAccountId: l.glAccountId,
        debitCents: l.debitCents || 0,
        creditCents: l.creditCents || 0,
        lineNumber,
        memo: l.memo || null,
        unitId: l.unitId || null,
        propertyId: l.propertyId || null,
        ownerId: l.ownerId || null,
        entityId: resolvedEntityId,
        leaseId: l.leaseId || null,
        tenantId: l.tenantId || null,
        vendorId: l.vendorId || null,
        beneficiaryType: l.beneficiaryType || null,
        beneficiaryId: l.beneficiaryId || null,
      })
      .returning({ id: journalLines.id });
    lineRows.push({ id: row.id, line: l });
  }

  // 5. Cascade tags onto each line.
  await materialiseTagsForLines(tx, organizationId, lineRows);

  // 6. Flip to posted (trigger validates balance + lines exist).
  await tx
    .update(journalEntries)
    .set({
      status: 'posted',
      postedAt: new Date(),
    })
    .where(eq(journalEntries.id, journalEntryId));

  return {
    journalEntryId,
    entryNumber,
    lineIds: lineRows.map((r) => r.id),
  };
}

// ── Tag cascade ──────────────────────────────────────────────────

async function materialiseTagsForLines(tx, organizationId, lineRows) {
  // Pre-fetch every account's default tags in one query to avoid
  // N+1. Group by gl_account_id.
  const accountIds = Array.from(new Set(lineRows.map((r) => r.line.glAccountId)));
  if (accountIds.length === 0) return;

  const defaults = await tx
    .select({
      glAccountId: glAccountTags.glAccountId,
      namespace: glAccountTags.namespace,
      value: glAccountTags.value,
    })
    .from(glAccountTags)
    .where(sql`${glAccountTags.glAccountId} IN ${accountIds}`);

  const defaultsByAccount = new Map();
  for (const d of defaults) {
    if (!defaultsByAccount.has(d.glAccountId)) defaultsByAccount.set(d.glAccountId, []);
    defaultsByAccount.get(d.glAccountId).push(d);
  }

  for (const r of lineRows) {
    const accountDefaults = defaultsByAccount.get(r.line.glAccountId) || [];
    const explicit = r.line.explicitTags || [];

    // Compose effective tag set. Explicit wins over default within
    // the same (namespace,value); but multiple values in the same
    // namespace are kept (tags are many-to-many).
    const map = new Map(); // key = ns:value -> { ns, value, source }
    for (const t of accountDefaults) {
      map.set(`${t.namespace}:${t.value}`, {
        namespace: t.namespace,
        value: t.value,
        source: 'account_default',
      });
    }
    for (const t of explicit) {
      map.set(`${t.namespace}:${t.value}`, {
        namespace: t.namespace,
        value: t.value,
        source: t.source || 'posting_explicit',
      });
    }

    const tagRows = Array.from(map.values());
    if (tagRows.length === 0) continue;

    // Validate vocabulary rules. Fail loud if a posting violates
    // (e.g. capital_expense without a capitalising tax_treatment).
    const violations = validateTagSet(tagsArrayToMap(tagRows));
    if (violations.length > 0) {
      throw new Error(
        `Tag validation failed for line ${r.id}: ` +
          violations.map((v) => v.message).join('; '),
      );
    }

    await tx
      .insert(journalLineTags)
      .values(
        tagRows.map((t) => ({
          journalLineId: r.id,
          organizationId,
          namespace: t.namespace,
          value: t.value,
          source: t.source,
        })),
      )
      .onConflictDoNothing();
  }
}
