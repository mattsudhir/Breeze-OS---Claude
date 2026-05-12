// GET / POST /api/admin/ai-settings?secret=<TOKEN>
//
// Org-level AI autonomy default.
//
// POST body: { default_autonomy_level: <enum value> }

import { eq } from 'drizzle-orm';
import {
  withAdminHandler,
  getDefaultOrgId,
  parseBody,
} from '../../lib/adminHelpers.js';
import { getDb, schema } from '../../lib/db/index.js';

const VALID_AUTONOMY = new Set([
  'draft_only',
  'approve_before_contact',
  'approve_before_action',
  'notify_only',
  'full',
]);

export default withAdminHandler(async (req, res) => {
  if (req.method !== 'GET' && req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'GET or POST only' });
  }
  const db = getDb();
  const organizationId = await getDefaultOrgId();

  if (req.method === 'POST') {
    const body = parseBody(req);
    if (!body.default_autonomy_level || !VALID_AUTONOMY.has(body.default_autonomy_level)) {
      return res.status(400).json({
        ok: false,
        error: `default_autonomy_level must be one of ${Array.from(VALID_AUTONOMY).join(', ')}`,
      });
    }
    await db
      .update(schema.organizations)
      .set({
        aiDefaultAutonomyLevel: body.default_autonomy_level,
        updatedAt: new Date(),
      })
      .where(eq(schema.organizations.id, organizationId));
  }

  const [org] = await db
    .select({ defaultAutonomy: schema.organizations.aiDefaultAutonomyLevel })
    .from(schema.organizations)
    .where(eq(schema.organizations.id, organizationId))
    .limit(1);

  return res.status(200).json({
    ok: true,
    organization_id: organizationId,
    default_autonomy_level: org?.defaultAutonomy || 'approve_before_action',
  });
});
