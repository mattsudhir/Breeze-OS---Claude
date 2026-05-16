import { useState, useEffect, useMemo } from 'react';
import {
  Building2, ArrowUpDown, ArrowUp, ArrowDown, ChevronDown, ChevronRight,
  MapPin, Home, CheckCircle2, AlertCircle, Wrench, DollarSign,
  Loader2, User,
} from 'lucide-react';
import { getAdminToken } from '../lib/admin';

// Analytics-style "drilldown" landing page for Properties. Reached from
// the Dashboard → Properties stat card (see ClassicDashboard.jsx). Shows
// a sortable portfolio table with per-property metrics and inline unit
// expansion.
//
// Reads from our own DB via /api/admin/list-properties-summary — no
// more AppFolio passthrough or demo fallback. The endpoint already
// rolls up units, active leases, primary tenants, AR, YTD income/
// expense, and open maintenance count per property in a single round
// trip, so the component just renders.

const COLUMNS = [
  { key: 'name',        label: 'Property',     numeric: false, align: 'left'  },
  { key: 'city',        label: 'City',         numeric: false, align: 'left'  },
  { key: 'totalUnits',  label: 'Units',        numeric: true,  align: 'right' },
  { key: 'occupied',    label: 'Occupied',     numeric: true,  align: 'right' },
  { key: 'vacant',      label: 'Vacant',       numeric: true,  align: 'right' },
  { key: 'occupancy',   label: 'Occupancy',    numeric: true,  align: 'right' },
  { key: 'monthlyRent', label: 'Rent/mo',      numeric: true,  align: 'right' },
  { key: 'openWOs',     label: 'Open WOs',     numeric: true,  align: 'right' },
];

function formatCurrency(n) {
  if (n == null || Number.isNaN(n)) return '—';
  return `$${Math.round(n).toLocaleString('en-US')}`;
}

function centsToDollars(c) {
  return (Number(c) || 0) / 100;
}

export default function PropertiesDrilldown({ initialFilters } = {}) {
  const [properties, setProperties] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [sortKey, setSortKey] = useState('totalUnits');
  const [sortDir, setSortDir] = useState('desc');
  const [expandedId, setExpandedId] = useState(null);
  // When opened from the Properties → Units stat card, expand every
  // row by default so units are visible immediately. The user can
  // still collapse individual rows.
  const [expandAll, setExpandAll] = useState(!!initialFilters?.expandAll);

  useEffect(() => {
    let cancelled = false;
    async function fetchAll() {
      setLoading(true);
      setError(null);
      const token = getAdminToken();
      const qs = token ? `?secret=${encodeURIComponent(token)}` : '';
      try {
        const resp = await fetch(`/api/admin/list-properties-summary${qs}`, {
          headers: token ? { 'X-Breeze-Admin-Token': token } : {},
        });
        const data = await resp.json().catch(() => ({}));
        if (cancelled) return;
        if (!resp.ok || data.ok === false) {
          setError(data.error || `HTTP ${resp.status}`);
          setProperties([]);
        } else {
          setProperties(data.properties || []);
        }
      } catch (err) {
        if (!cancelled) {
          setError(err.message || 'Network error');
          setProperties([]);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    fetchAll();
    return () => { cancelled = true; };
  }, []);

  // Derive a per-property row in the shape the table renders.
  const rows = useMemo(() => {
    if (!properties) return [];
    return properties.map((p) => {
      const totalUnits = p.unit_count || 0;
      const occupied = p.occupied_count || 0;
      const vacant = p.vacant_count ?? Math.max(0, totalUnits - occupied);
      const occupancy = totalUnits > 0 ? Math.round((occupied / totalUnits) * 100) : 0;
      return {
        id: p.id,
        name: p.display_name || '—',
        city: p.address?.city || '',
        state: p.address?.state || '',
        type: p.property_type || '',
        totalUnits,
        occupied,
        vacant,
        occupancy,
        monthlyRent: centsToDollars(p.total_monthly_rent_cents),
        openWOs: p.open_maintenance_count || 0,
        units: (p.units || []).map((u) => ({
          id: u.id,
          name: u.name || '—',
          bedrooms: u.bedrooms,
          bathrooms: u.bathrooms,
          sqft: u.sqft,
          rent: centsToDollars(u.monthly_rent_cents),
          tenantName: u.tenant_name || null,
          isOccupied: !!u.is_occupied,
        })),
      };
    });
  }, [properties]);

  // Apply sort.
  const sortedRows = useMemo(() => {
    const copy = [...rows];
    const col = COLUMNS.find((c) => c.key === sortKey);
    copy.sort((a, b) => {
      const av = a[sortKey];
      const bv = b[sortKey];
      if (col?.numeric) {
        return sortDir === 'asc' ? (av || 0) - (bv || 0) : (bv || 0) - (av || 0);
      }
      const as = String(av || '').toLowerCase();
      const bs = String(bv || '').toLowerCase();
      if (as < bs) return sortDir === 'asc' ? -1 : 1;
      if (as > bs) return sortDir === 'asc' ? 1 : -1;
      return 0;
    });
    return copy;
  }, [rows, sortKey, sortDir]);

  // Portfolio-wide totals.
  const totals = useMemo(() => {
    const t = rows.reduce(
      (acc, r) => ({
        properties: acc.properties + 1,
        units:      acc.units      + r.totalUnits,
        occupied:   acc.occupied   + r.occupied,
        vacant:     acc.vacant     + r.vacant,
        monthlyRent: acc.monthlyRent + r.monthlyRent,
        openWOs:    acc.openWOs    + r.openWOs,
      }),
      { properties: 0, units: 0, occupied: 0, vacant: 0, monthlyRent: 0, openWOs: 0 },
    );
    t.avgOccupancy = t.units > 0 ? Math.round((t.occupied / t.units) * 100) : 0;
    return t;
  }, [rows]);

  const handleSort = (key) => {
    if (sortKey === key) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortKey(key);
      const col = COLUMNS.find((c) => c.key === key);
      setSortDir(col?.numeric ? 'desc' : 'asc');
    }
  };

  const handleRowClick = (id) => {
    // Once the user interacts with any row, drop expand-all mode and
    // fall back to single-row toggling so collapse-one-row works as
    // expected.
    if (expandAll) {
      setExpandAll(false);
      setExpandedId(id);
      return;
    }
    setExpandedId((prev) => (prev === id ? null : id));
  };

  if (loading) {
    return (
      <div className="properties-page">
        <div className="loading-state">
          <Loader2 size={28} className="spin" />
          <span>Loading portfolio drilldown...</span>
        </div>
      </div>
    );
  }

  return (
    <div className="properties-page">
      {error && (
        <div style={{
          display: 'flex', alignItems: 'center', gap: 8,
          padding: '8px 14px', marginBottom: 16, borderRadius: 8,
          fontSize: 12, fontWeight: 600,
          background: '#FFEBEE', color: '#C62828',
          border: '1px solid #FFCDD2',
        }}>
          <AlertCircle size={14} /> Couldn't load portfolio: {error}
        </div>
      )}

      <div className="tenant-detail-topbar">
        <div className="property-detail-header" style={{ flex: 1 }}>
          <div className="wo-detail-icon" style={{ background: '#1565C015', color: '#1565C0' }}>
            <Building2 size={28} />
          </div>
          <div style={{ flex: 1 }}>
            <h2>Properties Drilldown</h2>
            <p className="property-detail-address">
              {totals.properties} properties · {totals.units} units · {totals.avgOccupancy}% avg occupancy · {formatCurrency(totals.monthlyRent)}/mo rent roll
            </p>
          </div>
        </div>
      </div>

      {/* Portfolio KPI strip — inline grid so we don't need new CSS. */}
      <div style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))',
        gap: 12,
        marginBottom: 16,
      }}>
        {[
          { label: 'Properties',       value: totals.properties,                        color: '#1565C0', icon: Building2 },
          { label: 'Total Units',      value: totals.units,                             color: '#0077B6', icon: Home },
          { label: 'Occupied',         value: totals.occupied,                          color: '#2E7D32', icon: CheckCircle2 },
          { label: 'Vacant',           value: totals.vacant,                            color: '#E65100', icon: AlertCircle },
          { label: 'Avg Occupancy',    value: `${totals.avgOccupancy}%`,                color: '#7B1FA2', icon: Home },
          { label: 'Open Work Orders', value: totals.openWOs,                           color: '#C62828', icon: Wrench },
        ].map((kpi) => {
          const Icon = kpi.icon;
          return (
            <div
              key={kpi.label}
              className="dashboard-card"
              style={{ marginBottom: 0, padding: '14px 16px' }}
            >
              <div style={{
                display: 'flex', alignItems: 'center', gap: 8,
                color: '#666', fontSize: 11, fontWeight: 600,
                textTransform: 'uppercase', letterSpacing: '0.05em',
              }}>
                <Icon size={14} style={{ color: kpi.color }} />
                {kpi.label}
              </div>
              <div style={{
                fontSize: 26, fontWeight: 700, color: '#222', marginTop: 4,
              }}>
                {kpi.value}
              </div>
            </div>
          );
        })}
      </div>

      {/* Sortable portfolio table */}
      <div className="dashboard-card">
        <div className="card-header">
          <h3><Building2 size={18} /> Portfolio Breakdown</h3>
          <span style={{ fontSize: 12, color: '#888' }}>
            Click any row to expand unit details
          </span>
        </div>
        <div style={{ overflowX: 'auto' }}>
          <table className="properties-table" style={{ minWidth: 900 }}>
            <thead>
              <tr>
                <th style={{ width: 28 }} />
                {COLUMNS.map((col) => {
                  const active = sortKey === col.key;
                  const SortIcon = !active ? ArrowUpDown : sortDir === 'asc' ? ArrowUp : ArrowDown;
                  return (
                    <th
                      key={col.key}
                      onClick={() => handleSort(col.key)}
                      style={{
                        cursor: 'pointer',
                        userSelect: 'none',
                        textAlign: col.align,
                        whiteSpace: 'nowrap',
                      }}
                    >
                      <span style={{
                        display: 'inline-flex', alignItems: 'center', gap: 4,
                        color: active ? '#1565C0' : undefined,
                      }}>
                        {col.label}
                        <SortIcon size={12} />
                      </span>
                    </th>
                  );
                })}
              </tr>
            </thead>
            <tbody>
              {sortedRows.length === 0 && !loading && (
                <tr>
                  <td colSpan={COLUMNS.length + 1} style={{ padding: 24, textAlign: 'center', color: '#888' }}>
                    No properties found.
                  </td>
                </tr>
              )}
              {sortedRows.map((r) => {
                const expanded = expandAll || expandedId === r.id;
                return (
                  <RowGroup
                    key={r.id}
                    row={r}
                    expanded={expanded}
                    onToggle={() => handleRowClick(r.id)}
                  />
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

// Extracted so we can render the expanded detail row alongside the
// main row without fighting React key warnings on a Fragment inside
// a .map() + nested rows.
function RowGroup({ row, expanded, onToggle }) {
  return (
    <>
      <tr
        onClick={onToggle}
        style={{
          cursor: 'pointer',
          background: expanded ? '#F5F9FF' : undefined,
        }}
      >
        <td style={{ textAlign: 'center', color: '#888' }}>
          {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        </td>
        <td>
          <div style={{ fontWeight: 600 }}>{row.name}</div>
          {row.type && (
            <div style={{ fontSize: 11, color: '#888' }}>{row.type}</div>
          )}
        </td>
        <td>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, color: '#555' }}>
            <MapPin size={12} /> {row.city}{row.state && row.city !== row.state ? `, ${row.state}` : ''}
          </span>
        </td>
        <td style={{ textAlign: 'right', fontWeight: 600 }}>{row.totalUnits}</td>
        <td style={{ textAlign: 'right', color: '#2E7D32' }}>{row.occupied}</td>
        <td style={{ textAlign: 'right', color: row.vacant > 0 ? '#E65100' : '#888' }}>{row.vacant}</td>
        <td style={{ textAlign: 'right' }}>
          <div className="occupancy-bar-container" style={{ maxWidth: 110, marginLeft: 'auto' }}>
            <div className="occupancy-bar" style={{ width: `${row.occupancy}%` }} />
            <span>{row.occupancy}%</span>
          </div>
        </td>
        <td style={{ textAlign: 'right' }}>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
            <DollarSign size={12} style={{ color: '#2E7D32' }} />
            {formatCurrency(row.monthlyRent)}
          </span>
        </td>
        <td style={{ textAlign: 'right' }}>
          {row.openWOs > 0 ? (
            <span style={{
              display: 'inline-flex', alignItems: 'center', gap: 4,
              padding: '2px 8px', borderRadius: 10,
              background: '#FFEBEE', color: '#C62828',
              fontWeight: 600, fontSize: 12,
            }}>
              <Wrench size={11} /> {row.openWOs}
            </span>
          ) : (
            <span style={{ color: '#888' }}>0</span>
          )}
        </td>
      </tr>

      {expanded && (
        <tr style={{ background: '#FAFBFD' }}>
          <td />
          <td colSpan={COLUMNS.length} style={{ padding: '12px 16px 18px' }}>
            <div style={{
              fontSize: 12, fontWeight: 600, color: '#555',
              textTransform: 'uppercase', letterSpacing: '0.05em',
              marginBottom: 8,
            }}>
              Units · {row.units.length}
            </div>
            {row.units.length === 0 ? (
              <div style={{ color: '#888', fontSize: 13 }}>
                No units found for this property.
              </div>
            ) : (
              <div style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))',
                gap: 8,
              }}>
                {row.units.map((u) => (
                  <div
                    key={u.id}
                    style={{
                      padding: '8px 10px',
                      border: '1px solid #E0E0E0',
                      borderRadius: 6,
                      background: 'white',
                      fontSize: 12,
                    }}
                  >
                    <div style={{
                      display: 'flex', justifyContent: 'space-between',
                      alignItems: 'center', marginBottom: 2,
                    }}>
                      <strong>{u.name}</strong>
                      <span style={{
                        display: 'inline-flex', alignItems: 'center', gap: 3,
                        padding: '1px 6px', borderRadius: 8, fontSize: 10, fontWeight: 600,
                        background: u.isOccupied ? '#E8F5E9' : '#FFF3E0',
                        color: u.isOccupied ? '#2E7D32' : '#E65100',
                      }}>
                        {u.isOccupied ? <CheckCircle2 size={10} /> : <AlertCircle size={10} />}
                        {u.isOccupied ? 'Occupied' : 'Vacant'}
                      </span>
                    </div>
                    <div style={{ color: '#666' }}>
                      {u.bedrooms != null ? `${u.bedrooms}bd` : ''}
                      {u.bathrooms != null ? ` · ${u.bathrooms}ba` : ''}
                      {u.sqft != null ? ` · ${u.sqft}sf` : ''}
                      {u.rent > 0 && ` · ${formatCurrency(u.rent)}/mo`}
                    </div>
                    {u.tenantName && (
                      <div style={{
                        marginTop: 4, display: 'inline-flex', alignItems: 'center',
                        gap: 4, color: '#1565C0', fontSize: 11,
                      }}>
                        <User size={10} /> {u.tenantName}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </td>
        </tr>
      )}
    </>
  );
}
