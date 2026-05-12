// POST /api/admin/add-ticket-comment?secret=<TOKEN>
// body: {
//   ticket_id:     uuid
//   author_type?:  'staff'|'tenant'|'vendor'|'ai'|'system'  default 'staff'
//   author_display?: string
//   body:          string
//   is_internal?:  boolean  default false (true = staff-only note)
// }

import { and, eq } from 'drizzle-orm';
import {
  withAdminHandler,
  getDefaultOrgId,
  parseBody,
} from '../../lib/adminHelpers.js';
import { getDb, schema } from '../../lib/db/index.js';

const VALID = new Set(['staff', 'tenant', 'vendor', 'ai', 'system']);

export default withAdminHandler(async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'POST only' });
  }
  const body = parseBody(req);
  if (!body.ticket_id) return res.status(400).json({ ok: false, error: 'ticket_id required' });
  if (!body.body || !String(body.body).trim()) {
    return res.status(400).json({ ok: false, error: 'body required' });
  }
  const authorType = body.author_type || 'staff';
  if (!VALID.has(authorType)) {
    return res.status(400).json({ ok: false, error: `author_type must be one of ${Array.from(VALID).join(', ')}` });
  }

  const db = getDb();
  const organizationId = await getDefaultOrgId();

  // Confirm ticket belongs to org.
  const [ticket] = await db
    .select({ id: schema.maintenanceTickets.id })
    .from(schema.maintenanceTickets)
    .where(
      and(
        eq(schema.maintenanceTickets.id, body.ticket_id),
        eq(schema.maintenanceTickets.organizationId, organizationId),
      ),
    )
    .limit(1);
  if (!ticket) return res.status(404).json({ ok: false, error: 'ticket not found' });

  const [comment] = await db
    .insert(schema.maintenanceTicketComments)
    .values({
      organizationId,
      ticketId: body.ticket_id,
      authorType,
      authorDisplay: body.author_display || null,
      body: String(body.body).trim(),
      isInternal: !!body.is_internal,
    })
    .returning({ id: schema.maintenanceTicketComments.id });

  // Bump the ticket's updated_at so list ordering reflects activity.
  await db
    .update(schema.maintenanceTickets)
    .set({ updatedAt: new Date() })
    .where(eq(schema.maintenanceTickets.id, body.ticket_id));

  return res.status(200).json({ ok: true, comment_id: comment.id });
});
