// Push notification registration for the React frontend.
//
// On a Capacitor native shell (iOS / Android), we request permission,
// receive an FCM registration token, and POST it to /api/push/register.
// On the web (browser, no Capacitor), this module is a no-op until we
// add a service-worker-based Web Push flow — that's a follow-up; for
// now the goal is real native push.
//
// Usage from React:
//   import { initPush } from './lib/push.js';
//   useEffect(() => { initPush({ onReceive: handle }); }, []);
//
// All Capacitor imports are dynamic so a plain web build doesn't pull
// the native plugins into the bundle.

let initialized = false;

function isNativePlatform() {
  // Capacitor injects a global on native shells. We avoid statically
  // importing @capacitor/core so the web build doesn't fail when the
  // package isn't installed (during the "Docker first" phase).
  if (typeof window === 'undefined') return false;
  const cap = window.Capacitor;
  return !!(cap && typeof cap.isNativePlatform === 'function' && cap.isNativePlatform());
}

function platformName() {
  if (typeof window === 'undefined') return 'web';
  const cap = window.Capacitor;
  if (cap && typeof cap.getPlatform === 'function') {
    const p = cap.getPlatform();
    if (p === 'ios' || p === 'android') return p;
  }
  return 'web';
}

// Pull metadata Capacitor gives us through the App plugin (if it's
// installed). Best-effort — every field is optional on the server.
async function collectDeviceMetadata() {
  const meta = {
    platform: platformName(),
    locale: typeof navigator !== 'undefined' ? navigator.language : undefined,
  };
  try {
    const { App } = await import('@capacitor/app');
    const info = await App.getInfo();
    meta.appVersion = info?.version;
  } catch {
    // @capacitor/app not installed yet — fine, app version stays blank.
  }
  try {
    const { Device } = await import('@capacitor/device');
    const info = await Device.getInfo();
    meta.deviceModel = info?.model;
  } catch {
    // @capacitor/device not installed yet — fine.
  }
  return meta;
}

async function registerTokenWithServer(token, meta) {
  try {
    const res = await fetch('/api/push/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token, ...meta }),
    });
    if (!res.ok) {
      console.warn('[push] /api/push/register returned', res.status);
    }
  } catch (err) {
    console.warn('[push] failed to register token with server:', err.message);
  }
}

export async function initPush({ onReceive, onAction } = {}) {
  if (initialized) return;
  if (!isNativePlatform()) {
    // Web build: nothing to do yet. Web Push via service worker is a
    // follow-up; getting native iOS / Android push working is the
    // priority.
    return;
  }
  initialized = true;

  let PushNotifications;
  try {
    ({ PushNotifications } = await import('@capacitor/push-notifications'));
  } catch (err) {
    console.warn('[push] @capacitor/push-notifications not installed:', err.message);
    return;
  }

  // Ask for permission (iOS shows the system prompt; Android 13+
  // requires this too).
  const perm = await PushNotifications.requestPermissions();
  if (perm.receive !== 'granted') {
    console.warn('[push] user denied push permission');
    return;
  }

  // Wire listeners BEFORE register() so we don't miss the first
  // registration event on slow devices.
  PushNotifications.addListener('registration', async (token) => {
    const meta = await collectDeviceMetadata();
    await registerTokenWithServer(token.value, meta);
  });

  PushNotifications.addListener('registrationError', (err) => {
    console.warn('[push] registration error:', err);
  });

  PushNotifications.addListener('pushNotificationReceived', (notification) => {
    onReceive?.(notification);
  });

  PushNotifications.addListener('pushNotificationActionPerformed', (action) => {
    onAction?.(action);
  });

  await PushNotifications.register();
}
