import { useState, useEffect } from 'react';
import {
  Search, Mail, Phone, User, CheckCircle2,
  AlertCircle, Loader2, WifiOff, ChevronLeft, UserCircle2,
  FileText, DollarSign, MapPin, Edit3, Save, X, Home,
  Smartphone, Briefcase, Calendar, Hash, StickyNote
} from 'lucide-react';
import { getTenants, getTenant, updateTenant } from '../services/rentManager';

function getInitials(name) {
  if (!name) return '?';
  const parts = name.trim().split(/\s+/);
  if (parts.length === 1) return parts[0].charAt(0).toUpperCase();
  return (parts[0].charAt(0) + parts[parts.length - 1].charAt(0)).toUpperCase();
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
      const full = await getTenant(tenantId);
      if (!cancelled && full) {
        setTenant(full);
      }
      if (!cancelled) setLoadingDetail(false);
    }
    fetchDetail();
    return () => { cancelled = true; };
  }, [tenantId]);

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
      await updateTenant(tenant.id, form);
      // Optimistically merge and refetch
      const merged = { ...tenant, ...form, name: `${form.firstName} ${form.lastName}`.trim() };
      setTenant(merged);
      setEditing(false);
      setSaveOk(true);
      if (onUpdated) onUpdated(merged);
      // Background refetch to pick up server-side changes
      const fresh = await getTenant(tenant.id);
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
          <button className="btn-primary tenant-edit-btn" onClick={startEdit}>
            <Edit3 size={14} /> Edit
          </button>
        )}
      </div>

      {loadingDetail && (
        <div className="tenant-detail-loading">
          <Loader2 size={14} className="spin" /> Loading full details...
        </div>
      )}

      {saveOk && (
        <div className="save-toast save-toast-ok">
          <CheckCircle2 size={14} /> Changes saved to Rent Manager
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
  const [tenants, setTenants] = useState(null);
  const [loading, setLoading] = useState(true);
  const [isLive, setIsLive] = useState(false);
  const [searchTerm, setSearchTerm] = useState('');
  const [statusFilter, setStatusFilter] = useState('all');
  const [selectedTenantId, setSelectedTenantId] = useState(null);

  useEffect(() => {
    async function fetchData() {
      setLoading(true);
      const data = await getTenants();
      if (data) {
        setTenants(data);
        setIsLive(true);
      }
      setLoading(false);
    }
    fetchData();
  }, []);

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
          <span>Loading tenants from Rent Manager...</span>
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
          <p>Couldn't reach Rent Manager, or the account has no tenants configured.</p>
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
          <><CheckCircle2 size={14} /> Live data from Rent Manager — {tenants.length} tenants</>
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
        {filtered.map((t) => {
          const statusInfo = getStatusInfo(t.status);
          const StatusIcon = statusInfo.icon;
          return (
            <button
              key={t.id}
              className="tenant-row"
              onClick={() => setSelectedTenantId(t.id)}
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
              </div>
              <span className={`unit-status ${statusInfo.className}`}>
                <StatusIcon size={12} />
                {statusInfo.label}
              </span>
            </button>
          );
        })}
      </div>

      {filtered.length === 0 && (
        <div className="empty-state">
          <Search size={32} />
          <p>No tenants match your search</p>
        </div>
      )}
    </div>
  );
}
