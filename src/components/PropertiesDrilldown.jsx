import { useState, useEffect, useMemo } from 'react';
import {
  Building2, ArrowUpDown, ArrowUp, ArrowDown, ChevronDown, ChevronRight,
  MapPin, Home, CheckCircle2, AlertCircle, Wrench, DollarSign,
  Loader2, WifiOff,
} from 'lucide-react';
import { getProperties, getUnits, getWorkOrders } from '../services/data';
import { useDataSource } from '../contexts/DataSourceContext.jsx';

// Analytics-style "drilldown" landing page for Properties. Reached from
// the Dashboard → Properties stat card (see ClassicDashboard.jsx). Shows
// a sortable portfolio table with per-property metrics and inline unit
// expansion, on top of the same RM endpoints the sidebar PropertiesPage
// uses. Sidebar "Properties" still goes to the simpler list view so we
// have one landing place per context.

// ── Demo fallback — mirrors the rent-manager service return shape so
// the rest of this component doesn't need conditional logic when we're
// offline or RM auth hits the max-sessions cap. ──────────────────────

const DEMO_PROPERTIES = [
  { id: 1, name: 'Oakwood Apartments', city: 'Portland', state: 'OR', type: 'Multifamily' },
  { id: 2, name: 'Maple Ridge Complex', city: 'Portland', state: 'OR', type: 'Multifamily' },
  { id: 3, name: 'Pine Valley Homes', city: 'Beaverton', state: 'OR', type: 'Single Family' },
  { id: 4, name: 'Birchwood Commons', city: 'Lake Oswego', state: 'OR', type: 'Multifamily' },
  { id: 5, name: 'Cedar Court', city: 'Portland', state: 'OR', type: 'Multifamily' },
  { id: 6, name: 'Riverside Lofts', city: 'Portland', state: 'OR', type: 'Mixed Use' },
];

const DEMO_UNITS = [
  // Oakwood — 10 units, 9 occupied
  ...Array.from({ length: 10 }, (_, i) => ({
    id: 100 + i, propertyId: 1, name: `Unit ${101 + i}`,
    status: i < 9 ? 'Occupied' : 'Vacant', bedrooms: i % 3 + 1, bathrooms: 1,
    marketRent: 1800 + i * 25,
  })),
  // Maple Ridge — 12 units, 11 occupied
  ...Array.from({ length: 12 }, (_, i) => ({
    id: 200 + i, propertyId: 2, name: `Unit ${i + 1}B`,
    status: i < 11 ? 'Occupied' : 'Vacant', bedrooms: 2, bathrooms: 1,
    marketRent: 1875 + i * 15,
  })),
  // Pine Valley — 6 units, 5 occupied
  ...Array.from({ length: 6 }, (_, i) => ({
    id: 300 + i, propertyId: 3, name: `Unit ${500 + i}`,
    status: i < 5 ? 'Occupied' : 'Vacant', bedrooms: 3, bathrooms: 2,
    marketRent: 2100 + i * 40,
  })),
  // Birchwood — 8 units, 8 occupied
  ...Array.from({ length: 8 }, (_, i) => ({
    id: 400 + i, propertyId: 4, name: `Unit ${400 + i}`,
    status: 'Occupied', bedrooms: 2, bathrooms: 1,
    marketRent: 1950 + i * 20,
  })),
  // Cedar Court — 6 units, 4 occupied
  ...Array.from({ length: 6 }, (_, i) => ({
    id: 500 + i, propertyId: 5, name: `Unit ${i + 1}A`,
    status: i < 4 ? 'Occupied' : 'Vacant', bedrooms: 1, bathrooms: 1,
    marketRent: 1650 + i * 10,
  })),
  // Riverside — 4 units, 3 occupied
  ...Array.from({ length: 4 }, (_, i) => ({
    id: 600 + i, propertyId: 6, name: `Unit ${i + 1}`,
    status: i < 3 ? 'Occupied' : 'Vacant', bedrooms: 2, bathrooms: 2,
    marketRent: 2250 + i * 30,
  })),
];

const DEMO_WORK_ORDERS = [
  { id: 1, propertyId: 1, isClosed: false }, { id: 2, propertyId: 1, isClosed: false },
  { id: 3, propertyId: 2, isClosed: false }, { id: 4, propertyId: 2, isClosed: false },
  { id: 5, propertyId: 2, isClosed: false }, { id: 6, propertyId: 3, isClosed: false },
  { id: 7, propertyId: 4, isClosed: false }, { id: 8, propertyId: 5, isClosed: false },
  { id: 9, propertyId: 5, isClosed: false }, { id: 10, propertyId: 5, isClosed: false },
  { id: 11, propertyId: 6, isClosed: false },
];

// ── Sorting ──────────────────────────────────────────────────────

const COLUMNS = [
  { key: 'name', label: 'Property', numeric: false, align: 'left' },
  { key: 'city', label: 'City', numeric: false, align: 'left' },
  { key: 'totalUnits', label: 'Units', numeric: true, align: 'right' },
  { key: 'occupied', label: 'Occupied', numeric: true, align: 'right' },
  { key: 'vacant', label: 'Vacant', numeric: true, align: 'right' },
  { key: 'occupancy', label: 'Occupancy', numeric: true, align: 'right' },
  { key: 'estRent', label: 'Est. Rent/mo', numeric: true, align: 'right' },
  { key: 'openWOs', label: 'Open WOs', numeric: true, align: 'right' },
];

function formatCurrency(n) {
  if (n == null || Number.isNaN(n)) return '—';
  return `$${Math.round(n).toLocaleString('en-US')}`;
}

export default function PropertiesDrilldown() {
  const { dataSource, sources } = useDataSource();
  const sourceLabel = sources.find((s) => s.value === dataSource)?.label || dataSource;
  const [properties, setProperties] = useState(null);
  const [units, setUnits] = useState(null);
  const [workOrders, setWorkOrders] = useState(null);
  const [loading, setLoading] = useState(true);
  const [isLive, setIsLive] = useState(false);
  const [sortKey, setSortKey] = useState('totalUnits');
  const [sortDir, setSortDir] = useState('desc');
  const [expandedId, setExpandedId] = useState(null);

  useEffect(() => {
    let cancelled = false;
    async function fetchAll() {
      setLoading(true);
      const results = await Promise.allSettled([
        getProperties(dataSource),
        getUnits(dataSource),
        getWorkOrders(dataSource, { status: 'all' }),
      ]);
      if (cancelled) return;
      const [propsRes, unitsRes, woRes] = results;
      const propsData = propsRes.status === 'fulfilled' ? propsRes.value : null;
      const unitsData = unitsRes.status === 'fulfilled' ? unitsRes.value : null;
      const woData = woRes.status === 'fulfilled' ? woRes.value : null;

      // If RM returned something, use it; otherwise fall back to demo.
      if (propsData && propsData.length > 0) {
        setProperties(propsData);
        setUnits(unitsData || []);
        setWorkOrders(woData || []);
        setIsLive(true);
      } else {
        setProperties(DEMO_PROPERTIES);
        setUnits(DEMO_UNITS);
        setWorkOrders(DEMO_WORK_ORDERS);
        setIsLive(false);
      }
      setLoading(false);
    }
    fetchAll();
    return () => { cancelled = true; };
  }, [dataSource]);

  // Group units by both propertyId and propertyName. AppFolio
  // sometimes surfaces only the name on a unit row (multi-unit
  // configs), so a strict id match silently shows 0 units in the
  // expand panel — that's what the "click row, page just refreshes"
  // regression looked like. Mirrors the fallback in PropertiesPage.
  const unitsByPropertyId = useMemo(() => {
    return (units || []).reduce((acc, u) => {
      if (!u.propertyId) return acc;
      (acc[u.propertyId] ||= []).push(u);
      return acc;
    }, {});
  }, [units]);
  const unitsByPropertyName = useMemo(() => {
    return (units || []).reduce((acc, u) => {
      if (!u.propertyName) return acc;
      (acc[u.propertyName] ||= []).push(u);
      return acc;
    }, {});
  }, [units]);

  // Derived per-property rows with all the metrics.
  const rows = useMemo(() => {
    if (!properties) return [];
    return properties.map((p) => {
      const propUnits =
        unitsByPropertyId[p.id] || unitsByPropertyName[p.name] || [];
      const totalUnits = propUnits.length;
      const occupied = propUnits.filter((u) => {
        const s = (u.status || '').toLowerCase();
        return s.includes('occupied') || s.includes('current');
      }).length;
      const vacant = totalUnits - occupied;
      const occupancy = totalUnits > 0 ? Math.round((occupied / totalUnits) * 100) : 0;
      const estRent = propUnits
        .filter((u) => {
          const s = (u.status || '').toLowerCase();
          return s.includes('occupied') || s.includes('current');
        })
        .reduce((sum, u) => sum + (Number(u.marketRent) || 0), 0);
      const openWOs = (workOrders || []).filter(
        (w) => w.propertyId === p.id && !w.isClosed,
      ).length;
      return {
        id: p.id,
        name: p.name,
        city: p.city || p.state || '',
        state: p.state || '',
        type: p.type || '',
        totalUnits,
        occupied,
        vacant,
        occupancy,
        estRent,
        openWOs,
        units: propUnits,
      };
    });
  }, [properties, units, workOrders, unitsByPropertyId, unitsByPropertyName]);

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

  // Portfolio-wide totals (recomputed from the current rows so they
  // stay consistent with whatever data source is in use).
  const totals = useMemo(() => {
    const t = rows.reduce(
      (acc, r) => ({
        properties: acc.properties + 1,
        units: acc.units + r.totalUnits,
        occupied: acc.occupied + r.occupied,
        vacant: acc.vacant + r.vacant,
        estRent: acc.estRent + r.estRent,
        openWOs: acc.openWOs + r.openWOs,
      }),
      { properties: 0, units: 0, occupied: 0, vacant: 0, estRent: 0, openWOs: 0 },
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
      <div className="data-source-banner" style={{
        display: 'flex', alignItems: 'center', gap: '8px',
        padding: '8px 14px', marginBottom: '16px', borderRadius: '8px',
        fontSize: '12px', fontWeight: 600,
        background: isLive ? '#E8F5E9' : '#FFF3E0',
        color: isLive ? '#2E7D32' : '#E65100',
        border: `1px solid ${isLive ? '#C8E6C9' : '#FFE0B2'}`,
      }}>
        {isLive ? (
          <><CheckCircle2 size={14} /> Live portfolio data from {sourceLabel}</>
        ) : (
          <><WifiOff size={14} /> Demo data — couldn't reach {sourceLabel} for live metrics</>
        )}
      </div>

      <div className="tenant-detail-topbar">
        <div className="property-detail-header" style={{ flex: 1 }}>
          <div className="wo-detail-icon" style={{ background: '#1565C015', color: '#1565C0' }}>
            <Building2 size={28} />
          </div>
          <div style={{ flex: 1 }}>
            <h2>Properties Drilldown</h2>
            <p className="property-detail-address">
              {totals.properties} properties · {totals.units} units · {totals.avgOccupancy}% avg occupancy · {formatCurrency(totals.estRent)}/mo est. rent roll
            </p>
          </div>
        </div>
      </div>

      {/* Portfolio KPI strip — inline grid so we don't need new CSS. */}
      <div style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))',
        gap: '12px',
        marginBottom: '16px',
      }}>
        {[
          { label: 'Properties', value: totals.properties, color: '#1565C0', icon: Building2 },
          { label: 'Total Units', value: totals.units, color: '#0077B6', icon: Home },
          { label: 'Occupied', value: totals.occupied, color: '#2E7D32', icon: CheckCircle2 },
          { label: 'Vacant', value: totals.vacant, color: '#E65100', icon: AlertCircle },
          { label: 'Avg Occupancy', value: `${totals.avgOccupancy}%`, color: '#7B1FA2', icon: Home },
          { label: 'Open Work Orders', value: totals.openWOs, color: '#C62828', icon: Wrench },
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
              {sortedRows.map((r) => {
                const expanded = expandedId === r.id;
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
            {formatCurrency(row.estRent)}
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
                gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))',
                gap: 8,
              }}>
                {row.units.map((u) => {
                  const s = (u.status || '').toLowerCase();
                  const isOccupied = s.includes('occupied') || s.includes('current');
                  return (
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
                          background: isOccupied ? '#E8F5E9' : '#FFF3E0',
                          color: isOccupied ? '#2E7D32' : '#E65100',
                        }}>
                          {isOccupied ? <CheckCircle2 size={10} /> : <AlertCircle size={10} />}
                          {isOccupied ? 'Occupied' : 'Vacant'}
                        </span>
                      </div>
                      <div style={{ color: '#666' }}>
                        {u.bedrooms != null ? `${u.bedrooms}bd` : ''}
                        {u.bathrooms != null ? ` · ${u.bathrooms}ba` : ''}
                        {u.marketRent != null && ` · ${formatCurrency(u.marketRent)}/mo`}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </td>
        </tr>
      )}
    </>
  );
}
