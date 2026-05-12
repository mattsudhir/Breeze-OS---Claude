// AI Agents — surfaces every named AI workflow as its own menu item.
//
// Sub-views (activeView IDs):
//   ai-agents                hub showing every workflow
//   ai-switch-utilities      Switch Utilities (outbound voice)
//   ai-payment-plan-followup Payment Plan Followup (outbound voice)
//
// Each sub-view fetches the matching ai_workflows row (by slug) and
// shows:
//   - description
//   - autonomy level (with edit dropdown)
//   - VAPI assistant id (with paste-and-save)
//   - "Place a test call" form
//   - Recent calls for this workflow

import { useCallback, useEffect, useState } from 'react';
import {
  Bot, PhoneOutgoing, Sparkles, ShieldAlert, ArrowRight, Settings, Power,
  Phone, RefreshCw, Check, X as XIcon,
} from 'lucide-react';
import MigrationFixButton from './MigrationFixButton.jsx';

const CLERK_ENABLED = Boolean(import.meta.env.VITE_CLERK_PUBLISHABLE_KEY);
const ADMIN_TOKEN_KEY = 'breeze.admin.token';
const getToken = () => {
  if (CLERK_ENABLED) return 'clerk';
  try { return sessionStorage.getItem(ADMIN_TOKEN_KEY) || ''; } catch { return ''; }
};

const SLUG_TO_VIEW = {
  switch_utilities:        'ai-switch-utilities',
  payment_plan_followup:   'ai-payment-plan-followup',
};
const VIEW_TO_SLUG = Object.fromEntries(Object.entries(SLUG_TO_VIEW).map(([k, v]) => [v, k]));
const APPROVAL_QUEUE_VIEW = 'ai-approval-queue';
const INBOX_VIEW = 'ai-inbox';

const AUTONOMY_LABELS = {
  draft_only:             'Draft only — staff sends manually',
  approve_before_contact: 'Approve before contact — staff approves before dialing',
  approve_before_action:  'Approve before action — AI runs the call, high-risk tools require approval',
  notify_only:            'Notify only — AI does everything, sends a summary',
  full:                   'Full — AI does everything without notifying',
};

async function fetchJson(path, opts = {}) {
  const url = new URL(path, window.location.origin);
  url.searchParams.set('secret', getToken());
  const res = await fetch(url.toString(), {
    method: opts.method || 'GET',
    headers: opts.body ? { 'Content-Type': 'application/json' } : undefined,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw new Error(`HTTP ${res.status}: ${t.slice(0, 200)}`);
  }
  return res.json();
}

export default function AiAgentsPage({ activeView, onNavigate }) {
  if (activeView === APPROVAL_QUEUE_VIEW) return <ApprovalQueuePage />;
  if (activeView === INBOX_VIEW) return <InboxPage />;
  const slug = VIEW_TO_SLUG[activeView] || null;
  if (slug) return <WorkflowPage slug={slug} />;
  return <HubPage onNavigate={onNavigate} />;
}

// ── Hub ─────────────────────────────────────────────────────────

function HubPage({ onNavigate }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const json = await fetchJson('/api/admin/list-ai-workflows');
      setData(json);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  if (loading) return <div style={{ padding: 24, color: '#666' }}>Loading…</div>;
  if (error) {
    return (
      <div style={{ padding: 24 }}>
        <div className="dashboard-card" style={{ padding: 16, background: '#FFEBEE', color: '#C62828' }}>
          <strong>Failed to load:</strong> {error}
          <MigrationFixButton error={error} />
        </div>
      </div>
    );
  }

  return (
    <div style={{ padding: '24px', maxWidth: '1100px', margin: '0 auto' }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: '16px', paddingBottom: '12px', borderBottom: '1px solid #EEE' }}>
        <div style={{
          width: 52, height: 52, borderRadius: 12,
          background: '#6A1B9A15', color: '#6A1B9A',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
        }}>
          <Bot size={28} />
        </div>
        <div style={{ flex: 1 }}>
          <h2 style={{ margin: 0 }}>AI Agents</h2>
          <p style={{ color: '#666', marginTop: 6, marginBottom: 0, fontSize: 14 }}>
            Voice and messaging agents that automate the comms work a property manager
            would otherwise do. Each agent has an autonomy level controlling how much it
            does without staff review.
          </p>
        </div>
      </div>

      <AutonomySettings defaultLevel={data.default_autonomy_level} onChanged={load} />

      <LiveCallsPanel />

      <div style={{
        marginTop: 20,
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))',
        gap: 14,
      }}>
        {data.workflows.map((w) => (
          <WorkflowCard
            key={w.id}
            workflow={w}
            onClick={() => {
              const viewId = SLUG_TO_VIEW[w.slug];
              if (viewId) onNavigate(viewId);
            }}
          />
        ))}
      </div>
    </div>
  );
}

function LiveCallsPanel() {
  const [calls, setCalls] = useState([]);
  const [busyId, setBusyId] = useState(null);
  const [steering, setSteering] = useState(null);
  const [transferTo, setTransferTo] = useState({});
  const [directiveText, setDirectiveText] = useState('');

  const load = useCallback(async () => {
    try {
      const json = await fetchJson('/api/admin/list-active-calls');
      setCalls(json.active_calls || []);
    } catch { /* fine */ }
  }, []);

  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    const t = setInterval(load, 4000);
    return () => clearInterval(t);
  }, [load]);

  const doTransfer = async (voiceCallId) => {
    const dest = transferTo[voiceCallId];
    if (!dest) return;
    setBusyId(voiceCallId);
    try {
      await fetchJson('/api/voice/transfer-call', {
        method: 'POST',
        body: { voice_call_id: voiceCallId, destination_phone: dest },
      });
      load();
    } finally {
      setBusyId(null);
    }
  };
  const doSteer = async (voiceCallId) => {
    if (!directiveText.trim()) return;
    setBusyId(voiceCallId);
    try {
      await fetchJson('/api/voice/steer-call', {
        method: 'POST',
        body: { voice_call_id: voiceCallId, directive_text: directiveText.trim() },
      });
      setDirectiveText('');
      setSteering(null);
    } finally {
      setBusyId(null);
    }
  };

  if (calls.length === 0) return null;

  return (
    <div style={{
      marginTop: 16,
      padding: '12px 16px',
      background: '#FFF8E1',
      borderLeft: '3px solid #F57F17',
      borderRadius: 8,
    }}>
      <div style={{ fontSize: 14, fontWeight: 700, color: '#F57F17', marginBottom: 8 }}>
        <PhoneOutgoing size={14} style={{ verticalAlign: '-2px', marginRight: 4 }} />
        Live calls ({calls.length})
      </div>
      {calls.map((c) => (
        <div key={c.voice_call_id} style={{ padding: '10px 0', borderTop: '1px solid #F0E5C0' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
            <div style={{ flex: 1 }}>
              <div style={{ fontWeight: 600, fontSize: 13 }}>
                {c.workflow_name || 'Voice call'} → {c.to_address}
              </div>
              <div style={{ fontSize: 11, color: '#666' }}>
                vapi_id {c.vapi_call_id?.slice(0, 12)}… · started {new Date(c.started_at).toLocaleTimeString()}
              </div>
            </div>
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              <input
                type="text"
                placeholder="+1..."
                value={transferTo[c.voice_call_id] || ''}
                onChange={(e) => setTransferTo({ ...transferTo, [c.voice_call_id]: e.target.value })}
                style={{ padding: '5px 8px', border: '1px solid #BBB', borderRadius: 5, fontSize: 12, width: 130 }}
              />
              <button
                type="button"
                onClick={() => doTransfer(c.voice_call_id)}
                disabled={busyId === c.voice_call_id || !transferTo[c.voice_call_id]}
                style={{
                  padding: '5px 10px', fontSize: 12, borderRadius: 5,
                  background: '#1565C0', color: 'white', border: 'none', fontWeight: 600,
                  cursor: 'pointer',
                }}
              >
                Transfer
              </button>
              <button
                type="button"
                onClick={() => setSteering(steering === c.voice_call_id ? null : c.voice_call_id)}
                style={{
                  padding: '5px 10px', fontSize: 12, borderRadius: 5,
                  background: 'white', color: '#6A1B9A', border: '1px solid #6A1B9A', fontWeight: 600,
                  cursor: 'pointer',
                }}
              >
                Steer AI
              </button>
            </div>
          </div>
          {steering === c.voice_call_id && (
            <div style={{ marginTop: 8, display: 'flex', gap: 6 }}>
              <input
                type="text"
                value={directiveText}
                onChange={(e) => setDirectiveText(e.target.value)}
                placeholder="e.g. offer 14-day extension if requested"
                style={{ flex: 1, padding: '6px 10px', border: '1px solid #BBB', borderRadius: 5, fontSize: 12 }}
                onKeyDown={(e) => e.key === 'Enter' && doSteer(c.voice_call_id)}
              />
              <button
                type="button"
                onClick={() => doSteer(c.voice_call_id)}
                disabled={busyId === c.voice_call_id || !directiveText.trim()}
                style={{
                  padding: '6px 14px', fontSize: 12, borderRadius: 5,
                  background: '#6A1B9A', color: 'white', border: 'none', fontWeight: 600,
                  cursor: 'pointer',
                }}
              >
                Send directive
              </button>
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

function AutonomySettings({ defaultLevel, onChanged }) {
  const [value, setValue] = useState(defaultLevel);
  const [saving, setSaving] = useState(false);
  const [savedHint, setSavedHint] = useState(false);

  useEffect(() => { setValue(defaultLevel); }, [defaultLevel]);

  const save = async (next) => {
    setSaving(true);
    setSavedHint(false);
    try {
      await fetchJson('/api/admin/ai-settings', {
        method: 'POST',
        body: { default_autonomy_level: next },
      });
      setValue(next);
      setSavedHint(true);
      onChanged();
    } finally {
      setSaving(false);
    }
  };

  return (
    <div style={{
      marginTop: 16,
      padding: '14px 16px',
      background: 'linear-gradient(135deg, #F3E5F5 0%, #E8EAF6 100%)',
      borderLeft: '3px solid #6A1B9A',
      borderRadius: 8,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
        <ShieldAlert size={14} style={{ color: '#6A1B9A' }} />
        <strong style={{ color: '#6A1B9A', fontSize: 14 }}>Default human-in-the-loop threshold</strong>
      </div>
      <div style={{ fontSize: 12, color: '#555', marginBottom: 10 }}>
        Every AI workflow inherits this unless it sets its own override. Sets how much the
        agent does autonomously vs. how much queues for staff review.
      </div>
      <select
        value={value || 'approve_before_action'}
        onChange={(e) => save(e.target.value)}
        disabled={saving}
        style={{
          padding: '7px 10px', border: '1px solid #BBB', borderRadius: 6,
          fontSize: 13, width: '100%', maxWidth: 500, background: 'white',
        }}
      >
        {Object.entries(AUTONOMY_LABELS).map(([k, v]) => (
          <option key={k} value={k}>{v}</option>
        ))}
      </select>
      {savedHint && <span style={{ marginLeft: 10, color: '#2E7D32', fontSize: 12 }}>Saved</span>}
    </div>
  );
}

function WorkflowCard({ workflow, onClick }) {
  const Icon = workflow.channel === 'voice' ? PhoneOutgoing : Sparkles;
  const colors = {
    voice: { bg: '#1565C015', fg: '#1565C0' },
    sms:   { bg: '#2E7D3215', fg: '#2E7D32' },
    email: { bg: '#E6510015', fg: '#E65100' },
  };
  const c = colors[workflow.channel] || { bg: '#9E9E9E15', fg: '#616161' };
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        textAlign: 'left',
        padding: '18px',
        borderRadius: 10,
        border: '1px solid #E0E0E0',
        background: 'white',
        cursor: 'pointer',
        display: 'flex',
        flexDirection: 'column',
        gap: 10,
      }}
      onMouseEnter={(e) => { e.currentTarget.style.borderColor = c.fg; }}
      onMouseLeave={(e) => { e.currentTarget.style.borderColor = '#E0E0E0'; }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <div style={{
          width: 36, height: 36, borderRadius: 8,
          background: c.bg, color: c.fg,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
        }}>
          <Icon size={20} />
        </div>
        <div>
          <div style={{ fontWeight: 700, fontSize: 15, color: '#1A1A1A' }}>
            {workflow.name}
            {!workflow.is_active && (
              <span style={{
                marginLeft: 8, padding: '1px 8px', borderRadius: 10, fontSize: 10,
                fontWeight: 600, background: '#EEE', color: '#888',
              }}>
                inactive
              </span>
            )}
          </div>
          <div style={{ fontSize: 12, color: c.fg, fontWeight: 600, textTransform: 'capitalize' }}>
            {workflow.direction} {workflow.channel}
          </div>
        </div>
      </div>
      <p style={{ margin: 0, fontSize: 12, color: '#555', lineHeight: 1.5 }}>
        {workflow.description}
      </p>
      <div style={{ fontSize: 11, color: '#888', borderTop: '1px dashed #EEE', paddingTop: 8 }}>
        <strong>Autonomy:</strong> {AUTONOMY_LABELS[workflow.effective_autonomy_level]?.split('—')[0]?.trim() || workflow.effective_autonomy_level}
        {workflow.autonomy_level ? '' : ' (inherited)'}
        {' · '}
        <strong>Assistant:</strong> {workflow.vapi_assistant_id ? '✓ configured' : 'not set'}
      </div>
      <div style={{ marginTop: 'auto', color: c.fg, fontSize: 13, fontWeight: 600, display: 'flex', alignItems: 'center', gap: 4 }}>
        Open <ArrowRight size={14} />
      </div>
    </button>
  );
}

// ── Per-workflow page ───────────────────────────────────────────

function WorkflowPage({ slug }) {
  const [workflow, setWorkflow] = useState(null);
  const [defaultLevel, setDefaultLevel] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const json = await fetchJson('/api/admin/list-ai-workflows');
      setDefaultLevel(json.default_autonomy_level);
      const w = json.workflows.find((x) => x.slug === slug);
      if (!w) throw new Error(`Workflow ${slug} not found`);
      setWorkflow(w);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [slug]);

  useEffect(() => { load(); }, [load]);

  if (loading) return <div style={{ padding: 24, color: '#666' }}>Loading…</div>;
  if (error) {
    return (
      <div style={{ padding: 24 }}>
        <div className="dashboard-card" style={{ padding: 16, background: '#FFEBEE', color: '#C62828' }}>
          <strong>Failed to load:</strong> {error}
          <MigrationFixButton error={error} />
        </div>
      </div>
    );
  }

  return (
    <div style={{ padding: '24px', maxWidth: '900px', margin: '0 auto' }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: '16px', paddingBottom: '12px', borderBottom: '1px solid #EEE' }}>
        <div style={{
          width: 52, height: 52, borderRadius: 12,
          background: '#1565C015', color: '#1565C0',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
        }}>
          <PhoneOutgoing size={28} />
        </div>
        <div style={{ flex: 1 }}>
          <h2 style={{ margin: 0 }}>{workflow.name}</h2>
          <p style={{ color: '#666', marginTop: 6, marginBottom: 0, fontSize: 14, lineHeight: 1.5 }}>
            {workflow.description}
          </p>
        </div>
      </div>

      <WorkflowConfigCard workflow={workflow} defaultLevel={defaultLevel} onChanged={load} />
      <PlaceCallCard workflow={workflow} />
    </div>
  );
}

function WorkflowConfigCard({ workflow, defaultLevel, onChanged }) {
  const [assistantId, setAssistantId] = useState(workflow.vapi_assistant_id || '');
  const [autonomy, setAutonomy] = useState(workflow.autonomy_level || '');
  const [isActive, setIsActive] = useState(workflow.is_active);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState(null);
  const [savedHint, setSavedHint] = useState(false);

  const save = async () => {
    setSaving(true);
    setErr(null);
    setSavedHint(false);
    try {
      await fetchJson('/api/admin/upsert-ai-workflow', {
        method: 'POST',
        body: {
          id: workflow.id,
          vapi_assistant_id: assistantId.trim() || null,
          autonomy_level: autonomy || null,
          is_active: isActive,
        },
      });
      setSavedHint(true);
      onChanged();
    } catch (e) {
      setErr(e.message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="dashboard-card" style={{ marginTop: 20, padding: '16px 18px' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
        <Settings size={16} style={{ color: '#444' }} />
        <h3 style={{ margin: 0, fontSize: 14 }}>Configuration</h3>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
        <label style={{ display: 'flex', flexDirection: 'column', fontSize: 12, color: '#444', gap: 4 }}>
          <span style={{ fontWeight: 600 }}>VAPI assistant id</span>
          <input
            type="text"
            value={assistantId}
            onChange={(e) => setAssistantId(e.target.value)}
            placeholder="asst_..."
            style={{ padding: '7px 10px', border: '1px solid #CCC', borderRadius: 6, fontSize: 13 }}
          />
          <span style={{ color: '#888', fontSize: 11 }}>
            Created in Vapi dashboard. The assistant defines the system prompt, voice,
            and the functions the agent is allowed to call.
          </span>
        </label>

        <label style={{ display: 'flex', flexDirection: 'column', fontSize: 12, color: '#444', gap: 4 }}>
          <span style={{ fontWeight: 600 }}>Autonomy level</span>
          <select
            value={autonomy}
            onChange={(e) => setAutonomy(e.target.value)}
            style={{ padding: '7px 10px', border: '1px solid #CCC', borderRadius: 6, fontSize: 13, background: 'white' }}
          >
            <option value="">Inherit org default ({defaultLevel?.replace(/_/g, ' ')})</option>
            {Object.entries(AUTONOMY_LABELS).map(([k, v]) => (
              <option key={k} value={k}>{v}</option>
            ))}
          </select>
          <span style={{ color: '#888', fontSize: 11 }}>
            Overrides the org default just for this workflow.
          </span>
        </label>
      </div>

      <div style={{ marginTop: 12, display: 'flex', alignItems: 'center', gap: 14 }}>
        <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 13 }}>
          <input type="checkbox" checked={isActive} onChange={(e) => setIsActive(e.target.checked)} />
          <Power size={12} /> Active
        </label>
        <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 8 }}>
          {err && <span style={{ color: '#C62828', fontSize: 12 }}>{err}</span>}
          {savedHint && <span style={{ color: '#2E7D32', fontSize: 12 }}>Saved</span>}
          <button
            type="button"
            onClick={save}
            disabled={saving}
            style={{
              padding: '7px 16px', background: saving ? '#BBB' : '#6A1B9A',
              color: 'white', border: 'none', borderRadius: 6, fontWeight: 600,
              fontSize: 13, cursor: saving ? 'not-allowed' : 'pointer',
            }}
          >
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  );
}

function PlaceCallCard({ workflow }) {
  const [phone, setPhone] = useState('');
  const [customerName, setCustomerName] = useState('');
  const [placing, setPlacing] = useState(false);
  const [result, setResult] = useState(null);
  const [err, setErr] = useState(null);

  const place = async () => {
    if (!phone.trim()) { setErr('Phone number required (E.164, e.g. +14155551234)'); return; }
    setPlacing(true);
    setErr(null);
    setResult(null);
    try {
      const json = await fetchJson('/api/voice/place-call', {
        method: 'POST',
        body: {
          workflow_slug: workflow.slug,
          phone_number: phone.trim(),
          customer_name: customerName.trim() || undefined,
        },
      });
      setResult(json);
    } catch (e) {
      setErr(e.message);
    } finally {
      setPlacing(false);
    }
  };

  return (
    <div className="dashboard-card" style={{ marginTop: 16, padding: '16px 18px' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
        <Phone size={16} style={{ color: '#1565C0' }} />
        <h3 style={{ margin: 0, fontSize: 14 }}>Place a test call</h3>
      </div>
      <p style={{ margin: '0 0 12px', fontSize: 12, color: '#666' }}>
        Dial any number with this workflow's assistant. If autonomy is set to
        <em> draft only</em> or <em>approve before contact</em>, the call queues for
        review instead of dialing immediately.
      </p>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
        <label style={{ display: 'flex', flexDirection: 'column', fontSize: 12, color: '#444', gap: 3 }}>
          <span style={{ fontWeight: 600 }}>Phone (E.164)</span>
          <input
            type="text"
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            placeholder="+14155551234"
            style={{ padding: '7px 10px', border: '1px solid #CCC', borderRadius: 6, fontSize: 13 }}
          />
        </label>
        <label style={{ display: 'flex', flexDirection: 'column', fontSize: 12, color: '#444', gap: 3 }}>
          <span style={{ fontWeight: 600 }}>Customer name (optional)</span>
          <input
            type="text"
            value={customerName}
            onChange={(e) => setCustomerName(e.target.value)}
            placeholder="e.g. Jane Smith"
            style={{ padding: '7px 10px', border: '1px solid #CCC', borderRadius: 6, fontSize: 13 }}
          />
        </label>
      </div>
      <div style={{ marginTop: 12, display: 'flex', alignItems: 'center', gap: 10 }}>
        <button
          type="button"
          onClick={place}
          disabled={placing}
          style={{
            padding: '8px 18px',
            background: placing ? '#BBB' : '#1565C0', color: 'white',
            border: 'none', borderRadius: 6, fontWeight: 600, fontSize: 13,
            cursor: placing ? 'not-allowed' : 'pointer',
            display: 'inline-flex', alignItems: 'center', gap: 6,
          }}
        >
          <PhoneOutgoing size={14} /> {placing ? 'Placing…' : 'Place call'}
        </button>
        <button
          type="button"
          onClick={() => { setResult(null); setErr(null); }}
          style={{
            padding: '8px 12px', background: 'white', color: '#444',
            border: '1px solid #BBB', borderRadius: 6, fontSize: 12, cursor: 'pointer',
            display: 'inline-flex', alignItems: 'center', gap: 4,
          }}
        >
          <RefreshCw size={12} /> Clear
        </button>
      </div>
      {err && (
        <div style={{ marginTop: 10, padding: '8px 10px', background: '#FFEBEE', color: '#C62828', borderRadius: 6, fontSize: 12 }}>
          {err}
        </div>
      )}
      {result && (
        <div style={{ marginTop: 10, padding: '8px 10px', background: '#E8F5E9', color: '#2E7D32', borderRadius: 6, fontSize: 12 }}>
          <strong>{result.status === 'queued' ? 'Queued' : 'Dialed'}.</strong>
          {result.vapi_call_id && <> Vapi call id: <code>{result.vapi_call_id}</code>.</>}
          {result.note && <> {result.note}</>}
        </div>
      )}
    </div>
  );
}

// ── Approval Queue page ─────────────────────────────────────────

function ApprovalQueuePage() {
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [busyId, setBusyId] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const json = await fetchJson('/api/admin/list-pending-approvals');
      setItems(json.pending || []);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const approve = async (messageId) => {
    setBusyId(messageId);
    try {
      await fetchJson('/api/admin/approve-queued-call', {
        method: 'POST',
        body: { message_id: messageId },
      });
      await load();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusyId(null);
    }
  };
  const reject = async (messageId) => {
    const reason = window.prompt('Rejection reason (optional)?', 'rejected by staff');
    if (reason === null) return;
    setBusyId(messageId);
    try {
      await fetchJson('/api/admin/reject-queued-call', {
        method: 'POST',
        body: { message_id: messageId, reason },
      });
      await load();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusyId(null);
    }
  };

  if (loading) return <div style={{ padding: 24, color: '#666' }}>Loading…</div>;

  return (
    <div style={{ padding: '24px', maxWidth: '1000px', margin: '0 auto' }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: '16px', paddingBottom: '12px', borderBottom: '1px solid #EEE' }}>
        <div style={{
          width: 52, height: 52, borderRadius: 12,
          background: '#E6510015', color: '#E65100',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
        }}>
          <ShieldAlert size={28} />
        </div>
        <div style={{ flex: 1 }}>
          <h2 style={{ margin: 0 }}>Approval Queue</h2>
          <p style={{ color: '#666', marginTop: 6, marginBottom: 0, fontSize: 14 }}>
            Outbound calls and messages that the autonomy threshold parked here for staff review.
            Approve to dispatch; reject to discard.
          </p>
        </div>
        <button
          type="button"
          onClick={load}
          className="btn-secondary"
          style={{ padding: '7px 12px', display: 'inline-flex', alignItems: 'center', gap: 6 }}
        >
          <RefreshCw size={14} /> Refresh
        </button>
      </div>

      {error && (
        <div style={{ marginTop: 12, padding: '10px 12px', background: '#FFEBEE', color: '#C62828', borderRadius: 6, fontSize: 13 }}>
          {error}
        </div>
      )}

      {items.length === 0 ? (
        <div className="dashboard-card" style={{ marginTop: 16, padding: 24, textAlign: 'center', color: '#666' }}>
          Nothing pending. The queue fills when an AI workflow's autonomy level requires staff
          approval before dispatch.
        </div>
      ) : (
        <div className="dashboard-card" style={{ marginTop: 16, padding: 0, overflow: 'hidden' }}>
          {items.map((m) => (
            <div key={m.id} style={{ padding: '14px 16px', borderBottom: '1px solid #F0F0F0' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 10, flexWrap: 'wrap' }}>
                <div style={{ flex: 1, minWidth: 240 }}>
                  <div style={{ fontWeight: 600, fontSize: 14 }}>
                    {m.workflow_name || '(no workflow)'}
                    <span style={{
                      marginLeft: 8, padding: '1px 8px', borderRadius: 10,
                      fontSize: 10, fontWeight: 600, textTransform: 'uppercase',
                      background: '#FFF3E0', color: '#E65100',
                    }}>
                      queued
                    </span>
                  </div>
                  <div style={{ fontSize: 12, color: '#666', marginTop: 4 }}>
                    {m.channel} · {m.direction} · to <strong>{m.to_address || '(unknown)'}</strong>
                    {' · '}
                    {new Date(m.created_at).toLocaleString()}
                  </div>
                  {m.body && (
                    <div style={{ fontSize: 12, color: '#444', marginTop: 6, fontStyle: 'italic' }}>
                      {m.body}
                    </div>
                  )}
                  {!m.workflow_has_assistant && (
                    <div style={{ fontSize: 11, color: '#C62828', marginTop: 6 }}>
                      ⚠ Workflow has no VAPI assistant configured — approval will fail until you set one.
                    </div>
                  )}
                </div>
                <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
                  <button
                    type="button"
                    onClick={() => approve(m.id)}
                    disabled={busyId === m.id}
                    style={{
                      padding: '6px 12px', fontSize: 12, borderRadius: 6,
                      background: '#2E7D32', color: 'white', border: 'none',
                      fontWeight: 600, cursor: busyId === m.id ? 'not-allowed' : 'pointer',
                      display: 'inline-flex', alignItems: 'center', gap: 4,
                    }}
                  >
                    <Check size={12} /> Approve
                  </button>
                  <button
                    type="button"
                    onClick={() => reject(m.id)}
                    disabled={busyId === m.id}
                    style={{
                      padding: '6px 12px', fontSize: 12, borderRadius: 6,
                      background: 'white', color: '#C62828', border: '1px solid #C62828',
                      cursor: busyId === m.id ? 'not-allowed' : 'pointer',
                      display: 'inline-flex', alignItems: 'center', gap: 4,
                    }}
                  >
                    <XIcon size={12} /> Reject
                  </button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Inbox page ──────────────────────────────────────────────────

function InboxPage() {
  const [threads, setThreads] = useState([]);
  const [selectedId, setSelectedId] = useState(null);
  const [filter, setFilter] = useState('all');
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const url = new URL('/api/admin/list-message-threads', window.location.origin);
      url.searchParams.set('secret', getToken());
      if (filter !== 'all') url.searchParams.set('filter', filter);
      const res = await fetch(url.toString());
      const json = await res.json();
      setThreads(json.threads || []);
    } catch (e) {
      console.error(e);
    } finally {
      setLoading(false);
    }
  }, [filter]);

  useEffect(() => { load(); }, [load]);
  // Poll every 8s for updates.
  useEffect(() => {
    const t = setInterval(load, 8000);
    return () => clearInterval(t);
  }, [load]);

  return (
    <div style={{ display: 'flex', height: 'calc(100vh - 120px)' }}>
      <aside style={{ width: 360, borderRight: '1px solid #EEE', display: 'flex', flexDirection: 'column' }}>
        <div style={{ padding: '12px 14px', borderBottom: '1px solid #EEE' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
            <strong style={{ fontSize: 14 }}>Inbox</strong>
            <button
              type="button" onClick={load}
              style={{ marginLeft: 'auto', background: 'none', border: 'none', cursor: 'pointer', color: '#666' }}
              title="Refresh"
            >
              <RefreshCw size={14} />
            </button>
          </div>
          <select
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            style={{ width: '100%', padding: '6px 8px', fontSize: 12, border: '1px solid #DDD', borderRadius: 5 }}
          >
            <option value="all">All threads</option>
            <option value="unmatched">Unmatched inbound</option>
            <option value="paused">Staff-paused</option>
            <option value="active">AI active</option>
          </select>
        </div>
        <div style={{ flex: 1, overflowY: 'auto' }}>
          {loading && threads.length === 0 && (
            <div style={{ padding: 16, color: '#999', fontSize: 13 }}>Loading…</div>
          )}
          {!loading && threads.length === 0 && (
            <div style={{ padding: 16, color: '#999', fontSize: 13 }}>
              No conversations yet. Inbound messages and outbound replies show up here.
            </div>
          )}
          {threads.map((t) => (
            <button
              type="button"
              key={t.id}
              onClick={() => setSelectedId(t.id)}
              style={{
                width: '100%', textAlign: 'left', padding: '10px 12px',
                border: 'none', borderBottom: '1px solid #F5F5F5',
                background: selectedId === t.id ? '#F3E5F5' : 'white',
                cursor: 'pointer',
                display: 'flex', flexDirection: 'column', gap: 3,
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <span style={{ fontWeight: 600, fontSize: 13, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {t.tenant_name || t.subject || '(unmatched)'}
                </span>
                {t.is_unmatched && (
                  <span style={{ fontSize: 9, padding: '0 6px', borderRadius: 8, background: '#FFEBEE', color: '#C62828', fontWeight: 600 }}>
                    UNMATCHED
                  </span>
                )}
                {t.staff_paused && (
                  <span style={{ fontSize: 9, padding: '0 6px', borderRadius: 8, background: '#FFF3E0', color: '#E65100', fontWeight: 600 }}>
                    AI PAUSED
                  </span>
                )}
              </div>
              <div style={{ fontSize: 11, color: '#666', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {t.last_direction === 'inbound' ? '↓ ' : '↑ '}
                {t.last_body || '(no messages)'}
              </div>
              <div style={{ fontSize: 10, color: '#999' }}>
                {t.last_message_at ? new Date(t.last_message_at).toLocaleString() : ''}
                {' · '}{t.message_count} msg{t.message_count === 1 ? '' : 's'}
              </div>
            </button>
          ))}
        </div>
      </aside>
      <main style={{ flex: 1, overflowY: 'auto', padding: 0 }}>
        {selectedId ? <ConversationPane threadId={selectedId} onChanged={load} /> : (
          <div style={{ padding: 40, textAlign: 'center', color: '#999' }}>
            Pick a thread on the left to view the conversation.
          </div>
        )}
      </main>
    </div>
  );
}

function ConversationPane({ threadId, onChanged }) {
  const [data, setData] = useState(null);
  const [composeText, setComposeText] = useState('');
  const [sending, setSending] = useState(false);
  const [err, setErr] = useState(null);

  const load = useCallback(async () => {
    try {
      const url = new URL('/api/admin/list-thread-messages', window.location.origin);
      url.searchParams.set('secret', getToken());
      url.searchParams.set('thread_id', threadId);
      const res = await fetch(url.toString());
      const json = await res.json();
      setData(json);
    } catch (e) {
      console.error(e);
    }
  }, [threadId]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    const t = setInterval(load, 5000);
    return () => clearInterval(t);
  }, [load]);

  const togglePause = async () => {
    const next = !data?.thread?.staff_paused;
    await fetchJson('/api/admin/pause-thread', {
      method: 'POST',
      body: { thread_id: threadId, paused: next },
    });
    load();
    onChanged();
  };

  const send = async () => {
    if (!composeText.trim()) return;
    setSending(true);
    setErr(null);
    try {
      const lastInbound = (data?.messages || []).filter((m) => m.direction === 'inbound').slice(-1)[0];
      const to = lastInbound?.from_address;
      if (!to) {
        setErr('No tenant number known on this thread. Match the inbound sender first.');
        return;
      }
      const res = await fetch(
        `/api/messages/send-sms?secret=${getToken()}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            tenant_id: data.thread.tenant_id,
            to,
            body: composeText.trim(),
          }),
        },
      );
      const json = await res.json();
      if (!json.ok) { setErr(json.error); return; }
      setComposeText('');
      load();
      onChanged();
    } catch (e) {
      setErr(e.message);
    } finally {
      setSending(false);
    }
  };

  if (!data) return <div style={{ padding: 24, color: '#999' }}>Loading…</div>;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <div style={{ padding: '12px 16px', borderBottom: '1px solid #EEE', background: '#FAFAFA' }}>
        <div style={{ fontWeight: 600 }}>{data.thread.subject || 'Conversation'}</div>
        <div style={{ fontSize: 11, color: '#666', marginTop: 2 }}>
          {data.thread.tenant_id ? `Tenant ${data.thread.tenant_id.slice(0, 8)}…` : 'Unmatched'}
          {' · '}{data.messages.length} messages
        </div>
        <div style={{ marginTop: 6 }}>
          <button
            type="button"
            onClick={togglePause}
            style={{
              padding: '4px 10px', fontSize: 11, borderRadius: 5,
              border: `1px solid ${data.thread.staff_paused ? '#E65100' : '#666'}`,
              background: data.thread.staff_paused ? '#FFF3E0' : 'white',
              color: data.thread.staff_paused ? '#E65100' : '#666',
              cursor: 'pointer',
            }}
          >
            {data.thread.staff_paused ? 'AI paused — resume' : 'Pause AI on this thread'}
          </button>
        </div>
      </div>
      <div style={{ flex: 1, overflowY: 'auto', padding: '16px 20px', background: 'white' }}>
        {data.messages.map((m) => {
          const isInbound = m.direction === 'inbound';
          return (
            <div
              key={m.id}
              style={{
                display: 'flex',
                justifyContent: isInbound ? 'flex-start' : 'flex-end',
                marginBottom: 10,
              }}
            >
              <div style={{
                maxWidth: '70%',
                padding: '8px 12px',
                borderRadius: 12,
                background: isInbound ? '#F0F0F0' : '#E3F2FD',
                color: '#222',
                fontSize: 13,
                lineHeight: 1.4,
              }}>
                <div>{m.body}</div>
                <div style={{ fontSize: 10, color: '#888', marginTop: 4 }}>
                  {isInbound ? `from ${m.from_address}` : `to ${m.to_address}`}
                  {' · '}{m.status}
                  {' · '}{new Date(m.created_at).toLocaleString()}
                </div>
              </div>
            </div>
          );
        })}
      </div>
      <div style={{ padding: 12, borderTop: '1px solid #EEE', background: '#FAFAFA' }}>
        {err && (
          <div style={{ marginBottom: 8, padding: '6px 10px', background: '#FFEBEE', color: '#C62828', fontSize: 12, borderRadius: 5 }}>
            {err}
          </div>
        )}
        <div style={{ display: 'flex', gap: 8 }}>
          <textarea
            value={composeText}
            onChange={(e) => setComposeText(e.target.value)}
            placeholder="Type a reply…"
            rows={2}
            style={{ flex: 1, padding: 8, border: '1px solid #CCC', borderRadius: 6, fontSize: 13, fontFamily: 'inherit', resize: 'vertical' }}
          />
          <button
            type="button"
            onClick={send}
            disabled={sending || !composeText.trim()}
            style={{
              padding: '8px 16px', background: sending || !composeText.trim() ? '#BBB' : '#6A1B9A',
              color: 'white', border: 'none', borderRadius: 6, fontWeight: 600, fontSize: 13,
              cursor: sending || !composeText.trim() ? 'not-allowed' : 'pointer',
            }}
          >
            {sending ? 'Sending…' : 'Send'}
          </button>
        </div>
      </div>
    </div>
  );
}
