import { useState, useEffect } from 'react';
import {
  Home, Users, FileText, DollarSign, Wrench, Building2,
  TrendingUp, TrendingDown, AlertCircle, CheckCircle2,
  Clock, ChevronRight, Search, BarChart3, Calendar,
  Loader2, WifiOff
} from 'lucide-react';
import { getProperties, getUnits, getWorkOrders, getTenants } from '../services/data';
import { useDataSource } from '../contexts/DataSourceContext.jsx';

// ── Helpers ───────────────────────────────────────────────────────────────

function relativeTime(dateLike) {
  if (!dateLike) return '';
  const t = new Date(dateLike).getTime();
  if (!Number.isFinite(t)) return '';
  const ago = Date.now() - t;
  if (ago < 0) return 'just now';
  if (ago < 60_000) return 'just now';
  if (ago < 3_600_000) return `${Math.floor(ago / 60_000)} min ago`;
  if (ago < 86_400_000) return `${Math.floor(ago / 3_600_000)} hr ago`;
  const days = Math.floor(ago / 86_400_000);
  return days === 1 ? '1 day ago' : `${days} days ago`;
}

function dayMonth(dateLike) {
  if (!dateLike) return { day: '—', month: '—' };
  const d = new Date(dateLike);
  if (Number.isNaN(d.getTime())) return { day: '—', month: '—' };
  const day = String(d.getDate());
  const month = d.toLocaleDateString('en-US', { month: 'short' }).toUpperCase();
  return { day, month };
}

function getPriorityClass(p) {
  const pl = (p || '').toLowerCase();
  return pl === 'high' || pl === 'emergency' ? 'priority-high'
    : pl === 'medium' || pl === 'normal' ? 'priority-medium'
    : 'priority-low';
}

function getStatusLabel(s) {
  const sl = (s || '').toLowerCase();
  if (sl.includes('open') || sl === 'new') return 'Open';
  if (sl.includes('assign')) return 'Assigned';
  if (sl.includes('progress') || sl.includes('active')) return 'In Progress';
  if (sl.includes('complete') || sl.includes('closed')) return 'Completed';
  return s || 'Open';
}

function getStatusClass(s) {
  const sl = (s || '').toLowerCase();
  if (sl.includes('open') || sl === 'new') return 'status-open';
  if (sl.includes('assign')) return 'status-assigned';
  if (sl.includes('progress') || sl.includes('active')) return 'status-in_progress';
  return 'status-open';
}

export default function ClassicDashboard({ onNavigate }) {
  const { dataSource, sources } = useDataSource();
  const sourceLabel = sources.find((s) => s.value === dataSource)?.label || dataSource;
  const [properties, setProperties] = useState(null);
  const [units, setUnits] = useState(null);
  const [workOrders, setWorkOrders] = useState(null);
  const [tenants, setTenants] = useState(null);
  const [loading, setLoading] = useState(true);
  const [isLive, setIsLive] = useState(false);

  useEffect(() => {
    let cancelled = false;
    async function fetchData() {
      setLoading(true);
      // Use allSettled so one slow/failed call doesn't kill the others.
      const results = await Promise.allSettled([
        getProperties(dataSource),
        getUnits(dataSource),
        getWorkOrders(dataSource, { status: 'all' }),
        getTenants(dataSource),
      ]);
      if (cancelled) return;
      const [propsRes, unitsRes, woRes, tRes] = results;
      const propsData = propsRes.status === 'fulfilled' ? propsRes.value : null;
      const unitsData = unitsRes.status === 'fulfilled' ? unitsRes.value : null;
      const woData    = woRes.status    === 'fulfilled' ? woRes.value    : null;
      const tData     = tRes.status     === 'fulfilled' ? tRes.value     : null;

      setProperties(propsData);
      setUnits(unitsData);
      setWorkOrders(woData);
      setTenants(tData);

      // Banner shows "live" if ANY endpoint responded
      setIsLive(!!(propsData || unitsData || woData || tData));

      setLoading(false);
    }
    fetchData();
    return () => { cancelled = true; };
  }, [dataSource]);

  // ── ID → name lookups, built from the same fetched data ──
  const propertyById = (properties || []).reduce((m, p) => {
    m[p.id] = p.name || p.shortName || '';
    return m;
  }, {});
  const unitById = (units || []).reduce((m, u) => {
    m[u.id] = u.name || '';
    return m;
  }, {});

  // ── Build display data — all derived from live fetches ──────────
  // No demo fallbacks. When AppFolio (or RM) is unreachable, sections
  // render an honest empty state rather than fake property names that
  // don't match the user's actual portfolio.

  const propertyRows = (properties || []).map((p) => {
    const propUnits = (units || []).filter((u) => u.propertyId === p.id);
    const unitCount = propUnits.length;
    const occupiedCount = propUnits.filter((u) => {
      const s = (u.status || '').toLowerCase();
      return s.includes('occupied') || s.includes('current');
    }).length;
    const occupancy = unitCount > 0 ? Math.round((occupiedCount / unitCount) * 100) : 0;
    return {
      name: p.name,
      city: p.city || p.state || '',
      units: unitCount || 0,
      occupancy,
    };
  });

  // Stats: live numbers only. "—" when we don't have data, never a
  // hardcoded portfolio total that doesn't match reality.
  const totalUnits = units ? units.length : null;
  const occupiedUnits = units
    ? units.filter((u) => {
        const s = (u.status || '').toLowerCase();
        return s.includes('occupied') || s.includes('current');
      }).length
    : null;
  const vacantUnits = totalUnits != null && occupiedUnits != null
    ? totalUnits - occupiedUnits
    : null;
  const propertyCount = properties ? properties.length : null;

  const fmt = (n) => (n == null ? '—' : String(n));

  // All four stat cards open the Properties drilldown — that's the
  // useful destination when someone clicks a top-level KPI. The
  // sidebar list view at 'properties' is for nav, not drilldown.
  // Each card passes a filter so the drilldown opens already focused
  // on the slice the user clicked (all units / occupied / vacant /
  // collapsed list of properties).
  const STATS = [
    { label: 'Total Units', value: fmt(totalUnits), icon: Building2, color: '#0077B6', trend: null,
      nav: 'properties-drilldown', filters: { expandAll: true } },
    { label: 'Occupied', value: fmt(occupiedUnits), icon: Home, color: '#2E7D32', trend: null,
      nav: 'properties-drilldown', filters: { expandAll: true, occupancy: 'occupied' } },
    { label: 'Vacant', value: fmt(vacantUnits), icon: AlertCircle, color: '#E65100', trend: null,
      nav: 'properties-drilldown', filters: { expandAll: true, occupancy: 'vacant' } },
    { label: 'Properties', value: fmt(propertyCount), icon: Building2, color: '#1565C0', trend: null,
      nav: 'properties-drilldown', filters: null },
  ];

  // Maintenance Queue: open work orders, freshest first. Property and
  // unit IDs resolve to names via the lookups built above.
  const maintenanceItems = (workOrders || [])
    .filter((wo) => !wo.isClosed)
    .slice(0, 6)
    .map((wo) => ({
      id: wo.displayId || `WO-${wo.id}`,
      unit: unitById[wo.unitId] ? `Unit ${unitById[wo.unitId]}` : '',
      property: propertyById[wo.propertyId] || '',
      issue: wo.summary || 'No description',
      priority: wo.priority || 'normal',
      status: wo.status || 'open',
    }));

  // Recent Activity: derived from work orders (created + completed)
  // and tenants (move-ins + move-outs). Sort by event time desc.
  const activityCandidates = [];

  for (const wo of workOrders || []) {
    if (wo.createdDate) {
      activityCandidates.push({
        when: wo.createdDate,
        icon: Wrench,
        iconBg: '#FFF3E0',
        iconColor: '#E65100',
        text: `Maintenance request — ${wo.summary || 'New work order'}` +
          (propertyById[wo.propertyId] ? `, ${propertyById[wo.propertyId]}` : ''),
      });
    }
    if (wo.completedDate) {
      activityCandidates.push({
        when: wo.completedDate,
        icon: CheckCircle2,
        iconBg: '#E8F5E9',
        iconColor: '#2E7D32',
        text: `Work order completed — ${wo.summary || `WO-${wo.id}`}` +
          (propertyById[wo.propertyId] ? `, ${propertyById[wo.propertyId]}` : ''),
      });
    }
  }

  for (const t of tenants || []) {
    if (t.moveInDate) {
      activityCandidates.push({
        when: t.moveInDate,
        icon: Users,
        iconBg: '#F3E5F5',
        iconColor: '#6A1B9A',
        text: `Tenant moved in — ${t.name}` +
          (t.unitName ? `, ${t.unitName}` : ''),
      });
    }
    if (t.moveOutDate && new Date(t.moveOutDate) <= new Date()) {
      activityCandidates.push({
        when: t.moveOutDate,
        icon: AlertCircle,
        iconBg: '#FFEBEE',
        iconColor: '#C62828',
        text: `Tenant moved out — ${t.name}` +
          (t.unitName ? `, ${t.unitName}` : ''),
      });
    }
  }

  const recentActivity = activityCandidates
    .filter((a) => a.when)
    .sort((a, b) => new Date(b.when) - new Date(a.when))
    .slice(0, 6)
    .map((a) => ({ ...a, time: relativeTime(a.when) }));

  // Upcoming: lease ends in the next 60 days, plus scheduled work
  // orders. Sort by date asc.
  const upcomingItems = [];
  const now = new Date();
  const sixtyDays = new Date(now.getTime() + 60 * 86_400_000);

  for (const t of tenants || []) {
    if (!t.leaseEnd) continue;
    const end = new Date(t.leaseEnd);
    if (Number.isNaN(end.getTime())) continue;
    if (end >= now && end <= sixtyDays) {
      upcomingItems.push({
        when: end,
        title: `Lease renewal — ${t.unitName || t.name}`,
        subtitle: t.propertyName || t.name,
      });
    }
  }
  for (const wo of workOrders || []) {
    if (!wo.scheduledDate) continue;
    const d = new Date(wo.scheduledDate);
    if (Number.isNaN(d.getTime())) continue;
    if (d >= now && d <= sixtyDays) {
      upcomingItems.push({
        when: d,
        title: wo.summary || `WO-${wo.id}`,
        subtitle: propertyById[wo.propertyId] || wo.assignedTo || '',
      });
    }
  }
  upcomingItems.sort((a, b) => a.when - b.when);
  const upcomingTop = upcomingItems.slice(0, 5).map((u) => ({
    ...u,
    ...dayMonth(u.when),
  }));

  return (
    <div className="classic-dashboard">
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
        {loading ? (
          <><Loader2 size={14} className="spin" /> Connecting to {sourceLabel}...</>
        ) : isLive ? (
          <><CheckCircle2 size={14} /> Live data from {sourceLabel}</>
        ) : (
          <><WifiOff size={14} /> Couldn't reach {sourceLabel}</>
        )}
      </div>

      {/* Search bar */}
      <div className="dashboard-search">
        <Search size={18} />
        <input type="text" placeholder="Search properties, tenants, leases, work orders..." />
      </div>

      {/* Stats row */}
      <div className="stats-row">
        {STATS.map((stat, i) => (
          <button
            key={i}
            className="stat-card stat-card-clickable"
            onClick={() => stat.nav && onNavigate && onNavigate(stat.nav, stat.filters || undefined)}
          >
            <div className="stat-icon" style={{ backgroundColor: stat.color + '15', color: stat.color }}>
              <stat.icon size={22} />
            </div>
            <div className="stat-info">
              <span className="stat-value">{loading ? '...' : stat.value}</span>
              <span className="stat-label">{stat.label}</span>
              {stat.trend && (
                <span className="stat-trend" style={{ color: stat.trend.startsWith('+') ? '#2E7D32' : '#C62828' }}>
                  {stat.trend.startsWith('+') ? <TrendingUp size={12} /> : <TrendingDown size={12} />}
                  {stat.trend}
                </span>
              )}
            </div>
          </button>
        ))}
      </div>

      {/* Main grid */}
      <div className="dashboard-grid">
        {/* Recent Activity */}
        <div className="dashboard-card activity-card">
          <div className="card-header">
            <h3><Clock size={18} /> Recent Activity</h3>
            <button className="card-link">View all <ChevronRight size={14} /></button>
          </div>
          <div className="activity-list">
            {recentActivity.length === 0 ? (
              <div style={{ padding: '20px 12px', color: '#6A737D', fontSize: 13 }}>
                {loading
                  ? 'Loading recent activity…'
                  : 'No recent activity to show. New work orders, completions, and tenant move-ins will appear here.'}
              </div>
            ) : (
              recentActivity.map((item, i) => (
                <div key={i} className="activity-item">
                  <div className="activity-icon" style={{ backgroundColor: item.iconBg, color: item.iconColor }}>
                    <item.icon size={16} />
                  </div>
                  <div className="activity-info">
                    <span className="activity-text">{item.text}</span>
                    <span className="activity-time">{item.time}</span>
                  </div>
                </div>
              ))
            )}
          </div>
        </div>

        {/* Properties overview */}
        <div className="dashboard-card properties-card">
          <div className="card-header">
            <h3><Building2 size={18} /> Properties {isLive && <span className="live-dot" />}</h3>
            <button className="card-link">Manage <ChevronRight size={14} /></button>
          </div>
          {propertyRows.length === 0 ? (
            <div style={{ padding: '20px 12px', color: '#6A737D', fontSize: 13 }}>
              {loading ? 'Loading properties…' : 'No properties to show.'}
            </div>
          ) : (
            <table className="properties-table">
              <thead>
                <tr>
                  <th>Property</th>
                  <th>Units</th>
                  <th>Occ.</th>
                  <th>City</th>
                </tr>
              </thead>
              <tbody>
                {propertyRows.map((p, i) => (
                  <tr key={i}>
                    <td>
                      <div className="property-name">{p.name}</div>
                      <div className="property-city">{p.city}</div>
                    </td>
                    <td>{p.units || '—'}</td>
                    <td>
                      <div className="occupancy-bar-container">
                        <div className="occupancy-bar" style={{ width: `${p.occupancy}%` }} />
                        <span>{p.occupancy}%</span>
                      </div>
                    </td>
                    <td>{p.city}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        {/* Maintenance queue */}
        <div className="dashboard-card maintenance-card">
          <div className="card-header">
            <h3><Wrench size={18} /> Maintenance Queue {isLive && <span className="live-dot" />}</h3>
            <button
              type="button"
              className="card-link"
              onClick={() => onNavigate && onNavigate('maintenance')}
            >
              View all <ChevronRight size={14} />
            </button>
          </div>
          <div className="maintenance-list">
            {maintenanceItems.length === 0 ? (
              <div style={{ padding: '20px 12px', color: '#6A737D', fontSize: 13 }}>
                {loading ? 'Loading work orders…' : 'No open work orders.'}
              </div>
            ) : (
              maintenanceItems.map((wo, i) => (
                <div
                  key={i}
                  className="maintenance-item"
                  role="button"
                  tabIndex={0}
                  onClick={() => onNavigate && onNavigate('maintenance', { ticketDisplayId: wo.id })}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      onNavigate && onNavigate('maintenance', { ticketDisplayId: wo.id });
                    }
                  }}
                  style={{ cursor: 'pointer' }}
                >
                  <div className="maintenance-header">
                    <span className="wo-id">{wo.id}</span>
                    <span className={`wo-priority ${getPriorityClass(wo.priority)}`}>{wo.priority}</span>
                  </div>
                  <div className="maintenance-body">
                    <span className="wo-issue">{wo.issue}</span>
                    <span className="wo-location">
                      {[wo.unit, wo.property].filter(Boolean).join(' · ') || '—'}
                    </span>
                  </div>
                  <span className={`wo-status ${getStatusClass(wo.status)}`}>{getStatusLabel(wo.status)}</span>
                </div>
              ))
            )}
          </div>
        </div>

        {/* Calendar */}
        <div className="dashboard-card calendar-card">
          <div className="card-header">
            <h3><Calendar size={18} /> Upcoming</h3>
          </div>
          <div className="upcoming-list">
            {upcomingTop.length === 0 ? (
              <div style={{ padding: '20px 12px', color: '#6A737D', fontSize: 13 }}>
                {loading
                  ? 'Loading upcoming items…'
                  : 'Nothing in the next 60 days. Lease renewals and scheduled work will appear here.'}
              </div>
            ) : (
              upcomingTop.map((u, i) => (
                <div key={i} className="upcoming-item">
                  <div className="upcoming-date">
                    <span className="upcoming-day">{u.day}</span>
                    <span className="upcoming-month">{u.month}</span>
                  </div>
                  <div className="upcoming-info">
                    <span className="upcoming-title">{u.title}</span>
                    {u.subtitle && (
                      <span className="upcoming-subtitle">{u.subtitle}</span>
                    )}
                  </div>
                </div>
              ))
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
