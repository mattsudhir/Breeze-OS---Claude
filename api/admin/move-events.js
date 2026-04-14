// Vercel Serverless Function — CRUD for move_events + auto-derive
// the utility action list from the property's configured utilities.
//
// GET    /api/admin/move-events                — list all
// GET    /api/admin/move-events?id=<uuid>      — fetch one + utilities
// POST   /api/admin/move-events                — create + auto-derive
// PATCH  /api/admin/move-events?id=<uuid>      — update status/notes
// DELETE /api/admin/move-events?id=<uuid>      — cancel + delete
//
// On POST create, we:
//   1. Insert the move_events row.
//   2. Read the property's property_utilities config.
//   3. For each utility where account_holder='tenant', create a
//      move_event_utilities row:
//        - Move-in  → action='verify_off_llc'
//        - Move-out → action='transfer_to_llc'
//   4. For each created row, insert a `tasks` row with
//        kind='retry_move_event_utility', scheduled_for=now
//      so the cron picks it up on the next tick.
//
// Rows where account_holder is 'owner_llc' or 'none' produce no
// utility action — LLC already holds the account, or the utility
// doesn't exist at the property.

import { and, eq, desc } from 'drizzle-orm';
import { getDb, schema } from '../../lib/db/index.js';
import {
  withAdminHandler,
  getDefaultOrgId,
  parseBody,
} from '../../lib/adminHelpers.js';

const EDITABLE_FIELDS = [
  'propertyId',
  'sourceTenantId',
  'tenantDisplayName',
  'eventType',
  'effectiveDate',
  'notes',
];

const PATCHABLE_FIELDS = ['status', 'notes'];

function pickFields(body, whitelist) {
  const out = {};
  for (const k of whitelist) {
    if (body[k] !== undefined) out[k] = body[k];
  }
  return out;
}

// Given a property's utility config, decide which utilities need a
// workflow action for a move event of the given type. Returns an
// array of { propertyUtilityId, action }.
function deriveUtilityActions(propertyUtilityRows, eventType) {
  const out = [];
  for (const pu of propertyUtilityRows) {
    // Skip LLC-held and not-applicable utilities — no call needed.
    if (pu.accountHolder !== 'tenant') continue;

    if (eventType === 'move_in') {
      // Tenant was supposed to switch it into their own name. Verify
      // the utility is now OFF our LLC.
      out.push({ propertyUtilityId: pu.id, action: 'verify_off_llc' });
    } else if (eventType === 'move_out') {
      // Tenant is leaving. Transfer the utility back into the LLC's
      // name so service continues uninterrupted for the next tenant
      // or vacancy period.
      out.push({ propertyUtilityId: pu.id, action: 'transfer_to_llc' });
    }
  }
  return out;
}

export default withAdminHandler(async (req, res) => {
  const db = getDb();
  const orgId = await getDefaultOrgId();
  const id = req.query?.id || null;

  // ── GET ───────────────────────────────────────────────────────
  if (req.method === 'GET') {
    if (id) {
      const rows = await db
        .select()
        .from(schema.moveEvents)
        .where(eq(schema.moveEvents.id, id))
        .limit(1);
      if (rows.length === 0) {
        return res.status(404).json({ ok: false, error: 'Move event not found' });
      }
      const event = rows[0];

      // Pull the utility rows + a small projection of each call
      // that's been placed for them.
      const utilities = await db
        .select()
        .from(schema.moveEventUtilities)
        .where(eq(schema.moveEventUtilities.moveEventId, id));

      // Fetch calls for all utility ids in one shot.
      const utilityIds = utilities.map((u) => u.id);
      let calls = [];
      if (utilityIds.length > 0) {
        calls = await db
          .select({
            id: schema.calls.id,
            relatedId: schema.calls.relatedId,
            vapiCallId: schema.calls.vapiCallId,
            toPhone: schema.calls.toPhone,
            status: schema.calls.status,
            outcome: schema.calls.outcome,
            startedAt: schema.calls.startedAt,
            endedAt: schema.calls.endedAt,
            durationSeconds: schema.calls.durationSeconds,
            transcript: schema.calls.transcript,
            recordingUrl: schema.calls.recordingUrl,
            createdAt: schema.calls.createdAt,
          })
          .from(schema.calls)
          .where(eq(schema.calls.relatedTable, 'move_event_utilities'));
        // Filter in JS — the relatedTable eq on the server side
        // plus a JS .filter on relatedId keeps the query simple
        // without a big IN clause per fetch.
        calls = calls.filter((c) => utilityIds.includes(c.relatedId));
      }

      return res.status(200).json({
        ok: true,
        event,
        utilities,
        calls,
      });
    }

    // List mode — newest first.
    const events = await db
      .select()
      .from(schema.moveEvents)
      .where(eq(schema.moveEvents.organizationId, orgId))
      .orderBy(desc(schema.moveEvents.createdAt))
      .limit(200);
    return res.status(200).json({ ok: true, count: events.length, events });
  }

  // ── POST (create + derive + enqueue tasks) ────────────────────
  if (req.method === 'POST') {
    const body = parseBody(req);
    const fields = pickFields(body, EDITABLE_FIELDS);

    if (!fields.propertyId || !fields.eventType || !fields.effectiveDate) {
      return res.status(400).json({
        ok: false,
        error: 'propertyId, eventType, and effectiveDate are required',
      });
    }
    if (!['move_in', 'move_out'].includes(fields.eventType)) {
      return res.status(400).json({
        ok: false,
        error: `eventType must be 'move_in' or 'move_out'`,
      });
    }

    // Coerce effectiveDate to a Date.
    let effectiveDate;
    try {
      effectiveDate = new Date(fields.effectiveDate);
      if (isNaN(effectiveDate.getTime())) throw new Error('bad date');
    } catch {
      return res.status(400).json({
        ok: false,
        error: 'effectiveDate must be a valid ISO 8601 date',
      });
    }

    // Verify the property exists and belongs to this org.
    const propertyRows = await db
      .select({
        id: schema.properties.id,
        displayName: schema.properties.displayName,
      })
      .from(schema.properties)
      .where(
        and(
          eq(schema.properties.id, fields.propertyId),
          eq(schema.properties.organizationId, orgId),
        ),
      )
      .limit(1);
    if (propertyRows.length === 0) {
      return res.status(404).json({ ok: false, error: 'Property not found' });
    }

    // Pull the property's utility config. Derivation reads this.
    const propertyUtilities = await db
      .select()
      .from(schema.propertyUtilities)
      .where(eq(schema.propertyUtilities.propertyId, fields.propertyId));

    const derivedActions = deriveUtilityActions(propertyUtilities, fields.eventType);

    // Wrap create+derive+enqueue in one transaction so partial
    // creation (event created but tasks not enqueued) can't happen.
    let createdEvent;
    let createdUtilities = [];
    let createdTasks = [];

    try {
      await db.transaction(async (tx) => {
        const [event] = await tx
          .insert(schema.moveEvents)
          .values({
            organizationId: orgId,
            propertyId: fields.propertyId,
            sourceTenantId: fields.sourceTenantId || fields.rmTenantId || null,
            tenantDisplayName: fields.tenantDisplayName || null,
            eventType: fields.eventType,
            effectiveDate,
            status: 'pending',
            notes: fields.notes || null,
          })
          .returning();
        createdEvent = event;

        if (derivedActions.length > 0) {
          const utilityRows = derivedActions.map((a) => ({
            moveEventId: event.id,
            propertyUtilityId: a.propertyUtilityId,
            action: a.action,
            status: 'pending',
          }));
          createdUtilities = await tx
            .insert(schema.moveEventUtilities)
            .values(utilityRows)
            .returning();

          // Enqueue one task per utility, scheduled for now so the
          // next cron tick picks them up.
          const taskRows = createdUtilities.map((u) => ({
            organizationId: orgId,
            kind: 'retry_move_event_utility',
            payload: { moveEventUtilityId: u.id },
            scheduledFor: new Date(),
            status: 'pending',
          }));
          createdTasks = await tx
            .insert(schema.tasks)
            .values(taskRows)
            .returning({ id: schema.tasks.id });
        } else {
          // Nothing to do at the utility level — mark the event
          // completed immediately. (Happens when the property has
          // no tenant-held utilities.)
          await tx
            .update(schema.moveEvents)
            .set({ status: 'completed', updatedAt: new Date() })
            .where(eq(schema.moveEvents.id, event.id));
          createdEvent.status = 'completed';
        }

        // Audit.
        await tx.insert(schema.auditEvents).values({
          organizationId: orgId,
          actorType: 'user',
          subjectTable: 'move_events',
          subjectId: event.id,
          eventType: 'created',
          afterState: {
            eventType: fields.eventType,
            propertyId: fields.propertyId,
            effectiveDate: effectiveDate.toISOString(),
            utilitiesDerived: createdUtilities.length,
            tasksEnqueued: createdTasks.length,
          },
        });
      });
    } catch (err) {
      console.error('[move-events POST] transaction failed:', err);
      return res.status(500).json({
        ok: false,
        error: `Move event creation failed: ${err.message}`,
      });
    }

    return res.status(201).json({
      ok: true,
      event: createdEvent,
      utilitiesDerived: createdUtilities.length,
      tasksEnqueued: createdTasks.length,
      utilities: createdUtilities,
    });
  }

  // ── PATCH (status / notes only) ──────────────────────────────
  if (req.method === 'PATCH') {
    if (!id) return res.status(400).json({ ok: false, error: 'id query param required' });
    const body = parseBody(req);
    const patch = pickFields(body, PATCHABLE_FIELDS);
    if (Object.keys(patch).length === 0) {
      return res.status(400).json({ ok: false, error: 'No patchable fields provided' });
    }
    const [updated] = await db
      .update(schema.moveEvents)
      .set({ ...patch, updatedAt: new Date() })
      .where(eq(schema.moveEvents.id, id))
      .returning();
    if (!updated) return res.status(404).json({ ok: false, error: 'Move event not found' });
    return res.status(200).json({ ok: true, event: updated });
  }

  // ── DELETE ───────────────────────────────────────────────────
  if (req.method === 'DELETE') {
    if (!id) return res.status(400).json({ ok: false, error: 'id query param required' });
    const [deleted] = await db
      .delete(schema.moveEvents)
      .where(eq(schema.moveEvents.id, id))
      .returning();
    if (!deleted) return res.status(404).json({ ok: false, error: 'Move event not found' });
    return res.status(200).json({ ok: true, deleted });
  }

  return res.status(405).json({ ok: false, error: 'Method not allowed' });
});
