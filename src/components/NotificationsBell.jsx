// Bell + unread badge + dropdown.
//
// Owns its own polling state (every 30s) — the count refreshes
// even when the dropdown is closed so the badge stays current.
// On a click into a notification, marks it read locally and on
// the server, then asks the host App to navigate to the right
// view for the entity_type. Selecting the specific record
// inside that view is a Phase 2 follow-up — for v1 the user
// lands on the list and finds the row.

import { useState, useRef, useEffect, useCallback } from 'react';
import { Bell, Loader2 } from 'lucide-react';

const POLL_MS = 30_000;

// Map our follows entity_type to the App's view id. Anything not
// in this map skips navigation and just marks-read on click.
const ENTITY_TYPE_TO_VIEW = {
  tenant: 'tenants',
  property: 'properties',
  unit: 'properties',
  work_order: 'maintenance',
  charge: 'tenants',
  lease: 'tenants',
  lead: 'leasing',
};

function relativeTime(iso) {
  if (!iso) return '';
  const t = new Date(iso).getTime();
  const ago = Date.now() - t;
  if (ago < 60_000) return 'just now';
  if (ago < 3_600_000) return `${Math.floor(ago / 60_000)}m ago`;
  if (ago < 86_400_000) return `${Math.floor(ago / 3_600_000)}h ago`;
  return `${Math.floor(ago / 86_400_000)}d ago`;
}

export default function NotificationsBell({ onNavigate }) {
  const [open, setOpen] = useState(false);
  const [notifications, setNotifications] = useState([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const [loadingFirst, setLoadingFirst] = useState(true);
  const [marking, setMarking] = useState(false);
  const wrapperRef = useRef(null);

  const fetchNotifications = useCallback(async () => {
    try {
      const res = await fetch('/api/notifications?limit=30');
      const data = await res.json();
      if (data?.ok) {
        setNotifications(data.notifications || []);
        setUnreadCount(data.unread_count || 0);
      }
    } catch (err) {
      // Silent — bell badge just stays where it was; we'll retry next tick.
      console.warn('[notifications] fetch failed:', err);
    } finally {
      setLoadingFirst(false);
    }
  }, []);

  useEffect(() => {
    fetchNotifications();
    const t = setInterval(fetchNotifications, POLL_MS);
    return () => clearInterval(t);
  }, [fetchNotifications]);

  // Click outside to close.
  useEffect(() => {
    if (!open) return undefined;
    const onDocClick = (e) => {
      if (!wrapperRef.current?.contains(e.target)) setOpen(false);
    };
    window.addEventListener('mousedown', onDocClick);
    return () => window.removeEventListener('mousedown', onDocClick);
  }, [open]);

  const markOneRead = useCallback(async (id) => {
    try {
      await fetch('/api/notifications', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'mark_read', ids: [id] }),
      });
    } catch (err) {
      console.warn('[notifications] mark_read failed:', err);
    }
  }, []);

  const handleClickItem = (n) => {
    // Optimistic local mark + server side
    if (!n.readAt) {
      const nowIso = new Date().toISOString();
      setNotifications((prev) =>
        prev.map((x) => (x.id === n.id ? { ...x, readAt: nowIso } : x)),
      );
      setUnreadCount((c) => Math.max(0, c - 1));
      markOneRead(n.id);
    }
    if (onNavigate && n.entityType) {
      const view = ENTITY_TYPE_TO_VIEW[n.entityType];
      if (view) {
        onNavigate(view);
        setOpen(false);
      }
    }
  };

  const markAllRead = async () => {
    if (marking) return;
    setMarking(true);
    const nowIso = new Date().toISOString();
    setNotifications((prev) =>
      prev.map((n) => (n.readAt ? n : { ...n, readAt: nowIso })),
    );
    setUnreadCount(0);
    try {
      await fetch('/api/notifications', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'mark_all_read' }),
      });
    } catch (err) {
      console.warn('[notifications] mark_all_read failed:', err);
      // Best-effort — refetch to canonicalize
      fetchNotifications();
    } finally {
      setMarking(false);
    }
  };

  return (
    <div ref={wrapperRef} style={{ position: 'relative' }}>
      <button
        className="topbar-icon-btn"
        onClick={() => setOpen((v) => !v)}
        title="Notifications"
        style={{ position: 'relative' }}
      >
        <Bell size={20} />
        {unreadCount > 0 && (
          <span
            style={{
              position: 'absolute',
              top: 2,
              right: 2,
              background: '#E53935',
              color: 'white',
              borderRadius: 10,
              minWidth: 18,
              height: 18,
              fontSize: 10,
              fontWeight: 700,
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              padding: '0 5px',
              lineHeight: 1,
            }}
          >
            {unreadCount > 99 ? '99+' : unreadCount}
          </span>
        )}
      </button>

      {open && (
        <div
          style={{
            position: 'absolute',
            top: 'calc(100% + 4px)',
            right: 0,
            width: 380,
            maxHeight: 480,
            background: '#FFF',
            border: '1px solid #D0D7DE',
            borderRadius: 8,
            boxShadow: '0 6px 20px rgba(0,0,0,0.12)',
            zIndex: 200,
            display: 'flex',
            flexDirection: 'column',
          }}
        >
          <div
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              padding: '10px 14px',
              borderBottom: '1px solid #EEF0F2',
              background: '#FFF',
              borderTopLeftRadius: 8,
              borderTopRightRadius: 8,
            }}
          >
            <span style={{ fontWeight: 700, fontSize: 13, color: '#1A1A1A' }}>
              Notifications
              {unreadCount > 0 && (
                <span style={{ color: '#1565C0', marginLeft: 6, fontWeight: 500 }}>
                  · {unreadCount} unread
                </span>
              )}
            </span>
            {unreadCount > 0 && (
              <button
                type="button"
                onClick={markAllRead}
                disabled={marking}
                style={{
                  background: 'none',
                  border: 'none',
                  color: '#1565C0',
                  cursor: marking ? 'default' : 'pointer',
                  fontSize: 12,
                  fontWeight: 500,
                  padding: 0,
                }}
              >
                Mark all read
              </button>
            )}
          </div>

          <div style={{ overflowY: 'auto', flex: 1 }}>
            {loadingFirst ? (
              <div
                style={{
                  padding: '20px 14px',
                  textAlign: 'center',
                  color: '#6A737D',
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 6,
                  width: '100%',
                  justifyContent: 'center',
                }}
              >
                <Loader2 size={14} className="spin" /> Loading…
              </div>
            ) : notifications.length === 0 ? (
              <div
                style={{
                  padding: '24px 14px',
                  textAlign: 'center',
                  color: '#6A737D',
                  fontSize: 13,
                  lineHeight: 1.45,
                }}
              >
                <div style={{ fontWeight: 600, color: '#1A1A1A', marginBottom: 4 }}>
                  No notifications yet
                </div>
                Follow a tenant, property, or work order to start getting alerts when
                they change in AppFolio.
              </div>
            ) : (
              notifications.map((n) => (
                <button
                  key={n.id}
                  type="button"
                  onClick={() => handleClickItem(n)}
                  style={{
                    display: 'block',
                    width: '100%',
                    textAlign: 'left',
                    padding: '10px 14px',
                    border: 'none',
                    borderBottom: '1px solid #EEF0F2',
                    cursor: 'pointer',
                    background: n.readAt ? '#FFF' : '#F0F7FF',
                  }}
                >
                  <div
                    style={{
                      fontWeight: n.readAt ? 500 : 700,
                      fontSize: 13,
                      color: '#1A1A1A',
                    }}
                  >
                    {n.title}
                  </div>
                  {n.body && (
                    <div style={{ fontSize: 12, color: '#6A737D', marginTop: 2 }}>
                      {n.body}
                    </div>
                  )}
                  <div
                    style={{
                      fontSize: 11,
                      color: '#9CA3AF',
                      marginTop: 4,
                      display: 'flex',
                      gap: 6,
                    }}
                  >
                    {n.entityLabel && <span>{n.entityLabel}</span>}
                    {n.entityLabel && <span>·</span>}
                    <span>{relativeTime(n.createdAt)}</span>
                  </div>
                </button>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
}
