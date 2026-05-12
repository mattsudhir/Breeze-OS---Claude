// GET  /api/admin/onboarding-state?secret=<TOKEN>
//   Returns the org's onboarding state.
//
// POST /api/admin/onboarding-state?secret=<TOKEN>
//   body: {
//     current_step?:    string
//     completed_step?:  string   // append to completed_steps[]
//     skipped_step?:    string   // append to skipped_steps[]
//     complete?:        boolean  // sets completed_at = now
//     reset?:           boolean  // start fresh (mostly for dev)
//   }
//
// All fields optional; mix and match. The endpoint reads the current
// state, applies the deltas, and writes back atomically. Returns the
// new state.
//
// Step ids (current set):
//   org · entity · owner · properties · banks · opening-balance ·
//   recon-defaults · done

import { eq } from 'drizzle-orm';
import {
  withAdminHandler,
  getDefaultOrgId,
  parseBody,
} from '../../lib/adminHelpers.js';
import { getDb, schema } from '../../lib/db/index.js';

const DEFAULT_STATE = {
  current_step: 'org',
  completed_steps: [],
  skipped_steps: [],
  started_at: null,
  completed_at: null,
};

function normalize(state) {
  if (!state || typeof state !== 'object') return null;
  return {
    current_step: state.current_step || 'org',
    completed_steps: Array.isArray(state.completed_steps) ? state.completed_steps : [],
    skipped_steps: Array.isArray(state.skipped_steps) ? state.skipped_steps : [],
    started_at: state.started_at || null,
    completed_at: state.completed_at || null,
  };
}

export default withAdminHandler(async (req, res) => {
  if (req.method !== 'GET' && req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'GET or POST only' });
  }
  const db = getDb();
  const organizationId = await getDefaultOrgId();

  const [org] = await db
    .select({ onboardingState: schema.organizations.onboardingState })
    .from(schema.organizations)
    .where(eq(schema.organizations.id, organizationId))
    .limit(1);

  let state = normalize(org?.onboardingState);

  if (req.method === 'POST') {
    const body = parseBody(req);

    if (body.reset === true) {
      state = { ...DEFAULT_STATE, started_at: new Date().toISOString() };
    } else {
      // Hydrate to a working state object even if it was null (i.e.
      // a legacy org just hit the wizard for the first time).
      if (!state) {
        state = { ...DEFAULT_STATE, started_at: new Date().toISOString() };
      }
      if (typeof body.current_step === 'string') {
        state.current_step = body.current_step;
      }
      if (typeof body.completed_step === 'string') {
        if (!state.completed_steps.includes(body.completed_step)) {
          state.completed_steps = [...state.completed_steps, body.completed_step];
        }
      }
      if (typeof body.skipped_step === 'string') {
        if (!state.skipped_steps.includes(body.skipped_step)) {
          state.skipped_steps = [...state.skipped_steps, body.skipped_step];
        }
      }
      if (body.complete === true) {
        state.completed_at = new Date().toISOString();
        state.current_step = 'done';
      }
    }

    await db
      .update(schema.organizations)
      .set({ onboardingState: state, updatedAt: new Date() })
      .where(eq(schema.organizations.id, organizationId));
  }

  return res.status(200).json({
    ok: true,
    organization_id: organizationId,
    onboarding_state: state,
  });
});
