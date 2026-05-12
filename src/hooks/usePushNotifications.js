// React hook that owns the browser-side push subscription
// lifecycle: feature detection, permission state, server-driven
// VAPID config, subscribe / unsubscribe.
//
// Used by NotificationsBell to decide whether to render the
// "Enable browser notifications" button. Also responsible for
// registering /sw.js with the browser the first time the user
// opts in — until then we don't install the worker (saves an
// extra fetch on first paint for users who'll never use push).

import { useCallback, useEffect, useState } from 'react';

function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(base64);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

const FEATURE_DETECT =
  typeof window !== 'undefined' &&
  'serviceWorker' in navigator &&
  'PushManager' in window &&
  typeof Notification !== 'undefined';

export function usePushNotifications() {
  const [vapidPublicKey, setVapidPublicKey] = useState(null);
  const [serverSupported, setServerSupported] = useState(false);
  const [permission, setPermission] = useState(
    FEATURE_DETECT ? Notification.permission : 'denied',
  );
  // null = unknown, true/false once the SW has reported in.
  const [subscribed, setSubscribed] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  // 1) Ask the server whether VAPID is configured + grab the public key.
  useEffect(() => {
    if (!FEATURE_DETECT) return;
    let cancelled = false;
    fetch('/api/push-subscriptions')
      .then((r) => r.json())
      .then((data) => {
        if (cancelled || !data?.ok) return;
        setServerSupported(!!data.supported);
        setVapidPublicKey(data.vapidPublicKey || null);
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, []);

  // 2) Find out whether THIS browser already has a live subscription.
  // We don't register the worker ourselves yet — only check what's
  // already there. Registration happens lazily on enable().
  useEffect(() => {
    if (!FEATURE_DETECT) {
      setSubscribed(false);
      return;
    }
    let cancelled = false;
    navigator.serviceWorker
      .getRegistration('/sw.js')
      .then((reg) => (reg ? reg.pushManager.getSubscription() : null))
      .then((sub) => {
        if (!cancelled) setSubscribed(!!sub);
      })
      .catch(() => {
        if (!cancelled) setSubscribed(false);
      });
    return () => { cancelled = true; };
  }, []);

  const enable = useCallback(async () => {
    setError(null);
    if (!FEATURE_DETECT) {
      setError('Push notifications are not supported in this browser.');
      return;
    }
    if (!vapidPublicKey) {
      setError(
        'Server-side VAPID isn\'t configured yet. Generate keys via /api/admin/generate-vapid-keys and set them in Vercel.',
      );
      return;
    }
    setLoading(true);
    try {
      // 1. Browser permission prompt.
      const result = await Notification.requestPermission();
      setPermission(result);
      if (result !== 'granted') {
        throw new Error(
          result === 'denied'
            ? 'Permission denied. Re-enable notifications for this site in your browser settings.'
            : 'Permission was not granted.',
        );
      }

      // 2. Register the service worker (idempotent — repeated calls
      // resolve to the same registration).
      const reg = await navigator.serviceWorker.register('/sw.js');
      // Wait until it's actually active before subscribing — calling
      // subscribe() against a still-installing worker is racy.
      if (reg.installing) {
        await new Promise((resolve) => {
          reg.installing.addEventListener('statechange', function listener(e) {
            if (e.target.state === 'activated') {
              e.target.removeEventListener('statechange', listener);
              resolve();
            }
          });
        });
      }
      // Or wait for serviceWorker.ready as a backstop.
      await navigator.serviceWorker.ready;

      // 3. Subscribe via PushManager.
      let sub = await reg.pushManager.getSubscription();
      if (!sub) {
        sub = await reg.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: urlBase64ToUint8Array(vapidPublicKey),
        });
      }

      // 4. Tell the server.
      const json = sub.toJSON();
      const res = await fetch('/api/push-subscriptions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          endpoint: json.endpoint,
          keys: json.keys,
          userAgent: navigator.userAgent,
        }),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j.error || `HTTP ${res.status}`);
      }
      setSubscribed(true);
    } catch (err) {
      setError(err.message || String(err));
    } finally {
      setLoading(false);
    }
  }, [vapidPublicKey]);

  const disable = useCallback(async () => {
    setError(null);
    if (!FEATURE_DETECT) return;
    setLoading(true);
    try {
      const reg = await navigator.serviceWorker.getRegistration('/sw.js');
      const sub = reg ? await reg.pushManager.getSubscription() : null;
      if (sub) {
        await fetch('/api/push-subscriptions', {
          method: 'DELETE',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ endpoint: sub.endpoint }),
        }).catch(() => {});
        await sub.unsubscribe();
      }
      setSubscribed(false);
    } catch (err) {
      setError(err.message || String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  return {
    supported: FEATURE_DETECT,
    available: FEATURE_DETECT && serverSupported && !!vapidPublicKey,
    permission,
    subscribed,
    loading,
    error,
    enable,
    disable,
  };
}
