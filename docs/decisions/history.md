# Project history & decision log

This is a chronological narrative of what Formspan is, why it exists, and every material decision and action taken so far — meant to let another human (or another AI session with no prior context) get oriented quickly. It complements, not replaces: `docs/architecture/*.md` hold the durable current-state architecture; this file holds the story of how we got there and why particular alternatives were rejected.

Keep entries dated and in order. When a later decision supersedes an earlier one, don't rewrite history — add a new entry and note what changed.

---

## 2026-07-24 — Phase 1: Product definition

**What Formspan is:** a unified training and nutrition platform for BJJ athletes who also strength train and track nutrition. One athlete profile and calendar connecting BJJ, strength training, and nutrition, with the core differentiator being cross-sport intelligence — e.g. flagging a heavy leg day scheduled the day before hard sparring — driven by deterministic, versioned rules rather than opaque AI output.

**Target user (MVP):** trains BJJ regularly, also lifts, tracks or wants to track calories/macros/weight, wants real progress analysis (not streaks/badges), values explainable recommendations. Explicitly not the initial target: pure runners, casual single-pillar users, anyone expecting a social feed or coach marketplace on day one.

**Core product principles set at this stage:**
- **Modular and dynamic** — users toggle BJJ/strength/nutrition/running/social/etc. on or off per module; disabling hides UI and recommendations but never deletes history.
- **Unified data model** — every sport shares one "activity envelope" (user, sport, times, source, planned-session ref, perceived effort, notes, device samples, sport-specific details), which is what lets one calendar/recommendation engine reason across sports.
- **Evidence-based intelligence before AI** — recommendations come from deterministic, versioned rules (inputs, rule version, evidence, confidence, explanation, safety constraints all stored), not free-form generation. AI's role is limited to wording/summarizing, not deciding.
- **Privacy by default** — health/weight/nutrition/photos/location private by default; granular sharing, export, deletion, consent records, audit logs, PII-safe logs required.

**MVP scope frozen (detailed, pending final freeze confirmation):** account/profile with module toggles, unified calendar with a small rule-based conflict-detection set (not a general solver), strength logging + PR detection (no auto-generated programs yet), BJJ session logging + a global technique library (moved in from originally-deferred), nutrition/body tracking, a concrete v1 deterministic recommendation-rule set (training load, recovery status, strength progression/deload, nutrition adjustment, BJJ competition taper — every rule with an explicit safety floor), HealthKit/Health Connect import, admin console, subscriptions, data export/deletion. Explicitly deferred: social feed, full sport library beyond BJJ/strength, coach marketplace, open-ended AI coaching, barcode/food-database, auto-generated programs, BJJ proficiency scoring/game-plan builder, achievements.

**8 user journeys defined (J1–J8):** onboarding, daily core loop, strength logging (offline-capable), BJJ session logging, nutrition/body logging, cross-sport conflict detection (the differentiator), weekly review, and admin support diagnosis.

**Navigation IA set:** mobile 5-tab (Today/Plan/Log/Progress/Profile) with sports as modules inside destinations, not their own tabs; web sidebar (Calendar/Strength/BJJ/Nutrition/Insights/Account) for planning and deep analysis; a fully separate admin console app.

**Technical architecture direction (decided):** Go backend as a modular monolith (not microservices) — `cmd/{api,admin-api,worker,scheduler,migrate}` entrypoints, `internal/modules/*` per domain, `internal/platform/*` for cross-cutting concerns (auth, db, logging, etc.). React Native + Expo for mobile, Next.js for web/admin. Offline-first mobile sync via local SQLite + mutation outbox + idempotency keys + incremental server cursors. Managed infra over self-hosted; avoid Kubernetes/service mesh at this stage. Target: support ~10,000 MAU without a rewrite.

**Railway deployment proposed — explicitly flagged as a recommendation, not a decision.** Single monorepo, one Railway project with `staging`+`production` environments, 6 services (`web`, `api`, `admin-web`, `admin-api`, `worker`, `scheduler`) plus managed Postgres/Redis/buckets. Migrations meant to run exactly once, as the `api` service's pre-deploy command, never independently from `worker`/`admin-api`. Portability principle set: avoid Railway-specific APIs, prefer standard Docker/Postgres/OIDC/OpenAPI/OpenTelemetry so a future migration off Railway stays cheap. Recommendation: launch and grow on Railway, reconsider only when a concrete constraint (cost, compliance, scale) appears — don't pre-build migration infrastructure.

**Collaboration style established:** act as product architect/technical partner, not just an executor — keep the full vision in mind, separate MVP from later, challenge unnecessary complexity, make recommendations auditable.

---

## 2026-07-28 — Phase 2: Foundation

The user asked to work through the Phase 2 foundation checklist (monorepo/CI, environments, managed auth, user/profile module, Postgres migrations, REST/OpenAPI conventions, RN shell, Next.js web/admin shell, structured logs, feature flags, admin lookup) **one small, verified increment at a time** rather than attempting it all at once — this became the standing working pattern for the rest of the project.

### Increment 1 — Hello-world vertical slice

Plan-mode session to scope the smallest possible slice: a Go API with one `/healthz` endpoint, and a Next.js page that fetches it and displays the result — nothing else (no DB, no auth, no CI yet). Established:
- Repo `github.com/dmytro-ch21/formspan` (pnpm + Go monorepo), git initialized on `main`.
- pnpm enabled via corepack; `backend/` as its own Go module (`github.com/dmytro-ch21/formspan/backend`), matching the planned `cmd/api` entrypoint shape.
- `apps/web` scaffolded via `create-next-app`. Caught and fixed: its own generated `pnpm-workspace.yaml`/lockfile would have made it a second, conflicting workspace root — removed, made it a proper member of the single root workspace.
- CORS had to be added to the Go API (`withCORS` middleware) — the browser blocked the initial cross-origin fetch entirely without it.
- Verified end-to-end via the Browser tool: page rendered the API's live response.
- Committed and pushed directly to `main` (no PR yet — that convention came later, see below).

### Increment 2 — CI

GitHub Actions workflow: backend job (`gofmt`, `go vet`, `go build`, `go test`, plus a `docker build` of the Dockerfile — added specifically because Docker wasn't available in the local dev sandbox at the time, so CI was the only way to verify the Dockerfile actually built), web job (`eslint`, `tsc --noEmit`, `next build`). Root `package.json` scripts mirror every CI check so the same commands work locally. Bugs caught and fixed along the way: Next.js was mis-detecting the monorepo root because of an unrelated `yarn.lock` sitting outside the repo (pinned `turbopack.root` explicitly); `go build ./...` was leaving a stray binary in the repo (switched to `-o bin/`, already gitignored); GitHub flagged `actions/checkout@v4` etc. for a deprecated Node 20 runtime (bumped to current majors).

### Increment 3 — Development, staging, production environment prep

Explicitly scoped as **prep only** — repo-side configuration, no real Railway project created yet (a deliberate, confirmed choice at the time). Built: `backend/Dockerfile` (multi-stage; `go build -o /app/bin/ ./cmd/...` picks up every `cmd/*` binary automatically, so it won't need edits as `admin-api`/`worker`/`scheduler` get added later), `railway/api.toml` + `railway/web.toml` (only for the two services that actually have code — no configs created for services with no binary behind them yet, a pattern kept throughout), `.env.example` per app documenting vars per environment tier, `docs/architecture/deployment.md` written into the repo as the living built-vs-planned status (not just kept in the assistant's memory). CI gained a real `docker build` step of the Dockerfile once Docker access mattered.

### Increment 4 — Managed authentication (PR #1)

Provider decision: **Clerk**, chosen over Auth0 and Supabase Auth after a pricing comparison (all three are free well past the ~10k MAU target, so cost wasn't the differentiator) — Clerk won on SDK fit for Expo/React Native + Next.js specifically, and because its JWTs can be verified in Go via standard JWKS without a Clerk-specific backend SDK.

- Backend: `internal/platform/auth` — hand-rolled JWKS verification (`golang-jwt/jwt` + `MicahParks/keyfunc`), deliberately not the Clerk Go SDK, keeping the verification layer swappable if the auth provider ever changes (matches the Railway-era portability principle). `RequireAuth` middleware; new `GET /me` returning the verified `user_id`. Documented, accepted gap: no `azp` (authorized party) claim check yet — fine with one frontend origin, would matter with more.
- Web: `ClerkProvider`, sign-in/sign-up, home page shows signed-in state and calls `/me`.
- Verified end-to-end in a real browser using Clerk's test-mode email pattern (`+clerk_test@`, fixed OTP `424242`) — no real email delivery needed.
- Along the way: Next.js in this version renamed the `middleware.ts` file convention to `proxy.ts` (Clerk's `clerkMiddleware()` export itself was unaffected) — file renamed to match.
- Merged 2026-07-28T18:42:35Z... (see PR #1, merged before PR #2).

### Increment 5 — User/profile module (PR #2)

First real database in the project.

- Local Postgres required real Docker, which wasn't installed. Docker Desktop needs a manual GUI setup step that can't be automated from a terminal, so installed **Colima** instead (CLI-only container runtime, identical `docker`/`docker compose` commands, no GUI). `docker-compose.yml` at repo root for local dev Postgres.
- Migrations: `golang-migrate`, plain versioned SQL in `backend/migrations/`, `cmd/migrate` entrypoint. First migration: `profiles` table — `user_id` (the Clerk `sub`, no separate internal ID) as primary key, basic bio fields (`display_name`, `date_of_birth`, `sex`) for calorie/1RM calculations, and the four module-toggle booleans matching the J1 onboarding defaults (BJJ/strength/nutrition on, running off).
- `internal/modules/profile`: domain + Postgres repository + HTTP handlers. `GET/POST/PATCH /profile`, behind the Clerk auth middleware, keyed off the verified `user_id`. Postgres constraint violations (duplicate create, invalid `sex`) mapped to 409/400 rather than leaking as 500s.
- Scope boundary set deliberately: BJJ-specific profile data (belt, stripes, promotions) stays out of this table for the future `bjj` module; goal setting is a separate future `goals` module.
- CI: added a Postgres service container to the backend job, migrations run before tests, a real repository integration test added.
- `railway/api.toml` got a real `preDeployCommand = "/app/bin/migrate up"` now that a migrate binary actually exists (still config-only at the time — no real Railway service existed yet).
- Bug caught and fixed post-merge: `pnpm run dev:api` never actually loaded `backend/.env` — it only "worked" during development because env vars had been exported by hand first. Fixed to `set -a && . ./.env && set +a` before `go run`.
- Merged into `main` (PR #2, 2026-07-28T18:42:35Z).

### Standing workflow change — feature branches + PRs

After PR #1 and the early increments (which were committed straight to `main`), the user asked to switch to a feature-branch + PR workflow going forward. Adopted for every increment since: branch off `main`, commit, push, `gh pr create`, watch CI, wait for explicit go-ahead before merging.

### Functional test suite (user-led, in progress)

The user began writing their own Playwright-based functional test suite (`tests/functional/`) covering both the API and the web app — a genuinely well-engineered harness: a mock JWKS issuer (self-signed RSA key, serves `/.well-known/jwks.json` and a `/token?sub=&expires_in=` endpoint for minting test tokens without needing real Clerk network calls), two API instances (one against the mock issuer, one against real Clerk), two web instances (one healthy, one pointed at a dead API port to test the error state), an isolated docker-compose Postgres, and full teardown handling.

**Bug found and root-caused (fix proposed, not yet applied — it's the user's in-progress file):** `next dev --hostname 127.0.0.1` breaks when a `proxy.ts` (the Clerk middleware) is present — Next's Proxy runtime tries to self-fetch the request via `http://localhost:<port>` internally, that self-fetch fails (`ECONNRESET`/socket hang up), and it surfaces as a 500 to the real client. Reproduced in complete isolation, unrelated to the "dead API" test scenario itself. `next dev --port X` alone (no `--hostname`) works fine, and `127.0.0.1:<port>` is still reachable without the flag. This affects both web instances in `start-stack.mjs` (both pass `--hostname 127.0.0.1`), which is why the whole stack was tearing down before any Playwright test could run. Also found and fixed in passing: orphaned child processes from a torn-down run that never actually got killed, left holding ports open.

### Increment 6 — REST and OpenAPI conventions (PR #4, merged)

Decision: add a `/v1` version prefix to all routes now, while it's cheap (before mobile/admin clients exist), rather than retrofitting later. Built: a shared `internal/platform/apihttp` package (`WriteJSON`, `WriteError`) standardizing the error response shape to `{"error": {"code": "...", "message": "..."}}` with a fixed, documented set of codes (`invalid_input`, `unauthorized`, `not_found`, `already_exists`, `internal`) — replacing the previous ad-hoc flat `{"error": "message"}` shape, and fixing an information-disclosure gap where unmapped errors were leaking raw internal error text (e.g. database errors) directly to clients; unmapped errors now log server-side and return a generic message only. `contracts/public.openapi.yaml` authored by hand (the backend deliberately stays on stdlib `net/http` rather than a framework with reflection-based spec generation, so the spec isn't auto-generated), linted in CI via `@redocly/cli`. `docs/architecture/api-conventions.md` written as the durable source of truth for these conventions. Work happened in an isolated git worktree so as not to disturb the user's uncommitted functional-test-suite work in the primary working directory.

Bug found and fixed while re-verifying: `profile/postgres_test.go`'s `t.Cleanup` delete was silently failing every run because a `defer pool.Close()` in the same test function closed the pool before `t.Cleanup` ran (defers fire on function return, before `t.Cleanup` teardown) — invisible in CI (fresh DB per run), but leaked a row on every local run against the same long-lived dev Postgres. Fixed by moving `pool.Close()` into a `t.Cleanup` registered before the delete cleanup. Verified by forcing a real re-run (`-count=1`, bypassing Go's test cache) and confirming the row was actually gone afterward.

Also decided not to keep chasing a flaky browser-automation session for one specific manual check (`/v1/me` with a real token) — the identical code path (`verifier.RequireAuth` + a two-line unchanged handler) was already proven correct via `/v1/profile`'s GET with a real token, so this was noted as a documented gap in the PR rather than a blocker.

### Real Railway infrastructure provisioned

The user's Railway trial had expired, blocking project creation — this needed the user to select a paid plan themselves (a billing decision, not something to push through automatically). Once done:
- Created the `formspan` Railway project.
- Found and deliberately left untouched an unrelated pre-existing project in the same account, `dynamic-trust` (service `medical-portal-api`, an `sqlite-data` volume) — not ours, not touched.
- Created a `staging` environment and added a real Postgres service to it.
- Ran `backend/cmd/migrate up` against it via the public proxy connection string — the `profiles` table now exists on real Railway infrastructure, not just locally.
- Credentials stored in `backend/.env.staging.local` (gitignored, never commit) — `DATABASE_URL_PUBLIC` (reachable from anywhere, via Railway's TCP proxy) and `DATABASE_URL_INTERNAL` (only resolves from inside Railway's network, for when the `api` service itself is deployed there).
- Explicit scope: this one Postgres instance is shared for dev + staging + testing purposes for now — no separate production database exists yet, and no application services (`api`, `web`) have been created on Railway yet, only Postgres.

### This history log itself (PR #3, merged) and the CLAUDE.md/agent/skill setup (this entry)

`docs/decisions/history.md` (this file) was added in its own PR (#3) alongside a refreshed `README.md` — meta, but worth recording: it was written specifically so another human or AI session could get oriented without re-deriving context from git log plus the assistant's private memory.

Follow-up gap the user caught immediately: the log was written as a one-time snapshot with no standing rule to keep it updated. Fixed by adding a hard rule to `CLAUDE.md` (see below) — append a dated entry here after any material decision or notable chunk of work, as part of finishing that work, not as an afterthought.

Also built: root `CLAUDE.md` (auto-loaded for any Claude Code session in this repo — repo map, the backend module pattern, REST/OpenAPI conventions pointer, the git/PR workflow hard rules, local dev setup, and the known-gotchas list below, condensed from everything learned so far) plus two custom subagents/skills for the two workflows that have actually repeated: `.claude/agents/backend-module-scaffolder.md` + `/new-module` (scaffold a new `internal/modules/<name>` following the `profile` module's exact shape) and `.claude/agents/pre-merge-checker.md` + `/pre-merge` (run the full CI-equivalent check suite and report before a push). Deliberately did not build a Railway-provisioning or functional-test-writing agent yet — those workflows haven't repeated enough times, or (functional tests) the pattern is still actively evolving in the user's own hands.

### React Native + Expo application shell

First mobile app in the project. Scaffolded `apps/mobile` via `create-expo-app` with the `tabs` template (Expo Router + a tab navigator out of the box — matches the already-decided mobile nav IA more directly than a manual `blank-typescript` setup would have). Stripped the template's demo content (a second placeholder tab, a modal screen, `EditScreenInfo`/`ExternalLink` components) down to the planned scope: one `Today` tab, one screen, fetching `/v1/healthz` and rendering the result — the mobile equivalent of the very first web/API hello-world increment.

Decisions made (flagged as recommended defaults during planning, not separately re-confirmed): **Expo Router** over React Navigation, **Expo Go** (not a custom dev client) for now — no EAS account needed, defer a dev client until a native module Expo Go doesn't support is actually needed (HealthKit, BLE, per the original brief). No auth yet; Clerk's Expo SDK is its own follow-up increment, same pattern as web auth being separate from the web hello-world.

Environment constraint hit immediately: Xcode wasn't fully installed (only Command Line Tools — `simctl` needs the full Xcode.app). The user chose to install Xcode themselves for real Simulator verification rather than settle for a lesser proxy. Scaffolding and most verification don't depend on Xcode being ready, so that work proceeded in parallel: `tsc --noEmit` clean, Metro bundler starts clean, and the Expo **web preview** (`npx expo start --web`, port `:8081`) verified in a real browser — confirmed the tab renders correctly and the healthz fetch/render logic works.

Bug found via that web-preview verification, not assumed away: the web preview is a real browser page and hit the same CORS wall the very first web hello-world did, since it runs on a different origin (`:8081`) than `apps/web` (`:3000`). Fixed by making the backend's `withCORS` support multiple comma-separated origins via `WEB_ORIGIN` (echoing back the request's `Origin` header only if it's in the allowlist, never a wildcard) instead of a single static one — this only matters for browser-based clients; native iOS/Android requests aren't subject to CORS at all, so the real Simulator/device experience was never going to hit this regardless.

Added a `mobile` CI job (typecheck only for now, matching the low-ceremony bar of this first increment) — every other app in this repo got CI coverage on its first PR, no reason mobile shouldn't too.

**Follow-up: real iOS Simulator verification (once Xcode finished installing).** After the user finished installing Xcode themselves (`xcode-select -s` and the license acceptance are both system-modifying `sudo` commands, so those were run by the user directly, not by the assistant), booted a real iPhone 15 Pro Simulator and drove Expo Go via `xcrun simctl openurl`/`terminate` (UI-tapping was tried first but abandoned — the Simulator control tool's coordinate space is device *points*, e.g. 393×852, not the screenshot's pixel dimensions, and conflating the two caused several missed taps).

Hit a second, genuinely non-obvious bug this surfaced: Expo Go could not connect to Metro at all under `--localhost` mode, failing with an honest "Could not connect to the server." Root-caused via `lsof -i :8081 -P -n`: Metro was bound only to `[::1]:8081` (IPv6), because Node resolves the hostname `localhost` to IPv6 first by default — but Expo's `--localhost` flag builds the Expo Go deep link using the literal IPv4 address `127.0.0.1`, so the two could never meet. Not a firewall issue (macOS's Application Firewall was checked and had already allowlisted the exact running Node binary). Fixed by forcing IPv4-first DNS resolution order (`NODE_OPTIONS=--dns-result-order=ipv4first`), confirmed via `lsof` that Metro then bound to `127.0.0.1:8081`, and baked the fix permanently into all four `apps/mobile/package.json` scripts (`start`/`android`/`ios`/`web`) so it's automatic rather than a manually-remembered env var. Documented in `CLAUDE.md`'s gotchas list.

With that fixed, the Simulator run succeeded end-to-end and was screenshot-confirmed: "Today" tab active, "Formspan" heading, and a live "API says: api is ok" rendered from the real backend — the same rigor (real tool-verified testing, not a proxy) used for every other piece of this project. Mobile app shell verification is now fully complete; Simulator testing is no longer a pending item.

### Next.js customer web shell

The web counterpart to the mobile shell above. `apps/web` had no real structure until now — just the original hello-world `page.tsx` (inline healthz fetch + Clerk sign-in demo) with `proxy.ts` explicitly not gating anything. Built the actual customer-facing shell per the navigation IA (web = sidebar, planning/analysis surface): a protected `/dashboard` route with a sidebar layout (`app/dashboard/layout.tsx` — wordmark, nav, `UserButton`) and one real destination, `Dashboard` (`app/dashboard/page.tsx`), which is where the old healthz + `/me` demo content moved to — same role as the mobile shell's Today tab. Root `/` is now a minimal public entry point: server-redirects signed-in users straight to `/dashboard`, shows branding + a sign-in button otherwise.

Same "smallest verified slice" discipline as the mobile shell: only `Dashboard` gets a sidebar entry — no stub pages for Calendar/Strength/BJJ/Nutrition/Insights/Account yet, mirroring mobile shipping with only its `Today` tab wired.

Decisions: **Tailwind CSS v4** added for styling (asked the user directly since, unlike Expo Router/Expo Go, this is a longer-lived choice that shapes every future web page — confirmed over plain CSS/CSS Modules). **Auth gating moved server-side**: `proxy.ts` now uses `createRouteMatcher(["/dashboard(.*)"])` + `auth.protect()`, closing the "not gating anything yet" gap called out when Clerk was first wired in — the old client-side `isLoaded`/`isSignedIn` check on the root page is gone, replaced by a server-side `auth()` check + `redirect()`, which also removes the previous flash-of-wrong-state on load.

Verified end-to-end in a real browser (not just typecheck/build): visiting `/dashboard` signed out redirects to Clerk's hosted sign-in with a `redirect_url` back to `/dashboard`; after signing in (done by the user directly — credentials are never entered on their behalf), the dashboard renders the sidebar, a live healthz check, and the authenticated `/me` call; visiting `/` while signed in redirects straight to `/dashboard`. Confirmed via `window.location.pathname` that the redirect is a real navigation, not just content substitution.

Work happened in an isolated git worktree (`feature/web-app-shell`, branched from `origin/main`) because the primary working directory had unrelated uncommitted changes (the user's own in-progress test-ID additions to the mobile Today screen) that weren't safe to disturb — same pattern used for the REST/OpenAPI conventions increment.

No backend, CI, or root `package.json` changes needed — reused the existing `/v1/healthz` and `/v1/me` endpoints as-is, and the existing `lint:web`/`typecheck:web`/`build:web` scripts plus the CI `web` job already cover the new routes without modification.

---

## Open items / known gaps as of this entry

- **`secrets.txt`** — an untracked file sitting in the repo root containing what looks like a live Anthropic API key in plaintext. Flagged to the user repeatedly; never staged or committed; not yet deleted or rotated as far as this log knows.
- Functional test suite not yet passing — blocked on applying the `--hostname` fix to `tests/functional/support/start-stack.mjs` (the user's own in-progress file — not something to edit unilaterally).
- No Railway `api` or `web` services exist yet, only Postgres — `railway/*.toml` configs are ready but unconnected.
- No production Postgres — `staging` is currently doing double duty for dev/staging/testing.
- JWT verification doesn't check the `azp` claim (fine for one frontend origin; revisit if that changes).
- Mobile app shell exists (`apps/mobile`) and is now fully Simulator-verified (screenshot-confirmed on a real iPhone 15 Pro Simulator). Still has no auth, no other tabs (Plan/Log/Progress/Profile), and no dev client (Expo Go only) — all deliberately deferred to future increments.
- Web app shell exists (`apps/web`, `/dashboard`) with only one destination (`Dashboard`) wired — Calendar/Strength/BJJ/Nutrition/Insights/Account are all still just IA on paper, no routes or stub pages yet.
- No admin console, structured logging/trace IDs, or feature flags yet — all still-untouched Phase 2 checklist items.
- The new `backend-module-scaffolder` agent and `/new-module` skill are unverified in practice — no module has been scaffolded through them yet (the `profile` module they're modeled on predates them). Worth checking they actually produce correct output the first time they're used for real (e.g. a future `goals` module).
