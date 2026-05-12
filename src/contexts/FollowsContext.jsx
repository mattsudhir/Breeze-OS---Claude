// App-wide follow state.
//
// Owning this in one context means N follow-buttons across a 100-row
// list page can derive their state from a single fetched list,
// instead of each making its own /api/follows roundtrip on mount.
// Optimistic updates flip the icon instantly on click — the server
// roundtrip happens in the background and rolls back on failure.

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
} from 'react';

const FollowsContext = createContext(null);

// Refetch on this cadence so a follow toggled in another tab /
// browser is reflected within ~minute. Cheap query — single small
// SELECT per tab.
const REFRESH_MS = 60_000;

export function FollowsProvider({ children }) {
  const [follows, setFollows] = useState([]);
  const [loading, setLoading] = useState(true);

  const fetchFollows = useCallback(async () => {
    try {
      const res = await fetch('/api/follows');
      const data = await res.json();
      if (data?.ok) setFollows(data.follows || []);
    } catch (err) {
      console.warn('[follows] fetch failed:', err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchFollows();
    const t = setInterval(fetchFollows, REFRESH_MS);
    return () => clearInterval(t);
  }, [fetchFollows]);

  const isFollowing = useCallback(
    (entityType, entityId) =>
      follows.some(
        (f) => f.entityType === entityType && f.entityId === entityId,
      ),
    [follows],
  );

  const follow = useCallback(
    async (entityType, entityId, entityLabel = null) => {
      // Optimistic add — flag with __optimistic so we can roll it back
      // on failure without clobbering an unrelated refetch.
      const stub = {
        id: `__opt_${entityType}_${entityId}`,
        entityType,
        entityId,
        entityLabel,
        __optimistic: true,
      };
      setFollows((prev) => [stub, ...prev]);
      try {
        const res = await fetch('/api/follows', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            entity_type: entityType,
            entity_id: entityId,
            entity_label: entityLabel,
          }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok || !data?.ok) {
          throw new Error(data?.error || `HTTP ${res.status}`);
        }
        // Replace optimistic stub with the canonical row from the server
        await fetchFollows();
      } catch (err) {
        console.warn('[follows] follow failed:', err);
        setFollows((prev) => prev.filter((f) => f.id !== stub.id));
      }
    },
    [fetchFollows],
  );

  const unfollow = useCallback(
    async (entityType, entityId) => {
      const previous = follows;
      // Optimistic remove
      setFollows((prev) =>
        prev.filter(
          (f) => !(f.entityType === entityType && f.entityId === entityId),
        ),
      );
      try {
        const res = await fetch('/api/follows', {
          method: 'DELETE',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            entity_type: entityType,
            entity_id: entityId,
          }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok || !data?.ok) {
          throw new Error(data?.error || `HTTP ${res.status}`);
        }
        await fetchFollows();
      } catch (err) {
        console.warn('[follows] unfollow failed:', err);
        setFollows(previous);
      }
    },
    [follows, fetchFollows],
  );

  return (
    <FollowsContext.Provider
      value={{ follows, loading, isFollowing, follow, unfollow, refetch: fetchFollows }}
    >
      {children}
    </FollowsContext.Provider>
  );
}

export function useFollows() {
  const ctx = useContext(FollowsContext);
  if (!ctx) {
    throw new Error('useFollows must be used within <FollowsProvider>');
  }
  return ctx;
}
