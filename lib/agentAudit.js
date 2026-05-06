// AI agent audit logger.
//
// One row written per tool invocation in lib/breezeAgent.js's
// runAgent loop, plus any other surface that calls executeTool. The
// log captures input, output, success, timing, and a handful of
// denormalised AppFolio reference IDs for fast "all actions on
// tenant X" / "audit trail for charge Y" lookups.
//
// Design notes:
// - logAgentAction is fire-and-forget from the caller's POV: it
//   never throws, never blocks the agent loop. Audit failures log a
//   console.warn and otherwise stay silent. We'd rather lose an
//   audit row than break a charge_tenant call.
// - JSONB payloads are stored verbatim, including potentially-
//   sensitive fields (full tenant records, phone numbers). Apply
//   row-level access in the UI; the audit table is an internal
//   forensic surface, not a tenant-facing one.
// - Denormalised id extraction is best-effort. If we miss a field
//   we'll still have it in tool_input / tool_output JSONB and can
//   backfill the column with a one-shot UPDATE.

import { getDb, schema } from './db/index.js';
import { getDefaultOrgId } from './adminHelpers.js';

// Set of known AppFolio-id fields we recognise on inputs and outputs.
// Each maps to the column on agent_actions where it's denormalised.
const ID_FIELDS = {
  tenant_id: 'appfolioTenantId',
  occupancy_id: 'appfolioOccupancyId',
  property_id: 'appfolioPropertyId',
  unit_id: 'appfolioUnitId',
  charge_id: 'appfolioChargeId',
  work_order_id: 'appfolioWorkOrderId',
};

// Walk an object (one level) for any of the known id fields and
// return a flat { appfolioTenantId, ... } subset. Both input and
// output may contain different ones — we union them on write.
function pickAppfolioIds(payload) {
  if (!payload || typeof payload !== 'object') return {};
  const out = {};
  for (const [src, dst] of Object.entries(ID_FIELDS)) {
    const v = payload[src];
    if (typeof v === 'string' && v.length > 0) out[dst] = v;
  }
  return out;
}

/**
 * Record one tool call in agent_actions.
 *
 * Required:
 *   surface       — 'chat' | 'cliq' | 'cron' | 'webhook'
 *   toolName      — e.g. 'charge_tenant'
 *   toolInput     — raw input object passed to the tool
 *   toolOutput    — raw return value (or null on throw)
 *   success       — boolean
 *   durationMs    — wall-clock time the tool took
 *
 * Optional:
 *   userId          — actor identifier if known
 *   conversationId  — string to group calls from the same chat session
 *   backendName     — 'appfolio' | 'rm-demo' | 'breeze' | 'zoho-mcp'
 *   errorText       — when success is false; if omitted and
 *                     toolOutput.error exists, that's used
 */
export async function logAgentAction({
  surface,
  toolName,
  toolInput,
  toolOutput,
  success,
  durationMs,
  userId = null,
  conversationId = null,
  backendName = null,
  errorText = null,
}) {
  try {
    if (!surface || !toolName) return; // bad call — skip silently

    const errText =
      errorText ||
      (toolOutput && typeof toolOutput === 'object' && toolOutput.error
        ? String(toolOutput.error).slice(0, 2000)
        : null);

    const ids = {
      ...pickAppfolioIds(toolInput),
      ...pickAppfolioIds(toolOutput),
    };

    const db = getDb();
    const organizationId = await getDefaultOrgId();

    await db.insert(schema.agentActions).values({
      organizationId,
      surface,
      userId,
      conversationId,
      backendName,
      toolName,
      toolInput: toolInput ?? {},
      toolOutput: toolOutput ?? null,
      success: !!success,
      errorText: errText,
      durationMs: Math.max(0, Math.round(durationMs || 0)),
      appfolioTenantId: ids.appfolioTenantId || null,
      appfolioOccupancyId: ids.appfolioOccupancyId || null,
      appfolioPropertyId: ids.appfolioPropertyId || null,
      appfolioUnitId: ids.appfolioUnitId || null,
      appfolioChargeId: ids.appfolioChargeId || null,
      appfolioWorkOrderId: ids.appfolioWorkOrderId || null,
    });
  } catch (err) {
    // Never throw out of an audit logger — the agent loop has to
    // keep running even if the DB is down. A console.warn surfaces
    // the issue in Vercel logs without affecting the user.
    console.warn('[agentAudit] failed to log action:', err?.message || err);
  }
}
