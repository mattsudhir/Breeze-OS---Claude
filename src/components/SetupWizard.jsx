// Setup wizard — onboarding stepper.
//
// Renders as a full-screen overlay when the org's onboarding_state
// has not been marked complete. Walks the user through the 7 setup
// steps in order, persisting progress to the server after each
// step so the user can resume mid-flow.
//
// Steps:
//   1. Org name
//   2. Entity (LLC / partnership / etc.)
//   3. Owner — minimal name/email
//   4. Properties — open Entities tab to import or skip
//   5. Bank accounts — open Bank Accounts tab to Plaid-Link
//   6. Opening balance — open Journal Entries or skip
//   7. Reconciliation defaults — embedded threshold form
//
// Each step shows: title, why-this-matters blurb, action area
// (embedded form OR a "Take me there" button), Skip / Continue.

import { useEffect, useState } from 'react';
import {
  Building2, Users, CreditCard, Scale, FileSpreadsheet,
  Sparkles, Check, ArrowRight, X, SkipForward,
} from 'lucide-react';

const STEPS = [
  { id: 'org',              label: 'Organization',   icon: Building2 },
  { id: 'entity',           label: 'First entity',   icon: Scale },
  { id: 'owner',            label: 'Owner',          icon: Users },
  { id: 'properties',       label: 'Properties',     icon: Building2 },
  { id: 'banks',            label: 'Bank accounts',  icon: CreditCard },
  { id: 'opening-balance',  label: 'Opening balance', icon: FileSpreadsheet },
  { id: 'recon-defaults',   label: 'Recon defaults', icon: Sparkles },
];

const TOKEN_KEY = 'breeze.admin.token';
const CLERK_ENABLED = Boolean(import.meta.env.VITE_CLERK_PUBLISHABLE_KEY);
const readToken = () => {
  if (CLERK_ENABLED) return 'clerk';
  try { return sessionStorage.getItem(TOKEN_KEY) || ''; } catch { return ''; }
};

async function fetchJson(path, opts = {}) {
  const url = new URL(path, window.location.origin);
  url.searchParams.set('secret', readToken());
  const res = await fetch(url.toString(), {
    method: opts.method || 'GET',
    headers: opts.body ? { 'Content-Type': 'application/json' } : undefined,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
  }
  return res.json();
}

export default function SetupWizard({ onClose, onNavigate }) {
  const [state, setState] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    (async () => {
      try {
        const json = await fetchJson('/api/admin/onboarding-state');
        setState(json.onboarding_state);
      } catch (err) {
        setError(err.message);
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  // Begin onboarding (transitions from null → fresh state) the
  // first time the user opens the wizard.
  const begin = async () => {
    setLoading(true);
    try {
      const json = await fetchJson('/api/admin/onboarding-state', {
        method: 'POST',
        body: { current_step: 'org' },
      });
      setState(json.onboarding_state);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  const advance = async (currentId, action /* 'completed' | 'skipped' */) => {
    const ids = STEPS.map((s) => s.id);
    const idx = ids.indexOf(currentId);
    const nextId = idx >= 0 && idx < ids.length - 1 ? ids[idx + 1] : 'done';
    const body = {
      current_step: nextId,
    };
    if (action === 'completed') body.completed_step = currentId;
    if (action === 'skipped') body.skipped_step = currentId;
    if (nextId === 'done') body.complete = true;

    try {
      const json = await fetchJson('/api/admin/onboarding-state', {
        method: 'POST',
        body,
      });
      setState(json.onboarding_state);
      if (json.onboarding_state?.completed_at) {
        onClose();
      }
    } catch (err) {
      setError(err.message);
    }
  };

  if (loading) return <FullScreen><div>Loading…</div></FullScreen>;
  if (error) {
    return (
      <FullScreen>
        <div style={{ color: '#C62828' }}>Wizard failed to load: {error}</div>
        <button onClick={onClose} style={ctaBtn}>Close</button>
      </FullScreen>
    );
  }

  // Null state → never started. Offer to begin.
  if (!state) {
    return (
      <FullScreen>
        <Intro onBegin={begin} onSkip={onClose} />
      </FullScreen>
    );
  }

  if (state.completed_at) {
    // Already done — just close.
    onClose();
    return null;
  }

  const currentId = state.current_step || 'org';
  const currentIdx = STEPS.findIndex((s) => s.id === currentId);

  return (
    <FullScreen>
      <Progress steps={STEPS} state={state} currentId={currentId} />
      <StepBody
        stepId={currentId}
        onNavigate={(viewId) => { onClose(); onNavigate(viewId); }}
        onComplete={() => advance(currentId, 'completed')}
        onSkip={() => advance(currentId, 'skipped')}
        onExit={onClose}
        isLast={currentIdx === STEPS.length - 1}
      />
    </FullScreen>
  );
}

// ── Full-screen container ───────────────────────────────────────

function FullScreen({ children }) {
  return (
    <div style={{
      position: 'fixed', inset: 0,
      background: 'rgba(15, 23, 42, 0.55)',
      backdropFilter: 'blur(4px)',
      zIndex: 1000,
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      padding: '24px',
      overflow: 'auto',
    }}>
      <div style={{
        background: 'white',
        borderRadius: '14px',
        width: '100%', maxWidth: '720px',
        padding: '28px',
        boxShadow: '0 24px 60px rgba(0,0,0,0.25)',
      }}>
        {children}
      </div>
    </div>
  );
}

// ── Intro ───────────────────────────────────────────────────────

function Intro({ onBegin, onSkip }) {
  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '8px' }}>
        <Sparkles size={20} style={{ color: '#6A1B9A' }} />
        <h2 style={{ margin: 0 }}>Welcome to Breeze OS</h2>
      </div>
      <p style={{ color: '#555', marginTop: 0 }}>
        A 5-minute setup walks through the essentials so the platform is wired up to your
        properties, your bank accounts, and your books. You can stop and resume anytime —
        we'll pick up where you left off.
      </p>
      <ul style={{ color: '#444', fontSize: '14px', lineHeight: 1.7 }}>
        <li><strong>Organization</strong> — what to call your account</li>
        <li><strong>First entity</strong> — the LLC that owns your property</li>
        <li><strong>Owner, properties, banks</strong> — the directory + Plaid links</li>
        <li><strong>Opening balance</strong> — if you're migrating from AppFolio or another system</li>
        <li><strong>Reconciliation defaults</strong> — how strict the auto-match should be</li>
      </ul>
      <div style={{ display: 'flex', gap: '10px', marginTop: '20px', justifyContent: 'flex-end' }}>
        <button onClick={onSkip} style={secondaryBtn}>
          Not now
        </button>
        <button onClick={onBegin} style={ctaBtn}>
          Begin <ArrowRight size={14} />
        </button>
      </div>
    </div>
  );
}

// ── Progress bar ────────────────────────────────────────────────

function Progress({ steps, state, currentId }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '20px', flexWrap: 'wrap' }}>
      {steps.map((s, i) => {
        const done = state.completed_steps?.includes(s.id);
        const skipped = state.skipped_steps?.includes(s.id);
        const current = s.id === currentId;
        const color = done ? '#2E7D32' : skipped ? '#999' : current ? '#6A1B9A' : '#CCC';
        return (
          <div key={s.id} style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
            <div style={{
              width: '24px', height: '24px',
              borderRadius: '50%',
              background: current ? color : 'white',
              border: `2px solid ${color}`,
              color: current ? 'white' : color,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              fontSize: '11px', fontWeight: 700,
            }}>
              {done ? <Check size={12} /> : i + 1}
            </div>
            {i < steps.length - 1 && (
              <div style={{ width: '14px', height: '2px', background: '#DDD' }} />
            )}
          </div>
        );
      })}
    </div>
  );
}

// ── Step body ───────────────────────────────────────────────────

function StepBody({ stepId, onNavigate, onComplete, onSkip, onExit, isLast }) {
  if (stepId === 'org') return (
    <OrgStep onComplete={onComplete} onSkip={onSkip} onExit={onExit} />
  );
  if (stepId === 'entity') return (
    <SimpleStep
      icon={Scale}
      title="Set up your first legal entity"
      blurb="Every LLC or partnership that owns a property needs an entity record. The Entities tab is where you create one — name, EIN, formation state. You can come back here after setting it up to mark this step done."
      ctaLabel="Open the Entities tab"
      ctaViewId="accounting"
      onNavigate={onNavigate}
      onComplete={onComplete}
      onSkip={onSkip}
      onExit={onExit}
    />
  );
  if (stepId === 'owner') return (
    <SimpleStep
      icon={Users}
      title="Set up the owner record"
      blurb="The 'owner' is the legal person or entity that owns the LLC. For a single-owner LLC, this is usually you. You can skip this for now and add it later from the Property Directory."
      ctaLabel="Open Property Directory"
      ctaViewId="property-directory"
      onNavigate={onNavigate}
      onComplete={onComplete}
      onSkip={onSkip}
      onExit={onExit}
    />
  );
  if (stepId === 'properties') return (
    <SimpleStep
      icon={Building2}
      title="Add a property"
      blurb="If you're migrating from AppFolio, use the per-property importer (lands in the Entities tab). Otherwise add properties manually from the Properties page."
      ctaLabel="Open the Entities tab"
      ctaViewId="accounting"
      onNavigate={onNavigate}
      onComplete={onComplete}
      onSkip={onSkip}
      onExit={onExit}
    />
  );
  if (stepId === 'banks') return (
    <SimpleStep
      icon={CreditCard}
      title="Link your bank accounts"
      blurb="Plaid-link the operating account(s) for your properties. We'll auto-pull transactions and feed them to the reconciliation engine. You can link more accounts later from the Bank Accounts tab."
      ctaLabel="Open Bank Accounts"
      ctaViewId="accounting"
      onNavigate={onNavigate}
      onComplete={onComplete}
      onSkip={onSkip}
      onExit={onExit}
    />
  );
  if (stepId === 'opening-balance') return (
    <SimpleStep
      icon={FileSpreadsheet}
      title="Post an opening balance"
      blurb="If you're migrating from AppFolio or another system, paste your trial balance as of cutover. We'll record a single 'opening_balance' journal entry so reports match your prior books. Skip if you're starting fresh."
      ctaLabel="Open Journal Entries"
      ctaViewId="accounting"
      onNavigate={onNavigate}
      onComplete={onComplete}
      onSkip={onSkip}
      onExit={onExit}
    />
  );
  if (stepId === 'recon-defaults') return (
    <ReconDefaultsStep
      onComplete={onComplete}
      onSkip={onSkip}
      onExit={onExit}
      isLast={isLast}
    />
  );
  return (
    <div>
      Unknown step: {stepId}
      <div style={{ marginTop: '12px' }}>
        <button onClick={onExit} style={ctaBtn}>Close</button>
      </div>
    </div>
  );
}

// ── Step: organization ──────────────────────────────────────────

function OrgStep({ onComplete, onSkip, onExit }) {
  const [name, setName] = useState('');
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState(null);

  const save = async () => {
    if (!name.trim()) { setErr('Name is required'); return; }
    setSaving(true);
    setErr(null);
    try {
      // Minimal org rename: there's no dedicated rename endpoint
      // yet — the wizard records the answer via completed_step.
      // Org rename UI is a follow-up.
      onComplete();
    } catch (e) {
      setErr(e.message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div>
      <Header icon={Building2} title="Organization name" />
      <p style={{ color: '#555', fontSize: '14px' }}>
        What should we call your account? You can change this later from Settings.
      </p>
      <input
        type="text"
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder="e.g. Breeze Property Group"
        style={{
          padding: '10px 12px',
          width: '100%',
          maxWidth: '420px',
          fontSize: '14px',
          border: '1px solid #CCC',
          borderRadius: '6px',
        }}
      />
      {err && <div style={{ color: '#C62828', fontSize: '12px', marginTop: '6px' }}>{err}</div>}
      <Footer
        onComplete={save}
        onSkip={onSkip}
        onExit={onExit}
        primaryLabel="Continue"
        primaryDisabled={saving || !name.trim()}
      />
    </div>
  );
}

// ── Step: simple "go do it" step ────────────────────────────────

function SimpleStep({ icon, title, blurb, ctaLabel, ctaViewId, onNavigate, onComplete, onSkip, onExit }) {
  return (
    <div>
      <Header icon={icon} title={title} />
      <p style={{ color: '#555', fontSize: '14px' }}>{blurb}</p>
      <button
        onClick={() => onNavigate(ctaViewId)}
        style={{ ...ctaBtn, background: '#1565C0' }}
      >
        {ctaLabel} <ArrowRight size={14} />
      </button>
      <p style={{ color: '#888', fontSize: '12px', marginTop: '20px' }}>
        Already done? Mark complete to advance. Or skip and come back later.
      </p>
      <Footer
        onComplete={onComplete}
        onSkip={onSkip}
        onExit={onExit}
        primaryLabel="Mark complete"
      />
    </div>
  );
}

// ── Step: recon defaults ────────────────────────────────────────

function ReconDefaultsStep({ onComplete, onSkip, onExit, isLast }) {
  const [confidence, setConfidence] = useState(0.95);
  const [minUses, setMinUses] = useState(5);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState(null);
  const [savedHint, setSavedHint] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        const json = await fetchJson('/api/admin/recon-settings');
        setConfidence(json.auto_match_confidence);
        setMinUses(json.auto_match_min_times_used);
      } catch { /* fine — defaults stay */ }
    })();
  }, []);

  const save = async () => {
    setSaving(true);
    setErr(null);
    try {
      await fetchJson('/api/admin/recon-settings', {
        method: 'POST',
        body: {
          auto_match_confidence: Number(confidence),
          auto_match_min_times_used: Number(minUses),
        },
      });
      setSavedHint(true);
      onComplete();
    } catch (e) {
      setErr(e.message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div>
      <Header icon={Sparkles} title="Reconciliation auto-match defaults" />
      <p style={{ color: '#555', fontSize: '14px' }}>
        New rules earn auto-match status when their confidence is at least the threshold AND
        the rule has been confirmed at least the minimum number of times. Conservative
        defaults: 0.95 / 5. Looser values ramp auto-trust faster.
      </p>
      <div style={{ display: 'flex', gap: '12px', flexWrap: 'wrap', alignItems: 'flex-end' }}>
        <label style={{ display: 'flex', flexDirection: 'column', fontSize: '12px', color: '#444' }}>
          Confidence threshold (0–1)
          <input
            type="number" min="0" max="1" step="0.01"
            value={confidence}
            onChange={(e) => setConfidence(e.target.value)}
            style={{ padding: '6px 10px', border: '1px solid #CCC', borderRadius: '6px', width: '140px', marginTop: '4px' }}
          />
        </label>
        <label style={{ display: 'flex', flexDirection: 'column', fontSize: '12px', color: '#444' }}>
          Min rule uses
          <input
            type="number" min="0" step="1"
            value={minUses}
            onChange={(e) => setMinUses(e.target.value)}
            style={{ padding: '6px 10px', border: '1px solid #CCC', borderRadius: '6px', width: '140px', marginTop: '4px' }}
          />
        </label>
      </div>
      {err && <div style={{ color: '#C62828', fontSize: '12px', marginTop: '6px' }}>{err}</div>}
      {savedHint && (
        <div style={{ color: '#2E7D32', fontSize: '12px', marginTop: '6px' }}>
          Saved.
        </div>
      )}
      <Footer
        onComplete={save}
        onSkip={onSkip}
        onExit={onExit}
        primaryLabel={isLast ? 'Save and finish setup' : 'Save and continue'}
        primaryDisabled={saving}
      />
    </div>
  );
}

// ── Shared pieces ───────────────────────────────────────────────

function Header({ icon: Icon, title }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '8px' }}>
      <Icon size={20} style={{ color: '#6A1B9A' }} />
      <h2 style={{ margin: 0, fontSize: '18px' }}>{title}</h2>
    </div>
  );
}

function Footer({ onComplete, onSkip, onExit, primaryLabel = 'Continue', primaryDisabled }) {
  return (
    <div style={{
      marginTop: '24px',
      paddingTop: '16px',
      borderTop: '1px solid #EEE',
      display: 'flex',
      gap: '10px',
      justifyContent: 'space-between',
      alignItems: 'center',
      flexWrap: 'wrap',
    }}>
      <button onClick={onExit} style={textBtn} title="Close the wizard (you can resume later)">
        <X size={12} /> Close
      </button>
      <div style={{ display: 'flex', gap: '8px' }}>
        <button onClick={onSkip} style={secondaryBtn} disabled={primaryDisabled}>
          <SkipForward size={12} /> Skip
        </button>
        <button onClick={onComplete} style={ctaBtn} disabled={primaryDisabled}>
          {primaryLabel}
        </button>
      </div>
    </div>
  );
}

const ctaBtn = {
  padding: '9px 18px',
  background: '#6A1B9A',
  color: 'white',
  border: 'none',
  borderRadius: '7px',
  fontWeight: 600,
  fontSize: '14px',
  cursor: 'pointer',
  display: 'inline-flex',
  alignItems: 'center',
  gap: '6px',
};

const secondaryBtn = {
  padding: '9px 14px',
  background: 'white',
  color: '#444',
  border: '1px solid #BBB',
  borderRadius: '7px',
  fontWeight: 500,
  fontSize: '13px',
  cursor: 'pointer',
  display: 'inline-flex',
  alignItems: 'center',
  gap: '6px',
};

const textBtn = {
  padding: '8px 6px',
  background: 'none',
  color: '#888',
  border: 'none',
  fontSize: '12px',
  cursor: 'pointer',
  display: 'inline-flex',
  alignItems: 'center',
  gap: '4px',
};
