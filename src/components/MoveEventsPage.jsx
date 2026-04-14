// Move Events — create move-in / move-out workflows, watch them
// run, inspect call outcomes.
//
// This page is the UI over the move_events + move_event_utilities
// + calls tables. For each move event:
//   - Create form at the top: pick a property, enter a tenant name,
//     choose event type, pick an effective date.
//   - List below: recent move events, newest first, with a rollup
//     status chip and per-utility progress summary.
//   - Click an event → detail panel with per-utility rows, their
//     call history, and transcripts.

import { useEffect, useState, useCallback } from 'react';
import {
  Calendar,
  RefreshCw,
  Plus,
  PhoneCall,
  AlertTriangle,
  CheckCircle2,
  Clock,
  ChevronRight,
  ChevronDown,
} from 'lucide-react';
import {
  moveEvents as moveEventsApi,
  properties as propertiesApi,
  getAdminToken,
  setAdminToken,
  hasAdminToken,
} from '../lib/admin';

// Shared token gate — same pattern as PropertyDirectoryPage so the
// user's stored admin token unlocks both pages seamlessly.
function TokenGate({ children }) {
  const [value, setValue] = useState(getAdminToken());
  if (hasAdminToken()) return children;
  return (
    <div style={{ padding: 24, maxWidth: 520 }}>
      <h2>Admin token required</h2>
      <p style={{ color: '#666' }}>
        Paste your <code>BREEZE_ADMIN_TOKEN</code> to access move events.
      </p>
      <input
        type="password"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder="bzadmin_..."
        style={inputStyle}
      />
      <button
        type="button"
        onClick={() => {
          setAdminToken(value.trim());
          window.location.reload();
        }}
        disabled={!value.trim()}
        style={primaryButtonStyle}
      >
        Save token
      </button>
    </div>
  );
}

export default function MoveEventsPage() {
  const [events, setEvents] = useState([]);
  const [propertiesList, setPropertiesList] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [creating, setCreating] = useState(false);
  const [expandedId, setExpandedId] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    const [evRes, propRes] = await Promise.all([
      moveEventsApi.list(),
      propertiesApi.list(),
    ]);
    setLoading(false);
    if (!evRes.ok) return setError(evRes.error);
    if (!propRes.ok) return setError(propRes.error);
    setError(null);
    setEvents(evRes.events || []);
    setPropertiesList(propRes.properties || []);
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  // Poll every 15 seconds when a detail view is open so call status
  // updates show up without manual refresh. Cheap enough on Neon.
  useEffect(() => {
    if (!expandedId) return;
    const interval = setInterval(() => {
      moveEventsApi.list().then((res) => {
        if (res.ok) setEvents(res.events || []);
      });
    }, 15000);
    return () => clearInterval(interval);
  }, [expandedId]);

  return (
    <TokenGate>
      <div style={{ padding: 24, maxWidth: 1100 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16 }}>
          <Calendar size={24} />
          <h1 style={{ margin: 0 }}>Move Events</h1>
          <span style={{ color: '#888', fontSize: 14 }}>
            — Autonomous utility transfers on move-in / move-out
          </span>
        </div>

        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
          <strong>{events.length} event{events.length === 1 ? '' : 's'}</strong>
          <div style={{ display: 'flex', gap: 8 }}>
            <button type="button" onClick={load} style={smallButtonStyle}>
              <RefreshCw size={14} style={{ marginRight: 4 }} /> Refresh
            </button>
            <button type="button" onClick={() => setCreating((c) => !c)} style={smallButtonStyle}>
              <Plus size={14} style={{ marginRight: 4 }} /> {creating ? 'Cancel' : 'New move event'}
            </button>
          </div>
        </div>

        {creating && (
          <CreateForm
            properties={propertiesList}
            onCreated={() => {
              setCreating(false);
              load();
            }}
          />
        )}

        {loading && <p style={{ color: '#888' }}>Loading…</p>}
        {error && <ErrorBox message={error} />}
        {!loading && !error && events.length === 0 && (
          <EmptyState message={'No move events yet. Click "New move event" to create one.'} />
        )}

        {events.map((ev) => (
          <MoveEventRow
            key={ev.id}
            event={ev}
            properties={propertiesList}
            expanded={expandedId === ev.id}
            onToggle={() => setExpandedId(expandedId === ev.id ? null : ev.id)}
          />
        ))}
      </div>
    </TokenGate>
  );
}

// ── Create form ──────────────────────────────────────────────────

function CreateForm({ properties, onCreated }) {
  const [form, setForm] = useState({
    propertyId: properties[0]?.id || '',
    tenantDisplayName: '',
    sourceTenantId: '',
    eventType: 'move_in',
    effectiveDate: new Date().toISOString().slice(0, 10),
    notes: '',
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  const update = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));

  const handleSave = async () => {
    setSaving(true);
    setError(null);
    const payload = {
      propertyId: form.propertyId,
      tenantDisplayName: form.tenantDisplayName || null,
      sourceTenantId: form.sourceTenantId ? parseInt(form.sourceTenantId, 10) : null,
      eventType: form.eventType,
      effectiveDate: new Date(form.effectiveDate).toISOString(),
      notes: form.notes || null,
    };
    const res = await moveEventsApi.create(payload);
    setSaving(false);
    if (!res.ok) return setError(res.error);
    if (res.utilitiesDerived === 0) {
      alert(
        'Move event created, but no utility actions were derived. ' +
          "The property either has no tenant-held utilities or hasn't been configured in the Bulk Config tab yet.",
      );
    }
    onCreated();
  };

  // Sort properties by display name for the dropdown.
  const sortedProps = [...properties].sort((a, b) =>
    (a.displayName || '').localeCompare(b.displayName || ''),
  );

  return (
    <div style={formContainerStyle}>
      <h3 style={{ marginTop: 0 }}>New move event</h3>
      <FormRow
        label="Property *"
        value={form.propertyId}
        onChange={update('propertyId')}
        select={sortedProps.map((p) => ({
          value: p.id,
          label: `${p.displayName} — ${p.serviceCity}, ${p.serviceState}`,
        }))}
      />
      <FormRow
        label="Event type *"
        value={form.eventType}
        onChange={update('eventType')}
        select={[
          { value: 'move_in', label: 'Move-in (verify utilities are off LLC)' },
          { value: 'move_out', label: 'Move-out (transfer utilities to LLC)' },
        ]}
      />
      <FormRow
        label="Effective date *"
        value={form.effectiveDate}
        onChange={update('effectiveDate')}
        type="date"
      />
      <FormRow
        label="Tenant name"
        value={form.tenantDisplayName}
        onChange={update('tenantDisplayName')}
        placeholder="Jane Doe"
      />
      <FormRow
        label="Rent Manager Tenant ID (optional)"
        value={form.sourceTenantId}
        onChange={update('sourceTenantId')}
        placeholder="12345"
      />
      <FormRow
        label="Notes"
        value={form.notes}
        onChange={update('notes')}
        placeholder="Any context for whoever reviews the call outcomes"
      />
      {error && <ErrorBox message={error} />}
      <button
        type="button"
        onClick={handleSave}
        disabled={!form.propertyId || saving}
        style={primaryButtonStyle}
      >
        {saving ? 'Creating…' : 'Create move event & enqueue tasks'}
      </button>
    </div>
  );
}

// ── Move event row ──────────────────────────────────────────────

function MoveEventRow({ event, properties, expanded, onToggle }) {
  const property = properties.find((p) => p.id === event.propertyId);
  const effectiveDate = event.effectiveDate
    ? new Date(event.effectiveDate).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' })
    : '(no date)';

  return (
    <div
      style={{
        marginBottom: 12,
        border: '1px solid #eee',
        borderRadius: 8,
        background: 'white',
      }}
    >
      <div
        onClick={onToggle}
        style={{
          padding: 16,
          cursor: 'pointer',
          display: 'flex',
          alignItems: 'center',
          gap: 12,
        }}
      >
        {expanded ? <ChevronDown size={18} /> : <ChevronRight size={18} />}
        <StatusChip status={event.status} />
        <div style={{ flex: 1 }}>
          <strong>{property?.displayName || '(unknown property)'}</strong>
          <span style={{ color: '#888', fontSize: 13, marginLeft: 8 }}>
            {event.eventType === 'move_in' ? 'Move-in' : 'Move-out'}
          </span>
          {event.tenantDisplayName && (
            <span style={{ color: '#555', fontSize: 13, marginLeft: 8 }}>
              · {event.tenantDisplayName}
            </span>
          )}
          <div style={{ color: '#666', fontSize: 12, marginTop: 2 }}>
            Effective {effectiveDate}
            {event.notes && ` · ${event.notes}`}
          </div>
        </div>
      </div>
      {expanded && <MoveEventDetail eventId={event.id} />}
    </div>
  );
}

function StatusChip({ status }) {
  const styles = {
    pending: { bg: '#f3f4f6', fg: '#374151', icon: Clock },
    in_progress: { bg: '#dbeafe', fg: '#1e3a8a', icon: PhoneCall },
    completed: { bg: '#dcfce7', fg: '#166534', icon: CheckCircle2 },
    escalated: { bg: '#fef3c7', fg: '#92400e', icon: AlertTriangle },
    cancelled: { bg: '#f3f4f6', fg: '#888', icon: Clock },
  };
  const style = styles[status] || styles.pending;
  const Icon = style.icon;
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 4,
        padding: '2px 8px',
        background: style.bg,
        color: style.fg,
        borderRadius: 12,
        fontSize: 12,
        fontWeight: 600,
      }}
    >
      <Icon size={12} /> {status}
    </span>
  );
}

// ── Detail panel ────────────────────────────────────────────────

function MoveEventDetail({ eventId }) {
  const [detail, setDetail] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    const res = await moveEventsApi.get(eventId);
    setLoading(false);
    if (!res.ok) return setError(res.error);
    setError(null);
    setDetail(res);
  }, [eventId]);

  useEffect(() => {
    load();
    const i = setInterval(load, 15000);
    return () => clearInterval(i);
  }, [load]);

  if (loading) return <div style={{ padding: 16, color: '#888' }}>Loading detail…</div>;
  if (error) return <div style={{ padding: 16 }}><ErrorBox message={error} /></div>;
  if (!detail) return null;

  const { utilities, calls } = detail;

  return (
    <div style={{ padding: 16, borderTop: '1px solid #eee', background: '#fafafa' }}>
      <h4 style={{ marginTop: 0, marginBottom: 8 }}>Utility actions ({utilities.length})</h4>
      {utilities.length === 0 && (
        <p style={{ color: '#888', fontSize: 13 }}>
          No utility actions derived. Check the property's utility config.
        </p>
      )}
      {utilities.map((u) => {
        const utilityCalls = (calls || []).filter((c) => c.relatedId === u.id);
        return <UtilityActionRow key={u.id} utility={u} calls={utilityCalls} />;
      })}
    </div>
  );
}

function UtilityActionRow({ utility, calls }) {
  const [showCalls, setShowCalls] = useState(false);
  const labels = {
    verify_off_llc: 'Verify utility is OFF LLC',
    transfer_to_llc: 'Transfer utility to LLC',
    verify_on_llc: 'Verify utility is ON LLC',
  };
  return (
    <div
      style={{
        padding: 12,
        marginBottom: 8,
        background: 'white',
        border: '1px solid #eee',
        borderRadius: 6,
        fontSize: 13,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <StatusChip status={utility.status} />
        <strong>{labels[utility.action] || utility.action}</strong>
        <span style={{ color: '#666' }}>
          · attempts {utility.attempts}/{utility.maxAttempts ?? 5}
        </span>
        {utility.nextAttemptAt && (
          <span style={{ color: '#888' }}>
            · next attempt {new Date(utility.nextAttemptAt).toLocaleString()}
          </span>
        )}
        {calls.length > 0 && (
          <button
            type="button"
            onClick={() => setShowCalls((s) => !s)}
            style={smallButtonStyle}
          >
            {showCalls ? 'Hide' : 'Show'} {calls.length} call{calls.length === 1 ? '' : 's'}
          </button>
        )}
      </div>
      {utility.confirmationNumber && (
        <div style={{ color: '#166534', marginTop: 4 }}>
          ✓ Confirmation: <code>{utility.confirmationNumber}</code>
          {utility.toAccountNumber && <> · New account: <code>{utility.toAccountNumber}</code></>}
        </div>
      )}
      {utility.notes && (
        <div style={{ color: '#666', fontSize: 12, marginTop: 4, whiteSpace: 'pre-wrap' }}>
          {utility.notes}
        </div>
      )}
      {showCalls && (
        <div style={{ marginTop: 10 }}>
          {calls.map((c) => (
            <CallRow key={c.id} call={c} />
          ))}
        </div>
      )}
    </div>
  );
}

function CallRow({ call }) {
  const [showTranscript, setShowTranscript] = useState(false);
  return (
    <div style={{ padding: 10, background: '#fafafa', borderRadius: 6, marginBottom: 6, fontSize: 12 }}>
      <div>
        <strong>status:</strong> {call.status}
        {call.outcome && <> · <strong>outcome:</strong> {call.outcome}</>}
        {call.durationSeconds != null && <> · {call.durationSeconds}s</>}
        {call.createdAt && <> · {new Date(call.createdAt).toLocaleString()}</>}
      </div>
      {call.recordingUrl && (
        <div style={{ marginTop: 4 }}>
          <a href={call.recordingUrl} target="_blank" rel="noreferrer">🎧 Recording</a>
        </div>
      )}
      {call.transcript && (
        <div style={{ marginTop: 4 }}>
          <button type="button" onClick={() => setShowTranscript((s) => !s)} style={smallButtonStyle}>
            {showTranscript ? 'Hide' : 'Show'} transcript
          </button>
          {showTranscript && (
            <pre
              style={{
                whiteSpace: 'pre-wrap',
                marginTop: 8,
                padding: 8,
                background: 'white',
                borderRadius: 4,
                fontSize: 11,
                maxHeight: 300,
                overflow: 'auto',
              }}
            >
              {call.transcript}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}

// ── Shared little bits ───────────────────────────────────────────

function FormRow({ label, value, onChange, placeholder, select, type }) {
  return (
    <div style={{ marginBottom: 10 }}>
      <label style={{ fontSize: 12, color: '#666', display: 'block', marginBottom: 4 }}>
        {label}
      </label>
      {select ? (
        <select value={value} onChange={onChange} style={inputStyle}>
          {select.map((opt) => {
            const o = typeof opt === 'string' ? { value: opt, label: opt } : opt;
            return <option key={o.value} value={o.value}>{o.label}</option>;
          })}
        </select>
      ) : (
        <input
          type={type || 'text'}
          value={value || ''}
          onChange={onChange}
          placeholder={placeholder}
          style={inputStyle}
        />
      )}
    </div>
  );
}

function EmptyState({ message }) {
  return <div style={{ padding: 40, textAlign: 'center', color: '#888' }}>{message}</div>;
}

function ErrorBox({ message }) {
  return (
    <div
      style={{
        padding: 12,
        marginBottom: 12,
        background: '#fef2f2',
        color: '#b91c1c',
        border: '1px solid #fecaca',
        borderRadius: 6,
        fontSize: 13,
      }}
    >
      {message}
    </div>
  );
}

const inputStyle = {
  width: '100%',
  padding: '8px 10px',
  fontSize: 14,
  border: '1px solid #d1d5db',
  borderRadius: 6,
  background: 'white',
  boxSizing: 'border-box',
};

const primaryButtonStyle = {
  padding: '10px 16px',
  background: '#1565C0',
  color: 'white',
  border: 'none',
  borderRadius: 6,
  cursor: 'pointer',
  fontSize: 14,
  marginTop: 8,
};

const smallButtonStyle = {
  padding: '4px 10px',
  background: '#f9fafb',
  border: '1px solid #d1d5db',
  borderRadius: 6,
  cursor: 'pointer',
  fontSize: 12,
  display: 'inline-flex',
  alignItems: 'center',
};

const formContainerStyle = {
  padding: 16,
  marginBottom: 16,
  background: '#f9fafb',
  border: '1px solid #e5e7eb',
  borderRadius: 8,
};
