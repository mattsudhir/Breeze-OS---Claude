# Breeze OS — Android setup playbook

This is the end-to-end guide for getting the Breeze OS Android app
onto a phone. There are two paths:

- **[Phone-only path](#phone-only-path-no-laptop-required)** — CI
  builds the APK in the cloud, you install it from the GitHub Actions
  artifact link. No Android Studio, no laptop, no SDK install.
- **[Laptop path](#laptop-path)** — Android Studio + emulator for a
  faster inner loop. Use this when you want to iterate on the app
  itself in seconds rather than minutes.

The Android Capacitor project lives in `/android` and is committed to
the repo. You don't need to run `npx cap add android` — it's already
been done.

---

## Phone-only path (no laptop required)

The `.github/workflows/android.yml` workflow builds the APK on
GitHub's Ubuntu runners every time you push to a `claude/*` or `main`
branch. You install the APK on your phone by tapping a link.

### First-time setup (5 minutes, once)

1. **Allow APK installs on your phone**:
   - Android 8+: Settings → Apps → Special access → Install unknown
     apps → pick Chrome (or whichever browser you'll download from)
     → Allow.
   - You can flip this off again after you've installed Breeze OS.
2. **Install the GitHub mobile app** (App Store / Play Store). It
   makes running workflows and downloading artifacts a one-tap
   experience.
3. (Optional) **Create the Firebase project** so push notifications
   work in the next build:
   - https://console.firebase.google.com → Add project →
     "Breeze OS".
   - Inside the project: Add app → Android → package name
     `com.breeze.os` → Register.
   - Download the `google-services.json` it gives you.
   - In GitHub: repo → Settings → Secrets and variables → Actions →
     New repository secret. Name: `GOOGLE_SERVICES_JSON`. Value:
     paste the **full contents** of the JSON file. Save.
   - The next CI build will bake it into the APK automatically.

### The day-to-day loop

```
1. Tell me what to change in the chat thread.
2. I commit + push.
3. GitHub Actions runs (visible in the GitHub mobile app under
   Actions → Android build → latest run).
4. When it finishes (5–8 min), tap "breeze-os-debug-apk" in the
   Artifacts section to download.
5. Tap the downloaded .apk in your phone's Downloads. Android asks
   "Install?" — yes. Done.
```

You'll see the build progress in real time in the GitHub mobile app.
No laptop touched at any point.

### Manually triggering a build from the phone

GitHub app → repo → Actions → "Android build" → Run workflow → pick
the branch → Run. Useful when you want a fresh APK without committing
anything new.

### Signed release build for the Play Store

Eventually you'll want to upload to the Play Console. That needs a
signed AAB (not a debug APK). To enable that path:

1. Generate a release keystore once (on any machine with `keytool`,
   or have CI generate one and email you the file — let me know if
   you want that flow):
   ```bash
   keytool -genkey -v \
     -keystore breeze-os-release.jks \
     -keyalg RSA -keysize 2048 -validity 10000 \
     -alias breeze-release
   ```
2. Add four GitHub repo secrets (Settings → Secrets → Actions):
   - `ANDROID_KEYSTORE_BASE64` — `base64 -i breeze-os-release.jks`
     and paste the output.
   - `ANDROID_KEYSTORE_PASSWORD`
   - `ANDROID_KEY_ALIAS` — `breeze-release`
   - `ANDROID_KEY_PASSWORD`
3. Trigger the workflow with `build_type=release`. Download the AAB
   from the run's artifacts. Upload to Play Console.

**Lose the keystore = lose the ability to ship updates under the
same Play Store listing, forever.** Back it up to a password manager.

---

## Laptop path

## 1. One-time tooling install

You need **JDK 17 or 21** and the **Android SDK**. The easiest path:

1. Install [Android Studio](https://developer.android.com/studio)
   (Mac/Windows/Linux). It bundles the SDK, the platform tools, an
   emulator, and Gradle.
2. Open Android Studio once. It'll auto-download:
   - **SDK Platform 35** (Android 15) — our target.
   - **Build Tools 35.x**
   - **Platform Tools** (`adb`)
   - The Android Emulator
3. Set `ANDROID_HOME` in your shell rc:
   ```bash
   # macOS / Linux — ~/.zshrc or ~/.bashrc
   export ANDROID_HOME="$HOME/Library/Android/sdk"     # macOS
   # export ANDROID_HOME="$HOME/Android/Sdk"           # Linux
   export PATH="$PATH:$ANDROID_HOME/platform-tools:$ANDROID_HOME/emulator"
   ```
4. Verify:
   ```bash
   adb version
   java -version    # should print 17 or 21
   ```

If you'd rather skip Android Studio, install just the command-line
tools and SDK packages with `sdkmanager` — same result, more typing.

---

## 2. First build, on an emulator

```bash
# Make sure the web bundle is fresh and synced into the Android shell.
npm install
npm run build
npx cap sync android

# Open the project in Android Studio.
npx cap open android
```

In Android Studio:

1. Wait for Gradle to sync (status bar at the bottom).
2. Top-right toolbar: pick or create an emulator (Pixel 8 / API 35 is
   a sensible default).
3. Hit ▶ (Run app). Android Studio installs the debug APK on the
   emulator and launches Breeze OS.

The first Gradle sync downloads ~500 MB of dependencies — set up
coffee. Subsequent runs are seconds.

---

## 3. Day-to-day inner loop

```bash
# Edit React code under src/ as usual.
npm run build
npx cap sync android
# Then re-run from Android Studio (▶), or:
npx cap run android
```

For a fast loop, point the Android app at the local Vite dev server
instead of the bundled `dist/`:

1. Find your machine's LAN IP: `ipconfig getifaddr en0` (macOS) or
   `hostname -I` (Linux).
2. In `capacitor.config.json`, add:
   ```json
   "server": {
     "url": "http://10.0.0.42:5173",
     "cleartext": true,
     ...existing fields
   }
   ```
3. `npx cap sync android`
4. `npm run dev` (Vite on the host, accessible to the emulator)
5. Run the app — it'll hot-reload from your local Vite.

**Revert before building a release APK.** A release with `server.url`
pointed at your laptop will not work for anyone but you.

---

## 4. Firebase Cloud Messaging (push notifications)

1. In the [Firebase console](https://console.firebase.google.com),
   create a project (or reuse an existing one).
2. **Add an Android app**:
   - Package name: `com.breeze.os` (must match exactly — it's in
     `android/app/build.gradle` and `capacitor.config.json`).
   - App nickname: "Breeze OS Android".
   - SHA-1: optional for FCM, required for some other Firebase
     features. Get it later with `cd android && ./gradlew signingReport`.
3. Download **`google-services.json`**.
4. Drop it at `android/app/google-services.json` — this path is
   gitignored, so the file stays on your machine.
5. The Gradle wiring is already in place
   (`android/app/build.gradle` conditionally applies
   `com.google.gms.google-services` when the JSON file is present).
6. Rebuild from Android Studio — that's it. The push handler in
   `src/lib/push.js` will request permission, receive an FCM token,
   and POST it to `/api/push/register`.

### Test push end-to-end

Once the device has registered a token, get the server admin token
from your `.env` (`BREEZE_ADMIN_TOKEN`) and send a test:

```bash
curl -X POST http://localhost:3000/api/push/send \
  -H "Content-Type: application/json" \
  -H "x-admin-token: $BREEZE_ADMIN_TOKEN" \
  -d '{
    "organizationId": "YOUR_ORG_UUID",
    "title": "Breeze OS",
    "body": "Push from the server works."
  }'
```

The Firebase Admin SDK on the server needs its credentials — either
`FIREBASE_SERVICE_ACCOUNT_JSON` (recommended) or
`GOOGLE_APPLICATION_CREDENTIALS` pointing at the service-account JSON
you can download from **Firebase Console → Project Settings → Service
accounts → Generate new private key**.

---

## 5. App icon and splash screen

Capacitor ships placeholder icons. To replace them:

```bash
# Once, install the asset generator:
npm install -D @capacitor/assets

# Place a 1024×1024 PNG of the icon and a 2732×2732 PNG of the splash
# in ./resources/
#   resources/icon.png
#   resources/splash.png    (single-image splash on a colour bg)
#
# Then generate every density:
npx capacitor-assets generate --android
```

The generator writes into `android/app/src/main/res/mipmap-*` and
`android/app/src/main/res/drawable-*`. Commit the output — they're
real source files now.

Splash background colour also lives in
`capacitor.config.json → plugins.SplashScreen.backgroundColor` (already
set to the Breeze navy `#0F172A`).

---

## 6. Release build + signing

Debug builds are signed with the Android debug keystore (auto-managed,
not for production). For a Play Store upload you need a **release
keystore** you control.

### One-time: create the release keystore

```bash
keytool -genkey -v \
  -keystore ~/breeze-os-release.jks \
  -keyalg RSA -keysize 2048 -validity 10000 \
  -alias breeze-release

# Back up the .jks file. If you lose it, you cannot push updates
# under the same Play Store listing — period.
```

### Wire the keystore into Gradle without committing it

Create `android/keystore.properties` (gitignored):

```
storeFile=/Users/you/breeze-os-release.jks
storePassword=YOUR_STORE_PASSWORD
keyAlias=breeze-release
keyPassword=YOUR_KEY_PASSWORD
```

Then add a signing config to `android/app/build.gradle` (paste
inside the `android { ... }` block, above `defaultConfig`):

```gradle
def keystorePropertiesFile = rootProject.file("keystore.properties")
def keystoreProperties = new Properties()
if (keystorePropertiesFile.exists()) {
    keystoreProperties.load(new FileInputStream(keystorePropertiesFile))
}

signingConfigs {
    release {
        if (keystorePropertiesFile.exists()) {
            keyAlias keystoreProperties['keyAlias']
            keyPassword keystoreProperties['keyPassword']
            storeFile file(keystoreProperties['storeFile'])
            storePassword keystoreProperties['storePassword']
        }
    }
}
```

And inside `buildTypes.release { ... }`:

```gradle
signingConfig signingConfigs.release
minifyEnabled true
```

### Build a release AAB (what the Play Store wants)

```bash
cd android
./gradlew bundleRelease
# Output: android/app/build/outputs/bundle/release/app-release.aab
```

Upload this `.aab` to Play Console → your app → Internal testing
track. From there you can promote through Closed → Open → Production
once you're ready.

---

## 7. Bumping version for each Play Store upload

Two fields, both in `android/app/build.gradle`:

- `versionCode` — integer, must increase every upload. Bump by 1.
- `versionName` — user-visible string, e.g. `1.0.4`.

Pull these from `package.json` later if you want a single source of
truth.

---

## 8. Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| App boots to a white screen | `dist/` is empty or stale | `npm run build && npx cap sync android` |
| Push permission popup never appears | Android < 13 doesn't show one — permission is implicit | Test the actual notification arriving instead |
| `FirebaseApp not initialized` | `google-services.json` missing from `android/app/` | Drop the file in and rebuild |
| Mic icon never lights up | `RECORD_AUDIO` denied (Android settings) | Settings → Apps → Breeze OS → Permissions → Microphone → Allow |
| On-device STT silently does nothing | Google app disabled or no RecognitionService | Install/enable the Google app from Play Store |
| Gradle: "Plugin requires Java 17+" | JDK 11 on PATH | Install JDK 17 or 21, set `JAVA_HOME` |
| `targetSdk 35 required` Play Console error | Old build slipped through | We're already on 35 — make sure `npx cap sync` ran |
