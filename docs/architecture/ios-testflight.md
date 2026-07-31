# Getting VOLA onto a real iPhone

Three ways to run the app on a device, in increasing order of setup cost. Pick
the cheapest one that answers the question you have.

## 1. Expo Go — zero setup, same Wi-Fi

```bash
pnpm run dev:mobile
```

Install Expo Go from the App Store, scan the QR with the Camera app. Two things
bite here, both documented in the root `CLAUDE.md`:

- **Use `dev:mobile`, not `pnpm --filter mobile ios`.** The `ios` script passes
  `--localhost`, which binds the deep link to `127.0.0.1` — the simulator's
  loopback, unreachable from a phone.
- **`EXPO_PUBLIC_API_URL` must be a LAN IP or the staging URL**, never
  `localhost`. The phone cannot reach your Mac's loopback.

Good enough to actually train with. It is not a standalone app — it runs inside
Expo Go and dies when the dev server does.

## 2. TestFlight — a real installable build

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
one desk.

## 3. `expo run:ios --device` — local build, no paid account

Builds with Xcode straight onto a plugged-in phone, signed with a free Apple ID.
The signature **expires after 7 days** and the app stops launching. Fine for a
one-off check, useless for anything sustained.

## Known gaps

- **No `expo-updates`.** Every JS change needs a fresh build and another
  TestFlight round trip. Adding it would allow over-the-air JS updates without
  resubmitting; deferred because it changes the release model and deserves its
  own decision.
- **`com.vola.fitness` is permanent once submitted.** Changing the bundle
  identifier after the first App Store Connect submission means a new app
  listing, losing TestFlight testers and any review history.
- **The app has never been built as a real binary** — only run under Expo Go.
  Expect the first build to surface configuration Expo Go tolerated. That is
  normal, not a signal something is broken.
