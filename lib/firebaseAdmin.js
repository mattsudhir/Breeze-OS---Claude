// Firebase Admin SDK singleton — used by /api/push/send to deliver
// push notifications to iOS + Android devices via FCM.
//
// Configuration (one of):
//   FIREBASE_SERVICE_ACCOUNT_JSON  — full service-account JSON as a
//                                    string. Easiest for Fly secrets:
//                                    `fly secrets set FIREBASE_SERVICE_ACCOUNT_JSON='{...}'`
//   GOOGLE_APPLICATION_CREDENTIALS — path to the same JSON on disk.
//                                    Works with Docker secret mounts /
//                                    Kubernetes ConfigMap mounts.
//
// If neither is set, getMessaging() throws a clear error so push
// handlers can return a useful 503 instead of crashing the process.

import { readFileSync } from 'node:fs';

let cached = null;

async function loadCredentials() {
  if (process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
    try {
      return JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
    } catch (err) {
      throw new Error(
        `FIREBASE_SERVICE_ACCOUNT_JSON is set but not valid JSON: ${err.message}`,
      );
    }
  }
  if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
    try {
      const raw = readFileSync(process.env.GOOGLE_APPLICATION_CREDENTIALS, 'utf8');
      return JSON.parse(raw);
    } catch (err) {
      throw new Error(
        `GOOGLE_APPLICATION_CREDENTIALS could not be read: ${err.message}`,
      );
    }
  }
  throw new Error(
    'Firebase credentials are not configured. Set FIREBASE_SERVICE_ACCOUNT_JSON ' +
      'or GOOGLE_APPLICATION_CREDENTIALS, then redeploy.',
  );
}

// Lazy init — first caller pays the import + auth cost, later callers
// reuse the same Messaging instance for the life of the process.
export async function getMessaging() {
  if (cached) return cached;

  // Dynamic import so the dependency is only required when push is
  // actually used. Web-only deploys can skip installing firebase-admin
  // until they're ready to ship mobile.
  const adminApp = await import('firebase-admin/app');
  const adminMessaging = await import('firebase-admin/messaging');

  const credentials = await loadCredentials();
  const apps = adminApp.getApps();
  const app = apps.length
    ? apps[0]
    : adminApp.initializeApp({
        credential: adminApp.cert(credentials),
      });

  cached = adminMessaging.getMessaging(app);
  return cached;
}
