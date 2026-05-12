// GET /api/admin/list-message-threads?secret=<TOKEN>&filter=all|unmatched|paused|active
//
// Drives the unified Inbox UI. Threads ordered by last_message_at DESC
// with tenant name + unread count + last message snippet.

import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import {
  withAdminHandler,
  getDefaultOrgId,
} from '../../lib/adminHelpers.js';
import { getDb, schema } from '../../lib/db/index.js';

export default withAdminHandler(async (req, res) => {
  if (req.method !== 'GET') {
    return res.status(405).json({ ok: false, error: 'GET only' });
  }
  const db = getDb();
  const organizationId = await getDefaultOrgId();
  const filter = req.query?.filter || 'all';
  const limit = Math.min(Math.max(parseInt(req.query?.limit, 10) || 100, 1), 500);

  const whereClauses = [eq(schema.messageThreads.organizationId, organizationId)];
  if (filter === 'unmatched') whereClauses.push(isNull(schema.messageThreads.tenantId));
  if (filter === 'paused') whereClauses.push(eq(schema.messageThreads.staffPaused, true));
  if (filter === 'active') whereClauses.push(eq(schema.messageThreads.staffPaused, false));

  const rows = await db
    .select({
      id: schema.messageThreads.id,
      tenantId: schema.messageThreads.tenantId,
      propertyId: schema.messageThreads.propertyId,
      subject: schema.messageThreads.subject,
      lastMessageAt: schema.messageThreads.lastMessageAt,
      staffPaused: schema.messageThreads.staffPaused,
      fromPhoneNumberId: schema.messageThreads.fromPhoneNumberId,
      tenantName: schema.tenants.displayName,
      fromPhone: schema.phoneNumbers.e164Number,
      messageCount: sql`(SELECT COUNT(*) FROM ${schema.messages} WHERE ${schema.messages.threadId} = ${schema.messageThreads.id})`.as('message_count'),
      lastBody: sql`(SELECT ${schema.messages.body} FROM ${schema.messages} WHERE ${schema.messages.threadId} = ${schema.messageThreads.id} ORDER BY ${schema.messages.createdAt} DESC LIMIT 1)`.as('last_body'),
      lastDirection: sql`(SELECT ${schema.messages.direction} FROM ${schema.messages} WHERE ${schema.messages.threadId} = ${schema.messageThreads.id} ORDER BY ${schema.messages.createdAt} DESC LIMIT 1)`.as('last_direction'),
    })
    .from(schema.messageThreads)
    .leftJoin(schema.tenants, eq(schema.messageThreads.tenantId, schema.tenants.id))
    .leftJoin(schema.phoneNumbers, eq(schema.messageThreads.fromPhoneNumberId, schema.phoneNumbers.id))
    .where(and(...whereClauses))
    .orderBy(desc(schema.messageThreads.lastMessageAt))
    .limit(limit);

  return res.status(200).json({
    ok: true,
    organization_id: organizationId,
    count: rows.length,
    threads: rows.map((r) => ({
      id: r.id,
      tenant_id: r.tenantId,
      tenant_name: r.tenantName,
      property_id: r.propertyId,
      subject: r.subject,
      last_message_at: r.lastMessageAt,
      staff_paused: r.staffPaused,
      from_phone: r.fromPhone,
      message_count: Number(r.messageCount),
      last_body: r.lastBody,
      last_direction: r.lastDirection,
      is_unmatched: !r.tenantId,
    })),
  });
});
