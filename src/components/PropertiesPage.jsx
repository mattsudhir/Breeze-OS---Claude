import { useState, useEffect } from 'react';
import {
  Building2, Search, MapPin, Home, CheckCircle2,
  AlertCircle, ChevronRight, Loader2, WifiOff, Filter
} from 'lucide-react';
import { getProperties, getUnits, getTenants } from '../services/data';
import { useDataSource } from '../contexts/DataSourceContext.jsx';
import FollowButton from './FollowButton.jsx';

export default function PropertiesPage({ onNavigate }) {
  const { dataSource, sources } = useDataSource();
  const sourceLabel = sources.find((s) => s.value === dataSource)?.label || dataSource;
  const [properties, setProperties] = useState(null);
  const [units, setUnits] = useState(null);
  const [tenants, setTenants] = useState(null);
  const [loading, setLoading] = useState(true);
  const [isLive, setIsLive] = useState(false);
  const [searchTerm, setSearchTerm] = useState('');
  const [selectedPropertyId, setSelectedPropertyId] = useState(null);

  // Refetch when the data source toggle flips. Tenants joined in
  // so single-unit cards can show the resident's name in place of
  // the not-very-useful 0% / 100% occupancy bar.
  useEffect(() => {
    let cancelled = false;
    async function fetchData() {
      setLoading(true);
      const [propsData, unitsData, tenantsData] = await Promise.all([
        getProperties(dataSource),
        getUnits(dataSource),
        getTenants(dataSource),
      ]);
      if (cancelled) return;
      if (propsData) {
        setProperties(propsData);
        setIsLive(true);
      } else {
        setProperties(null);
        setIsLive(false);
      }
      setUnits(unitsData || null);
      setTenants(tenantsData || null);
      setLoading(false);
    }
    fetchData();
    return () => { cancelled = true; };
  }, [dataSource]);

  // Group units by property. Robust: try matching by propertyId
  // first; fall back to propertyName when the id link is missing
  // (some AppFolio multi-unit configurations surface only the name
  // on the unit row).
  const unitsByPropertyId = (units || []).reduce((acc, u) => {
    if (!u.propertyId) return acc;
    if (!acc[u.propertyId]) acc[u.propertyId] = [];
    acc[u.propertyId].push(u);
    return acc;
  }, {});
  const unitsByPropertyName = (units || []).reduce((acc, u) => {
    if (!u.propertyName) return acc;
    if (!acc[u.propertyName]) acc[u.propertyName] = [];
    acc[u.propertyName].push(u);
    return acc;
  }, {});

  function unitsForProperty(p) {
    if (!p) return [];
    return (
      unitsByPropertyId[p.id] ||
      unitsByPropertyName[p.name] ||
      []
    );
  }

  // Active tenants by propertyId (for single-unit cards' "Tenant: X"
  // line). Hidden tenants are already filtered out by the mirror
  // read default; this also drops any with a moveOutDate in the
  // past so the resident shown is actually current.
  const today = new Date();
  const activeTenantsByPropertyId = (tenants || []).reduce((acc, t) => {
    if (!t.propertyId) return acc;
    if (t.moveOutDate && new Date(t.moveOutDate) < today) return acc;
    if (!acc[t.propertyId]) acc[t.propertyId] = [];
    acc[t.propertyId].push(t);
    return acc;
  }, {});

  function getPropertyStats(propertyId) {
    const propUnits = unitsByPropertyId[propertyId]
      || unitsByPropertyName[(properties || []).find((p) => p.id === propertyId)?.name]
      || [];
    const total = propUnits.length;
    const occupied = propUnits.filter((u) => {
      const s = (u.status || '').toLowerCase();
      return s.includes('occupied') || s.includes('current');
    }).length;
    const vacant = total - occupied;
    const occupancy = total > 0 ? Math.round((occupied / total) * 100) : 0;
    return { total, occupied, vacant, occupancy };
  }

  // Filter properties by search term
  const filteredProperties = (properties || []).filter((p) => {
    if (!searchTerm) return true;
    const q = searchTerm.toLowerCase();
    return (
      p.name.toLowerCase().includes(q) ||
      (p.city || '').toLowerCase().includes(q) ||
      (p.address || '').toLowerCase().includes(q)
    );
  });

  // If a property is selected, show its units
  const selectedProperty = selectedPropertyId
    ? (properties || []).find((p) => p.id === selectedPropertyId)
    : null;
  const selectedUnits = unitsForProperty(selectedProperty);

  if (loading) {
    return (
      <div className="properties-page">
        <div className="loading-state">
          <Loader2 size={28} className="spin" />
          <span>Loading properties from {sourceLabel}...</span>
        </div>
      </div>
    );
  }

  if (!properties || properties.length === 0) {
    return (
      <div className="properties-page">
        <div className="empty-state">
          <WifiOff size={40} />
          <h3>No properties found</h3>
          <p>Couldn't reach {sourceLabel}, or the account has no properties configured.</p>
        </div>
      </div>
    );
  }

  // ── Property detail view ──────────────────────────────────────
  if (selectedProperty) {
    const stats = getPropertyStats(selectedProperty.id);
    const detailIsSingleUnit = stats.total === 1 && selectedUnits[0];
    const detailOnlyUnit = detailIsSingleUnit ? selectedUnits[0] : null;
    const detailOnlyTenant = detailIsSingleUnit
      ? (activeTenantsByPropertyId[selectedProperty.id] || [])[0]
      : null;
    return (
      <div className="properties-page">
        <button className="back-link" onClick={() => setSelectedPropertyId(null)}>
          ← Back to all properties
        </button>

        <div className="property-detail-header">
          <div className="property-detail-icon">
            <Building2 size={32} />
          </div>
          <div>
            <h2>{selectedProperty.name}</h2>
            {selectedProperty.address && (
              <p className="property-detail-address">
                <MapPin size={14} /> {selectedProperty.address}
              </p>
            )}
          </div>
        </div>

        {detailIsSingleUnit ? (
          <div className="property-detail-stats">
            <div className="property-detail-stat">
              <span className="detail-stat-value">
                {detailOnlyUnit.bedrooms ?? '—'} / {detailOnlyUnit.bathrooms ?? '—'}
              </span>
              <span className="detail-stat-label">BD / BA</span>
            </div>
            <div className="property-detail-stat">
              <span
                className="detail-stat-value"
                style={{ color: detailOnlyTenant ? '#1A1A1A' : '#E65100', fontSize: 18 }}
              >
                {detailOnlyTenant?.name || 'Vacant'}
              </span>
              <span className="detail-stat-label">
                {detailOnlyTenant ? 'Tenant' : 'Status'}
              </span>
            </div>
            {detailOnlyUnit.marketRent != null && (
              <div className="property-detail-stat">
                <span className="detail-stat-value" style={{ color: '#0077B6' }}>
                  ${Number(detailOnlyUnit.marketRent).toLocaleString()}
                </span>
                <span className="detail-stat-label">Market Rent</span>
              </div>
            )}
            {detailOnlyTenant?.leaseEnd && (
              <div className="property-detail-stat">
                <span className="detail-stat-value" style={{ fontSize: 16 }}>
                  {new Date(detailOnlyTenant.leaseEnd).toLocaleDateString('en-US', {
                    month: 'short', day: 'numeric', year: 'numeric',
                  })}
                </span>
                <span className="detail-stat-label">Lease Ends</span>
              </div>
            )}
          </div>
        ) : (
        <div className="property-detail-stats">
          <div className="property-detail-stat">
            <span className="detail-stat-value">{stats.total}</span>
            <span className="detail-stat-label">Total Units</span>
          </div>
          <div className="property-detail-stat">
            <span className="detail-stat-value" style={{ color: '#2E7D32' }}>{stats.occupied}</span>
            <span className="detail-stat-label">Occupied</span>
          </div>
          <div className="property-detail-stat">
            <span className="detail-stat-value" style={{ color: '#E65100' }}>{stats.vacant}</span>
            <span className="detail-stat-label">Vacant</span>
          </div>
          <div className="property-detail-stat">
            <span className="detail-stat-value" style={{ color: '#0077B6' }}>{stats.occupancy}%</span>
            <span className="detail-stat-label">Occupancy</span>
          </div>
        </div>
        )}

        <div className="dashboard-card">
          <div className="card-header">
            <h3><Home size={18} /> Units ({selectedUnits.length})</h3>
          </div>
          {selectedUnits.length === 0 ? (
            <div style={{ padding: '40px', textAlign: 'center', color: '#6C757D' }}>
              No units found for this property.
            </div>
          ) : (
            <table className="properties-table">
              <thead>
                <tr>
                  <th>Unit</th>
                  <th>Type</th>
                  <th>Status</th>
                  <th>Bed/Bath</th>
                  <th>Market Rent</th>
                </tr>
              </thead>
              <tbody>
                {selectedUnits.map((u) => {
                  const s = (u.status || '').toLowerCase();
                  const isOccupied = s.includes('occupied') || s.includes('current');
                  return (
                    <tr key={u.id}>
                      <td><strong>{u.name}</strong></td>
                      <td>{u.type || '—'}</td>
                      <td>
                        <span className={`unit-status ${isOccupied ? 'unit-occupied' : 'unit-vacant'}`}>
                          {isOccupied ? <CheckCircle2 size={12} /> : <AlertCircle size={12} />}
                          {u.status || (isOccupied ? 'Occupied' : 'Vacant')}
                        </span>
                      </td>
                      <td>
                        {u.bedrooms != null || u.bathrooms != null
                          ? `${u.bedrooms || '—'} / ${u.bathrooms || '—'}`
                          : '—'}
                      </td>
                      <td>{u.marketRent != null ? `$${Number(u.marketRent).toLocaleString()}` : '—'}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
      </div>
    );
  }

  // ── Properties list view ──────────────────────────────────────
  const totalUnits = units ? units.length : 0;
  const totalOccupied = units
    ? units.filter((u) => {
        const s = (u.status || '').toLowerCase();
        return s.includes('occupied') || s.includes('current');
      }).length
    : 0;

  return (
    <div className="properties-page">
      {/* Data source indicator */}
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
          <><CheckCircle2 size={14} /> Live data from {sourceLabel} — {properties.length} properties</>
        ) : (
          <><WifiOff size={14} /> Demo data</>
        )}
      </div>

      {/* Summary stats. The Properties card used to navigate to the
          portfolio drilldown but the user is *already* on the
          properties view, so the click felt like a page reload —
          made it non-interactive. The Units card is the proper
          drill-in entry point, opening the portfolio drilldown with
          all rows pre-expanded so units are visible immediately. */}
      <div className="stats-row">
        <div className="stat-card">
          <div className="stat-icon" style={{ backgroundColor: '#0077B615', color: '#0077B6' }}>
            <Building2 size={22} />
          </div>
          <div className="stat-info">
            <span className="stat-value">{properties.length}</span>
            <span className="stat-label">Properties</span>
          </div>
        </div>
        <button
          type="button"
          className="stat-card stat-card-clickable"
          onClick={() => onNavigate && onNavigate('properties-drilldown', { expandAll: true })}
          title="Open portfolio drilldown with units expanded"
        >
          <div className="stat-icon" style={{ backgroundColor: '#1565C015', color: '#1565C0' }}>
            <Home size={22} />
          </div>
          <div className="stat-info">
            <span className="stat-value">{totalUnits}</span>
            <span className="stat-label">Total Units</span>
          </div>
        </button>
        <div className="stat-card">
          <div className="stat-icon" style={{ backgroundColor: '#2E7D3215', color: '#2E7D32' }}>
            <CheckCircle2 size={22} />
          </div>
          <div className="stat-info">
            <span className="stat-value">{totalOccupied}</span>
            <span className="stat-label">Occupied</span>
          </div>
        </div>
        <div className="stat-card">
          <div className="stat-icon" style={{ backgroundColor: '#E6510015', color: '#E65100' }}>
            <AlertCircle size={22} />
          </div>
          <div className="stat-info">
            <span className="stat-value">{totalUnits - totalOccupied}</span>
            <span className="stat-label">Vacant</span>
          </div>
        </div>
      </div>

      {/* Search */}
      <div className="dashboard-search">
        <Search size={18} />
        <input
          type="text"
          placeholder="Search properties by name, city, or address..."
          value={searchTerm}
          onChange={(e) => setSearchTerm(e.target.value)}
        />
      </div>

      {/* Property cards grid */}
      <div className="properties-grid">
        {filteredProperties.map((p) => {
          const stats = getPropertyStats(p.id);
          // Single-unit properties: a 0% / 100% occupancy bar isn't
          // useful. Show BD/BA + the resident's name (or Vacant)
          // instead. Multi-unit keeps the aggregate view.
          const propUnits = unitsForProperty(p);
          const isSingleUnit = stats.total === 1 && propUnits[0];
          const onlyUnit = isSingleUnit ? propUnits[0] : null;
          const onlyTenant = isSingleUnit
            ? (activeTenantsByPropertyId[p.id] || [])[0]
            : null;
          return (
            <div
              key={p.id}
              className="property-card"
              role="button"
              tabIndex={0}
              onClick={() => setSelectedPropertyId(p.id)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  setSelectedPropertyId(p.id);
                }
              }}
            >
              <div className="property-card-header">
                <div className="property-card-icon">
                  <Building2 size={22} />
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                  <FollowButton
                    entityType="property"
                    entityId={p.id}
                    entityLabel={p.name}
                  />
                  <ChevronRight size={18} className="property-card-chevron" />
                </div>
              </div>
              <div className="property-card-body">
                <h4>{p.name}</h4>
                {p.city && (
                  <p className="property-card-location">
                    <MapPin size={12} /> {p.city}{p.state ? `, ${p.state}` : ''}
                  </p>
                )}
              </div>
              {isSingleUnit ? (
                <div className="property-card-footer">
                  <div className="property-card-metric">
                    <span className="metric-value">
                      {onlyUnit.bedrooms ?? '—'} / {onlyUnit.bathrooms ?? '—'}
                    </span>
                    <span className="metric-label">BD / BA</span>
                  </div>
                  <div
                    className="property-card-metric"
                    style={{ flex: 2, minWidth: 0 }}
                  >
                    <span
                      className="metric-value"
                      style={{
                        color: onlyTenant ? '#1A1A1A' : '#E65100',
                        fontSize: 13,
                        whiteSpace: 'nowrap',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        display: 'block',
                      }}
                    >
                      {onlyTenant?.name || 'Vacant'}
                    </span>
                    <span className="metric-label">
                      {onlyTenant ? 'Tenant' : 'Status'}
                    </span>
                  </div>
                </div>
              ) : (
              <div className="property-card-footer">
                <div className="property-card-metric">
                  <span className="metric-value">{stats.total}</span>
                  <span className="metric-label">Units</span>
                </div>
                <div className="property-card-metric">
                  <span className="metric-value" style={{ color: '#2E7D32' }}>{stats.occupied}</span>
                  <span className="metric-label">Occupied</span>
                </div>
                <div className="property-card-metric">
                  <span className="metric-value" style={{ color: '#0077B6' }}>{stats.occupancy}%</span>
                  <span className="metric-label">Occupancy</span>
                </div>
              </div>
              )}
              {!isSingleUnit && stats.total > 0 && (
                <div className="property-card-bar">
                  <div
                    className="property-card-bar-fill"
                    style={{ width: `${stats.occupancy}%` }}
                  />
                </div>
              )}
            </div>
          );
        })}
      </div>

      {filteredProperties.length === 0 && (
        <div className="empty-state">
          <Search size={32} />
          <p>No properties match "{searchTerm}"</p>
        </div>
      )}
    </div>
  );
}
