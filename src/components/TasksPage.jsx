import { useEffect, useState, useCallback } from 'react';
import {
  CheckSquare, Clock, CheckCircle2, ExternalLink,
  Loader2, Inbox, X, Plus,
} from 'lucide-react';

const STATUS_TABS = [
  { id: 'active', label: 'Active' },
  { id: 'open', label: 'Open' },
  { id: 'in_progress', label: 'In progress' },
  { id: 'done', label: 'Done' },
  { id: 'dismissed', label: 'Dismissed' },
];

function relTime(iso, { suffix = '' } = {}) {
  if (!iso) return '—';
  const t = new Date(iso).getTime();
  const ago = Date.now() - t;
  if (ago < 0) {
    const ahead = -ago;
    if (ahead < 3600_000) return `in ${Math.max(1, Math.floor(ahead / 60_000))}m${suffix}`;
    if (ahead < 86_400_000) return `in ${Math.floor(ahead / 3_600_000)}h${suffix}`;
    return `in ${Math.floor(ahead / 86_400_000)}d${suffix}`;
  }
  if (ago < 60_000) return `just now${suffix}`;
  if (ago < 3_600_000) return `${Math.floor(ago / 60_000)}m ago${suffix}`;
  if (ago < 86_400_000) return `${Math.floor(ago / 3_600_000)}h ago${suffix}`;
  return `${Math.floor(ago / 86_400_000)}d ago${suffix}`;
}

function slaStatusOf(task) {
  if (!task?.dueAt) return 'no_due';
  const due = new Date(task.dueAt).getTime();
  const now = Date.now();
  if (due < now) return 'overdue';
  if (due - now < 12 * 3600_000) return 'due_soon';
  return 'on_track';
}

function SlaPill({ task }) {
  const status = slaStatusOf(task);
  if (status === 'no_due') return null;
  const styles = {
    overdue:  { bg: '#FFEBEE', fg: '#C62828', label: `Overdue · ${relTime(task.dueAt)}` },
    due_soon: { bg: '#FFF3E0', fg: '#E65100', label: `Due ${relTime(task.dueAt)}` },
    on_track: { bg: '#E8F5E9', fg: '#2E7D32', label: `Due ${relTime(task.dueAt)}` },
  };
  const s = styles[status];
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: 4,
      padding: '2px 8px', borderRadius: 4, background: s.bg, color: s.fg,
      fontSize: 11, fontWeight: 600, whiteSpace: 'nowrap',
    }}>
      <Clock size={11} /> {s.label}
    </span>
  );
}

function PriorityPill({ priority }) {
  if (!priority || priority === 'normal') return null;
  const styles = {
    low:    { bg: '#F2F6FA', fg: '#6A737D' },
    high:   { bg: '#FFF3E0', fg: '#E65100' },
    urgent: { bg: '#FFEBEE', fg: '#C62828' },
  };
  const s = styles[priority] || styles.low;
  return (
    <span style={{
      padding: '2px 8px', borderRadius: 4, background: s.bg, color: s.fg,
      fontSize: 11, fontWeight: 600, textTransform: 'uppercase',
    }}>
      {priority}
    </span>
  );
}

export default function TasksPage() {
  const [tasks, setTasks] = useState([]);
  const [taskTypes, setTaskTypes] = useState({});
  const [counts, setCounts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [statusFilter, setStatusFilter] = useState('active');
  const [actingId, setActingId] = useState(null);
  const [showAdd, setShowAdd] = useState(false);

  const fetchTasks = useCallback(async (status) => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/human-tasks?status=${status}&limit=200`);
      const data = await res.json();
      if (!res.ok || !data?.ok) {
        throw new Error(data?.error || `HTTP ${res.status}`);
      }
      setTasks(data.tasks || []);
      setTaskTypes(data.taskTypes || {});
      setCounts(data.counts || []);
    } catch (err) {
      setError(err.message || 'Network error');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchTasks(statusFilter);
  }, [statusFilter, fetchTasks]);

  const updateStatus = async (taskId, newStatus) => {
    setActingId(taskId);
    try {
      const res = await fetch('/api/human-tasks', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: taskId, status: newStatus }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data?.ok) {
        throw new Error(data?.error || `HTTP ${res.status}`);
      }
      // Optimistic: drop from current view if leaving active set.
      setTasks((prev) => prev.filter((t) => t.id !== taskId));
    } catch (err) {
      setError(err.message || 'Update failed');
    } finally {
      setActingId(null);
    }
  };

  const totalActive = counts.reduce((sum, c) => sum + c.total, 0);
  const totalOverdue = counts.reduce((sum, c) => sum + (c.overdue || 0), 0);

  return (
    <div className="properties-page" style={{ padding: 16 }}>
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        marginBottom: 16, gap: 12, flexWrap: 'wrap',
      }}>
        <div>
          <h2 style={{ margin: 0, display: 'flex', alignItems: 'center', gap: 8 }}>
            <CheckSquare size={22} /> Tasks
          </h2>
          <p style={{ margin: '4px 0 0', color: '#6A737D', fontSize: 13 }}>
            Items waiting on a human action — payment allocations, charge reviews, vendor follow-ups.
          </p>
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
          <span style={{
            padding: '6px 10px', borderRadius: 6, background: '#F0F7FF',
            color: '#1565C0', fontSize: 12, fontWeight: 600,
          }}>
            {totalActive} active
          </span>
          {totalOverdue > 0 && (
            <span style={{
              padding: '6px 10px', borderRadius: 6, background: '#FFEBEE',
              color: '#C62828', fontSize: 12, fontWeight: 600,
            }}>
              {totalOverdue} overdue
            </span>
          )}
          <button
            type="button"
            onClick={() => setShowAdd(true)}
            style={{
              display: 'inline-flex', alignItems: 'center', gap: 6,
              padding: '6px 12px', border: 'none', background: '#1565C0',
              color: '#FFF', borderRadius: 6, fontSize: 12, fontWeight: 600,
              cursor: 'pointer',
            }}
          >
            <Plus size={14} /> Add Task
          </button>
        </div>
      </div>

      {showAdd && (
        <AddTaskModal
          taskTypes={taskTypes}
          onClose={() => setShowAdd(false)}
          onCreated={() => {
            setShowAdd(false);
            fetchTasks(statusFilter);
          }}
        />
      )}

      <div style={{
        display: 'flex', gap: 4, borderBottom: '1px solid #DCE6F1',
        marginBottom: 16, overflowX: 'auto',
      }}>
        {STATUS_TABS.map((tab) => (
          <button
            key={tab.id}
            onClick={() => setStatusFilter(tab.id)}
            style={{
              padding: '8px 14px',
              border: 'none',
              background: 'transparent',
              borderBottom: statusFilter === tab.id ? '2px solid #1565C0' : '2px solid transparent',
              color: statusFilter === tab.id ? '#1565C0' : '#6A737D',
              fontWeight: statusFilter === tab.id ? 600 : 500,
              fontSize: 13,
              cursor: 'pointer',
              whiteSpace: 'nowrap',
            }}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {error && (
        <div style={{
          padding: '8px 12px', background: '#FFF3F3', border: '1px solid #F5C6CB',
          borderRadius: 6, color: '#C62828', fontSize: 12, marginBottom: 12,
        }}>
          {error}
        </div>
      )}

      {loading ? (
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          padding: '48px 0', color: '#6A737D', gap: 8,
        }}>
          <Loader2 size={18} className="spin" /> Loading tasks…
        </div>
      ) : tasks.length === 0 ? (
        <div style={{
          padding: '48px 24px', textAlign: 'center', color: '#6A737D',
          background: '#FAFBFC', border: '1px dashed #DCE6F1', borderRadius: 8,
        }}>
          <Inbox size={32} style={{ opacity: 0.5 }} />
          <div style={{ marginTop: 12, fontWeight: 600, color: '#1A1A1A' }}>
            {statusFilter === 'active'
              ? 'Inbox zero.'
              : `No ${statusFilter.replace('_', ' ')} tasks.`}
          </div>
          <div style={{ fontSize: 12, marginTop: 4 }}>
            New items will appear here when there's something a person needs to do.
          </div>
        </div>
      ) : (
        tasks.map((task) => {
          const cfg = taskTypes[task.taskType] || {};
          const isActing = actingId === task.id;
          const isTerminal = task.status === 'done' || task.status === 'dismissed';
          const appfolioUrl = task.payload?.appfolio_url;
          return (
            <div
              key={task.id}
              style={{
                background: '#FFF',
                border: '1px solid #DCE6F1',
                borderRadius: 8,
                padding: 14,
                marginBottom: 10,
                opacity: isActing ? 0.6 : 1,
              }}
            >
              <div style={{
                display: 'flex', justifyContent: 'space-between', gap: 12,
                alignItems: 'flex-start', flexWrap: 'wrap',
              }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
                    <span style={{
                      fontSize: 11, padding: '2px 8px', borderRadius: 4,
                      background: '#F0F7FF', color: '#1565C0', fontWeight: 600,
                      textTransform: 'uppercase', letterSpacing: 0.5,
                    }}>
                      {cfg.label || task.taskType}
                    </span>
                    <PriorityPill priority={task.priority} />
                    {!isTerminal && <SlaPill task={task} />}
                    {isTerminal && (
                      <span style={{ fontSize: 11, color: '#6A737D' }}>
                        {task.status === 'done' ? 'Completed' : 'Dismissed'} {relTime(task.completedAt)}
                      </span>
                    )}
                  </div>
                  <div style={{ fontWeight: 600, fontSize: 14, color: '#1A1A1A', marginTop: 6 }}>
                    {task.title}
                  </div>
                  {task.description && (
                    <div style={{ fontSize: 12, color: '#6A737D', marginTop: 4, lineHeight: 1.4 }}>
                      {task.description}
                    </div>
                  )}
                  <div style={{ fontSize: 11, color: '#9CA3AF', marginTop: 6 }}>
                    Created {relTime(task.createdAt)}
                  </div>
                </div>
                {!isTerminal && (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 6, minWidth: 140 }}>
                    {appfolioUrl && (
                      <a
                        href={appfolioUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        style={{
                          display: 'inline-flex', alignItems: 'center', gap: 6,
                          padding: '6px 10px', background: '#1565C0', color: 'white',
                          borderRadius: 4, fontSize: 12, fontWeight: 600,
                          textDecoration: 'none', justifyContent: 'center',
                        }}
                      >
                        <ExternalLink size={12} />
                        {cfg.actionLabel || 'Open in AppFolio'}
                      </a>
                    )}
                    <button
                      onClick={() => updateStatus(task.id, 'done')}
                      disabled={isActing}
                      style={{
                        display: 'inline-flex', alignItems: 'center', gap: 6,
                        padding: '6px 10px', background: '#E8F5E9', color: '#2E7D32',
                        border: 'none', borderRadius: 4, fontSize: 12, fontWeight: 600,
                        cursor: isActing ? 'default' : 'pointer', justifyContent: 'center',
                      }}
                    >
                      <CheckCircle2 size={12} /> Mark complete
                    </button>
                    <button
                      onClick={() => updateStatus(task.id, 'dismissed')}
                      disabled={isActing}
                      style={{
                        display: 'inline-flex', alignItems: 'center', gap: 6,
                        padding: '6px 10px', background: 'transparent', color: '#6A737D',
                        border: '1px solid #DCE6F1', borderRadius: 4,
                        fontSize: 11, cursor: isActing ? 'default' : 'pointer',
                        justifyContent: 'center',
                      }}
                    >
                      <X size={11} /> Dismiss
                    </button>
                  </div>
                )}
              </div>
            </div>
          );
        })
      )}
    </div>
  );
}

// Manual task creation. Mirrors the catalog from the API so the
// dropdown stays in sync with TASK_TYPES (lib/humanTasks.js) without
// duplicating it here. Voice-driven creation is the longer-term play
// (the chat agent already has a tool surface) — this button is the
// keyboard fallback.
function AddTaskModal({ taskTypes, onClose, onCreated }) {
  const typeIds = Object.keys(taskTypes || {});
  const [taskType, setTaskType] = useState(typeIds[0] || '');
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [priority, setPriority] = useState('normal');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState(null);

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (submitting) return;
    if (!taskType) return setError('Pick a task type');
    if (!title.trim()) return setError('Title required');
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch('/api/human-tasks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          task_type: taskType,
          title: title.trim(),
          description: description.trim() || null,
          priority,
          source: 'manual',
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data?.ok) {
        throw new Error(data?.error || `HTTP ${res.status}`);
      }
      onCreated?.();
    } catch (err) {
      setError(err.message || 'Save failed');
      setSubmitting(false);
    }
  };

  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)',
        zIndex: 300, display: 'flex', alignItems: 'flex-start',
        justifyContent: 'center', padding: '40px 12px',
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: 'min(440px, 100%)', background: '#FFF', borderRadius: 8,
          padding: 20, boxShadow: '0 12px 28px rgba(0,0,0,0.18)',
        }}
      >
        <div style={{
          display: 'flex', justifyContent: 'space-between', alignItems: 'center',
          marginBottom: 12,
        }}>
          <h3 style={{ margin: 0 }}>Add Task</h3>
          <button
            type="button" onClick={onClose}
            style={{
              background: 'transparent', border: 'none', cursor: 'pointer',
              padding: 4, color: '#6A737D',
            }}
          >
            <X size={18} />
          </button>
        </div>
        <form onSubmit={handleSubmit}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              <span style={{ fontSize: 12, fontWeight: 600 }}>Type</span>
              <select
                value={taskType} onChange={(e) => setTaskType(e.target.value)} required
                style={{ padding: 8, border: '1px solid #D0D7DE', borderRadius: 4 }}
              >
                {typeIds.length === 0 && <option value="">— No task types loaded —</option>}
                {typeIds.map((t) => (
                  <option key={t} value={t}>
                    {taskTypes[t]?.label || t}
                    {taskTypes[t]?.slaHours ? ` (${Math.round(taskTypes[t].slaHours / 24)}d SLA)` : ''}
                  </option>
                ))}
              </select>
            </label>
            <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              <span style={{ fontSize: 12, fontWeight: 600 }}>Title</span>
              <input
                type="text" value={title} onChange={(e) => setTitle(e.target.value)}
                placeholder="Call vendor about backflow inspection" required
                style={{ padding: 8, border: '1px solid #D0D7DE', borderRadius: 4 }}
              />
            </label>
            <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              <span style={{ fontSize: 12, fontWeight: 600 }}>Notes (optional)</span>
              <textarea
                value={description} onChange={(e) => setDescription(e.target.value)}
                rows={3}
                style={{ padding: 8, border: '1px solid #D0D7DE', borderRadius: 4, resize: 'vertical' }}
              />
            </label>
            <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              <span style={{ fontSize: 12, fontWeight: 600 }}>Priority</span>
              <select
                value={priority} onChange={(e) => setPriority(e.target.value)}
                style={{ padding: 8, border: '1px solid #D0D7DE', borderRadius: 4 }}
              >
                <option value="low">Low</option>
                <option value="normal">Normal</option>
                <option value="high">High</option>
                <option value="urgent">Urgent</option>
              </select>
            </label>
            {error && (
              <div style={{
                padding: '8px 12px', background: '#FFF3F3', border: '1px solid #F5C6CB',
                borderRadius: 6, color: '#C62828', fontSize: 12,
              }}>
                {error}
              </div>
            )}
            <div style={{ display: 'flex', gap: 8, marginTop: 4 }}>
              <button
                type="button" onClick={onClose} disabled={submitting}
                style={{
                  flex: 1, padding: '10px 14px', border: '1px solid #D0D7DE',
                  background: '#FFF', borderRadius: 6, cursor: 'pointer',
                  fontWeight: 500,
                }}
              >
                Cancel
              </button>
              <button
                type="submit" disabled={submitting}
                style={{
                  flex: 1, padding: '10px 14px', border: 'none',
                  background: '#1565C0', color: 'white', borderRadius: 6,
                  cursor: submitting ? 'default' : 'pointer', fontWeight: 600,
                }}
              >
                {submitting ? 'Creating…' : 'Create task'}
              </button>
            </div>
          </div>
        </form>
      </div>
    </div>
  );
}
