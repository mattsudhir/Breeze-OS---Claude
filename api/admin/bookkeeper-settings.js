// GET  /api/admin/bookkeeper-settings?secret=<TOKEN>
//   Returns the org's bookkeeper_review_location setting.
//
// POST /api/admin/bookkeeper-settings?secret=<TOKEN>
//   body: { bookkeeper_review_location: 'breeze' | 'bill_com' | 'both' }

import { eq } from 'drizzle-orm';
import {
  withAdminHandler,
  getDefaultOrgId,
  parseBody,
} from '../../lib/adminHelpers.js';
import { getDb, schema } from '../../lib/db/index.js';

const VALID = new Set(['breeze', 'bill_com', 'both']);

export default withAdminHandler(async (req, res) => {
  if (req.method !== 'GET' && req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'GET or POST only' });
  }
  const db = getDb();
  const organizationId = await getDefaultOrgId();

  if (req.method === 'POST') {
    const body = parseBody(req);
    if (!VALID.has(body.bookkeeper_review_location)) {
      return res.status(400).json({
        ok: false,
        error: `bookkeeper_review_location must be one of ${Array.from(VALID).join(', ')}`,
      });
    }
    await db
      .update(schema.organizations)
      .set({
        bookkeeperReviewLocation: body.bookkeeper_review_location,
        updatedAt: new Date(),
      })
      .where(eq(schema.organizations.id, organizationId));
  }

  const [org] = await db
    .select({ location: schema.organizations.bookkeeperReviewLocation })
    .from(schema.organizations)
    .where(eq(schema.organizations.id, organizationId))
    .limit(1);

  return res.status(200).json({
    ok: true,
    organization_id: organizationId,
    bookkeeper_review_location: org?.location || 'breeze',
  });
});
