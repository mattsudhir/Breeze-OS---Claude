// POST /api/voice/steer-call?secret=<TOKEN>
// body: { voice_call_id, directive_text }
//
// Injects a supervisor directive into an active VAPI call. The AI
// continues talking but its system context now includes the
// directive, so its next utterance reflects the new guidance.
// Writes a voice_call_directives row for audit.

import { and, eq } from 'drizzle-orm';
import {
  withAdminHandler,
  getDefaultOrgId,
  parseBody,
} from '../../lib/adminHelpers.js';
import { getDb, schema } from '../../lib/db/index.js';
import { steerCall, isVapiConfigured } from '../../lib/backends/vapi.js';

export default withAdminHandler(async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'POST only' });
  }
  if (!isVapiConfigured()) {
    return res.status(503).json({ ok: false, error: 'VAPI not configured' });
  }

  const body = parseBody(req);
  if (!body.voice_call_id || !body.directive_text) {
    return res.status(400).json({ ok: false, error: 'voice_call_id and directive_text required' });
  }

  const db = getDb();
  const organizationId = await getDefaultOrgId();

  const [vc] = await db
    .select({
      id: schema.voiceCalls.id,
      vapiCallId: schema.voiceCalls.vapiCallId,
    })
    .from(schema.voiceCalls)
    .where(
      and(
        eq(schema.voiceCalls.id, body.voice_call_id),
        eq(schema.voiceCalls.organizationId, organizationId),
      ),
    )
    .limit(1);
  if (!vc) return res.status(404).json({ ok: false, error: 'voice_call not found' });
  if (!vc.vapiCallId) return res.status(400).json({ ok: false, error: 'voice_call has no vapi_call_id' });

  // Persist the directive first so we have an audit record even if
  // the VAPI call fails.
  const [directive] = await db
    .insert(schema.voiceCallDirectives)
    .values({
      organizationId,
      voiceCallId: vc.id,
      directiveText: body.directive_text,
    })
    .returning({ id: schema.voiceCallDirectives.id });

  try {
    await steerCall(vc.vapiCallId, body.directive_text);
  } catch (err) {
    return res.status(502).json({ ok: false, error: err.message, directive_id: directive.id });
  }

  await db
    .update(schema.voiceCallDirectives)
    .set({ deliveredAt: new Date() })
    .where(eq(schema.voiceCallDirectives.id, directive.id));

  return res.status(200).json({
    ok: true,
    voice_call_id: vc.id,
    directive_id: directive.id,
  });
});
