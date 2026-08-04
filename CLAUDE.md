# VOLA — instructions for Claude Code

VOLA is a unified training and nutrition platform for BJJ athletes who also strength train and track nutrition — one athlete profile and calendar connecting BJJ, strength training, and nutrition, with deterministic, explainable cross-sport recommendations.

**Start here for full context:** [docs/decisions/history.md](docs/decisions/history.md) — chronological narrative of what's been built and why. `docs/architecture/*.md` hold the current-state detail this file only summarizes.

## Repo map

- `backend/` — Go modular monolith, stdlib `net/http` (no web framework, deliberately). `cmd/api`, `cmd/migrate`, `cmd/seed`. `internal/modules/*` per domain, `internal/platform/*` for cross-cutting concerns (`auth`, `database`, `apihttp`).
- `apps/web/` — Next.js customer app, Clerk auth. **Web (and admin) use Clerk's _prebuilt_ `<SignInButton mode="modal">`; only `apps/mobile` hand-builds auth on the headless hooks.** That split is deliberate — mobile needed the flows designed (offline-tolerant errors, a resumable sign-up), web does not — so **don't port mobile's auth screens here.** VOLA styling comes from `src/app/clerkAppearance.ts`, whose `appearance.variables` are `var(--c-*)` references and never hex, so the modal follows the light/dark toggle with no theme detection; a literal colour there silently gives dark-mode users a white modal. Its `localization` block also overrides Clerk's titles, because the **Clerk dashboard application is still named "Formspan dev"** and composes titles from it — Clerk's server-side emails still say Formspan until that's renamed. `/dashboard(.*)` is server-side gated by `proxy.ts` (Clerk middleware `auth.protect()`); `app/dashboard/` holds the sidebar shell (`layout.tsx`) + destinations (only `Dashboard` wired so far, matching the mobile shell's single-tab scope). Root `/` is the public entry — redirects signed-in users to `/dashboard`, shows sign-in otherwise. Tailwind CSS v4 for styling.
- `apps/mobile/` — Expo (managed workflow, Expo Go — not a custom dev client yet) + Expo Router (file-based, `app/(tabs)/` for the tab navigator). **Clerk auth** (same instance as web/admin) via `@clerk/clerk-expo`, session token cached in the OS keychain (`lib/tokenCache.ts` → `expo-secure-store`, not AsyncStorage). `app/_layout.tsx` routes signed-out users to `app/sign-in.tsx`, which handles email+password plus a second factor (TOTP / SMS / **email code** / backup code — this Clerk instance uses email codes). `app/sign-up.tsx` is the account-creation path (email+password → emailed code → `setActive`) and `app/forgot-password.tsx` the reset path (emailed code → new password → `setActive`); all three link to each other and hand the typed address across as an `email` route param. **The layout's signed-out guard is keyed on the `AUTH_ROUTES` array, not on one route** — keyed on one route it replaces every other path with `/sign-in`, which silently makes any second auth screen unreachable. **Every new auth screen must be added to `AUTH_ROUTES` or it renders for one frame and vanishes.** Shared auth plumbing lives in `lib/clerkErrors.ts` (routes a Clerk error to the field its `meta.paramName` names; a failure with no `errors` array is form-level, never blamed on an input) and `lib/secondFactor.ts` (picks and prepares the 2FA factor — sign-in and password reset both land there). Note `forgot-password` sets the new password *before* reporting `needs_second_factor`, so on a 2FA account the password is already live while the user is not yet signed in; the copy has to say so. No OAuth yet. **Offline-first activity logging**: `lib/db.ts` (expo-sqlite) writes locally first with a `synced` outbox flag; `lib/activities.ts` pushes pending rows to `POST /v1/activities`. The activity ID is generated *client-side*, which is what makes sync retries idempotent — see the backend's `ON CONFLICT DO NOTHING`. `EXPO_PUBLIC_*` env var convention (RN equivalent of Next's `NEXT_PUBLIC_*`).
- `apps/admin/` — Next.js admin console, fully separate from `apps/web` (not athlete-facing). Reuses the **same Clerk instance** as `apps/web`; `/users(.*)` is gated two ways — `proxy.ts` requires sign-in, `app/users/layout.tsx` additionally checks the signed-in Clerk user ID against the `ADMIN_USER_IDS` allowlist env var (**same var name and value the backend uses** — one admin-identity convention across the stack; the backend's own `RequireAdmin` is the real security boundary, this gate is defence in depth for the UI). Only `User Lookup` (`/users`) and `User Detail` (`/users/[id]`) exist so far, matching what's actually been designed. **Runs on real backend data** — `lib/api.ts` server-fetches `/v1/admin/users` and `/v1/admin/users/{userID}/activities`; there is no mock data anywhere in this app. Fields the design mocked up but that have no real system behind them yet (subscriptions, device/platform, integration sync, support tickets) are simply **not shown** rather than faked. Visual design (colors, Barlow/Barlow Condensed fonts, component styles) comes from a shared hi-fi design file — tokens live in `app/globals.css`'s `@theme` block. **Note:** `apps/web`'s current visual style predates this design system and does not yet follow it — reconciling that is a separate, not-yet-started piece of work.
- `apps/mobile/lib/__tests__/` — jest (`jest-expo` preset). `support/sqlite.ts` gives tests a **real** database: `expo-sqlite` can't run here (jest-expo stubs the native module), so it is a thin async shim over Node's built-in `node:sqlite` — same engine, no new dependency — and `migratedFixture()` runs the app's own `migrate()`, so the schema under test is the schema that ships. **Anything about SQL behaviour belongs in a fixture test, never a regex over the query string**: a text assertion proves a clause is present, not that SQLite honours it, and an array mock can silently *supply* the behaviour under test. Both mistakes shipped here before the fixture existed. The rest is pure-logic coverage: the set transforms, the Clerk token broker, the sync orchestrator. Deliberately not component tests — what breaks in this app is concurrency and state reconciliation, not rendering. **Every assertion here should fail when the code it covers is deleted**; the suite was started because two throwaway harness tests passed for the wrong reason (a 300s token that never reached the offline path, and a backoff ladder already at 300s so a 5s wait proved nothing). Run `pnpm run test:mobile`; when adding a test, mutate the guard it covers and check it goes red.
- `tests/functional/` — Playwright functional test suite (user-authored, in progress — evolving, don't assume its current shape without checking).
- `docs/testing/functional-scenarios.md` — recommended functional test scenarios per feature, meant to be translated into `tests/functional/` (or mobile's equivalent). A living doc, not `tests/functional/` itself — safe to update even when the test suite's own shape is uncertain.
- `contracts/public.openapi.yaml` — hand-maintained OpenAPI spec (not generated).
- `railway/*.toml` — per-service Railway config. **Only exists for services with real code behind them** — don't create a config for a service that has no binary/app yet.
- `docs/architecture/` — current-state docs (deployment, API conventions). `docs/decisions/history.md` — the project narrative.
- `assets/brand/` — the VOLA brand kit, and the **source of truth** for brand identity: logos, app-icon and splash masters, 25 UI icons, and `design-tokens.json`. All SVG — the rasters in `apps/mobile/assets/images/` are *generated* from these, so edit the SVG and regenerate, never the PNG. UI icons use `currentColor`, so recolour via CSS/props rather than by forking the file.

## Which platform gets a feature (hard rule)

**An in-progress session is a phone thing. The web app is for planning and analysis.**

- **Mobile** owns live logging: recording sets mid-workout, the rest timer, swapping an exercise because the rack is taken. These are done standing up, one-handed, with 20 seconds between sets.
- **Web** owns authoring and review: building templates (two-pane, catalog always visible), reading history back, and the analytical surface. It can also start, review and correct a session — those are desk activities — but it does **not** get in-workout affordances. A rest countdown on a desktop you are not standing next to is decoration.

This was re-litigated per feature for a while; it isn't open. When adding something to the session flow, decide which of the two it is before building it, and say so in the history entry.

## Backend module pattern

Every domain module follows the shape of `internal/modules/profile/` — read it as the reference implementation before adding a new one:

- `<name>.go` — domain struct(s) + a `Repository` interface (`Get`/`Create`/`Update`/etc.)
- `postgres.go` — the Postgres-backed implementation. Domain errors (`ErrNotFound`, `ErrAlreadyExists`, `ErrInvalidInput`) get translated from Postgres constraint violations (`pgconn.PgError` codes) — never let a raw SQL error escape the repository.
- `handler.go` — HTTP handlers using `internal/platform/apihttp.WriteJSON`/`WriteError` for every response. Never hand-roll JSON writing or error shapes here.
- A migration in `backend/migrations/` (plain versioned SQL, `golang-migrate` — `NNNNNN_description.up.sql` / `.down.sql`).
- An integration test (`postgres_test.go`) gated on `TEST_DATABASE_URL`, skipping gracefully if unset. **Gotcha:** if the test needs `pool.Close()`, register it via `t.Cleanup`, not `defer` — and register it *before* any other `t.Cleanup` that still needs the pool open (`t.Cleanup` runs LIFO, strictly after all `defer`s in the function have already fired; a `defer pool.Close()` closes the pool before any `t.Cleanup` gets a chance to use it).
- Wired into `cmd/api/main.go` under `/v1`, and a matching entry in `contracts/public.openapi.yaml`.

## REST / OpenAPI conventions

Full detail: [docs/architecture/api-conventions.md](docs/architecture/api-conventions.md). The essentials:

- Every route is prefixed `/v1`.
- Every error response is `{"error": {"code": "...", "message": "..."}}` — codes are part of the contract (`invalid_input`, `unauthorized`, `not_found`, `already_exists`, `internal`); messages are not (don't pattern-match on them). Unmapped/unexpected errors log server-side and return a generic message only — **never leak raw internal error text (e.g. database errors) to the client.**
- JSON is snake_case, matching Postgres columns 1:1. Timestamps are RFC3339.
- Any new endpoint needs an entry in `contracts/public.openapi.yaml` (validate with `pnpm run lint:openapi`).

## Git / PR workflow (hard rule)

Every change goes on a feature branch — **never commit directly to `main`.** If the primary working directory has uncommitted changes that aren't yours to touch (check `git status` first), use an isolated `git worktree` branched from `origin/main` instead of disturbing them.

Before every push, run the full local check suite — **one command**:

```bash
pnpm run verify
```

It chains every check with `&&`, which is the point. Running them as separate
lines has twice let a **failing typecheck scroll past and the commit happen
anyway** — once on the test-runner PR, once on PR4a — because a newline is not
a dependency. If you run individual checks while iterating, still run `verify`
before pushing.

Deliberately not included — each is slow or needs setup, and CI covers them:

```bash
pnpm run test:api                            # needs TEST_DATABASE_URL
pnpm run build:web && pnpm run build:admin   # slow; CI runs both
docker build -f backend/Dockerfile backend   # if Docker/Colima is available
```

**If you add a check to CI, add it to `verify` too.** It already missed
`typecheck:admin` once — an admin type error passed locally and failed in CI,
which is the same "failing typecheck scrolled past" it exists to prevent, just
relocated to a third app. And note `fmt:api` has to *test* gofmt's output:
`gofmt -l` prints offenders and still exits 0, so as the chain's first link it
could never fail.

Then: `git push -u origin <branch>`, `gh pr create`, watch CI with `gh run watch <run-id> --exit-status`.

**Never merge a PR without the user's explicit go-ahead, even if CI is green.** This has been the rule for every PR in this project — don't treat a passing CI run as implicit merge permission.

## Keep the history log current (hard rule)

[docs/decisions/history.md](docs/decisions/history.md) is a living document, not a one-time snapshot. Whenever a PR lands (or right before merging one) that represents a material decision or a notable chunk of work — a new module, a new convention, an infrastructure change, a bug found and fixed, a provider/tooling choice — **append a dated entry** to it in the same style as the existing entries: what was decided/built, why, and any open questions or gaps it leaves behind. Do this as part of finishing the work, not as an afterthought someone has to remember to ask for. Skip it only for truly trivial changes (typo fixes, formatting) that don't represent a decision anyone would need to know about later.

## Keep functional test scenarios current (hard rule)

[docs/testing/functional-scenarios.md](docs/testing/functional-scenarios.md) is a living document, same discipline as `docs/decisions/history.md`. Whenever a new module or user-facing feature lands — a new backend endpoint, a new web route/page, a new mobile screen — **add its recommended scenarios** (happy path, edge cases & errors, and auth/security where relevant) as part of finishing that work. Don't write the actual Playwright/test code yourself unless asked — `tests/functional/` is the user's own in-progress suite; this doc is the reference list they (or a future session) translate into real tests. Skip it only for changes with no user-facing or API-surface behavior (refactors, docs, CI tweaks).

## Review before every PR (hard rule)

**Run `/pre-merge` before opening or updating any PR.** It is one gate that
runs both the CI-equivalent check suite *and* the review subagents in
`.claude/agents/`:

- **`backend-reviewer`** — for `backend/**` or `contracts/**`. Security
  (authorization gaps/IDOR, information disclosure, secrets/PII in logs),
  correctness, performance (N+1s, missing indexes, unbounded lists), and
  adherence to the module pattern above.
- **`frontend-reviewer`** — for `apps/**`. Security (server/client boundary
  leaks, client-only authorization), correctness (Server vs Client
  Components, `useEffect` deps, error states), performance, accessibility,
  and design-token/convention adherence.

Both are **read-only diagnostics** — they report, they don't fix. Resolve or
explicitly justify every `[blocking]` finding *before* opening the PR;
`[suggestion]` items are judgment calls.

**Why one command and not two rules:** it used to be two, and the check
suite got run while the reviewers got skipped — repeatedly, over several
PRs — because running the checks feels like having verified the change. It
isn't. The checks prove it compiles. The reviewers are what caught the
cross-user ID-enumeration bug (twice, in two modules) and the `completed`
flag that was written but never read back, which zeroed every session's
volume and would have erased real data through the mobile sync cycle. All
of those had a green check suite.

Give the reviewers the design intent along with the diff — they find far
more when they know which properties are load-bearing.

## Keep the README current (hard rule)

[README.md](README.md) is the first thing anyone (human or AI) sees — it drifted stale once already (still described a two-app, four-endpoint repo well after `apps/mobile`/`apps/admin` and several backend modules existed) because, unlike the two rules above, nothing required it to be updated. Whenever a new app, a new top-level backend route, or a new "how do I run this locally" step lands, **update README.md's "Current state" and "Run it locally" sections** as part of finishing that work. It should always be accurate enough that "how do I start X" never needs to be answered from outside it.

## Local dev setup

```bash
docker compose up -d                       # local Postgres on :5432 (Colima-backed Docker, not Docker Desktop)
cd backend && go run ./cmd/migrate up
cd backend && go run ./cmd/seed             # reference content (exercise catalog) — idempotent, safe to re-run
pnpm run dev:api                            # :8080
pnpm run dev:web                            # :3000
pnpm run dev:mobile                          # Expo — Metro on :8081, press i/a/w for iOS Sim/Android/web
pnpm run dev:admin                          # :3001 (or next available port — runs alongside apps/web)
```

**Backend tests run with `-p 1`** (`test:api` and CI both). `go test ./...`
runs packages in PARALLEL against ONE shared database, and several tests assert
global counts — `SELECT count(*) FROM techniques` and friends. The moment a
second package's fixtures seed library rows, those counts include them:
measured 3 failures in 6 concurrent runs. Scoping each assertion was tried and
abandoned — there are seven in one file alone, and every future one would have
to remember. If you add a test that seeds shared reference data, `-p 1` is what
is keeping it from breaking somebody else's package.

The backend integration tests need `TEST_DATABASE_URL` and **skip silently without it** — for a long stretch that meant a green local `go test ./...` proved nothing and they only genuinely ran in CI. Point it at a separate database from `DATABASE_URL`:

```bash
docker compose exec postgres createdb -U vola vola_test
cd backend && DATABASE_URL='postgres://vola:vola_dev_only@localhost:5432/vola_test?sslmode=disable' go run ./cmd/migrate up
```

Env vars come from real files, never baked into images: `backend/.env` / `backend/.env.example`, `apps/web/.env.local` / `apps/web/.env.example`, `apps/mobile/.env.local` / `apps/mobile/.env.example`, `apps/admin/.env.local` / `apps/admin/.env.example` — all gitignored except the `.example` templates. `backend/.env.staging.local` holds real Railway `staging` Postgres credentials (gitignored, never commit).

The backend's CORS (`withCORS` in `cmd/api/main.go`) allows multiple comma-separated origins via `WEB_ORIGIN` (not just one) — needed once the Expo web preview (`:8081`) joined `apps/web` (`:3000`) as a second browser-based local client. Only matters for browser clients; native iOS/Android requests aren't subject to CORS at all.

## Known gotchas

- **`secrets.txt`** may show up untracked in the repo root containing what looks like a live API key. Never stage or commit it — flag it to the user instead.
- This Next.js version renamed the `middleware.ts` file convention to `proxy.ts` (same `clerkMiddleware()` export, just a renamed file). Separately: `next dev --hostname 127.0.0.1` breaks when a `proxy.ts`/`clerkMiddleware()` is present — Next's Proxy runtime tries to self-fetch via `localhost` internally and fails (`ECONNRESET`, surfaces as a 500). Use `--port` alone when running concurrent dev instances; never pass `--hostname`.
- pnpm blocks native build scripts (`sharp`, `unrs-resolver`, etc.) by default — they need explicit `allowBuilds: true` entries in `pnpm-workspace.yaml` or installs fail.
- Railway: the real project is **still named `formspan`** — the VOLA rename covered the repo and code, not the external service accounts (Railway, Clerk). Don't "correct" it in docs until it's actually renamed in the Railway dashboard. It has a `staging` environment holding a real Postgres (migrations already applied there). No `production` Postgres yet. The `api` service is deployed to `staging` and live; `web`/`admin` are in progress. Note that Nixpacks-built services (`web`, `admin`) need `NIXPACKS_INSTALL_CMD` set to bypass corepack — see `railway/web.toml`. An **unrelated pre-existing project, `dynamic-trust`** (service `medical-portal-api`), sits in the same Railway account — it is not ours; never touch it.
- **You cannot verify a mobile screen through Expo web.** `pnpm run dev:mobile --web` fails to bundle *any* route: `expo-sqlite`'s web build imports `./wa-sqlite/wa-sqlite.wasm`, which isn't present in the pnpm store, and Expo Router's `require.context` pulls every route into one bundle — so `app/(tabs)/library.tsx` → `lib/sessionStore.ts` → `lib/db.ts` breaks the build for an unrelated screen like `sign-up`. Not fixable by touching the screen you're working on. Verify on the Simulator or a real device instead, and don't spend time diagnosing the bundle error as if it were caused by your change. The working route: boot a simulator (`xcrun simctl boot <udid>`), run `pnpm --dir apps/mobile run ios` — Expo CLI installs a matching Expo Go itself, so the App Store's SDK-54 pin is irrelevant here — then deep-link individual routes with `exp://127.0.0.1:8081/--/<route>`. Note the web bundler still runs and still fails in the logs; ignore it, the iOS bundle is separate.
- **`expo run:ios --device` has two traps that both look like your code is broken.** (1) **CocoaPods crashes with `Unicode Normalization not appropriate for ASCII-8BIT (Encoding::CompatibilityError)` when `LANG` is unset** — it is a Ruby locale bug in `pod install`, nothing to do with the project. Prefix the command with `LANG=en_US.UTF-8 LC_ALL=en_US.UTF-8`. (2) **`xcrun devicectl list devices` and `xcrun xctrace list devices` disagree about the same phone in two different ways.** They report different *identifiers* — Expo matches the *xctrace* one, so passing the `devicectl` UUID gives `CommandError: No device UDID or name matching "..."` even though the device is plainly connected; get the UDID from `xcrun xctrace list devices` (the `00008110-...` form). They also disagree about *reachability*, and **neither tool's listing is a readiness check**: `xctrace` files a perfectly usable wired phone under `== Devices Offline ==` (a build against it succeeds anyway, so do not treat that section as a blocker), while `devicectl list devices` shows an **unplugged** phone as `available (paired)` because it counts the Wi-Fi pairing. The signals that actually mean "ready to build" are `xcrun devicectl device info details --device <UUID>` reporting `tunnelState: connected` + `transportType: wired`, and `ioreg -p IOUSB -w0 | grep -i iphone` finding the device on the bus. Get this wrong and `expo run:ios` does not error — it hangs silently, no output, no `xcodebuild` process, indefinitely.
- **Expo Go upgrading *itself* is the other half of that trap, and it looks nothing like a version problem.** `pnpm --dir apps/mobile run ios` offers to install the Expo Go it considers recommended and then does, mid-launch. If the JS dependencies have drifted below what that build ships (`npx expo install --check` currently reports six, including `react-native-worklets@0.10.0` against an expected `0.10.1`), the app **segfaults on launch with no JS error and no red box** — it bundles fine, Metro logs a clean `iOS Bundled`, and the Simulator drops straight back to the home screen. Diagnose from `~/Library/Logs/DiagnosticReports/Expo Go-*.ips`: `EXC_BAD_ACCESS` with `worklets::JSIWorkletsModuleProxy` near the top of the faulting thread, and a fault address like `0x3ff0000000000008` (a NaN-boxed double being dereferenced as a pointer — a JSI ABI mismatch, not your code). Every previously-downloaded build is cached, so the quick fix is to put the matching one back:

  ```bash
  xcrun simctl uninstall <udid> host.exp.Exponent && xcrun simctl install <udid> ~/.expo/ios-simulator-app-cache/Expo-Go-57.0.5.tar.app
  ```

  The durable fix is `npx expo install --fix`, which bumps the JS side to match — but that moves `react-native` too, so it is a deliberate change, not a reflex. **Before assuming a launch crash is yours, reproduce it on a clean tree** (`git stash`); this one predated the work in progress and reproduced identically without it.
- **Never build the mobile app from a `git worktree`.** `EXPO_PUBLIC_*` vars are inlined into the JS bundle **at build time**, and `apps/mobile/.env.local` is gitignored — so a worktree never has one, and the build succeeds, installs, and launches into "EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY is not set, copy .env.example". Nothing in the build output warns, because a missing `EXPO_PUBLIC_*` is not an error to Metro; it is an empty string. This bites *specifically* in the worktree flow this file mandates for code changes, which is why it looks like a regression in the app rather than a build-environment problem. Either build from the primary checkout, or `cp apps/mobile/.env.local <worktree>/apps/mobile/.env.local` first (it stays gitignored in both, so it cannot be committed). And note a rebuild reuses a cached bundle — delete `main.jsbundle` from the DerivedData product, or the second build ships the same keyless bundle as the first.
- **A Debug device build has no JS in it.** `expo run:ios --device` defaults to Debug, which fetches the bundle from Metro at launch — so the app dies on open the moment your Mac stops serving it, which looks exactly like a crash in the app. Check with `ls <product>/VOLA.app/main.jsbundle`: absent means Debug. Pass `--configuration Release` for anything the user will actually carry around. Release-signed-with-a-development-certificate still expires in ~7 days.
- **A stale Expo Go on the Simulator fails as `Cannot find native module 'ExpoAsset'`** (or any other Expo native module) at *runtime module load*, before a line of your code evaluates — so it looks like your change broke the app. It is a version mismatch: the installed Expo Go's native binary predates the project's SDK. `--clear` does not fix it, because the cache is not the problem. Fix by removing Expo Go and letting the CLI reinstall a matching build: `xcrun simctl uninstall <udid> host.exp.Exponent`, then `pnpm --dir apps/mobile run ios`, which prints "Installing Expo Go on …". Diagnose by comparing `xcrun simctl listapps <udid>` (look for `host.exp.Exponent`'s version) against `expo` in `apps/mobile/package.json`. **Do not go looking for a missing dependency:** pnpm hoists to the *workspace root* `node_modules/.pnpm`, not `apps/mobile/node_modules/.pnpm`, so checking the app directory makes every transitive package look absent. That wrong turn cost real time once.
- **OAuth cannot work under Expo Go.** Clerk's `startSSOFlow` redirects back through the app's own scheme (`vola://`, set in `app.json`), and Expo Go registers `exp://` — it cannot hand a callback to a project it is merely hosting. Google sign-in therefore only works in a real build (`expo run:ios --device`), which is also the only way to verify it.
- **Clerk returns `null` offline — it does not throw, and it does not sign you out.** Verified in the installed clerk-js: `_baseFetch` logs "Network request failed while offline, returning null" and returns null unless the experimental `rethrowOfflineNetworkErrors` option is on (it is off by default). Separately, `_updateClient(e){if(!e)return;…}` means a null response leaves the cached client intact, so **`isSignedIn` stays true offline** and the `AUTH_ROUTES` guard in `app/_layout.tsx` correctly does not redirect. The consequence that bit us: nine modules read that null as `throw new Error('Not signed in.')`, so a gym dead-spot made every screen simultaneously tell a signed-in athlete to sign in. **All Clerk token access now goes through `lib/session.ts`** — the only module allowed to call Clerk — which caches against the token's own `exp`, collapses concurrent refreshes, keeps serving a still-valid token when Clerk is unreachable, and throws `OfflineError` rather than ever claiming signed-out. Do not reintroduce a direct `getToken()` call; `useAuthToken()` returns a `TokenGetter` typed `Promise<string>` precisely so the null reading cannot come back. Clerk's default session token lives ~60s; set `EXPO_PUBLIC_CLERK_JWT_TEMPLATE` to a Clerk JWT template to lengthen that (no backend change — the API checks signature/issuer/exp/`sub` only).
- **Metro/Expo Go IPv6 vs IPv4 loopback mismatch**: Node resolves the hostname `localhost` to IPv6 first by default, so a plain `expo start` binds Metro only to `::1:8081`. But Expo's `--localhost` flag generates the Expo Go deep link using the literal IPv4 address `127.0.0.1`, so Expo Go can never connect — a total, silent mismatch, not a firewall/network issue. Fixed by prefixing `NODE_OPTIONS=--dns-result-order=ipv4first` on every `apps/mobile/package.json` script (`start`/`android`/`ios`/`web`), forcing Metro to bind IPv4 first. Diagnose with `lsof -i :8081 -P -n` — look for `127.0.0.1:8081` vs `[::1]:8081`.

## Where to look for more

- [docs/decisions/history.md](docs/decisions/history.md) — full chronological narrative
- [docs/architecture/deployment.md](docs/architecture/deployment.md) — environments, Railway topology, migrations
- [docs/architecture/api-conventions.md](docs/architecture/api-conventions.md) — full REST/OpenAPI conventions
- [contracts/public.openapi.yaml](contracts/public.openapi.yaml) — the wire contract
- [docs/testing/functional-scenarios.md](docs/testing/functional-scenarios.md) — recommended functional test scenarios per feature
