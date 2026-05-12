// Toggle bell button used on entity rows (tenants, properties,
// work orders). Reads/writes through FollowsContext so a single
// fetched follows list backs every button on a list page.
//
// Visual states:
//   not following → outlined bell, neutral colour
//   following     → filled bell, accent blue
//
// Click stops event propagation so a button on a clickable row
// doesn't also navigate to the row's detail when toggling.

import { Bell } from 'lucide-react';
import { useFollows } from '../contexts/FollowsContext.jsx';

export default function FollowButton({
  entityType,
  entityId,
  entityLabel,
  size = 16,
  ariaLabel,
}) {
  const { isFollowing, follow, unfollow } = useFollows();
  if (!entityType || !entityId) return null;

  const following = isFollowing(entityType, entityId);

  const handleClick = (e) => {
    e.stopPropagation();
    e.preventDefault();
    if (following) {
      unfollow(entityType, entityId);
    } else {
      follow(entityType, entityId, entityLabel || null);
    }
  };

  return (
    <button
      type="button"
      onClick={handleClick}
      title={
        following
          ? `Following — click to stop`
          : `Follow to get notifications when this changes`
      }
      aria-label={ariaLabel || (following ? 'Unfollow' : 'Follow')}
      style={{
        background: 'transparent',
        border: 'none',
        cursor: 'pointer',
        padding: 4,
        color: following ? '#1565C0' : '#9CA3AF',
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        borderRadius: 4,
        transition: 'color 0.15s, background 0.15s',
      }}
      onMouseEnter={(e) => {
        if (!following) e.currentTarget.style.color = '#1565C0';
      }}
      onMouseLeave={(e) => {
        if (!following) e.currentTarget.style.color = '#9CA3AF';
      }}
    >
      <Bell size={size} fill={following ? 'currentColor' : 'none'} />
    </button>
  );
}
