// GET /api/admin/recent-errors?secret=<TOKEN>&limit=20&since_minutes=60
//
// Returns the most recent admin_error_log entries with full stack
// traces. Powers the GitHub Actions `tail-errors` workflow — the
// dev/ops loop reads these instead of digging through Vercel function
// logs or screenshot-passing.
//
// Query params:
//   limit          — number of rows to return (default 20, max 200)
//   since_minutes  — only return rows newer than N minutes (default 1440 = 24h)
//   path_contains  — case-insensitive substring filter on `path`
//
// Response:
//   { ok: true, count: N, errors: [{...}, ...] }

import { desc, gte, ilike, and } from 'drizzle-orm';
import { withAdminHandler } from '../../lib/adminHelpers.js';
import { getDb, schema } from '../../lib/db/index.js';

export const config = { maxDuration: 30 };

export default withAdminHandler(async (req, res) => {
  if (req.method !== 'GET' && req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'GET or POST only' });
  }

  const limit = Math.min(Math.max(Number(req.query?.limit) || 20, 1), 200);
  const sinceMinutes = Math.min(Math.max(Number(req.query?.since_minutes) || 1440, 1), 60 * 24 * 30);
  const pathContains = req.query?.path_contains || null;

  const sinceDate = new Date(Date.now() - sinceMinutes * 60 * 1000);

  const conditions = [gte(schema.adminErrorLog.createdAt, sinceDate)];
  if (pathContains) {
    conditions.push(ilike(schema.adminErrorLog.path, `%${pathContains}%`));
  }

  const db = getDb();
  const rows = await db
    .select({
      id: schema.adminErrorLog.id,
      createdAt: schema.adminErrorLog.createdAt,
      path: schema.adminErrorLog.path,
      method: schema.adminErrorLog.method,
      status: schema.adminErrorLog.status,
      message: schema.adminErrorLog.message,
      stack: schema.adminErrorLog.stack,
      context: schema.adminErrorLog.context,
    })
    .from(schema.adminErrorLog)
    .where(conditions.length === 1 ? conditions[0] : and(...conditions))
    .orderBy(desc(schema.adminErrorLog.createdAt))
    .limit(limit);

  return res.status(200).json({
    ok: true,
    count: rows.length,
    since: sinceDate.toISOString(),
    errors: rows,
  });
});
