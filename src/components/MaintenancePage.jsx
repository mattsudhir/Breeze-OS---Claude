import { useState, useEffect } from 'react';
import {
  Wrench, Search, CheckCircle2, AlertCircle, Loader2, WifiOff,
  ChevronLeft, Building2, Home, Clock, Calendar, User as UserIcon,
  AlertTriangle, Zap, Droplet, Flame, Wind, Lightbulb, Hammer,
  Edit3, Save, X,
} from 'lucide-react';
// Data fetches (work orders / properties / units) go through the
// backend-aware services/data.js so they respect the toggle. Filter
// metadata (categories / statuses / priorities) and the edit form
// (updateWorkOrder / getWorkOrder) are still RM-only — AppFolio has
// its own status / priority enums but we haven't surfaced them as
// tools yet, and we don't have a write path for AppFolio work
// orders. When AppFolio is active, the filter dropdowns degrade to
// what's hardcoded inline and the edit drawer surfaces a "not yet
// supported" message.
import { getWorkOrders, getProperties, getUnits } from '../services/data';
import {
  getWorkOrderCategories, getWorkOrderStatuses, getWorkOrderPriorities,
  updateWorkOrder, getWorkOrder,
} from '../services/rentManager';
import { useDataSource } from '../contexts/DataSourceContext.jsx';

// ── Helpers ──────────────────────────────────────────────────────

function normalizeCategory(raw) {
  const c = (raw || '').toLowerCase();
  if (!c) return 'other';
  if (c.includes('hvac') || c.includes('heat') || c.includes('air') || c.includes('cool')) return 'hvac';
  if (c.includes('plumb') || c.includes('leak') || c.includes('water') || c.includes('pipe') || c.includes('toilet') || c.includes('faucet') || c.includes('drain')) return 'plumbing';
  if (c.includes('electric') || c.includes('outlet') || c.includes('wiring') || c.includes('light')) return 'electrical';
  if (c.includes('appliance') || c.includes('refrig') || c.includes('dishwash') || c.includes('dryer') || c.includes('washer') || c.includes('oven') || c.includes('stove')) return 'appliance';
  if (c.includes('pest') || c.includes('roach') || c.includes('rodent') || c.includes('bug')) return 'pest';
  if (c.includes('lock') || c.includes('key') || c.includes('door')) return 'locks';
  if (c.includes('general') || c.includes('maint')) return 'general';
  return 'other';
}

const CATEGORY_META = {
  hvac:       { label: 'HVAC',       icon: Wind,       color: '#1565C0' },
  plumbing:   { label: 'Plumbing',   icon: Droplet,    color: '#00838F' },
  electrical: { label: 'Electrical', icon: Zap,        color: '#F9A825' },
  appliance:  { label: 'Appliance',  icon: Lightbulb,  color: '#6A1B9A' },
  pest:       { label: 'Pest',       icon: Flame,      color: '#C62828' },
  locks:      { label: 'Locks',      icon: Hammer,     color: '#546E7A' },
  general:    { label: 'General',    icon: Wrench,     color: '#2E7D32' },
  other:      { label: 'Other',      icon: Wrench,     color: '#757575' },
};

function priorityRank(p) {
  const pl = (p || '').toLowerCase();
  if (pl.includes('emerg') || pl.includes('urgent')) return 4;
  if (pl.includes('high')) return 3;
  if (pl.includes('med') || pl.includes('normal')) return 2;
  if (pl.includes('low')) return 1;
  return 2;
}

function priorityMeta(p) {
  const r = priorityRank(p);
  if (r === 4) return { label: 'Urgent', className: 'priority-urgent', icon: AlertTriangle };
  if (r === 3) return { label: 'High',   className: 'priority-high',   icon: AlertCircle };
  if (r === 2) return { label: 'Medium', className: 'priority-medium', icon: Clock };
  return { label: 'Low', className: 'priority-low', icon: Clock };
}

// Resolve a work order's status using RM's source-of-truth fields:
// - isClosed (boolean on the work order itself)
// - statusLookup map (from /ServiceManagerStatuses, has each status's
//   own IsClosed flag and human name)
// Returns a consistent { label, className, isOpen } shape for the UI.
function statusMetaFromWo(wo, statusLookup) {
  const lookupEntry =
    wo.statusId != null ? statusLookup?.[wo.statusId] : null;

  // RM's IsClosed on the work order is authoritative. Fall back to the
  // lookup entry's IsClosed flag, then to keyword matching on the name.
  const isClosed =
    wo.isClosed === true ||
    lookupEntry?.isClosed === true ||
    /complete|closed|resolved/i.test(wo.status || '');

  // Display name: prefer the RM status name verbatim so we never
  // mis-label a custom status.
  const label = lookupEntry?.name || wo.status || (isClosed ? 'Closed' : 'Open');

  // Color/tone — three buckets: closed, in-progress-ish, plain open
  let className = 'status-open';
  if (isClosed) {
    className = 'status-completed';
  } else if (/progress|working|active/i.test(label)) {
    className = 'status-in_progress';
  } else if (/assign|scheduled/i.test(label)) {
    className = 'status-assigned';
  } else if (/hold|wait/i.test(label)) {
    className = 'status-onhold';
  }

  return { label, className, isOpen: !isClosed };
}

function formatDate(d) {
  if (!d) return '—';
  try {
    return new Date(d).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
  } catch {
    return d;
  }
}

// ── Detail view ──────────────────────────────────────────────────

function WorkOrderDetail({
  workOrder, categories, statuses, priorities, statusLookup,
  onBack, onUpdated,
}) {
  const { dataSource, sources } = useDataSource();
  const sourceLabel = sources.find((s) => s.value === dataSource)?.label || dataSource;
  const catKey = normalizeCategory(workOrder.category);
  const cat = CATEGORY_META[catKey];
  const CatIcon = cat.icon;
  const pri = priorityMeta(workOrder.priority);
  const PriIcon = pri.icon;
  const status = statusMetaFromWo(workOrder, statusLookup);

  const [editing, setEditing] = useState(false);
  const [editLoading, setEditLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState(null);
  const [saveOk, setSaveOk] = useState(false);
  const [form, setForm] = useState({});

  const startEdit = async () => {
    setSaveError(null);
    setSaveOk(false);
    setEditing(true);
    setEditLoading(true);

    // Seed from the list-view record first for an instant UI
    setForm({
      summary: workOrder.summary || '',
      description: workOrder.description || '',
      priorityId: workOrder.priorityId || '',
      categoryId: workOrder.categoryId || '',
      statusId: workOrder.statusId || '',
    });

    // Then overwrite with a fresh record so the form reflects the current
    // server state rather than whatever was cached in the list. RM-only —
    // when AppFolio is active we keep the cached row in the form (the
    // user can't actually save edits anyway, the saveEdit guard short-
    // circuits with a clear message).
    if (dataSource === 'appfolio') {
      setEditLoading(false);
      return;
    }
    try {
      const fresh = await getWorkOrder(workOrder.id);
      if (fresh) {
        setForm({
          summary: fresh.Title || fresh.Summary || fresh.Description || '',
          description: fresh.Description || '',
          priorityId: fresh.PriorityID || '',
          categoryId: fresh.CategoryID || '',
          statusId: fresh.StatusID || '',
        });
      }
    } catch {
      // fall through — form already has list-view values as a fallback
    } finally {
      setEditLoading(false);
    }
  };

  const cancelEdit = () => {
    setEditing(false);
    setSaveError(null);
  };

  const save = async () => {
    setSaving(true);
    setSaveError(null);
    try {
      // RM requires numeric IDs for priority/category/status — strings are
      // rejected with a type conversion error.
      const patch = {
        summary: form.summary,
        description: form.description,
      };
      if (form.priorityId) patch.priorityId = Number(form.priorityId);
      if (form.categoryId) patch.categoryId = Number(form.categoryId);
      if (form.statusId) patch.statusId = Number(form.statusId);

      if (dataSource === 'appfolio') {
        throw new Error(
          `Editing work orders is not yet supported when AppFolio is active. ` +
          `Switch to Rent Manager to edit, or update the ticket directly in AppFolio.`,
        );
      }
      await updateWorkOrder(workOrder.id, patch);
      setEditing(false);
      setSaveOk(true);
      if (onUpdated) onUpdated(workOrder.id);
      setTimeout(() => setSaveOk(false), 3000);
    } catch (err) {
      setSaveError(err.message || 'Failed to save changes');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="properties-page">
      <button className="back-link" onClick={onBack}>
        <ChevronLeft size={14} /> Back to all maintenance
      </button>

      <div className="tenant-detail-topbar">
        <div className="property-detail-header" style={{ flex: 1 }}>
          <div
            className="wo-detail-icon"
            style={{ background: cat.color + '15', color: cat.color }}
          >
            <CatIcon size={28} />
          </div>
          <div style={{ flex: 1 }}>
            <h2>{workOrder.summary || `Work Order ${workOrder.id}`}</h2>
            <p className="property-detail-address">
              <span className={`unit-status ${status.className}`}>{status.label}</span>
              <span className={`unit-status ${pri.className}`} style={{ marginLeft: 6 }}>
                <PriIcon size={12} /> {pri.label}
              </span>
              <span className="tenant-display-id">#{workOrder.displayId || workOrder.id}</span>
            </p>
          </div>
        </div>
        {!editing && (
          <button className="btn-primary tenant-edit-btn" onClick={startEdit}>
            <Edit3 size={14} /> Edit
          </button>
        )}
      </div>

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
        <div className="dashboard-card">
          <div className="card-header">
            <h3>
              <Edit3 size={18} /> Edit Work Order
              {editLoading && (
                <span style={{ marginLeft: 10, fontSize: 12, color: '#6c757d', fontWeight: 400 }}>
                  <Loader2 size={12} className="spin" /> refreshing...
                </span>
              )}
            </h3>
          </div>
          <form
            className="tenant-edit-form"
            onSubmit={(e) => { e.preventDefault(); save(); }}
          >
            <label>
              <span>Summary</span>
              <input
                type="text"
                value={form.summary}
                onChange={(e) => setForm({ ...form, summary: e.target.value })}
              />
            </label>

            <label>
              <span>Description</span>
              <textarea
                rows={4}
                value={form.description}
                onChange={(e) => setForm({ ...form, description: e.target.value })}
              />
            </label>

            <div className="form-row">
              <label>
                <span>Priority</span>
                <select
                  value={form.priorityId}
                  onChange={(e) => setForm({ ...form, priorityId: e.target.value })}
                >
                  <option value="">—</option>
                  {priorities.map((p) => (
                    <option key={p.id} value={p.id}>{p.name}</option>
                  ))}
                </select>
              </label>

              <label>
                <span>Category</span>
                <select
                  value={form.categoryId}
                  onChange={(e) => setForm({ ...form, categoryId: e.target.value })}
                >
                  <option value="">—</option>
                  {categories.map((c) => (
                    <option key={c.id} value={c.id}>{c.name}</option>
                  ))}
                </select>
              </label>
            </div>

            <label>
              <span>Status</span>
              <select
                value={form.statusId}
                onChange={(e) => setForm({ ...form, statusId: e.target.value })}
              >
                <option value="">—</option>
                {statuses.map((s) => (
                  <option key={s.id} value={s.id}>{s.name}</option>
                ))}
              </select>
            </label>

            <div className="form-actions">
              <button type="button" className="btn-secondary" onClick={cancelEdit} disabled={saving}>
                <X size={14} /> Cancel
              </button>
              <button type="submit" className="btn-primary" disabled={saving}>
                {saving
                  ? <><Loader2 size={14} className="spin" /> Saving...</>
                  : <><Save size={14} /> Save Changes</>}
              </button>
            </div>
          </form>
        </div>
      ) : (
        <>
          <div className="dashboard-card">
            <div className="card-header">
              <h3><Wrench size={18} /> Work Order Details</h3>
            </div>
            <div className="tenant-detail-list">
              <DetailRow icon={CatIcon} label="Category" value={workOrder.category || cat.label} />
              <DetailRow
                icon={Building2}
                label="Property"
                value={workOrder.propertyName || (workOrder.propertyId ? `Property #${workOrder.propertyId}` : '—')}
              />
              <DetailRow
                icon={Home}
                label="Unit"
                value={workOrder.unitName || (workOrder.unitId ? `Unit #${workOrder.unitId}` : '—')}
              />
              <DetailRow icon={UserIcon} label="Assigned to" value={workOrder.assignedTo || '—'} />
              <DetailRow icon={Calendar} label="Created" value={formatDate(workOrder.createdDate)} />
              <DetailRow icon={Calendar} label="Scheduled" value={formatDate(workOrder.scheduledDate)} />
              {workOrder.completedDate && (
                <DetailRow icon={CheckCircle2} label="Completed" value={formatDate(workOrder.completedDate)} />
              )}
            </div>
          </div>

          {workOrder.description && workOrder.description !== workOrder.summary && (
            <div className="dashboard-card">
              <div className="card-header">
                <h3><Wrench size={18} /> Description</h3>
              </div>
              <p className="tenant-notes">{workOrder.description}</p>
            </div>
          )}
        </>
      )}
    </div>
  );
}

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

// ── Main page ───────────────────────────────────────────────────

// Translate chat-supplied filters into the page's internal filter state.
// Chat sends keys like { status, min_priority, category, search }.
// min_priority is a keyword ("urgent" | "high" | "medium" | "low") but the
// page now filters by numeric priorityId. We stash the keyword on a
// separate field and resolve it to an ID in an effect once the lookup
// has loaded.
function normalizeInitialFilters(initial) {
  if (!initial) return {};
  return {
    statusFilter:
      initial.status === 'completed' ? 'completed'
      : initial.status === 'all' ? 'all'
      : initial.status === 'open' ? 'open'
      : undefined,
    categoryFilter: initial.category
      ? normalizeCategory(initial.category)
      : undefined,
    priorityKeyword: initial.min_priority || undefined,
    searchTerm: initial.search || undefined,
  };
}

export default function MaintenancePage({ initialFilters }) {
  const { dataSource, sources } = useDataSource();
  const sourceLabel = sources.find((s) => s.value === dataSource)?.label || dataSource;
  const applied = normalizeInitialFilters(initialFilters);

  const [workOrders, setWorkOrders] = useState(null);
  const [propertyMap, setPropertyMap] = useState({});
  const [unitMap, setUnitMap] = useState({});
  const [loading, setLoading] = useState(true);
  const [isLive, setIsLive] = useState(false);
  const [searchTerm, setSearchTerm] = useState(applied.searchTerm || '');
  const [categoryFilter, setCategoryFilter] = useState(applied.categoryFilter || 'all');
  const [statusFilter, setStatusFilter] = useState(applied.statusFilter || 'open');
  const [priorityFilter, setPriorityFilter] = useState('all');
  const [pendingPriorityKeyword, setPendingPriorityKeyword] = useState(
    applied.priorityKeyword || null,
  );
  const [selectedId, setSelectedId] = useState(null);

  const [categoryLookup, setCategoryLookup] = useState({});
  const [statusLookup, setStatusLookup] = useState({});
  const [priorityLookup, setPriorityLookup] = useState({});
  const [fetchFailed, setFetchFailed] = useState(false);
  const [fetchError, setFetchError] = useState(null);
  const [fetchMs, setFetchMs] = useState(null);
  const [reloadTick, setReloadTick] = useState(0);

  // When an initial chat filter specified a priority keyword like "urgent"
  // but the priority lookup hadn't loaded yet, resolve it to the matching
  // priorityId as soon as the lookup is populated.
  useEffect(() => {
    if (!pendingPriorityKeyword) return;
    if (!priorityLookup || Object.keys(priorityLookup).length === 0) return;
    const targetRank = priorityRank(pendingPriorityKeyword);
    const match = Object.entries(priorityLookup).find(
      ([, name]) => priorityRank(name) === targetRank,
    );
    if (match) {
      setPriorityFilter(String(match[0]));
    }
    setPendingPriorityKeyword(null);
  }, [pendingPriorityKeyword, priorityLookup]);

  // Critical path: fetch work orders AND priorities in parallel. Priorities
  // must be loaded before the filter dropdown renders or we fall back to
  // unreliable legacy string guessing.
  useEffect(() => {
    let cancelled = false;
    async function fetchTickets() {
      setLoading(true);
      setFetchFailed(false);
      setFetchError(null);
      setFetchMs(null);
      const startedAt = Date.now();
      try {
        // Priorities lookup is RM-only metadata. When AppFolio is the
        // active source, skip the call (it would return unrelated RM
        // priority IDs that don't match anything in our work orders)
        // and let the page fall back to the inline priority strings.
        const [woResult, prioritiesResult] = await Promise.allSettled([
          getWorkOrders(dataSource, { status: 'all' }),
          dataSource === 'appfolio'
            ? Promise.resolve(null)
            : getWorkOrderPriorities(),
        ]);
        if (cancelled) return;
        setFetchMs(Date.now() - startedAt);

        if (woResult.status === 'fulfilled' && woResult.value) {
          setWorkOrders(woResult.value);
          setIsLive(true);
        } else {
          setFetchFailed(true);
          const err = woResult.status === 'rejected' ? woResult.reason : null;
          setFetchError(err?.message || `Empty response from ${sourceLabel}`);
        }

        if (prioritiesResult.status === 'fulfilled' && prioritiesResult.value) {
          const map = {};
          prioritiesResult.value.forEach((p) => { map[p.id] = p.name; });
          setPriorityLookup(map);
        } else {
          setPriorityLookup({});
        }
      } catch (err) {
        if (cancelled) return;
        setFetchMs(Date.now() - startedAt);
        setFetchFailed(true);
        setFetchError(err?.message || String(err));
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    fetchTickets();
    return () => { cancelled = true; };
  }, [reloadTick, dataSource]);

  // Phase two: the remaining lookups aren't on the critical path.
  useEffect(() => {
    if (!workOrders) return;
    let cancelled = false;

    async function fetchLookups() {
      // Properties + units come from the backend-aware service.
      // Categories + statuses are RM-only metadata; on AppFolio they
      // resolve to empty lookups and the page falls back to inline
      // labels and the work-order-row's own .status/.categoryName
      // strings.
      const steps = [
        { fn: () => getProperties(dataSource), apply: (data) => {
          const map = {};
          data.forEach((p) => { map[p.id] = p.name; });
          setPropertyMap(map);
        }},
        { fn: () => getUnits(dataSource), apply: (data) => {
          const map = {};
          data.forEach((u) => { map[u.id] = u.name; });
          setUnitMap(map);
        }},
        { fn: dataSource === 'appfolio' ? null : getWorkOrderCategories, apply: (data) => {
          const map = {};
          data.forEach((c) => { map[c.id] = c.name; });
          setCategoryLookup(map);
        }},
        { fn: dataSource === 'appfolio' ? null : getWorkOrderStatuses, apply: (data) => {
          const map = {};
          data.forEach((s) => { map[s.id] = s; });
          setStatusLookup(map);
        }},
      ];

      for (const step of steps) {
        if (cancelled) return;
        if (!step.fn) continue; // skipped step (e.g. RM-only on AppFolio)
        try {
          const data = await step.fn();
          if (cancelled) return;
          if (data) step.apply(data);
        } catch {
          // ignore individual lookup failures — the list is still usable
        }
      }
    }
    fetchLookups();
    return () => { cancelled = true; };
  }, [workOrders, dataSource]);

  // Enrich work orders with names resolved client-side from lookup tables.
  // RM's list endpoint returns both ID fields and legacy string fields (e.g.
  // Priority / PriorityName) that can disagree with the canonical priorities
  // table. The ID + lookup is the source of truth — never trust the string.
  const enriched = workOrders
    ? workOrders.map((w) => {
        const resolvedCategory =
          (w.categoryId != null ? categoryLookup[w.categoryId] : null) ||
          w.categoryName || w.category || '';
        const resolvedStatus =
          (w.statusId != null ? statusLookup[w.statusId]?.name : null) ||
          w.status || '';
        const resolvedPriority =
          (w.priorityId != null ? priorityLookup[w.priorityId] : null) ||
          w.priority || '';

        return {
          ...w,
          propertyName: propertyMap[w.propertyId] || '',
          unitName: unitMap[w.unitId] || '',
          category: resolvedCategory,
          status: resolvedStatus,
          priority: resolvedPriority,
        };
      })
    : null;

  if (loading) {
    return (
      <div className="properties-page">
        <div className="loading-state">
          <Loader2 size={28} className="spin" />
          <span>Loading maintenance tickets from {sourceLabel}...</span>
        </div>
      </div>
    );
  }

  if (fetchFailed) {
    return (
      <div className="properties-page">
        <div className="empty-state">
          <WifiOff size={40} />
          <h3>Couldn't reach {sourceLabel}</h3>
          <p>The work order endpoint didn't respond successfully.</p>
          {fetchError && (
            <div style={{
              marginTop: 12,
              padding: '10px 14px',
              background: '#FFEBEE',
              border: '1px solid #FFCDD2',
              borderRadius: 8,
              color: '#C62828',
              fontSize: 12,
              fontFamily: 'monospace',
              wordBreak: 'break-word',
              textAlign: 'left',
              maxWidth: 520,
            }}>
              <strong>Error:</strong> {fetchError}
              {fetchMs != null && <div style={{ marginTop: 4 }}>Elapsed: {fetchMs}ms</div>}
            </div>
          )}
          <button
            className="btn-primary"
            style={{ marginTop: 16 }}
            onClick={() => setReloadTick((t) => t + 1)}
          >
            Retry
          </button>
        </div>
      </div>
    );
  }

  if (!enriched || enriched.length === 0) {
    return (
      <div className="properties-page">
        <div className="empty-state">
          <WifiOff size={40} />
          <h3>No maintenance tickets found</h3>
          <p>{sourceLabel} returned an empty list. There are no service orders on file.</p>
        </div>
      </div>
    );
  }

  // Detail view
  if (selectedId) {
    const wo = enriched.find((w) => w.id === selectedId);
    if (!wo) {
      setSelectedId(null);
      return null;
    }
    const categoriesList = Object.entries(categoryLookup).map(([id, name]) => ({
      id: Number(id), name,
    }));
    const statusesList = Object.entries(statusLookup).map(([id, s]) => ({
      id: Number(id), name: s.name || s,
    }));
    const prioritiesList = Object.entries(priorityLookup).map(([id, name]) => ({
      id: Number(id), name,
    }));
    return (
      <WorkOrderDetail
        workOrder={wo}
        categories={categoriesList}
        statuses={statusesList}
        priorities={prioritiesList}
        statusLookup={statusLookup}
        onBack={() => setSelectedId(null)}
        onUpdated={() => setReloadTick((t) => t + 1)}
      />
    );
  }

  // ── Counts used for filter chip labels ─────────────────────────
  const categoryCounts = enriched.reduce((acc, w) => {
    const k = normalizeCategory(w.category);
    acc[k] = (acc[k] || 0) + 1;
    return acc;
  }, {});

  const openCount = enriched.filter((w) => statusMetaFromWo(w, statusLookup).isOpen).length;
  const completedCount = enriched.length - openCount;
  const urgentOpenCount = enriched.filter(
    (w) => statusMetaFromWo(w, statusLookup).isOpen && priorityRank(w.priority) >= 3,
  ).length;

  // ── Apply filters ──────────────────────────────────────────────
  // Build a list of priorities from the lookup, ordered high → low by
  // keyword severity so the dropdown reads naturally. Using priorityId as
  // the filter key avoids all keyword-guessing on the legacy string field.
  const priorityOptions = Object.entries(priorityLookup)
    .map(([id, name]) => ({ id: Number(id), name, rank: priorityRank(name) }))
    .sort((a, b) => b.rank - a.rank || a.name.localeCompare(b.name));

  // Count tickets per priorityId
  const priorityCountsById = enriched.reduce((acc, w) => {
    if (w.priorityId != null) {
      acc[w.priorityId] = (acc[w.priorityId] || 0) + 1;
    }
    return acc;
  }, {});

  const filtered = enriched
    .filter((w) => {
      if (categoryFilter !== 'all' && normalizeCategory(w.category) !== categoryFilter) return false;
      const s = statusMetaFromWo(w, statusLookup);
      if (statusFilter === 'open' && !s.isOpen) return false;
      if (statusFilter === 'completed' && s.isOpen) return false;
      if (priorityFilter !== 'all' && String(w.priorityId) !== String(priorityFilter)) return false;
      if (searchTerm) {
        const q = searchTerm.toLowerCase();
        return (
          (w.summary || '').toLowerCase().includes(q) ||
          (w.description || '').toLowerCase().includes(q) ||
          (w.propertyName || '').toLowerCase().includes(q) ||
          (w.unitName || '').toLowerCase().includes(q) ||
          (w.category || '').toLowerCase().includes(q)
        );
      }
      return true;
    })
    // Sort open items by priority desc, then date desc
    .sort((a, b) => {
      const ap = priorityRank(a.priority);
      const bp = priorityRank(b.priority);
      if (ap !== bp) return bp - ap;
      const ad = new Date(a.createdDate || 0).getTime();
      const bd = new Date(b.createdDate || 0).getTime();
      return bd - ad;
    });

  // Only show category chips that actually have items
  const visibleCategories = Object.keys(CATEGORY_META).filter((k) => categoryCounts[k] > 0);

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
          <><CheckCircle2 size={14} /> Live data — {enriched.length} tickets ({openCount} open, {urgentOpenCount} urgent/high)</>
        ) : (
          <><WifiOff size={14} /> Demo data</>
        )}
      </div>

      {/* Compact filter row — three native selects */}
      <div className="filter-select-row">
        <label className="filter-select">
          <span className="filter-select-label">Status</span>
          <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}>
            <option value="open">Open ({openCount})</option>
            <option value="completed">Completed ({completedCount})</option>
            <option value="all">All</option>
          </select>
        </label>

        <label className="filter-select">
          <span className="filter-select-label">Type</span>
          <select value={categoryFilter} onChange={(e) => setCategoryFilter(e.target.value)}>
            <option value="all">All types</option>
            {visibleCategories.map((key) => (
              <option key={key} value={key}>
                {CATEGORY_META[key].label} ({categoryCounts[key]})
              </option>
            ))}
          </select>
        </label>

        <label className="filter-select">
          <span className="filter-select-label">Priority</span>
          <select value={priorityFilter} onChange={(e) => setPriorityFilter(e.target.value)}>
            <option value="all">Any</option>
            {priorityOptions.map((p) => (
              <option key={p.id} value={String(p.id)}>
                {p.name} ({priorityCountsById[p.id] || 0})
              </option>
            ))}
          </select>
        </label>
      </div>

      <div className="dashboard-search">
        <Search size={18} />
        <input
          type="text"
          placeholder="Search by description, property, unit, or type..."
          value={searchTerm}
          onChange={(e) => setSearchTerm(e.target.value)}
        />
      </div>

      <div className="tenants-list">
        {filtered.map((w) => {
          const catKey = normalizeCategory(w.category);
          const cat = CATEGORY_META[catKey];
          const CatIcon = cat.icon;
          const pri = priorityMeta(w.priority);
          const PriIcon = pri.icon;
          const status = statusMetaFromWo(w, statusLookup);

          return (
            <button
              key={w.id}
              className="tenant-row"
              onClick={() => setSelectedId(w.id)}
            >
              <div
                className="tenant-avatar"
                style={{ background: cat.color + '15', color: cat.color }}
              >
                <CatIcon size={22} />
              </div>
              <div className="tenant-info">
                <span className="tenant-name">{w.summary || `Work Order ${w.id}`}</span>
                <div className="tenant-contact">
                  {w.propertyName && (
                    <span className="tenant-contact-item">
                      <Building2 size={12} /> {w.propertyName}
                    </span>
                  )}
                  {w.unitName && (
                    <span className="tenant-contact-item">
                      <Home size={12} /> {w.unitName}
                    </span>
                  )}
                  {w.category && (
                    <span className="tenant-contact-item">
                      {w.category}
                    </span>
                  )}
                </div>
              </div>
              <div className="wo-badges">
                <span className={`unit-status ${pri.className}`}>
                  <PriIcon size={12} />
                  {pri.label}
                </span>
                <span className={`unit-status ${status.className}`}>
                  {status.label}
                </span>
              </div>
            </button>
          );
        })}
      </div>

      {filtered.length === 0 && (
        <div className="empty-state">
          <Search size={32} />
          <p>No tickets match your filters</p>
        </div>
      )}
    </div>
  );
}
