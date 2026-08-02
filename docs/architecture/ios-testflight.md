# Getting VOLA onto a real iPhone

## Read this first: App Store Expo Go cannot run this project

Expo Go on the iOS App Store is **pinned at SDK 54**. This project is on SDK 57.
No amount of updating the app from the App Store will change that — there is no
released build of Expo Go that can load an SDK 57 project on a physical iPhone.

Apple's review queue is the bottleneck, not Expo's release cadence. Expo's
[May 2026 changelog](https://expo.dev/changelog/expo-go-and-app-store-may-2026)
records the SDK **55** build still sitting unapproved with no timeline; the
[SDK 57 changelog](https://expo.dev/changelog/sdk-57) says plainly *"we're still
waiting on approval."* The External TestFlight beta for Expo Go is at capacity
and closed to new users.

Symptom when you hit this: Expo Go connects to Metro, then shows **"Project is
incompatible with this version of Expo Go."** That message reads like a stale
install. It isn't.

### Why the simulator is not evidence

**The iOS Simulator gets Expo Go from Expo CLI directly, never from the App
Store.** So the simulator happily runs Expo Go 57.x against this project while a
physical phone cannot. The two clients ship through completely different
channels, and the working one is the channel Apple doesn't gate.

The same trap exists on npm: `npm view expo dist-tags` reports the SDK Expo has
*published*, which says nothing about what Apple has *approved*. Checking npm to
predict App Store availability is checking the wrong registry — the only sources
that answer the question are Expo's changelog and
[expo.dev/go](https://expo.dev/go?sdkVersion=57&platform=ios&device=true).

## The four ways onto a device

| | Cost | Setup | Lifespan | Standalone? |
|---|---|---|---|---|
| 1. `expo run:ios --device` | free | Xcode + cable | **7 days** | yes (Release) |
| 2. EAS development build | $99/yr | EAS account | 1 year | yes |
| 3. `eas go` | $99/yr | EAS account | 1 year | no — it's Expo Go |
| 4. App Store Expo Go | free | — | — | **impossible at SDK 57** |

## 1. `expo run:ios --device` — free, works today

Xcode builds straight onto a plugged-in phone, signed with a **free** Apple ID.
No Developer Program membership.

```bash
cd apps/mobile
npx expo prebuild --platform ios       # generates ios/ — gitignored, regenerable
npx expo run:ios --device --configuration Release
```

Prerequisites, each of which fails the build in its own confusing way if missed:

- **The phone plugged in over USB, unlocked, and trusted.** Appearing in
  `xcrun devicectl list devices` is **not** sufficient — that lists Wi-Fi-paired
  phones too, so an unplugged phone still shows as `available (paired)` and the
  build then hangs forever waiting for a device it cannot reach. Check the
  transport, not the listing:

  ```bash
  xcrun devicectl list devices          # get the device's UUID column
  xcrun devicectl device info details --device <UUID> --json-output /dev/stdout \
    | grep -E 'tunnelState|transportType|pairingState|developerModeStatus'
  ```

  You want `tunnelState: connected`, `transportType: wired`,
  `pairingState: paired`, `developerModeStatus: enabled`. "No devices found"
  means the Trust prompt was never accepted.
- **An Apple ID added in Xcode → Settings → Accounts.** Check with
  `security find-identity -v -p codesigning`; "0 valid identities found" means
  Xcode has no team to sign with.
- **CocoaPods, and a UTF-8 locale.** See the gotcha below — this one bites
  every time.

**Use `--configuration Release`.** A Debug build still needs Metro running on
the same Wi-Fi, which defeats the point. Release bundles the JS into the binary,
so the app runs standing alone at the gym with the Mac asleep at home.

**Verify the bundle actually got embedded — `Build Succeeded` does not prove
it.** A Debug build succeeds, installs, reports zero errors, and then shows
"Could not connect to development server" the moment you open it away from the
Mac, because `expo run:ios` stops Metro on exit. The two outcomes are
indistinguishable from the build log; they differ by one file:

```bash
find ~/Library/Developer/Xcode/DerivedData/VOLA-*/Build/Products/Release-iphoneos/VOLA.app \
  -name '*.jsbundle' -maxdepth 2
```

A ~5 MB `main.jsbundle` means the app is self-contained. No output means you
built Debug — whatever the log said. This has been shipped by mistake once
already, and the only reason it was caught was checking the `.app` rather than
trusting the build output.

**And a correct build is still not a correct install.** Observed: a Debug build
installed at 22:54, a Release build at 22:56 whose log read
`Installing .../Release-iphoneos/VOLA.app` — and the phone still ran the Debug
one, failing with `No script URL provided … unsanitizedScriptURLString = (null)`.
Both carry `CFBundleVersion: 1` and version `1.0.0`, which is the likely reason
the replacement was skipped, though that was not proven. Verify on the device
rather than in the log:

```bash
xcrun devicectl device process launch --device <UUID> --console \
  --terminate-existing com.vola.fitness
```

`ReactInstance: evaluateJavaScript() with JS bundle` means the embedded bundle
loaded. `No script URL provided` means the device is still running an older
Debug install. Force the replacement explicitly — **do not uninstall first**,
that destroys unsynced offline data in the app's SQLite store:

```bash
xcrun devicectl device install app --device <UUID> \
  ~/Library/Developer/Xcode/DerivedData/VOLA-*/Build/Products/Release-iphoneos/VOLA.app
```

The signature **expires after 7 days** and the app stops launching — re-run the
command to revive it. That is Apple's limit on free provisioning, not something
the project can work around.

### Gotcha: `pod install` fails with an encoding error

```
Unicode Normalization not appropriate for ASCII-8BIT (Encoding::CompatibilityError)
```

CocoaPods requires a UTF-8 locale and a non-interactive shell often has `LANG`
unset entirely. `expo prebuild` runs `pod install` for you and inherits that
empty environment, so prebuild reports a CocoaPods failure that has nothing to
do with the pods. The native directory is generated correctly; only the install
step dies.

```bash
cd apps/mobile/ios && LANG=en_US.UTF-8 pod install
```

Then re-run `expo run:ios`. Adding `export LANG=en_US.UTF-8` to `~/.zshrc` makes
it permanent.

## 2. EAS development build — the real answer once you have the membership

Needs an **Apple Developer Program membership ($99/year)** and a free Expo
account. Everything in the repo is already configured; what follows is the part
that needs credentials.

```bash
npm i -g eas-cli
eas login
cd apps/mobile

# One-time: creates the EAS project and writes extra.eas.projectId into
# app.json. Requires being logged in, which is why it is not committed.
eas init

# One-time: the Clerk key, kept out of git like every other key here.
eas env:create --name EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY \
  --value pk_test_... --environment preview --environment production \
  --visibility plaintext

pnpm run build:ios      # eas build --platform ios --profile preview
pnpm run submit:ios     # eas submit --platform ios --latest
```

EAS generates and stores the certificate and provisioning profile for you — it
asks for your Apple ID during the first build. Expect **15–25 minutes** in the
build queue, then another **10–30 minutes** of App Store Connect processing
before testers can install.

`eas submit` needs an App Store Connect app record. Create it once at
appstoreconnect.apple.com with bundle id `com.vola.fitness`, then put its numeric
App ID into `eas.json`'s `submit.production.ios.ascAppId`.

### The build profiles

| Profile | Distribution | API it points at |
|---|---|---|
| `development` | internal, dev client, simulator | `http://localhost:8080` |
| `preview` | internal (TestFlight-able) | staging |
| `production` | store | staging |

`production` still points at staging deliberately: there is no production API
yet. Change it when there is, and not before — a build that points somewhere
that doesn't exist is worse than one that points somewhere real.

**`EXPO_PUBLIC_*` vars are inlined at bundle time, not read at runtime.** A
TestFlight build carries whatever EAS had when it built. This is why the API URL
lives in `eas.json` per profile rather than in `.env.local`: a build made from a
developer's machine would otherwise point at their LAN IP and work on exactly
one desk. The same rule is why restarting Metro is not enough after editing
`.env.local` — the bundle has to be rebuilt (`--clear`).

## 3. `eas go` — a private Expo Go, same price as a dev build

```bash
npx eas-cli@latest go
```

Builds a custom Expo Go on EAS and deploys it to *your* TestFlight internal
team. It is the officially documented way to run SDK 57 on a device via Expo Go,
and it needs the **same $99/year membership** option 2 does.

Given equal cost, prefer option 2. A development build is VOLA — its own icon,
its own bundle id, its own native modules — where this is a private copy of a
generic host app. The one thing it buys is the scan-a-QR-and-reload workflow
across any project on any SDK, which matters if you juggle several.

## 4. Expo Go from the App Store

Not available for this project. See the top of this file. Kept in the list only
so nobody rediscovers it as a fresh idea.

For **Android** there is no equivalent problem — Google Play's Expo Go tracks
the current SDK, and the emulator gets its copy from Expo CLI either way.

## Known gaps

- **No `expo-updates`.** Every JS change needs a fresh build and another
  TestFlight round trip. Adding it would allow over-the-air JS updates without
  resubmitting; deferred because it changes the release model and deserves its
  own decision.
- **`com.vola.fitness` is permanent once submitted.** Changing the bundle
  identifier after the first App Store Connect submission means a new app
  listing, losing TestFlight testers and any review history.
- **SDK 57 locks us out of App Store Expo Go for as long as Apple's queue
  lasts.** Downgrading to SDK 54 would restore it, at the cost of three SDK
  versions and a React Native downgrade — not worth it, but worth writing down
  as the trade that was declined rather than overlooked. Note that from SDK 56
  onward `create-expo-app` asks new projects to choose between App Store Expo Go
  compatibility and the latest SDK, so this is now a permanent fork in the road,
  not a temporary outage.
- **The app has never been built as a real binary** — only run under Expo Go.
  Expect the first build to surface configuration Expo Go tolerated. That is
  normal, not a signal something is broken.
