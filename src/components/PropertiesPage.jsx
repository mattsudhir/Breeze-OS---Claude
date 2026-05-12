// Properties page — native to Breeze OS's own data model.
//
// Each property card shows: address + entity, unit count, occupancy,
// monthly rent total, open AR, and year-to-date net cash flow. Click
// to expand and see the unit list with current tenant + lease + rent.
//
// Backed by /api/admin/list-properties-summary. Was previously a
// passthrough to AppFolio's API; now reads from our ledger so the
// page works without an active AppFolio connection.

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Building2, Search, MapPin, Users, DollarSign,
  ChevronDown, ChevronRight, AlertCircle, Loader2, Plus, RefreshCw,
  TrendingUp, TrendingDown,
} from 'lucide-react';
import MigrationFixButton from './MigrationFixButton.jsx';

const CLERK_ENABLED = Boolean(import.meta.env.VITE_CLERK_PUBLISHABLE_KEY);
const ADMIN_TOKEN_KEY = 'breeze.admin.token';
const getToken = () => {
  if (CLERK_ENABLED) return 'clerk';
  try { return sessionStorage.getItem(ADMIN_TOKEN_KEY) || ''; } catch { return ''; }
};

function fmtCents(c) {
  const v = (Number(c) || 0) / 100;
  return v.toLocaleString('en-US', { style: 'currency', currency: 'USD' });
}

export default function PropertiesPage() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [search, setSearch] = useState('');
  const [expandedId, setExpandedId] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const url = new URL('/api/admin/list-properties-summary', window.location.origin);
      url.searchParams.set('secret', getToken());
      const res = await fetch(url.toString());
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
      }
      setData(await res.json());
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => { load(); }, [load]);

  const filtered = useMemo(() => {
    if (!data?.properties) return [];
    if (!search.trim()) return data.properties;
    const q = search.trim().toLowerCase();
    return data.properties.filter((p) =>
      p.display_name?.toLowerCase().includes(q) ||
      p.address?.city?.toLowerCase().includes(q) ||
      p.address?.line1?.toLowerCase().includes(q) ||
      p.entity_name?.toLowerCase().includes(q),
    );
  }, [data, search]);

  const totals = useMemo(() => {
    const props = data?.properties || [];
    return {
      properties: props.length,
      units: props.reduce((s, p) => s + p.unit_count, 0),
      occupied: props.reduce((s, p) => s + p.occupied_count, 0),
      monthlyRent: props.reduce((s, p) => s + p.total_monthly_rent_cents, 0),
      openAr: props.reduce((s, p) => s + p.open_ar_cents, 0),
      ytdIncome: props.reduce((s, p) => s + p.ytd_income_cents, 0),
      ytdExpense: props.reduce((s, p) => s + p.ytd_expense_cents, 0),
    };
  }, [data]);
  const occupancyPct = totals.units > 0 ? Math.round((totals.occupied / totals.units) * 100) : 0;

  if (loading) {
    return (
      <div style={{ padding: 32, display: 'flex', alignItems: 'center', gap: 10, color: '#666' }}>
        <Loader2 size={20} className="spin" /> Loading properties…
      </div>
    );
  }

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
    <div style={{ padding: '20px 24px', maxWidth: 1280, margin: '0 auto' }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 16, marginBottom: 18, flexWrap: 'wrap' }}>
        <div style={{
          width: 52, height: 52, borderRadius: 12,
          background: '#1565C015', color: '#1565C0',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
        }}>
          <Building2 size={28} />
        </div>
        <div style={{ flex: 1, minWidth: 240 }}>
          <h2 style={{ margin: 0 }}>Properties</h2>
          <p style={{ color: '#666', marginTop: 4, marginBottom: 0, fontSize: 14 }}>
            Every property under management, with units, occupancy, and year-to-date
            cash flow. Data is read from Breeze's own ledger — no AppFolio dependency.
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

      <div style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))',
        gap: 10,
        marginBottom: 16,
      }}>
        <StatCard label="Properties"    value={totals.properties} />
        <StatCard label="Units" value={`${totals.occupied} / ${totals.units}`} sub={`${occupancyPct}% occupied`} />
        <StatCard label="Monthly rent"  value={fmtCents(totals.monthlyRent)} />
        <StatCard label="Open AR" value={fmtCents(totals.openAr)} color={totals.openAr > 0 ? '#E65100' : '#2E7D32'} />
        <StatCard label="YTD net"
          value={fmtCents(totals.ytdIncome - totals.ytdExpense)}
          color={totals.ytdIncome - totals.ytdExpense >= 0 ? '#2E7D32' : '#C62828'} />
      </div>

      <div style={{ display: 'flex', gap: 10, marginBottom: 14, alignItems: 'center', flexWrap: 'wrap' }}>
        <div style={{ position: 'relative', flex: 1, minWidth: 220, maxWidth: 380 }}>
          <Search size={14} style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', color: '#999' }} />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search name / city / address / entity"
            style={{ width: '100%', padding: '8px 12px 8px 32px', border: '1px solid #CCC', borderRadius: 6, fontSize: 13, boxSizing: 'border-box' }}
          />
        </div>
        <span style={{ fontSize: 13, color: '#666' }}>{filtered.length} of {totals.properties}</span>
      </div>

      {filtered.length === 0 ? (
        <EmptyState totals={totals} />
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))', gap: 12 }}>
          {filtered.map((p) => (
            <PropertyCard
              key={p.id}
              property={p}
              expanded={expandedId === p.id}
              onToggle={() => setExpandedId(expandedId === p.id ? null : p.id)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function StatCard({ label, value, sub, color }) {
  return (
    <div className="dashboard-card" style={{ padding: '10px 14px' }}>
      <div style={{ fontSize: 11, color: '#888', textTransform: 'uppercase', letterSpacing: 0.5 }}>{label}</div>
      <div style={{ fontSize: 18, fontWeight: 700, color: color || '#1A1A1A', fontFamily: 'monospace' }}>{value}</div>
      {sub && <div style={{ fontSize: 11, color: '#888', marginTop: 2 }}>{sub}</div>}
    </div>
  );
}

function PropertyCard({ property, expanded, onToggle }) {
  const occPct = property.unit_count > 0
    ? Math.round((property.occupied_count / property.unit_count) * 100)
    : 0;
  const netPos = property.ytd_net_cents >= 0;
  return (
    <div className="dashboard-card" style={{ padding: 0, overflow: 'hidden' }}>
      <button
        type="button"
        onClick={onToggle}
        style={{
          width: '100%', textAlign: 'left', padding: '14px 16px',
          border: 'none', background: 'white', cursor: 'pointer',
          display: 'flex', flexDirection: 'column', gap: 8,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8 }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontWeight: 700, fontSize: 15, color: '#1A1A1A', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {property.display_name}
            </div>
            <div style={{ fontSize: 12, color: '#666', marginTop: 2, display: 'flex', alignItems: 'center', gap: 4 }}>
              <MapPin size={11} /> {property.address?.line1}, {property.address?.city}, {property.address?.state}
            </div>
            {property.entity_name && (
              <div style={{ fontSize: 11, color: '#1565C0', marginTop: 4 }}>
                <strong>Entity:</strong> {property.entity_name}
              </div>
            )}
          </div>
          {expanded ? <ChevronDown size={18} style={{ color: '#999' }} /> : <ChevronRight size={18} style={{ color: '#999' }} />}
        </div>

        <div style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(80px, 1fr))',
          gap: 8,
          marginTop: 4,
          paddingTop: 8,
          borderTop: '1px solid #F0F0F0',
        }}>
          <MiniStat icon={Users} label="Units" value={`${property.occupied_count}/${property.unit_count}`} sub={`${occPct}%`} />
          <MiniStat icon={DollarSign} label="Rent/mo" value={fmtCents(property.total_monthly_rent_cents)} />
          {property.open_ar_cents > 0 && (
            <MiniStat icon={AlertCircle} label="Open AR" value={fmtCents(property.open_ar_cents)} color="#E65100" />
          )}
          <MiniStat
            icon={netPos ? TrendingUp : TrendingDown}
            label="YTD net"
            value={fmtCents(property.ytd_net_cents)}
            color={netPos ? '#2E7D32' : '#C62828'}
          />
        </div>
      </button>

      {expanded && (
        <div style={{ borderTop: '1px solid #EEE', background: '#FAFAFA', padding: '10px 16px' }}>
          {property.units.length === 0 ? (
            <div style={{ color: '#999', fontSize: 12, padding: '6px 0' }}>
              No units imported for this property yet.
            </div>
          ) : (
            <div style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12, minWidth: 320 }}>
                <thead>
                  <tr style={{ textAlign: 'left', color: '#666', fontWeight: 600 }}>
                    <th style={{ padding: '4px 6px' }}>Unit</th>
                    <th style={{ padding: '4px 6px' }}>Tenant</th>
                    <th style={{ padding: '4px 6px' }}>Lease ends</th>
                    <th style={{ padding: '4px 6px', textAlign: 'right' }}>Rent</th>
                  </tr>
                </thead>
                <tbody>
                  {property.units.map((u) => (
                    <tr key={u.id} style={{ borderTop: '1px solid #EEE' }}>
                      <td style={{ padding: '4px 6px' }}>
                        <div style={{ fontWeight: 600 }}>{u.name}</div>
                        <div style={{ color: '#999', fontSize: 10 }}>
                          {u.bedrooms ? `${u.bedrooms}br` : ''}
                          {u.bathrooms ? ` · ${u.bathrooms}ba` : ''}
                          {u.sqft ? ` · ${u.sqft}sf` : ''}
                        </div>
                      </td>
                      <td style={{ padding: '4px 6px' }}>
                        {u.tenant_name || <span style={{ color: '#999' }}>vacant</span>}
                      </td>
                      <td style={{ padding: '4px 6px', color: '#666' }}>
                        {u.lease_end_date || (u.is_occupied ? <span style={{ color: '#999' }}>m-to-m</span> : '—')}
                      </td>
                      <td style={{ padding: '4px 6px', textAlign: 'right', fontFamily: 'monospace', fontWeight: 600 }}>
                        {u.monthly_rent_cents ? fmtCents(u.monthly_rent_cents) : '—'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function MiniStat({ icon: Icon, label, value, sub, color }) {
  return (
    <div style={{ minWidth: 0 }}>
      <div style={{ fontSize: 10, color: '#888', display: 'flex', alignItems: 'center', gap: 3 }}>
        <Icon size={10} /> {label}
      </div>
      <div style={{ fontSize: 12, fontWeight: 700, color: color || '#1A1A1A', fontFamily: 'monospace', overflow: 'hidden', textOverflow: 'ellipsis' }}>
        {value}
      </div>
      {sub && <div style={{ fontSize: 9, color: '#888' }}>{sub}</div>}
    </div>
  );
}

function EmptyState({ totals }) {
  if (totals.properties === 0) {
    return (
      <div className="dashboard-card" style={{ padding: 24, textAlign: 'center', color: '#666' }}>
        <Plus size={24} style={{ marginBottom: 8, color: '#999' }} />
        <h3 style={{ marginTop: 0, marginBottom: 6 }}>No properties yet</h3>
        <p style={{ fontSize: 13, color: '#888' }}>
          Import a property from AppFolio (Accounting → Entities, then run the
          single-property importer), or add one manually. This page populates
          as soon as Breeze has at least one property + unit on file.
        </p>
      </div>
    );
  }
  return (
    <div className="dashboard-card" style={{ padding: 16, textAlign: 'center', color: '#666' }}>
      No properties match the search.
    </div>
  );
}
