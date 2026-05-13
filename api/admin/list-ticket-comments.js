// GET /api/admin/list-ticket-comments?secret=<TOKEN>&ticket_id=<uuid>
//
// Returns all comments on a ticket, oldest first.

import { and, asc, eq } from 'drizzle-orm';
import {
  withAdminHandler,
  getDefaultOrgId,
} from '../../lib/adminHelpers.js';
import { getDb, schema } from '../../lib/db/index.js';

export default withAdminHandler(async (req, res) => {
  if (req.method !== 'GET') {
    return res.status(405).json({ ok: false, error: 'GET only' });
  }
  const ticketId = req.query?.ticket_id;
  if (!ticketId) return res.status(400).json({ ok: false, error: 'ticket_id required' });

  const db = getDb();
  const organizationId = await getDefaultOrgId();

  const rows = await db
    .select()
    .from(schema.maintenanceTicketComments)
    .where(
      and(
        eq(schema.maintenanceTicketComments.ticketId, ticketId),
        eq(schema.maintenanceTicketComments.organizationId, organizationId),
      ),
    )
    .orderBy(asc(schema.maintenanceTicketComments.createdAt));

  return res.status(200).json({
    ok: true,
    organization_id: organizationId,
    count: rows.length,
    comments: rows.map((c) => ({
      id: c.id,
      ticket_id: c.ticketId,
      author_type: c.authorType,
      author_id: c.authorId,
      author_display: c.authorDisplay,
      body: c.body,
      is_internal: c.isInternal,
      created_at: c.createdAt,
    })),
  });
});
