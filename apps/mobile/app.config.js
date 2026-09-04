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
    version: "1.0.0",
    orientation: "portrait",
    icon: "./assets/images/icon.png",
    scheme: "vola",
    userInterfaceStyle: "dark",
    ios: {
      supportsTablet: true,
      bundleIdentifier: "com.vola.fitness",
      buildNumber: "1",
      infoPlist: {
        ITSAppUsesNonExemptEncryption: false,
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
      permissions: [
        "android.permission.health.READ_HEART_RATE",
        "android.permission.health.READ_VO2_MAX",
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
        "expo-location",
        {
          locationWhenInUsePermission:
            "VOLA uses your location to track your run's route, distance and pace while you're using the app. Location is only accessed while VOLA is open and on screen — VOLA does not track your location in the background or when the app is closed.",
          locationAlwaysAndWhenInUsePermission: false,
          locationAlwaysPermission: false,
          motionUsagePermission: false,
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
            "VOLA can import runs you've already recorded elsewhere — on an Apple Watch, or logged directly in the Health app — so they appear in your training history without re-entering them. It can also read heart rate for any finished session and your VO2max trend. All of this is off until you turn it on in Settings, and VOLA never writes anything to Health.",
          NSHealthUpdateUsageDescription: false,
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
        },
      ],
    ],
    experiments: {
      typedRoutes: true,
    },
    backgroundColor: "#080B12",
  },
});
