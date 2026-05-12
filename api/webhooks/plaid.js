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
import { verifyPlaidWebhook } from '../../lib/backends/plaid.js';

// Vercel auto-parses application/json bodies before our handler
// runs, which throws away the raw bytes we need to compute the
// signature hash. Disable that so we can read the request as a
// stream and verify the signature against the exact bytes Plaid sent.
export const config = {
  api: { bodyParser: false },
};

// Read the request as a Buffer + UTF-8 string. Plaid hashes the raw
// bytes; we need both the bytes (for the hash) and a parsed JSON
// (for the handler logic).
async function readRawAndParsed(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks);
  const text = raw.toString('utf8');
  let parsed = {};
  if (text) {
    try { parsed = JSON.parse(text); } catch { parsed = {}; }
  }
  return { raw, text, parsed };
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

  // Read raw body first — needed for signature verification.
  let raw;
  let body;
  try {
    const parsed = await readRawAndParsed(req);
    raw = parsed.text;
    body = parsed.parsed;
  } catch (err) {
    console.error('plaid webhook: body read failed', err);
    return res.status(200).json({ ok: true, ignored: 'body_read_failed' });
  }

  // Verify signature. In production this MUST pass; in sandbox we
  // accept unsigned payloads (Plaid's sandbox doesn't always sign).
  // Mode controlled by PLAID_WEBHOOK_VERIFY_REQUIRED env var:
  //   true (default for production)  → reject unsigned/invalid
  //   false                          → log warning + continue
  const plaidVerificationHeader = req.headers['plaid-verification'];
  const verifyRequired =
    process.env.PLAID_WEBHOOK_VERIFY_REQUIRED === 'true' ||
    process.env.PLAID_ENV === 'production';

  if (plaidVerificationHeader) {
    const verifyResult = await verifyPlaidWebhook({
      jwtHeader: plaidVerificationHeader,
      rawBody: raw,
    });
    if (!verifyResult.valid) {
      if (verifyRequired) {
        console.error(`plaid webhook: signature INVALID (${verifyResult.reason}) — rejecting`);
        return res.status(200).json({
          ok: true,
          ignored: 'signature_invalid',
          reason: verifyResult.reason,
        });
      }
      console.warn(`plaid webhook: signature invalid in non-required mode (${verifyResult.reason}) — continuing`);
    }
  } else if (verifyRequired) {
    console.error('plaid webhook: missing Plaid-Verification header in required mode — rejecting');
    return res.status(200).json({
      ok: true,
      ignored: 'missing_signature_header',
    });
  } else {
    console.warn('plaid webhook: missing Plaid-Verification header (sandbox mode — continuing)');
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
