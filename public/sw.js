// Breeze OS service worker — handles incoming web pushes and the
// native notification click that follows.
//
// Lives at /sw.js (registered by usePushNotifications) so its
// scope covers the whole app. Vite serves /public/* from the root
// in both dev and prod.
//
// Activated on first install via skipWaiting + clients.claim so
// new versions take over immediately without a forced reload.

self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

// Push event: parse the JSON payload sent by lib/webpush.js and
// show a native notification. Defensive on payload shape — a
// missing field shouldn't throw.
self.addEventListener('push', (event) => {
  let data = {};
  try {
    if (event.data) data = event.data.json();
  } catch (e) {
    // Plain-text or malformed payload — fall back to a generic.
    try {
      const txt = event.data?.text();
      if (txt) data = { title: 'Breeze OS', body: txt };
    } catch {
      /* ignore */
    }
  }

  const title = data.title || 'Breeze OS';
  const body = data.body || '';
  const url = data.url || '/';
  const tag = data.tag || 'breeze-default';

  event.waitUntil(
    self.registration.showNotification(title, {
      body,
      icon: '/breeze-logo.png',
      badge: '/favicon.png',
      tag,
      data: { url },
      // renotify=true so a follow-up update on the same tag bumps
      // the device's notification chime rather than silently
      // replacing.
      renotify: true,
    }),
  );
});

// Click on the notification: focus an open Breeze tab if one
// exists, otherwise open a fresh tab at the recorded URL.
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = event.notification.data?.url || '/';

  event.waitUntil(
    self.clients
      .matchAll({ type: 'window', includeUncontrolled: true })
      .then((wins) => {
        for (const client of wins) {
          // Same-origin Breeze tab — focus it.
          try {
            const clientUrl = new URL(client.url);
            if (clientUrl.origin === self.location.origin && 'focus' in client) {
              return client.focus();
            }
          } catch {
            /* skip */
          }
        }
        return self.clients.openWindow(url);
      }),
  );
});
