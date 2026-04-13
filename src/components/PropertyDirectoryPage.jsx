// Property Directory — the first UI built on top of the new Postgres
// backend. Lets you manage Owners (LLCs), Properties, and Utility
// Providers, and see per-property utility configuration.
//
// This is deliberately a minimum-viable admin panel. No fancy state
// management, no react-query, no router, no modal system — just
// useState + fetch + tabs. Once Clerk + a proper shell land in a later
// PR, we can upgrade the primitives.

import { useEffect, useState, useCallback } from 'react';
import { Building2, Users, Zap, Database, RefreshCw, Plus, Trash2 } from 'lucide-react';
import {
  owners as ownersApi,
  properties as propertiesApi,
  propertyUtilities as propertyUtilitiesApi,
  utilityProviders as providersApi,
  seed as seedApi,
  getAdminToken,
  setAdminToken,
  hasAdminToken,
} from '../lib/admin';

const UTILITY_TYPES = ['electric', 'gas', 'water', 'sewer', 'trash', 'internet', 'cable'];
const ACCOUNT_HOLDERS = ['owner_llc', 'tenant'];
const PROPERTY_TYPES = ['sfr', 'multi_family', 'commercial', 'mixed'];
const US_STATES = ['OH', 'MI', 'IN', 'KY', 'PA', 'WV', 'IL'];

// ── Shared token-gate wrapper ────────────────────────────────────

function TokenGate({ children, onTokenSet }) {
  const [value, setValue] = useState(getAdminToken());
  if (hasAdminToken()) return children;
  return (
    <div style={{ padding: 24, maxWidth: 520 }}>
      <h2>Admin token required</h2>
      <p style={{ color: '#666' }}>
        Paste your <code>BREEZE_ADMIN_TOKEN</code> to access the property directory.
        It will be stored in <code>localStorage</code> on this device only.
      </p>
      <input
        type="password"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder="bzadmin_..."
        style={{
          width: '100%',
          padding: 10,
          fontSize: 14,
          border: '1px solid #ccc',
          borderRadius: 6,
        }}
      />
      <button
        type="button"
        onClick={() => {
          setAdminToken(value.trim());
          if (onTokenSet) onTokenSet();
          window.location.reload();
        }}
        disabled={!value.trim()}
        style={{
          marginTop: 12,
          padding: '8px 16px',
          background: '#1565C0',
          color: 'white',
          border: 'none',
          borderRadius: 6,
          cursor: value.trim() ? 'pointer' : 'not-allowed',
          fontSize: 14,
        }}
      >
        Save token
      </button>
    </div>
  );
}

// ── Page shell with tabs ─────────────────────────────────────────

export default function PropertyDirectoryPage() {
  const [tab, setTab] = useState('owners');
  const [, force] = useState(0);
  const refresh = useCallback(() => force((n) => n + 1), []);

  return (
    <TokenGate onTokenSet={refresh}>
      <div style={{ padding: 24, maxWidth: 1100 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16 }}>
          <Database size={24} />
          <h1 style={{ margin: 0 }}>Property Directory</h1>
          <span style={{ color: '#888', fontSize: 14 }}>
            — Owners, Properties, Utility Providers
          </span>
        </div>

        <div style={{ display: 'flex', gap: 8, marginBottom: 24, borderBottom: '1px solid #eee' }}>
          {[
            { id: 'owners', label: 'Owners (LLCs)', icon: Users },
            { id: 'properties', label: 'Properties', icon: Building2 },
            { id: 'providers', label: 'Utility Providers', icon: Zap },
          ].map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              type="button"
              onClick={() => setTab(id)}
              style={{
                padding: '10px 16px',
                background: 'none',
                border: 'none',
                borderBottom: tab === id ? '2px solid #1565C0' : '2px solid transparent',
                color: tab === id ? '#1565C0' : '#666',
                fontSize: 14,
                fontWeight: tab === id ? 600 : 400,
                cursor: 'pointer',
                display: 'flex',
                alignItems: 'center',
                gap: 6,
              }}
            >
              <Icon size={16} />
              {label}
            </button>
          ))}
        </div>

        {tab === 'owners' && <OwnersTab />}
        {tab === 'properties' && <PropertiesTab />}
        {tab === 'providers' && <ProvidersTab />}
      </div>
    </TokenGate>
  );
}

// ── Owners tab ───────────────────────────────────────────────────

function OwnersTab() {
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [creating, setCreating] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    const res = await ownersApi.list();
    setLoading(false);
    if (!res.ok) return setError(res.error);
    setError(null);
    setRows(res.owners || []);
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  return (
    <div>
      <SectionHeader
        title={`${rows.length} owner${rows.length === 1 ? '' : 's'}`}
        onRefresh={load}
        onAdd={() => setCreating((c) => !c)}
        adding={creating}
      />
      {creating && <OwnerForm onSaved={() => { setCreating(false); load(); }} />}
      {loading && <p style={{ color: '#888' }}>Loading…</p>}
      {error && <ErrorBox message={error} />}
      {!loading && !error && rows.length === 0 && (
        <EmptyState
          message="No owners yet. Click + Add to create your first LLC entry."
        />
      )}
      {rows.map((o) => (
        <OwnerRow key={o.id} owner={o} onDeleted={load} />
      ))}
    </div>
  );
}

function OwnerRow({ owner, onDeleted }) {
  const [deleting, setDeleting] = useState(false);
  const handleDelete = async () => {
    if (!confirm(`Delete owner "${owner.legalName}"?`)) return;
    setDeleting(true);
    const res = await ownersApi.delete(owner.id);
    setDeleting(false);
    if (!res.ok) return alert(res.error);
    onDeleted();
  };
  const addr = [
    owner.mailingAddressLine1,
    owner.mailingCity && `${owner.mailingCity}, ${owner.mailingState || ''} ${owner.mailingZip || ''}`.trim(),
  ]
    .filter(Boolean)
    .join(' · ');
  return (
    <div
      style={{
        padding: 16,
        marginBottom: 12,
        border: '1px solid #eee',
        borderRadius: 8,
        background: 'white',
      }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between' }}>
        <div>
          <strong>{owner.legalName}</strong>
          {owner.dba && <span style={{ color: '#888' }}> (dba {owner.dba})</span>}
          {addr && <div style={{ color: '#666', fontSize: 13 }}>{addr}</div>}
          {owner.billingEmail && (
            <div style={{ color: '#888', fontSize: 13 }}>{owner.billingEmail}</div>
          )}
        </div>
        <button
          type="button"
          onClick={handleDelete}
          disabled={deleting}
          style={iconButtonStyle}
          title="Delete owner"
        >
          <Trash2 size={16} />
        </button>
      </div>
    </div>
  );
}

function OwnerForm({ onSaved }) {
  const [form, setForm] = useState({
    legalName: '',
    dba: '',
    mailingAddressLine1: '',
    mailingCity: '',
    mailingState: 'OH',
    mailingZip: '',
    billingEmail: '',
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  const update = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));

  const handleSave = async () => {
    setSaving(true);
    const res = await ownersApi.create(form);
    setSaving(false);
    if (!res.ok) return setError(res.error);
    onSaved();
  };

  return (
    <div style={formContainerStyle}>
      <h3 style={{ marginTop: 0 }}>New owner</h3>
      <FormRow label="Legal name *" value={form.legalName} onChange={update('legalName')} />
      <FormRow label="DBA (optional)" value={form.dba} onChange={update('dba')} />
      <FormRow label="Mailing address" value={form.mailingAddressLine1} onChange={update('mailingAddressLine1')} />
      <div style={{ display: 'flex', gap: 8 }}>
        <FormRow style={{ flex: 2 }} label="City" value={form.mailingCity} onChange={update('mailingCity')} />
        <FormRow style={{ flex: 1 }} label="State" value={form.mailingState} onChange={update('mailingState')} select={US_STATES} />
        <FormRow style={{ flex: 1 }} label="ZIP" value={form.mailingZip} onChange={update('mailingZip')} />
      </div>
      <FormRow label="Billing email" value={form.billingEmail} onChange={update('billingEmail')} />
      {error && <ErrorBox message={error} />}
      <button type="button" onClick={handleSave} disabled={!form.legalName || saving} style={primaryButtonStyle}>
        {saving ? 'Saving…' : 'Create owner'}
      </button>
    </div>
  );
}

// ── Properties tab ───────────────────────────────────────────────

function PropertiesTab() {
  const [rows, setRows] = useState([]);
  const [ownerMap, setOwnerMap] = useState({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [creating, setCreating] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    const [propRes, ownerRes] = await Promise.all([propertiesApi.list(), ownersApi.list()]);
    setLoading(false);
    if (!propRes.ok) return setError(propRes.error);
    if (!ownerRes.ok) return setError(ownerRes.error);
    setError(null);
    setRows(propRes.properties || []);
    setOwnerMap(
      Object.fromEntries((ownerRes.owners || []).map((o) => [o.id, o])),
    );
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  return (
    <div>
      <SectionHeader
        title={`${rows.length} propert${rows.length === 1 ? 'y' : 'ies'}`}
        onRefresh={load}
        onAdd={() => setCreating((c) => !c)}
        adding={creating}
      />
      {creating && (
        <PropertyForm
          ownerOptions={Object.values(ownerMap)}
          onSaved={() => { setCreating(false); load(); }}
        />
      )}
      {loading && <p style={{ color: '#888' }}>Loading…</p>}
      {error && <ErrorBox message={error} />}
      {!loading && !error && rows.length === 0 && (
        <EmptyState message="No properties yet. Create an owner first, then add a property." />
      )}
      {rows.map((p) => (
        <PropertyRow key={p.id} property={p} owner={ownerMap[p.ownerId]} onDeleted={load} />
      ))}
    </div>
  );
}

function PropertyRow({ property, owner, onDeleted }) {
  const [expanded, setExpanded] = useState(false);
  const [utilities, setUtilities] = useState([]);
  const [loadingUtils, setLoadingUtils] = useState(false);

  const loadUtilities = useCallback(async () => {
    setLoadingUtils(true);
    const res = await propertyUtilitiesApi.list(property.id);
    setLoadingUtils(false);
    if (res.ok) setUtilities(res.utilities || []);
  }, [property.id]);

  useEffect(() => {
    if (expanded) loadUtilities();
  }, [expanded, loadUtilities]);

  const handleDelete = async () => {
    if (!confirm(`Delete property "${property.displayName}"?`)) return;
    const res = await propertiesApi.delete(property.id);
    if (!res.ok) return alert(res.error);
    onDeleted();
  };

  const addr = `${property.serviceAddressLine1}, ${property.serviceCity}, ${property.serviceState} ${property.serviceZip}`;

  return (
    <div
      style={{
        padding: 16,
        marginBottom: 12,
        border: '1px solid #eee',
        borderRadius: 8,
        background: 'white',
      }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between' }}>
        <div style={{ flex: 1, cursor: 'pointer' }} onClick={() => setExpanded((e) => !e)}>
          <strong>{property.displayName}</strong>
          <span style={{ color: '#888', fontSize: 13, marginLeft: 8 }}>{property.propertyType}</span>
          <div style={{ color: '#666', fontSize: 13 }}>{addr}</div>
          <div style={{ color: '#888', fontSize: 12 }}>
            Owner: {owner?.legalName || '(unknown)'}
          </div>
        </div>
        <button type="button" onClick={handleDelete} style={iconButtonStyle} title="Delete property">
          <Trash2 size={16} />
        </button>
      </div>
      {expanded && (
        <div style={{ marginTop: 12, paddingTop: 12, borderTop: '1px solid #eee' }}>
          <PropertyUtilitiesPanel
            propertyId={property.id}
            utilities={utilities}
            loading={loadingUtils}
            onChanged={loadUtilities}
          />
        </div>
      )}
    </div>
  );
}

function PropertyForm({ ownerOptions, onSaved }) {
  const [form, setForm] = useState({
    ownerId: ownerOptions[0]?.id || '',
    displayName: '',
    propertyType: 'sfr',
    serviceAddressLine1: '',
    serviceCity: '',
    serviceState: 'OH',
    serviceZip: '',
    billingAddressLine1: '',
    billingCity: '',
    billingState: '',
    billingZip: '',
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  const update = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));

  const handleSave = async () => {
    setSaving(true);
    // Drop empty billing fields so they're stored as NULL rather than
    // empty strings (cleaner queries later).
    const payload = { ...form };
    for (const k of Object.keys(payload)) {
      if (payload[k] === '') payload[k] = null;
    }
    const res = await propertiesApi.create(payload);
    setSaving(false);
    if (!res.ok) return setError(res.error);
    onSaved();
  };

  return (
    <div style={formContainerStyle}>
      <h3 style={{ marginTop: 0 }}>New property</h3>
      <FormRow label="Owner (LLC) *" value={form.ownerId} onChange={update('ownerId')} select={ownerOptions.map((o) => ({ value: o.id, label: o.legalName }))} />
      <FormRow label="Display name *" value={form.displayName} onChange={update('displayName')} placeholder="105 Southard Ave" />
      <FormRow label="Property type" value={form.propertyType} onChange={update('propertyType')} select={PROPERTY_TYPES} />
      <h4 style={{ marginBottom: 4 }}>Service address</h4>
      <FormRow label="Street *" value={form.serviceAddressLine1} onChange={update('serviceAddressLine1')} />
      <div style={{ display: 'flex', gap: 8 }}>
        <FormRow style={{ flex: 2 }} label="City *" value={form.serviceCity} onChange={update('serviceCity')} />
        <FormRow style={{ flex: 1 }} label="State *" value={form.serviceState} onChange={update('serviceState')} select={US_STATES} />
        <FormRow style={{ flex: 1 }} label="ZIP *" value={form.serviceZip} onChange={update('serviceZip')} />
      </div>
      <h4 style={{ marginBottom: 4 }}>Billing address <span style={{ color: '#888', fontWeight: 400 }}>(optional — falls back to owner)</span></h4>
      <FormRow label="Street" value={form.billingAddressLine1} onChange={update('billingAddressLine1')} />
      <div style={{ display: 'flex', gap: 8 }}>
        <FormRow style={{ flex: 2 }} label="City" value={form.billingCity} onChange={update('billingCity')} />
        <FormRow style={{ flex: 1 }} label="State" value={form.billingState} onChange={update('billingState')} select={['', ...US_STATES]} />
        <FormRow style={{ flex: 1 }} label="ZIP" value={form.billingZip} onChange={update('billingZip')} />
      </div>
      {error && <ErrorBox message={error} />}
      <button
        type="button"
        onClick={handleSave}
        disabled={!form.ownerId || !form.displayName || !form.serviceAddressLine1 || saving}
        style={primaryButtonStyle}
      >
        {saving ? 'Saving…' : 'Create property'}
      </button>
    </div>
  );
}

// ── Per-property utility config ──────────────────────────────────

function PropertyUtilitiesPanel({ propertyId, utilities, loading, onChanged }) {
  const [providers, setProviders] = useState([]);
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState({
    utilityType: 'electric',
    providerId: '',
    accountHolder: 'tenant',
    billbackTenant: false,
    currentAccountNumber: '',
    notes: '',
  });

  useEffect(() => {
    providersApi.list().then((res) => {
      if (res.ok) setProviders(res.providers || []);
    });
  }, []);

  const handleAdd = async () => {
    const payload = {
      propertyId,
      ...form,
      providerId: form.providerId || null,
    };
    const res = await propertyUtilitiesApi.create(payload);
    if (!res.ok) return alert(res.error);
    setAdding(false);
    setForm((f) => ({ ...f, currentAccountNumber: '', notes: '' }));
    onChanged();
  };

  const handleDelete = async (id) => {
    if (!confirm('Delete this utility row?')) return;
    const res = await propertyUtilitiesApi.delete(id);
    if (!res.ok) return alert(res.error);
    onChanged();
  };

  const providerMap = Object.fromEntries(providers.map((p) => [p.id, p]));

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
        <strong style={{ fontSize: 14 }}>Utilities ({utilities.length})</strong>
        <button type="button" onClick={() => setAdding((a) => !a)} style={smallButtonStyle}>
          {adding ? 'Cancel' : '+ Add'}
        </button>
      </div>
      {loading && <p style={{ color: '#888', fontSize: 13 }}>Loading…</p>}
      {!loading && utilities.length === 0 && !adding && (
        <p style={{ color: '#888', fontSize: 13 }}>No utilities configured.</p>
      )}
      {utilities.map((u) => (
        <div key={u.id} style={{ display: 'flex', justifyContent: 'space-between', padding: 8, borderBottom: '1px solid #f3f3f3', fontSize: 13 }}>
          <div>
            <strong>{u.utilityType}</strong>
            <span style={{ color: '#666', marginLeft: 8 }}>
              → {u.accountHolder === 'owner_llc' ? 'LLC-held' : 'Tenant-held'}
            </span>
            {u.billbackTenant && <span style={{ color: '#E65100', marginLeft: 8 }}>billback</span>}
            {u.providerId && (
              <span style={{ color: '#888', marginLeft: 8 }}>
                via {providerMap[u.providerId]?.name || u.providerId}
              </span>
            )}
            {u.currentAccountNumber && (
              <span style={{ color: '#888', marginLeft: 8 }}>acct {u.currentAccountNumber}</span>
            )}
          </div>
          <button type="button" onClick={() => handleDelete(u.id)} style={iconButtonStyle}>
            <Trash2 size={14} />
          </button>
        </div>
      ))}
      {adding && (
        <div style={{ marginTop: 12, padding: 12, background: '#fafafa', borderRadius: 6 }}>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <FormRow style={{ flex: 1, minWidth: 120 }} label="Type" value={form.utilityType} onChange={(e) => setForm({ ...form, utilityType: e.target.value })} select={UTILITY_TYPES} />
            <FormRow style={{ flex: 2, minWidth: 160 }} label="Provider" value={form.providerId} onChange={(e) => setForm({ ...form, providerId: e.target.value })} select={[{ value: '', label: '(none)' }, ...providers.map((p) => ({ value: p.id, label: p.name }))]} />
            <FormRow style={{ flex: 1, minWidth: 120 }} label="Account holder" value={form.accountHolder} onChange={(e) => setForm({ ...form, accountHolder: e.target.value })} select={ACCOUNT_HOLDERS} />
          </div>
          <FormRow label="Account # (optional)" value={form.currentAccountNumber} onChange={(e) => setForm({ ...form, currentAccountNumber: e.target.value })} />
          <label style={{ fontSize: 13, display: 'flex', alignItems: 'center', gap: 6 }}>
            <input type="checkbox" checked={form.billbackTenant} onChange={(e) => setForm({ ...form, billbackTenant: e.target.checked })} />
            Bill back to tenant (even if LLC holds the account)
          </label>
          <button type="button" onClick={handleAdd} style={{ ...primaryButtonStyle, marginTop: 8 }}>
            Add utility
          </button>
        </div>
      )}
    </div>
  );
}

// ── Providers tab ────────────────────────────────────────────────

function ProvidersTab() {
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [seeding, setSeeding] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    const res = await providersApi.list();
    setLoading(false);
    if (!res.ok) return setError(res.error);
    setError(null);
    setRows(res.providers || []);
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const handleSeed = async () => {
    if (!confirm('Run the Ohio utility providers seed? Existing providers will not be touched.')) return;
    setSeeding(true);
    const res = await seedApi.run();
    setSeeding(false);
    if (!res.ok) return alert(res.error);
    alert(`Seed complete — ${res.createdCount} created, ${res.skippedCount} skipped.`);
    load();
  };

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
        <div>
          <strong>{rows.length} provider{rows.length === 1 ? '' : 's'}</strong>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button type="button" onClick={load} style={smallButtonStyle}>
            <RefreshCw size={14} style={{ marginRight: 4 }} /> Refresh
          </button>
          <button type="button" onClick={handleSeed} disabled={seeding} style={smallButtonStyle}>
            {seeding ? 'Seeding…' : 'Run seed'}
          </button>
        </div>
      </div>
      {loading && <p style={{ color: '#888' }}>Loading…</p>}
      {error && <ErrorBox message={error} />}
      {!loading && !error && rows.length === 0 && (
        <EmptyState message={'No providers yet. Click "Run seed" to populate common Ohio utilities.'} />
      )}
      {rows.map((p) => (
        <div
          key={p.id}
          style={{
            padding: 12,
            marginBottom: 8,
            border: '1px solid #eee',
            borderRadius: 6,
            background: 'white',
            fontSize: 14,
          }}
        >
          <strong>{p.name}</strong>
          <span style={{ color: '#888', marginLeft: 8 }}>{p.phoneNumber}</span>
          {p.expectedHoldMinutes && (
            <span style={{ color: '#888', marginLeft: 8 }}>
              ~{p.expectedHoldMinutes} min hold
            </span>
          )}
          {p.callScriptNotes && (
            <div style={{ color: '#666', fontSize: 12, marginTop: 4 }}>{p.callScriptNotes}</div>
          )}
        </div>
      ))}
    </div>
  );
}

// ── Small shared primitives ──────────────────────────────────────

function SectionHeader({ title, onRefresh, onAdd, adding }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
      <strong>{title}</strong>
      <div style={{ display: 'flex', gap: 8 }}>
        <button type="button" onClick={onRefresh} style={smallButtonStyle}>
          <RefreshCw size={14} style={{ marginRight: 4 }} /> Refresh
        </button>
        <button type="button" onClick={onAdd} style={smallButtonStyle}>
          <Plus size={14} style={{ marginRight: 4 }} /> {adding ? 'Cancel' : 'Add'}
        </button>
      </div>
    </div>
  );
}

function FormRow({ label, value, onChange, placeholder, select, style }) {
  return (
    <div style={{ marginBottom: 10, ...style }}>
      <label style={{ fontSize: 12, color: '#666', display: 'block', marginBottom: 4 }}>
        {label}
      </label>
      {select ? (
        <select value={value} onChange={onChange} style={inputStyle}>
          {(Array.isArray(select) ? select : []).map((opt) => {
            if (typeof opt === 'string') return <option key={opt} value={opt}>{opt || '(none)'}</option>;
            return <option key={opt.value} value={opt.value}>{opt.label}</option>;
          })}
        </select>
      ) : (
        <input type="text" value={value || ''} onChange={onChange} placeholder={placeholder} style={inputStyle} />
      )}
    </div>
  );
}

function EmptyState({ message }) {
  return (
    <div style={{ padding: 40, textAlign: 'center', color: '#888' }}>
      {message}
    </div>
  );
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

// ── Styles ───────────────────────────────────────────────────────

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
  padding: '6px 12px',
  background: '#f9fafb',
  border: '1px solid #d1d5db',
  borderRadius: 6,
  cursor: 'pointer',
  fontSize: 13,
  display: 'flex',
  alignItems: 'center',
};

const iconButtonStyle = {
  padding: 8,
  background: 'none',
  border: 'none',
  borderRadius: 6,
  cursor: 'pointer',
  color: '#888',
};

const formContainerStyle = {
  padding: 16,
  marginBottom: 16,
  background: '#f9fafb',
  border: '1px solid #e5e7eb',
  borderRadius: 8,
};
