// Maintenance tickets — native to Breeze OS's own data model.
//
// Reads from /api/admin/list-maintenance-tickets and mutates via
// upsert-maintenance-ticket / add-ticket-comment / list-ticket-comments.
// Was previously a passthrough to AppFolio / RentManager; now operates
// on our own tickets table so the page works without any external PMS
// connection.

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Wrench, Search, CheckCircle2, AlertCircle, Loader2,
  ChevronDown, ChevronRight, Plus, RefreshCw, Building2, Home,
  Clock, AlertTriangle, MessageSquare, Send, Lock, X, Download,
} from 'lucide-react';
import MigrationFixButton from './MigrationFixButton.jsx';

const CLERK_ENABLED = Boolean(import.meta.env.VITE_CLERK_PUBLISHABLE_KEY);
const ADMIN_TOKEN_KEY = 'breeze.admin.token';
const getToken = () => {
  if (CLERK_ENABLED) return 'clerk';
  try { return sessionStorage.getItem(ADMIN_TOKEN_KEY) || ''; } catch { return ''; }
};

async function fetchJson(path, { method = 'GET', body, query } = {}) {
  const url = new URL(path, window.location.origin);
  url.searchParams.set('secret', getToken());
  if (query) for (const [k, v] of Object.entries(query)) {
    if (v != null && v !== '') url.searchParams.set(k, v);
  }
  const init = { method };
  if (body) {
    init.headers = { 'Content-Type': 'application/json' };
    init.body = JSON.stringify(body);
  }
  const res = await fetch(url.toString(), init);
  const text = await res.text();
  let json;
  try { json = text ? JSON.parse(text) : {}; } catch { json = { raw: text }; }
  if (!res.ok || json.ok === false) {
    throw new Error(json.error || `HTTP ${res.status}: ${text.slice(0, 200)}`);
  }
  return json;
}

const STATUS_META = {
  new:              { label: 'New',              color: '#1976D2', bg: '#E3F2FD' },
  triage:           { label: 'Triage',           color: '#6A1B9A', bg: '#F3E5F5' },
  assigned:         { label: 'Assigned',         color: '#00838F', bg: '#E0F7FA' },
  in_progress:      { label: 'In progress',      color: '#F9A825', bg: '#FFF8E1' },
  awaiting_parts:   { label: 'Awaiting parts',   color: '#EF6C00', bg: '#FFF3E0' },
  awaiting_tenant:  { label: 'Awaiting tenant',  color: '#EF6C00', bg: '#FFF3E0' },
  completed:        { label: 'Completed',        color: '#2E7D32', bg: '#E8F5E9' },
  cancelled:        { label: 'Cancelled',        color: '#757575', bg: '#ECEFF1' },
};

const PRIORITY_META = {
  emergency: { label: 'Emergency', color: '#C62828', bg: '#FFEBEE', icon: AlertTriangle, rank: 4 },
  high:      { label: 'High',      color: '#EF6C00', bg: '#FFF3E0', icon: AlertCircle,   rank: 3 },
  medium:    { label: 'Medium',    color: '#1565C0', bg: '#E3F2FD', icon: Clock,         rank: 2 },
  low:       { label: 'Low',       color: '#546E7A', bg: '#ECEFF1', icon: Clock,         rank: 1 },
};

const STATUS_ORDER = [
  'new', 'triage', 'assigned', 'in_progress',
  'awaiting_parts', 'awaiting_tenant', 'completed', 'cancelled',
];
const PRIORITY_ORDER = ['emergency', 'high', 'medium', 'low'];

const AUTHOR_TYPE_META = {
  staff:  { label: 'Staff',  color: '#1565C0' },
  tenant: { label: 'Tenant', color: '#2E7D32' },
  vendor: { label: 'Vendor', color: '#6A1B9A' },
  ai:     { label: 'AI',     color: '#00838F' },
  system: { label: 'System', color: '#757575' },
};

function fmtDate(d) {
  if (!d) return '—';
  try {
    return new Date(d).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  } catch { return d; }
}

function fmtDateTime(d) {
  if (!d) return '';
  try {
    return new Date(d).toLocaleString('en-US', {
      month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
    });
  } catch { return d; }
}

function StatusBadge({ status }) {
  const m = STATUS_META[status] || { label: status, color: '#555', bg: '#eee' };
  return (
    <span style={{
      display: 'inline-block', padding: '3px 9px', borderRadius: 999,
      fontSize: 11, fontWeight: 600, color: m.color, background: m.bg,
    }}>{m.label}</span>
  );
}

function PriorityBadge({ priority }) {
  const m = PRIORITY_META[priority] || PRIORITY_META.medium;
  const Icon = m.icon;
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: 4,
      padding: '3px 9px', borderRadius: 999,
      fontSize: 11, fontWeight: 600, color: m.color, background: m.bg,
    }}>
      <Icon size={11} /> {m.label}
    </span>
  );
}

// ── New ticket form ──────────────────────────────────────────────

function NewTicketForm({ properties, vendors, onCreated, onCancel }) {
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [propertyId, setPropertyId] = useState('');
  const [vendorId, setVendorId] = useState('');
  const [priority, setPriority] = useState('medium');
  const [category, setCategory] = useState('');
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState(null);

  const submit = async (e) => {
    e.preventDefault();
    if (!title.trim()) { setErr('Title is required'); return; }
    setSaving(true);
    setErr(null);
    try {
      await fetchJson('/api/admin/upsert-maintenance-ticket', {
        method: 'POST',
        body: {
          title: title.trim(),
          description: description.trim() || undefined,
          property_id: propertyId || undefined,
          vendor_id: vendorId || undefined,
          priority,
          category: category.trim() || undefined,
        },
      });
      onCreated();
    } catch (e2) {
      setErr(e2.message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <form onSubmit={submit} style={{
      background: '#fff', border: '1px solid #e0e0e0', borderRadius: 12,
      padding: 18, marginBottom: 16, display: 'grid', gap: 12,
    }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <h3 style={{ margin: 0, fontSize: 16, display: 'flex', alignItems: 'center', gap: 8 }}>
          <Plus size={16} /> New maintenance ticket
        </h3>
        <button type="button" onClick={onCancel} style={{
          background: 'transparent', border: 'none', cursor: 'pointer', color: '#666',
        }}><X size={18} /></button>
      </div>

      <label style={{ display: 'grid', gap: 4 }}>
        <span style={{ fontSize: 12, fontWeight: 600, color: '#555' }}>Title</span>
        <input
          type="text"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="e.g., Kitchen sink leaking"
          style={{ padding: '8px 10px', border: '1px solid #ccc', borderRadius: 6, fontSize: 14 }}
        />
      </label>

      <label style={{ display: 'grid', gap: 4 }}>
        <span style={{ fontSize: 12, fontWeight: 600, color: '#555' }}>Description</span>
        <textarea
          rows={3}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="What's going on?"
          style={{ padding: '8px 10px', border: '1px solid #ccc', borderRadius: 6, fontSize: 14, fontFamily: 'inherit' }}
        />
      </label>

      <div style={{
        display: 'grid', gap: 12,
        gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
      }}>
        <label style={{ display: 'grid', gap: 4 }}>
          <span style={{ fontSize: 12, fontWeight: 600, color: '#555' }}>Property</span>
          <select
            value={propertyId}
            onChange={(e) => setPropertyId(e.target.value)}
            style={{ padding: '8px 10px', border: '1px solid #ccc', borderRadius: 6, fontSize: 14 }}
          >
            <option value="">—</option>
            {properties.map((p) => (
              <option key={p.id} value={p.id}>{p.display_name}</option>
            ))}
          </select>
        </label>

        <label style={{ display: 'grid', gap: 4 }}>
          <span style={{ fontSize: 12, fontWeight: 600, color: '#555' }}>Vendor</span>
          <select
            value={vendorId}
            onChange={(e) => setVendorId(e.target.value)}
            style={{ padding: '8px 10px', border: '1px solid #ccc', borderRadius: 6, fontSize: 14 }}
          >
            <option value="">— (unassigned)</option>
            {vendors.map((v) => (
              <option key={v.id} value={v.id}>{v.display_name}</option>
            ))}
          </select>
        </label>

        <label style={{ display: 'grid', gap: 4 }}>
          <span style={{ fontSize: 12, fontWeight: 600, color: '#555' }}>Priority</span>
          <select
            value={priority}
            onChange={(e) => setPriority(e.target.value)}
            style={{ padding: '8px 10px', border: '1px solid #ccc', borderRadius: 6, fontSize: 14 }}
          >
            {PRIORITY_ORDER.map((p) => (
              <option key={p} value={p}>{PRIORITY_META[p].label}</option>
            ))}
          </select>
        </label>

        <label style={{ display: 'grid', gap: 4 }}>
          <span style={{ fontSize: 12, fontWeight: 600, color: '#555' }}>Category</span>
          <input
            type="text"
            value={category}
            onChange={(e) => setCategory(e.target.value)}
            placeholder="plumbing, HVAC, …"
            style={{ padding: '8px 10px', border: '1px solid #ccc', borderRadius: 6, fontSize: 14 }}
          />
        </label>
      </div>

      {err && (
        <div style={{
          padding: '8px 12px', background: '#FFEBEE', border: '1px solid #FFCDD2',
          borderRadius: 6, color: '#C62828', fontSize: 13,
        }}>{err}</div>
      )}

      <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
        <button type="button" onClick={onCancel} disabled={saving} style={{
          padding: '8px 14px', border: '1px solid #ccc', background: '#fff',
          borderRadius: 6, cursor: 'pointer', fontSize: 13,
        }}>Cancel</button>
        <button type="submit" disabled={saving} style={{
          padding: '8px 14px', border: 'none', background: '#1976D2', color: '#fff',
          borderRadius: 6, cursor: 'pointer', fontSize: 13, fontWeight: 600,
          display: 'inline-flex', alignItems: 'center', gap: 6,
        }}>
          {saving ? <><Loader2 size={14} className="spin" /> Creating…</> : <><Plus size={14} /> Create ticket</>}
        </button>
      </div>
    </form>
  );
}

// ── Detail panel (comments timeline + controls) ──────────────────

function TicketDetail({ ticket, vendors, onChanged }) {
  const [comments, setComments] = useState(null);
  const [loadingComments, setLoadingComments] = useState(true);
  const [commentBody, setCommentBody] = useState('');
  const [isInternal, setIsInternal] = useState(false);
  const [posting, setPosting] = useState(false);
  const [postErr, setPostErr] = useState(null);
  const [updating, setUpdating] = useState(false);

  const loadComments = useCallback(async () => {
    setLoadingComments(true);
    try {
      const j = await fetchJson('/api/admin/list-ticket-comments', { query: { ticket_id: ticket.id } });
      setComments(j.comments || []);
    } catch (e) {
      setPostErr(e.message);
    } finally {
      setLoadingComments(false);
    }
  }, [ticket.id]);

  useEffect(() => { loadComments(); }, [loadComments]);

  const postComment = async (e) => {
    e.preventDefault();
    if (!commentBody.trim()) return;
    setPosting(true);
    setPostErr(null);
    try {
      await fetchJson('/api/admin/add-ticket-comment', {
        method: 'POST',
        body: { ticket_id: ticket.id, body: commentBody.trim(), is_internal: isInternal },
      });
      setCommentBody('');
      setIsInternal(false);
      await loadComments();
      onChanged();
    } catch (e2) {
      setPostErr(e2.message);
    } finally {
      setPosting(false);
    }
  };

  const updateField = async (patch) => {
    setUpdating(true);
    try {
      await fetchJson('/api/admin/upsert-maintenance-ticket', {
        method: 'POST',
        body: { id: ticket.id, ...patch },
      });
      onChanged();
    } catch (e) {
      setPostErr(e.message);
    } finally {
      setUpdating(false);
    }
  };

  return (
    <div style={{
      padding: 16, background: '#fafbfc', borderTop: '1px solid #e8eaed',
      display: 'grid', gap: 14,
    }}>
      {/* Controls row */}
      <div style={{
        display: 'grid', gap: 10,
        gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))',
      }}>
        <label style={{ display: 'grid', gap: 4 }}>
          <span style={{ fontSize: 11, fontWeight: 600, color: '#666', textTransform: 'uppercase' }}>Status</span>
          <select
            value={ticket.status}
            disabled={updating}
            onChange={(e) => updateField({ status: e.target.value })}
            style={{ padding: '6px 8px', border: '1px solid #ccc', borderRadius: 6, fontSize: 13 }}
          >
            {STATUS_ORDER.map((s) => (
              <option key={s} value={s}>{STATUS_META[s].label}</option>
            ))}
          </select>
        </label>

        <label style={{ display: 'grid', gap: 4 }}>
          <span style={{ fontSize: 11, fontWeight: 600, color: '#666', textTransform: 'uppercase' }}>Priority</span>
          <select
            value={ticket.priority}
            disabled={updating}
            onChange={(e) => updateField({ priority: e.target.value })}
            style={{ padding: '6px 8px', border: '1px solid #ccc', borderRadius: 6, fontSize: 13 }}
          >
            {PRIORITY_ORDER.map((p) => (
              <option key={p} value={p}>{PRIORITY_META[p].label}</option>
            ))}
          </select>
        </label>

        <label style={{ display: 'grid', gap: 4 }}>
          <span style={{ fontSize: 11, fontWeight: 600, color: '#666', textTransform: 'uppercase' }}>Vendor</span>
          <select
            value={ticket.vendor_id || ''}
            disabled={updating}
            onChange={(e) => updateField({ vendor_id: e.target.value || null })}
            style={{ padding: '6px 8px', border: '1px solid #ccc', borderRadius: 6, fontSize: 13 }}
          >
            <option value="">— (unassigned)</option>
            {vendors.map((v) => (
              <option key={v.id} value={v.id}>{v.display_name}</option>
            ))}
          </select>
        </label>
      </div>

      {ticket.description && (
        <div style={{
          padding: 12, background: '#fff', borderRadius: 8, border: '1px solid #e0e0e0',
          fontSize: 13, color: '#333', whiteSpace: 'pre-wrap',
        }}>{ticket.description}</div>
      )}

      {/* Timeline */}
      <div>
        <div style={{
          display: 'flex', alignItems: 'center', gap: 6, marginBottom: 8,
          fontSize: 12, fontWeight: 600, color: '#666', textTransform: 'uppercase',
        }}>
          <MessageSquare size={14} /> Timeline
        </div>

        {loadingComments && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, color: '#888', fontSize: 13 }}>
            <Loader2 size={14} className="spin" /> Loading comments…
          </div>
        )}

        {!loadingComments && comments && comments.length === 0 && (
          <div style={{ color: '#888', fontSize: 13, fontStyle: 'italic' }}>
            No comments yet. Add the first one below.
          </div>
        )}

        {!loadingComments && comments && comments.length > 0 && (
          <div style={{ display: 'grid', gap: 8 }}>
            {comments.map((c) => {
              const meta = AUTHOR_TYPE_META[c.author_type] || AUTHOR_TYPE_META.system;
              return (
                <div key={c.id} style={{
                  padding: 10,
                  background: c.is_internal ? '#FFFDE7' : '#fff',
                  border: `1px solid ${c.is_internal ? '#FFF59D' : '#e0e0e0'}`,
                  borderLeft: `3px solid ${meta.color}`,
                  borderRadius: 6,
                }}>
                  <div style={{
                    display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                    fontSize: 11, color: '#666', marginBottom: 4,
                  }}>
                    <span>
                      <strong style={{ color: meta.color }}>{meta.label}</strong>
                      {c.author_display && <span> · {c.author_display}</span>}
                      {c.is_internal && (
                        <span style={{ marginLeft: 6, color: '#F57C00', display: 'inline-flex', alignItems: 'center', gap: 3 }}>
                          <Lock size={10} /> internal
                        </span>
                      )}
                    </span>
                    <span>{fmtDateTime(c.created_at)}</span>
                  </div>
                  <div style={{ fontSize: 13, color: '#222', whiteSpace: 'pre-wrap' }}>{c.body}</div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Comment composer */}
      <form onSubmit={postComment} style={{
        display: 'grid', gap: 6, padding: 10, background: '#fff',
        border: '1px solid #e0e0e0', borderRadius: 8,
      }}>
        <textarea
          rows={2}
          value={commentBody}
          onChange={(e) => setCommentBody(e.target.value)}
          placeholder="Add a comment…"
          style={{
            padding: '6px 8px', border: '1px solid #d0d0d0', borderRadius: 4,
            fontSize: 13, fontFamily: 'inherit', resize: 'vertical',
          }}
        />
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12, color: '#555' }}>
            <input
              type="checkbox"
              checked={isInternal}
              onChange={(e) => setIsInternal(e.target.checked)}
            />
            <Lock size={12} /> Internal note (staff-only)
          </label>
          <button type="submit" disabled={posting || !commentBody.trim()} style={{
            padding: '6px 12px', border: 'none', background: '#1976D2', color: '#fff',
            borderRadius: 6, cursor: posting || !commentBody.trim() ? 'not-allowed' : 'pointer',
            opacity: posting || !commentBody.trim() ? 0.6 : 1,
            fontSize: 12, fontWeight: 600,
            display: 'inline-flex', alignItems: 'center', gap: 5,
          }}>
            {posting ? <><Loader2 size={12} className="spin" /> Posting…</> : <><Send size={12} /> Post</>}
          </button>
        </div>
      </form>

      {postErr && (
        <div style={{
          padding: '8px 12px', background: '#FFEBEE', border: '1px solid #FFCDD2',
          borderRadius: 6, color: '#C62828', fontSize: 12,
        }}>{postErr}</div>
      )}
    </div>
  );
}

// ── Ticket row ──────────────────────────────────────────────────

function TicketRow({ ticket, vendors, expanded, onToggle, onChanged }) {
  return (
    <div style={{
      background: '#fff', border: '1px solid #e0e0e0', borderRadius: 10,
      marginBottom: 8, overflow: 'hidden',
    }}>
      <div
        role="button"
        tabIndex={0}
        onClick={onToggle}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onToggle(); } }}
        style={{
          padding: '12px 14px', cursor: 'pointer', display: 'flex',
          alignItems: 'center', gap: 12,
        }}
      >
        <div style={{ color: '#888' }}>
          {expanded ? <ChevronDown size={18} /> : <ChevronRight size={18} />}
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 14, fontWeight: 600, color: '#222', marginBottom: 3 }}>{ticket.title}</div>
          <div style={{
            display: 'flex', flexWrap: 'wrap', gap: 10,
            fontSize: 12, color: '#666',
          }}>
            {ticket.property_name && (
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 3 }}>
                <Building2 size={11} /> {ticket.property_name}
              </span>
            )}
            {ticket.unit_name && (
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 3 }}>
                <Home size={11} /> {ticket.unit_name}
              </span>
            )}
            {ticket.vendor_name && (
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 3 }}>
                <Wrench size={11} /> {ticket.vendor_name}
              </span>
            )}
            {ticket.category && <span>· {ticket.category}</span>}
            <span>· reported {fmtDate(ticket.reported_at)}</span>
          </div>
        </div>
        <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexShrink: 0 }}>
          <PriorityBadge priority={ticket.priority} />
          <StatusBadge status={ticket.status} />
        </div>
      </div>
      {expanded && (
        <TicketDetail ticket={ticket} vendors={vendors} onChanged={onChanged} />
      )}
    </div>
  );
}

// ── Stat card ───────────────────────────────────────────────────

function StatCard({ label, value, accent }) {
  return (
    <div style={{
      background: '#fff', border: '1px solid #e0e0e0', borderRadius: 10,
      padding: '12px 14px',
    }}>
      <div style={{ fontSize: 11, fontWeight: 600, color: '#888', textTransform: 'uppercase', marginBottom: 4 }}>
        {label}
      </div>
      <div style={{ fontSize: 22, fontWeight: 700, color: accent || '#222' }}>{value}</div>
    </div>
  );
}

// ── Main page ───────────────────────────────────────────────────

export default function MaintenancePage({ initialFilters } = {}) {
  const [tickets, setTickets] = useState(null);
  const [summary, setSummary] = useState([]);
  const [properties, setProperties] = useState([]);
  const [vendors, setVendors] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  // Dashboard's maintenance card hands us a ticketDisplayId so the
  // user lands on the right ticket. Pre-set search to it and show
  // 'all' statuses (the ticket might be closed) so the filter chips
  // don't hide what the user just clicked.
  const initialStatus = initialFilters?.ticketDisplayId ? 'all' : 'open';
  const initialSearch = initialFilters?.ticketDisplayId || '';
  const [statusFilter, setStatusFilter] = useState(initialStatus);
  const [priorityFilter, setPriorityFilter] = useState('all');
  const [search, setSearch] = useState(initialSearch);
  const [expandedId, setExpandedId] = useState(null);
  const [showNew, setShowNew] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [syncResult, setSyncResult] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [tjson, pjson, vjson] = await Promise.all([
        fetchJson('/api/admin/list-maintenance-tickets', { query: { status: statusFilter } }),
        fetchJson('/api/admin/list-properties-summary').catch(() => ({ properties: [] })),
        fetchJson('/api/admin/list-vendors').catch(() => ({ vendors: [] })),
      ]);
      setTickets(tjson.tickets || []);
      setSummary(tjson.summary_by_status || []);
      setProperties(pjson.properties || []);
      setVendors(vjson.vendors || []);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, [statusFilter]);

  useEffect(() => { load(); }, [load]);

  const syncFromAppfolio = async (status = 'all') => {
    setSyncing(true);
    setSyncResult(null);
    try {
      const j = await fetchJson('/api/admin/sync-appfolio-tickets', {
        method: 'POST',
        body: { status },
      });
      setSyncResult({
        ok: true,
        fetched: j.fetched,
        inserted: j.inserted,
        updated: j.updated,
        skipped: j.skipped_no_property,
      });
      await load();
    } catch (e) {
      setSyncResult({ ok: false, error: e.message });
    } finally {
      setSyncing(false);
    }
  };

  const filtered = useMemo(() => {
    let list = tickets || [];
    if (priorityFilter !== 'all') list = list.filter((t) => t.priority === priorityFilter);
    if (search.trim()) {
      const q = search.trim().toLowerCase();
      list = list.filter((t) =>
        t.title?.toLowerCase().includes(q) ||
        t.description?.toLowerCase().includes(q) ||
        t.property_name?.toLowerCase().includes(q) ||
        t.unit_name?.toLowerCase().includes(q) ||
        t.vendor_name?.toLowerCase().includes(q) ||
        t.category?.toLowerCase().includes(q),
      );
    }
    return list.slice().sort((a, b) => {
      const ar = PRIORITY_META[a.priority]?.rank || 0;
      const br = PRIORITY_META[b.priority]?.rank || 0;
      if (ar !== br) return br - ar;
      return new Date(b.reported_at).getTime() - new Date(a.reported_at).getTime();
    });
  }, [tickets, priorityFilter, search]);

  const counts = useMemo(() => {
    const c = { total: 0, open: 0, urgent: 0, completed: 0 };
    for (const s of summary) {
      c.total += s.count;
      if (s.status === 'completed') c.completed += s.count;
      else if (s.status !== 'cancelled') c.open += s.count;
    }
    c.urgent = (tickets || []).filter(
      (t) => t.status !== 'completed' && t.status !== 'cancelled'
        && (t.priority === 'emergency' || t.priority === 'high'),
    ).length;
    return c;
  }, [summary, tickets]);

  if (loading && !tickets) {
    return (
      <div style={{ padding: 32, display: 'flex', alignItems: 'center', gap: 10, color: '#666' }}>
        <Loader2 size={20} className="spin" /> Loading maintenance tickets…
      </div>
    );
  }

  if (error) {
    return (
      <div style={{ padding: 24 }}>
        <div style={{
          padding: 16, background: '#FFEBEE', border: '1px solid #FFCDD2',
          borderRadius: 8, color: '#C62828',
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6, fontWeight: 600 }}>
            <AlertCircle size={16} /> Failed to load maintenance tickets
          </div>
          <div style={{ fontSize: 13, fontFamily: 'monospace', wordBreak: 'break-word' }}>{error}</div>
          <div style={{ marginTop: 10, display: 'flex', gap: 8 }}>
            <button onClick={load} style={{
              padding: '6px 12px', border: '1px solid #C62828', background: '#fff',
              color: '#C62828', borderRadius: 6, cursor: 'pointer', fontSize: 12,
              display: 'inline-flex', alignItems: 'center', gap: 5,
            }}><RefreshCw size={12} /> Retry</button>
            <MigrationFixButton error={error} />
          </div>
        </div>
      </div>
    );
  }

  return (
    <div style={{ padding: 24, maxWidth: 1200, margin: '0 auto' }}>
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        marginBottom: 16, gap: 12, flexWrap: 'wrap',
      }}>
        <h1 style={{ margin: 0, fontSize: 22, display: 'flex', alignItems: 'center', gap: 8 }}>
          <Wrench size={22} /> Maintenance
        </h1>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <button onClick={load} style={{
            padding: '7px 12px', border: '1px solid #ccc', background: '#fff',
            borderRadius: 6, cursor: 'pointer', fontSize: 13,
            display: 'inline-flex', alignItems: 'center', gap: 5,
          }}><RefreshCw size={13} /> Refresh</button>
          <button
            onClick={() => syncFromAppfolio('all')}
            disabled={syncing}
            style={{
              padding: '7px 12px', border: '1px solid #1565C0', background: '#fff',
              color: '#1565C0', borderRadius: 6,
              cursor: syncing ? 'wait' : 'pointer', fontSize: 13, fontWeight: 600,
              display: 'inline-flex', alignItems: 'center', gap: 5,
            }}
          >
            {syncing
              ? <><Loader2 size={13} className="spin" /> Syncing…</>
              : <><Download size={13} /> Sync from AppFolio</>}
          </button>
          <button onClick={() => setShowNew((v) => !v)} style={{
            padding: '7px 14px', border: 'none', background: '#1976D2', color: '#fff',
            borderRadius: 6, cursor: 'pointer', fontSize: 13, fontWeight: 600,
            display: 'inline-flex', alignItems: 'center', gap: 5,
          }}><Plus size={14} /> New ticket</button>
        </div>
      </div>

      {syncResult && (
        <div style={{
          marginBottom: 12,
          padding: '10px 14px', borderRadius: 8, fontSize: 13,
          background: syncResult.ok ? '#E8F5E9' : '#FFEBEE',
          border: `1px solid ${syncResult.ok ? '#C8E6C9' : '#FFCDD2'}`,
          color: syncResult.ok ? '#2E7D32' : '#C62828',
          display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10,
        }}>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            {syncResult.ok
              ? <><CheckCircle2 size={14} /> Synced {syncResult.fetched} AppFolio work orders — {syncResult.inserted} new, {syncResult.updated} updated{syncResult.skipped > 0 ? `, ${syncResult.skipped} skipped (property not in DB)` : ''}.</>
              : <><AlertCircle size={14} /> Sync failed: {syncResult.error}</>}
          </span>
          <button onClick={() => setSyncResult(null)} style={{
            background: 'transparent', border: 'none', cursor: 'pointer',
            color: 'inherit', padding: 2,
          }}><X size={14} /></button>
        </div>
      )}

      {/* Stats */}
      <div style={{
        display: 'grid', gap: 10, marginBottom: 16,
        gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))',
      }}>
        <StatCard label="Open" value={counts.open} accent="#1976D2" />
        <StatCard label="Urgent / High" value={counts.urgent} accent={counts.urgent > 0 ? '#C62828' : '#222'} />
        <StatCard label="Completed" value={counts.completed} accent="#2E7D32" />
        <StatCard label="Total" value={counts.total} />
      </div>

      {showNew && (
        <NewTicketForm
          properties={properties}
          vendors={vendors}
          onCancel={() => setShowNew(false)}
          onCreated={() => { setShowNew(false); load(); }}
        />
      )}

      {/* Filters */}
      <div style={{
        display: 'grid', gap: 10, marginBottom: 14,
        gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
      }}>
        <label style={{ display: 'grid', gap: 4 }}>
          <span style={{ fontSize: 11, fontWeight: 600, color: '#666', textTransform: 'uppercase' }}>Status</span>
          <select
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value)}
            style={{ padding: '7px 9px', border: '1px solid #ccc', borderRadius: 6, fontSize: 13 }}
          >
            <option value="open">Open (any active)</option>
            <option value="all">All</option>
            {STATUS_ORDER.map((s) => (
              <option key={s} value={s}>{STATUS_META[s].label}</option>
            ))}
          </select>
        </label>

        <label style={{ display: 'grid', gap: 4 }}>
          <span style={{ fontSize: 11, fontWeight: 600, color: '#666', textTransform: 'uppercase' }}>Priority</span>
          <select
            value={priorityFilter}
            onChange={(e) => setPriorityFilter(e.target.value)}
            style={{ padding: '7px 9px', border: '1px solid #ccc', borderRadius: 6, fontSize: 13 }}
          >
            <option value="all">Any</option>
            {PRIORITY_ORDER.map((p) => (
              <option key={p} value={p}>{PRIORITY_META[p].label}</option>
            ))}
          </select>
        </label>

        <label style={{ display: 'grid', gap: 4, gridColumn: 'span 2', minWidth: 0 }}>
          <span style={{ fontSize: 11, fontWeight: 600, color: '#666', textTransform: 'uppercase' }}>Search</span>
          <div style={{ position: 'relative' }}>
            <Search size={14} style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', color: '#888' }} />
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Title, property, unit, vendor…"
              style={{ width: '100%', padding: '7px 9px 7px 30px', border: '1px solid #ccc', borderRadius: 6, fontSize: 13, boxSizing: 'border-box' }}
            />
          </div>
        </label>
      </div>

      {filtered.length === 0 ? (
        <div style={{
          padding: 32, textAlign: 'center', background: '#fafbfc',
          border: '1px dashed #d0d0d0', borderRadius: 10, color: '#666',
        }}>
          <Wrench size={28} style={{ marginBottom: 8, opacity: 0.4 }} />
          <div style={{ fontSize: 14 }}>
            {tickets && tickets.length === 0
              ? 'No tickets yet — click "New ticket" to create one.'
              : 'No tickets match your filters.'}
          </div>
        </div>
      ) : (
        <div>
          {filtered.map((t) => (
            <TicketRow
              key={t.id}
              ticket={t}
              vendors={vendors}
              expanded={expandedId === t.id}
              onToggle={() => setExpandedId((id) => (id === t.id ? null : t.id))}
              onChanged={load}
            />
          ))}
        </div>
      )}
    </div>
  );
}
