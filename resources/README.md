# Capacitor source assets

Drop two PNG files in this directory:

| File | Size | Purpose |
|---|---|---|
| `icon.png` | **1024 × 1024** | App icon. Used to generate every iOS / Android density. |
| `splash.png` | **2732 × 2732** | Splash screen background. Should be the logo centred on a solid colour with generous padding — Android crops aggressively. |

Then run:

```bash
# All platforms
npm run assets:generate

# Just Android
npm run assets:generate:android

# Just iOS (after `npx cap add ios`)
npm run assets:generate:ios
```

The generator writes into:

- `android/app/src/main/res/mipmap-*/ic_launcher*.png` (legacy)
- `android/app/src/main/res/mipmap-anydpi-v26/ic_launcher.xml` (adaptive)
- `android/app/src/main/res/drawable-*/splash.png`
- `ios/App/App/Assets.xcassets/AppIcon.appiconset/*.png`
- `ios/App/App/Assets.xcassets/Splash.imageset/*.png`

Commit the generator output — those are the real source files now.

## Splash background

The splash background colour is controlled separately, in
`capacitor.config.json → plugins.SplashScreen.backgroundColor`. It's
currently the Breeze navy `#0F172A`. Match the colour you pick in
`splash.png` to that hex code so users don't see a seam during the
fade-out.

## Adaptive icon (Android 8+)

Android adaptive icons are composed of a foreground layer + a
background colour. By default `@capacitor/assets` uses `icon.png` as
the foreground on a single-colour background. If you want a
different foreground/background pair, add:

```
resources/
  android/
    icon-foreground.png       (1024×1024 with transparent bg)
    icon-background.png       (1024×1024 solid colour or pattern)
```

The generator picks them up automatically.

## Notes

- The 1024×1024 icon must NOT have rounded corners or alpha along the
  edges — Apple's App Store rejects icons with transparency.
- The splash should not contain critical UI elements near the edges:
  Android crops, iOS letterboxes. Keep your logo within the centre
  60% of the canvas.
