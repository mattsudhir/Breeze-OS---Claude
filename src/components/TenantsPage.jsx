import { useState, useEffect } from 'react';
import {
  Search, Mail, Phone, User, CheckCircle2,
  AlertCircle, Loader2, WifiOff, ChevronLeft, UserCircle2,
  FileText, DollarSign, MapPin, Edit3, Save, X, Home,
  Smartphone, Briefcase, Calendar, Hash, StickyNote
} from 'lucide-react';
import { getTenant, updateTenant } from '../services/data';
import { getAdminToken } from '../lib/admin';

// List tenants from our DB (post-reimport). Returns AppFolio
// source_tenant_id as `id` so the existing detail / edit passthrough
// keeps working against AppFolio without further changes. Detail +
// write migration to our DB is a separate, larger lift; this is the
// list-view-only pass.
async function listTenantsFromBreezeDb() {
  const token = getAdminToken();
  const qs = token ? `?secret=${encodeURIComponent(token)}` : '';
  const resp = await fetch(`/api/admin/list-tenants${qs}`, {
    headers: token ? { 'X-Breeze-Admin-Token': token } : {},
  });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok || data.ok === false) return null;
  return data.tenants || [];
}
import { useDataSource } from '../contexts/DataSourceContext.jsx';
import FollowButton from './FollowButton.jsx';

function getInitials(name) {
  if (!name) return '?';
  const parts = name.trim().split(/\s+/);
  if (parts.length === 1) return parts[0].charAt(0).toUpperCase();
  return (parts[0].charAt(0) + parts[parts.length - 1].charAt(0)).toUpperCase();
}

// Compact tenure pill: ">10y", "3y", "8mo", "2w". Falls back to a
// month string for anything <30 days so a brand-new resident shows
// a useful value instead of "0y".
function tenureLabel(moveInDate) {
  if (!moveInDate) return '';
  const start = new Date(moveInDate).getTime();
  if (Number.isNaN(start)) return '';
  const days = Math.max(0, (Date.now() - start) / 86_400_000);
  if (days < 30) return `${Math.max(1, Math.round(days / 7))}w`;
  const years = days / 365.25;
  if (years >= 1) return `${Math.floor(years)}y`;
  return `${Math.max(1, Math.round(days / 30))}mo`;
}

function getStatusInfo(status) {
  const s = (status || '').toLowerCase();
  if (s.includes('current') || s.includes('active')) {
    return { label: 'Current', className: 'unit-occupied', icon: CheckCircle2 };
  }
  if (s.includes('past') || s.includes('former')) {
    return { label: 'Past', className: 'tenant-status-past', icon: User };
  }
  if (s.includes('future') || s.includes('pending')) {
    return { label: 'Future', className: 'tenant-status-future', icon: AlertCircle };
  }
  if (s.includes('notice')) {
    return { label: 'Notice', className: 'unit-vacant', icon: AlertCircle };
  }
  return { label: status || 'Unknown', className: 'tenant-status-past', icon: User };
}

function avatarColor(str) {
  const colors = [
    'linear-gradient(135deg, #0077B6, #023E8A)',
    'linear-gradient(135deg, #2E7D32, #1B5E20)',
    'linear-gradient(135deg, #E65100, #BF360C)',
    'linear-gradient(135deg, #6A1B9A, #4A148C)',
    'linear-gradient(135deg, #00695C, #004D40)',
    'linear-gradient(135deg, #1565C0, #0D47A1)',
    'linear-gradient(135deg, #C62828, #B71C1C)',
    'linear-gradient(135deg, #00838F, #006064)',
  ];
  let hash = 0;
  for (let i = 0; i < (str || '').length; i++) {
    hash = str.charCodeAt(i) + ((hash << 5) - hash);
  }
  return colors[Math.abs(hash) % colors.length];
}

function formatCurrency(n) {
  if (n === null || n === undefined || isNaN(n)) return '—';
  return `$${Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function formatDate(d) {
  if (!d) return '—';
  try {
    return new Date(d).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
  } catch {
    return d;
  }
}

// ── Detail view with tabs + edit form ──────────────────────────────
function TenantDetail({ tenantId, listTenant, onBack, onUpdated }) {
  const { dataSource, sources } = useDataSource();
  const sourceLabel = sources.find((s) => s.value === dataSource)?.label || dataSource;
  const [showChargeFee, setShowChargeFee] = useState(false);
  const [tenant, setTenant] = useState(listTenant); // seed with list data
  const [loadingDetail, setLoadingDetail] = useState(true);
  const [activeTab, setActiveTab] = useState('overview');
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState(null);
  const [saveOk, setSaveOk] = useState(false);
  const [form, setForm] = useState({});

  useEffect(() => {
    let cancelled = false;
    async function fetchDetail() {
      setLoadingDetail(true);
      const full = await getTenant(dataSource, tenantId);
      if (!cancelled && full) {
        setTenant(full);
      }
      if (!cancelled) setLoadingDetail(false);
    }
    fetchDetail();
    return () => { cancelled = true; };
  }, [tenantId, dataSource]);

  const startEdit = () => {
    setForm({
      firstName: tenant.firstName || '',
      lastName: tenant.lastName || '',
      email: tenant.email || '',
      homePhone: tenant.homePhone || '',
      cellPhone: tenant.cellPhone || '',
      workPhone: tenant.workPhone || '',
      status: tenant.status || '',
      comment: tenant.comment || '',
    });
    setSaveError(null);
    setSaveOk(false);
    setEditing(true);
  };

  const cancelEdit = () => {
    setEditing(false);
    setSaveError(null);
  };

  const saveEdit = async () => {
    setSaving(true);
    setSaveError(null);
    try {
      const result = await updateTenant(dataSource, tenant.id, form);
      // services/data.updateTenant returns { ok: false, error } when
      // the active backend doesn't support edits (AppFolio today).
      // Surface that to the user instead of swallowing.
      if (result && result.ok === false) {
        throw new Error(result.error || 'Update not supported on this data source');
      }
      // Optimistically merge and refetch
      const merged = { ...tenant, ...form, name: `${form.firstName} ${form.lastName}`.trim() };
      setTenant(merged);
      setEditing(false);
      setSaveOk(true);
      if (onUpdated) onUpdated(merged);
      // Background refetch to pick up server-side changes
      const fresh = await getTenant(dataSource, tenant.id);
      if (fresh) setTenant(fresh);
      setTimeout(() => setSaveOk(false), 3000);
    } catch (err) {
      setSaveError(err.message || 'Failed to save changes');
    } finally {
      setSaving(false);
    }
  };

  if (!tenant) return null;
  const statusInfo = getStatusInfo(tenant.status);
  const StatusIcon = statusInfo.icon;

  return (
    <div className="properties-page">
      <button className="back-link" onClick={onBack}>
        <ChevronLeft size={14} /> Back to all tenants
      </button>

      <div className="tenant-detail-topbar">
        <div className="property-detail-header" style={{ flex: 1 }}>
          <div className="tenant-avatar-large" style={{ background: avatarColor(tenant.name) }}>
            {getInitials(tenant.name)}
          </div>
          <div>
            <h2>{tenant.name}</h2>
            <p className="property-detail-address">
              <span className={`unit-status ${statusInfo.className}`}>
                <StatusIcon size={12} />
                {statusInfo.label}
              </span>
              <span className="tenant-display-id">#{tenant.displayId || tenant.id}</span>
            </p>
          </div>
        </div>
        {!editing && (
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <button
              className="btn-secondary"
              onClick={() => setShowChargeFee(true)}
              style={{
                display: 'inline-flex', alignItems: 'center', gap: 6,
                padding: '8px 14px', borderRadius: 6,
                background: '#FFF3E0', color: '#E65100', border: '1px solid #FFE0B2',
                fontWeight: 600, fontSize: 13, cursor: 'pointer',
              }}
            >
              <DollarSign size={14} /> Charge Fee
            </button>
            <button className="btn-primary tenant-edit-btn" onClick={startEdit}>
              <Edit3 size={14} /> Edit
            </button>
          </div>
        )}
      </div>
      {showChargeFee && (
        <ChargeFeeModal
          tenant={tenant}
          dataSource={dataSource}
          onClose={() => setShowChargeFee(false)}
          onSuccess={() => {
            setShowChargeFee(false);
            // Refetch tenant detail so new balance shows
            getTenant(dataSource, tenant.id).then((fresh) => {
              if (fresh) setTenant(fresh);
            });
          }}
        />
      )}

      {loadingDetail && (
        <div className="tenant-detail-loading">
          <Loader2 size={14} className="spin" /> Loading full details...
        </div>
      )}

      {saveOk && (
        <div className="save-toast save-toast-ok">
          <CheckCircle2 size={14} /> Changes saved to {sourceLabel}
        </div>
      )}
      {saveError && (
        <div className="save-toast save-toast-err">
          <AlertCircle size={14} /> {saveError}
        </div>
      )}

      {editing ? (
        <TenantEditForm
          form={form}
          setForm={setForm}
          saving={saving}
          onSave={saveEdit}
          onCancel={cancelEdit}
        />
      ) : (
        <>
          <div className="tenant-tabs">
            <button className={`tenant-tab ${activeTab === 'overview' ? 'active' : ''}`} onClick={() => setActiveTab('overview')}>
              <UserCircle2 size={14} /> Overview
            </button>
            <button className={`tenant-tab ${activeTab === 'lease' ? 'active' : ''}`} onClick={() => setActiveTab('lease')}>
              <FileText size={14} /> Lease
            </button>
            <button className={`tenant-tab ${activeTab === 'balance' ? 'active' : ''}`} onClick={() => setActiveTab('balance')}>
              <DollarSign size={14} /> Balance
            </button>
            <button className={`tenant-tab ${activeTab === 'contacts' ? 'active' : ''}`} onClick={() => setActiveTab('contacts')}>
              <User size={14} /> Contacts
            </button>
            <button className={`tenant-tab ${activeTab === 'notes' ? 'active' : ''}`} onClick={() => setActiveTab('notes')}>
              <StickyNote size={14} /> Notes
            </button>
          </div>

          {activeTab === 'overview' && <OverviewTab tenant={tenant} />}
          {activeTab === 'lease' && <LeaseTab tenant={tenant} />}
          {activeTab === 'balance' && <BalanceTab tenant={tenant} />}
          {activeTab === 'contacts' && <ContactsTab tenant={tenant} />}
          {activeTab === 'notes' && <NotesTab tenant={tenant} />}
        </>
      )}
    </div>
  );
}

// ── Tab: Overview ──────────────────────────────────────────────────
function OverviewTab({ tenant }) {
  return (
    <div className="dashboard-card">
      <div className="card-header">
        <h3><UserCircle2 size={18} /> Contact Information</h3>
      </div>
      <div className="tenant-detail-list">
        <DetailRow icon={Mail} label="Email" value={
          tenant.email ? <a href={`mailto:${tenant.email}`}>{tenant.email}</a> : '—'
        } />
        <DetailRow icon={Home} label="Home Phone" value={
          tenant.homePhone ? <a href={`tel:${tenant.homePhone}`}>{tenant.homePhone}</a> : '—'
        } />
        <DetailRow icon={Smartphone} label="Cell Phone" value={
          tenant.cellPhone ? <a href={`tel:${tenant.cellPhone}`}>{tenant.cellPhone}</a> : '—'
        } />
        <DetailRow icon={Briefcase} label="Work Phone" value={
          tenant.workPhone ? <a href={`tel:${tenant.workPhone}`}>{tenant.workPhone}</a> : '—'
        } />
        <DetailRow icon={MapPin} label="Address" value={
          tenant.primaryAddress
            ? [
                tenant.primaryAddress.Street,
                tenant.primaryAddress.City,
                tenant.primaryAddress.State,
                tenant.primaryAddress.PostalCode,
              ].filter(Boolean).join(', ') || '—'
            : '—'
        } />
        <DetailRow icon={Hash} label="Tenant ID" value={`#${tenant.displayId || tenant.id}`} />
        <DetailRow icon={Calendar} label="Created" value={formatDate(tenant.createDate)} />
      </div>
    </div>
  );
}

// ── Tab: Lease ─────────────────────────────────────────────────────
function LeaseTab({ tenant }) {
  const lease = tenant.currentLease;
  if (!lease && (!tenant.leases || tenant.leases.length === 0)) {
    return (
      <div className="dashboard-card">
        <div className="empty-state">
          <FileText size={32} />
          <p>No lease information available</p>
        </div>
      </div>
    );
  }
  return (
    <div className="dashboard-card">
      <div className="card-header">
        <h3><FileText size={18} /> Current Lease</h3>
      </div>
      <div className="tenant-detail-list">
        <DetailRow icon={Calendar} label="Start Date" value={formatDate(lease?.StartDate)} />
        <DetailRow icon={Calendar} label="End Date" value={formatDate(lease?.EndDate || lease?.MoveOutDate)} />
        <DetailRow icon={DollarSign} label="Monthly Rent" value={formatCurrency(lease?.Rent || lease?.RentAmount)} />
        <DetailRow icon={DollarSign} label="Security Deposit" value={formatCurrency(lease?.SecurityDeposit)} />
        <DetailRow icon={Home} label="Property" value={lease?.PropertyID ? `Property #${lease.PropertyID}` : '—'} />
        <DetailRow icon={Hash} label="Unit" value={lease?.UnitID ? `Unit #${lease.UnitID}` : '—'} />
      </div>
      {tenant.leases && tenant.leases.length > 1 && (
        <div className="lease-history">
          <h4>Lease History ({tenant.leases.length})</h4>
          <ul>
            {tenant.leases.map((l, i) => (
              <li key={i}>
                {formatDate(l.StartDate)} – {formatDate(l.EndDate || l.MoveOutDate)}
                {l.Rent && <span className="lease-rent"> · {formatCurrency(l.Rent)}/mo</span>}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

// ── Tab: Balance ───────────────────────────────────────────────────
function BalanceTab({ tenant }) {
  const charges = tenant.openCharges || [];
  return (
    <div className="dashboard-card">
      <div className="card-header">
        <h3><DollarSign size={18} /> Account Balance</h3>
      </div>
      <div className="balance-summary">
        <span className="balance-label">Current Balance</span>
        <span className={`balance-amount ${tenant.balance > 0 ? 'owed' : ''}`}>
          {formatCurrency(tenant.balance)}
        </span>
      </div>
      {charges.length > 0 ? (
        <table className="properties-table" style={{ marginTop: '16px' }}>
          <thead>
            <tr>
              <th>Date</th>
              <th>Description</th>
              <th style={{ textAlign: 'right' }}>Amount</th>
            </tr>
          </thead>
          <tbody>
            {charges.map((c, i) => (
              <tr key={i}>
                <td>{formatDate(c.Date || c.TransactionDate)}</td>
                <td>{c.Description || c.ChargeType || '—'}</td>
                <td style={{ textAlign: 'right' }}>{formatCurrency(c.Amount)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <p className="muted-text" style={{ marginTop: '12px' }}>No open charges</p>
      )}
    </div>
  );
}

// ── Tab: Contacts ──────────────────────────────────────────────────
function ContactsTab({ tenant }) {
  const contacts = tenant.contacts || [];
  if (contacts.length === 0) {
    return (
      <div className="dashboard-card">
        <div className="empty-state">
          <User size={32} />
          <p>No additional contacts on file</p>
        </div>
      </div>
    );
  }
  return (
    <div className="dashboard-card">
      <div className="card-header">
        <h3><User size={18} /> Emergency & Additional Contacts</h3>
      </div>
      <div className="contacts-list">
        {contacts.map((c, i) => (
          <div key={i} className="contact-row">
            <div className="contact-name">{c.FirstName} {c.LastName}</div>
            <div className="contact-meta">
              {c.Relationship && <span>{c.Relationship}</span>}
              {c.Email && <a href={`mailto:${c.Email}`}>{c.Email}</a>}
              {c.Phone && <a href={`tel:${c.Phone}`}>{c.Phone}</a>}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Tab: Notes ─────────────────────────────────────────────────────
function NotesTab({ tenant }) {
  return (
    <div className="dashboard-card">
      <div className="card-header">
        <h3><StickyNote size={18} /> Notes</h3>
      </div>
      <p className="tenant-notes">
        {tenant.comment || <span className="muted-text">No notes</span>}
      </p>
    </div>
  );
}

// ── Helper: detail row ─────────────────────────────────────────────
function DetailRow({ icon: Icon, label, value }) {
  return (
    <div className="tenant-detail-row">
      <div className="tenant-detail-icon"><Icon size={18} /></div>
      <div className="tenant-detail-info">
        <span className="tenant-detail-label">{label}</span>
        <span className="tenant-detail-value">{value}</span>
      </div>
    </div>
  );
}

// ── Edit form ──────────────────────────────────────────────────────
function TenantEditForm({ form, setForm, saving, onSave, onCancel }) {
  const update = (k) => (e) => setForm({ ...form, [k]: e.target.value });

  return (
    <div className="dashboard-card">
      <div className="card-header">
        <h3><Edit3 size={18} /> Edit Tenant</h3>
      </div>
      <form className="tenant-edit-form" onSubmit={(e) => { e.preventDefault(); onSave(); }}>
        <div className="form-row">
          <label>
            <span>First Name</span>
            <input type="text" value={form.firstName} onChange={update('firstName')} />
          </label>
          <label>
            <span>Last Name</span>
            <input type="text" value={form.lastName} onChange={update('lastName')} />
          </label>
        </div>

        <label>
          <span>Email</span>
          <input type="email" value={form.email} onChange={update('email')} />
        </label>

        <div className="form-row">
          <label>
            <span>Home Phone</span>
            <input type="tel" value={form.homePhone} onChange={update('homePhone')} />
          </label>
          <label>
            <span>Cell Phone</span>
            <input type="tel" value={form.cellPhone} onChange={update('cellPhone')} />
          </label>
          <label>
            <span>Work Phone</span>
            <input type="tel" value={form.workPhone} onChange={update('workPhone')} />
          </label>
        </div>

        <label>
          <span>Status</span>
          <select value={form.status} onChange={update('status')}>
            <option value="">—</option>
            <option value="Current">Current</option>
            <option value="Past">Past</option>
            <option value="Future">Future</option>
            <option value="Notice">Notice</option>
          </select>
        </label>

        <label>
          <span>Notes</span>
          <textarea rows={4} value={form.comment} onChange={update('comment')} />
        </label>

        <div className="form-actions">
          <button type="button" className="btn-secondary" onClick={onCancel} disabled={saving}>
            <X size={14} /> Cancel
          </button>
          <button type="submit" className="btn-primary" disabled={saving}>
            {saving ? <><Loader2 size={14} className="spin" /> Saving...</> : <><Save size={14} /> Save Changes</>}
          </button>
        </div>
      </form>
    </div>
  );
}

// ── Main TenantsPage ───────────────────────────────────────────────
export default function TenantsPage() {
  const { dataSource, sources } = useDataSource();
  const sourceLabel = sources.find((s) => s.value === dataSource)?.label || dataSource;
  const [tenants, setTenants] = useState(null);
  const [loading, setLoading] = useState(true);
  const [isLive, setIsLive] = useState(false);
  const [searchTerm, setSearchTerm] = useState('');
  // Default to 'current' so the first paint isn't 2k+ rows of past
  // tenants — that was locking up the tab on phones, which made the
  // sidebar look unresponsive (the next tap was queued behind a
  // never-finishing render). 'all' is still one chip-click away.
  const [statusFilter, setStatusFilter] = useState('current');
  const [selectedTenantId, setSelectedTenantId] = useState(null);
  // Render cap so a 2200-row "All" view doesn't tank scroll perf.
  // Bumped 250 at a time when the user hits Show more.
  const [renderLimit, setRenderLimit] = useState(250);

  // The list view reads from our DB via /api/admin/list-tenants
  // — fast, accurate, paginated server-side. Detail + edit still
  // talk to AppFolio (legacy passthrough) using the source_tenant_id
  // the list endpoint surfaces as `id`. The dataSource toggle still
  // matters for those, so we re-fetch when it changes.
  useEffect(() => {
    let cancelled = false;
    async function fetchData() {
      setLoading(true);
      const data = await listTenantsFromBreezeDb();
      if (cancelled) return;
      if (data) {
        setTenants(data);
        setIsLive(true);
      } else {
        setTenants(null);
        setIsLive(false);
      }
      setLoading(false);
    }
    fetchData();
    return () => { cancelled = true; };
  }, [dataSource]);

  const handleTenantUpdated = (updated) => {
    setTenants((prev) =>
      prev ? prev.map((t) => (t.id === updated.id ? { ...t, ...updated } : t)) : prev
    );
  };

  if (loading) {
    return (
      <div className="properties-page">
        <div className="loading-state">
          <Loader2 size={28} className="spin" />
          <span>Loading tenants from {sourceLabel}...</span>
        </div>
      </div>
    );
  }

  if (!tenants || tenants.length === 0) {
    return (
      <div className="properties-page">
        <div className="empty-state">
          <WifiOff size={40} />
          <h3>No tenants found</h3>
          <p>Couldn't reach {sourceLabel}, or the account has no tenants configured.</p>
        </div>
      </div>
    );
  }

  // Detail view
  if (selectedTenantId) {
    const listTenant = tenants.find((t) => t.id === selectedTenantId);
    if (!listTenant) {
      setSelectedTenantId(null);
      return null;
    }
    return (
      <TenantDetail
        tenantId={selectedTenantId}
        listTenant={listTenant}
        onBack={() => setSelectedTenantId(null)}
        onUpdated={handleTenantUpdated}
      />
    );
  }

  // Filter
  const filtered = tenants.filter((t) => {
    if (statusFilter !== 'all') {
      const info = getStatusInfo(t.status);
      if (info.label.toLowerCase() !== statusFilter) return false;
    }
    if (searchTerm) {
      const q = searchTerm.toLowerCase();
      return (
        t.name.toLowerCase().includes(q) ||
        (t.email || '').toLowerCase().includes(q) ||
        (t.phone || '').toLowerCase().includes(q)
      );
    }
    return true;
  });

  const statusCounts = tenants.reduce((acc, t) => {
    const label = getStatusInfo(t.status).label.toLowerCase();
    acc[label] = (acc[label] || 0) + 1;
    return acc;
  }, {});
  const activeCount = (statusCounts.current || 0) + (statusCounts.notice || 0);

  return (
    <div className="properties-page">
      <div className="data-source-banner" style={{
        display: 'flex',
        alignItems: 'center',
        gap: '8px',
        padding: '8px 14px',
        marginBottom: '16px',
        borderRadius: '8px',
        fontSize: '12px',
        fontWeight: 600,
        background: isLive ? '#E8F5E9' : '#FFF3E0',
        color: isLive ? '#2E7D32' : '#E65100',
        border: `1px solid ${isLive ? '#C8E6C9' : '#FFE0B2'}`,
      }}>
        {isLive ? (
          <>
            <CheckCircle2 size={14} /> Live data from {sourceLabel} —{' '}
            {activeCount} active ({tenants.length} total incl. past / future)
          </>
        ) : (
          <><WifiOff size={14} /> Demo data</>
        )}
      </div>

      <div className="status-filter-row">
        <button
          className={`status-filter-chip ${statusFilter === 'all' ? 'active' : ''}`}
          onClick={() => setStatusFilter('all')}
        >
          All <span className="chip-count">{tenants.length}</span>
        </button>
        {statusCounts.current && (
          <button
            className={`status-filter-chip ${statusFilter === 'current' ? 'active' : ''}`}
            onClick={() => setStatusFilter('current')}
          >
            Current <span className="chip-count">{statusCounts.current}</span>
          </button>
        )}
        {statusCounts.past && (
          <button
            className={`status-filter-chip ${statusFilter === 'past' ? 'active' : ''}`}
            onClick={() => setStatusFilter('past')}
          >
            Past <span className="chip-count">{statusCounts.past}</span>
          </button>
        )}
        {statusCounts.future && (
          <button
            className={`status-filter-chip ${statusFilter === 'future' ? 'active' : ''}`}
            onClick={() => setStatusFilter('future')}
          >
            Future <span className="chip-count">{statusCounts.future}</span>
          </button>
        )}
        {statusCounts.notice && (
          <button
            className={`status-filter-chip ${statusFilter === 'notice' ? 'active' : ''}`}
            onClick={() => setStatusFilter('notice')}
          >
            On Notice <span className="chip-count">{statusCounts.notice}</span>
          </button>
        )}
      </div>

      <div className="dashboard-search">
        <Search size={18} />
        <input
          type="text"
          placeholder="Search by name, email, or phone..."
          value={searchTerm}
          onChange={(e) => setSearchTerm(e.target.value)}
        />
      </div>

      <div className="tenants-list">
        {filtered.slice(0, renderLimit).map((t) => {
          const statusInfo = getStatusInfo(t.status);
          const StatusIcon = statusInfo.icon;
          return (
            <div
              key={t.id}
              className="tenant-row"
              role="button"
              tabIndex={0}
              onClick={() => setSelectedTenantId(t.id)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  setSelectedTenantId(t.id);
                }
              }}
            >
              <div className="tenant-avatar" style={{ background: avatarColor(t.name) }}>
                {getInitials(t.name)}
              </div>
              <div className="tenant-info">
                <span className="tenant-name">{t.name}</span>
                <div className="tenant-contact">
                  {t.email && (
                    <span className="tenant-contact-item">
                      <Mail size={12} /> {t.email}
                    </span>
                  )}
                  {t.phone && (
                    <span className="tenant-contact-item">
                      <Phone size={12} /> {t.phone}
                    </span>
                  )}
                </div>
                {(t.unitName || t.propertyName || t.rent || t.moveInDate) && (
                  <div
                    className="tenant-meta"
                    style={{
                      display: 'flex', gap: 10, flexWrap: 'wrap',
                      marginTop: 4, fontSize: 11, color: '#6A737D',
                    }}
                  >
                    {(t.unitName || t.propertyName) && (
                      <span style={{
                        display: 'inline-flex', alignItems: 'center', gap: 3,
                      }}>
                        <Home size={11} />
                        {t.unitName
                          ? `${t.unitName}${t.propertyName ? ` · ${t.propertyName}` : ''}`
                          : t.propertyName}
                      </span>
                    )}
                    {t.rent && (
                      <span style={{
                        display: 'inline-flex', alignItems: 'center', gap: 3,
                      }}>
                        <DollarSign size={11} />
                        ${Number(t.rent).toLocaleString()}/mo
                      </span>
                    )}
                    {t.moveInDate && (
                      <span style={{
                        display: 'inline-flex', alignItems: 'center', gap: 3,
                      }} title={`Moved in ${new Date(t.moveInDate).toLocaleDateString()}`}>
                        <Calendar size={11} />
                        {tenureLabel(t.moveInDate)}
                      </span>
                    )}
                  </div>
                )}
              </div>
              <span className={`unit-status ${statusInfo.className}`}>
                <StatusIcon size={12} />
                {statusInfo.label}
              </span>
              <FollowButton
                entityType="tenant"
                entityId={t.id}
                entityLabel={t.name}
              />
            </div>
          );
        })}
      </div>

      {filtered.length > renderLimit && (
        <div style={{
          display: 'flex', justifyContent: 'center', alignItems: 'center',
          gap: 8, padding: '16px 0', flexDirection: 'column',
        }}>
          <span style={{ fontSize: 12, color: '#6A737D' }}>
            Showing {renderLimit} of {filtered.length}
          </span>
          <button
            type="button"
            onClick={() => setRenderLimit((n) => n + 250)}
            style={{
              padding: '8px 14px', border: '1px solid #D0D7DE',
              background: '#FFF', borderRadius: 6, cursor: 'pointer',
              fontSize: 13, fontWeight: 500,
            }}
          >
            Show {Math.min(250, filtered.length - renderLimit)} more
          </button>
        </div>
      )}

      {filtered.length === 0 && (
        <div className="empty-state">
          <Search size={32} />
          <p>No tenants match your search</p>
        </div>
      )}
    </div>
  );
}

// ── Charge Fee modal ───────────────────────────────────────────────
//
// Posts a charge to the tenant's occupancy in AppFolio (existing
// charge_tenant tool). Spawns a Tasks-page review item with a
// 7-day SLA so a second pair of eyes verifies amount + GL account.
// Optional photo attachment uploads via Vercel Blob and rides
// along with the charge as the AppFolio attachment.
function ChargeFeeModal({ tenant, dataSource, onClose, onSuccess }) {
  const [glAccounts, setGlAccounts] = useState([]);
  const [glLoading, setGlLoading] = useState(true);
  const [glError, setGlError] = useState(null);

  // Issue category catalog + saved category→GL mappings from
  // Settings → Charge categories. The category picker auto-fills
  // the GL when chosen so the user doesn't scroll the full GL list
  // on every charge.
  const [issueCategories, setIssueCategories] = useState([]);
  const [categoryMappings, setCategoryMappings] = useState({});
  const [categoryId, setCategoryId] = useState('');

  const [amount, setAmount] = useState('');
  const [glAccount, setGlAccount] = useState('');
  const [description, setDescription] = useState('');
  const [chargedOn, setChargedOn] = useState(
    new Date().toISOString().slice(0, 10),
  );
  const [attachmentUrl, setAttachmentUrl] = useState(null);
  const [attachmentName, setAttachmentName] = useState(null);
  const [uploading, setUploading] = useState(false);

  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (dataSource !== 'appfolio') {
      setGlError('Charge Fee currently requires AppFolio as the active data source.');
      setGlLoading(false);
      return;
    }
    let cancelled = false;
    Promise.all([
      fetch('/api/data', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          source: 'appfolio',
          tool: 'list_gl_accounts',
          input: { limit: 200 },
        }),
      }).then((r) => r.json()),
      fetch('/api/issue-gl-mappings').then((r) => r.json()),
    ])
      .then(([glData, mapData]) => {
        if (cancelled) return;
        if (!glData?.ok) {
          setGlError(glData?.error || 'Could not load GL accounts');
        } else {
          setGlAccounts(glData.data?.accounts || []);
        }
        if (mapData?.ok) {
          setIssueCategories(mapData.categories || []);
          setCategoryMappings(mapData.mappings || {});
        }
      })
      .catch((err) => {
        if (!cancelled) setGlError(err.message || 'Network error');
      })
      .finally(() => {
        if (!cancelled) setGlLoading(false);
      });
    return () => { cancelled = true; };
  }, [dataSource]);

  // Picking a category auto-fills the GL from the saved mapping.
  // Falls back to a name-includes-hint search if no mapping exists
  // yet, so the form is still useful before Settings is configured.
  const handleCategoryChange = (id) => {
    setCategoryId(id);
    if (!id) return;
    const saved = categoryMappings[id];
    if (saved?.glAccountName) {
      setGlAccount(saved.glAccountName);
      return;
    }
    const cat = issueCategories.find((c) => c.id === id);
    const hint = (cat?.glHint || '').toLowerCase();
    if (hint) {
      const match = glAccounts.find((g) => g.name.toLowerCase().includes(hint));
      if (match) setGlAccount(match.name);
    }
  };

  const handleFile = async (e) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setUploading(true);
    setError(null);
    try {
      const { upload: blobUpload } = await import('@vercel/blob/client');
      const blob = await blobUpload(file.name, file, {
        access: 'public',
        handleUploadUrl: '/api/upload',
        contentType: file.type,
      });
      setAttachmentUrl(blob.url);
      setAttachmentName(file.name);
    } catch (err) {
      setError(err.message || 'Upload failed');
    } finally {
      setUploading(false);
    }
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (submitting) return;
    setSubmitting(true);
    setError(null);

    try {
      const numericAmount = Number(amount);
      if (!Number.isFinite(numericAmount) || numericAmount <= 0) {
        throw new Error('Amount must be a positive number');
      }
      if (!glAccount) throw new Error('Pick a GL account');
      if (!description.trim()) throw new Error('Description is required');

      // 1. Post the charge.
      const chargeRes = await fetch('/api/data', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          source: dataSource,
          tool: 'charge_tenant',
          input: {
            tenant_id: tenant.id,
            amount_due: numericAmount.toFixed(2),
            description: description.trim(),
            gl_account: glAccount,
            charged_on: chargedOn,
            attachment_url: attachmentUrl || undefined,
            attachment_filename: attachmentName || undefined,
          },
        }),
      });
      const chargeData = await chargeRes.json().catch(() => ({}));
      if (!chargeRes.ok || !chargeData?.ok) {
        throw new Error(chargeData?.error || `HTTP ${chargeRes.status}`);
      }
      const chargeResult = chargeData.data;
      if (chargeResult?.error) {
        throw new Error(chargeResult.error);
      }

      // 2. Spawn a review task — 7-day SLA per TASK_TYPES.
      try {
        await fetch('/api/human-tasks', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            task_type: 'charge_fee_review',
            title: `Verify $${numericAmount.toFixed(2)} fee charged to ${tenant.name}`,
            description:
              `${description.trim()} · GL: ${chargeResult?.gl_account_name || glAccount}` +
              (attachmentName ? ` · attachment: ${attachmentName}` : ''),
            related_entity_type: 'charge',
            related_entity_id: chargeResult?.charge_id || null,
            priority: 'normal',
            source: 'manual',
            payload: {
              charge_id: chargeResult?.charge_id,
              tenant_id: tenant.id,
              tenant_name: tenant.name,
              amount: numericAmount,
              gl_account: chargeResult?.gl_account_name || glAccount,
              gl_account_id: chargeResult?.gl_account_id,
              charged_on: chargedOn,
              attachment_url: attachmentUrl,
            },
          }),
        });
      } catch (taskErr) {
        console.warn('[charge-fee] task creation failed:', taskErr);
      }

      onSuccess?.();
    } catch (err) {
      setError(err.message || String(err));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)',
        zIndex: 300, display: 'flex', alignItems: 'flex-start', justifyContent: 'center',
        padding: '40px 12px',
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: 'min(480px, 100%)', background: '#FFF', borderRadius: 8,
          padding: 20, boxShadow: '0 12px 28px rgba(0,0,0,0.18)',
          maxHeight: 'calc(100vh - 80px)', overflowY: 'auto',
        }}
      >
        <div style={{
          display: 'flex', justifyContent: 'space-between', alignItems: 'center',
          marginBottom: 12,
        }}>
          <h3 style={{ margin: 0 }}>Charge Fee</h3>
          <button
            type="button"
            onClick={onClose}
            style={{
              background: 'transparent', border: 'none', cursor: 'pointer',
              padding: 4, color: '#6A737D',
            }}
          >
            <X size={18} />
          </button>
        </div>
        <p style={{ fontSize: 12, color: '#6A737D', margin: '0 0 16px' }}>
          Posts a charge to <strong>{tenant.name}</strong>'s occupancy in AppFolio.
          A review task is created automatically with a 7-day SLA.
        </p>
        <form onSubmit={handleSubmit}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            {issueCategories.length > 0 && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                <span style={{ fontSize: 12, fontWeight: 600 }}>Category</span>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                  {issueCategories.map((cat) => {
                    const active = categoryId === cat.id;
                    const mapped = !!categoryMappings[cat.id]?.glAccountName;
                    return (
                      <button
                        key={cat.id}
                        type="button"
                        onClick={() => handleCategoryChange(active ? '' : cat.id)}
                        title={mapped
                          ? `GL: ${categoryMappings[cat.id].glAccountName}`
                          : 'No saved GL — set one in Settings → Charge categories'}
                        style={{
                          padding: '6px 10px',
                          border: `1px solid ${active ? '#1565C0' : '#D0D7DE'}`,
                          background: active ? '#F0F7FF' : '#FFF',
                          color: active ? '#1565C0' : '#1A1A1A',
                          borderRadius: 4, cursor: 'pointer', fontSize: 12,
                          fontWeight: active ? 600 : 500,
                        }}
                      >
                        {cat.label.replace(' Issues', '')}
                      </button>
                    );
                  })}
                </div>
              </div>
            )}
            <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              <span style={{ fontSize: 12, fontWeight: 600 }}>Amount</span>
              <input
                type="number" step="0.01" min="0.01" placeholder="250.00"
                value={amount} onChange={(e) => setAmount(e.target.value)} required
                style={{ padding: 8, border: '1px solid #D0D7DE', borderRadius: 4 }}
              />
            </label>
            <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              <span style={{ fontSize: 12, fontWeight: 600 }}>GL account</span>
              {glLoading ? (
                <div style={{ fontSize: 12, color: '#6A737D' }}>Loading…</div>
              ) : glError ? (
                <input
                  type="text" value={glAccount}
                  onChange={(e) => setGlAccount(e.target.value)}
                  placeholder="Repairs - Plumbing" required
                  style={{ padding: 8, border: '1px solid #D0D7DE', borderRadius: 4 }}
                />
              ) : (
                <select
                  value={glAccount} onChange={(e) => setGlAccount(e.target.value)} required
                  style={{ padding: 8, border: '1px solid #D0D7DE', borderRadius: 4 }}
                >
                  {glAccounts.length === 0 && <option value="">— No repair GL accounts found —</option>}
                  {glAccounts.map((g) => (
                    <option key={g.id} value={g.name}>{g.name}</option>
                  ))}
                </select>
              )}
              {glError && <span style={{ fontSize: 11, color: '#C62828' }}>{glError}</span>}
            </label>
            <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              <span style={{ fontSize: 12, fontWeight: 600 }}>Description</span>
              <input
                type="text" placeholder="Damage to bathroom door — repaired April 15"
                value={description} onChange={(e) => setDescription(e.target.value)} required
                style={{ padding: 8, border: '1px solid #D0D7DE', borderRadius: 4 }}
              />
            </label>
            <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              <span style={{ fontSize: 12, fontWeight: 600 }}>Charge date</span>
              <input
                type="date" value={chargedOn}
                onChange={(e) => setChargedOn(e.target.value)} required
                style={{ padding: 8, border: '1px solid #D0D7DE', borderRadius: 4 }}
              />
            </label>
            <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              <span style={{ fontSize: 12, fontWeight: 600 }}>
                Photo or PDF (optional)
              </span>
              <input
                type="file" accept="image/*,application/pdf"
                onChange={handleFile} disabled={uploading} style={{ fontSize: 12 }}
              />
              {uploading && (
                <span style={{ fontSize: 11, color: '#6A737D', display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                  <Loader2 size={11} className="spin" /> Uploading…
                </span>
              )}
              {attachmentName && !uploading && (
                <span style={{ fontSize: 11, color: '#2E7D32' }}>
                  Attached: {attachmentName}
                </span>
              )}
            </label>
            {error && (
              <div style={{
                padding: '8px 12px', background: '#FFF3F3', border: '1px solid #F5C6CB',
                borderRadius: 6, color: '#C62828', fontSize: 12,
              }}>
                {error}
              </div>
            )}
            <div style={{ display: 'flex', gap: 8, marginTop: 4 }}>
              <button
                type="button" onClick={onClose} disabled={submitting}
                style={{
                  flex: 1, padding: '10px 14px', border: '1px solid #D0D7DE',
                  background: '#FFF', borderRadius: 6, cursor: 'pointer', fontWeight: 500,
                }}
              >
                Cancel
              </button>
              <button
                type="submit" disabled={submitting || uploading}
                style={{
                  flex: 1, padding: '10px 14px', border: 'none',
                  background: '#1565C0', color: 'white', borderRadius: 6,
                  cursor: submitting || uploading ? 'default' : 'pointer', fontWeight: 600,
                }}
              >
                {submitting ? 'Posting…' : 'Post charge'}
              </button>
            </div>
          </div>
        </form>
      </div>
    </div>
  );
}
