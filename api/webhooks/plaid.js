// POST /api/webhooks/plaid
//
// Plaid webhook receiver. Registered in the Plaid Dashboard under
// "Production / Webhook URL". Plaid posts JSON events here as
// item lifecycle changes happen — transactions ready, item errored,
// user revoked permission, etc.
//
// Webhook shape (https://plaid.com/docs/api/webhooks/):
//   {
//     webhook_type: "TRANSACTIONS" | "ITEM" | ...
//     webhook_code: "SYNC_UPDATES_AVAILABLE" | "ERROR" | "PENDING_EXPIRATION" |
//                   "USER_PERMISSION_REVOKED" | "WEBHOOK_UPDATE_ACKNOWLEDGED" | ...
//     item_id:      "<plaid_item_id>"
//     error?:       { error_code, error_message, ... }
//     new_transactions?: number
//   }
//
// What we do per event:
//   SYNC_UPDATES_AVAILABLE  Log + audit. Don't trigger sync inline
//                           — Vercel function timeout is short. A
//                           cron or manual sync handles the pull.
//   ERROR / ITEM_LOGIN_REQUIRED
//     → bank_account.plaid_status = 're_auth_required'
//   PENDING_EXPIRATION      Log + audit (status change happens at
//                           actual expiry, on next sync attempt).
//   USER_PERMISSION_REVOKED → bank_account.plaid_status = 'disconnected'
//   WEBHOOK_UPDATE_ACKNOWLEDGED  Log only.
//   *                       Log unknown event types so we notice if
//                           Plaid ships a new code we should handle.
//
// Plaid retries on non-2xx, so we always return 200 even on
// internal errors after logging.
//
// JWT signature verification is a TODO before going live. Plaid
// signs every webhook; verifying the signature blocks spoofed
// events. For now we log a warning and accept everything — fine
// for sandbox, must be added before flipping PLAID_ENV=production.

import { eq } from 'drizzle-orm';
import { getDb, schema } from '../../lib/db/index.js';

// Read raw body from a Node request stream (Vercel sometimes hands
// us a parsed body, sometimes the raw stream; handle both).
async function readBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  if (typeof req.body === 'string') {
    try { return JSON.parse(req.body); } catch { return {}; }
  }
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw) return {};
  try { return JSON.parse(raw); } catch { return {}; }
}

async function logAudit(db, organizationId, subjectId, eventType, payload) {
  if (!organizationId || !subjectId) return;
  try {
    await db.insert(schema.auditEvents).values({
      organizationId,
      actorType: 'plaid_webhook',
      actorId: null,
      subjectTable: 'bank_accounts',
      subjectId,
      eventType,
      beforeState: null,
      afterState: payload,
    });
  } catch (err) {
    console.error('plaid webhook: audit log failed', err);
  }
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'POST only' });
  }

  if (!req.headers['plaid-verification']) {
    console.warn('plaid webhook: missing Plaid-Verification header (signature check pending)');
  }

  let body;
  try {
    body = await readBody(req);
  } catch (err) {
    console.error('plaid webhook: body parse failed', err);
    return res.status(200).json({ ok: true, ignored: 'parse_failed' });
  }

  const { webhook_type, webhook_code, item_id } = body || {};
  if (!webhook_type || !webhook_code) {
    console.warn('plaid webhook: missing webhook_type/code', body);
    return res.status(200).json({ ok: true, ignored: 'missing_fields' });
  }

  console.log(`plaid webhook: ${webhook_type}/${webhook_code} item=${item_id || '(none)'}`);

  // No item_id means it's an account-level webhook (rare for what we
  // use) — ack and move on.
  if (!item_id) {
    return res.status(200).json({ ok: true, acked: true });
  }

  const db = getDb();
  // Find every bank_account in this item. Plaid items are 1:N with
  // accounts; multiple bank_accounts can share a plaid_item_id.
  const banks = await db
    .select({
      id: schema.bankAccounts.id,
      organizationId: schema.bankAccounts.organizationId,
      currentStatus: schema.bankAccounts.plaidStatus,
    })
    .from(schema.bankAccounts)
    .where(eq(schema.bankAccounts.plaidItemId, item_id));

  if (banks.length === 0) {
    console.warn(`plaid webhook: no bank_accounts for item ${item_id}`);
    return res.status(200).json({ ok: true, ignored: 'unknown_item' });
  }

  // Decide what to do.
  let newStatus = null;
  let eventLabel = `${webhook_type}/${webhook_code}`;

  if (webhook_type === 'ITEM') {
    if (webhook_code === 'ERROR') {
      const errorCode = body.error?.error_code;
      if (errorCode === 'ITEM_LOGIN_REQUIRED') {
        newStatus = 're_auth_required';
      }
    } else if (webhook_code === 'PENDING_EXPIRATION') {
      // Not flipped to re_auth_required yet — Plaid signals it's
      // coming, sync will detect actual expiry. Just log.
    } else if (webhook_code === 'USER_PERMISSION_REVOKED') {
      newStatus = 'disconnected';
    }
  }
  // TRANSACTIONS/SYNC_UPDATES_AVAILABLE et al: no status change.
  // A cron or manual sync picks up new transactions.

  if (newStatus) {
    await db
      .update(schema.bankAccounts)
      .set({ plaidStatus: newStatus, updatedAt: new Date() })
      .where(eq(schema.bankAccounts.plaidItemId, item_id));
  }

  for (const b of banks) {
    await logAudit(db, b.organizationId, b.id, `plaid_webhook_${webhook_code.toLowerCase()}`, {
      webhook_type,
      webhook_code,
      error: body.error || null,
      new_transactions: body.new_transactions ?? null,
      status_change: newStatus ? { from: b.currentStatus, to: newStatus } : null,
    });
  }

  return res.status(200).json({
    ok: true,
    item_id,
    event: eventLabel,
    banks_affected: banks.length,
    status_updated: newStatus,
  });
}
