# Breeze OS mobile shells (Capacitor)

This directory is the home for the iOS and Android Capacitor projects.
The shells are intentionally **not committed in their entirety** until
you generate them locally — they contain platform-specific tooling
(CocoaPods, Gradle wrappers, signing configs) that needs to be set up
on a real Mac (for iOS) or any machine with the Android SDK (for
Android).

## What Capacitor is, in one sentence

Capacitor packages our existing Vite/React web build (`./dist`) inside
a native iOS `.ipa` and Android `.apk`/`.aab`, giving us real App
Store and Play Store apps that share 100% of their UI code with the
website.

## One-time setup

### Prerequisites

| Platform | What you need |
|----------|---------------|
| iOS      | macOS, Xcode 15+, CocoaPods (`sudo gem install cocoapods`) |
| Android  | JDK 17+, Android Studio (or just the Android command-line tools + SDK platform 34) |

### Generate the native projects

From the repo root:

```bash
# Make sure web deps and the web build are fresh — Capacitor copies
# from ./dist into the native shells on every sync.
npm install
npm run build

# Generate the iOS project (skip on a non-Mac machine).
npx cap add ios

# Generate the Android project.
npx cap add android

# Push the latest web build into both shells.
npx cap sync
```

After running these commands you will have:

```
ios/
  App/
    App.xcworkspace          ← open this in Xcode
    App/Info.plist
    ...
android/
  app/
    build.gradle             ← Android Studio "Open project" target
    src/main/AndroidManifest.xml
    ...
```

Both `ios/` and `android/` are already in `.dockerignore` and will be
gitignored by `.gitignore` — commit only the **generated source files**
you intentionally modify (Info.plist, AndroidManifest.xml, build
configs, signing configs once they exist).

## Day-to-day loop

```bash
# 1. Edit React code as usual under src/.
# 2. Rebuild the web bundle and push it into the native shells.
npm run build && npx cap sync

# 3. Run on a simulator / device.
npx cap open ios       # opens Xcode — hit ⌘R
npx cap open android   # opens Android Studio — hit ▶
```

For a fast inner loop you can also point the native app at the local
dev server instead of the bundled `dist/`. Set `server.url` in
`capacitor.config.json` to your machine's LAN IP + Vite dev port and
re-run `npx cap sync`. **Remember to revert before shipping a build.**

## Native capabilities already wired up

The web code in `src/lib/voice.js` and `src/lib/push.js` auto-detects
when it's running inside a Capacitor shell and prefers native APIs:

- **Push notifications** — `@capacitor/push-notifications`. Tokens are
  POSTed to `/api/push/register` and forwarded to FCM (which talks to
  APNs for iOS on our behalf).
- **Speech-to-text** — `@capacitor-community/speech-recognition` uses
  on-device transcription (free, fast, private). Falls back to
  `/api/stt` (ElevenLabs Scribe) when the device path isn't available.
- **Text-to-speech** — `@capacitor-community/text-to-speech` uses
  Apple's AVSpeechSynthesizer / Android's TextToSpeech. Falls back to
  `/api/tts` (ElevenLabs) when called with `prefer: 'cloud'`.

You don't need to do anything in JS to pick the native path — the
detection happens inside those two files based on `Capacitor.isNativePlatform()`.

## iOS push notification setup

1. In the Apple Developer portal, enable **Push Notifications** on the
   App ID for `com.breeze.os`.
2. Create an APNs Auth Key (`.p8`) and download it.
3. In the [Firebase console](https://console.firebase.google.com),
   create a project, add an iOS app with bundle ID `com.breeze.os`,
   and upload the `.p8` key (Project Settings → Cloud Messaging →
   Apple app configuration).
4. Download `GoogleService-Info.plist` and drop it into
   `ios/App/App/GoogleService-Info.plist`.
5. In Xcode, on the **Signing & Capabilities** tab, add the **Push
   Notifications** capability and the **Background Modes → Remote
   notifications** capability.

## Android push notification setup

1. In the same Firebase project, add an Android app with package name
   `com.breeze.os`.
2. Download `google-services.json` and drop it into
   `android/app/google-services.json`.
3. The `@capacitor/push-notifications` plugin handles the rest of the
   Gradle wiring automatically when you run `npx cap sync android`.

## Server-side push setup

Firebase Admin authenticates with a service-account JSON. Either:

```bash
# Option A — paste the JSON contents directly into the env var
fly secrets set FIREBASE_SERVICE_ACCOUNT_JSON="$(cat ~/Downloads/breeze-os-firebase-adminsdk.json)"

# Option B — mount the file and point Google's standard env var at it
# (works for Docker volumes / Kubernetes secret mounts)
fly secrets set GOOGLE_APPLICATION_CREDENTIALS=/secrets/firebase.json
```

`/api/push/send` will pick up whichever is configured.
