// Converted from a static app.json (N482, #829) for exactly one reason: the
// Android Google Maps API key `react-native-maps`'s config plugin needs has
// to be resolved from the environment at config-EVALUATION time (this file
// runs as Node during `expo prebuild` / `eas build`), and plain app.json has
// no templating. Everything else here is an unmodified copy of the old
// app.json's `expo` object.
//
// `androidGoogleMapsApiKey` is deliberately NOT an `EXPO_PUBLIC_*` var — that
// prefix means "Metro/Babel string-substitutes this into the JS bundle at
// transform time" (see .env.example), and nothing in this app reads it that
// way (no app code calls `Constants.expoConfig`). It only has to exist in
// `process.env` while THIS file evaluates, which the Expo CLI already does
// for `.env`/`.env.local` regardless of prefix
// (https://docs.expo.dev/guides/environment-variables/, "Reading environment
// variables with Expo CLI, in app config").
//
// This is NOT the same claim as "never reachable from app code" — Expo's
// `isPublicConfig` resolution (what `expo-constants` bakes into the binary
// for `Constants.expoConfig`, and what the dev-client/EAS-Update manifest
// serves over the network) does NOT strip the `plugins` array, so this value
// would be readable there too if something ever called `Constants.expoConfig`
// (verified against the installed `@expo/config` package's source — as of
// this writing it does not). The real protection was always Google Cloud's
// package-name + SHA-1 restriction (see below and .env.example), not this
// env var's naming — the key ends up unencrypted in the built
// AndroidManifest.xml either way, which restriction is what accounts for.
//
// react-native-maps' plugin (`plugin/build/android.js`, `withMapsAndroid`)
// writes `androidGoogleMapsApiKey` into AndroidManifest.xml as
// `com.google.android.geo.API_KEY` when it is set, and removes that
// meta-data item when it is unset — there is no keyless/free tier the way
// iOS gets with Apple Maps, so an unset key means the running-tracking map
// renders blank/grey tiles on Android rather than crashing. See
// docs/decisions/history.md's N482 entry for exactly what a human needs to
// do in Google Cloud Console (issue + restrict a Maps SDK for Android key)
// and in EAS (`eas env:create`, same pattern this repo already uses for
// `EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY`) to supply a real value.
module.exports = () => ({
  expo: {
    name: "VOLA",
    slug: "vola",
    // N582 (#1260) — the EAS account that owns this project. Required before
    // `eas init` will run non-interactively when the signed-in user has access
    // to more than one account (here: `dchobotar` and `dchobotars-team`), and
    // it pins which account's builds and credentials this app uses rather than
    // leaving it to whoever happens to be logged in.
    owner: "dchobotar",
    // The EAS project this app builds under. `eas init` creates it server-side
    // but CANNOT write it back into a dynamic config (app.config.js), so it is
    // pasted here by hand — without it every `eas build` would re-prompt to
    // create a project and could silently make a second one.
    extra: {
      eas: {
        projectId: "45733def-bc3b-455e-97ab-7674e86a2313",
      },
    },
    version: "1.0.0",
    orientation: "portrait",
    icon: "./assets/images/icon.png",
    scheme: "vola",
    userInterfaceStyle: "dark",
    ios: {
      supportsTablet: true,
      bundleIdentifier: "com.vola.fitness",
      // No `buildNumber` here on purpose: eas.json sets
      // `appVersionSource: "remote"`, so EAS owns the build number and a
      // literal here is IGNORED for builds while still being served to
      // expo-constants — i.e. a value that looks authoritative, is not, and
      // silently disagrees with the binary. EAS itself warns about this.
      infoPlist: {
        ITSAppUsesNonExemptEncryption: false,
        // Kept, but NOT the fix it was added as. It was added on the
        // hypothesis that a missing top-level CFBundleIconName was why build 4
        // vanished during processing. Apple's actual rejection email named
        // ITMS-90683 / NSMotionUsageDescription instead, so that hypothesis was
        // wrong. A top-level key is still the conventional shape for an
        // asset-catalog icon and is harmless, so it stays — but nobody should
        // read it as load-bearing.
        CFBundleIconName: "AppIcon",
      },
    },
    android: {
      adaptiveIcon: {
        backgroundColor: "#0B1220",
        foregroundImage: "./assets/images/android-icon-foreground.png",
        backgroundImage: "./assets/images/android-icon-background.png",
        monochromeImage: "./assets/images/android-icon-monochrome.png",
      },
      predictiveBackGestureEnabled: false,
      package: "com.vola.fitness",
      versionCode: 1,
      // ONE ENTRY PER RECORD TYPE IN `READ_RECORD_TYPES` (lib/healthConnect.ts),
      // and the two lists are kept in step BY HAND — nothing generates one from
      // the other; `check:health-permissions-parity` (H16/#951) fails when they
      // drift. W15/#944 is what
      // drifting looks like: `ExerciseSession` joined the read list for N479
      // (walk/hike detection) and `READ_EXERCISE` never joined this one, so on
      // Android every read of it threw a SecurityException that
      // `queryOtherExerciseSessions` caught and returned as "no records". The
      // feature was dead, Settings said it worked, and no check in the repo
      // could see it — a manifest missing a permission prebuilds and builds
      // cleanly. Health Connect's own naming, one per record type. `READ_STEPS`
      // joined for N569 (#1130), with `Steps` in READ_RECORD_TYPES in the same
      // commit. Like every entry here it reaches a phone only through a NATIVE
      // REBUILD; a Metro reload leaves the installed manifest without it:
      permissions: [
        "android.permission.health.READ_HEART_RATE",
        "android.permission.health.READ_VO2_MAX",
        "android.permission.health.READ_EXERCISE",
        "android.permission.health.READ_STEPS",
      ],
    },
    web: {
      bundler: "metro",
      output: "static",
      favicon: "./assets/images/favicon.png",
    },
    plugins: [
      "expo-router",
      [
        "expo-splash-screen",
        {
          backgroundColor: "#080B12",
          // ANDROID ONLY, and load-bearing rather than decorative: without an
          // `image` here, no Android build links at all (N526/#943).
          //
          // `expo-splash-screen`'s Android plugin ALWAYS writes
          //   <item name="windowSplashScreenAnimatedIcon">@drawable/splashscreen_logo</item>
          // into res/values/styles.xml (withAndroidSplashStyles.js), but only
          // GENERATES that drawable when an `image` is supplied
          // (withAndroidSplashImages.js: "If path isn't provided then no new
          // image is placed in drawable directories"). With no image the
          // reference dangles and resource linking fails outright:
          //   error: resource drawable/splashscreen_logo not found.
          //   error: failed linking references.
          // Reproduced on a clean checkout before fixing: styles.xml carried
          // the reference and 0 splashscreen_logo files existed;
          // `:app:processDebugResources` FAILED in 16s.
          //
          // iOS is unaffected and stays image-less — its half of the plugin
          // emits a storyboard with no equivalent reference, which is why this
          // survived unnoticed until the first Android build was ever
          // attempted. Scoped under `android` so it stays that way:
          // getAndroidSplashConfig.js merges this sub-object over the root
          // props, and the root keeps only `backgroundColor`.
          //
          // The MARK, not `assets/brand/splash/*.svg`: those masters are
          // whole 1080x1920 compositions (background, wordmark, tagline), and
          // Android 12+'s `windowSplashScreenAnimatedIcon` slot takes a
          // CENTRED ICON, not a full-screen image. The tick on the dark
          // ground is what that slot is for.
          //
          // 160 because Android 12+ masks the splash icon to a 192dp inner
          // circle of a 288dp canvas, and this tick spans nearly its whole
          // square canvas, so its points sit at the very edge. 160dp keeps
          // them inside that mask with room to spare.
          //
          // What was actually MEASURED is 160, on a Pixel 7 / API 36
          // emulator: the tick renders whole and centred, both points
          // intact, no clipping. Larger values were NOT tried — the safe-zone
          // figure above is Android's documented geometry, not something
          // observed failing here, and it is written that way deliberately
          // rather than implying a comparison nobody ran.
          android: {
            image: "./assets/images/vola-mark.png",
            imageWidth: 160,
          },
        },
      ],
      "expo-image",
      [
        "expo-image-picker",
        {
          photosPermission:
            "VOLA uses your photos so you can attach a progress picture to a check-in, set a profile photo, or choose a photo for your session share card. Progress pictures stay private to your account; a profile photo is visible to other athletes; a share-card photo never leaves your phone — it's only used to render the image you export.",
          cameraPermission:
            "VOLA uses the camera so you can photograph a meal to estimate it, photograph a gym machine to identify it, scan a barcode off a food packet, take a profile photo, or take a photo for your session share card. A meal, machine or barcode photo is read and not stored; a barcode never leaves your phone; a profile photo is stored, resized, and visible to other athletes; a share-card photo never leaves your phone either — it's only used to render the image you export.",
          microphonePermission: false,
        },
      ],
      [
        "expo-camera",
        {
          cameraPermission:
            "VOLA uses the camera so you can photograph a meal to estimate it, photograph a gym machine to identify it, scan a barcode off a food packet, take a profile photo, or take a photo for your session share card. A meal, machine or barcode photo is read and not stored; a barcode never leaves your phone; a profile photo is stored, resized, and visible to other athletes; a share-card photo never leaves your phone either — it's only used to render the image you export.",
          microphonePermission: false,
          recordAudioAndroid: false,
        },
      ],
      "expo-sharing",
      [
        // N528/#958: live heart rate from a Bluetooth Heart Rate Profile
        // monitor. Foreground only — no background mode, no `modes` — so the
        // binary declares exactly the capability the feature uses: a session
        // runs with the app open and on screen (mobile owns live logging).
        // `neverForLocation` is Android 12+'s way of saying a BLE scan is not
        // a location scan, which keeps ACCESS_FINE_LOCATION out of the
        // manifest — the same "declare only what you use" discipline the
        // expo-location entry below applies. Permission strings are the
        // athlete's words for the feature, not the API's.
        "react-native-ble-plx",
        {
          // W21/#992: background BLE, so a run's heart rate survives the
          // screen locking. TWO props are needed and only one of them is
          // obvious — `isBackgroundEnabled` alone does NOT do this. Measured
          // against the plugin's own source: `withBLE.js` passes
          // `isBackgroundEnabled` only to `withBLEAndroidManifest` (an
          // Android <uses-feature> line), while the iOS `UIBackgroundModes`
          // entry comes exclusively from
          // `withBLEBackgroundModes(config, _props.modes || [])`. A first cut
          // of this ticket set the flag, asserted in three places that
          // `bluetooth-central` had shipped, and generated an Info.plist
          // without it; `ac-verifier` caught that by running `expo prebuild`
          // and reading the plist rather than trusting the config.
          //
          // `central` only — VOLA reads a monitor and never advertises as
          // one, so `peripheral` would be a capability we do not use.
          isBackgroundEnabled: true,
          modes: ['central'],
          neverForLocation: true,
          // The old string promised 'Only while VOLA is open', which this
          // change would have turned into a lie in the system dialog.
          bluetoothAlwaysPermission:
            'VOLA connects to your heart-rate monitor over Bluetooth to record your heart rate during a run, including while your screen is locked. It connects when a run starts and disconnects when the run ends.',
        },
      ],
      [
        "expo-location",
        {
          // W21/#992 rewrote this. The old text promised "only accessed while
          // VOLA is open and on screen — VOLA does not track your location in
          // the background", which the `location` background mode below makes
          // false. Reviewers caught the Bluetooth string's version of this lie
          // and this one was missed on the first pass; both are what the
          // athlete actually reads in the system dialog.
          locationWhenInUsePermission:
            "VOLA uses your location to track your run's route, distance and pace. While a run is in progress it keeps tracking with your screen locked, and iOS shows its location indicator the whole time. Tracking starts when you start a run and stops when you finish it — VOLA never tracks your location at any other time.",
          // W21/#992: the `location` background mode, so a run keeps
          // recording once the screen locks.
          //
          // This does NOT need 'Always' authorization and deliberately does
          // not ask for it: when-in-use plus this background mode is the
          // standard run-tracker arrangement, and iOS shows its own blue
          // indicator throughout. The two `false`s below are unchanged.
          //
          // The mode alone is NOT sufficient, which is the easy thing to get
          // wrong: expo-location hard-codes `allowsBackgroundLocationUpdates
          // = false` in BaseLocationProvider.swift (the provider behind
          // `watchPositionAsync`) and sets it true only in
          // EXLocationTaskConsumer.m — the TaskManager path. So the running
          // screen tracks via `startLocationUpdatesAsync`; read
          // lib/runningTrackingTask.ts before changing either.
          isIosBackgroundLocationEnabled: true,
          locationAlwaysAndWhenInUsePermission: false,
          locationAlwaysPermission: false,
          // Was `false`, which REMOVED NSMotionUsageDescription — and that is
          // what Apple rejected build 4 for: "ITMS-90683: Missing purpose
          // string in Info.plist … should contain a NSMotionUsageDescription
          // key" (2026-10-15).
          //
          // Nothing in this app calls a motion API directly. The HealthKit
          // library references CMPedometer to read step counts, which is
          // exactly the case Apple's message names: "If you're using external
          // libraries or SDKs, they may reference APIs that require a purpose
          // string. While your app might not use these APIs, a purpose string
          // is still required."
          //
          // IT MUST BE SET HERE, NOT IN `ios.infoPlist`. expo-location's plugin
          // OWNS this key via createPermissionsPlugin, so it runs last and wins
          // — setting it in `ios.infoPlist` is silently discarded. Measured:
          // with the key in `ios.infoPlist`, an arbitrary probe key survived
          // `expo config --type introspect` and this one did not, and the built
          // IPA shipped without it. Same ownership trap CLAUDE.md records for
          // the camera and microphone strings.
          motionUsagePermission:
            "VOLA can show your daily step count alongside your training. iOS counts steps using motion data, so this permission is what lets VOLA read them. It is read-only and off until you turn on Health syncing in Settings.",
        },
      ],
      [
        "react-native-maps",
        {
          // iOS deliberately carries no `iosGoogleMapsApiKey` — VOLA stays on
          // the free Apple Maps provider there (N459). Android has no
          // equivalent free tier, hence this key.
          androidGoogleMapsApiKey: process.env.ANDROID_GOOGLE_MAPS_API_KEY,
        },
      ],
      [
        "@kingstinct/react-native-healthkit",
        {
          NSHealthShareUsageDescription:
            "VOLA can import runs you've already recorded elsewhere — on an Apple Watch, or logged directly in the Health app — so they appear in your training history without re-entering them. It can also read heart rate for any finished session and your VO2max trend, and, if you allow it, your daily step count to show on VOLA. All of this is off until you turn it on in Settings, and VOLA never writes anything to Health.",
          // Was `false` — deliberately, because VOLA never writes to Health
          // and this repo does not declare capabilities it does not use (see
          // the permission traps in the `vola-mobile-build` skill, where
          // declaring an unused capability was called indefensible — that text
          // moved out of CLAUDE.md, so do not go looking for it there).
          //
          // Apple refuses the upload without it. Measured 2026-09-30 against
          // the real App Store Connect uploader, error 90683: "The Info.plist
          // file for the VOLA.app bundle should contain a
          // NSHealthUpdateUsageDescription key". The HealthKit ENTITLEMENT
          // covers reading and writing together — there is no read-only
          // variant — so the string is demanded by the capability, not by
          // anything VOLA actually does.
          //
          // The wording therefore keeps the promise the share string above
          // makes, rather than inventing a reason to write.
          NSHealthUpdateUsageDescription:
            "VOLA does not write anything to Apple Health. It only reads the data you explicitly allow, and never adds, changes or deletes anything there. iOS requires this text because the Health capability covers reading and writing together; VOLA never asks for permission to write.",
          background: false,
        },
      ],
      "react-native-health-connect",
      [
        "expo-build-properties",
        {
          android: {
            compileSdkVersion: 36,
            targetSdkVersion: 36,
            minSdkVersion: 26,
          },
          ios: {
            // N581 (#1259). The iOS 27 SDK refuses to launch a UIKit app that
            // has not adopted the UIScene life cycle: EXC_BREAKPOINT in
            // __UIApplicationEvaluateRuntimeIssueForNoSceneLifecycleAdoption,
            // instantly, before any JS runs. Every build made here since Xcode
            // 27 landed has died that way.
            //
            // Expo added the adoption in 57.0.23 and made it opt-in, because it
            // changes how the native app starts. This repo is on 57.0.25.
            enableSceneSupport: true,
          },
        },
      ],
    ],
    experiments: {
      typedRoutes: true,
    },
    backgroundColor: "#080B12",
  },
});
