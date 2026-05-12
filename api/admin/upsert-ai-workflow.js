// POST /api/admin/upsert-ai-workflow?secret=<TOKEN>
// body: {
//   id?:               string  // omit on create
//   slug?:             string  required on create
//   name?:             string  required on create
//   description?:      string
//   channel?:          'sms' | 'email' | 'voice'  required on create
//   direction?:        'inbound' | 'outbound'     required on create
//   vapi_assistant_id?: string | null
//   trigger_type?:     string
//   trigger_config?:   object
//   autonomy_level?:   'draft_only' | 'approve_before_contact' |
//                      'approve_before_action' | 'notify_only' | 'full'
//                      | null (null = inherit org default)
//   is_active?:        boolean
//   notes?:            string
// }
//
// Used by the AI Agents UI to edit workflow settings — most often
// updating vapi_assistant_id (after staff sets up the assistant in
// VAPI's dashboard) or adjusting autonomy_level.

import { and, eq } from 'drizzle-orm';
import {
  withAdminHandler,
  getDefaultOrgId,
  parseBody,
} from '../../lib/adminHelpers.js';
import { getDb, schema } from '../../lib/db/index.js';

const VALID_CHANNELS = new Set(['sms', 'email', 'voice']);
const VALID_DIRECTIONS = new Set(['inbound', 'outbound']);
const VALID_AUTONOMY = new Set([
  'draft_only',
  'approve_before_contact',
  'approve_before_action',
  'notify_only',
  'full',
]);

export default withAdminHandler(async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'POST only' });
  }
  const body = parseBody(req);
  const id = body.id || null;

  if (body.channel !== undefined && !VALID_CHANNELS.has(body.channel)) {
    return res.status(400).json({
      ok: false,
      error: `channel must be one of ${Array.from(VALID_CHANNELS).join(', ')}`,
    });
  }
  if (body.direction !== undefined && !VALID_DIRECTIONS.has(body.direction)) {
    return res.status(400).json({
      ok: false,
      error: `direction must be one of ${Array.from(VALID_DIRECTIONS).join(', ')}`,
    });
  }
  if (body.autonomy_level !== undefined && body.autonomy_level !== null
      && !VALID_AUTONOMY.has(body.autonomy_level)) {
    return res.status(400).json({
      ok: false,
      error: `autonomy_level must be one of ${Array.from(VALID_AUTONOMY).join(', ')} (or null to inherit)`,
    });
  }

  if (!id) {
    if (!body.slug)      return res.status(400).json({ ok: false, error: 'slug required on create' });
    if (!body.name)      return res.status(400).json({ ok: false, error: 'name required on create' });
    if (!body.channel)   return res.status(400).json({ ok: false, error: 'channel required on create' });
    if (!body.direction) return res.status(400).json({ ok: false, error: 'direction required on create' });
  }

  const values = { updatedAt: new Date() };
  if (body.slug !== undefined)              values.slug = String(body.slug).trim();
  if (body.name !== undefined)              values.name = String(body.name).trim();
  if (body.description !== undefined)       values.description = body.description || null;
  if (body.channel !== undefined)           values.channel = body.channel;
  if (body.direction !== undefined)         values.direction = body.direction;
  if (body.vapi_assistant_id !== undefined) values.vapiAssistantId = body.vapi_assistant_id || null;
  if (body.trigger_type !== undefined)      values.triggerType = body.trigger_type || null;
  if (body.trigger_config !== undefined)    values.triggerConfig = body.trigger_config || null;
  if (body.autonomy_level !== undefined)    values.autonomyLevel = body.autonomy_level || null;
  if (body.is_active !== undefined)         values.isActive = !!body.is_active;
  if (body.notes !== undefined)             values.notes = body.notes || null;

  const db = getDb();
  const organizationId = await getDefaultOrgId();

  let result;
  if (id) {
    const updated = await db
      .update(schema.aiWorkflows)
      .set(values)
      .where(
        and(
          eq(schema.aiWorkflows.id, id),
          eq(schema.aiWorkflows.organizationId, organizationId),
        ),
      )
      .returning({ id: schema.aiWorkflows.id });
    if (updated.length === 0) {
      return res.status(404).json({ ok: false, error: 'workflow not found' });
    }
    result = { id: updated[0].id, created: false };
  } else {
    const created = await db
      .insert(schema.aiWorkflows)
      .values({ organizationId, ...values })
      .returning({ id: schema.aiWorkflows.id });
    result = { id: created[0].id, created: true };
  }

  return res.status(200).json({
    ok: true,
    organization_id: organizationId,
    workflow: result,
  });
});
