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

### Functional test scenarios doc + standing workflow rule

Added `docs/testing/functional-scenarios.md`: a living, per-feature list of recommended functional test scenarios (happy path, edge cases & errors, auth/security), meant to be translated into the user's own in-progress Playwright suite (`tests/functional/`) or mobile's equivalent — not test code itself, so it's safe to write even while that suite's own shape is still evolving. Backfilled scenarios for everything shipped so far: the healthz check, Clerk/JWKS auth, the profile module, and both the web and mobile app shells.

Decision: kept this under `docs/testing/` rather than inside `tests/functional/` specifically so it never risks colliding with or presuming the shape of the user's own in-progress test files — same caution `CLAUDE.md` already calls out for that directory.

Wired into the standing workflow, same pattern as the `docs/decisions/history.md` rule: a new `CLAUDE.md` hard rule says to add a feature's scenarios here as part of finishing any new module/route/screen, and the `/new-module` skill now has an explicit step for it (after the history-log entry) so it isn't only a manually-remembered convention.

### Next.js admin shell

The admin console, per the nav IA (fully separate app, not athlete-facing) — nothing admin existed until now: no `apps/admin`, no admin backend, no staff/role concept anywhere. This time the user provided a real hi-fi design (a bundled Claude-design export, shared as a local HTML file after the in-app Browser turned out to be policy-blocked from `claude.ai` and Claude in Chrome wasn't connected in this session) covering the whole product's visual system — dark mobile, light web. Only two admin screens exist in it so far, **User Detail** and **User Lookup**, matching the nav IA's first two items exactly (Jobs & Webhooks and Audit Log aren't designed yet, so out of scope here, same "build what's designed" discipline as every prior shell).

Exact design tokens were extracted directly from the rendered DOM's inline styles (the export has no semantic CSS classes) rather than approximated by eye: Barlow + Barlow Condensed (real Google Fonts), a light palette (`#F5F5F2` page / `#FFFFFF` cards / `#E4E4DF` borders / `#111312` text), a dark lime accent pill (`#111312` bg, `#E9FFA3` text) for tags and active filters, and success/danger/neutral status-badge colors. These now live as Tailwind `@theme` tokens in `apps/admin/src/app/globals.css`.

Two decisions the user made directly this session:
- **Auth**: reuse the *same* Clerk instance as `apps/web` rather than a separate app or Clerk Organizations/roles — gated by a plain `ADMIN_EMAILS` allowlist env var, checked server-side in `app/users/layout.tsx` (in addition to `proxy.ts` requiring sign-in at all). Matches "no admin team exists yet"; upgradeable to real roles later without a rewrite.
- **Data**: no backend admin API or data model exists for any of what the design shows (subscriptions, device/platform tracking, integration sync, support tickets — none of these tables/systems exist, and the real user directory lives in Clerk, not Postgres). Per the user, **"we'll work on each of those later, just remember the design decisions for now"** — this pass is the visual/interaction shell only. `lib/mock-users.ts` holds the design's own sample content as explicit, temporary static data — not fabricated filler, and clearly labeled as such in code and in `CLAUDE.md`. Only one full detail record exists (Ivan Koval, the only one designed); the other five lookup rows are genuinely clickable but land on an honest "no mock detail record for this user yet" state rather than showing his data under a different identity.

Mid-build feedback from the user: the first pass centered everything in a `max-w-5xl` column, which read as a small floating card on a wide screen rather than a real app surface. Fixed by rebuilding both screens with a full-width header bar (matching the design's own white top-bar-with-border-bottom) and full-bleed content — confirmed via direct DOM measurement (not just eyeballing a screenshot) that the rendered width matches the viewport.

Verified end-to-end in a real browser, all three auth states: signed-out `/users` redirects to Clerk's hosted sign-in; signed-in with a non-allowlisted email (temporarily pointed `ADMIN_EMAILS` at a different address, then restored it) shows a plain "Not authorized" message instead of the shell; signed-in and allowlisted renders the lookup table and, for the seeded id, the full detail view — both matching the design's layout, colors, and typography. Search and filter pills are genuinely functional client-side over the mock array, not decorative.

Wired into the workspace the same way every prior app was: root `package.json` scripts, a CI job (lint + typecheck + build, no backend needed), `railway/admin.toml`. Added this feature's scenarios to `docs/testing/functional-scenarios.md`, explicitly noting everything is against mock data for now.

### Structured logging, request IDs, and trace context

Next Phase 2 foundation item. Before this, the API had zero structured logging and no correlation IDs at all — every log call was stdlib `log.Printf`/`log.Fatal` plain text, and there was no way to trace a single request through the logs or for a client to reference "what happened on my request" when reporting a bug.

Built `backend/internal/platform/httplog`, matching the shape of the existing `apihttp`/`auth`/`database` platform packages: `log/slog` (Go 1.26 stdlib — no new dependency) with JSON output always, plus an HTTP middleware that generates/extracts a request ID and a W3C `traceparent` trace context per request, injects a request-scoped logger into context, echoes both back as response headers (`X-Request-ID`, `traceparent`), and emits one structured access-log line per request.

Decisions: **request ID** is honored from an incoming `X-Request-ID` header if present (harmless to trust — it's a correlation value, not a security control), generated fresh otherwise. **Trace ID uses the W3C `traceparent` standard** rather than a project-specific header — the one place the architecture doc explicitly names a preferred standard (OpenTelemetry) over something proprietary; parsed defensively so a malformed incoming header never fails the request, just starts a fresh trace. No frontend app generates or forwards one yet, so today every request effectively starts its own trace — the payoff is that the mechanism already speaks the real standard, so whenever a client starts threading one trace ID across several related calls, they'll correlate with zero backend changes. **No API contract change**: `apihttp.WriteError`'s signature and the `{"error":{"code","message"}}` shape stay untouched — the `X-Request-ID` response header already gives support/debugging the same correlation capability without rippling a signature change through 8+ call sites across `profile/handler.go`, `auth.go`, and `main.go`.

Also added, since structured logging made it nearly free: `auth.go`'s `RequireAuth` now logs a `WARN` line on every rejected auth attempt (missing/invalid bearer token) — a security-relevant signal that plainly didn't exist before. Scope deliberately excludes `cmd/migrate` (a one-shot CLI, not a request-serving server — request/trace IDs don't apply, its plain `log.Printf` output is fine as-is).

Verified for real, not just typecheck/build: ran the API locally and confirmed via `curl -i` that `X-Request-ID` and `traceparent` response headers are present on every response, that a custom incoming `X-Request-ID` is echoed back rather than overwritten, and that both the access-log line and the `auth: rejected` warning line for a bad-token request share the same `request_id`/`trace_id`/`span_id` — proving the context-scoped logger correlation actually works, not just compiles.

### Server-controlled feature flags

Last unstarted item from the original Phase 2 foundation checklist. Built `internal/modules/featureflag`, following the established module pattern (`internal/modules/profile/` as reference) — but scaffolded by hand rather than via the `backend-module-scaffolder` agent, since that agent's template assumes a per-user resource (`Get`/`Create`/`Update` keyed by `claims.UserID`, like `profile`) and feature flags are a global, ownerless resource; forcing it through the generic template would have fought the tool rather than used it well. This remains the first real, non-trivial test of that agent still owed — noted again below.

Decisions: **global boolean flags only** — no percentage rollout, no per-user/cohort targeting, matching this project's repeated "don't build for hypothetical future needs" discipline. **Read-only for this pass**: `GET /v1/flags` (authenticated, same as every non-`healthz` endpoint) returns the full list; there's no write endpoint and no admin-console screen for this yet. Toggling happens via direct SQL for now — a write endpoint needs a backend-side admin-authorization concept that doesn't exist at all (`apps/admin`'s `ADMIN_EMAILS` check is frontend-only; the Go API has no notion of "admin"), and building that just for one endpoint nobody calls yet was judged premature. **Response shape** is an array of full flag objects (`key`, `enabled`, `description`, `updated_at`), matching the snake_case/1:1-with-Postgres convention `/v1/profile` already established, rather than a bespoke flattened `{key: bool}` map. **Seeded via the migration itself** (`new_recommendation_engine`, `bjj_technique_video_upload`, both defaulting off) so there's something real to fetch immediately rather than an empty array. **Not wired into any frontend app** in this pass — same scoping call as structured logging.

Verified for real: ran the migration against local Postgres, ran the new integration test twice in a row (`-count=1`) per the project's standing test-cleanup caution, then ran the API locally and confirmed via `curl` that `GET /v1/flags` is `401` without a token and, with a real Clerk bearer token obtained live from a signed-in browser session (`window.Clerk.session.getToken()`), returns `200` with both seeded flags in the correct shape.

### Frontend trace propagation

Closed the gap flagged when structured logging landed: no frontend sent a `traceparent`, so every request started its own trace at the API. Added a tiny (~15-line) `lib/trace.ts` to both `apps/web` and `apps/mobile` — duplicated rather than shared, not worth a package yet — generating one trace ID per page/screen view (plain `Math.random()`-based hex, not a CSPRNG: these are log-correlation IDs, not secrets, so there's no need for `crypto.getRandomValues` or an RN polyfill) and a fresh `traceparent` per request within that trace. `apps/web`'s dashboard now sends it on both its `healthz` and `/me` fetches (sharing one trace ID between them); `apps/mobile`'s Today screen sends it on its one `healthz` fetch. `apps/admin` untouched — it doesn't call the backend at all yet.

Bug found and fixed during verification, not assumed away: the backend's `withCORS` middleware didn't include `traceparent` in `Access-Control-Allow-Headers`, so adding the header broke every browser-based request the moment it shipped — the `OPTIONS` preflight succeeded (`204`), but the browser then refused to send the actual `GET`, surfacing as a generic `net::ERR_FAILED` with no server-side symptom at all (nothing to see in the backend logs, since the request never arrived). Caught only because verification checked the actual network requests in the browser, not just that the backend's own logs looked right. Fixed by adding `traceparent` to the allowed headers list.

Verified for real: with the CORS fix in place, the dashboard's `healthz` and `/me` backend log lines were confirmed to share one `trace_id` with distinct `span_id`s (proof the client's trace ID round-trips and is honored, not silently replaced), and the Expo web preview's request succeeded with its own trace ID. Both signed-in-session checks required the user to sign in directly in the Browser pane — the assistant never touches credentials.

---

## Open items / known gaps as of this entry

- **`secrets.txt`** — an untracked file sitting in the repo root containing what looks like a live Anthropic API key in plaintext. Flagged to the user repeatedly; never staged or committed; not yet deleted or rotated as far as this log knows.
- Functional test suite not yet passing — blocked on applying the `--hostname` fix to `tests/functional/support/start-stack.mjs` (the user's own in-progress file — not something to edit unilaterally).
- No Railway `api` or `web` services exist yet, only Postgres — `railway/*.toml` configs are ready but unconnected.
- No production Postgres — `staging` is currently doing double duty for dev/staging/testing.
- JWT verification doesn't check the `azp` claim (fine for one frontend origin; revisit if that changes).
- Mobile app shell exists (`apps/mobile`) and is now fully Simulator-verified (screenshot-confirmed on a real iPhone 15 Pro Simulator). Still has no auth, no other tabs (Plan/Log/Progress/Profile), and no dev client (Expo Go only) — all deliberately deferred to future increments.
- Web app shell exists (`apps/web`, `/dashboard`) with only one destination (`Dashboard`) wired — Calendar/Strength/BJJ/Nutrition/Insights/Account are all still just IA on paper, no routes or stub pages yet.
- Admin console exists (`apps/admin`) with only `User Lookup`/`User Detail` wired, entirely against mock data (`lib/mock-users.ts`) — no admin backend, no subscriptions/device-platform/integrations/support-ticket data model, no `Jobs & Webhooks`/`Audit Log` screens (not designed yet). All explicitly future work, not silently skipped.
- `apps/web`'s current visual style predates the shared hi-fi design system (Barlow/Barlow Condensed, the light palette used in `apps/admin`) and doesn't yet follow it — reconciling that is unstarted.
- Structured logging + request/trace IDs exist in the API (`backend/internal/platform/httplog`), and `apps/web`/`apps/mobile` now propagate a `traceparent` on their real backend calls. `apps/admin` still doesn't — it has no backend calls of any kind yet, not a tracing gap specifically.
- Feature flags exist (`GET /v1/flags`, `internal/modules/featureflag`) but are read-only — no write endpoint, no admin-console screen, no backend admin-authorization concept, no frontend app fetches or gates on one yet. All explicitly future work.
- The new `backend-module-scaffolder` agent and `/new-module` skill are still unverified in practice — the feature-flags module was scaffolded by hand instead, since its shape (global, ownerless, read-only) didn't fit the agent's per-user-CRUD template. No module has gone through the agent for real yet (the `profile` module it's modeled on predates it) — worth checking it actually produces correct output the first time it's used for a module that *does* fit the template (e.g. a future `goals` module).
