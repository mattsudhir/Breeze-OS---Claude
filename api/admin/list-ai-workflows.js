// GET /api/admin/list-ai-workflows?secret=<TOKEN>
//
// Returns every ai_workflow for the org plus the org-level default
// autonomy. Drives the AI Agents UI.

import { eq } from 'drizzle-orm';
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

  const [org] = await db
    .select({
      defaultAutonomy: schema.organizations.aiDefaultAutonomyLevel,
    })
    .from(schema.organizations)
    .where(eq(schema.organizations.id, organizationId))
    .limit(1);

  const rows = await db
    .select()
    .from(schema.aiWorkflows)
    .where(eq(schema.aiWorkflows.organizationId, organizationId))
    .orderBy(schema.aiWorkflows.name);

  return res.status(200).json({
    ok: true,
    organization_id: organizationId,
    default_autonomy_level: org?.defaultAutonomy || 'approve_before_action',
    count: rows.length,
    workflows: rows.map((w) => ({
      id: w.id,
      slug: w.slug,
      name: w.name,
      description: w.description,
      channel: w.channel,
      direction: w.direction,
      vapi_assistant_id: w.vapiAssistantId,
      trigger_type: w.triggerType,
      trigger_config: w.triggerConfig,
      autonomy_level: w.autonomyLevel,
      // effective_autonomy is what the dispatcher actually uses.
      effective_autonomy_level: w.autonomyLevel || org?.defaultAutonomy || 'approve_before_action',
      is_active: w.isActive,
      notes: w.notes,
      created_at: w.createdAt,
      updated_at: w.updatedAt,
    })),
  });
});
