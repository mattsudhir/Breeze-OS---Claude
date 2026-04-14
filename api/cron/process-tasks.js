// Vercel Cron Function — task queue drainer.
//
// Runs every N minutes (see vercel.json "crons" entry) and processes
// pending rows in the `tasks` table whose scheduled_for is <= now().
//
// The loop:
//   1. SELECT candidate tasks with FOR UPDATE SKIP LOCKED (so parallel
//      cron instances can't double-process the same row).
//   2. For each task, mark it 'claimed' inside the same txn.
//   3. Dispatch by kind to a handler function.
//   4. On success, mark the task 'completed'.
//   5. On failure, mark 'failed' and record the error. The webhook
//      side (not us) handles retry-scheduling by creating NEW tasks.
//
// Kinds currently supported:
//   - retry_move_event_utility — fire a Vapi call for a single
//     move_event_utility row.
//
// New kinds are added here as the product grows. Keep each handler
// small and delegate real work to lib/* helpers.
//
// Authentication: Vercel cron jobs are invoked with an
// `x-vercel-cron` header containing a signed token. We also accept
// BREEZE_ADMIN_TOKEN for manual invocation (debugging).

import { and, eq, inArray, lte, sql } from 'drizzle-orm';
import { getDb, schema } from '../../lib/db/index.js';
import { placeUtilityCall } from '../../lib/vapiCaller.js';

const MAX_TASKS_PER_RUN = 20;

// ── Auth guard ───────────────────────────────────────────────────

function isAuthorizedCron(req) {
  // Vercel cron sends this header automatically; absent otherwise.
  if (req.headers['x-vercel-cron']) return true;
  // Fall back to admin token for manual invocation.
  const expected = process.env.BREEZE_ADMIN_TOKEN;
  if (!expected) return true; // dev / first-boot mode
  const provided =
    req.query?.secret ||
    req.headers['x-breeze-admin-token'] ||
    (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  return provided === expected;
}

// ── Date helpers ─────────────────────────────────────────────────

function plusHours(base, hours) {
  return new Date(base.getTime() + hours * 3600 * 1000);
}

// ── Task handlers ────────────────────────────────────────────────

// retry_move_event_utility
//
// payload: { moveEventUtilityId: uuid }
//
// Side effects:
//   - Reads the move_event_utility, its move_event, its property,
//     and the property_utilities + provider + owner rows needed to
//     build the Vapi call context.
//   - Increments the attempt counter on the move_event_utility.
//   - Calls Vapi with the built system prompt and payload.
//   - Inserts a `calls` row with the returned vapi_call_id, linked
//     back to the move_event_utility via (related_table, related_id).
//   - Transitions the move_event_utility.status to 'calling'.
//   - Returns { ok, info? } on success, { ok: false, error } on failure.
async function handleRetryMoveEventUtility(db, payload) {
  const moveEventUtilityId = payload?.moveEventUtilityId;
  if (!moveEventUtilityId) {
    return { ok: false, error: 'Missing moveEventUtilityId in payload' };
  }

  // One joined read to pull everything we need for the prompt.
  // Drizzle doesn't have a single-call joined-select builder for this
  // many tables — use raw SQL for clarity.
  const rows = await db.execute(sql`
    SELECT
      meu.id                    AS meu_id,
      meu.action                AS meu_action,
      meu.status                AS meu_status,
      meu.attempts              AS meu_attempts,
      meu.max_attempts          AS meu_max_attempts,
      me.id                     AS me_id,
      me.event_type             AS me_event_type,
      me.effective_date         AS me_effective_date,
      me.tenant_display_name    AS me_tenant_name,
      me.status                 AS me_status,
      me.organization_id        AS me_org_id,
      p.id                      AS p_id,
      p.display_name            AS p_display_name,
      p.service_address_line1   AS p_street,
      p.service_city            AS p_city,
      p.service_state           AS p_state,
      p.service_zip             AS p_zip,
      pu.utility_type           AS pu_utility_type,
      pu.account_holder         AS pu_account_holder,
      up.id                     AS up_id,
      up.name                   AS up_name,
      up.phone_number           AS up_phone,
      o.legal_name              AS o_legal_name,
      o.authorized_callers      AS o_authorized_callers
    FROM move_event_utilities meu
    INNER JOIN move_events me          ON me.id = meu.move_event_id
    INNER JOIN property_utilities pu   ON pu.id = meu.property_utility_id
    INNER JOIN properties p            ON p.id = me.property_id
    INNER JOIN owners o                ON o.id = p.owner_id
    LEFT  JOIN utility_providers up    ON up.id = pu.provider_id
    WHERE meu.id = ${moveEventUtilityId}
    LIMIT 1
  `);

  const row = Array.isArray(rows) ? rows[0] : rows?.rows?.[0];
  if (!row) {
    return { ok: false, error: `move_event_utility ${moveEventUtilityId} not found` };
  }

  // If the row has already moved to a terminal or in-flight state,
  // bail out rather than firing another call. Protects against
  // double-runs from retry tasks stacking up.
  if (['completed', 'failed', 'needs_human', 'calling'].includes(row.meu_status)) {
    return {
      ok: true,
      info: `move_event_utility already in state '${row.meu_status}' — skipping`,
    };
  }

  if (row.meu_attempts >= row.meu_max_attempts) {
    // Out of retries — escalate.
    await db
      .update(schema.moveEventUtilities)
      .set({
        status: 'needs_human',
        notes: sql`coalesce(notes, '') || E'\n[cron] Max attempts exhausted — escalated.'`,
        updatedAt: new Date(),
      })
      .where(eq(schema.moveEventUtilities.id, moveEventUtilityId));
    return {
      ok: true,
      info: `Max attempts (${row.meu_max_attempts}) exhausted — transitioned to needs_human`,
    };
  }

  // Skip if the provider has no phone number on file. Escalate so a
  // human can either set the provider or handle the call manually.
  if (!row.up_phone) {
    await db
      .update(schema.moveEventUtilities)
      .set({
        status: 'needs_human',
        notes: sql`coalesce(notes, '') || E'\n[cron] No provider phone on file.'`,
        updatedAt: new Date(),
      })
      .where(eq(schema.moveEventUtilities.id, moveEventUtilityId));
    return { ok: false, error: 'Provider has no phone number configured' };
  }

  // Parse authorized_callers jsonb to pull the first name on file.
  let authorizedCallerName = null;
  try {
    const callers = row.o_authorized_callers;
    if (Array.isArray(callers) && callers.length > 0 && callers[0].name) {
      authorizedCallerName = callers[0].name;
    }
  } catch {
    // ignore — authorizedCallerName stays null
  }

  const serviceAddress =
    `${row.p_street}, ${row.p_city}, ${row.p_state} ${row.p_zip}`.trim();
  const effectiveDate = row.me_effective_date
    ? new Date(row.me_effective_date).toLocaleDateString('en-US', {
        year: 'numeric',
        month: 'long',
        day: 'numeric',
      })
    : 'the agreed date';

  // Fire the Vapi call.
  const callResult = await placeUtilityCall({
    action: row.meu_action,
    utilityType: row.pu_utility_type,
    providerName: row.up_name || 'the utility company',
    providerPhoneE164: row.up_phone,
    llcLegalName: row.o_legal_name,
    authorizedCallerName,
    serviceAddress,
    tenantName: row.me_tenant_name,
    effectiveDate,
  });

  if (!callResult.ok) {
    // Attempt counts against the budget even if the call failed at the
    // Vapi layer — prevents infinite loops on a misconfigured row.
    await db
      .update(schema.moveEventUtilities)
      .set({
        attempts: row.meu_attempts + 1,
        notes: sql`coalesce(notes, '') || E'\n[cron] Vapi error: ' || ${callResult.error || 'unknown'}`,
        updatedAt: new Date(),
      })
      .where(eq(schema.moveEventUtilities.id, moveEventUtilityId));
    return { ok: false, error: callResult.error };
  }

  // Record the call row — webhook will update it on endOfCallReport.
  await db.insert(schema.calls).values({
    organizationId: row.me_org_id,
    purpose: 'move_event_utility',
    relatedTable: 'move_event_utilities',
    relatedId: moveEventUtilityId,
    vapiCallId: callResult.vapiCallId,
    toPhone: row.up_phone,
    status: 'queued',
  });

  // Transition the move_event_utility to 'calling'.
  await db
    .update(schema.moveEventUtilities)
    .set({
      status: 'calling',
      attempts: row.meu_attempts + 1,
      updatedAt: new Date(),
    })
    .where(eq(schema.moveEventUtilities.id, moveEventUtilityId));

  return { ok: true, info: `Vapi call queued: ${callResult.vapiCallId}` };
}

// ── Dispatch table ───────────────────────────────────────────────

const HANDLERS = {
  retry_move_event_utility: handleRetryMoveEventUtility,
};

// ── HTTP handler ─────────────────────────────────────────────────

export default async function handler(req, res) {
  if (!isAuthorizedCron(req)) {
    return res.status(401).json({ ok: false, error: 'Unauthorized' });
  }

  const db = getDb();
  const now = new Date();

  // Pull a batch of due tasks and claim them atomically. The claim
  // update returns the claimed rows so we can process them without
  // another round trip. We use raw SQL because Drizzle's query builder
  // doesn't currently expose FOR UPDATE SKIP LOCKED in a subquery-
  // friendly way.
  const claimResult = await db.execute(sql`
    UPDATE tasks
    SET status = 'claimed', updated_at = now()
    WHERE id IN (
      SELECT id FROM tasks
      WHERE status = 'pending'
        AND scheduled_for <= ${now}
      ORDER BY scheduled_for
      LIMIT ${MAX_TASKS_PER_RUN}
      FOR UPDATE SKIP LOCKED
    )
    RETURNING id, kind, payload, attempts
  `);

  const claimed = Array.isArray(claimResult) ? claimResult : claimResult?.rows || [];

  if (claimed.length === 0) {
    return res.status(200).json({ ok: true, processed: 0, message: 'No due tasks' });
  }

  const results = [];
  for (const task of claimed) {
    const handler = HANDLERS[task.kind];
    if (!handler) {
      await db
        .update(schema.tasks)
        .set({
          status: 'failed',
          lastError: `Unknown task kind: ${task.kind}`,
          attempts: (task.attempts || 0) + 1,
          updatedAt: new Date(),
        })
        .where(eq(schema.tasks.id, task.id));
      results.push({ id: task.id, kind: task.kind, ok: false, error: 'Unknown kind' });
      continue;
    }

    try {
      const handlerRes = await handler(db, task.payload || {});
      if (handlerRes.ok) {
        await db
          .update(schema.tasks)
          .set({
            status: 'completed',
            attempts: (task.attempts || 0) + 1,
            updatedAt: new Date(),
          })
          .where(eq(schema.tasks.id, task.id));
        results.push({ id: task.id, kind: task.kind, ok: true, info: handlerRes.info });
      } else {
        await db
          .update(schema.tasks)
          .set({
            status: 'failed',
            lastError: handlerRes.error || 'Unknown error',
            attempts: (task.attempts || 0) + 1,
            updatedAt: new Date(),
          })
          .where(eq(schema.tasks.id, task.id));
        results.push({ id: task.id, kind: task.kind, ok: false, error: handlerRes.error });
      }
    } catch (err) {
      console.error(`[cron] handler threw for task ${task.id}:`, err);
      await db
        .update(schema.tasks)
        .set({
          status: 'failed',
          lastError: err.message || String(err),
          attempts: (task.attempts || 0) + 1,
          updatedAt: new Date(),
        })
        .where(eq(schema.tasks.id, task.id));
      results.push({ id: task.id, kind: task.kind, ok: false, error: err.message });
    }
  }

  return res.status(200).json({
    ok: true,
    processed: results.length,
    results,
  });
}
