// GET /api/admin/recent-audit?secret=<TOKEN>
//   &limit=20                  (default 20, max 200)
//   &since_minutes=1440        (default 24h, max 30 days)
//   &table=tenants             (optional, filter by target_table)
//   &id=<uuid>                 (optional, filter by target_id)
//   &actor_id=user_xxx         (optional, filter by Clerk userId)
//
// Companion to /api/admin/recent-errors. Where recent-errors shows
// failures, recent-audit shows the trail of intentional state
// changes through every admin endpoint that called recordAudit().
//
// Read-only. Safe to run anytime.

import { desc, and, gte, eq } from 'drizzle-orm';
import { withAdminHandler } from '../../lib/adminHelpers.js';
import { getDb, schema } from '../../lib/db/index.js';

export const config = { maxDuration: 30 };

export default withAdminHandler(async (req, res) => {
  if (req.method !== 'GET' && req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'GET or POST only' });
  }

  const limit = Math.min(Math.max(Number(req.query?.limit) || 20, 1), 200);
  const sinceMinutes = Math.min(
    Math.max(Number(req.query?.since_minutes) || 1440, 1),
    60 * 24 * 30,
  );
  const sinceDate = new Date(Date.now() - sinceMinutes * 60 * 1000);

  const conditions = [gte(schema.adminAuditLog.createdAt, sinceDate)];
  if (req.query?.table) {
    conditions.push(eq(schema.adminAuditLog.targetTable, String(req.query.table)));
  }
  if (req.query?.id) {
    conditions.push(eq(schema.adminAuditLog.targetId, String(req.query.id)));
  }
  if (req.query?.actor_id) {
    conditions.push(eq(schema.adminAuditLog.actorId, String(req.query.actor_id)));
  }

  const db = getDb();
  const rows = await db
    .select({
      id: schema.adminAuditLog.id,
      createdAt: schema.adminAuditLog.createdAt,
      actorType: schema.adminAuditLog.actorType,
      actorId: schema.adminAuditLog.actorId,
      path: schema.adminAuditLog.path,
      method: schema.adminAuditLog.method,
      action: schema.adminAuditLog.action,
      targetTable: schema.adminAuditLog.targetTable,
      targetId: schema.adminAuditLog.targetId,
      before: schema.adminAuditLog.before,
      after: schema.adminAuditLog.after,
      diff: schema.adminAuditLog.diff,
      ipAddress: schema.adminAuditLog.ipAddress,
      userAgent: schema.adminAuditLog.userAgent,
      context: schema.adminAuditLog.context,
    })
    .from(schema.adminAuditLog)
    .where(conditions.length === 1 ? conditions[0] : and(...conditions))
    .orderBy(desc(schema.adminAuditLog.createdAt))
    .limit(limit);

  return res.status(200).json({
    ok: true,
    count: rows.length,
    since: sinceDate.toISOString(),
    entries: rows,
  });
});
