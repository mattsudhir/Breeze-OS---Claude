import { useState, useEffect } from 'react';
import {
  Users, Search, Mail, Phone, User, CheckCircle2,
  AlertCircle, Loader2, WifiOff, ChevronLeft, UserCircle2
} from 'lucide-react';
import { getTenants } from '../services/rentManager';

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

// Generate a consistent color from a string (for avatar backgrounds)
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

  // Count by status
  const statusCounts = tenants.reduce((acc, t) => {
    const label = getStatusInfo(t.status).label.toLowerCase();
    acc[label] = (acc[label] || 0) + 1;
    return acc;
  }, {});

  // ── Tenant detail view ────────────────────────────────────────
  if (selectedTenantId) {
    const tenant = tenants.find((t) => t.id === selectedTenantId);
    if (!tenant) {
      setSelectedTenantId(null);
      return null;
    }
    const statusInfo = getStatusInfo(tenant.status);
    const StatusIcon = statusInfo.icon;

    return (
      <div className="properties-page">
        <button className="back-link" onClick={() => setSelectedTenantId(null)}>
          <ChevronLeft size={14} /> Back to all tenants
        </button>

        <div className="property-detail-header">
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
            </p>
          </div>
        </div>

        <div className="dashboard-card">
          <div className="card-header">
            <h3><UserCircle2 size={18} /> Contact Information</h3>
          </div>
          <div className="tenant-detail-list">
            <div className="tenant-detail-row">
              <div className="tenant-detail-icon"><Mail size={18} /></div>
              <div className="tenant-detail-info">
                <span className="tenant-detail-label">Email</span>
                <span className="tenant-detail-value">
                  {tenant.email ? (
                    <a href={`mailto:${tenant.email}`}>{tenant.email}</a>
                  ) : '—'}
                </span>
              </div>
            </div>
            <div className="tenant-detail-row">
              <div className="tenant-detail-icon"><Phone size={18} /></div>
              <div className="tenant-detail-info">
                <span className="tenant-detail-label">Phone</span>
                <span className="tenant-detail-value">
                  {tenant.phone ? (
                    <a href={`tel:${tenant.phone}`}>{tenant.phone}</a>
                  ) : '—'}
                </span>
              </div>
            </div>
            <div className="tenant-detail-row">
              <div className="tenant-detail-icon"><User size={18} /></div>
              <div className="tenant-detail-info">
                <span className="tenant-detail-label">Tenant ID</span>
                <span className="tenant-detail-value">#{tenant.id}</span>
              </div>
            </div>
          </div>
        </div>
      </div>
    );
  }

  // ── Tenants list view ─────────────────────────────────────────
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

      {/* Status filter chips */}
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

      {/* Search */}
      <div className="dashboard-search">
        <Search size={18} />
        <input
          type="text"
          placeholder="Search by name, email, or phone..."
          value={searchTerm}
          onChange={(e) => setSearchTerm(e.target.value)}
        />
      </div>

      {/* Tenants list */}
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
