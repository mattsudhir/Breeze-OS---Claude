import {
  Home, Users, FileText, DollarSign, Wrench, Building2,
  TrendingUp, TrendingDown, AlertCircle, CheckCircle2,
  Clock, ChevronRight, Search, BarChart3, Calendar
} from 'lucide-react';

const STATS = [
  { label: 'Total Units', value: '342', icon: Building2, color: '#0077B6', trend: null },
  { label: 'Occupied', value: '318', icon: Home, color: '#2E7D32', trend: '+3 this month' },
  { label: 'Vacant', value: '24', icon: AlertCircle, color: '#E65100', trend: '-2 this month' },
  { label: 'Revenue (MTD)', value: '$487,200', icon: DollarSign, color: '#1565C0', trend: '+4.2%' },
];

const RECENT_ACTIVITY = [
  { icon: DollarSign, iconBg: '#E8F5E9', iconColor: '#2E7D32', text: 'Rent payment received — Unit 102, Maple Ridge', time: '2 min ago' },
  { icon: Wrench, iconBg: '#FFF3E0', iconColor: '#E65100', text: 'Maintenance request — Leaky faucet, Unit 315, Oakwood', time: '15 min ago' },
  { icon: FileText, iconBg: '#E3F2FD', iconColor: '#1565C0', text: 'Lease signed — Unit 204, Oakwood Apartments', time: '1 hr ago' },
  { icon: Users, iconBg: '#F3E5F5', iconColor: '#6A1B9A', text: 'New tenant application — Unit 508, Pine Valley', time: '2 hr ago' },
  { icon: AlertCircle, iconBg: '#FFEBEE', iconColor: '#C62828', text: 'Late rent notice sent — Unit 411, Birchwood Commons', time: '3 hr ago' },
  { icon: CheckCircle2, iconBg: '#E8F5E9', iconColor: '#2E7D32', text: 'Work order completed — HVAC repair, Unit 201', time: '4 hr ago' },
];

const PROPERTIES = [
  { name: 'Oakwood Apartments', units: 86, occupancy: 95, revenue: '$124,500', city: 'Portland' },
  { name: 'Maple Ridge Complex', units: 120, occupancy: 92, revenue: '$178,000', city: 'Portland' },
  { name: 'Pine Valley Homes', units: 64, occupancy: 89, revenue: '$98,400', city: 'Beaverton' },
  { name: 'Birchwood Commons', units: 72, occupancy: 97, revenue: '$86,300', city: 'Lake Oswego' },
];

const MAINTENANCE_QUEUE = [
  { id: 'WO-1847', unit: 'Unit 315', property: 'Oakwood', issue: 'Leaky kitchen faucet', priority: 'medium', status: 'open' },
  { id: 'WO-1846', unit: 'Unit 102', property: 'Maple Ridge', issue: 'Broken window latch', priority: 'low', status: 'assigned' },
  { id: 'WO-1845', unit: 'Unit 508', property: 'Pine Valley', issue: 'No hot water', priority: 'high', status: 'open' },
  { id: 'WO-1844', unit: 'Unit 201', property: 'Oakwood', issue: 'HVAC not cooling', priority: 'high', status: 'in_progress' },
];

function getPriorityClass(p) {
  return p === 'high' ? 'priority-high' : p === 'medium' ? 'priority-medium' : 'priority-low';
}

function getStatusLabel(s) {
  return s === 'open' ? 'Open' : s === 'assigned' ? 'Assigned' : 'In Progress';
}

export default function ClassicDashboard() {
  return (
    <div className="classic-dashboard">
      {/* Search bar */}
      <div className="dashboard-search">
        <Search size={18} />
        <input type="text" placeholder="Search properties, tenants, leases, work orders..." />
      </div>

      {/* Stats row */}
      <div className="stats-row">
        {STATS.map((stat, i) => (
          <div key={i} className="stat-card">
            <div className="stat-icon" style={{ backgroundColor: stat.color + '15', color: stat.color }}>
              <stat.icon size={22} />
            </div>
            <div className="stat-info">
              <span className="stat-value">{stat.value}</span>
              <span className="stat-label">{stat.label}</span>
              {stat.trend && (
                <span className="stat-trend" style={{ color: stat.trend.startsWith('+') ? '#2E7D32' : '#C62828' }}>
                  {stat.trend.startsWith('+') ? <TrendingUp size={12} /> : <TrendingDown size={12} />}
                  {stat.trend}
                </span>
              )}
            </div>
          </div>
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
            {RECENT_ACTIVITY.map((item, i) => (
              <div key={i} className="activity-item">
                <div className="activity-icon" style={{ backgroundColor: item.iconBg, color: item.iconColor }}>
                  <item.icon size={16} />
                </div>
                <div className="activity-info">
                  <span className="activity-text">{item.text}</span>
                  <span className="activity-time">{item.time}</span>
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Properties overview */}
        <div className="dashboard-card properties-card">
          <div className="card-header">
            <h3><Building2 size={18} /> Properties</h3>
            <button className="card-link">Manage <ChevronRight size={14} /></button>
          </div>
          <table className="properties-table">
            <thead>
              <tr>
                <th>Property</th>
                <th>Units</th>
                <th>Occ.</th>
                <th>Revenue</th>
              </tr>
            </thead>
            <tbody>
              {PROPERTIES.map((p, i) => (
                <tr key={i}>
                  <td>
                    <div className="property-name">{p.name}</div>
                    <div className="property-city">{p.city}</div>
                  </td>
                  <td>{p.units}</td>
                  <td>
                    <div className="occupancy-bar-container">
                      <div className="occupancy-bar" style={{ width: `${p.occupancy}%` }} />
                      <span>{p.occupancy}%</span>
                    </div>
                  </td>
                  <td className="revenue-cell">{p.revenue}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {/* Maintenance queue */}
        <div className="dashboard-card maintenance-card">
          <div className="card-header">
            <h3><Wrench size={18} /> Maintenance Queue</h3>
            <button className="card-link">View all <ChevronRight size={14} /></button>
          </div>
          <div className="maintenance-list">
            {MAINTENANCE_QUEUE.map((wo, i) => (
              <div key={i} className="maintenance-item">
                <div className="maintenance-header">
                  <span className="wo-id">{wo.id}</span>
                  <span className={`wo-priority ${getPriorityClass(wo.priority)}`}>{wo.priority}</span>
                </div>
                <div className="maintenance-body">
                  <span className="wo-issue">{wo.issue}</span>
                  <span className="wo-location">{wo.unit} - {wo.property}</span>
                </div>
                <span className={`wo-status status-${wo.status}`}>{getStatusLabel(wo.status)}</span>
              </div>
            ))}
          </div>
        </div>

        {/* Quick stats / calendar placeholder */}
        <div className="dashboard-card calendar-card">
          <div className="card-header">
            <h3><Calendar size={18} /> Upcoming</h3>
          </div>
          <div className="upcoming-list">
            <div className="upcoming-item">
              <div className="upcoming-date">
                <span className="upcoming-day">14</span>
                <span className="upcoming-month">APR</span>
              </div>
              <div className="upcoming-info">
                <span className="upcoming-title">Lease Renewal - Unit 204</span>
                <span className="upcoming-subtitle">Oakwood Apartments</span>
              </div>
            </div>
            <div className="upcoming-item">
              <div className="upcoming-date">
                <span className="upcoming-day">15</span>
                <span className="upcoming-month">APR</span>
              </div>
              <div className="upcoming-info">
                <span className="upcoming-title">Property Inspection</span>
                <span className="upcoming-subtitle">Pine Valley Homes</span>
              </div>
            </div>
            <div className="upcoming-item">
              <div className="upcoming-date">
                <span className="upcoming-day">18</span>
                <span className="upcoming-month">APR</span>
              </div>
              <div className="upcoming-info">
                <span className="upcoming-title">Vendor Meeting - HVAC</span>
                <span className="upcoming-subtitle">All Properties</span>
              </div>
            </div>
            <div className="upcoming-item">
              <div className="upcoming-date">
                <span className="upcoming-day">20</span>
                <span className="upcoming-month">APR</span>
              </div>
              <div className="upcoming-info">
                <span className="upcoming-title">Move-in - Unit 508</span>
                <span className="upcoming-subtitle">Pine Valley Homes</span>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
