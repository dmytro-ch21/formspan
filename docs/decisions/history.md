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

### First end-to-end vertical slice — Phase 1: activity module + real admin authorization

Every increment up to this point was infrastructure or self-contained. This kicks off the project's first real vertical slice: log an activity offline on mobile, sync it to the API, display it on web, find the user and trace the exact request in admin. Scoped as 5 sequential, independently-mergeable PRs (matching the project's own established discipline rather than one giant change) — this entry covers Phase 1, the backend foundation everything else depends on.

A real gap surfaced during planning, not part of the original ask: `apps/mobile` has no authentication at all yet, so it can't sync anything to an authenticated endpoint without first being able to sign in — added as a necessary Phase 2 (minimal Clerk Expo auth) ahead of the offline-logging phase, flagged up front rather than discovered mid-build.

Built `internal/modules/activity`: a generic "unified activity envelope" (`kind` + flexible `details` JSONB, not per-sport tables) matching the product's own stated vision, following the `profile` module's shape. **Create is idempotent** on the client-generated `id` (`INSERT ... ON CONFLICT (id) DO NOTHING`, falling back to a `SELECT` for the original row on conflict) — essential for offline-sync correctness, since a retried sync must never create a duplicate. `occurred_at` is client-supplied and deliberately distinct from `created_at`, since the entire point of offline logging is that it can happen well after the activity itself.

Also built: **real backend-side admin authorization**, closing a gap flagged when the admin console shipped (`apps/admin`'s `ADMIN_EMAILS` check was frontend-only — any authenticated user could have called an admin-scoped backend endpoint directly, since none existed to gate). User confirmed the approach directly: `ADMIN_USER_IDS`, a backend allowlist of Clerk user IDs checked against the JWT's own `sub` claim — no extra Clerk API calls, no dashboard configuration. `auth.Verifier` gained this allowlist (parsed once at construction, same pattern as `withCORS`'s origin list) and a `RequireAdmin` method composing `RequireAuth` with the membership check, `403 forbidden` (a genuinely new `apihttp` code — `401` and `403` are different things and only the former existed before) if the caller isn't listed.

`httplog` gained `RequestIDFromContext`/`TraceIDFromContext` — the raw ID strings weren't retrievable outside the logger before, and the activity handler needs them to stamp each row with the exact `request_id`/`trace_id` of the sync call that created it. That's the whole mechanism behind "trace the request in admin" (Phase 5): not a built log-viewer (its own future admin feature, alongside the already-flagged `Jobs & Webhooks`/`Audit Log`), just durably recording the correlation ID so a human can grep the actual log stream for it.

New routes: `POST`/`GET /v1/activities` (self-scoped, `RequireAuth`), `GET /v1/admin/users` (every user with a `profiles` row, LEFT JOINed against `activities` for a count/last-activity — not just users who've logged something) and `GET /v1/admin/users/{userID}/activities` (both `RequireAdmin`).

Verified for real, not just typecheck/build: the integration test's idempotent-create assertion passed twice in a row (`-count=1`); then, against the live API with a real Clerk bearer token, two identical `POST /v1/activities` calls returned byte-identical `request_id`/`created_at` (proof the idempotency actually works over HTTP, not just in the repository layer); `GET /v1/admin/users`/`.../activities` returned real Postgres data with that same admin token; and — the actual security property this whole phase exists for — the same valid, signed-in token got `403 forbidden` on both admin routes when temporarily excluded from `ADMIN_USER_IDS`, then succeeded once restored.

### README drift — a real gap, plus a standing rule to stop it recurring

The user asked how to start the admin app; the honest answer required pulling it from a chat reply rather than the README, because the README still described a two-app, four-endpoint repo — `apps/mobile` and `apps/admin` weren't mentioned at all, and the backend endpoint list predated `/v1/flags`, `/v1/activities`, and `/v1/admin/*`. Root cause, not just the symptom: `docs/decisions/history.md` and `docs/testing/functional-scenarios.md` both have explicit "keep current" hard rules in `CLAUDE.md`; `README.md` never did, so nothing forced it to track reality.

Fixed the content (current app list with what each one actually does today, the real backend route list, a complete "run it locally" section covering all four services including the admin console's non-default port and its `ADMIN_EMAILS` requirement) and the root cause: added a matching "Keep the README current" hard rule to `CLAUDE.md`, same shape as the other two.

### Vertical slice Phase 5 (pulled forward): admin on real data, plus PR-review subagents

The user asked to remove all mocked data and get a real test with a real log check. Phase 5 of the vertical slice was pulled ahead of Phases 2–4 (mobile auth, mobile offline sync, web display) because the backend already fully supported it — there was no reason to keep showing fabricated data while real endpoints sat unused.

**Mock data deleted outright**, not feature-flagged or commented out: `apps/admin/src/lib/mock-users.ts` is gone. New `lib/api.ts` server-fetches `/v1/admin/users` and `/v1/admin/users/{userID}/activities` with the signed-in admin's Clerk token and `cache: "no-store"` (a stale render of someone's account is a correctness bug in an admin tool). User Lookup now lists real users (ID, display name, activity count, last activity); User Detail lists real activities with the `request_id`/`trace_id` of the sync request that created each.

A deliberate call on the design's other columns: the mock had EMAIL/PLAN/PLATFORM/STATUS, subscriptions, integration health, and support tickets — **none of which have any real system behind them**. Rather than keep fake values or invent plausible-looking placeholders, those sections are simply **not rendered**. The screens show less than the design mock, and that's the honest state; they'll come back as each real system lands.

**Admin identity unified**: `apps/admin`'s gate moved from `ADMIN_EMAILS` to `ADMIN_USER_IDS`, the same var name and values the backend's `RequireAdmin` already used — one admin-identity convention instead of two that could drift apart. The UI gate is now explicitly documented as defence in depth; the backend check is the real boundary.

**Verified end-to-end for real, which is what was actually asked for**: created a genuine activity via the live API with a real Clerk token, then confirmed (a) it appeared in the admin User Lookup's activity count and in User Detail's activity list, and (b) grepping the running API's structured log output for that activity's stored `request_id` (`f7e0fa0c589688d5`) returned the exact `POST /v1/activities` line that created it — `status 200`, `duration_ms 13`. That closes the log-tracing loop the whole `httplog` + `request_id`-on-activity design existed for. Also confirmed the honest empty state on a user with zero activities.

Bug found while setting this up: `apps/admin/.env.local` had only `ADMIN_EMAILS` and was missing the Clerk keys and API URL entirely — the app had never actually needed them before, since it only rendered static data. Surfaced immediately as a Clerk "Missing publishableKey" runtime error the moment real server-side fetching started. Fixed locally; `.env.example` updated so the next person doesn't hit it.

**Two PR-review subagents added** (`.claude/agents/`), per the user's request for ongoing review toward a cleaner, more secure, more performant app:
- `backend-reviewer` — Go changes: authorization gaps/IDOR, information disclosure, secrets/PII in logs, N+1 queries, missing indexes, unbounded list endpoints, and adherence to the `profile`-module pattern (including the `t.Cleanup`-vs-`defer` gotcha this project already got bitten by).
- `frontend-reviewer` — app changes: server/client boundary leaks, client-only authorization, Server vs Client Component choices, `useEffect` dependency bugs, missing error states, accessibility, and design-token adherence.

Both are read-only diagnostics that report `[blocking]` vs `[suggestion]` findings and never apply fixes. A new `CLAUDE.md` hard rule requires running whichever matches the diff before opening a PR. The `frontend-reviewer` was run against this very change as its first real test.

### Vertical slice Phases 2–4: mobile auth, offline logging + sync, web display

Completes the arc. With Phase 1 (backend) and Phase 5 (admin) already done, this closes the middle: an activity logged on a phone — possibly offline — reaching Postgres, the web dashboard, and the admin console.

**Phase 2 — mobile Clerk auth.** `@clerk/clerk-expo` with the session token cached in the OS keychain via `expo-secure-store` rather than AsyncStorage (a token in plaintext app storage isn't worth the convenience), so sessions survive restarts. `app/_layout.tsx` gates the tabs behind sign-in.

The sign-in flow needed two rounds of real fixes, both surfaced only by actually signing in — a good argument for the project's insistence on live verification over "it compiles":
1. The first pass handled only email+password. The account has 2FA, so Clerk returned `needs_second_factor` and the screen stopped there. It reported the status honestly rather than failing silently, which made the gap obvious.
2. The second pass added TOTP / SMS / backup codes — but this Clerk instance uses **email codes**, which Clerk's own TypeScript definitions don't list among second-factor params even though instances can be configured for it. The fallback error was changed to *name the strategy Clerk actually asked for* instead of a generic "unsupported", which is what identified `email_code` immediately. Implemented with a narrow, commented cast at the two call sites.

**Phase 3 — offline logging + sync.** `lib/db.ts` (expo-sqlite) holds a local `activities` table with a `synced` outbox flag; `lib/activities.ts` writes locally first and pushes pending rows to `POST /v1/activities`. **The activity ID is generated client-side** — that's the load-bearing decision, since it's what makes a retried sync idempotent against the backend's `ON CONFLICT (id) DO NOTHING`. Rows are kept after syncing rather than deleted, so the device keeps its own history independent of the network. Sync is manual + opportunistic-on-log; no background sync yet.

**Phase 4 — web display.** An activities panel on the dashboard consuming `GET /v1/activities`, with fixed-locale UTC timestamps (the same SSR-vs-browser hydration trap the admin console hit).

**Bug found by real end-to-end testing, not by any check suite:** the mobile test account had logged three activities but never completed onboarding, so it had no `profiles` row — and `ListUsers` started `FROM profiles`, making it **completely invisible in admin user lookup**. A user with data but no profile is precisely who an admin is most likely hunting for during support. Fixed to `UNION` user IDs from both tables (`LEFT JOIN` for the display name, which is now legitimately null for such users), with a named regression test. This only showed up because the verification used a genuinely different account than the seeded one.

**Verified end-to-end on a real iOS Simulator, not by proxy** — the whole point of the exercise:
- Signed in through the real 2FA flow.
- Took the API down, logged "Logged while offline" → saved locally as **pending** with an explicit "Could not connect to the server" message, no false success.
- Confirmed the row in the Simulator's actual `formspan.db` with `synced = 0`.
- Brought the API back, hit Sync now → "Synced 1.", row flipped to `synced = 1`.
- The same client-generated ID (`1b15201f…`) is in Postgres, stamped `request_id=36a2b0cabecfcadf`.
- The web dashboard lists it; admin user lookup shows the user (3 activities) and the detail view shows that same `request_id`.
- Grepping the live API log for `36a2b0cabecfcadf` returns the exact `POST /v1/activities` line — `200`, `46ms`. Full chain: phone SQLite → API → Postgres → web → admin → log line.
- The authorization deny path also proved itself incidentally: signing into admin as the non-allowlisted mobile account produced the "Not authorized" screen naming the ID, before that ID was added to `ADMIN_USER_IDS`.

**Three blocking issues found by `frontend-reviewer` on this change, all fixed before the PR** — and all things the check suite passed straight through:
1. **IDOR in the backend's idempotency path.** Activity IDs are client-generated, and `Create`'s conflict fallback looked the row up by ID *unscoped* — so any authenticated caller could POST a guessed/replayed ID and receive another user's activity (`user_id`, `notes`, timestamps) with a `200`. A collision also silently discarded the second user's activity while telling their client it synced. Fixed by scoping the fallback to the caller and returning `409 already_exists` on someone else's ID, with a named regression test seeding a victim row and asserting an attacker gets neither the row nor a success.
2. **Unscoped local outbox.** The device's SQLite `activities` table had no `user_id`, and sign-out didn't clear it — so on a shared device, user A's pending rows would sync **under user B's token** (permanent, since idempotency prevents correction), and B would see A's history. Fixed by adding `user_id`, stamping it from Clerk at insert, and filtering every read/sync by the active user. Pre-existing dev rows are dropped rather than mis-attributed.
3. **Silent local-database failures.** `onLog`/`onSync`/`refresh` had no error handling; a failed local read rendered as **"No activities yet."** — a failure disguised as a legitimate empty state, on an app whose entire promise is that the local write survived. Now surfaced. This fix immediately proved itself: re-testing showed a real `no such column: user_id` migration-ordering bug (the `user_id` index was created before the column check) that would otherwise have been invisible.

Also hardened from the same review: activity IDs moved from `Math.random()` hex to `expo-crypto`'s `randomUUID()` (the reasoning in `lib/trace.ts` — "correlation IDs, not secrets" — doesn't transfer to a value the server treats as an idempotency key); the session token is now fetched per row rather than once per sync run, since Clerk tokens are short-lived and a long backlog would start failing `401` partway; permanent 4xx rejections are distinguished from transient failures so a poison row can't retry forever; and accessibility fixes (accessible names on busy buttons, labelled inputs, larger sign-out target, contrast-corrected placeholders).

Deferred with reasons rather than silently: no `FlatList` virtualisation yet (the list is small), no fetch cancellation on the web panel (matches the existing `MePanel` pattern — fix both or neither), and Expo web target unverified for SecureStore/SQLite.

Also resolved: pnpm required explicit `allowBuilds` decisions for five new transitive postinstalls (`@clerk/shared`, `browser-tabs-lock`, `bufferutil`, `core-js`, `utf-8-validate`) — all set to `false` with a comment on why none are needed under React Native.

---

## 2026-07-28 — Phase 3: Rebrand to VOLA

The product is renamed **Formspan → VOLA**. Nothing about the strategy, scope, or architecture changed — this is an identity change, and everything above this entry stays as written. Per this document's own rule, earlier entries are *not* rewritten: they say "Formspan" because that is what the project was called when those decisions were made, and silently rewriting them would destroy the record of when the name changed.

**Brand assets are now in the repo** at `assets/brand/` and are the source of truth for identity: 7 logo SVGs, 4 app-icon masters, 2 splash masters, 25 UI icons, and `design-tokens.json`. Palette: lime `#B8FF2C`, green `#42F58D`, navy `#0B1220`, charcoal `#111827`, muted `#94A3B8`. The mark is a green→lime gradient check.

Everything is SVG, deliberately. The rasters Expo needs (`apps/mobile/assets/images/*.png`) are **generated from those SVGs**, not hand-edited — so the vector stays authoritative and the PNGs can be regenerated at any size. Details that mattered while generating them: the iOS 1024 icon is flattened onto navy so it carries **no alpha channel** (the App Store rejects a transparent icon, and iOS applies its own corner mask anyway, so the source SVG's rounded corners must not survive as transparent pixels); Android's monochrome/themed icon collapses the gradient to flat white, because Android re-tints that layer from the user's wallpaper and a gradient renders as mud; and the splash ships the mark alone on transparency with the navy supplied by `app.json`'s `backgroundColor`, so it stays correct at any aspect ratio instead of letterboxing a fixed 1080×1920 bitmap.

**What the rename actually touched, and what it deliberately didn't:**
- Go module path `github.com/dmytro-ch21/formspan/backend` → `.../vola/backend`, with every import rewritten. Decided together with renaming the GitHub repo, so the Go convention that module path == repo URL still holds.
- Local Postgres role/database `formspan` → `vola`, in `docker-compose.yml`, `backend/.env.example`, and CI. This one has a trap: Postgres only runs its init env vars against an **empty** data directory, so bringing the container back up with new credentials against the existing named volume would silently keep the old `formspan` role and leave you debugging an auth failure. It needs `docker compose down -v` — an actual data wipe, taken deliberately (the local rows were throwaway dev data).
- Mobile SQLite `formspan.db` → `vola.db`. The filename change *is* the migration: pre-rename rows aren't migrated, they're abandoned. Fine — throwaway dev data, and no build has shipped to anyone.
- Design tokens are now available as `brand-`-namespaced Tailwind v4 `@theme` tokens in both `apps/web` and `apps/admin`. **Namespaced on purpose**: they're purely additive, so no existing utility (`rounded-lg`, `p-4`, …) shifts underneath screens that were built before them. Note `apps/admin`'s existing `--color-accent-lime` (`#e9ffa3`) is the *admin mock's* pale lime and is **not** the brand lime — reconciling the two is part of the deferred restyle, not this change.
- **Not renamed:** the Railway project and the Clerk application are still called `formspan` externally. Docs now say so explicitly rather than describing the desired end state, because a doc that names a resource you can't find is worse than no doc.
- Restyling the apps to the VOLA palette is deliberately **not** in this change. `apps/web` already doesn't follow the existing design system, so doing brand + rename + restyle at once would have buried a 30-file mechanical rename in visual churn and made both halves harder to review.

**A real problem surfaced while verifying the rename**, unrelated to it: the backend Postgres integration tests skip silently unless `TEST_DATABASE_URL` is set, and that variable was never documented in `backend/.env.example`. So locally they had *always* skipped — `pnpm run test:api` printed `ok` for all three module packages while running no integration test at all. They did genuinely run in CI (which sets the var), so the tests were doing their job on every PR; what was worthless was the local signal, and any local claim of "tests pass" made before this. Now documented in `.env.example`, `README.md`, and `CLAUDE.md`, pointed at a separate `vola_test` database so a test run can never touch dev data, and confirmed: all six integration tests report `PASS`, not `SKIP`.


## 2026-07-28 — Exercise catalog (first content module)

The first module that is **content rather than user data**: operator-authored reference material shared by every user, with no owner. That difference drives most of the design — nothing in it is user-scoped, and it's read-only over HTTP.

**Two fields carry the product intent, and they're the reason this isn't just a list of names:**

- **`load_type`** (`weight_reps` | `reps` | `time` | `distance` | `distance_time`) tells a client *which inputs to render*. A back squat wants weight × reps, a plank wants a duration, a run wants distance and time. Carrying that as data instead of branching in client code is what keeps logging one screen rather than a form per exercise type — and it means adding an exercise never requires an app-store release. This is the "experience, not a logger" principle made concrete in a database column.
- **`movement_pattern`** (squat / hinge / horizontal_push / vertical_pull / carry / core / lunge / locomotion / grappling) is the level the cross-sport rules can actually reason at. "Heavy hinge and squat work yesterday" is what makes hard sparring today worth flagging; muscle lists alone are too granular to write a readable rule against. `primary_muscles` is kept as well, but for display and filtering rather than as the rule input.

**Content lives in version-controlled JSON**, embedded into the binary with `go:embed` and applied by a new `cmd/seed`. This is the CMS decision, made concretely: content stays diffable and code-reviewed, deploys are reproducible across environments, and no authoring UI has to exist for the catalog to grow. Reach for a real headless CMS when people who don't use git need to author — not before. `go:embed` rather than reading from disk so the binary is self-contained and seeding can't fail on a container that didn't copy a data directory.

`seed` is a **separate binary from `migrate`**, deliberately. Migrations change schema and must run exactly once in strict order; seeding writes content and is meant to run repeatedly. Folding content into migrations would mean a new migration file every time a typo in an exercise description gets fixed. Every write is an upsert, so re-running is safe and `created_at` survives.

Seeded with 12 starter exercises spanning all three sports and — deliberately — **every one of the five load types**, so no load type ships without a client having rendered it at least once. A test asserts that property directly, rather than trusting the content to stay balanced as it grows.

**Media is deliberately absent.** Exercise images/video will live in object storage (Cloudflare R2 — S3-compatible so the Go SDK is unchanged, and its zero egress fee matches the access pattern: one file, every user, repeatedly, over mobile networks), with Postgres holding only a key and a CDN serving the bytes. But there are no bytes yet, so no bucket was provisioned to serve nothing. When it lands, the split that matters is **two buckets**: public immutable catalog media with content-hashed keys served straight from the CDN, and private user progress photos behind short-lived signed URLs — different policies, so a public-read rule can never widen to cover the private one.

**`backend-reviewer` caught one blocking issue and several worth fixing.** The blocker: the Dockerfile builds `./cmd/...` so the `seed` binary *shipped*, but `railway/api.toml`'s `preDeployCommand` only ran `migrate up` — so on any deployed environment the table would be created and never populated, and `/v1/exercises` would return `{"exercises": []}` forever. That fails **silently**: an empty catalog is a valid `200`, so no healthcheck or error would ever surface it. Fixed by adding `&& /app/bin/seed`. Latent rather than live, since no `api` service is deployed to Railway yet — but it would have been found in production, not staging.

Three others worth recording because they change how the next module should be written:

- **`updated_at = now()` fired unconditionally on every re-seed**, so it silently meant "time of last deploy" rather than "time of last content change" — which would have broken exactly the delta sync an offline-first client wants, returning the whole catalog after every deploy. Now guarded with `IS DISTINCT FROM` over the content columns, so an unchanged row is a true no-op. Verified directly: `created_at = updated_at` still holds after a re-seed. The distinction is between *row-count* idempotency and *value* idempotency, and only the latter is enough here.
- **The `($1 = '' OR sport = $1)` "one static plan" trick actively defeats the index.** pgx defaults to cached prepared statements, and once PostgreSQL settles on a generic plan the parameter is opaque, so it can't fold the `OR` away — measured on 50k rows, it seq-scanned even for a highly selective value. Replaced with a `WHERE` composed from compile-time-constant fragments and bound values, which gives one cached plan per filter shape and no injection exposure. The original comment argued the opposite of what's measurably true, which is the sort of thing that gets copied into the next module as settled wisdom.
- **LIKE pattern injection**, distinct from SQL injection: `$2` was bound correctly, but it landed inside a `LIKE` pattern, so a bare `%` turned a search into a full-table match. Metacharacters are now escaped and `q` is length-bounded.

Also from the review: seeding is now a single transaction (a half-applied catalog was briefly visible to readers on failure), `cmd/seed` has a bounded context so an unreachable database fails the deploy instead of hanging it, `sport` and `movement_pattern` are validated against closed vocabularies like `load_type` already was (the JSON is the authoring interface, so `"strenght"` would otherwise seed a row no filter could ever return), and `build:api` now builds `./cmd/...` to match the Dockerfile rather than only `./cmd/api`.

**Known gaps, all deliberate:** seeding never deletes — removing an entry from the JSON leaves its row, and renaming a slug creates a second row, so the JSON is authoritative for *content* but not yet for *membership* (hard deletion gets risky once activities reference exercise IDs, so an `archived_at` column is the likely answer); no `ETag`/`Cache-Control` on a payload that's byte-identical for every user and changes only on deploy, which is probably the highest-value next change for an offline-first client; no user-authored custom exercises (when they arrive they get a nullable owner column on this table, not a parallel one, so the logger keeps reading from one place); no admin write path (edit the JSON and re-seed); no media; and no pagination — 12 rows today, and the filters are applied in SQL rather than in Go specifically so that adding pagination later doesn't require rewriting the query.


## 2026-07-28 — Exercise media on Cloudflare R2

R2 bucket created and first images uploaded, so the media half of the catalog is now wired.

**Postgres stores a key, never a URL and never bytes.** Bytes in Postgres would bloat every backup and WAL segment and couldn't be CDN-cached. A baked-in absolute URL is subtler but just as bad: it pins the bucket and CDN hostname into the data, so moving either becomes a data migration. Instead each row holds a `storage_key` (`exercises/{id}/{kind}.webp`) and the API joins it onto `MEDIA_BASE_URL` at read time — moving buckets or putting a different CDN in front is then an env-var change.

`MEDIA_BASE_URL` being **unset is a supported state, not a misconfiguration**: local dev and CI have no bucket. Media then reports an empty URL rather than a broken one, and clients treat empty as "no image" instead of trying to load it.

**A separate `exercise_media` table**, not columns on `exercises` — one exercise has several assets (start position, end position, later a demo clip) and that set should grow without a schema change. `width`/`height` are stored so a client can reserve layout space before the image loads instead of reflowing the list as each one arrives.

**Two non-obvious things this surfaced:**

- **A media change has to mark the parent exercise stale.** A client delta-syncing on `exercises.updated_at` would otherwise never learn that an image was swapped, because the exercise row itself didn't change — media is part of what the client caches, so it has to be part of what marks the row stale. The seed now touches the parent's `updated_at` for any exercise whose media actually changed (and only those, preserving the value-idempotency established in the previous entry).
- **`ORDER BY kind` is alphabetical, which puts `end` before `start`** — backwards for a movement, and exactly the sort of thing that ships as "why is the finish position showing first?". Caught by a test. Media is now ordered by `position` first, with an explicit semantic `CASE` (thumbnail → start → end → demo_video) breaking ties deterministically when position is left at its default.

Unlike the exercise upsert, the media writer **does delete**: rows absent from the seed JSON are pruned, so the file is authoritative for which assets exist. Safe here in a way it isn't for exercises themselves, since nothing references a media row by ID — a deleted image that kept being served would be a worse failure than a stale row.

`List` and `Get` both fetch media in **one query for the whole page** rather than one per exercise. The N+1 would be invisible at 12 rows and painful at 500.

**Still open:** the two-bucket split (public immutable catalog media vs. private progress photos behind signed URLs) exists as a decision but only the public half is real, since no user-uploaded media exists yet. No content-hash in keys yet, so `Cache-Control: immutable` isn't safe until keys are versioned — worth doing before the catalog is public. And there's still no `ETag` on `/v1/exercises` itself.


## 2026-07-29 — Workout templates

Workouts are **templates** ("Push Day A": bench 5×5, overhead press 3×8), deliberately distinct from a logged session (the `activity` module). Conflating the two is the classic mistake — you lose the ability to say "I did 3 sets, not the 5 the plan called for", and that gap between planned and actual is the adherence signal the system-design doc calls the most valuable row in the database.

**Two decisions came from the user and one correction came out of them:**

- **Shareable.** `owner_user_id` is nullable — NULL means a VOLA-authored official template — and pairs with a `visibility` of private/public. Together those cover both sharing cases (official templates, and a user publishing their own) without an ACL table, which would be premature. A DB constraint stops the two nonsense combinations: an ownerless private row would be unreachable by anyone.
- **No mixed workouts** — a workout is strength, running, or BJJ, never a blend. Enforced in the repository (every item's exercise must match the workout's sport) rather than trusted from the client, because "no mixing" is a data-model guarantee, not a UI convention.
- **The correction: goal is not sport.** The brief said "strength/powerlifting/hypertrophy/endurance or running or bjj", but powerlifting, hypertrophy and endurance are all things you do with the *same barbell squat*. Modelling them as sports would have meant duplicating every exercise across four catalogs. They're a property of the **workout** instead — a nullable `goal` column, meaningful only for strength — so `sport` stays the three real disciplines.

**Security carried forward from the activity module rather than rediscovered.** Workout IDs are client-generated (so a workout can be created offline and synced idempotently), which means `Create`'s conflict fallback has to be owner-scoped or replaying someone else's ID hands back their workout — the exact IDOR found in `activity`. Tested by name. Three more properties are tested rather than assumed:

- A private workout returns **`ErrNotFound`, not `ErrForbidden`**, to a stranger — telling them apart would let someone enumerate other people's IDs.
- **Visible does not mean writable**: a public workout is readable by everyone and editable only by its owner. Official templates (NULL owner) are read-only over the API entirely.
- The read-authorization rule lives in **one SQL fragment** reused by both `List` and `Get`, so the two can't drift — a `Get` more permissive than its `List` is a classic leak.

`visibility` defaults to private, in the handler as well as the schema: sharing should be a deliberate act, never the consequence of omitting a field. `position` is assigned from array order on write rather than trusted, so a client can't create gaps, duplicates, or a stored order that differs from what it sent.

Items are replaced **wholesale** (`PUT /v1/workouts/{id}/items`) rather than diffed. Reordering is the common edit, and a diff would have to dance around the `(workout_id, position)` unique constraint for no benefit at this size — the reorder case is tested precisely because that constraint is where a naive implementation breaks.

**BJJ is only half-served.** BJJ workouts work today because `bjj-gi-rounds` and `bjj-drilling` live in the exercise catalog, but a real BJJ session is techniques (armbar, triangle, guard passes) — positions and transitions, not muscles and load types. That's its own library and its own module. When it lands, `workout_items` gains a nullable `technique_id` alongside `exercise_id` with a CHECK that exactly one is set: additive, so nothing here needs redoing.

**Not built yet:** no mobile UI (the API is complete but nothing consumes it), no logging a session *against* a template, no official seeded templates, and no duplicate-a-shared-workout-into-your-own action — which is the obvious next thing sharing implies.


## 2026-07-29 — Mobile stack: RN now, Swift later, Android probably dropped

**Decision:** stay on Expo/React Native for now, build out the foundation and get the interaction design right, then rebuild iOS in Swift — and probably abandon Android at that point.

An intermediate option was considered and rejected: **RN for Android, Swift for iOS, in parallel.** That gets the costs of both and the benefits of neither — two codebases, which is the thing RN exists to avoid, while still carrying RN's constraints on Android. Worse for this product specifically, the offline sync layer is the highest-risk code in the app (outbox, client-generated idempotency keys, per-user scoping), and two independent implementations of an idempotency contract is how you get divergent bugs that surface on one platform months later in someone's real training history. The only thing genuinely shared between an RN Android app and a Swift iOS app is the OpenAPI contract, which already exists — so it would be two apps, not one app with two shells.

**What this changes about how to build from here**, and it's the important part:

React Native is now explicitly the **design vehicle, not the destination**. That shifts the cost/benefit of every mobile decision:

- **Push logic into the backend wherever there's a choice.** Anything behind the API is stack-agnostic and survives the rewrite; anything in `apps/mobile` gets rewritten in Swift. This retroactively validates decisions already made — `load_type` driving which inputs a client renders, `movement_pattern` as the rule-reasoning level, the server assembling media URLs — all of that is carried by the API rather than by client code, so a Swift client inherits it for free.
- **The offline sync protocol needs to exist as a written spec, not only as TypeScript.** Today it's implicit in `lib/activities.ts` + the backend's `ON CONFLICT` behaviour. Before the Swift rewrite it has to be documented as a contract (client-generated UUID as idempotency key, per-user scoping, retry semantics, which 4xx are permanent) so the second implementation can be faithful rather than reverse-engineered.
- **Don't over-invest in RN visual polish.** The WHOOP-like feel — 60fps rings, gradients, heavy animation — is where RN is weakest and where SwiftUI is strongest. Building it twice is waste; building it once in RN to *learn the design* and once properly in Swift is the plan. So RN screens should be functionally complete and visually plain rather than laboriously polished.
- **Do invest in the data model, API contract, and OpenAPI spec.** Those are permanent.

**Open question deferred, not resolved:** whether to leave Expo Go for a custom dev client. HealthKit is load-bearing given wearables are recommended, and it doesn't work in Expo Go — but if the iOS app is going to be Swift anyway, prebuilding an RN app to reach HealthKit may be work that gets thrown away. The answer probably depends on whether HealthKit integration is needed to *validate the design* or only to ship.


## 2026-07-29 — The real catalog: 523 exercises, 450 BJJ techniques

The twelve hand-written starter exercises are replaced by the authored catalogs, imported from the source spreadsheets by `scripts/import-exercise-catalog.py` — kept as a script, not a one-off, because the spreadsheets are the authoring surface and the seed is the build artifact.

**The "one catalog or separate?" question, settled by the data rather than by argument.** Exercises stay in one table — splitting by *sport* would triplicate search, filtering and media handling, force a UNION for anything cross-sport, and undercut the unified load model. But BJJ techniques got their own module, because the split that matters is by **shape**, not sport:

- An exercise is a **loggable unit measured by a load type**. You never log "3 sets of armbar at 60kg" — techniques aren't measured at all.
- A technique lives in a **graph**: it comes from a position and is answered by counters. In the imported library **444 of 450 carry `setup_from` edges and all 450 carry counters**. That graph is the substance of the thing, and it is simply inexpressible as a row in a flat catalog.

**Two mappings were needed, and one of them is a design decision worth knowing.** The source has **75 movement patterns** (Elbow Flexion, Scapular Elevation, Plantar Flexion…). That granularity is right for browsing and useless for rules — "heavy hinge work yesterday" would have to enumerate a dozen. So there are now two levels: `movement_pattern` stays a small closed vocabulary the cross-sport rules reason over, and `movement_pattern_detail` preserves the source's own value for display. Same split as keeping `primary_muscles` for display while rules read the pattern. `isolation` is the honest bucket for the single-joint long tail (147 entries) rather than inventing precision the rules can't use.

The other mapping is a quiet vindication: **all 19 of the source's tracking types collapsed onto the existing five load types.** No new one was needed, which is some evidence the original cut was right.

**A real content-integrity problem surfaced, and a test caught it.** Most of the twelve placeholders were *renamed* on the way in (`barbell-back-squat` → `back-squat`), so replacing the seed left ten superseded rows sitting alongside their replacements — the API would have served both — and orphaned three of the four R2 image sets, since their exercise IDs no longer existed. This is the "seeding never deletes" gap, previously noted as theoretical, biting for real: the JSON is authoritative for *content* but not for *membership*. Fixed by re-pointing the media at the surviving IDs and a one-off migration removing the ten. The general problem still wants an `archived_at` column rather than a migration each time.

Storage keys still read `exercises/barbell-back-squat/...` while pointing at `back-squat`. A key is an opaque path, so re-pointing costs nothing and re-uploading eight files would buy only tidiness — worth doing when the media pipeline grows, not now.

**Test fixtures moved to named constants** in both the exercise and workout suites. With the catalog generated from a spreadsheet, a content edit can rename an exercise, and inline string IDs meant that broke five tests at once with no indication that the cause was content rather than code.

**Also added deliberately:** a curated outdoor `Run`. The source is a commercial-gym catalog whose only running options are five treadmill variants — no outdoor run, which is the one a BJJ athlete who runs outside actually logs. It lives in an `EXTRAS` list in the importer rather than in the spreadsheet, so the spreadsheet stays a faithful record of the gym's equipment.

**Known gaps:** 463 of 523 imported exercises have **no coaching notes** — the catalog is structurally complete but nearly devoid of instructional content, which is far cheaper to fill in the spreadsheet than later. Technique `setup_from`/`common_counters` are name arrays rather than resolved foreign keys, because the source authors them as free text and not every referenced technique exists yet; a hard FK would reject the whole seed over one forward reference. And `workout_items` still can't reference a technique, so BJJ workouts remain exercise-only — that's the additive `technique_id` column already planned.


## 2026-07-29 — Theming split, and full authoring on web

**Web is light by default with an opt-in dark toggle; mobile is dark-first and dark-only.** The phone is used in a gym and at night; the web app is the desk surface — planning, reviewing, authoring — where a light ground reads better over long stretches and matches the tools beside it. A first pass made web dark-only, which was neither of those, and was corrected.

Web declares every colour twice and the Tailwind utilities reference the semantic variable rather than a literal, via `@theme inline` — a static theme would bake today's values into each utility and the swap would do nothing. Two details the swap forced, both invisible until you actually switch: **the brand lime is only legible as a fill against dark**, so on light it becomes an outline/tint and solid buttons use navy (hence `accent-fill`/`accent-on-fill` rather than a hardcoded pair); and the light ground is a faint warm grey, not white, so cards read as raised without heavy borders.

The theme lives on `<html data-theme>` applied by a blocking inline script, not in React state. Without that, a dark-mode user gets a white flash on every navigation — the most obvious way a theme toggle looks broken. React reads it via `useSyncExternalStore`, the right primitive for external mutable state; the lint rule rejected a first attempt that synced it into state in an effect, which would have meant a frame of disagreement plus a cascading render. Stored per browser rather than per profile: it's a property of where you're sitting, not who you are.

**Web gained full authoring, and that changed a previous decision.** The earlier "mobile builds, web plans" split was applied too literally. Logging genuinely is mobile-first — it happens at the gym, one-handed. But *authoring* a template is a sit-down task, and building the two-pane editor made that obvious: template on the left, catalog always visible on the right, so eight movements is eight clicks with the list never leaving view. On a phone the catalog must be a modal, costing an open/search/pick/close cycle each time. **The honest rule is logging is mobile-first, authoring is desktop-first**, and both should exist on both.

Web also gained the exercise Library it never had — 524 entries previously reachable only from a phone, which was a gap rather than a decision. Its detail panel labels placeholder images explicitly, for the same reason the API flags them: 463 of 523 entries have no photo of their own, and a placeholder that passes for real content makes the gap invisible and therefore permanent.

**A structural UI bug the dark theme exposed.** `components/Themed`'s `View` applied the theme's *page* background unconditionally, so every nested layout container stamped a page-coloured rectangle over whatever card it sat inside. Invisible while the app was light and both colours were near-white; immediately obvious on dark, as a darker box behind every exercise name. Fixed at the source — a layout View now paints nothing unless asked — rather than by adding `transparent` to fifteen inner containers, because the old default meant every future container would have hit it too. The screen background comes from the navigator instead, which had still been resolving to `DefaultTheme` (light).

**Still open:** the dashboard shows real counts only. The Readiness/Load/Fuel dials from the system-design doc need data not yet collected, and a fabricated dial on the one screen that must never lie would be the wrong first impression. Web remains unverified in a browser — it sits behind Clerk sign-in, which no agent can pass on the user's behalf; that verification friction is the strongest argument for a dev-only auth path, not for replacing the provider.


## 2026-07-29 — Session logging: what actually happened, with effort

Until now the app could describe a plan (`/v1/workouts`) and record that *something* happened (`/v1/activities`, a generic envelope with a `kind` and a JSONB blob). Neither could answer "what did I squat on Tuesday, and how hard was it" — which is the question the whole product is built to answer. `internal/modules/session` closes that: `sessions` + `session_sets`, with reps, weight, seconds, distance, **RIR and RPE**, and a set **type**.

**Sets are rows, not an aggregate.** "3×5 @ 100" cannot say the third set was heavier, the last one was a drop, or the first two were warm-ups — and that detail is most of what makes a training log worth keeping. The set type came directly from the user noticing it was missing, and it isn't cosmetic: **warm-ups are excluded from working sets and tonnage**, so counting them would inflate every number and make a light day look like a hard one, poisoning any load calculation built on top.

**RIR and RPE are both stored, though they measure the same thing** (RPE 8 ≈ 2 RIR). Lifters are fluent in one or the other and rarely both, and the moment just after a hard set is the wrong time to ask someone for arithmetic. Storing both costs two nullable columns; forcing a conversion costs data quality.

**The volume summary is computed in Go, not in SQL and not in either client.** `Summarise` lives in the domain package and travels with every session response, so the phone and the browser cannot disagree about tonnage — a number that differed by platform would be worse than no number.

**`sessions.workout_id` is `ON DELETE SET NULL`, not cascade.** Deleting a template you've outgrown must not delete the record of having trained it. History outlives the plan it came from; there's a regression test for it.

**Neither client has a Save button, and that's the load-bearing UI decision.** A save button in a gym is a way to lose a session: you put the phone down, pick up a bar, and the app gets killed with the last three sets only in memory. Every edit writes through — but the first pass did that *per keystroke*, which is both a request per character and a race: the response for "1" would land after "12" was typed and reset the field. Fixed by holding the sets in local state, coalescing edits ~700ms, and having the response update **only** the volume summary, never the rows. Structural changes (add/remove a set) and the moments that must not lose an edit — leaving the screen, opening the exercise picker, finishing the session — flush immediately and are awaited.

**The two clients diverge on purpose, along the line drawn in the previous entry.** On the phone each set is a summary row with the fields behind a disclosure, the previous set's weight and reps carry forward, and "+ Set" is one tap that repeats them — the common case is confirming, not typing. On the desktop nothing is hidden: every set is a row of live inputs in a table and Tab walks reps → weight → RIR → RPE → next set, which is the right shape for typing up a session from paper or fixing last Tuesday's numbers. Effort is **never** carried forward on either, because the third set at the same weight is not the same effort as the first and prefilling it would invite recording a number nobody judged.

**Starting from a template pre-fills the prescribed sets.** Beginning a planned session from an empty list means retyping the plan you already wrote — and the prescribed-vs-actual gap, the whole reason sessions and workouts are separate tables, only exists if the prescription is what you start from and then change.

**Review caught the same security bug the previous PR fixed, arriving through a different door.** `workout_id` was accepted from the request body and written straight to the foreign key with no visibility check — so naming someone else's *private* template succeeded with a `200`, while naming a nonexistent one tripped the FK and returned `400`. That split is a working enumeration oracle over every private workout in the system, because workout IDs are client-generated and therefore often guessable (`push-day-a`). It's exactly the bug closed on the workout write paths one PR earlier, which is the lesson: **the property has to be re-established at every new reference to a resource, not fixed once per module.** Now resolved under the same visibility rule the workout module reads by, with "doesn't exist" and "not yours" returning one identical error — and regression-tested, including a check that the test fails without the fix.

Two smaller review findings worth recording: `hardest_rpe` was counting warm-up sets, contradicting the schema's own wording and letting a hard warm-up single set a session's headline difficulty; and the handler validated RIR/RPE but not the positive-measure constraints, so `reps: 0` fell through to the database's set-less "a value is out of range" — the exact outcome that validation function exists to prevent.

**Verified live, not just compiled.** A real session was logged on the iPhone 15 Pro Simulator against the local API — Back Squat 5 × 102.5 kg at RIR 2 / RPE 8, a carried-forward second set, then finished — and read back out of Postgres with every field intact. Starting "Push Day A" produced its four prescribed sets pre-filled. Two real UI defects surfaced only in that pass and would not have shown up in a typecheck: a four-figure tonnage wrapped onto a second line and shoved its own label out of the summary row, and the back button read `(tabs)` — the Expo Router group name leaking into the interface.

**Not verified live: the web screens.** They build, typecheck, lint, and their routes are correctly gated by the Clerk middleware, but nothing has driven them signed-in — Clerk sign-in is a wall no agent can pass on the user's behalf, and the Chrome extension that could reuse an existing session wasn't reachable. This is the second entry in a row ending on that note, which is now the clearest argument for a dev-only auth path.

**One unstable function reference was silently breaking three screens.** `@clerk/clerk-expo`'s `useAuth().getToken` is a bare arrow function rebuilt on every render — its `@clerk/react` counterpart is wrapped in `useCallback`, so this is a mobile-only hazard. Every screen that listed it as a `useCallback`/`useEffect` dependency therefore rebuilt that callback every render, which meant: a fetch effect became a **self-perpetuating refetch loop**; each reload overwrote local state, so a set being typed or an exercise just reordered was wiped a frame later; and cleanup functions ran on *every render* rather than on unmount, quietly defeating the debounce that flushes on unmount.

Two of the symptoms were reported as user-visible bugs before the cause was known — reordering a workout's exercises did nothing at all, and "+ Set" incremented the volume summary without the set ever appearing. Both were this. Fixed with a `useAuthToken()` latest-ref hook that hands out one stable getter, applied to every fetching screen; the root cause predates this work (`(tabs)/workouts.tsx` had it too), so the fix is repo-wide rather than local.

**Three more real defects came out of the same review pass**, none of which a typecheck could have caught:

- **"+ Set" appended to the end of the session, not to its exercise.** Sets group by adjacency, so in a multi-exercise session the new set formed a second block of the same movement at the very bottom of the screen — from where you were looking, the tap had done nothing, while the summary counted it. Now inserted after its own group, with positions renumbered.
- **A decimal weight was impossible to type on mobile.** The input was driven straight off the parsed number, so "72." parsed to 72 and re-rendered as "72", eating the point — on an app whose primary flow is 2.5 kg jumps. The raw string is now the input's state and the number is derived from it.
- **Saves weren't serialised, and `flush()` didn't await one already in flight.** Two overlapping whole-list PUTs have no ordering guarantee, and the exercise picker's read-modify-write could read pre-PUT state and write it back — a silently lost set. Saves now chain, and `flush()` awaits the chain rather than just the queued write.

**Two features the logging flow was missing, both from using it rather than from designing it.** Starting a session from Today jumped straight to an empty one, which has the common case backwards: someone who wrote a plan wants to *perform the plan*, and rebuilding it at the rack is the thing the plan existed to avoid — so a sport now leads to a chooser (your workouts for that discipline first, empty session as the fallback, and an offer to create one when there are none). And an exercise can now be **swapped mid-session**: the rack is taken, the bar is in use, a shoulder complains on the third set. Swapping rewrites the sets already logged in place rather than losing them, and suggests substitutes by a rule you can say out loud — same movement pattern, same load type — with measures carrying over only when the two are measured the same way. Deterministic and explainable, per the project's own principle; nothing opaque.

**The gap this leaves, and it's a real one: sessions are online-only.** `/v1/activities` goes through the SQLite outbox; sessions do not, so logging in a basement with no signal currently fails outright — on the feature most likely to be used exactly there. The contract is already right (client-generated ID, idempotent create, whole-list replace), so the fix is a local queue rather than a redesign. Also missing: no rest timer, no supersets, no history analytics — nothing yet *reads* sessions back, which is the point of collecting RIR and RPE at all.


## 2026-07-29 — Progressive overload, a rest timer, and the platform split made explicit

**The app now tells you what to load, and always says why.** `GET /v1/sessions/suggestions` answers "what should I lift today" for a whole workout in one request, from the caller's own history: the **top working set of the most recent session** containing that exercise, warm-ups excluded (progressing off a warm-up would recommend a weight nobody worked at).

The rule is **effort-driven**, which is the entire reason RIR and RPE are collected. Weight alone cannot say whether a set was easy — someone who grinds out five reps and someone who leaves three in reserve log an identical row. So:

| last top set | outcome |
|---|---|
| 2+ RIR, or RPE ≤ 8 | **increase** by the movement's increment |
| RIR 1, or RPE 8–9.5 | repeat — real work, but not room |
| RIR 0, or RPE ≥ 9.5 | repeat — at or near failure |
| no RIR and no RPE | repeat, and say so: nothing recorded means nothing to call easy |
| over 28 days ago | repeat — staleness outranks effort |

Increments scale with the movement rather than being one number: **5 kg** for squat/hinge/olympic, **2.5 kg** for push/pull/lunge, **1.25 kg** for isolation and anything unmapped. "Add 2.5 kg" is trivial on a squat and a fortnight of progress on a lateral raise. This is the coarse `movement_pattern` earning its keep a second time — the same vocabulary now drives both the increment and the rest default, which is exactly the argument for having split it from `movement_pattern_detail`.

**Two properties were treated as non-negotiable.** First, it *never guesses*: no recorded effort produces "repeat it and log an RIR", not an invented jump. Second, **the evidence travels with the recommendation** — `last_reps`, `last_weight_kg`, `last_rir`, `last_rpe` and the date are returned even when the answer is "repeat", so a number can be checked rather than trusted. A recommendation you can argue with is a different object from an oracle, and only the first belongs in a training log. Clients branch on a `code`; `reason` is prose and explicitly not contract.

Sessions started from a template now open **pre-filled**: the plan's prescribed weight wins where it exists, and history fills the gaps. Reps are left alone — the programme owns those, and inferring them from one prior set would quietly rewrite it.

**A flaw the tests missed and real data caught immediately.** The first version took the most recent session containing the exercise, full stop. But a session where an exercise was *added and never performed* — every measure null — is not evidence, and it was winning over a real set behind it, reporting "not measured in weight" and erasing a genuine 102.5 kg history. Sets with nothing recorded are now excluded from the lookup. This is the second time in two days that running the thing against real rows found something twelve unit tests didn't.

**A rest timer, driven by a deadline rather than by ticks.** That distinction is the whole implementation: a timer that decrements a counter each second drifts, and it stops when iOS throttles the JS thread — which happens the moment the phone goes into a pocket, i.e. during every real rest period. So the only state is the epoch millisecond the rest *ends*, and each tick re-reads the clock. Put the phone away for two minutes and the timer is right when you look again, because it was never counting.

Defaults come from the same movement-pattern table (180s for squat/hinge/olympic, 120s for push/pull/lunge, 60s otherwise), and they are defaults rather than prescriptions — ±15s is one tap and the number is always on screen. Rest starts on an explicit per-set "Rest" tap and on "+ Set", both of which mean "I just finished one". It uses haptics (`expo-haptics`, the one new dependency) because you should not have to be looking at a phone to know rest is over.

**The platform split is now a rule, not a habit.** The previous entry landed on "logging is mobile-first, authoring is desktop-first" and then hedged by building both everywhere. The user drew the line properly: **an in-progress session is a phone thing; the web app is for planning and analysis.** So the rest timer is mobile-only and always will be — a countdown on a desktop you are not standing next to is decoration. Web keeps starting, reviewing and correcting sessions, which are desk activities, and gains the planning and analytical surface. Recorded in `CLAUDE.md` so it stops being re-litigated per feature.

**Still open:** nothing yet *reads* the history back as trends — the suggestion is the first consumer of RIR/RPE, and the analysis surface the web app is now explicitly for hasn't been built. Sessions remain online-only. Everything is still kilograms and metres.


## 2026-07-29 — Offline workout execution

Session logging was online-only, which meant it failed in a basement gym — the place it is most likely to be used. It is now local-first: every read and write on the session screen goes to SQLite, and the network is a background reconciliation concern the UI never waits on.

**The design rests entirely on two properties the API already had**, which is why it stayed small enough to trust:

1. The session ID is **client-generated**, so a session created offline and pushed hours later cannot duplicate — the server's create is idempotent on that ID.
2. Sets are replaced as a **whole ordered list**, so the outbox stores desired *state*, not a log of operations. Replaying is just "send what the row says now", which means a failed push followed by three more edits still costs one request. An operation log would have needed ordering, compaction and conflict resolution; last-write-wins on a whole list needs none of it, and is correct because a live session is edited on exactly one device.

Sets live in the local row as a JSON blob rather than their own table — nothing anywhere touches a single set in isolation, so rows would buy a join and a reconciliation step and nothing else.

**Push before pull, and that order is not incidental.** Pulling first would overwrite unsynced local work with the server's older copy — precisely the data loss the store exists to prevent. On the pull side, any session the device holds dirty is skipped.

**Caching the sessions turned out to be the easy half.** Testing against a genuinely stopped API surfaced two gaps that no amount of reading the code would have:

- **The exercise catalog wasn't cached**, so an offline session had set rows and no idea what exercise they belonged to, which measures to render, or what to call them. A log you can write but not read is not offline support.
- **Workouts weren't cached either**, so the start screen said *"No Strength workouts yet"* and offered to create one — a lie told at the exact moment someone is standing in a gym about to train. Worse than an error, because it looks like data.

Both are now cached, and the catalog is warmed from the Library tab rather than lazily on first offline use — the first offline session shouldn't be the first time anything gets cached.

**The volume summary is now computed locally too**, a deliberate and narrow exception to "compute it once, on the server". A summary that blanks out the moment you lose signal is worse than one computed twice. The server's `Summarise` remains the authority, pinned by its own test; if the two ever disagree, that test wins.

**Verified against a stopped API, not a mocked one.** With `dev:api` killed: a session started, the screen rendered with no error, the picker fell back to the cache, and the row was written locally. On restart, returning to Today triggered the sync and the session landed in Postgres — keeping its **real** `started_at` of 22:42:30, the moment it was created offline, not the moment it synced. That timestamp is the whole point of the exercise.

**Honest remaining gaps.** Sync is **trigger-based, not event-driven**: it runs on screen focus, on the next edit, and when a session starts — there is no connectivity listener, so a phone that regains signal while sitting on a bench won't push until something touches it. A `NetInfo` subscription is the obvious next step and was deliberately not added here rather than bolted on untested. Also: a session started on *another* device still can't be opened offline (it has to be fetched once), suggestions are server-computed and so simply don't appear offline, and the workout cache covers `scope=mine` only. The web app is unchanged and stays online-only, which is correct under the platform rule — it is the planning and analysis surface, not the one used in a gym.


## 2026-07-29 — Units, a settings screen, and remembering the right things

**Everything is still stored in kilograms and metres. Units are a display and input transform, nothing more.** That is the whole design, and the reason the change stayed contained.

Storing converted values would have made every historical row ambiguous the moment someone flipped the setting — was that 100 recorded as kg or lb? — and it would have silently broken the progression rule, which compares weights across sessions. So conversion happens at the last possible moment on the way out and the first possible moment on the way in. The settings screen says this in plain language, because a units toggle is exactly the control people expect to rewrite their history.

`profiles.unit_system` holds it, so the preference is an **account** property, not a device one: someone who thinks in pounds thinks in pounds on the web app and on their next phone. Mobile caches it locally so the session screen renders correctly with no signal — showing kilograms to a pounds user purely because the phone is offline would be a worse failure than showing nothing.

**One thing the units work forced a change in.** The progression suggestion's reason read *"add 5 kg"* — hardcoded metric, which would have leaked into a pounds interface. The button beside it already shows the target weight in the athlete's own units, so the delta didn't belong in the prose at all. The reason is now unit-free and there's a test asserting it contains neither "kg" nor "lb".

**A gap found on the way:** `PATCH /v1/profile` 404s when no profile row exists, which is the right answer for the API and a dead end for a real person — you can reach Settings without ever having onboarded, and "choose your units" failing because of a missing row explains nothing. Both clients now create the profile and retry.

**Verified end to end**, which for this feature means the round trip: switched to Imperial on the phone, confirmed `unit_system = 'imperial'` on the profile row, then typed **225** into a field labelled "Weight lb" and read **102.06 kg** back out of Postgres — which converts back to exactly 225.0 lb.

**Separately, the Library now remembers the right half of its state.** The sport filter persists across visits; the search box clears. They're different kinds of thing: "I train strength" is a standing fact that shouldn't need re-stating, while "bench" is a question already answered — finding it still in the box next time is a small confusion every visit, because the list looks short for no visible reason. Filters live in a per-user local `prefs` table, keyed by user because a shared device must not hand one account's settings to the next person.

**Still not done:** the workout editor and exercise library show weights in kilograms regardless — only the session surfaces are unit-aware so far. Distances convert but no screen currently takes a distance input in anger. And there's no per-exercise unit override, which some lifters want for machines marked in pounds.


## 2026-07-29 — Units everywhere, and a per-exercise override

Two follow-ups to the units work, both flagged in the previous entry rather than discovered later.

**The workout surfaces are unit-aware now.** The template editor's weight field, the target summary on every workout card, and the start chooser all render and accept the athlete's own unit, converting back to kilograms before anything is stored — the same rule the session logger already followed, so a template written in pounds and performed in kilograms is still the same plan.

The exercise library turned out to need nothing: it shows no weights at all. The earlier flag was overcautious, and saying so is cheaper than "fixing" something that was never broken.

**Per-exercise overrides, because equipment doesn't care what you think in.** A lifter who works in kilograms still faces a leg press marked in pounds, and forcing the whole account to one system makes them convert in their head at exactly the moment they're trying to record a number. `exercise_unit_prefs (user_id, exercise_id, unit_system)` holds the exceptions, and the session screen gets a small `kg`/`lb` chip on each exercise header.

The modelling decision worth keeping: **a missing row means "use the profile default"**, so there is no third state to reason about, and clearing an override is a `DELETE` rather than a sentinel value. The clients mirror that — flipping an exercise back to the account default removes the key rather than storing it, so the map only ever holds genuine exceptions.

**A pre-existing leak fixed on the way past.** `profile.translatePgError` echoed `pgErr.Message` straight to the client on a check violation. Postgres includes the offending value and the constraint body in that text, and `CLAUDE.md` has forbidden exactly this since the API conventions were written — it had simply never been audited in this module. Now mapped by constraint name, like the session module does. The FK case was missing entirely, so an unknown exercise id would have surfaced as a 500; it's a 400 now, with a test.

**Still open:** distances convert but no screen currently takes a distance input in anger, so that path is typed but unexercised. And the override is available on the session screen only — the workout editor uses the account default, which is arguably wrong for a template built around one specific machine.

## 2026-07-29 — Modal sheets went white (a fix's own regression)

The exercise picker and the new-workout sheet were rendering on iOS's default white, with the near-white body text invisible against it.

Cause: the earlier fix that stopped `components/Themed`'s `View` painting the theme's *page* background unconditionally. That was right — it was stamping a page-coloured rectangle over every card it sat inside — but it assumed something else always paints behind. On a normal screen the navigator does. **A `Modal` renders outside the navigator, so nothing does**, and the two sheets that relied on `Themed.View` for their background got the system default instead.

Both sheets now set `backgroundColor` explicitly, with a comment saying why a screen-level container needs one here and nowhere else. Worth recording because the shape recurs: a fix that removes an implicit default is only safe where the explicit replacement actually exists, and a modal is exactly the place it doesn't.


## 2026-07-29 — One ground, a flat tab bar, and the Λ

The mobile shell was three stacked slabs of slightly different dark — navigation header, content, tab bar — each separated by a hairline rule. On a dark theme those seams are the most visible thing on screen, and they were dividing a layout with no actual sections in it. Everything now sits on one continuous ground: the stack header paints `vola.bg` with `headerShadowVisible: false`, the tab navigator's scene does too, and the tab screens' own header is a plain component rather than navigation furniture.

**The tab bar is flat, flush, and type-only** — labels in uppercase on the same ground, a small dot above the active one, and a hairline as the only separator. No icons, no pill, no fill.

This took two wrong turns worth recording, because both were plausible. The first was a solid floating pill; the second made it glass, on the reasoning that a solid bar floating over content is just a smaller opaque bar. Both were the wrong instinct: **a floating control is a *thing on top of* the app**, and the design treats navigation as part of the page — quiet enough to ignore until you look for it. The active tab is marked by a dot rather than a container because that's the least furniture that still answers "where am I". Checking the hi-fi mockup earlier would have skipped both attempts.

The hairline is the one seam kept deliberately: without it the labels read as content when a list scrolls behind them.

**A React Navigation trap worth recording anyway**, since it'll bite the next person who tries to float something: insetting the tab bar with `left`/`right`/`bottom` silently does nothing — the navigator positions the bar's own container and overwrites those offsets, so it stays edge-to-edge and looks completely unchanged. Margins apply to the bar itself and survive.

**Screen names are small and top-left**, with the wordmark centred beside them. They're orientation, not headlines — you already know where you are and just want confirming.

**The wordmark's A is a bare chevron**, drawn from two rotated rules rather than set as a glyph. The Greek lambda renders at a different weight and width to the rest of the wordmark in most faces, so "VOLΛ" came out visibly mismatched; two strokes match the text exactly because that weight is a number we pick. The box width is derived rather than eyeballed — a 12pt leg rotated 22° carries its top end ≈2.25pt inward, so the apexes meet at 8.5pt and 9 gives a hair of overlap so the join reads solid. The first attempt had the rotations swapped and rendered a V.

**On the Dynamic Island:** the wordmark sits below it, not in it. Drawing *into* the island means a Live Activity via ActivityKit — native code and a custom dev client, neither of which this app has. The first attempt placed it level with the island and the island simply covered it; the island is opaque hardware, not a layer an app can draw into.

**Also removed:** the Expo web target's `body` still followed `prefers-color-scheme` and went white on a light machine, behind a dark app. Mobile is dark-only by decision, so it's the VOLA ground unconditionally now.


## 2026-07-29 — A You tab, profile editing, and Settings as grouped rows

The mockup's fifth tab exists now. **You** shows who the athlete is — name, which sports they train, the units in use — with **Edit** and **Settings** in the top-right.

**Those two are deliberately separate, not one list.** Edit changes *facts about you* that the app reasons over: which sports you do decides what it offers, and date of birth feeds the calorie and heart-rate maths later. Settings changes *how the app behaves*. Getting a fact wrong changes answers; getting a preference wrong only changes labels. One combined list would make "change my units" and "change my birthday" look like the same kind of action.

**Settings is grouped rows that drill down**, following the reference the user pointed at. The shape matters more than it looks: this list is going to grow — notifications, integrations, privacy, per-sport defaults — and a screen that gains a switch per feature becomes unnavigable long before it becomes complete. Sections and drill-downs mean adding a preference is adding a row, not redesigning the page. Units moved into its own sub-screen on that basis.

**Sign out lives in Settings under Account**, which is where people look for it, and it confirms first — anything not yet synced is still only on the device, and signing out is the one action that can put it out of reach. It was removed from Today (where it never belonged) and from You (where it would have been a second copy).

`PATCH /v1/profile` still 404s for an account with no profile row, so the edit screen creates one and retries, same as the units preference already did.

**Not visually verified:** the grouped Settings screen and the Edit form. Both typecheck and the navigation into Settings from the You header was confirmed working, but repeated Fast Refreshes had drifted the Simulator's navigation state badly enough that further taps were landing on stale frames, and screenshotting through that would have proved nothing. Worth a real pass before merging.


## 2026-07-29 — Volume that climbs, and effort you can switch off

**The session summary now counts what you've done, not what's been planned.** Opening a template used to show its full tonnage before a single rep — the opposite of what a training log is for. `session_sets.completed` is the trigger, and `Summarise` skips anything not ticked, so working sets, reps, tonnage and top RPE all climb as the session is performed.

The migration backfills existing rows to `true` and *then* flips the default to `false`. Anything already logged was by definition done; resetting history to "not completed" would have zeroed every past session's volume — and the fact that the tests caught exactly that when the insert path silently kept writing the new default is the reason the backfill is worth spelling out.

**Completing a set is a tick.** The old "Rest" chip became a checkbox. Un-ticking is allowed: mis-taps happen mid-set, and an un-undoable checkbox is worse than none.

*(Superseded below: the tick briefly also started the rest timer.)*

Two consequences worth stating because they're easy to miss: an uncompleted set contributes **no effort** to `hardest_rpe`, and the progression lookup now requires `completed` — a weight you planned but didn't lift must not become the evidence the next session's recommendation is built on.

**Effort tracking is a preference.** `profiles.track_effort`, on by default, with a switch under Settings → Preferences. Off hides the RIR and RPE fields entirely rather than greying them: a disabled field still costs the space and still reads as something you're failing to fill in.

Default-on is deliberate and not just conservatism — the progression rule has no other input, so shipping it off would make the app look broken rather than simple. Worth remembering if the setting ever moves into onboarding.

**Not visually verified.** The whole change typechecks, the full suite passes, and the new `Summarise` behaviour has tests covering nothing-done, partly-done and fully-done. But the tick and the effort switch haven't been driven on the Simulator — the session state there had drifted badly from a long stretch of Fast Refreshes, and screenshotting through it would have proved nothing. Both want a real pass.


## 2026-07-29 — What the session header is actually for

Trimmed to three numbers while training — **time, sets, reps** — with tonnage joining them only once the session is finished.

**Top RPE is gone entirely.** Mid-session it repeated the effort typed thirty seconds earlier, which is the definition of a stat that doesn't earn its place. **Tonnage is a result, not a readout**: nobody changes the next set because a running total crossed 1,500 kg, so it appears when the figure means something.

Both are still computed by the API. They're real data for the trends screen the web app is meant to become — the change is about what deserves a permanent slot in a header read between sets with one hand, not about what's worth recording.

## 2026-07-29 — Session duration, rest per exercise, and stats in the library

**A session records how long it took.** A live clock in the summary header, derived from `started_at` on every tick rather than accumulated — same reasoning as the rest timer, since a session spends most of its life with the phone in a pocket and a counter would stop when the JS thread is throttled. Finished sessions show their duration in the recent list and on the web history page.

**Rest is per exercise, and you start it when you want.** Each exercise header gained a Rest control, so the timer no longer only fires by ticking a set — you can start it after a warm-up, or a set you didn't tick, or just because.

**Then: auto-start became a setting, because it's genuinely a preference.** Ticking a set had also kicked off the countdown, on the theory that finishing a set and beginning to rest are the same moment. For some people it is; for others it isn't — you tick late, or tick a set you finished five minutes ago, or you're already walking to the next rack. Having guessed wrong in both directions (first auto-on, then auto-off), the honest answer was that neither is universally right: it's **"Auto rest timer"** under Settings → Preferences.

It defaults **off**, because a countdown that starts itself is one you spend attention cancelling when it guesses wrong, and the Rest button is always there regardless. The setting is local, like the per-exercise durations, for the same reason: the rest timer is mobile-only, so there's no second client to keep in step.

Worth noting as a process point rather than a design one — two rounds of me picking a default were two rounds of churn that a setting resolved immediately. Behaviour that splits on how someone trains is a preference, not a decision to make on their behalf. The duration is per exercise and **learned**: ±15s while a rest is running saves that adjustment against the exercise, so a heavy squat and a lateral raise stop sharing a wait after the first time you correct it.

Those durations live in the local `prefs` table rather than on the profile, and that's the right shape rather than a shortcut: the rest timer is mobile-only by the platform rule, so there is no second client to keep in step, and a server round-trip would buy nothing while breaking it in a basement gym.

**The library opens an exercise.** A detail screen showing the catalog entry and, underneath, what you last did on it — weight, reps, effort, when. The catalog alone is reference material anyone could look up; the last line is what turns "what is a Bulgarian split squat" into "what did *I* do last time", which is the only version of the question anyone asks standing in a gym. It reads from the same endpoint that drives progressive overload, so the number shown here and the number recommended in a session cannot drift.

**A bug caught by looking rather than by testing.** The mobile client's `localVolume` is a deliberate duplicate of the server's `Summarise`, kept so the header still works offline — and the completion change went into the Go version only. The result was a live session showing the plan's full tonnage (18 sets, 19,171 lb) against a column of unticked sets. Exactly the drift the duplication risks, found on the first screenshot after wiring it up. Both rules are now pinned server-side by tests named in the client's comment, so the next person to touch either knows which is authoritative.

Verified live: ticking the first set dropped the header from 18 sets to 1 set / 12 reps / 1620.1 lb, started the rest countdown labelled with that exercise, and left the session clock running.


## 2026-07-29 — A preference that needed a server was a preference that broke

The "Track effort" switch wouldn't move. The immediate cause was mundane — the local API had stopped, so the profile read and write both failed. But the reason that was *invisible* is the part worth keeping: the switch applied optimistically and then reverted in a `.catch`, so a dead network looked exactly like a dead control. No error, no explanation, just a toggle that snapped back.

The fix is the same shape the units preference already had and this one didn't: a **local cache is what the UI reads and writes**, and the account-level write is opportunistic. `useTrackEffort` now mirrors `useUnits`, and both the Settings switch and the session screen read the same hook, so they can't disagree about whether effort is being collected.

The preference still lives on the profile rather than being purely local, because it changes what the web app collects too — but in an offline-first app, *nothing about expressing a preference* should require a server to be reachable. The rest-timer settings were already local for a related reason; this brings the account-level ones in line behaviourally without moving where they're stored.

Verified by flipping it and reading `profiles.track_effort` go `t` → `f`.


## 2026-07-30 — The reviewers earn their place

Two review agents exist for exactly this, and I had been skipping them —
running the CI check suite instead and treating that as verification. The
user caught it. Running them on the merged shell work immediately surfaced a
**blocking data-loss bug that had already reached `main`**.

`insertSets` wrote `session_sets.completed`; `attachSets` never selected it
back. Every set read from Postgres therefore came back `Completed: false`,
which meant:

- **Every API response reported zero volume.** `attachSets` backs `Get` and
  `List`, and `Get` is what `Create`, `ReplaceSets` and `Finish` all return —
  so all four `Summarise` calls ran over uniformly not-completed sets. The
  web session page would have shown 0 / 0 / — for a fully logged session.
- **The mobile sync cycle would have erased real flags.** `sessionStore`
  pulls sessions from the API and upserts them clean into local SQLite, so a
  sync overwrote the phone's ticks with `false`; the next whole-list `PUT`
  wrote those back to Postgres. Flags gone, volume zeroed, and the session
  silently dropped out of `LastPerformances` — invisible to the progression
  rule forever.

What let it through is the sharper lesson. `TestCreateAndGet_RecordsEveryMeasure`
exists precisely to prove "every recorded measure survives the round trip".
The completion change added `Completed: true` to its fixtures and **no
assertion on it** — so the test dutifully passed while the measure it was
named after silently didn't round-trip. A fixture is not a check. Now
asserted, and confirmed to fail without the fix.

**The process change matters more than the fix.** The rule was already in
`CLAUDE.md` and I violated it repeatedly anyway, because it lived somewhere
separate from the thing I actually invoke. `/pre-merge` now runs the
reviewers *and* the check suite as one gate, with the reasoning written into
the skill: the checks prove it compiles and have never once caught an
authorization gap or a data-loss bug, while the reviewers have now caught
three — the cross-user ID-enumeration oracle twice, and this. Every one of
them shipped green.

Also from the same review: the `Volume` schema descriptions still claimed
only warm-ups were excluded, `completed`'s write-side default was implied by
Go's zero value rather than stated in the contract, `exercise_ids`' doc
comment disagreed with its own behaviour, and the down migration didn't warn
that a down-then-up cycle re-backfills every row to `true` — silently
marking skipped sets as performed.
## 2026-07-30 — What the reviewers found the second time

Running `frontend-reviewer` on the merged shell work turned up **five blocking
defects**, all already on `main`, and one of them was mine from the commit
immediately before.

**The "Track effort" switch did nothing.** The session screen imported
`useTrackEffort` and never called it, sitting next to a `useState(true)` that
nothing ever updated. The commit that introduced it claimed the opposite in
its own message: *"Settings and the session screen read the same hook, so the
switch and the visibility of the RIR/RPE fields can't disagree."* They
couldn't disagree because one of them wasn't reading anything.

**Three more copies of the volume rule had drifted.** `localVolume` — the one
duplicate I was worried enough about to leave a warning comment on — was
correct. The problem was the three nobody was watching: Today's `workingSets`,
the web history list's `working` filter, and the web session table, which had
no way to mark a set complete at all. So Today said "5 working sets", the
session it linked to said "Sets 0", and any session logged on web reported
zero volume *and* disappeared from the progression history, since
`LastPerformances` now requires `completed`.

The lesson is about where I aimed my attention: I guarded the duplicate I had
just created and never asked how many others existed. There are five copies
of that rule. Four of them needed changing and I changed one.

**The offline store could push bad data on upgrade.** `toSession` parses a
`sets_json` blob written before `completed` existed, so those sets read as
`undefined` → falsy. A session that happened to be dirty at upgrade time would
push `completed: false` for every set, overwriting the server migration's
backfill for work that was actually done. Now defaulted to `true` on read,
mirroring the migration.

**The root cause of the first one is a missing check, not a lapse.**
`apps/mobile` has no ESLint config, and `typecheck:mobile` wasn't in the
pre-push list. An unused import and an orphaned `useState` were invisible to
every check that ran. Rather than add a second lint toolchain, `noUnusedLocals`
and `noUnusedParameters` are now on in the mobile tsconfig, and
`typecheck:mobile` is in both `CLAUDE.md`'s check list and the
`pre-merge-checker` agent.

Turning them on immediately found five dead symbols, two of which were real
losses rather than tidiness: **the session-duration display on Today had been
silently dropped** by a later edit to the same block, and `pending` was running
a SQLite count on every save while being rendered nowhere.

That is two reviews in a row where the *green check suite* was the thing that
gave false confidence. The checks are necessary and they are not evidence.


## 2026-07-30 — One save, seven requests

The backend log was flooding during a workout. Capturing it properly (the
`pnpm run dev:api` wrapper never wrote stdout anywhere readable, which is why
this went unseen all session) showed 91 requests in about a second:

| path | count |
|---|---|
| `/v1/sessions` | 21 |
| `/v1/exercises` | 20 |
| `PUT /v1/sessions/{id}/sets` | 15 |
| `/v1/profile` | 15 |

Fifteen of those were the actual saves. The rest were amplification.

**The cause: `persist` called `syncSessions`, which is a full
reconciliation.** It pushes *every* dirty session at 2–3 requests each and
then pulls the last twenty. So one tick of a set — or one debounced
keystroke — cost `3 × dirty + 1` requests, and any session that could never
push stayed dirty and got retried on every single one of them. The cost grew
with the length of your training history rather than with what you were
doing, which is exactly backwards.

Editing a session should talk about that session. `pushSession` does one
session and clears its flag; reconciliation stays on screen focus, where it
happens once.

Review caught that the first cut of this went too far in the other
direction: the narrowed `catch` wrapped the *local* write too, so a failed
SQLite write — the one failure offline-first exists to make visible — said
nothing at all while the screen kept showing sets that existed nowhere. The
local write is the save and always speaks up; only the push is allowed to
fail quietly, and only when it failed because the *network* did. A push the
server actively refused (404 deleted elsewhere, 409, `invalid_input`) will
fail identically forever, so it surfaces.

Three more things fell out of the same review:

- **The create was still firing on every save.** `POST /v1/sessions` is
  idempotent, so replaying it was harmless — but it doubled the request cost
  of typing a weight and made the server re-validate the workout template
  each time. A `remote` column (schema v5) records that the server has
  acknowledged the session; a 404 on push clears it so a session deleted on
  another device is recreated rather than failing forever.
- **A corrupt local blob would have deleted the server's copy.** `toSession`
  degrades an unreadable `sets_json` to an empty list so the session stays
  openable — but `PUT /sets` *replaces*, so pushing that empty list turned a
  local read failure into permanent remote data loss. The push paths now
  check the parse themselves instead of trusting the display value.
- **Nothing drained the outbox except the Today tab.** With saves no longer
  running a full sync, a session logged offline sat dirty until something
  happened to open Today. The session screen now reconciles once on focus.

`pushSession` and `syncSessions` share one `pushRow` rather than holding two
copies of the ordering, idempotency and compare-and-swap logic. This codebase
has already been bitten by a duplicated implementation drifting (`localVolume`
against `Summarise`), and this is the same shape of risk.

**Still outstanding from the same trace**, both flagged by `frontend-reviewer`
and not yet fixed: `/v1/exercises` refetches the entire 524-entry catalog on
the session screen and the exercise detail screen rather than reading the
local cache, and `useUnits`/`useTrackEffort` each independently `getProfile()`
on mount so a screen using both issues two identical requests.

The wider lesson is about instrumentation, not the loop. Nothing in the
check suite, CI, or the reviewers' static reading would have surfaced a
request-count problem — it took reading a log, and there was no log to read
because the dev script's output went nowhere. Worth fixing that before the
next "why is it slow".


## 2026-07-30 — Training history, and where the arithmetic lives

`/dashboard/sessions` was a flat list of sessions with a start button on top.
It's now the history surface the platform split always implied — the web app
owns review, and review means more than a list — and the nav calls it
**History** rather than Sessions.

What's on it: a period selector (4 weeks / 3 months / year), sport chips, five
totals each carrying its change against the preceding window of the same
length, a consistency heatmap one cell per day, weekly load bars, and the
session list. Clicking a day filters the list to it.

**The one real decision here was where the numbers get computed.** Doing it in
the client was the obvious path and would have been wrong twice over:

- The working-set rule has already drifted between a client copy and
  `Summarise` **twice** in this project. A history page recomputing tonnage in
  TypeScript would have planted the same bug a third time, in the one view
  whose entire purpose is being trusted.
- `GET /v1/sessions` caps at 200 rows. A client summing that listing would
  have been *correct* for every current user and silently started
  under-reporting the day someone's history outgrew the cap — the worst
  possible failure, because nothing looks broken.

So `GET /v1/sessions/history` returns day buckets, period totals, the previous
window's totals, and a per-sport breakdown. The page's only arithmetic buckets
days the server already rolled up.

That endpoint aggregates in **SQL**, which does duplicate the working-set rule
(`completed AND set_type <> 'warmup'`) outside the domain. Loading a year of
set rows to produce six numbers was the alternative. It's made safe the only
way that actually works — `TestHistoryAgreesWithSummarise` runs the SQL and
`Summarise` over the same fixtures and compares. Verified it fails when the
rule drifts: breaking the warm-up exclusion reports `SQL 5, Summarise 4`.

**Days are bucketed in the caller's timezone**, passed as an IANA name. In UTC
a 19:00 New York session lands on the next day's square — wrong on the one
view whose whole job is which days you trained. That needed
`_ "time/tzdata"` in `cmd/api`: the runtime image is alpine with only
`ca-certificates`, so `LoadLocation` would have failed on every real zone in
production while working perfectly on a Mac.

Two things found by building on top of the existing app:

- **Every solid button in the app had invisible text.**
  `input,textarea,select,button { color: inherit }` sat *unlayered* in
  `globals.css`, and unlayered CSS beats `@layer utilities` — so it overrode
  every `text-*` utility on a button. "New workout", "Save", all of them were
  rendering `#10151f` on `#0b1220`: a contrast ratio of about 1.05:1, already
  shipped. Moving the reset into `@layer base` fixes all of them.
- **`formatWeight` has no upper register.** A training block's tonnage came
  out as `251147kg`. Cumulative load is a different magnitude from a set, so
  `formatTonnage` renders `251.1t` / `553,905lb` and `formatWeight` stays as
  it is — abbreviating there would turn a heavy single into `0.2t`.

Gaps this leaves: per-exercise progression ("how has my bench moved") is the
obvious next analytical surface and isn't here. The listing behind the day
filter is still capped at 200, which is fine for a year of training and won't
be forever. And mobile has no equivalent — correctly, per the platform split,
though "what did I do last time" on a phone is a different question worth
answering separately.

## 2026-07-30 — History on the phone, deliberately small

The web history page answers "what happened, and let me interrogate it." The
YOU tab now answers the one question a desk can't while you're standing in a
gym: **am I showing up.** Three numbers with their direction, a grid of days,
a bar per week. Two spans, 4 and 12 weeks. No filtering, no drill-down, no
year view — those stay on web, per the platform split.

The API does all the arithmetic, same as web. Mobile buckets days the server
already rolled up and works out a streak from the dates; no volume rule
crosses the wire.

**The streak counts weeks, not days,** and that's a product decision rather
than an implementation detail. A daily streak in a training app punishes rest
days — which *are* training — so it pushes people toward the one behaviour the
app should never encourage. Consecutive weeks with at least one session
rewards showing up and stays silent about which days. The current week only
counts once it has a session, so an unbroken run doesn't appear to reset every
Monday morning.

**The colour ramp was computed, not chosen.** The obvious move was lime at
25/45/70/100% opacity, matching web. Run through a contrast and colour-vision
validator against the mobile card, that ramp fails twice: the bottom step
lands at 2.05:1 (invisible on a phone in daylight) and, once raised enough to
clear 3:1, the top two steps collapse to ΔE 13.5 — below the threshold at
which *full-colour* vision separates them reliably. Three steps clear both
comfortably (ΔE 18.6+, all ≥3:1), so the ramp is three: `#567826 · #87BC28 ·
#B8FF2C`, stored as composited hex rather than alphas because those are the
values that were actually validated. Four levels of precision on a 13pt square
was over-reading anyway.

The mixed-sport bug the web version shipped was avoided here rather than
rediscovered: `hasSets` is decided per period but read per day, so a mat day
with no working sets is floored at the first colour step instead of rendering
as a rest day.

What this leaves: the phone still can't answer "how has my bench moved" — the
per-exercise progression gap is the same one web has. And the summary is
online-only, which sits oddly next to a logging flow that works with no signal
at all; caching the last response would fit the offline-first story better.

## 2026-07-30 — Aborts, "volume", and a session list that pages

Three fixes, one of which turned out to be structural.

**A cancelled request is not a server error.** Every module's error path
mapped anything unrecognised to 500 with an ERROR log, and a browser aborting
a fetch lands there — so the history page, which aborts on every filter
change, was manufacturing false failures. Anyone with an error-rate alert
would have been paged by a working feature.

The fix that mattered wasn't the check, it was where it lives. Twelve call
sites each wrote their own two lines of "log it, 500 it"; a `ClientGone`
branch pasted into twelve places is a branch someone forgets on the
thirteenth. They now all go through `apihttp.WriteInternal`, which is also
the only place that can decide what an unexpected error becomes. Cancelled
requests get 499 — nginx's convention, understood by every log pipeline —
and no ERROR line. `DeadlineExceeded` is deliberately *not* included: that's
usually our own timeout, which is a real problem.

The assumption underneath is that `errors.Is` can see through pgx's error and
the repository's `fmt.Errorf("%w")` wrapping. That's now pinned by a test that
cancels a real query and asserts the classification, rather than hoped for.

**"Tonnage" is now "Volume"** everywhere it's visible. The wire field stays
`tonnage_kg` — renaming it would break the contract for no user-visible gain
— but the label, the helper (`formatVolume`) and the internal discriminant
all say volume now, so the code and the UI use one word.

**The session list pages, filters and searches.** It used to fetch a flat 100
and stop: a year of training simply ended two-thirds down with nothing saying
so. `GET /v1/sessions` now takes `offset` and `q` and returns a `SessionPage`
— rows plus the total matched. The total is counted in the same request with
the identical predicate, because a count fetched separately is a count that
disagrees with the rows beside it.

Two details worth keeping: the ordering is `started_at DESC, id` so a session
can't repeat on one page and vanish from another, and the search escapes
LIKE's wildcards, so `%` searches for the character rather than matching
everything. Both are tested.

Found while verifying: at anything under ~900px the session name was being
squeezed to "U…" by four fixed-width metric columns — the one part of the row
you scan by. Given a basis so it wraps instead.

## 2026-07-30 — Estimated 1RM, and why it reads effort

An estimated one-rep max, on both platforms, embedded where the evidence for
it already sits rather than in a calculator screen of its own: on the "last
time" card in the session logger, and on the exercise detail screen.

**Two decisions carry the feature.**

*Brzycki, not Epley.* Epley evaluates a true single at 1.033× the weight, so
logging a genuine 100kg 1RM would report 103kg — visibly wrong at exactly the
moment the number is most checkable. Brzycki (`w × 36/(37−r)`) returns the
weight itself at one rep and is more conservative through the low-rep range
where heavy sets live.

*Effort is folded in, which is the part most apps skip.* A set of 5 with 3
reps in reserve is not evidence of a 5-rep max; it's a set of 5 that could
have been 8. VOLA records RIR and RPE per set, so the estimate runs on reps +
reserve. Without that, stopping short would read as a strength loss — and the
whole reason to log effort is that it changes what the numbers mean. RIR wins
over RPE when both are present: RIR is observed, RPE is converted.

Past twelve effective reps there's no estimate at all. Every rep-max curve is
fitted near a maximum and diverges badly beyond that; a set of 20 would
happily "estimate" a single nobody could lift. Returning nothing beats
returning fiction.

The personal best is a separate number because a current estimate alone is
inert. It's computed in Go over candidate sets rather than ranked in SQL, for
a reason worth recording: **the best estimate is not the heaviest set.** 5×100
estimates to 112.5kg and beats a 110 single. Any "just take the max weight"
shortcut is wrong, and putting the curve in SQL would have parked a second
copy of it a migration away from the first.

Displayed through `formatEstimate`, which rounds to whole units. `formatWeight`
keeps two decimals because a logged set is a *measurement* — 62.55kg is what
was on the bar — and a modelled number rendered as "143.88kg" invites being
read as a measured one.

Open: the estimate only appears where a suggestion already loads, so an
exercise you've never trained shows nothing (correct) and one you trained
today shows last session's set rather than today's. A per-session estimate,
and a "new best" moment when a logged set beats the record, are the obvious
next steps and aren't here.

Two things review changed materially, both worth recording because the first
instinct was wrong in each case.

**The personal-best search was capped by row count, and that silently loses
bests.** `ORDER BY weight_kg DESC LIMIT 5000` looks safe and isn't: the order
is global across every requested exercise, so a squat history eats the budget
and the lateral raises fall off the end entirely — the failure is biased
against light lifts and gets worse the longer someone uses the app. Even
per-exercise a cap can cut the winner, because 12×100 (144) beats 1×140 (140).

Replaced with a bound that's arithmetic rather than arbitrary. The estimate
lies between 1.00× and 1.44× the weight lifted (Brzycki at the 12-rep
ceiling), so a set can only win if 1.44 × its weight reaches the heaviest set
for that exercise. Everything below that line is provably beatable and is
never fetched. No cap, and no way to lose a best.

**RPE half-steps were being rounded away, in the wrong direction.** The column
is `NUMERIC(3,1)` precisely because the scale is used in halves, and rounding
made 8.5 mean 8 — then rounded halves *up*, which raises the estimate, against
this code's own stated bias toward under-stating. Reserve is fractional now;
Brzycki takes fractional reps without complaint.

Also from review: offset paging contradicted `api-conventions.md`, which said
"cursor everywhere, never offsets" — written before any list endpoint existed.
Rather than change the code, the doc now describes both shapes and when each
applies: offset+total for a bounded list a *person browses* (the total is the
point, and a cursor can't give one), cursor for anything a *machine drains*,
where re-reading a row is a correctness bug. And the contract no longer claims
paging is stable across writes, because it isn't — a session synced mid-page
shifts every later row down one.


## 2026-07-30 — Three loose ends: hydration, a shared escaper, an index

**The theme script and React were fighting on every page load.** `ThemeScript`
sets `data-theme` in `<head>` before hydration — deliberately, because without
it a dark-mode user gets a white flash on every navigation. So the server HTML
legitimately lacks an attribute the live DOM has, and React reported a
mismatch every time. `suppressHydrationWarning` on `<html>` is the case that
prop exists for; it covers that element's own attributes one level deep, so a
genuine mismatch anywhere below is still reported. Verified: no console error
on a fresh load, `data-theme` still applied.

**`likeEscaper` had reached three copies** — exercise, technique, session. The
escaping is only correct *in combination with* `ESCAPE '\'`, and the ESCAPE
is the half that gets forgotten: omit it and the backslashes the escaper
inserted become literal characters to match, so a search for "50%" silently
finds nothing while "%" still matches everything. Both halves now live in
`platform/database` as `LikeTerm` + `LikeClause`, because they are one
decision rather than two.

**`BestOneRMs` had no index it could use, and it runs whenever a workout
starts.** The query filtered on `sessions.user_id` and
`session_sets.exercise_id` — two tables, so nothing could index it. Postgres
had to either scan every user's sets of that exercise or walk the caller's
whole history, and both get worse with every session logged.

The owner is now denormalised onto `session_sets`, which makes
`(user_id, exercise_id, weight_kg DESC)` possible and drops the join
entirely. Measured on 60,000 squat sets across 300 athletes: the planner picks
the new index and reads exactly the 200 rows belonging to one of them, four
heap blocks. `user_id` is derived from the session inside the INSERT rather
than passed in, so no code path can supply a different one; a check across the
dev database found zero rows disagreeing with their session.

Review turned two of those into stronger versions, and corrected something I'd
written that was simply untrue.

**The derived `user_id` guaranteed consistency, not authorization.** Deriving
it from the session means the value can't disagree with the row it came
from — but a future caller that skipped the ownership check would write
perfectly-derived rows into someone else's session, and those rows would then
show up in that athlete's personal bests. A composite foreign key on
`(session_id, user_id)` closes it: the pair has to exist on `sessions`, so a
set can never name a session/owner combination that isn't real. Proven by
inserting one — the database rejects it. `ON UPDATE CASCADE` also means a
future Clerk-ID migration carries down instead of silently desyncing every
set, which nothing else covered. With the FK verifying it, the value is now
passed rather than sub-queried per row.

**`LastPerformances` is the other half of the same request** — same user, same
exercises, called one line before `BestOneRMs` — and it still filtered through
the join, so it couldn't use the new index either. A redundant
`AND ss.user_id = $1` lets the planner seek the index first.

**And the comment justifying `ESCAPE '\'` was wrong.** It claimed removing the
clause would make a search for "50%" silently find nothing. In PostgreSQL the
backslash is *already* the default escape character, so the clause is
redundant and removing it changes nothing — verified both ways. The clause
stays, because it's explicit about an otherwise invisible dependency and isn't
the default in every engine, but a wrong justification in the file whose whole
billing is "the one place to get this right" is worse than no comment: it
would send someone chasing a search bug by adding `ESCAPE` where it does
nothing.


## 2026-07-30 — Personal records, derived rather than stored

`GET /v1/records` gives every record the athlete holds for a shortlist of
exercises, and the YOU tab shows them under the training summary.

**The decision that matters: records are computed on read, not kept in a
table.** A stored record has to be *retracted* when the set behind it is
corrected or its session deleted, and getting that wrong leaves someone
looking at a lift they never made — the one failure a records feature cannot
afford. Derived, a record is by construction exactly what the log says, and
correcting a typo fixes the record for free. The index added for the 1RM
lookup makes it cheap enough that there's no reason to trade that away.

The simple maxima are exact by construction: weight, reps, seconds and
distance are each monotonic, so the largest row *is* the record and one window
function finds it. Only the estimated 1RM isn't monotonic in weight — effort
folds in — which is why it comes from `BestOneRMs` and its own arithmetic
bound instead.

**Two kinds per lift where both apply**, because they answer different
questions. The heaviest is what you'd tell someone in a gym; the estimated 1RM
is what actually moves when you get stronger at any rep range. They frequently
cite *different sets* — 5×100 estimates 112.5 and beats a 110 single — which
is the whole reason to show both, and is asserted in the tests.

Which kinds an exercise can hold comes from its `load_type`, mirroring
`measuresFor`, so a plank never advertises a weight record and a run never
advertises reps.

**The shortlist is exercises, not record types.** People care about "my big
three", not about whether to display heaviest-weight separately from
estimated-1RM — and since load type already decides the kinds, choosing the
exercise chooses everything downstream. An unset shortlist falls back to what
you train most, so the view says something useful before anyone configures it
and there's no empty state to set up.

**Web is the fuller view, deliberately.** The phone shows a shortlist because
that's what a glance holds; `/dashboard/records` shows *everything you've
actually trained* — every exercise, every kind it can hold, the exact set
behind each, and a link into the session it came from. That's the platform
split doing its job rather than the same screen at two widths.

Pinning is inline there rather than on its own screen: on a wide layout the
choice and the numbers being chosen can sit together, so you decide what
matters *while looking at* it. On a phone they can't, which is why that one
gets a separate picker.

`scope=all` backs it, capped at 200 distinct exercises — far past what anyone
accumulates, but a ceiling rather than a promise to return a career.

Review caught one thing that looked entirely fine and wasn't: `sort.Strings`
was called on the caller's slice and the output loop then iterated that same
slice, so **every response came back alphabetically**. That silently threw
away both orderings the feature runs on — the `position` an athlete chose, and
most-trained-first for `scope=all` — which made migration 000015's `position`
column and the reorder UI inert while appearing to work, and contradicted the
contract. The query now sorts a copy and the output keeps the caller's order.

The test written to pin that down *also* didn't work, which is the more useful
lesson. It asked for `[back-squat, bench-press]` — already alphabetical — so it
passed with the bug deliberately reinstated. Fixed to ask bench-first, and
re-verified by breaking the code again: it now fails on both the order and the
mutated slice.

Also from review: ties broke on `session_sets.id`, which `ReplaceSets`
regenerates on every edit, so correcting an old session could silently move a
tied record's date — now `started_at, id`. Two devices saving a shortlist at
once each deleted under their own snapshot and collided on the primary key,
returning 500 for what should be last-write-wins — now `ON CONFLICT DO
UPDATE`, matching what `profile.SetExerciseUnit` already does. A weight logged
without reps could become the "heaviest for at least one rep" record. And
`RecordKindsFor` returns nil for an unknown load type, which `Records` then
skips in silence — a table test over the catalog's own CHECK values now fails
at CI the moment a load type is added without a record kind.


## 2026-07-30 — Progression rules: double progression, and deleting the old one

There was already a progression rule (`Suggest`), and it wasn't one. It looked
at a single top set and added weight whenever two reps were left in reserve.
That reads as progression but isn't: it moves load off one good set regardless
of whether the session's other sets held up, it has no concept of a rep target,
and its only answer to a plateau is "repeat" — forever, with no branch that
ever says anything else.

Replaced with the scheme the strength literature actually converges on for
non-novice lifters, deliberately the *basic* one:

1. **Work inside a rep range**, chosen by the workout's `goal` rather than by
   the exercise — the same squat is a 3-rep lift in a powerlifting block and a
   10-rep lift in a hypertrophy one. Powerlifting 3–5, hypertrophy 6–10,
   endurance 12–20, general 5–8.
2. **Add reps first.** Same load, one more rep, until every working set reaches
   the top of the range.
3. **Then add load** and drop back to the bottom. Load and reps advance
   alternately — hence "double progression".
4. **Effort gates both halves.** A set taken to failure is not evidence of
   room, so RIR/RPE decides whether a rep is even available (2 RIR is the
   target reserve). This is finally the thing that justifies collecting effort
   at all.
5. **A stall deloads.** Three consecutive sessions at one load without gaining
   a rep is a plateau; the answer is ~10% off and a rebuild, not more grinding.

Two smaller corrections that matter more than they look. The gate is the
**weakest** working set, not the top one — a session opening at 10 and
collapsing to 6 is not a 10-rep session, and the old rule would have added
weight to it. And the increment is now capped at **5% of what's on the bar**:
2.5 kg is 1.8% of a 140 kg bench and 6% of a 40 kg one, and treating those as
the same number is how a beginner gets pushed into a stall by an increase that
looks modest written down.

**The old rule was deleted, not left beside the new one.** `Suggest`,
`Performance` and `LastPerformances` are gone. Two rules that can disagree is
the exact drift this codebase has been bitten by twice (the working-set
definition, both times), and "we'll keep the old one for compatibility" is how
you get there. There is one progression rule, it lives on the server, and no
client has a copy.

### What the clients got

Web is the analytical surface, so it gets the whole reasoning: a
`ProgressionCard` with the phase, the prescription as `weight × reps`, the
reason verbatim, the evidence, and a **rep-range track** — pips filling toward
the top of the range and resetting one weight higher. Double progression is a
two-phase cycle that no sentence explains well; five dots explain it at a
glance, and they make "why am I not adding weight yet" answerable without
reading anything.

Mobile gets the same recommendation compressed to a card read between sets:
phase, pips, target, one line of reason, one line of evidence. Same rule, same
numbers, less prose — the standing mobile-vs-web split.

`applySuggestions` now fills **reps as well as weight**. It deliberately didn't
before, because the old rule only moved load and inventing reps would have
overwritten the programme. Under double progression the rep target *is* half
the recommendation, so filling only the weight silently drops the half that
moves in most sessions.

The `goal` had to be threaded through every "start a session" path on both
clients. Missing one wouldn't have failed anything — it would have pre-filled a
session on the general 5–8 range that the session screen then re-derived on
3–5, and the two would have quietly disagreed about what the athlete was doing.

### Verification

The rule is a pure function and every branch is pinned, but the useful part was
**mutation testing** rather than the tests passing. Eight bugs were reinstated
deliberately, one at a time; six were caught, and **two escaped**:

- Removing the effort gate from `readyForLoad` — nothing failed, because no
  test covered "top of the range at 1 RIR", the case that is neither failure
  nor sufficient reserve.
- Changing the stall counter's `break` to `continue` — nothing failed, because
  no test covered a lifter who deloaded and came back to the same weight, whom
  a non-consecutive count would deload again immediately.

Both gaps are now covered and both mutations are caught. The same method found
the `ROW_NUMBER`-vs-`DENSE_RANK` bug in `RecentEfforts`: the window has to
number *sessions*, and numbering set rows instead cuts a session in half — the
surviving sets then look like the whole session to the weakest-set gate, which
is precisely the failure that gate exists to prevent. Verified by swapping the
function and watching the test report 1 session where it wanted 3.

### Two bugs review caught that testing didn't

Both were shipped-quality by every check I had: green suite, green mutation
tests, green integration run. Both were found by the `backend-reviewer`
reading for intent.

**The deload spiral.** `sessionsAtLoad` counted consecutive sessions at a
weight, and the deload fired at three. But climbing 6 → 7 → 8 reps at a fixed
weight *is* double progression — it is the entire first phase of the cycle. So
a lifter doing exactly what the app prescribed got deloaded on their third
session. And because a deload takes 10% off while the following `add_load`
gives about 5% back, the prescribed load ratcheted **downward** roughly 5%
every four sessions, forever:

```
session 1: did 100.00 x 6 -> add_reps  next 100.00 x 7
session 2: did 100.00 x 7 -> add_reps  next 100.00 x 8
session 3: did 100.00 x 8 -> deload    next  90.00 x 10   <-- gained a rep every session
session 4: did  90.00 x 10 -> add_load next  92.50 x 6
session 7: did  92.50 x 8 -> deload    next  83.75 x 10
```

The reason string shipped alongside it said "Three sessions at this weight
without gaining a rep" while `last_min_reps` in the same response said 8 on a
history of 6 → 7 → 8 — the module's own stated property (if the reason is
wrong, the data behind it is in the same response) catching the bug, with
nobody reading it. Fixed by ending the stalled run when a rep was gained.
Same lifter now: 100×6→7→8→9→10 → 102.5×6. Pinned by
`TestProgress_ObedientLifterNeverRegresses`, which asserts the prescribed load
never falls, and verified by disabling the check and watching it fail.

Worth naming why my own tests missed it: `TestProgress_StallTriggersDeload`
used a flat 7/7/7, and `TestProgress_ProgressingLiftIsNotAStall` used a lift
already at the top of the range, which short-circuits the stall check
entirely. Neither covered *climbing inside* the range — where most sessions
actually live. Mutation testing doesn't help here either, because the bug
wasn't a wrong line; it was a missing concept.

**`no_history` was unreachable.** `RecentEfforts` learned an exercise's
`load_type` from the joined catalog row of a set that existed, so an exercise
with no history came back with an empty load type — and the `not_applicable`
guard runs before the `no_history` one. Every exercise in a new user's first
session was told "Not measured in weight — progress this by time or distance
instead", about a barbell squat. The first-timer text was dead code in
production.

The test that should have caught it constructed its input with a fixture that
hardcoded `LoadType: "weight_reps"` — an input the handler can never produce.
Fixed by driving the query from `unnest($2::text[]) JOIN exercises` so every
requested id returns its catalog row whether or not history exists, with the
sets `LEFT JOIN`ed on. That also moved the catalog join out of the window CTE,
where it had been evaluated per set row and accounted for most of the query's
buffer traffic for values that never vary.

The security test had to be re-aimed rather than deleted: every requested id
now yields a map entry, so "did another user's history leak" is no longer "is
the key present" but "did any of their sets come with it". The assertion now
checks `len(Recent) == 0`.

Three smaller review findings fixed alongside: `target_reps` could land
outside `rep_range` on the four "repeat what you did" branches (the range is
the *current* workout's goal, the history may be from a different block);
`sessions_at_load` and `hit_target_effort` shipped as 0/false on the two early
returns, describing the branch rather than the history; and an unusable newest
session (weight logged, reps not) erased a real session behind it, because
only `Recent[0]` was read.

### The query, measured rather than assumed

`RecentEfforts` is the new query and the one that will hurt first at scale, so
it was measured against realistic data rather than the dev database's 149
sessions — which is small enough that Postgres seq-scans it and the plan says
nothing. Seeded 300 athletes × 120 sessions × 21 exercises into the *test*
database (2.4M `session_sets` rows) and ran `EXPLAIN (ANALYZE, BUFFERS)`:

- **30 ms** for a 21-exercise workout against 120 sessions of history.
- Driven by `session_sets_user_exercise_idx` with **both** columns in the
  `Index Cond` (`user_id = … AND exercise_id = ANY(…)`). No sequential scan.
- Postgres pushes the window's `session_rank <= 3` down as a `Run Condition`,
  so it stops ranking early.

The cost scales with **one athlete's own history**, not with table size, which
is the property that matters — but it does grow linearly in that history,
because `DENSE_RANK` has to rank every session to find the most recent three.
A five-year athlete would be a few times slower. Not optimised now: there's no
correct date bound to apply, since a lift untouched for two years still needs
its last session to report `repeat_stale` rather than `no_history`. Recorded
here so the next person doesn't have to rediscover the shape.

One bug was caught in my own wiring rather than by a test: `last_max_reps` is
the session's best rep count while `last_weight_kg` is the *top set's* load,
and I fed both to `EstimateOneRM` — modelling a set that never happened (10
reps at the weight only done for 5) and inflating the estimate by exactly that
fiction. The fields are now named for what they hold, `last_reps` carries the
top set's own reps, and a test pins that the top-set evidence describes one
real set.

## 2026-07-30 — Tests for the strength arithmetic's seams

The strength maths was well covered *within* each function and not at all
*between* them. `onerm_test.go` pins what `EstimateOneRM` returns;
`progression_test.go` pins what `Progress` decides. Neither covered a constant
in SQL that is only correct because of a bound in Go, or a domain rule written
out twice in two files — which is the shape that has bitten this codebase
before, because each side stays internally consistent while drifting from the
other.

**The one that matters most.** `BestOneRMs` cannot run Brzycki in Postgres, so
it narrows candidates with `weight_kg * 1.44 >= heaviest` and estimates the
survivors in Go. That prefilter is sound only if no set can estimate above
`weight × 1.44` — otherwise a genuine personal best is thrown away before Go
ever sees it, with no error anywhere. Nothing checked it.

Writing that test surfaced something real. The obvious assertion —
`est <= weight × multiplier` — **fails**: `EstimateOneRM` computes
`w * 36 / (37 - r)`, which for w=42.5, r=12 is 1530/25 = 61.2 exactly, while
the query passes the pre-divided constant and `42.5 * (36.0/25.0)` is
61.199999999999996. An estimate can land one unit in the last place above its
own bound.

The temptation was an epsilon. Instead the test asserts the property that
actually protects records: **if a set would beat the incumbent, the filter
keeps it.** The ulp gap can only swallow an exact tie, and `BestOneRM`
discards ties anyway (`est <= best` skips), so no record is reachable through
it. Stating the implication says that precisely; an epsilon would have hidden
it.

Also added: `BestOneRM` (Go) against `BestOneRMs` (SQL) over the same history,
the same pairing `TestHistoryAgreesWithSummarise` established; an agreement
test between `EstimateOneRM`'s RPE conversion and `reserveOf`'s, recovered
from outside since the estimator's is unexported; the increment table pinned
explicitly; every branch that returns a weight asserted to return a loadable
1.25kg multiple; and a deload asserted to actually reduce the load.

Each was mutation-verified — Brzycki→Epley, the SQL constant derived from the
wrong ceiling, the RPE scale shifted half a point, RIR/RPE precedence swapped,
the default increment raised, `roundToPlate` dropped from `add_load`, the
deload guard loosened, and the SQL prefilter over-narrowed. All caught.

One mutation was **not** caught — loosening the RPE clamp from `min(rpe, 10)`
to `min(rpe, 11)` — and that is correct rather than a gap: the outer
`math.Max(0, …)` absorbs it, so the two are the same function. Worth recording
because "the test didn't catch it" and "the test is weak" are not the same
finding, and treating the first as the second is how tests get padded with
assertions that pin nothing.

A fixture bug of my own, for the record: the agreement test's data was built so
the best estimate would be the 12 × 100 (144), and it came back 145.38. The two
implementations agreed perfectly — my arithmetic was wrong. 8 × 105 at 3 RIR is
eleven effective reps, 105 × 36/26 = 145.38, beating both the 140 single and
the 12 × 100. A better illustration than the one intended: the best evidence of
a maximum came from neither the heaviest set nor the longest.

## 2026-07-30 — A personal best that silently stopped existing

`BestOneRMs` narrows candidates in SQL before estimating them in Go, because
Postgres can't run Brzycki. The bound is sound: a set can only win if
`1.44 × its weight` reaches the heaviest recorded. The **pool** was not.

`heaviest` is a MAX over the candidates, and candidates were chosen on `reps`
alone — while `EstimateOneRM` refuses on *effective* reps, reps plus reserve.
So a set of 10 at 3 RIR (13 effective) passed the filter, became a candidate,
set the bar at its own weight, contributed no estimate of its own, and pruned
every lighter set in favour of a row that could never score.

Reproduced against Postgres: 100 kg × 10 @ 3 RIR alongside 60 kg × 12 @ 0 RIR
returns **no 1RM record at all**, for an athlete whose log plainly supports
86.4 kg. It surfaces in `best_1rm_kg` on the suggestions endpoint and in the
`estimated_1rm` personal record. Ordinary hypertrophy data — 10 at 3 RIR,
11 at 2, 12 at 2 all exceed the ceiling once effort folds in — so this was not
an edge case, and the comment above the query asserted the opposite.

Fixed by testing effective reps in the filter, mirroring `EstimateOneRM`
exactly: RIR wins over RPE, RPE converts as `10 − rpe`, a set reporting
neither is taken at face value. A non-estimable row can never be the best, so
excluding it from the pool outright is both the fix and the simpler statement.
The added predicate sits in the same Filter position the old one did and
touches no indexed column, so the access path is unchanged.

### How it was found, and why the tests didn't

Two review subagents — different models, separate contexts, neither seeing the
other — were given the same diff and independently found this, reproducing it
with different data. That convergence is the strongest signal available that a
finding is real rather than a plausible-sounding artifact, and it is the
argument for running reviewers fresh rather than continuing one that has
already seen its own conclusions.

The test written specifically to catch this class **passed over it**, twice
over — and the corrections described here are **applied in this same branch**,
in `strength_test.go`.

It asserted "if a set beats the incumbent, the filter keeps it" with the
incumbent taken as `heaviest` — a *weight*. What a winner actually has to beat
is the best surviving *estimate*, and the two coincide only when the heaviest
candidate is itself estimable, which is exactly what fails here. And the
fixture's deliberately-unestimable set used 25 reps, which `reps <= 12`
excluded from the candidate pool entirely — so no fixture row was ever the
thing that matters: a candidate that cannot be estimated.

A second correction, applied alongside: the ulp reasoning in that test was
defending a claim that does not apply. `$4` is inferred as `numeric`, not
`float8` (the operand `weight_kg` is `NUMERIC(6,2)`), and pgx encodes the
float as its shortest round-tripping decimal — so Postgres computes
`42.5 × 1.44` in exact decimal arithmetic. The comment claiming the test
models "exactly the comparison postgres.go makes" is wrong about the
arithmetic, even though its conclusion happened to survive. Both that comment
and the weight-as-incumbent property are now corrected.

## 2026-07-30 — Correcting the tests that missed the bug

Follow-up to the 1RM prefilter fix, on the branch where those tests live.

**The property was wrong.** `TestOneRMBound_NeverDiscardsASetThatWouldWin`
asserted "if a set beats the incumbent, the filter keeps it" with the incumbent
taken as `heaviest` — a *weight*. What a winner actually has to beat is the
best surviving **estimate**, and the two coincide only when the heaviest
candidate is itself estimable. That is precisely the case the bug broke, which
is why the test sailed past it. It now computes the best estimate among the
rows the filter would keep, and asserts against that.

**The agreement test's fixture was the wrong shape.** Its deliberately
"estimable by neither" set used 25 reps — which a reps-only candidate filter
excludes from the pool entirely, so no fixture row was ever the thing that
matters: *a candidate that cannot be estimated*. Verified by reinstating the
bug and watching the test still pass. Added a 12 × 180 at 3 RIR row (15
effective: passes a reps-only filter, scores nothing, and being heaviest sets
the bar). The test now fails on the old predicate with `SQL says 140.0000, Go
says 145.3846` and passes on the fix.

**The ulp comment was wrong about the arithmetic.** `$4` is inferred as
`numeric`, not `float8` — the operand `weight_kg` is `NUMERIC(6,2)` — and pgx
encodes the float as its shortest round-tripping decimal. Postgres computes
`42.5 × 1.44` in exact decimal with a 0.0001 margin, so the float64 hazard the
comment described never arises in the query at all. The Go-side assertion is
still worth making, because Go is where the estimate is computed; the comment
now says which is which.

Two smaller ones: `approx()` is a 0.05 *absolute* tolerance, so using it to pin
a constant whose whole job is to be exactly 36/25 allowed a 3.5% drift (a
ceiling of 11 gives 1.3846 and would have slipped through at a tenth of the
threshold) — now an exact comparison. And the deload test `continue`d on any
non-deload code, so a change to `stallSessions` could have turned all seven
iterations into skips while the test stayed green — it now counts how many
reached the branch and fails if none did.

The through-line: every one of these tests asserted something *true*. They were
weak in what they chose to assert, or in the data they asserted it over, which
no amount of running them would reveal. Mutation testing caught the ones where
a line was wrong; only reading the reasoning caught the ones where the premise
was.

## 2026-07-30 — The web session showed no recommendation for anything you added

Found by the web functional spec on its first honest run, which is the whole
argument for writing it.

`fetchSuggestions` was called once, inside the session page's `load`, on mount.
`addExercise` never refetched. A freeform session starts empty, so that single
call asked about **zero** exercises and returned an empty map — and every
exercise added from the catalog afterwards had no entry in it. No target, no
reason, no rep range, no card at all, until the page was reloaded.

On the surface that is meant to be the *detailed* one for progression, and for
every freeform session, which is the common case.

Mobile never had it, and not by design: adding an exercise there navigates to a
separate screen, and its loader runs under `useFocusEffect`, so returning
happens to refetch. The web page has an always-visible catalog and never
navigates, so nothing re-triggered it.

Fixed with an effect keyed on a **deduped, sorted exercise list**, so it fires
once per change to *which movements are in the session* — not per set, per row,
or per keystroke. That distinction is load-bearing here specifically: this
codebase has twice shipped a hook that fired one request per row, once at 200
concurrent `/v1/profile` calls.

The spec that caught it now passes, and the fix is confirmed by the failure
*moving*: before, "First time" was absent entirely; after, the card renders in
full and the only failures left were two over-reaching assertions of my own.

### Two harness lessons from the same run

`web.spec.ts` still asserts a heading named "Formspan" while the app renders
**VOLA** — stale since the rename, failing on the one test that never signs up.
And the sign-up helper derived its phone number from `Date.now() % 100`, so two
sign-ups in the same second generated the *same* number, Clerk rejected the
duplicate, and it surfaced as sign-up silently never completing — a symptom
pointing nowhere near the cause. I diagnosed that as Clerk rate limiting first
and was wrong; running one test alone, serially, failed identically, which is
what disproved it.

## 2026-07-30 — Two staging deploys that failed in opposite ways

Both found by deploying for real. Neither is visible from the repo.

**The seed never ran, and everything said it was fine.** `preDeployCommand`
was `"/app/bin/migrate up && /app/bin/seed"`. Migrations applied, the
healthcheck passed, the API served 200s, and `exercises` sat at **0 rows** —
precisely the `{"exercises": []}` forever outcome `railway/api.toml`'s own
comment warns about, a valid 200 no healthcheck, error or log will ever
surface. Only counting rows in the deployed database catches it, which is why
the check after a green deploy has to be a query and not a status code.

What is actually **observed**: migrate printed `migrate: up: done` and exited
0; seed produced no output at all. That is enough to pin the mechanism,
because `cmd/migrate` rejects anything but exactly one argument
(`len(os.Args) != 2` → `log.Fatal`). Had it been handed `&&` and the seed path
as extra argv, it would have died on a usage error and failed the deploy
loudly. It didn't — so **Railway discarded everything from `&&` onward while
parsing**, rather than passing it through.

Two wrong explanations were written down before that one, and both are worth
recording because the fix survived them and the reasoning didn't. The first
was `sh -c '...'`. The second was a claim that Railway "splits on
whitespace", which was then used to reject `sh -c` — and which the repo's own
`migrate` code disproves, since whitespace splitting would have produced a
usage error on the very first deploy. The evidence never showed whitespace
splitting; it showed clean truncation at an operator, which is closer to
shell-style parsing than to the opposite.

The fix is unaffected, and deliberately so: the chain moved into
`/app/bin/predeploy`, a script baked into the image, so `preDeployCommand` is
a **single token**. A single token parses identically under every model, which
is the point — the remaining unknown (how Railway treats quotes) can stay
unknown. Verified by running the built image's script against a fresh empty
database: `migrate: up: done`, then 524 exercises and 450 techniques, and a
deliberate failure exits non-zero so a broken pre-deploy fails loudly.

That is the durable lesson, and it is not about Railway. Choosing the form
that depends on no unobserved behaviour was right; inventing a mechanism to
justify it was not, and the invented mechanism was checkable against code
already in the repository. Prefer the robust form *and* leave the mechanism
marked unknown, rather than manufacturing certainty to support a correct
decision.

**Nixpacks could not install dependencies at all** — and the first diagnosis
was wrong, which is the part worth recording.

`web` builds under Nixpacks, and it died in `pnpm i` on
`ERR_VM_DYNAMIC_IMPORT_CALLBACK_MISSING` — an error naming neither Node nor
pnpm, so it reads like a broken lockfile. The build log showed Node 18.20.5
against a repo pinning pnpm 11, which needs Node >=22.13, so the Node version
looked like the answer. Adding `engines.node: ">=22"` to the root
package.json did move Nixpacks to Node 22.19.0 — **and the identical error
persisted.**

The real cause was one line further up the same log: Nixpacks force-installs
`corepack@0.24.1`, which predates pnpm 10/11's bundle format and cannot load
it. Confirmed by reproducing all three cases in a container rather than
reasoning about them:

| setup | result |
|---|---|
| Node 22 + corepack 0.24.1 | fails, identically |
| Node 22 + Node's own bundled corepack | works |
| Node 22 + `npm i -g pnpm@11.17.0`, corepack skipped | works |

Fixed on the service with
`NIXPACKS_INSTALL_CMD="npm install -g pnpm@11.17.0 && pnpm install --frozen-lockfile"`,
which skips corepack and installs exactly what `packageManager` pins. Both
`railway/web.toml` and `railway/admin.toml` now carry the explanation.

The `engines.node` pin is kept: it is correct, matches the Node 22 CI has
always used, and stops Nixpacks choosing Node 18 — but it is a *separate*
axis, and the comments now say so rather than implying it was the fix.

The lesson is about the shape of the mistake, not the tooling. A plausible
cause that matches part of the evidence — Node 18 really is too old for pnpm
11 — is the easiest kind to stop at, because acting on it produces a visible
change. Nixpacks did switch to Node 22. Nothing about that confirmed the
diagnosis, and only the failure surviving the fix did. The check that settled
it was three one-line container runs isolating each variable, which cost less
than the guess did.

## 2026-07-30 — The trace ids the browser was never allowed to read

`withCORS` set `Allow-Origin`, `Allow-Methods` and `Allow-Headers`, and never
`Access-Control-Expose-Headers`. Browsers only let JS read CORS-safelisted
response headers, so the `traceparent` and `x-request-id` the API stamps on
every response were simply **absent from `response.headers`** in the web app.

That made the trace correlation one-way. Both clients were taught to *send* a
`traceparent`; neither could read back the request id the server resolved —
the very value you would log, display, or paste into a log search. No error,
no warning, nothing in a test: the headers are on the wire, visible in curl
and in devtools' network panel, and invisible to `fetch`. Native clients are
unaffected by CORS entirely, which is why the mobile work never noticed.

Fixed by exposing exactly those two. Verified against a running binary rather
than by reading the code: an allowed origin now receives
`Access-Control-Expose-Headers: traceparent, x-request-id`, and a disallowed
one still receives no `Allow-Origin` at all, so the allowlist is intact.

Found because the staging deployment made the headers inspectable for the
first time. Nothing about this was visible locally, where every client is
same-origin or native — CORS only has opinions once a browser talks to a
different host, which is a thing that first happened today.

## 2026-07-30 — iOS build configuration, ahead of a real device

The app has only ever run under Expo Go. Nothing in the repo could produce an
installable binary: `app.json`'s `ios` block held `supportsTablet` and nothing
else — no bundle identifier — and there was no `eas.json` at all.

Added the identity (`com.vola.fitness` for both platforms), build/version
numbers, and three EAS profiles. The choice worth recording is what the
profiles point at: `preview` and `production` both target the **staging** API,
because there is no production API yet. A profile aimed at a host that does
not exist is worse than one aimed at a real one, so `production` moves when
production does and not before.

**`EXPO_PUBLIC_*` is inlined at bundle time, not read at runtime**, which is
why `EXPO_PUBLIC_API_URL` lives in `eas.json` per profile rather than in
`.env.local`. A build made from a developer's machine would otherwise carry
their LAN IP and work on exactly one desk — the kind of thing that looks fine
until a tester installs it.

The Clerk publishable key deliberately stays out of `eas.json` and goes in as
an EAS environment variable. It is publishable and ships in the bundle either
way, so this is not about secrecy: it is about there being one answer to
"where do keys live in this repo", and that answer already being "not in git".

`ITSAppUsesNonExemptEncryption: false` is set because App Store Connect
otherwise blocks every submission on an export-compliance question. The app
uses only HTTPS and the OS keychain, which is exempt.

Deferred, and flagged in `docs/architecture/ios-testflight.md`: no
`expo-updates`, so every JS change needs a fresh build and another TestFlight
round trip. Adding it changes the release model enough to deserve its own
decision rather than riding along with build configuration.

## 2026-07-30 — The local schema migration bricked every fresh install

Found the only way it could be found: by installing the app on a phone that had
never had it. The first launch showed

```
SQLiteErrorException: duplicate column name: remote
```

and every offline feature was dead behind it — the activity outbox, local
sessions, the workout cache, prefs. "Couldn't read local activities", "0 pending
· 0 synced", a Start session button that did nothing.

**The mechanism.** `lib/db.ts` keeps its `CREATE TABLE` statements at the
*current* schema shape, and `migrate()` applies incremental `if (current < N)`
branches. Those two facts are fine alone and fatal together: a device at version
0 runs **every** branch. So `current < 2` creates `local_sessions` from DDL that
already declares `remote`, and then `current < 5` runs
`ALTER TABLE local_sessions ADD COLUMN remote` against it. SQLite rejects the
duplicate, `migrate()` throws, `PRAGMA user_version` is never stamped, and
`getDb()` rejects for the life of the install. The identical pair existed for
`workout_cache.goal`, so fixing only `remote` would have moved the error down
one line.

Not a fresh-install-only bug, and **not new**: it shipped with v5 (`8c5c480`),
which introduced both the `remote` column in `CREATE_SESSIONS` and the
unguarded `ALTER` in the same commit. Any device below v2 took the same path. It
survived this long because every device that had ever run the app already
carried a stamped version and migrated forward through the steps — including
every simulator used for testing. **The upgrade path was exercised constantly
and the install path was never exercised at all.**

**The fix**: an `addColumnIfMissing()` helper that checks `PRAGMA table_info`
before issuing the `ALTER`, with both call sites routed through it.

The alternative — freezing each `CREATE` at the shape of the version that
introduced it, so `ALTER`s can stay unconditional — is the more canonical
design, and it is what the backend's own golang-migrate setup does. It was
rejected here for a specific reason rather than on taste: **it does not repair
the devices that are already broken.** A bricked phone sits at `user_version =
0` with current-shape tables, so an unconditional `ALTER ... ADD remote` crashes
it again identically. The guard is needed for recovery regardless, at which
point freezing adds git-archaeology risk without adding safety. Worth revisiting
from v7 onward as an *addition*, not a replacement.

The per-column guard also turns out to be the only thing that handles the state
a v5-era brick is actually in — `local_sessions` **has** `remote`,
`workout_cache` **lacks** `goal`, version 0. Nothing per-version could fix that
mix. And it quietly closes a second latent brick: under the old code a device
killed after a successful `ALTER` but before the stamp would re-run that `ALTER`
next launch and be permanently broken. `migrate()` is still non-transactional,
which is benign now that every step is idempotent, and noted as the next thing
to tighten if a step ever isn't.

**Recovery needs no reinstall.** An affected device never stamped its version,
so the next launch re-runs the migration: the `CREATE ... IF NOT EXISTS`
statements no-op, both guards skip what already exists, and the version finally
stamps. No data loss.

**The lesson worth keeping**, because it is not the one the code comment above
`SCHEMA_VERSION` already taught: that comment records why a version counter
replaced an earlier column-sniffing guard, and it was right. But a version
counter tells you *which migrations to run*, not *whether they are safe to run
against tables created at today's shape*. Those are different questions, and
only the first one had an answer written down. The invariant — every version
branch must be a no-op against a freshly-created current-shape table — is now
stated where the next person adding v7 will read it, because nothing structural
enforces it.

The testing gap is the same shape as the mutation-testing entry above: the
suite covered the path taken by devices that already worked. `docs/testing/
functional-scenarios.md` gains fresh-install and upgrade-path scenarios, which
is the coverage that would have caught this before a phone did.

## 2026-07-30 — Expo Go can't run this app on a phone, and four wrong turns finding out why

Getting VOLA onto a real iPhone for the first time. The QR scanned, Expo Go
connected to Metro, and then: **"Project is incompatible with this version of
Expo Go."**

**App Store Expo Go is pinned at SDK 54. This project is on SDK 57.** Apple's
review queue is the constraint — Expo's May 2026 changelog records the SDK 55
build still unapproved, and the SDK 57 changelog says plainly that they are
"still waiting on approval." There is no released Expo Go that can load this
project on a physical device, and no amount of updating from the App Store
changes that.

The decision: **do not downgrade to SDK 54** to regain it. Three SDK versions
and a React Native downgrade, to accommodate a review queue, on a project that
already works. Written down as a trade declined rather than overlooked —
especially because from SDK 56 onward `create-expo-app` asks new projects to
choose between App Store Expo Go compatibility and the current SDK, so this is
a permanent fork in the road, not an outage to wait out.

### The four wrong turns, because each is reusable

**1. Checking npm to predict App Store availability.** `npm view expo
dist-tags` reported `latest: 57.0.9`, from which the App Store client "must"
support 57. Those channels are decoupled: npm ships when Expo ships, the App
Store ships when Apple approves. Wrong registry entirely. Only Expo's changelog
and `expo.dev/go` answer the question.

**2. Treating the simulator as evidence.** The simulator ran Expo Go 57.0.5
against this project happily, which looked like confirmation. **The simulator
gets Expo Go from Expo CLI directly, never from the App Store.** A working
simulator says nothing about a phone — the two clients ship through different
channels, and the working one is the channel Apple doesn't gate.

**3. Blaming the iOS 27 beta.** With the local-Xcode path chosen instead,
`xcodebuild` rejected the device: *"iOS 26.5 is not installed."* The phone ran
an iOS 27 beta and Xcode 26.6 ships the 26.5 SDK, so the obvious reading was a
major-version mismatch needing the Xcode 27 beta. That was wrong, and the
disproof was already in the same output: **`Any iOS Device` — a generic
placeholder, not a device — was ineligible with the identical error.** A
placeholder cannot fail for a device-OS reason. The real cause was exactly what
the message said: in Xcode 26 the iOS *device platform* is a separate
downloadable component from the SDK, and it had never been installed.
`xcodebuild -downloadPlatform iOS` fixed it, and both phones became eligible.

**4. Assuming beta access implies membership.** Running iOS betas does not mean
enrollment in the Apple Developer Program — betas have been free since iOS 16.4.
The tell is on-screen: Xcode showed a **"Personal Team"**, which is the free
tier's label, and issued an `Apple Development` certificate rather than
`Apple Distribution`.

The shape of all four: a plausible mechanism, asserted from adjacent evidence,
when the decisive check was cheap and available. Same failure as the mutation
testing entry above — a wrong premise, not a wrong line.

### What the local device path actually requires

`expo prebuild --platform ios` generates `ios/` (gitignored, regenerable from
`app.json`), then `expo run:ios --device <udid> --configuration Release`.
Release, not Debug, so the JS is bundled into the binary and the app runs at the
gym with the Mac asleep — a Debug build still needs Metro on the same Wi-Fi,
which defeats the point.

Four things gate it, each failing in its own misleading way:

- **CocoaPods needs a UTF-8 locale.** With `LANG` unset, `pod install` dies with
  `Unicode Normalization not appropriate for ASCII-8BIT`. `expo prebuild` runs
  `pod install` for you and inherits the empty environment, so prebuild reports
  a CocoaPods failure that has nothing to do with pods. The native directory
  generates correctly; only the install step dies.
- **The iOS device platform must be downloaded** — see wrong turn 3.
- **A signing certificate must exist.** Adding an Apple ID to Xcode creates the
  Personal Team but mints no certificate; Xcode does that lazily. Expo CLI will
  create one, but by prompting for Apple ID credentials. Builds were run with
  `CI=1` so a hidden prompt fails loudly instead of hanging a background process
  invisibly — the certificate was created through Xcode's own UI
  (Settings → Apple Accounts → Manage Certificates → `+`) so the credential
  exchange stayed between the user and Apple.
- **Developer Mode must be enabled on the device**, and the device paired. Both
  are phone-side and need a restart.

The signature expires after **7 days** — Apple's limit on free provisioning, not
something the project can work around.

### What this leaves open

An EAS build sidesteps every device-side constraint here: an app compiled
against the iOS 26.5 SDK installs and runs fine on iOS 27, because forward
compatibility is normal — it is Xcode *directly installing and debugging* that
needs matching device support. So the 7-day local build is a stopgap, and the
durable answer remains a development build once the Apple Developer Program
membership lands. Nothing done here is wasted: the prebuilt `ios/`, the pods,
and `com.vola.fitness` are what EAS uses too.

`docs/architecture/ios-testflight.md` was rewritten to lead with the Expo Go
ceiling rather than bury it, since its previous first instruction — "install
Expo Go from the App Store, scan the QR" — described a path that cannot work at
SDK 57 and is what sent this session down the detour.
## 2026-07-31 — Five screens that turned "I couldn't ask" into a fact about you

Surveying the mobile app before making it work offline turned up something
worse than the offline gap itself: **a rejected promise carries two entirely
different meanings — "the server says there is nothing here" and "I could not
reach the server" — and five places collapsed them into one.** Each then
rendered the first when the truth was the second, which is how a network
failure came to make claims about the athlete.

Two were destructive rather than merely misleading:

- **`app/profile/edit.tsx`** caught *any* failed load and opened the form as a
  first run. So offline it showed an established athlete a blank form, and
  saving it PATCHed `display_name: null, date_of_birth: null, sex: null` over
  their real profile the moment the network returned. The screen did not need
  to be wrong for long — one Save was enough.
- **`app/records/pinned.tsx`** turned a failed `fetchPinned` into `[]`, making
  "couldn't load" indistinguishable from "nothing pinned". It then told someone
  with twelve pinned lifts that they had none, and because `setPinned` is a
  whole-list PUT, one tap from that false baseline would have written a list
  that erased the eleven it never knew about.

The other three lied without deleting: `app/(tabs)/you.tsx` cleared an
already-loaded profile on a failed refocus, showing "Add your name" and
"None chosen yet" to an established user — silently, because its `error` state
was only ever assigned `null` and the banner was dead code.
`app/exercise/[id].tsx` rendered "You haven't logged this yet" whenever the
suggestions call failed, and the bare UUID as the heading whenever the catalog
call did. `lib/useUnits.ts` called `updateUnitSystem` unguarded, so offline the
tick moved, an unhandled rejection fired, and the change never reached the
account or the web app with nothing said.

**The fix is the same shape in all five: distinguish the two meanings, and
withhold rather than invent.** Where the state is unknown, the screens now say
so instead of rendering an empty version of it — the profile form is not shown
at all rather than shown blank, and the pinned list is withheld rather than
drawn with every tick box empty, because an unticked list is the same lie in
another font.

### The thing that made it impossible to do right

`lib/profile.ts` threw a bare `Error`, so nothing downstream could tell a 404
from a dead socket. `updateProfile` worked around that by matching
`/not found/i` **on the message** — which the project's own API conventions
forbid in as many words ("codes are part of the contract; messages are not").
That would have broken silently the day someone reworded the string
server-side, and it also cost two doomed requests offline, since a network
error can neither match the pattern nor create the profile.

So `profile.ts` now throws the same `ApiError` the session module already did,
and the classifiers moved into a new `lib/apiError.ts`. That module is the
answer to "is this worth retrying?", and it exists because there were **two
copies of that answer and they disagreed**: `isPermanentRejection` counted 401
as permanent, while `lib/activities.ts` had an inline copy that counted it as
transient. Activities was right — Clerk tokens are short-lived and `getToken()`
refreshes internally, so a long outbox drain can expire its token partway
through and the next attempt succeeds. Under the session path's answer, one
badly-timed token expiry marked real training data as permanently dead. There
is now one definition, exposed twice (`isPermanentStatus` for callers holding a
raw `Response`, `isPermanentRejection` for callers holding an error) so the
next module can't fork it again.

`isNotFound` is new and is what the load screens branch on.

### What this leaves

None of this is offline support — it is the honesty that offline support has to
be built on, and it lands first precisely because every later phase gets easier
once "failed" and "empty" are different states. The queue that would make an
offline unit change actually reach the account arrives with the sync
orchestrator; until then `useUnits` reports `unsynced` and the Units screen
says plainly that the change is on this phone only.

Worth noting for whoever adds the next screen: the invariant is that **an empty
state may only claim "you have none" after a successful read.** Nothing
structural enforces it.

## 2026-07-31 — A replaced picture that reached nobody

Swapping an exercise image in R2, under the same filename, changed nothing on
the phone. Not a slow propagation — a permanent one.

The URL was a plain concatenation, `MEDIA_BASE_URL + "/" + storage_key`, and
storage keys are stable by design: an exercise's thumbnail is
`.../thumbnail.webp` for as long as the exercise exists. So new bytes arrived
at a byte-identical URL, and every cache in the path did exactly what it is
supposed to do. Three of them, in the order they bite:

1. **`expo-image`'s disk cache on the phone**, which is keyed by URL and
   **never revalidates**. A device that loaded the old picture keeps it until
   the app is deleted. There is no in-app cache-clear. This is what turns a
   caching annoyance into a permanent one, and no amount of work on the bucket
   touches it.
2. **Cloudflare's edge**, serving what it holds.
3. **No `Cache-Control` on the objects at all** — R2 returns only `ETag` and
   `Last-Modified`, so caches apply *heuristic* freshness, which lengthens as a
   file ages and is unpredictable by construction.

**The fix: version the URL.** `?v=<exercise_media.updated_at>` makes new bytes a
new resource, which is the one lever all three layers honour. The bucket ignores
the parameter and returns the object — checked against the live bucket rather
than assumed, same `ETag`, HTTP 200.

`updated_at` was already on the table and simply unused. It is folded into the
URL rather than exposed as a JSON field, because no client needs to *read* it —
they need the URL to differ, and it does. Adding contract surface nothing
consumes is how a contract becomes hard to change. What the contract does now
say, loudly, is that `url` is **opaque**: rebuilding it from `storage_key`
throws the version away and reinstates the entire problem.

### The part that isn't in the code

Versioning only helps if `updated_at` moves, and **uploading to R2 touches
nothing in Postgres.** Worse, re-running `cmd/seed` doesn't help either: its
upsert guard only writes when `(storage_key, content_type, width, height)`
differ, so a pure byte swap is invisible to the database. That guard is right
for its purpose — don't churn rows — but it means the database genuinely cannot
know the picture changed.

So the recommended workflow is **not** "keep the filename and bust the cache".
It is **put a content hash in the storage key** — `thumbnail.a3f9c1.webp`. The
seed's guard then fires by itself, `updated_at` bumps, the parent exercise is
touched (which is what lets a delta-syncing client learn an image changed at
all), and the failure mode stops existing rather than being worked around. The
`?v=` mechanism is the safety net for the times someone doesn't, and for the
524-asset backfill now in progress it costs nothing to generate hashed names
from the start.

### Left open, and worth fixing before real users

**`MEDIA_BASE_URL` points at an `r2.dev` URL.** That is Cloudflare's development
endpoint — rate-limited, and with no zone attached, which means **there is no
cache-purge API for it**. Once the edge holds an object, waiting is the only
option. A custom domain restores purge and `Cache-Control`. Recorded in
`deployment.md` rather than fixed here because it is an infrastructure change,
not a code one.

**No `Cache-Control` is set at upload.** With versioned URLs the correct value
is `public, max-age=31536000, immutable` — caching forever is right precisely
because a URL can never mean different bytes.

**The sport placeholders have no row**, so their version is a hand-maintained
constant, `defaultMediaRevision`. A stale constant is at least a visible mistake
where a missing mechanism was not, and a test now fails if a placeholder ever
loses its revision.

The unit test pins the property the whole change exists for — different
`updated_at`, different URL — and was verified by breaking it: pinning the
version to a constant still compiles, still returns 200, and is silently
useless, which is exactly the failure a reader would not spot.

## 2026-07-31 — Today stops showing its own plumbing

Today was still the first vertical slice with three layers of scaffolding on
display: a **"Log a BJJ session"** form with `kind` hardcoded to
`bjj_session`, a raw list printing that string at the athlete as a label, and a
permanent **"0 pending · 0 synced"** readout with a Sync now button. None of it
answered the question someone opens the tab to ask.

**BJJ is off Today, temporarily and for a stated reason.** There is no BJJ
module — 20 catalog entries against strength's 498, and nothing behind them —
so a start button advertised a room with no floor. It made the screen look
complete while doing nothing useful, which is worse than offering less. The
constant carries the reason so it comes back when the module lands rather than
being quietly forgotten. **Running is in the identical position** (6 entries, no
module) and was left in place deliberately: the same argument applies, but it
wasn't the thing asked about, and one of them shouldn't drag the other out by
implication.

**What the screen does now**, in priority order, because hierarchy was the real
problem:

- **An unfinished session dominates.** It is the only thing on the screen with a
  clock running, and it used to sit inside a list wearing a small "in progress"
  label — which made the one urgent thing look exactly like the four finished
  ones. It is now a card with a live elapsed timer and a Continue button.
- **Otherwise, starting one dominates.** One primary action; the secondary sport
  is present but not competing.
- **This week** — sessions, volume, distinct days. Computed from the *local*
  store, not fetched: Today has to answer on a gym floor with no signal, and it
  also cannot then disagree with the list directly beneath it, which a
  separately-fetched rollup eventually would.
- **Pending sync appears only when non-zero.** "0 pending · 0 synced" reassured
  precisely when nobody needed reassuring, and trained the eye to skip the row
  on the day it finally said something.

The elapsed clock recomputes from `started_at` each tick rather than
incrementing, so it cannot drift and returns correct after the screen has been
backgrounded. It only ticks while a session is open, so an idle Today costs
nothing.

The empty state is gated on a completed local read, holding the invariant the
profile and records screens adopted a day earlier: **an empty state may only
claim "you have none" after a successful read.**

### What this orphans, said plainly

`lib/activities.ts` now has **no caller anywhere in the app**. The table, the
outbox flag, `POST /v1/activities` and the admin console's activity view all
still exist and still work — but nothing creates activities, so the admin list
will only ever show historical rows.

Kept rather than deleted: the machinery is proven end to end and is exactly what
real BJJ logging will write through, so rebuilding it later would be strictly
worse. The alternative — keeping a fake button so a demo surface stays
populated — is the thing this entry is about removing. The module now says all
of this in its own docstring, because "unused" and "deliberately dormant" look
identical from the outside.

### Also in this change

`.gitignore` gained three entries, one of them overdue: **`secrets.txt` was
never ignored.** It appears in the repo root periodically containing a live API
key, and the standing instruction was to remember not to commit it — which is
not a mechanism. A single `git add -A` would have published a credential to a
public remote, and `git add -A` is precisely what "commit everything" reaches
for. Also ignored: `*.bak` (an `.env.local.bak` does not match `.env.*.local`,
so a backup taken before editing an env file sat in `git status` as an ordinary
untracked file carrying whatever keys the original held) and
`.claude/worktrees/` (whole checkouts; committing one nests the repo inside
itself).

And the Postman collection generated from the OpenAPI spec by
`scripts/build_postman_collection.py` — generated rather than hand-written
because a hand-maintained collection drifts from the contract silently, and you
find out when a request 404s against a route renamed months ago.

## 2026-07-31 — Making "is anything wrong?" a question with an answer

The logs already carried every request. They could not answer a single question
anyone actually asks.

They go to stdout and are read through Railway's viewer: **not queryable from
the admin console, expiring, and carrying no `user_id` at all.** So "this
athlete says their training isn't syncing" had no query behind it — you could
see that *someone* got a 500, never who. That is not an awkward log format; it
is a missing field that made the whole stream unusable for support.

Three things now exist.

**`user_id` on every request line.** Cheap, and the single highest-value field
in the whole change. It needed one piece of plumbing that is worth writing down:
`httplog` is the *outermost* middleware — it has to be, to time and correlate
everything inside it — while authentication happens further in. A context value
set by inner middleware is invisible to the outer one when control returns, so
the id cannot travel outward as an ordinary value. It travels through a pointer
instead: the middleware puts a mutable slot in the context, and `RequireAuth`
fills it. Set in the auth middleware rather than per-handler, because something
every handler must remember to do is something a handler eventually forgets.

**A `health_events` table**, because the admin console cannot query stdout.
**Only notable events are recorded, never every request** — a row per request
puts a database write on the hot path of every call, and the healthy case is
precisely the case with nothing to say. What lands there is 5xx and requests
past a latency threshold (2s default, `SLOW_REQUEST_MS` to override, since a
Railway instance and a laptop disagree about "slow").

4xx are deliberately excluded. A 404 for a deleted session and a 401 for an
expired token are ordinary, and filling an operator's screen with routine client
mistakes is how a health page becomes one nobody opens. On a healthy system this
table stays near-empty, and that emptiness is the signal.

**`POST /v1/client-errors`**, which is the part that matters most and the part
with no server-side substitute. When a push is permanently refused the mobile
client stops retrying — correctly — and at that moment the training exists only
on that device while *every API metric stays green*, because the request that
would have carried it is never made again. There is no server-side observation
of this failure. Only the client knows, so only the client can say.

### Measured versus claimed

The two feeds are kept distinct throughout — `source` on the row, a badge on the
screen — because their trustworthiness differs and an operator has to know which
they are looking at before acting.

That distinction is enforced, not just labelled. A client may report only
`client_error` and `sync_blocked`; it cannot claim `server_error` or
`slow_request`, and the user is attributed from the verified token rather than
the request body. A client that could name the user could file noise against
someone else — and, more corrosively, could not be trusted when reporting its
own trouble, which is the entire value of the endpoint. Message length is
bounded so the endpoint cannot become free storage.

Reporting is fire-and-forget by construction: never throws, never blocks, never
retries. A device that cannot reach the API to *sync* cannot reach it to
complain either, and queuing failed reports would build a second outbox whose
failure mode is indistinguishable from the first — while spending exactly the
connectivity the real outbox needs. Losing a report is acceptable; losing
training data is not. The two are ranked rather than balanced.

### The admin screen

`/health` shows a summary over the last 24 hours and the events behind it, in
one response — a summary alone invites "12 errors" with no way to see them, and
a list alone makes an operator count.

**Affected athletes is counted distinctly, not as a total.** Twenty rows from one
person on a bad connection is a very different morning from twenty people
hitting one broken endpoint, and a raw count cannot tell them apart. Each row
carries its `request_id`, which is the pivot the table exists for: the row says
*that* something went wrong, the log line says what the request was doing.

`proxy.ts` gained `/health(.*)` — it had only ever matched `/users(.*)`, so a
new admin surface would have reached the layout's own allowlist check instead of
a sign-in prompt. The layout does refuse them, but "protected" belongs declared
once rather than rediscovered per screen.

### What this leaves open

**Retention.** The table grows with every incident and nothing prunes it. There
is no scheduler in this project yet, so the honest answer today is that it is
small and bounded by how often things break — but it is a real gap, and the
first thing to revisit if the health screen ever slows down.

**Nothing reports `client_error` yet.** The only wired reporter is the permanent
sync rejection on the session screen — the one signal that genuinely exists
today. The richer source, an outbox row that has exhausted its retries, arrives
with the sync orchestrator, and the endpoint is deliberately in place first so
that work has somewhere to report to.

**A panicking handler is still invisible.** `net/http` recovers per connection
*above* this middleware, so a panic produces neither a log line nor a recorded
event — the most severe 5xx class is the one class this cannot see. Closing it
means a recover layer in `httplog`, which changes what a panicking request
returns, so it wants its own decision rather than riding along here.

**No rate limit on `POST /v1/client-errors`.** One authenticated client can
insert unbounded rows, which both grows a table nothing prunes and pushes other
athletes' events below the default view — degrading the screen exactly when it
is needed. Nothing in this stack rate-limits anything yet, so adding it only
here would be a lone convention; the cheap version when it matters is a per-user
hourly cap or dedupe on `(user_id, kind, error_code)` within a window.

### The bug the review caught, which is the interesting part

The recorder originally wrote **synchronously** from the middleware, on the
reasoning that the request had already been served by then. That reasoning was
wrong, and measurably so: `net/http` buffers the response and only flushes once
the entire middleware chain returns, so a slow insert delayed the client's first
byte by its own duration — a 2s stall produced a 2s time-to-first-byte.

Which made the failure mode precisely inverted. During an incident where the
database is struggling and everything is 5xx-ing, every one of those failing
requests would then queue behind an INSERT into that same struggling database,
adding seconds to a response that had already failed. **The observability would
have amplified the outage it existed to observe.**

It now hands events to a writer goroutine through a small buffered channel, and
**drops rather than blocks** when that fills. Under a storm the choice is
between losing some observability and slowing every request, and a health system
that degrades the service it watches has inverted its purpose. Drops are counted
and logged so the gap is visible rather than silent.

Worth recording because it is the same shape as the mutation-testing and
fresh-install entries above: a plausible premise ("the response is already
sent"), never checked, that a green test suite could not contradict.

## 2026-07-31 — The front door was on a different device

A mobile-first training app shipped without a way to create an account on the
phone. `app/sign-in.tsx` had been sign-in only since Phase 2, where the scope
was deliberately "obtain a real session token so the app can call authenticated
endpoints" — correct then, and quietly wrong ever since. A new athlete had to
find the deployed web app, register there, and know to set a password (mobile
sign-in is email+password, so an OAuth-only web signup would leave them locked
out of the phone). Nobody was going to do that standing in a gym.

`app/sign-up.tsx` closes it: email + password, then the emailed six-digit code,
then straight into the app.

### The bug that would have made the whole screen unreachable

The root layout's auth guard read:

```ts
const onSignIn = segments[0] === 'sign-in';
if (!isSignedIn && !onSignIn) router.replace('/sign-in');
```

Adding a route is normally additive. Here it is not: a signed-out user — which
is *every* user of a sign-up screen — opening `/sign-up` matches `!onSignIn`,
and gets replaced back to `/sign-in` on the next effect tick. The screen would
have rendered for one frame and vanished, and the tempting diagnosis would have
been the new file rather than the six-month-old line that never mentioned it.

Found by reading the guard before writing the screen rather than after, which is
the only reason it isn't a debugging story. It is now keyed on a *set* of auth
routes, with a comment saying why it is a set — because the next person adding
`forgot-password` will hit exactly this.

### Three UX properties, each of which is a specific failure it avoids

**Errors land on the field that caused them.** Clerk tags every error with
`meta.paramName`, so "that email is taken" is routed under the email input
rather than pooled into one message at the bottom of the form. The fallback is
the honest part: a failure with no `errors` array at all — no signal, DNS, a
5xx — becomes a single form-level message, because nothing about the input is
known to be wrong. Same discipline as the honest-failure-states work: don't
report a fact you didn't establish.

**An interrupted sign-up resumes where it stopped.** Clerk keeps the in-flight
`signUp` on the client, so the mount effect restores the verify step from
`status === 'missing_requirements'` + `unverifiedFields`. Without it, an app
killed between "create" and "verify" — a phone call, a swipe-up, iOS reclaiming
memory — reopens on a blank form that then rejects *its own* half-registered
email as already taken. That is a dead end with no exit but a second email
address, and it happens at the single least forgiving moment in the product.

**And that feature shipped dead**, until the review caught it. Writing the
resume effect is only half of it: a relaunched app is signed-out, and the root
guard's answer for signed-out is `/sign-in`. So the screen that knows how to
resume was never the screen the user arrived at, and password sign-in against an
unverified account fails with an error that mentions nothing about sign-up. The
guard now checks for a pending sign-up and prefers `/sign-up` for that case.

Worth recording because of the shape, which this log keeps finding: **a
mechanism verified in isolation, whose trigger was never checked.** The effect
was correct. It just never ran. Same family as the `completed` flag that was
written but never read back, and the `updated_at` that could be dropped from a
SELECT without failing a single test.

**The password rule is stated before it is enforced**, and only the rule that
can be backed. The 8-character minimum is Clerk's documented default and is
shown live from the first frame; nothing else is asserted, because the
instance's full password config hasn't been read and inventing a rule list would
be the same failure as inventing a data field. Whatever else Clerk rejects is
surfaced verbatim under the field.

### Three smaller things the review found, all the same kind

Each is a state the screen could reach and then describe wrongly — the failure
mode this codebase has spent several entries learning to distrust:

- **The verify heading said "we sent a code to you" even when the send was
  exactly what had just failed**, and on a resumed sign-up, where whether a
  code is waiting is genuinely unknown. Now gated on an actual successful send,
  with neutral copy otherwise.
- **A `setActive` that failed after a successful verification left a dead
  button.** The verification is spent, so tapping Verify again could only
  produce a confusing rejection; the escape existed but ran through relaunch →
  "email taken" → sign-in. The button now becomes **Continue** and retries only
  the activation.
- **`maxLength={6}` on the code field truncated pasted input natively**, before
  the sanitizer could strip the space out of `"123 456"` — five digits, no
  explanation. Removed; the existing `.slice(0, 6)` already bounds it.

### One non-obvious ordering decision

If `signUp.create` succeeds but `prepareEmailAddressVerification` throws, the
screen still advances to the verify step and shows "tap Resend". Returning to
the details form would be worse than useless: the account now exists, so
resubmitting it would report that the email is already taken — about the
half-registered account created one line earlier. The verify step's Resend *is*
the retry for a failed code send, so that is where the user belongs.

### What is not verified

Neither browser nor simulator could render this, and both for reasons unrelated
to it:

- **Expo web won't bundle at all.** `expo-sqlite`'s web build imports
  `./wa-sqlite/wa-sqlite.wasm`, which isn't present in the pnpm store, and
  Expo Router's `require.context` pulls every route into one bundle — so
  `(tabs)/library.tsx` → `lib/sessionStore.ts` → `lib/db.ts` breaks the build
  for `/sign-up` too. Pre-existing on `main`, not caused here, and not worth
  fixing inside a sign-up PR.
- **The iOS Simulator is gated** on a device-access grant that is pending.

So: typecheck and the full CI-equivalent suite pass, and the frontend reviewer
ran. Layout — the reveal button overlapping the password input, the
letter-spaced code field, behaviour on an SE-sized screen — is **unproven** and
wants one pass on a real device before this is trusted.

One layout decision was made specifically *because* it can't be tested here.
`KeyboardAvoidingView` with `behavior="padding"` needs a `keyboardVerticalOffset`
equal to the nav header's height, and reading that height means importing
`useHeaderHeight` from `@react-navigation/elements` — which pnpm's strict
`node_modules` doesn't expose, since nothing declares it directly. Rather than
add a dependency to compute a number, the screen uses the scroll view's
`automaticallyAdjustKeyboardInsets`: UIKit doing the same job natively, header
included, and a no-op on Android where Expo's `resize` mode already handles it.
The content also still scrolls by hand, so the worst case is inelegant rather
than unreachable — which is the property to want when you can't see the screen.

### What review caught, and one thing my own mutation test did

**The screen opened on yesterday.** `viewDay` was a `Date` captured at mount and
refreshed by nothing, while `now` re-reads on focus and on AppState. Leaving the
app on Today overnight therefore reopened it in *past mode* — yesterday in the
switcher, plans dimmed and marked "Not logged" — with the athlete having
navigated nowhere. It is a day **offset** now, derived from `now`, so every
refresh re-derives it and the class is gone rather than patched at the two
places that happened to refresh.

**A blanket `opacity: 0.55` on the past card** composited every ink inside it:
"Not logged" fell to 1.96:1 and the BJJ eyebrow to 2.51:1 — the latter being the
exact figure the palette cites as its reason for banning `textDim` from a done
row, and failing specifically for this app's headline discipline. The card is
not dimmed at all now; "Not logged" is `warn` at full strength, which is also
what it means.

And one that arrived from my own mutation testing rather than from review: the
first fix for the outside-the-week bug passed *two* plan lists and matched their
union. Three mutations of it stayed green, which is how it came out that the
wider list was **inert** — `matchPlans` groups by day, so plans on other days
can never compete for this day's sessions, and plans on the same day are the
same rows. A parameter that cannot change the answer reads as a safeguard and is
scenery. `owedOn(sessions, dayPlans)` is what was ever needed.

### Gaps this leaves

- **No password reset**, which is now the most urgent hole in mobile auth and is
  worse than the one just closed: an athlete who forgets their password has no
  route back into the app from the phone at all. It belongs on `sign-in.tsx`.
- **No OAuth.**
- **No terms/privacy consent**, because there is no terms or privacy URL to link
  to. Left absent rather than linked to a page that doesn't exist.
- **iOS Strong Password won't actually offer** in Expo Go — the AASA/associated-
  domains setup needs a custom dev client. `textContentType="newPassword"` is
  still correct markup and costs nothing, but it does not work today.

## 2026-07-31 — Forgetting a password stops costing you the account

Sign-up (above) closed the front door; this closes the one that mattered more.
An athlete who forgot their password had **no** route into the app from the
phone — and unlike the sign-up gap there wasn't even a workaround, because
"reset it on the web app" is only advice you can follow if you already know the
web app exists. `app/forgot-password.tsx`: emailed code, new password, straight
into the app.

### The window where the password has changed and you are not signed in

This is the thing that makes reset different from the other two auth screens,
and it isn't obvious from the API. Clerk's `attemptFirstFactor` with
`reset_password_email_code` **sets the new password and then tells you whether
the account still needs a second factor.** So on a 2FA account there is a real
interval where the password is already updated and the user is not yet signed
in.

Getting the copy wrong there is not cosmetic. A screen that says "enter your
authenticator code" and nothing else invites someone to give up believing
nothing happened — and then reset again, which invalidates the password they
now actually have. Every path past that call says the password is saved: the
second-factor step, the unsupported-factor message, and the footer link back to
sign-in.

### Telling the truth about an unknown email, on purpose

The standard advice is neutral copy — "if an account exists, we've sent a
code" — so reset can't be used to test whether an address is registered. It is
good advice when it works. It doesn't work here: **`sign-up.tsx` already leaks
exactly the same fact**, unavoidably, by refusing to reuse a taken address. So
neutral wording on reset alone would close nothing while costing a real user —
the one who mistyped their address — a silent wait for an email that was never
going to arrive.

Recorded rather than just done, because the reasoning has a dependency: if
sign-up ever stops leaking it, this must change *with* it, not on its own. A
future reader finding non-neutral reset copy should be able to tell it was a
decision and what would invalidate it.

### Two extractions, one of which had a real bug in it

`lib/clerkErrors.ts` (error→field routing) came out of `sign-up.tsx`, and
`lib/secondFactor.ts` (2FA selection and preparation) out of `sign-in.tsx`.
Reset needs both — and it reaches `needs_second_factor` by a completely
different route than sign-in does, which is precisely why that logic shouldn't
have had two copies.

The second-factor extraction is the one worth noting. Typing the factor list as
a hand-written `{ strategy: string }` **compiled**, and silently invalidated the
two casts inside it — `phoneNumberId` and `emailAddressId` exist only on their
respective variants of Clerk's union, so the narrowing is what makes those casts
safe. Deriving the type from Clerk's own
(`NonNullable<SignInResource['supportedSecondFactors']>[number]`) is what caught
it. A restated type is a type that stops matching.

### What the review found, which was the same failure twice

The blocking finding was a path where the screen would have said the wrong
thing at exactly the moment it exists to say the right one. Preparing an
emailed second factor is a **network call**, and email code is this instance's
configured method — so it is the common path, not an exotic one. It sat inside
the same `try` as `attemptFirstFactor`, so a flaky network there produced
"Something went wrong, check your connection and try again" over the reset form
with a now-spent code still in it — while the password had, in fact, already
changed. The generic retry message and the footer saying "Password saved"
contradicted each other on the same screen.

`sign-up.tsx` had already established the fix a few hours earlier, for the same
reason in different clothes: create-then-prepare, where "the account exists from
here on" meant the prepare failure must not send you back to the form. Here the
invariant is "the password is saved from here on", and it wasn't honored. Worth
recording because the lesson didn't transfer on its own — the pattern was known,
written down, and still not applied to the next screen that needed it.

Two smaller ones of the same family, both now fixed: the catch-all status branch
asserted the password was saved for *any* unrecognised status, including
`needs_new_password`, which means precisely that it wasn't; and `setActive({
session: null })` is a legal *deactivate* call that resolves, so a null session
id would have navigated nowhere and reported nothing.

The review also killed three casts. Two were mine and one was inherited: the
`email_code` prepare cast dated from a Clerk version whose types genuinely
omitted `email_code`, and at the pinned version they don't — it had been
suppressing type checking on those props for nothing. Deleting it and
recompiling was the whole verification. The per-factor `phoneNumberId` /
`emailAddressId` casts went too, since TypeScript's inferred type predicates
narrow `.find((f) => f.strategy === '…')` to the right variant on their own.

And one piece of state got deleted rather than fixed: `codeSent` became
write-only once its only reader turned out to be an unreachable branch. This
codebase has been bitten by a written-but-never-read flag before (the
`completed` one that zeroed every session's volume), so a write with no reader
now gets removed rather than left looking load-bearing.

### What review caught, and one thing my own mutation test did

**The screen opened on yesterday.** `viewDay` was a `Date` captured at mount and
refreshed by nothing, while `now` re-reads on focus and on AppState. Leaving the
app on Today overnight therefore reopened it in *past mode* — yesterday in the
switcher, plans dimmed and marked "Not logged" — with the athlete having
navigated nowhere. It is a day **offset** now, derived from `now`, so every
refresh re-derives it and the class is gone rather than patched at the two
places that happened to refresh.

**A blanket `opacity: 0.55` on the past card** composited every ink inside it:
"Not logged" fell to 1.96:1 and the BJJ eyebrow to 2.51:1 — the latter being the
exact figure the palette cites as its reason for banning `textDim` from a done
row, and failing specifically for this app's headline discipline. The card is
not dimmed at all now; "Not logged" is `warn` at full strength, which is also
what it means.

And one that arrived from my own mutation testing rather than from review: the
first fix for the outside-the-week bug passed *two* plan lists and matched their
union. Three mutations of it stayed green, which is how it came out that the
wider list was **inert** — `matchPlans` groups by day, so plans on other days
can never compete for this day's sessions, and plans on the same day are the
same rows. A parameter that cannot change the answer reads as a safeguard and is
scenery. `owedOn(sessions, dayPlans)` is what was ever needed.

### Gaps this leaves

- **OAuth** is now the only auth path still missing, and it is a want rather
  than a hole — every account is reachable without it.
- No terms/privacy consent anywhere in auth, still, because there is no URL to
  link to.
- `forgot-password.tsx` duplicates ~80 lines of `StyleSheet` from
  `sign-up.tsx`. A deliberate call: extracting shared auth styles would mean
  churning a screen that merged an hour earlier and is still not device-verified.
  Worth doing once both have been seen on a phone.
### Then they were actually run

Simulator access was granted and all three auth screens were driven on a booted
iPhone 15 Pro (Expo Go, SDK 57). What that proved, and what it didn't:

**Verified live.** The `AUTH_ROUTES` guard — tapping "Create an account" reaches
sign-up and *stays* there, which is the failure that would have made the whole
screen unreachable. Sign-in shows both new links. Local validation on sign-up
flags both fields, focuses the offending one, and the content scrolls clear of
the keyboard, which settles the `automaticallyAdjustKeyboardInsets` bet made
blind. The email keyboard carries `@` and `.` and a `next` return key.

**The best single result** was the unknown-email path against real Clerk: it
returns `form_identifier_not_found`, and the message lands *under the email
field* rather than in a generic blob — which is the `identifier` param mapping
added to `lib/clerkErrors.ts` this round, proving itself on a live response
rather than by reading the code. The "create an account with that email instead"
affordance fired with it.

**One real defect found, which only looking could have found.** The password
placeholder read "At least 8 characters" directly above a hint reading "• At
least 8 characters" — the same six words, stacked, on both sign-up and reset.
Every check in the suite passed with that on screen, and the reviewer couldn't
see it either; it is a rendering fact, not a code fact. Placeholders are now
"Create a password" / "Enter a new password" and the hint keeps the rule.

**Still unverified, honestly:** the reset step's *behaviour*, and the whole
second-factor branch. Both need a real emailed code, which needs a real inbox.
The reset step's **layout** was inspected by forcing the step locally (reverted)
— code field centring, the reveal button, the resend row all correct. The 2FA
branch has been reasoned about and never executed.
## 2026-07-31 — Web keeps Clerk's auth UI, and finally looks like it owns it

A question worth writing down because the answer isn't the obvious one: does
any of the mobile auth work apply to web? **None of it.** `apps/web` and
`apps/admin` each hand the entire flow to Clerk's prebuilt
`<SignInButton mode="modal">` — twelve lines apiece — while `apps/mobile` is
~1,400 lines of hand-built screens on the headless hooks.

That asymmetry is right and stays. Mobile needed the *flows* designed: errors
that don't lie when the network drops, a sign-up that resumes after iOS kills
the app, a code that may or may not have been sent. None of those pressures
exist at a desk. Clerk's component already does sign-in, sign-up, password
reset, OAuth and 2FA correctly there, and a third hand-rolled copy would carry
risk without carrying a product opinion.

So web was never *missing* sign-up or reset — that is precisely why "register
on the web app first" was the workaround while mobile had neither. What was
wrong is that it looked like Clerk instead of like VOLA.

### Two things found by opening the page, which nothing else would have caught

**The landing page's only call to action was invisible as a button.**
`SignInPrompt.tsx` styled it `bg-foreground text-background`. Neither token is
in this app's `@theme`, so Tailwind emitted nothing at all and
`getComputedStyle` returned `rgba(0,0,0,0)` — plain black text on the grey
ground, on the public entry point of the customer app. It typechecked, it
linted, it built, and it shipped. Tailwind's failure mode for an unknown
utility is silence, which makes "look at it" the only detector. Now
`bg-accent-fill` / `text-accent-on-fill`, the pair the theme defines for solid
controls.

**Every athlete signing in read "Sign in to Formspan dev".** Clerk composes its
titles from the application name in the Clerk dashboard, and the VOLA rename
covered the repo and the code but never the external service accounts. A
`localization` override fixes the two customer-visible strings. It is a patch
over a wrong setting, not a fix for it — **Clerk's transactional emails are
generated server-side and still say Formspan** until someone renames the
application in the dashboard.

### The styling decision worth keeping

`appearance.variables` are **`var(--c-*)` references, never hex literals.**
Web is light-first with an opt-in dark mode that `ThemeScript` applies to
`<html>` before hydration. Because the vars resolve at paint time against
`:root`, the modal inherits the theme for free: no theme detection, no second
config, and nothing rendered server-side that the client then contradicts.

Verified rather than assumed, and the first version of this paragraph was
wrong. Opening the modal under each theme gives the right result both ways, and
the primary button *inverts* — navy-on-lime in light, lime-on-navy in dark —
because `--c-accent-fill` and `--c-accent-on-fill` swap between the two blocks.
That inversion is the design system's own intent (the brand lime is only
legible as a fill against dark; on light it has to be a rule or a tint) and it
came out for free from naming the semantic pair rather than a colour.

What is **not** true, and was claimed here first time round: that the modal
re-themes *live*. Clerk resolves `variables` when the modal mounts and does not
re-resolve them afterwards, so flipping `data-theme` with the modal already
open leaves the card and button on stale colours. The `elements` classes, being
ordinary CSS, do follow — which is what made the earlier reading look like a
success, since the one thing that visibly changed was the piece backed by a
real CSS rule.

It doesn't matter today, and the reason is worth writing down: `ThemeToggle` is
rendered only by `dashboard/layout.tsx`, behind auth. A signed-out user looking
at this modal has no control that could change the theme. `ThemeScript` has
already applied their stored preference before hydration, so the modal only
ever mounts into a settled theme. **Add a theme toggle to the public landing
page and this becomes a real bug** — the modal would need remounting on theme
change. Recorded because that future change looks completely unrelated to this
file.

### Cascade layers, and why three-quarters of the styling was silently dead

The best finding of the change, and it came from review rather than from me.

Clerk's `appearance` has two surfaces: `variables`, which it resolves into its
own stylesheet, and `elements`, which appends class names to its markup. The
variables all worked. **Three of four `elements` overrides did nothing at all** —
`card: "border border-line"` computed `border-width: 0`, `footer: "bg-surface"`
computed `rgba(0,0,0,0)`, and `footerActionLink: "text-lime"` never applied.

My first diagnosis was "Clerk's styles win on specificity, so put colour in
`variables` and keep `elements` nearly empty." That was wrong about the
mechanism and therefore wrong about the fix. The real cause is **cascade
layers**: Tailwind v4 emits utilities inside `@layer utilities`, Clerk injects
its stylesheet **unlayered**, and an unlayered declaration beats every layered
one regardless of specificity or source order. No amount of class-writing was
ever going to win.

Clerk's own `Appearance` has the escape hatch: `cssLayerName`. Setting
`cssLayerName: "clerk"` and declaring `@layer theme, base, clerk, components,
utilities;` **before** the Tailwind import in `globals.css` (the first `@layer`
statement fixes the order) puts Clerk's CSS in a layer our utilities outrank.
Verified behaviourally rather than reasoned: with the layer named, a throwaway
`card: "bg-warn"` turned the card amber — something the identical mechanism
could not do minutes earlier.

**The sharp edge, which is the part worth remembering.** That fix makes
previously-inert config suddenly live. Had `cssLayerName` been added while the
original `elements` block was still in place, it would have *introduced* an
accessibility failure: `footerActionLink: "text-lime"` on the light theme is
`#6f9c00` on white, **3.27:1**, under AA for small text. It had been harmless
purely because it was broken. It stays out; Clerk's own link colour derives
from `colorPrimary` and is navy on light at 18.28:1.

Two more measurement lessons from the same pass:

- **Dark mode could not detect the dead link style.** In dark, `--c-lime` and
  `--c-accent-fill` are the same colour, so the link looked exactly as intended
  whether the class applied or not. Only light, where the two differ, exposed
  it. Anything styled here gets checked in **both** themes.
- **A stale portal node produced a measurement that contradicted the
  screenshot.** `document.querySelector(".cl-formButtonPrimary")` matched a
  detached node from a previous modal instance; scoping to `[role=dialog]`
  fixed it. When a measurement and a picture disagree, the picture is what the
  user gets — the picture was right both times.

### Two colours deliberately not branded

`colorNeutral` was left at Clerk's default, which is literally `black`, and it
drives borders, dividers, hover fills and focus rings. On the dark theme that
derives all of them from black against a near-black surface. Now
`var(--c-text)` — the token that already flips ink direction per theme — with
`colorModalBackdrop` pinned to `var(--c-navy)`, because the backdrop otherwise
defaults to the neutral at ~73% and would have dropped a near-*white* scrim
over the dark theme. Measured after: input and social-button borders are now
light ink at 11% instead of invisible.

`colorSuccess` and `colorWarning` are **not** set to VOLA's tokens, against the
instinct to brand everything. Clerk renders both as small text, and against the
light surface `--c-green` (#42f58d) is **1.43:1** — effectively invisible — and
`--c-warn` is 4.28:1, under AA. `--c-green` is also identical in both theme
blocks, so there is no legible-on-light variant to reach for. Legibility beats
brand on status text; Clerk's defaults are readable. The real fix is a
light-theme success step in the palette, which is a design-system job.

### Verified, and not

Browser-verified: the broken button, the VOLA titles, Barlow throughout, both
themes, and **the sign-up view exists and is reachable** from the modal footer.

**Not verified: the "Forgot password?" link.** It lives on the password step,
which only renders after submitting a real email address, and testing it means
touching a real account. Web reset is therefore *believed* to work and not
demonstrated — worth a ten-second manual check by someone signed out with their
own address.

Left alone deliberately: `apps/admin`'s modal is equally unstyled, but its own
button tokens are fine and it is an internal tool, so it stays out of a
customer-facing change. Same `appearance` pattern will port to it directly.

## 2026-07-31 — The accounts that could never sign in on a phone

Asked plainly by the user, and the answer was worse than expected: *"why does
sign-in in VOLA not have Google, as on web? how does someone who registered
with a Google account sign in here?"*

They couldn't. The Clerk instance has Google enabled and `apps/web`'s prebuilt
modal has been offering "Continue with Google" since web shipped, so athletes
have been creating Google accounts all along. **Those accounts have no
password.** Mobile's only path was `signIn.create({ identifier, password })`,
which can never authenticate an account that has no password to check. Not a
degraded experience — a locked door.

### A correction, because it was recorded wrong twice

Both the sign-up and password-reset entries above call OAuth "a want rather
than a hole — every account is reachable without it." **That is false, and it
was false when written.** The reasoning was that email+password covers
everybody, which is only true of accounts *created* with a password. Web had
been minting passwordless accounts the whole time. Worth leaving the wrong
claim visible above rather than editing it away: it is a good example of a
gap that stays invisible because you keep checking the same path.

There is an accidental escape hatch, discovered while thinking this through:
`forgot-password.tsx` uses `reset_password_email_code`, which *sets* a
password — on a passwordless account that effectively adds one. So a Google
user could have "reset" a password they never had. Unverified, and nobody
would ever guess it. It is not a design.

### One hook, because Clerk doesn't distinguish

`lib/useGoogleSignIn.ts` wraps `useSSO().startSSOFlow`, and both screens use
it. Clerk's OAuth does not separate sign-in from sign-up — an existing Google
identity signs in, a new one is created — so two copies with different labels
would have been two chances to diverge. `components/GoogleAuthButton.tsx`
exists for the same reason: it is the one element that must look identical on
both screens, which own separate StyleSheets.

The outcome type is a discriminated union rather than a boolean, and the
interesting member is `cancelled`. Backing out of the browser sheet is a
*decision*, not a failure, and reporting it as an error would be the same
class of lie as an empty state claiming "you have none" after a failed read —
the rule this codebase keeps rediscovering.

`needs_second_factor` routes into the **existing** second-factor step on
sign-in rather than a new one, because Clerk's client is a singleton: the
`signIn` resource handed back by the SSO flow is the same object the screen's
own `useSignIn()` holds. Confirmed at source level in review, not assumed.

The neighbouring claim was **wrong**, and it is the useful part of this entry.
The first version said sign-up could point at sign-in because "the in-flight
resource is waiting there" — implying it resumes. The resource does persist,
but **nothing on sign-in reads it at mount**, so the user would land on an
email+password form for an account that has no password. It escapes only
because tapping Continue with Google again restarts the flow cleanly. Both the
code comment and the functional-scenarios line said "resumes", which means a
test would have been written asserting behaviour that does not exist — the
same failure as the `completed` flag written but never read.

It was fixed by correcting the claim rather than by building the resume,
because making it true means calling `prepareBestSecondFactor` on mount — a
call that *sends* an SMS or email code. Any mount that happened to find a
stale in-flight attempt would spray unrequested codes at people. The copy now
names the action that actually works.

### Verified on a device

Built Release and installed on a real iPhone 13 Pro Max, and the round trip
that motivated the whole change was **confirmed by hand: an account created
through Google on web signs in on the phone.** That class of account had no
route in at all before.

Worth stating plainly because it could not be automated or simulated — see
the constraint below. The only verification available was a person with the
phone in their hand.

### The constraint that shaped the testing

**OAuth cannot work in Expo Go.** The redirect returns through `vola://`, the
scheme in `app.json`, and Expo Go registers `exp://`; it has no way to hand a
callback to a project it is only hosting. So the simulator flow used to verify
every other auth screen this week is useless here, and this had to go onto a
real device via `expo run:ios --device`.

That build surfaced two traps worth the entry in CLAUDE.md, because both look
like broken code and neither is: `pod install` dies with a Ruby
`Encoding::CompatibilityError` when `LANG` is unset, and `devicectl` and
`xctrace` report **different UDIDs for the same phone** — Expo matches
xctrace's, so the devicectl one yields "No device UDID or name matching" for a
device sitting plainly connected.

### What review caught, and one thing my own mutation test did

**The screen opened on yesterday.** `viewDay` was a `Date` captured at mount and
refreshed by nothing, while `now` re-reads on focus and on AppState. Leaving the
app on Today overnight therefore reopened it in *past mode* — yesterday in the
switcher, plans dimmed and marked "Not logged" — with the athlete having
navigated nowhere. It is a day **offset** now, derived from `now`, so every
refresh re-derives it and the class is gone rather than patched at the two
places that happened to refresh.

**A blanket `opacity: 0.55` on the past card** composited every ink inside it:
"Not logged" fell to 1.96:1 and the BJJ eyebrow to 2.51:1 — the latter being the
exact figure the palette cites as its reason for banning `textDim` from a done
row, and failing specifically for this app's headline discipline. The card is
not dimmed at all now; "Not logged" is `warn` at full strength, which is also
what it means.

And one that arrived from my own mutation testing rather than from review: the
first fix for the outside-the-week bug passed *two* plan lists and matched their
union. Three mutations of it stayed green, which is how it came out that the
wider list was **inert** — `matchPlans` groups by day, so plans on other days
can never compete for this day's sessions, and plans on the same day are the
same rows. A parameter that cannot change the answer reads as a safeguard and is
scenery. `owedOn(sessions, dayPlans)` is what was ever needed.

### Gaps

- The "this account was created with Google" hint keys on Clerk's
  `strategy_for_user_invalid`, **unverified against this instance**. If the
  real code differs the hint stays hidden and the generic error shows — the
  Google button is on screen either way, so the failure mode is a missed
  nicety, not a dead end.
- Apple sign-in is not offered. iOS App Store review requires it once a
  third-party social login exists, so this becomes a shipping requirement the
  moment VOLA goes to TestFlight for real.

## 2026-07-31 — The BJJ library gets everything it knows, and stays fast

The technique library existed as an API nothing consumed: 450 techniques, no
screen on mobile or web. A richer authoring spreadsheet arrived and the ask was
twofold — surface everything it carries when a technique is opened, and keep a
growing library snappy.

### It was an enrichment, not an import

The first useful finding was that these 450 were **already seeded** from an
earlier cut of the same sheet. All 450 names matched; the ids differed only by
delimiter (`grappling-stance-motion` vs `grappling_stance_motion`) and mapped
450/450. Ten of 21 columns were simply not stored.

Worth checking before writing an importer, because the alternative — treating
it as new content — would have produced 450 duplicate rows keyed differently.

### The optimisation was deduplication, not caching

The IBJJF columns are near-constant across the library: `age_scope` has **one**
distinct value across all 466 techniques, and the most common `rule_notes`
string repeats **359 times** at ~200 characters. Per-row that is ~182 KB of
duplicated prose; collapsed into 25 `ibjjf_rulesets` rows it is ~11 KB.

Paired with splitting list columns from detail columns — the list endpoint was
returning full rows — the measured result against a real database is a **65 kB
list payload against 274 kB**, before counting the rule dedup. The client
fetches the whole library once as summaries and searches locally, so typing
costs nothing and works offline.

The trigram index added alongside is **not** for speed; at 466 rows a seq scan
is fine. It is for aliases: "scarf hold" not finding "Kesa-Gatame Escape" was a
correctness bug, and search covered `name` only.

### The mistake worth encoding

`is_restricted` is a stored column, computed at import, and the reason is a
mistake made **three times in one session**.

Adult no-gi has no white belt division. So a no-gi technique listing "Blue,
Purple, Brown, Black" is the **baseline**, not a restriction. Deriving
"restricted?" by comparing belt lists therefore flags ~130 perfectly ordinary
techniques — hand fighting, pummelling, sit-outs — as restricted. The true
number is 20.

It was measured wrong three times (137, then 5, then 9) before being measured
right, each time by reporting a number without checking what it meant. Rather
than get it right a fourth time, the rule now lives in the data: one boolean,
computed once, documented in the migration, the domain type, the OpenAPI schema
and a test that fails if the flag becomes all-or-nothing.

### Belts: relabelled, not deleted

`typical_belt` reads as "Commonly taught from", subordinate to the legality
panel. The problem was never accuracy — it was two belt-shaped fields on one
screen where one is advisory and one is a rule you can be disqualified for
breaking. Relabelling dissolved the only two genuine conflicts: "commonly
taught from Purple" alongside "IBJJF Brown/Black no-gi only" are both true.
You drill a technique long before you may compete it.

### 16 techniques added, after 6 were caught as duplicates

A gap analysis by position count said Mount-Bottom, Side-Bottom, Back-Bottom
and North-South were thin. 22 techniques were drafted; a collision check
against names **and aliases** killed 6 as duplicates of entries that already
existed, some with better descriptions. The counts looked thin because they
were counted, not read.

The remaining 16 are defensive positions and two advanced shoulder locks. They
live in `techniques.additions.json`, merged at import — the sheet is a full
replacement, so without the merge the next re-import would silently delete
them. **They are machine-drafted and want a black belt's review.**

### Honest limits

`video_reference` is empty in all 466 rows, so the screen renders no video
section rather than an empty one implying a missing asset. `common_next_moves`
resolves to a real technique only ~29% of the time and `common_counters` ~6%,
so those render as plain text unless they resolve — a dead link is worse than
honest text. Only `setup_from` (~80%) is a navigable graph.

**Nothing here was device-verified when this entry was written**, and the first
look at it on a phone is what produced the entry below: the split library and
the wall-of-text rows were both invisible to typecheck, to a green test suite,
and to me.

## 2026-07-31 — The library was split, and shouldn't have been

The technique library shipped behind a "BJJ Techniques" link row at the top of
the Library tab, pushing a separate screen with its own search box, its own
filter chips, and its own visual language. I wrote a comment in `library.tsx`
justifying it: an exercise is a loggable unit, a technique is reference
knowledge, one toggle would make one search box serve two vocabularies.

That was wrong, and it had been decided already. **There is one library.**

The split's real cost was visible the moment it reached a phone. Tapping the
Library's existing **"BJJ" chip returned twenty bear-crawl drills** — the BJJ
entries in the *exercise* catalog — while the 466 actual techniques sat behind
a link somewhere above it. A user filtering to their sport got the least
relevant possible answer, and nothing on that screen suggested where the rest
was. Two search boxes, and neither one searched the library.

### What replaced it

One `FlatList` over a merged, alphabetically sorted list. One search box. The
same sport chips. Grouping exercises-then-techniques was considered and
rejected — it is the same split wearing a different hat, and it makes "is
armbar in here?" depend on knowing which group an armbar belongs to.

The two halves keep different fetch mechanisms, deliberately: exercises are
filtered server-side (debounced, cancellable), techniques are fetched **once**
(~65 KB for all 466) and filtered in memory, so typing is free and works with
no signal. Same search box, different plumbing underneath.

Position filtering moved into a second chip row that appears only under BJJ,
and was fixed while moving: the old chips keyed on exact positions
(`Mount - Top`) and reached **274 of 466**, silently excluding every bottom and
escape position — the half a white belt needs most. Worse, a chip labelled
"Mount" that returns only Mount-Top is a label making a promise the filter
doesn't keep. Matching the position *family* covers 458 of 466.

### The rows were a wall of text, and that was structural

The second complaint was that it looked like nothing: plain text, no images.
True, and not fixable by adding images — **only 4 of 524 exercises have
artwork** and techniques have none, so "render the image when there is one" is
a list that is blank 99% of the time.

So every row now draws a tile unconditionally: the photo when one exists, and
otherwise a coloured code derived from what the item *is* (`SUB`, `ESC`, `SWP`
for techniques; the movement pattern for exercises).

**Colour never carries meaning alone** — every tile also carries its code. That
turned out to matter concretely. The obvious scheme, one hue per technique
category, failed `validate_palette.js`: violet against blue measured **ΔE 2.0
for a deuteranope and 12.9 with full colour vision**, i.e. two categories that
look identical to *everyone*, not just to the colour-blind. Three hues plus an
achromatic step clear every check (worst adjacent pair ΔE 21.7 CVD / 35.6
normal), so the nine categories map onto four *intents* for colour while the
code stays specific. Guessing would have shipped the failing palette; the
validator took thirty seconds.

### Fixed at the source, not at the client

Separately, the enrichment work had left `setup_from` storing technique **ids**
in a field the UI has to render, with the mobile client compensating. That put
the workaround in every future client. The importer now resolves ids to names,
so the data is what it claims to be:

- **Ruleset ids are content-derived** (`sha256` of the ruleset tuple) rather
  than positional counters. Under the old scheme, reordering rows in the source
  spreadsheet silently repointed techniques at a *different ruleset's* legality
  — wrong competition rules shown to a competitor, with nothing to notice.
- **`techniques_name_trgm_idx` is dropped.** `EXPLAIN ANALYZE` proves it was
  never chosen: the predicate is `name ILIKE $1 OR EXISTS (… aliases …)` and
  the non-indexable `EXISTS` arm disqualifies the whole `OR`. With
  `enable_seqscan=off` the planner *still* can't use it — "cannot", not merely
  "prefers not to". The migration comment claiming it was "for aliases" was
  doubly wrong: it was on `name`, and it served nothing.
- **The tests now assert exact counts** (8 restricted rulesets, 20 restricted
  techniques). The `0 < n < all` range they replace would have passed the
  ~130-technique belt-count regression it exists to catch, which makes it worse
  than no test. The raw-id check runs as one query over all 466 rather than a
  sample of 80 — verified to bite: 0 on real data, 464 on the same query over
  underscored ids.

### What the reviewers caught that I had shipped

`{hit.name}` on a graph edge rewrote **128 alias-matched edges into a different
technique's name**: "Straight Armbar" rendered as "Armbar from Closed Guard",
"Wrist control" as "Turtle Hand Fighting" — a different technique from a
different position, presented as though the author had written it. The label
now shows what the author wrote unless they wrote an id, which is the only
unreadable form.

### Honest limits

The 16 machine-drafted techniques still want a black belt's review. The
importer writes `*.generated.json` while the binaries embed `*.json`, with no
step in the repo connecting them — a manual rename nobody has documented, and
a trap for the next person who re-imports. `UpsertAll` still never deletes, so
a technique removed from the sheet lingers forever and keeps its ruleset alive
against the new orphan prune.

## 2026-07-31 — The technique library on the web, and what the wide screen is actually for

Same merge as the phone, one day later and one screen wider: `/dashboard/library`
now lists the exercise catalog **and** the 466 techniques in one grid, behind
one search box and the existing sport chips. No separate destination, for the
same reason there isn't one on mobile — it would need a second search box, and
the "BJJ" chip would keep returning bear-crawl drills while the techniques lived
elsewhere.

### The part that isn't a port

The phone and the desk get the *same* library and a **different** reading
experience, and this is the clearest case yet of the platform split in
CLAUDE.md earning its keep.

On mobile, opening a technique is a push-navigation: the list goes away, and
following a graph edge means unwinding a stack to get back. On the web the
detail panel sits *beside* the grid, so **following the graph costs nothing** —
clicking "Triangle Choke from Closed Guard" under Common next moves swaps the
panel and leaves the list, the scroll position and the search exactly where they
were. Reading around a subject is what a desk is for, so the panel carries the
full prose, the gi/no-gi legality table and all three edge lists rather than the
trimmed set a phone can show.

That is also why the edges are buttons here and links there: on the web an edge
is a lateral move within one view; on the phone it is a journey.

### Colour had to be re-derived, not reused

The mobile tiles use `#FF6B6B / #B8FF2C / #6BB6FF` against `#10151F`. Web is
light-by-default, so those values were re-stepped for a white surface and
validated against it: `#c0392b / #6f9c00 / #1f6feb`, all six checks passing,
worst adjacent pair ΔE 8.7 CVD / 27.1 normal. A shared hex would have been
wrong in both directions — a mid-blue that reads on `#10151f` washes out on
white, and the light lime (`#6f9c00`) disappears on black. `--c-info` is
therefore a **per-mode token**, like every other colour in that file.

The CVD figure of 8.7 sits in the band that is legal *only* with secondary
encoding. The tile's three-letter code is that encoding, which is also what
lets hue be scoped per domain: red means "lower body" on an exercise and
"submission" on a technique, unambiguous because `PSH` is never a technique and
`SUB` is never an exercise.

### Caught by looking, not by checking

`/dashboard` is Clerk-gated, so the page can't be opened without signing in —
which I can't do on someone's behalf. Rather than ship unlooked-at (the exact
mistake that produced the previous entry), the tiles and panel were rendered
against fixed sample data on a throwaway public route, screenshotted in both
themes, and the route deleted.

It immediately caught one: **the achromatic tile was invisible in light mode.**
`--c-surface-raised` is `#ffffff` there, identical to the card it sits on, so
`PIN` and `ISO` rendered as empty outlines — the "nothing stands out" complaint
reappearing for the one bucket with no hue to fall back on. `surface-hover`
differs from the card in both modes. Type-checking, linting and a production
build were all green with that bug in place.

### Honest limits

The page has never been rendered against the real API — the harness used sample
data, and staging needs a sign-in. The technique summaries are cached for the
tab's lifetime with no invalidation, which is right for reference content and
wrong the moment techniques become editable.

## 2026-07-31 — The technique detail screen: "just a bunch of text"

Accurate description of what shipped. Eight stacked sections in identical type,
no visual anchor, and the execution instructions delivered as a single
121-character sentence. Structurally correct, unreadable in a gym.

### The fix was in the data, not the styling

`description` is authored as ONE comma-separated sentence — "Control wrist and
elbow, break posture, pivot across the shoulder, clamp the knees, and extend
the hips through the elbow line." That is **five instructions wearing a
paragraph**, and it is most of why the screen read as a wall.

`executionSteps` splits it. Measured across all 466 *before* any UI was built:
460 (99%) yield 2+ steps, clustered at 3–4, averaging 30 characters, none under
10 or over 110. The remaining 6 fall back to prose, because a one-item numbered
list looks like a bug.

The split takes `;` as well as `,` — several descriptions join instruction
pairs with a semicolon — and deliberately **avoids a lookbehind**. `(?<=\.)\s+`
matched zero of 466 (trailing periods are stripped anyway), while on web
`lib/api.ts` is imported by every dashboard page and Next/SWC does not
transpile regex features: an unsupported construct is a parse-time
`SyntaxError` that takes the whole dashboard down on Safari/iOS < 16.4. The
review verified the pattern compiles under the app's own Hermes binary, so this
was risk removal rather than a fix — but it was free.

The fragment-folding rule needed a correction that only showed up on screen:
the first version folded anything under three words and silently merged "Control
wrist and elbow" with "break posture". **"Break posture" is a step, not a
tail.** Length alone separates fragments from instructions on this corpus.

### An idea that measurement killed

The obvious companion was a timing panel — `when_to_use` reads "Use from Closed
Guard **after** the elbow is isolated… Apply it **before** the opponent
completes stack pass", which looks like an entry/exit window. Only **33%** of
the library has both halves, and the actual samples don't fit the frame at all
("Use as the default standing posture whenever neither athlete has dominant
grips"). Building it would have misrepresented two-thirds of the library. It
was not built.

### The hero is a media slot, deliberately empty

Images are coming; techniques have no image field yet. Rather than defer the
layout or ship a grey rectangle that reads as a failed download on all 466, the
hero is built as the slot and filled meanwhile with the category mark — an
oversized, very low-contrast watermark plus the category eyebrow. `heroImage`
is the one prop that turns it into a photo, with no layout change.

The scrim over the lower two-thirds is not decoration: today it keeps the title
clear of the watermark, and the moment real imagery lands it is what stops white
text sitting on a white gi. Solid rather than a gradient, because
`expo-linear-gradient` isn't a dependency and one overlay doesn't justify a
native module.

### Caught by looking, twice

The first render put the category tile bottom-aligned against a tall text block,
so it sat beside the *aliases* rather than the title, and the watermark ran
straight through "Armbar from Closed". Neither is visible to a typechecker.
Verifying meant a throwaway route rendering the **real** components against real
library data, deep-linked into the Simulator — `/technique/[id]` needs auth, so
it cannot be opened directly.

### One bug the redesign introduced

The new "Try again" button called `load()`, which cleared the error while
`loading` stayed false and `technique` stayed null — so for the whole retry the
screen rendered the fallback branch's **"Technique not found."**, the most
alarming possible message, on exactly the slow connection the button exists
for. Caught in review, not by any check.

### Parity

The web panel got the same split from an identical parser, verified
comment-stripped-identical to the mobile one so the two screens can never
disagree about where a step ends.

## 2026-08-01 — Two pieces of feedback that both came down to "half-done reads worse than absent"

### The graph links are gone; the graph is not

The technique detail screen linked `setup_from`, `common_next_moves` and
`common_counters` to other techniques. Verdict after using it: *"I don't really
need the links… they kinda cool but its not full."*

That is a coverage problem wearing a UI complaint. **~80%** of `setup_from`
entries name a real library entry, but only **~29%** of next-moves and **~6%**
of counters — the rest is prose like "establish grips or inside ties". So a
typical screen showed one or two links surrounded by plain text, which reads as
a feature that half-works rather than as a graph.

The lists stay as reference text — knowing an armbar chains to a triangle is
useful whether or not the app can navigate there. The navigation goes. That
deleted `resolveEdge`, `indexByName`, `edgeKey` and `indexTechniques` outright,
and with them a whole network fetch on the mobile detail screen: it no longer
loads all 466 summaries just to decide what is tappable. Worth reconsidering if
coverage ever approaches "nearly every entry resolves".

### The 20 BJJ drills left the exercise catalog

*"some older bjj in library with default images are still present."* Two things
were true at once. The exercise catalog held 20 BJJ conditioning drills — Bear
Crawl, Sprawl, Granby Roll — which predate the technique library, so filtering
the Library to "BJJ" returned drills **and** 466 techniques: two different kinds
of thing under one label. And all 20 have no media of their own, so the backend
served each the per-sport placeholder from `defaultMedia`, rendering a block of
identical stock photos.

They are removed. "BJJ" in the Library now means the technique library.
`Technical Stand-Up`, the one entry that existed on both sides, stops being a
duplicate.

**This is the first time `UpsertAll` never deleting has actually cost
something.** Removing rows from `exercises.json` leaves them in every database
already seeded, so it took migration `000019` — and that migration is
deliberately conditional:

```sql
DELETE FROM exercises e
WHERE e.sport = 'bjj'
  AND NOT EXISTS (SELECT 1 FROM session_sets  s WHERE s.exercise_id = e.id)
  AND NOT EXISTS (SELECT 1 FROM workout_items w WHERE w.exercise_id = e.id);
```

`session_sets` and `workout_items` reference `exercises` with **no** `ON DELETE`
clause. An unconditional delete would fail the migration outright or, worse,
tempt someone into adding `CASCADE` and silently destroying training history. A
drill that survives because someone logged it stays visible in the library —
the right failure direction. Checked against staging first: 20 rows, 0 referenced by `session_sets`,
`workout_items` or `pinned_exercises` — and, after review pointed out the
original claim of "0 referenced by anything" skipped it, 0 in
`exercise_unit_prefs` too. That one and `pinned_exercises` CASCADE, so on
another database they would be deleted silently along with the drill; both are
trivially recreatable preferences rather than training history, which is why
they are not in the guard.

### The consequence worth stating plainly

With no bjj entries in the catalog and the existing sport-equality rule, **a
`sport='bjj'` session can no longer contain a single set, and a bjj workout
template can no longer contain an item.** Every remaining catalog entry
mismatches, and techniques are not loggable — there is no `technique_id` on
`session_sets`.

That is coherent with where BJJ is going, and `docs/testing/functional-scenarios.md`
already called the old arrangement a stopgap ("BJJ workouts only work because
two BJJ entries live in the exercise catalog; a real technique library is its
own module"). But it is a capability that existed this morning and does not
now, and the review is what forced it to be written down rather than discovered
later. Making techniques loggable is the work that closes it.

### What the test suite caught

Four integration tests in `session` and `workout` broke — both packages pinned
`exBJJ = "bear-crawl-forward"` as their non-strength fixture — plus
`TestPostgresRepository_ListFilters`, which asserted "expected at least one bjj
exercise". All five are the tests doing their job.

**They were nearly missed.** A local `go test ./...` reported those two packages
as `(cached)`, so the run looked green while four tests were broken; only
`-count=1` surfaced them. The documented gotcha about integration tests
skipping without `TEST_DATABASE_URL` has a sibling: they can also be *cached*
past a data change they depend on. The fixtures now point at `run`, the one
remaining non-strength catalog entry. It now filters on
`running` for the positive case and asserts bjj is **empty**, with a comment
saying why — so if the drills ever come back, something fails loudly rather
than bear crawls quietly reappearing among the armbars.

### Still true, and deliberately not changed

`defaultMedia` still serves per-sport placeholders to the ~500 strength and
running exercises with no artwork of their own. That was offered as part of this
change and not taken; it remains the case that most catalog rows show a stock
image rather than the movement.

## 2026-08-01 — A discipline registry, because the toggles did nothing

The profile has carried `bjj_enabled` / `strength_enabled` / `nutrition_enabled`
/ `running_enabled` since migration 000001. They were read in **exactly one
place** — mobile's "You" screen rendered them as a comma-separated string.
Turning `running_enabled` off changed one line of text and nothing else, while
`profile/edit.tsx` claimed "which sports you do decides what the app offers
you".

Meanwhile the same closed set was written down **four times in Go**: a map in
`session/handler.go`, a second map in `exercise/seed.go`, a typed enum plus a
switch in `workout/workout.go`, and a media map keyed by sport in
`exercise/exercise.go` — plus 2 SQL CHECKs, 5 hardcoded prose error strings, 9
OpenAPI enums, and **six mutually inconsistent lists in the mobile app alone**.
Adding a discipline touched ~31 places, none of which the compiler connected.

### Three vocabularies, and one of them had nothing behind it

`sport` (`strength|running|bjj`), activity `kind` (free text, unvalidated), and
`*_enabled` (bjj, strength, nutrition, **running**). Nothing mapped between
them, and `nutrition` existed only in the third — no table, no route, no seed
content. So "discipline" was really two concepts. `internal/platform/discipline`
now says so explicitly: `IsSport` is a field, because nutrition is a module you
can toggle and a session with `sport="nutrition"` is nonsense.

### Toggles decide what you can reach; data decides what you can read

The rule the registry is built around, and the reason `Capabilities` is a struct
rather than one boolean. "Is BJJ on?" and "does BJJ have 1RM records?" are
different questions — collapse them and a BJJ-only athlete gets a Records screen
whose five record kinds are all lift- or run-shaped.

What the registry deliberately does **not** decide is whether a *metric* shows.
Web's `loadMetric()` already picks volume-vs-time from the data present, and the
calendar falls back to session-count with a `Math.max(1, …)` floor so a
lift-Monday/roll-Tuesday athlete's BJJ days don't render identical to rest days.
Gating those on toggles would break the one part that was already right.

### Columns became rows

`profile_modules(user_id, module_key, enabled)`, backfilled from the four
columns. Adding a discipline now needs **no migration**: a user with no row
falls back to the registry's `DefaultOn`.

Deliberately **no CHECK on `module_key`** — a CHECK is exactly the
migration-per-discipline cost being removed. The registry validates on write,
and an unknown row is inert because reads go registry-first.

The four columns are **left in place and unread**. Dropping them in the same
migration would make it unrecoverable — roll the api back and the old binary
reads columns that don't exist. Standing, a rollback reads stale-but-present
values: wrong, not a crash. Consequence written down rather than discovered:
between now and the follow-up that drops them, columns and rows can diverge,
because only the rows are written.

The **down** migration pushes rows back into the columns before dropping the
table, so a rollback keeps whatever the user chose while rows were
authoritative. Verified with real data: a row edited `true`→`false` came back as
`false` in the column, and untouched values survived.

### Verification worth naming

The backfill was tested against a **simulated legacy database** — migrate to 19,
insert three profiles with deliberately varied toggles including a non-default
combination, then migrate. 12 rows, **0 mismatches**, and the BJJ-only user came
through with `bjj=true` and the rest false. A from-zero database lands
identically.

`defaultMedia` is the one discipline list that can't derive from the registry —
its values are asset paths that have to exist in the bucket. It failed
*silently*: a sport missing an entry made `DefaultMediaFor` return nil, the
handler skip media, and every exercise in that discipline render imageless with
nothing logged. It now has a coverage test, mutation-checked by deleting the
`running` entry and watching it fail.

### The claim was false, and review caught it

`discipline.go`, the 000020 migration comment, this entry and
functional-scenarios all asserted that adding a discipline needs no migration.
**It didn't, while `workouts_sport_valid` and `sessions_sport_valid` stood** —
two CHECK constraints pinning `sport IN ('strength','running','bjj')` in SQL. A
fifth discipline would have passed every Go validator and then failed every
INSERT on a 23514, surfacing as a misleading 400, with nothing in the suite to
catch it: the registry's tripwires never touch the database.

Migration `000021` drops them. Widening rather than dropping was considered and
rejected — a CHECK listing the values *is* the migration-per-discipline cost
this work exists to remove; widening moves the next migration one discipline
out. The trade is stated in the migration: the database will now accept a sport
no handler would produce, reachable only by direct SQL, and inert because
nothing enumerates sports from those tables.

What replaces it is a test that writes a session for **every** sport in the
registry — the tripwire that was missing. Mutation-checked: re-adding a CHECK
that excludes BJJ fails it on the BJJ subtest.

### Other things review caught

- The FK violation from toggling modules for a user with no profile reported
  **"unknown exercise"** — a message written for `exercise_unit_prefs`, reachable
  by any signed-in user who hadn't onboarded.
- `SetModules` queued its batch in Go's randomised map order, so two concurrent
  multi-key PATCHes for one user could deadlock. Sorted now.
- The tracked Postman collection still PATCHed `/profile` with
  `running_enabled` — which after this change returns **200 and does nothing**,
  since unknown fields are ignored. The generator had it hardcoded; fixed at
  source and regenerated.
- On mobile, a modules-save failure after a successful profile save showed one
  generic banner, so a user whose profile (and, on first run, whose profile
  *row*) had just been created was told nothing saved. The comment claiming
  sequencing prevented this was wrong — sequencing alone distinguishes nothing.
- The "You" screen fetched modules on mount while fetching the profile on focus,
  so the Sports row went stale after exactly the flow it exists for. And its
  `.catch(() => {})` asserted "None chosen yet" as fact on a network failure —
  the same default-standing-in-for-unknown bug this file has fixed twice before.

### Phase B, and what review caught in it

The mobile half shipped four blocking defects, all one root cause: **the
provider's lifecycle was write-only after mount.**

1. **Toggling a discipline did nothing until the app was killed.** The profile
   screen called the raw API helper and never touched the provider; `refresh`
   was exposed on the context and called by *nothing*. The save persisted
   server-side and the tab bar, start buttons and Library chips all kept the old
   configuration for the rest of the process. **The entire feature failed on its
   primary path.** `PATCH /modules` already returns the merged set, so the fix
   costs no extra request.
2. **`ready` was consumed by nothing**, so its docstring's central claim — "the
   shell can hold a frame rather than show the wrong one" — was honoured by no
   code. The tab bar rearranged on every cold start (the exact bug it was
   written to prevent) and Today flashed its all-disciplines-off empty state at
   every user.
3. **The technique fetch was not gated.** The commit message and two code
   comments asserted it was; `loadTechniques` had no reference to the
   capability. A strength-only user still pulled ~65 kB of techniques on every
   Library mount and every pull-to-refresh.
4. **Sign-out leaked the previous athlete's configuration.** The provider sits
   above the navigator and never remounts, so on a shared device the next user
   saw A's tabs — and if B was offline and new to the device, indefinitely.

Smaller, same review: a `sportTouched` flag that defended against nothing and
preserved the one invalid state (a selection whose discipline had been
disabled, still creating workouts in it); two stale-`modules` closures; a cached
module set parsed with a bare cast rather than through the normaliser written
for that boundary; and "Start bjj" — the first consumer of the label the
registry carries specifically to keep BJJ capitalised, lowercasing it.

None of this was reachable by typechecking, and I could not run the gated flows
myself: they need a signed-in session. The review read what I could not execute.

### Open

Phase A is backend only — the toggles still gate nothing in the UI. Phases B and
C wire the clients, at which point disabled disciplines lose their nav, their
controls **and their network requests** (the Library currently fetches 466
techniques for every user regardless).

`activity.kind` remains a fourth, unvalidated vocabulary. The registry is where
it should eventually be validated.

## 2026-08-01 — Phase C: the web app catches up, and the admin console stops measuring a dead table

Phase A gave the backend a discipline registry; Phase B made the phone obey it.
This is the desk half, plus the thing that fell out of asking "what should
admin actually track?"

### Web now obeys the toggles

`apps/web` had its own hardcoded `SPORTS` list and its own reimplementations of
what the registry already knows — a `HAS_TECHNIQUES` set, a `usesPosition()`
predicate. All gone. The modules are fetched **once, server-side, in
`dashboard/layout.tsx`**, and handed to a client `ModulesProvider` as an initial
value.

Server-side and once, for two reasons. The layout is a Server Component, so the
read is awaited before anything paints — a client fetch would render the full
navigation for one frame and then remove items, a visible flash of destinations
the user doesn't have. And this codebase has already paid for the other shape:
`useUnits` fetches the profile per call site with no shared cache, costing *one
`GET /v1/profile` per session rendered* — 200 identical requests for one
account-level enum, documented in `sessions/page.tsx`. Module state is read by
the sidebar *and* every page, so repeating that would have been worse.

Nav items gained a `needs` predicate. **Records is gated on "any enabled module
has record kinds"**, not on strength — it is marginally useful to a runner
(`longest_time`, `furthest_distance`) and useless to a BJJ-only athlete, whose
five available record kinds are all lift- or run-shaped. Library is gated on any
enabled module having a catalog. When the fetch fails the nav falls back to
ungated: a preference endpoint blinking must not hide the app.

Settings gained a **"What you train"** section. This closes a real hole rather
than adding a nicety — the toggles existed only on the phone, so a discipline
switched off there could not be switched back on from a desk, while web
cheerfully kept showing it everywhere because it ignored the toggles entirely.

### The admin console was measuring a table with no writer

Asked to "track the most important things", the first thing worth checking was
what it already tracked. Against staging:

```
activities: 0   sessions: 2   session_sets: 36   workouts: 2   health_events: 0
```

`activities` has had **no writer** since the in-app logging form was removed.
Its two columns — `activity_count` and `last_activity_at` — were the entirety of
the user-lookup table, and `/users/[id]` rendered nothing else. Every row read 0
and null while the account's real training sat in `sessions`. The detail page's
own empty state admitted it couldn't tell a wrong id from an idle account:
*"Either they haven't logged any yet, or the ID doesn't exist — the API returns
an empty list for both."*

So the fix was not "add tracking". It was **deriving from rows that already
exist**:

- `session_count`, `last_session_at`, `set_count` — aggregates over `sessions`
  and `session_sets`. `set_count` earns its place by separating someone who
  started two sessions and abandoned them from someone who trained twice.
- `modules` — enabled disciplines, resolved through the registry so a user with
  no stored row reads as the *default* rather than as "off".
- A new `GET /v1/admin/users/{userID}`: summary + recent sessions, **two queries
  in one round trip** via `pgx.Batch`. The detail page is two requests total
  (that, plus the per-user health log, run concurrently) — no per-row fetches.

Both queries share one `userSummaryCols` projection so the list and the detail
cannot drift into reporting different numbers for the same account; a test
asserts they agree. Aggregates are correlated subqueries, not joins: joining
`sessions` to `session_sets` in one `GROUP BY` multiplies rows before collapsing
them, which is how a count quietly becomes a product.

**A test caught me reintroducing a bug it was written to prevent.** Rewriting
`ListUsers`, I keyed it `FROM profiles` — and
`TestPostgresRepository_ListUsers_IncludesProfilelessUsers` exists precisely
because that hides users who signed up and trained but never onboarded (there is
no FK from `sessions` to `profiles`, so it is a real state). Users are now
enumerated from a `UNION` of every table holding a user id. Verified by
mutation: reverting to `FROM profiles` fails both that test and the new one.
`/users`' own copy claimed "N with a profile", which was already false; it now
says "N known to the API" and explains what that excludes.

### `health_events` grew forever

Migration 000016 reasoned that "on a healthy system this table stays close to
empty" — true right up to the moment it matters. A degraded database pushes
ordinary requests past the 2s slow threshold, and every one of them then writes
a row into the same struggling database. The queue and single writer bounded the
*rate*; nothing bounded the *total*. There was no TTL, no partitioning, no
cleanup job, no `DELETE` anywhere in the repo.

Now 90 days, matched to the read path's own 30-day `MaxWindow` clamp — anything
older was already unreachable through the API and was pure storage. Migration
000022 clears the backlog once; `cmd/seed` keeps it bounded, since the predeploy
seed is the only scheduled thing this project has. `pg_cron` would be tidier and
is not worth an extension for one statement. Verified by inserting a 100-day-old
and a 10-day-old row and running the seed: `health_events pruned: 1`, the recent
one untouched.

### What was deliberately NOT added

**A `last_seen_at` write.** It is the only way to get DAU — every count here
measures *logged training*, not *opened the app*, so a daily browser who never
logs is indistinguishable from a churned account. It would cost one stamped-
once-a-day write off the existing `/v1/modules` launch call. It is a genuine
gap, but it is a new write path on every launch and the user asked for no
bloat, so it is written down rather than built. Naming the field
`last_session_at` instead of `last_seen_at` keeps the current numbers honest
about which question they answer.

The dead `listUserActivities` client and `Activity` type were deleted from
`apps/admin` — nothing rendered them. The backend route survives as the only
read path for rows predating the form's removal.

### Open

`apps/web` still doesn't follow the shared hi-fi design system that `apps/admin`
uses — unchanged by this and still unstarted. `activity.kind` remains a fourth,
unvalidated vocabulary.

## 2026-08-01 — "Why am I being asked to sign in? I'm signed in" — one broker for Clerk

Feedback from an actual gym session, not a test: *"When offline I would see a
lot of sign in? why I'm on my phone signed in why should i again?"* Followed by
the sharper architectural question: *"why do we make any calls outside of auth
with clerk we need to make to clerk as small amout of calls as possible we need
a better architecture."*

Both were right, and they were the same problem.

### What was actually happening

Read out of the installed clerk-js rather than guessed:

```js
catch (t) {
  if (this.shouldRethrowOfflineNetworkErrors()) throw ...
  if (!isOnline()) return warn("Network request failed while offline, returning null"), null;
```

**Clerk returns `null` when it cannot be reached.** It does not throw. And
nine modules read that null as:

```js
const token = await getToken();
if (!token) throw new Error('Not signed in.');
```

So a dead spot made every screen in the app simultaneously tell a signed-in
athlete that he was not signed in. He had never been signed out —
`_updateClient(e){if(!e)return;…}` means a null response leaves the cached
client alone, so `isSignedIn` stayed true and the route guard correctly never
redirected. The word "sign in" he kept seeing was purely our own message,
nine times over, and it was false.

### The architecture underneath it

12 direct `getToken()` calls plus 18 through `useAuthToken`, one per API
request. Clerk's default session token lives about **60 seconds**, so the app
depended on Clerk's servers being reachable roughly every minute — for work
that is otherwise entirely local. That is the real answer to "why do we make
calls to Clerk at all": we weren't calling it per request, but we were
re-earning the right to function every 60 seconds.

`lib/session.ts` is now the only module that talks to Clerk:

- caches the token against its own `exp`, decoded from the JWT — no call is
  made to find out whether a call is needed;
- collapses concurrent misses into one refresh, so five screens mounting
  together cost one Clerk call rather than five;
- **keeps using a still-valid token when Clerk is unreachable.** Being unable
  to *refresh* is not being unable to *authenticate*. This is the fix;
- persists the last token in the keychain, so a cold start in a dead spot can
  still reach our API until that token genuinely expires;
- throws `OfflineError` when there is truly nothing usable — never a claim
  about being signed out. `useAuthToken()` returns `Promise<string>`, not
  `Promise<string | null>`, so the old reading cannot be reintroduced.

The cheapest remaining win is configuration, not code:
`EXPO_PUBLIC_CLERK_JWT_TEMPLATE` mints from a Clerk JWT template whose lifetime
is set in the dashboard. The API verifies signature, issuer, expiry and `sub`
only — no `azp`, no audience — so a longer-lived token needs no server change
and multiplies the offline grace window directly.

### The test that proved nothing

Worth recording, because it nearly shipped. The first harness asserted "a valid
token is still served while Clerk is unreachable" using a 300-second token —
which the broker serves from cache without consulting Clerk at all. The offline
getter was never even called. Deleting the entire offline-grace branch left all
seven tests green.

The token has to sit **inside the refresh skew but outside expiry** for that
path to run at all. With a 10-second token against a 20-second skew, removing
the branch fails two tests. A `reached === 1` assertion now guards the harness
against going vacuous again.

`apps/mobile` still has **no test runner**, so this ran as a standalone Node
harness against `tsc` output. That is a real gap: this is the most
consequential pure-logic module in the app and nothing in CI exercises it.

### Not fixed here

Reads still go to the network — a valid token does not make `GET /v1/sessions`
work in a basement. Serving reads from the local store is the offline-first
programme, still untouched. This change is what stops *authentication* from
being the thing that breaks first.

## 2026-08-01 — In-session fixes, from a phone actually taken to a gym

Five items from one session on the mat and under a bar. Four are done here;
two are deliberately not.

### The add-exercise bug — and a wrong diagnosis I shipped first

*"when adding exercise it stuck when in session I had to wipe down few times
and apparently the exercise was added but would just load without my
intervention."*

**My first diagnosis was wrong, and the review caught it.** I claimed the
session screen's 700ms debounce held a pre-picker snapshot that landed after
the picker's write, and that `Swap` flushed before navigating while `+ Add
exercise` did not. The second half is simply false: `git show origin/main`
has `await flush()` on *both* buttons. I had grepped for `router.push` and
never read the lines above the one I found. The "fix" was a behavioural no-op
dressed as a root cause — the worst kind, because the next person would have
trusted the comment.

The real mechanism is a check-then-act in the sync **pull**, and it is still
live on main:

```
run A: pullSessions()          -> snapshot WITHOUT the new exercise
picker: writes it locally, dirty = 1
run B: pushes it, sets dirty = 0
run A: reads dirty = 0, upserts its stale snapshot -> exercise gone
later: another pull brings it back
```

`syncSessions` is fired and forgotten from six places, and the add flow
overlaps two of them by construction — the picker's own sync and the session
screen's refocus sync. The **push** side already guards its version of this
with a CAS on `updated_at` ("or we'd mark a newer edit as already sent"). The
pull side had nothing.

Two fixes: the pull now refuses to write a snapshot older than the local row,
and `syncSessions` is serialised process-wide so overlapping runs cannot
interleave at all. The wrong diagnosis is recorded in the code beside the
right one, so it is not re-derived.

`openPicker` stays, because putting the flush in one place instead of two is
worth keeping — but its comment now says plainly that it is not the fix.

### Prefill, and a bug its own doc comment described

*"when we have predefined few sets, and we enter some data in first the next
ones should pick up those numbers."*

`+ Set` already carried numbers forward; sets that arrive from a template do
not, so a 3×5 meant typing the same weight three times. `fillForward` now fills
later *planned* sets when you tick one done — the moment the numbers are final,
and a tap already being made. It never overwrites a value already typed (a top
set with back-offs is a real plan), never touches a completed set, and never
carries effort.

The first implementation filtered on `exercise_id` without stopping at the
group boundary, so squat / bench / squat filled the *second* squat block from
the first — a different piece of work. Its own doc comment said "stopping at
the next one". A test caught the contradiction.

### Reorder and remove an exercise

Buttons on the group header rather than drag handles: a long-press-drag is a
poor bet one-handed with a bar to get back to, and it fights the scroll view.
Removal is confirmed and says how many logged sets go with it; `Swap` remains
the non-destructive neighbour for "wrong exercise".

### The done-set highlight, computed rather than eyeballed

*"make it the whole thing highlighted so it is visible that is done. But color
should be nice and a bit transparent."*

Lime at 15% over `surface`, solved per channel and stored opaque as
`vola.setDone` — the convention this palette already uses. 15% because it was
measured: the tint is 1.47:1 against an untouched row (visible at a glance),
`text` 11.5:1, `textMuted` 4.67:1. 20% reads better as a band but drops
`textMuted` to 3.98:1; 10% keeps every ink happy but the tint falls to 1.26:1
and stops being obvious. `textDim` is 2.51:1 on the tint, so the set ordinal
steps up to `textMuted` on done rows only.

### Not done, and why

- **Swipe-left to delete a set.** Needs `react-native-gesture-handler`, which
  isn't a dependency — a new native module plus a root-view wrapper, and it
  wants device verification rather than a typecheck. There is already a
  "Remove set" button in the expanded row, so this is an ergonomics upgrade,
  not a missing capability. Its own change.
- **Volume shown in kg when the athlete wants lb — now reproduced and fixed.**
  The account was already imperial, which ruled out the "never been online"
  theory and pointed at the real cause: **`useUnits` was a hook, so each of six
  screens held its own copy** of one account-level enum, its own
  `useState('metric')`, and its own `GET /v1/profile`. Every screen therefore
  began in metric and corrected itself a frame later — and a finished-session
  summary renders at mount, which is exactly that frame. Six resolutions racing
  six fetches also meant screens disagreed with each other, which is the "why
  it is not consistent?" in the report.

  Now one `UnitsProvider` above the navigator: one copy, one fetch (six down to
  one), cache read before first paint, and `unitsReady` so a unit-bearing
  number is never printed in a unit not yet established — a dash for one frame
  beats tonnes to someone who thinks in pounds. The offline/`owed` logic was
  already correct and is carried over unchanged; it was just being run six
  times.

  Same shape as the documented 200-request `useUnits` bug on web.

- **`useTrackEffort` collapsed too — and it had a bug units did not.** Two call
  sites, two copies, two profile fetches: the same shape, though a boolean
  cannot render a wrong *number*, so it never produced a visible symptom.

  The substantive half is that it had **no record of a local choice that hadn't
  reached the account**. Turning effort off with no signal pushed to the server,
  failed, and had the failure swallowed by a bare `.catch(() => {})` — then the
  next successful profile read did `setOn(p.track_effort)` and overwrote the
  cache with the server's stale `true`. The switch turned itself back on,
  minutes later, silently. `useUnits` carries an `owed` flag precisely to
  prevent that, and its comment describes this exact failure; `useTrackEffort`
  was written from the same template and left the flag out. It now has
  `PREF_TRACK_EFFORT_OWED`, the same server-wins guard, and Settings admits the
  state rather than swallowing it.

  Four profile fetch sites remain (`you.tsx`, `profile/edit.tsx` and the two
  providers), all of which genuinely want the whole profile.

### Testing

The two new transforms went into `lib/sessions.ts` beside `swapExercise`
rather than staying inline in the screen — pure array logic belongs there, and
it is the only way to exercise it at all given `apps/mobile` still has no test
runner. 13 assertions run from a standalone harness over `tsc` output; one of
them is what found the group-boundary bug above.

That runner gap is now the second entry in a row to mention it.

## 2026-08-01 — Offline-first, PR2: something owns when sync happens

First of the offline-first run (#115–#120). This one is about **writes getting
off the phone**; it does not make reads work offline, and the entry says so
because that distinction is the whole programme.

### Nobody decided when to sync

`syncSessions` was fired and forgotten from **seven** call sites — session
focus, the exercise picker, finishing a session, starting one, Today's mount, a
manual Retry. Each was an independent guess that *now* might be a good moment.
Between them there was no timer, no connectivity trigger, and nothing that
noticed the app had come back to the foreground.

The shape an athlete meets: log a whole session in a basement gym, walk out
into signal, pocket the phone. Nothing happens. The training sits there until
you happen to open a screen whose mount fires a sync.

`lib/sync.ts` now owns the question. Call sites say *"something changed"*
(`request(reason)`); it decides whether to act. It coalesces — ten requests
during a run cost two syncs, not eleven — backs off 5s/15s/60s/5min on failure,
retries only when something is actually pending, and syncs on **foreground
transition**, which is the trigger that was missing and the one that matches
walking out of a basement.

### Reachability, not radio state

Deliberately **no `expo-network`/NetInfo dependency.** The OS answers "is wifi
associated", and the case that started this entire thread — a phone on gym wifi
with no upstream — answers that question *yes* while nothing works. So
online/offline is inferred from whether requests actually succeed: an
`OfflineError` means offline, a completed sync means online, and a 4xx means
**online** (the server answered; it just refused). Adding the OS listener later
is worth it only to shorten the wait after signal returns — an optimisation
over the backoff, never the source of truth.

It also avoids a native dependency, which on this project means a device
rebuild before anything can be tested.

### A bug found while wiring

`schedule()` refuses to set a timer with nothing pending — sensible, but it was
reading `state.pending` *before* the `finally` refreshed it. A session created
moments earlier still reads as 0 until the recount, so the retry was skipped for
exactly the rows that needed it. The recount now happens before the decision.
Mutation-verified: reverting the order fails that test alone.

### Not in this PR

Reads. `GET /v1/sessions` still needs the network, so the Library, the workout
list and history remain online-only — that is PR4a/PR4b/PR5. Background sync is
also explicitly out: nothing runs while the app is suspended, and claiming
otherwise in the UI would be worse than the honest "syncs when you open it".

### Review, and a second vacuous test

Three things worth fixing came out of review, and one of them fixed three
problems at once.

**Classification moved into the sync result.** The orchestrator was deciding
online-vs-offline by matching `/reach VOLA/` against the error *message* — the
exact thing `apiError.ts` warns against, and worse than the usual case because
the string is our own gym-facing UI copy, so it breaks when someone reasonably
reworders it, and breaks *inverted and silently*. `SessionSyncResult` now
carries a typed `errorKind` (`offline` | `permanent` | `transient`), classified
where the error object still exists. That one change also stopped
permanently-refused rows retrying forever — a 4xx-refused session keeps
`dirty = 1`, so `pending` never reaches 0, so the 5-minute tail re-armed for the
life of the install — and fixed last-row-wins, where an offline failure followed
by a validation error classified as online.

**`syncNow` could be silently stolen.** If a request landed during a run,
`run`'s `finally` re-fires and occupies `running` in the same microtask that
resolves `syncNow`'s single `await running` — so the manual attempt hit the
in-flight guard and returned having done nothing, reporting the *previous*
run's error and stopping the spinner. Reachable on exactly the tap the button
exists for. It loops now.

**Today's badge never reflected the sync it triggered.** The screen kept its own
`pendingSessions` copy, which was fresh only because it used to `await` the
sync. Now that the orchestrator decides, that copy went stale immediately —
"N waiting to sync" persisted through the successful sync that same focus had
started. It reads `useSyncState()` instead, which until then had *zero
consumers* — a smell in its own right.

**And a second vacuous test.** The "permanent rejection schedules no retry"
assertion passed with the guard deleted. `failures` is module state that only
resets on success, so by that point in the file the backoff was 300s and the
5-second wait proved nothing. Fixed by putting the ladder back to rung 0 first,
and paired with a control asserting a *transient* failure at the same rung does
retry — so the test can't pass just because nothing ever retries. That is twice
now a test of mine has passed for the wrong reason; mutation is the only thing
that has caught either.

14 assertions from a standalone harness stubbing only the store and RN's
AppState; four mutations checked. `apps/mobile` still has no test runner — third
entry in a row to say so.

## 2026-08-01 — apps/mobile gets a test runner, and the tests are mutation-checked

Three history entries in a row had noted that this app had no test runner. The
cost was not hypothetical: **twice in one day a test of mine passed for the
wrong reason**, and both times the only thing that caught it was deleting the
code under test to see whether anything went red.

- The token broker's "a still-valid token is served when Clerk is unreachable"
  used a 300-second token — which the broker answers from cache without ever
  consulting Clerk. The offline getter was never called, and removing the whole
  offline-grace branch left all seven assertions green.
- The orchestrator's "a permanent rejection schedules no retry" ran when
  `failures` had already climbed the ladder to 300 seconds, so waiting 5
  seconds proved nothing. It passed with the guard deleted.

Both lived in Node harnesses compiled with `tsc` and thrown away, so neither
was repeatable and neither ran in CI.

`jest-expo` rather than bare jest or vitest: it resolves React Native and the
`expo-*` modules the way Metro does, so `lib/session.ts` (expo-secure-store)
and `lib/sync.ts` (react-native's AppState) can be imported without
hand-stubbing the module graph — which is what made the harnesses fragile.

**30 assertions across three files**, all logic, no rendering. That is a
deliberate aim: what has actually broken in this app is concurrency and state
reconciliation — token refreshes racing sign-out, sync runs interleaving, set
transforms crossing a group boundary. Component tests would be ceremony
pointed away from the bugs.

Fake timers throughout the orchestrator suite. The backoff starts at five
seconds, and waiting that in real time both blew jest's default timeout and
made the suite slow enough that nobody would run it. It now runs in 0.5s
instead of 16.

### The bar for this suite

Every one of the seven guards these tests exist for was **mutation-checked**,
and each mutation fails at least one test:

| Mutation | Caught |
|---|---|
| `fillForward` drops the group boundary | 1 |
| `fillForward` overwrites typed values | 2 |
| broker drops the offline-grace branch | 2 |
| broker drops the cross-user check | 1 |
| orchestrator retries permanent rejections | 1 |
| `syncNow` reverts to a single await | 1 |
| `request()` loses its coalescing | 2 |

CLAUDE.md now says the same thing as a rule: when adding a test here, delete
the guard it covers and check it goes red. A green test proves nothing about
code it never reaches.

### Review: the bar held for the guards I named, and not for the rest

The reviewer's substantive point was that "every guard is mutation-checked" was
true of the seven guards I happened to test and silently untrue elsewhere.
Four surviving mutations sat in **the broker's entire restore/persistence
path** — which was *structurally* untestable, because the `clearSessionToken()`
every test uses as its reset sets `restorePromise` to a resolved promise that
nothing ever nulls, so `restore()`'s body never executed under any test. The
mock even exposed the keychain for seeding and nothing used it.

Fixed with `jest.resetModules()` cold-start cases. Two things learned doing it:
a handle to a mock's internal state must live on `globalThis`, because
`resetModules` re-runs the factory and leaves your captured reference pointing
at an orphan; and `instanceof` is the wrong assertion across a registry reset,
producing the memorable "Expected constructor: OfflineError / Received
constructor: OfflineError".

Also closed: the orchestrator's thrown-rejection path (the mock only ever
*resolved*, so inverting `online: !isOffline(err)` survived a test literally
titled "reports offline only when the sync could not reach the server"), the
AppState foreground trigger — the module's own comment calls it "the trigger
that matters most" and it had no test at all — and `fillForward`'s `i <= index`
guard, which every fixture had made unreachable by always entering at index 0.

**Writing the foreground test found a real bug**: `previous.match(/…/)` assumes
`AppState.currentState` is a string, and it is documented as possibly null at
startup. It throws inside a listener nobody awaits, so the trigger would have
died silently. Now a comparison.

Seven mutations, six caught. The seventh — `restore()`'s expired-token guard —
survives and always will: `usableToken` refuses expired tokens on every path
out of the module, so the check changes no observable behaviour. Kept as
defence in depth and **documented as deliberately untested**, so the gap reads
as a decision rather than an oversight.

Wired into CI as `pnpm run test:mobile` in the Mobile job, so it runs on every
PR rather than when someone remembers.

## 2026-08-01 — Offline-first PR3: an offline delete stops undoing itself

`deleteLocalSession` hard-deleted the row, and `DELETE /v1/sessions/{id}` went
out fire-and-forget beside it. Offline that produced a delete which quietly
reverted:

- the row vanished locally, so the session disappeared from the list;
- the server still held it, so the **next pull fetched it straight back**;
- and with the row gone there was nothing left carrying *"this needs
  deleting"*, so the intent was lost the moment the fire-and-forget call
  failed — which, offline, it always does.

The session came back some minutes later with nothing said. That is data being
**wrong**, not merely absent, which is why this ranked above the
reads-offline work.

### Tombstones

Schema v7 adds `deleted_at` to `local_sessions`. Deleting marks the row and
leaves it dirty; the ordinary push path carries the delete out, and only then
is the row hard-deleted for real. Reads (`listLocalSessions`,
`readLocalSession`) filter tombstones, so it is invisible from the tap.

Three decisions worth recording:

- **Deleting always writes a tombstone; the push decides what the server
  needs.** The first version short-circuited: `remote = 0` meant "never
  pushed, nothing to tell the server", so the row was hard-deleted outright.
  That read is racy — `pushRow` sets `remote = 1` partway through a first
  push, so deleting in that window sees 0, hard-deletes locally, and then the
  push it was racing **creates the session on the server**. Local row gone,
  server row created, next pull brings it back: the exact resurrection this
  feature exists to prevent, reintroduced by the optimisation meant to avoid a
  pointless outbox entry. Moving the decision into `pushRow` — which runs
  inside the serialised sync and can act on what is true *then* — removes
  *that* window. **It does not remove every one:** if a create lands
  server-side but the response is lost — a half-open connection, which is this
  app's home environment — `remote` stays 0 until the next successful push, and
  a delete in that gap still drops the row locally while the server keeps the
  session. Self-healing (the pulled copy comes back `remote = 1`, so a second
  delete works), and closing it would cost the clears-offline property, so it
  is a trade rather than an oversight. Recorded because the first draft of this
  entry claimed the window was gone. Safe to interleave because the tombstone
  bumps `updated_at`, so a push already in flight finds its CAS no longer
  matches and leaves the row dirty for the next pass.
- **A 404 on the delete counts as success.** The server agreeing it isn't there
  is exactly the state being asked for. Without that, deleting the same session
  twice (or deleting it on the web first) leaves a tombstone that can never
  clear.
- **The pull skips tombstoned ids**, read once per run. Without it the pull
  writes the server's copy straight back, which is the whole bug.
- **A permanent refusal restores the session.** If the server will refuse the
  delete identically forever, keeping the tombstone hides the row for the life
  of the install while `pending` never reaches zero and every foreground
  retries a doomed request — precisely the failure PR2 fixed for updates and
  which had not been applied here. So the row is un-deleted and the error
  surfaced: the session was *not* deleted, and continuing to hide it would be
  a lie about what the server holds.
- **`upsert` refuses to write over a tombstone** (`WHERE deleted_at IS NULL` on
  the `DO UPDATE`). Its SET list clobbers `dirty` and omits `deleted_at`, so an
  upsert onto a deleted row would leave the tombstone in place but mark it
  clean — the delete silently never pushed. Both callers were guarded, but
  that is two callers remembering; the clause makes the row immune instead.

### The resurrection path I nearly missed

`hydrateSession` exists for sessions this device has never seen — started on
the web, say. But `readLocalSession` now filters tombstones, so a screen opened
on a deleted id finds nothing locally and **falls through to hydrate**, which
would fetch the server's copy and upsert it with `dirty = 0`. The row would
stay hidden (reads filter it) while the tombstone quietly stopped being
pushable. A delete that silently never happens is worse than one that visibly
fails. Guarded, with a test asserting it never even asks the server.

### Testing

This is the first PR to land on the new runner, and it is the case that
motivated asking for one: the whole bug is a delete racing a pull. Seven
assertions, three mutations checked (revert to a hard delete → 4 fail;
tombstone a never-synced session → 1; forget to mark it dirty → 4).

**Named limit:** these run against an in-memory stand-in for the rows table,
not real SQLite. They exercise the *decisions* — tombstone vs hard delete, what
reads and pulls skip — and not the SQL. A schema or query mistake would slip
through. Covering that needs a real SQLite fixture, which is the next thing
this suite wants.

## 2026-08-01 — Two design docs promoted from a product conversation

A product-design conversation about what BJJ tracking should feel like as a
whole system — and what the Today screen has to be for any of it to get used —
produced two designs worth keeping. They started as session memory; the repo
is the long-term home for design intent, so they're now
[bjj-tracking-design.md](bjj-tracking-design.md) and
[today-view-design.md](today-view-design.md), both **drafts for discussion**
in the same spirit as [system-design.md](system-design.md), which they build
on rather than revise.

The BJJ doc's organizing claims: BJJ inverts the strength UX (zero phone
during, everything at a sub-90-second reflection within ~20 minutes of the
mat, layered *on top of* system-design's ≤3-tap floor rather than replacing
it); proficiency should **emerge from an event stream** (drilled /
attempted-live / hit-live) instead of ever asking "rate your triangle 1–5";
and the athlete's game is an **evidence overlay on the technique graph that
already exists** — the library's `setup_from`/counter edges — which makes gap
detection ("no reliable exit from bottom half guard") deterministic graph
analysis, and turns the deferred gameplan builder into curation over data
rather than an aspirational whiteboard. Insights, focused work, and curricula
fall out as one loop at three levels of guidance, sharing a single "current
focus" mechanism.

The Today doc's one rule: **if a number doesn't change what the athlete does
today, it doesn't belong on Today.** Layout follows (plan-with-state,
readiness *always paired with its consequence for the plan*, exactly one
recommendation, calories/protein *remaining* rather than consumed, quick
log), plus the one differentiating behavior — the lead card follows the
clock: morning readiness, pre-class focus prompt, post-class "log it",
evening macros-plus-tomorrow. A presentation rule over data the screen
already has, not a feature.

The near-term consequence that outlives both drafts: **session technique
tags must carry position context and an outcome direction (hit vs. received,
success vs. fail) from their first migration.** That is nearly free now and
expensive to retrofit, and it is what keeps every deferred BJJ feature a
pure read over data that will already have months of depth by the time it's
built.

Open questions live in the docs themselves — rounds granularity, anonymous
partner attributes, prompt stacking with the sRPE ask, and whether the
"daily message" survives Today's filter rule at all.
## 2026-08-01 — A real SQLite fixture, and a fourth test that proved nothing

Three commits in a row carried the same caveat: the mobile tests mocked
`lib/db` with an in-memory array and matched SQL with regexes, so they covered
the *decisions* and not the SQL. That caveat had already cost something
concrete — two tombstone guards could only be pinned by asserting on query
**text**, and the array mock once *supplied* the behaviour under test, setting
`dirty = 1` unconditionally so an assertion passed with the production
`dirty = 1` deleted.

`expo-sqlite` cannot run under jest: jest-expo stubs the native module
(`NativeDatabase is not a constructor`). But Node 22+ ships **`node:sqlite`** —
the same engine, synchronous API, **no new dependency**. `support/sqlite.ts` is
a thin async shim over it wearing expo-sqlite's interface, and
`migratedFixture()` runs the app's own `migrate()`.

That last part matters more than the SQL execution. `db.ts` carries a hard-won
comment — the fresh-install path runs *every* branch from v0, which is why each
`ADD COLUMN` is guarded, after a v5-shaped assumption produced an ALTER that
failed on a fresh install. **Nothing had ever exercised that.** Now any test
that opens a fixture does.

### What it caught immediately

Five mutations that the array mock let through, all now failing:

| Mutation | Tests caught |
|---|---|
| upsert loses `WHERE deleted_at IS NULL` | 1 |
| `listLocalSessions` stops filtering | 2 |
| `readLocalSession` stops filtering | 2 |
| delete drops `dirty = 1` (narrow form) | 4 |
| schema v7 column never added (fresh path) | 7 |

The narrow `dirty` mutation had gone from 1 failure to 4 — real SQL catches it
in more places than the decision tests could.

### Review found two of the new tests vacuous. Fifth and sixth.

Both were the exact class this branch was written to end, which is the part
worth sitting with — *building the tool that catches vacuous tests did not stop
me writing two more in the same commit*:

- **"running every branch twice is idempotent"** called `migratedFixture()`
  twice, and each call constructs a **new** `:memory:` database. So it ran the
  fresh path twice under a different name. It could not have failed:
  `migrate()` short-circuits on `current >= SCHEMA_VERSION` before reaching a
  branch, and the scenario it names — a crash between DDL and the version
  stamp — is *same database, old `user_version`*. Now resets
  `PRAGMA user_version` on the same db and re-runs.
- **"deleting twice does not move updated_at"** compared two
  `new Date().toISOString()` values taken microseconds apart. Measured on this
  machine: **999/1000 share the millisecond**, so deleting
  `AND deleted_at IS NULL` produced an identical string and the test passed.
  It happened to fail on one mutation run, which is worse than failing
  reliably — a guard that catches by coin-flip reads as coverage. Now
  deterministic, by backdating the row between the two deletes.

Two more gaps it named, both now closed: **the upgrade branches never
executed** (every fixture starts at v0 with CREATEs at current shape, so
`addColumnIfMissing`'s ALTER never fired — deleting the whole `if (current <
7)` branch stayed green), and there was **no test that `upsert` still updates a
live row**, so an over-broad `WHERE` that blocked *every* update — silently
dropping pulled server changes in production — also passed.

Shim fidelity was verified against expo's installed source rather than its
docs, and holds: expo's binder does exactly `boolean → 1/0` and
`value ?? null`, `getFirstAsync` returns `null`, multi-statement `execAsync`
matches. Three deltas corrected: `BEGIN` moved inside the try to match expo's
own ordering, `runAsync` now forwards `{ lastInsertRowId, changes }` instead of
discarding it, and `PRAGMA foreign_keys = OFF` so the fixture matches device
semantics (node:sqlite enables them by default; expo does not).

**Six vacuous tests in one day.** Every one was caught by mutation and by
nothing else. The pattern is not carelessness about any single test — it is
that a test's *name* is a claim, and the only thing that checks the claim is
deleting the code and watching.

### And a fourth vacuous test, caught by the same discipline

The first version of "the upsert genuinely refuses to write over a tombstone"
**hand-wrote its own `INSERT ... ON CONFLICT`** with the WHERE clause inlined,
instead of calling the app's `upsert`. It passed with the production clause
deleted, because it was testing its own SQL. Found by mutating and watching
nothing fail.

Fixing it meant exporting `upsert`, which is a smell worth naming: by design
no production path reaches it with a tombstoned id — the pull skips them and
`hydrateSession` refuses — so the clause is a backstop for a *future* caller,
and the only way to exercise a backstop is to be that caller. Exported with a
comment saying exactly that.

The text-assertion tests it supersedes were **deleted**, not kept alongside, so
nobody reads regex-over-source as an accepted way to test SQL. CLAUDE.md now
says so directly.

Four vacuous tests in one day, each passing for a different reason: a token
that never reached the branch, a backoff ladder already at its ceiling, a mock
supplying the assertion, and a test exercising its own copy of the code.
Mutation caught all four; nothing else would have.

## 2026-08-01 — Offline-first PR4a: workouts readable offline, and the cache stops inventing ownership

Two problems, and the second is the one worth the entry.

### The Plan tab never read the cache it already had

`app/(tabs)/workouts.tsx` called `listWorkouts` and nothing else, so with no
signal it showed an error where the plan should be — **even though the
workouts were already on the device**, cached for the offline session-start
path since v2. Local first now, network refreshes.

`mine` only. The shared tab browses other people's published templates, and
there is no honest local answer to "what has everyone shared" — an empty list
would read as "nobody has shared anything", which is a claim the device cannot
make. Nor are shared templates written into this athlete's cache rows, or they
would come back looking like theirs.

### The cache invented ownership — but not the bug I first wrote down

`cachedWorkouts` returned `owner_user_id: userID` and `visibility: 'private'`,
both hardcoded. `app/workout/[id].tsx` computes

```ts
const canEdit = workout.owner_user_id !== null && workout.owner_user_id === userId;
```

from exactly that field, and the first version of this entry concluded that
**offline every cached workout looked editable**, VOLA templates included, with
a Save button for things the server refuses.

**Review disproved that, using the backend's own scope semantics, and it is
worth recording precisely because it was a good story.** `workout/postgres.go`
implements `mine` as `owner_user_id = $1` — a NULL never matches, and another
athlete's id never matches — and *both* `cacheWorkouts` call sites pass a
`mine` list. So every row the cache could ever hold was genuinely owned by the
reader: the hardcoded `userID` returned the **right answer for every row that
exists**. And `workout/[id].tsx` never reads the cache at all (it calls
`getWorkout` and errors offline), so no Save button could appear.

What was *actually* broken was the other hardcode: `visibility: 'private'`
meant your own **public** template lost its "Shared" badge whenever the Plan
tab rendered it from cache.

The ownership fix still earns its place — it is a landmine for PR4b, where
cached shared templates genuinely will exist — but it was **latent**, not
live, and the entry said otherwise. Same correction discipline as c8d647b.

The v8 upgrade therefore **backfills** `owner_user_id = user_id` rather than
leaving NULL. NULL is the cautious default in the abstract and simply wrong
here: it is untrue for 100% of real rows, it would label every one of an
upgrader's own workouts "VOLA template" until a refresh landed, and an
ownerless private workout is a pair the server cannot produce.

### The cache never pruned

The blocking find. `cacheWorkouts` only ever upserted and nothing anywhere
deleted from the table — so a workout deleted on this phone, or on the web,
stayed cached **forever**. With the Plan tab now reading cache-first, the
deleted template flashes back on every tab focus until the network answers,
and offline it is simply listed as still existing and dead-ends on tap. Both
callers pass the complete `mine` list, so reconciling inside the existing
transaction is safe: drop this athlete's rows whose ids aren't in it.

### Testing

The first PR4 to land after the SQLite fixture, and it earned it immediately —
the bug was in what the columns *hold*, which the old array mock could not have
expressed.

Review then found **three surviving mutations** in those tests, which is the
adversarial pass paying for itself: dropping *only* the `owner_user_id` half of
the ON CONFLICT refresh (the sole conflict test asserted visibility, so the
clause the whole backfill story depends on was unpinned); breaking the
per-athlete filter in the *sport-narrowed* branch (the isolation test used the
other branch — and the sport branch is the one offline session-start calls);
and never storing `items` at all (nothing asserted items or `goal` round-trip,
though the Plan tab renders `items.length` from cache and carrying `goal`
offline was the entire point of schema v6). All three now fail.

Also caught by having schema tests at all: bumping `SCHEMA_VERSION` failed
three existing assertions immediately, which is the intended friction — a
version bump should be a conscious act.

Two mistakes of mine while writing it, both recurrences, and **both now made
structural rather than remembered**:

- **Backticks inside a SQL comment** ended the JS template literal — second
  time. TypeScript does catch it, but as a wall of unrelated syntax errors
  twenty lines down, which reads like the code is broken rather than the
  comment. `sqlComments.test.ts` now fails with the offending file and line
  instead.
- **A failing typecheck scrolled past and the commit happened anyway** —
  second time, once on the test-runner PR and once here — because I ran the
  checks as separate lines and a newline is not a dependency. There is now one
  `pnpm run verify` that chains everything with `&&`; verified it halts, by
  breaking a type and watching the later steps not run. CLAUDE.md points at
  the single command and says why.

(The third, unrelated: the first v6 upgrade fixture created only
`local_sessions`, so a later `addColumnIfMissing` threw "no such table" for a
reason that cannot happen on a device, which has every earlier table.)

### Not in this PR

Writing. Creating and editing templates still needs the network — that is PR4b,
and it is the headline of the original request.

## 2026-08-01 — Offline-first PR4b: workouts writable offline

The headline of the original request. `workout_cache` gains the same outbox
shape `local_sessions` has — dirty / remote / deleted_at / updated_at — and
create, edit-items and delete all write locally first.

Existing rows upgrade to `dirty = 0 / remote = 1`, which is the truth for them:
everything cached so far arrived *from* the server, so none of it is owed a
push. Defaulting the other way would fire every cached workout back at the
server on first launch after the upgrade.

### Conflicts: the CAS, not last-write-wins

Decided by the user, and mirroring sessions. `pushWorkoutRow` clears `dirty`
only `WHERE updated_at` matches what it read, so an edit landing mid-push
leaves the row dirty for the next pass rather than being marked as sent. The
server-refresh path carries the same idea structurally rather than by
convention: its `ON CONFLICT` refuses to write over a row with `dirty = 1` or a
tombstone, because anything arriving from the server is by definition older
than what this device has not pushed.

### Ordering: workouts before sessions, and *deferral*

`sessions.workout_id` is a real FK, so a session referencing a workout the
server has never seen is refused. "Workouts first" alone is not enough,
though — **if the workout push fails, the session must be held back too.**
Otherwise it hits the FK error, and since a 4xx classifies as `permanent`
under PR2's rules, the orchestrator would stop retrying training that is
perfectly fine and report it as doomed.

So the sync pushes dirty workouts, collects the ids still not `remote`, and
**defers** any session pointing at one — counted as `deferred`, never `failed`.
Today's badge says so in words: *"waiting on a plan that hasn't synced yet"*.
That distinction is the same one this whole programme keeps turning on —
"we couldn't ask" versus "the answer is no".

### A silent id bug

`createWorkout` minted its own UUID internally. Pushing an offline-created
workout would therefore have created it server-side under a **different id**,
leaving any session started from it pointing at a workout that never arrives.
The id is caller-supplied now, the contract sessions already had.

### Two bugs my own tests caught

`cachedWorkouts` did not filter tombstones, so a deleted workout stayed
visible. And **PR4a's reconcile would have deleted never-pushed local
creations** — "absent from the server list" is only evidence of deletion for
rows the server knows about, and a workout created offline is absent because
the server has never heard of it. That one would have destroyed a plan made in
a gym.

### The detail screen had to become readable too

PR4a made the *list* offline; the plan's contents still needed the network, so
it dead-ended. An editable plan you cannot open is no use, so `workout/[id]`
now reads cache-first as well, with the exercise catalog following the same
cache-then-refresh shape the session screen uses.

### Testing

Five mutations checked: drop the CAS on refresh (1 test), let the reconcile
delete unpushed rows (1), stop filtering tombstones (2), re-stamp an existing
tombstone (1), report deferred rows as failures (1).

**Correction, from the review round below:** the last of those was unbacked as
first written. `sync.test.ts` mocks `syncSessions` wholesale, so it covered the
orchestrator *displaying* a deferred count, not `runSync` *producing* one —
mutating `runSync` to count deferrals as failures left the suite green. The
`pushWorkoutRow` tests added afterwards do cover it.

### The review round, and what it found

Six blocking findings, and the first two are the ones worth remembering.

**`lib/workouts.ts` threw plain `Error`.** `lib/sessions.ts` had been migrated
to `ApiError`; this module never was. `isNotFound` and `isPermanentRejection`
both answer `false` for anything that is not an `ApiError` — on the sound
reasoning that it never reached the server — so **every classification branch
in the workout push path was dead code**. A 404 on delete never counted as
success, meaning a tombstone for a plan deleted on the web would fail every
sync run forever. A permanent refusal classified as `transient`, so the
orchestrator would grind a doomed request for the life of the install: exactly
the failure PR2 exists to prevent, revived in the new outbox.

**And my own test hid it.** The `pushWorkoutRow` tests mock `../workouts`, and
the mocks rejected with `ApiError` — supplying the contract the real module did
not honour. The 404 and permanent-restore tests passed against branches
unreachable in production. Eleven source mutations had been checked and all
eleven were caught, because every one of them mutated `sessionStore.ts`; the
defect was in the dependency, where no mutation was looking. **Mutation testing
proves a test can fail, not that its fixtures are honest.** The fix is a
`workoutsApi.test.ts` that never mocks `../workouts` and asserts the property
the other file's mocks assume — so the two cannot drift apart again silently.

The other four:

- **A workout delete deterministically orphaned its sessions.** Workouts are
  pushed first *by design*, so a tombstoned workout's row leaves the cache
  before the session loop runs — the deferral could no longer see it, the
  session went out referencing a workout the server had never heard of, was
  refused 400, and classified permanent. Not a race; guaranteed. Fixed by
  nulling `local_sessions.workout_id` at delete time, which is precisely what
  the server's own `ON DELETE SET NULL` does, so both sides converge. The link
  is metadata; the training is the data.
- **`pushSession` bypassed the deferral entirely** — it lived only in the batch
  loop, and `pushSession` is what runs on every debounced save from the session
  screen. Ticking a set just after signal returned would show a fatal-looking
  error and file a `sync_blocked` operator report, mid-workout, for a row that
  heals itself moments later.
- **Both screens rendered the server's stale copy over unpushed local state.**
  The CAS protected SQLite and the UI then undid it on screen: reopen an
  offline-edited plan online before its push landed and the edit visibly
  vanished, Save went inactive, and editing on from what was displayed
  overwrote the local row with stale items — the athlete losing their own work
  with their unwitting help. The list screen had the same shape, rendering the
  raw response instead of the reconciled cache. It now renders the cache, which
  is also the honest answer: what is on screen is what is on disk.
- **Dirty workouts were not in `pending`,** and `pending` is not a badge — it
  gates the retry timer and the foreground trigger. An edited plan that failed
  transiently got neither. The offline case survived only by accident, because
  `!online` trips the foreground gate on its own.

Twelve mutations checked across the fixes; all twelve caught. One was vacuous
on the first pass (the zero-row save guard had no test at all) and is now
covered.

**Still untested: the two screen fixes.** `apps/mobile` has no component test
runner, so the SQLite-level behaviour is covered and the render path is not.
Worth having, not worth blocking this on — recorded here rather than left to be
rediscovered.

A note on the SQL-comment guard added earlier today: the backtick trap fired a
**third** time here, and the guard did not help — `tsc` runs first and reports
it as unrelated syntax errors twenty lines down, so the named failure never got
a chance to speak. The guard is worth less than I claimed when I added it.

### Not in this PR

`replaceItems` is still a whole-list replace, so two devices editing the same
plan is last-writer-wins *at the server* even though the CAS protects the local
row. Renaming a template is still impossible on any client — there is no
endpoint. Both are worth deciding on deliberately rather than discovering.

## 2026-08-01 — Two gym complaints about the same thing: getting a number in

Both items came from logging live, and both are about the seconds between
sets rather than about data.

### The keyboard was covering the inputs

Reported as *"i had hard time with inputs that are lower and go bihind the
keyboard from iphone, i think we need to push that block above the input block
so it is always visible... and then slide it back"*.

The screen **already had `automaticallyAdjustKeyboardInsets`**, so the first
question was why that wasn't enough.

**I answered it wrong, confidently, and shipped the wrong answer in a doc
comment.** I wrote that the prop "adjusts the inset but never scrolls" — that
iOS merely makes the hidden field *reachable* and leaves you to drag it into
view. The reviewer checked it against the actual RN 0.86 source and it is
false. In `RCTScrollViewComponentView.mm`'s `_keyboardWillChangeFrame:`, RN
asks the first responder for its focus rect and, when the field's bottom is
below the keyboard, sets `contentDiff = keyboardEndFrame.origin.y - focusEnd`
and scrolls by it, on the keyboard's own animation curve.
`RCTTextInputComponentView.mm` even adds a 15pt margin. iOS lifts the field on
every keyboard appearance, and does it better than we can.

**The real gap is narrower and more specific: the native adjustment only runs
when the keyboard's FRAME CHANGES.** Every field on this screen is a
`number-pad` or `decimal-pad`, and those are the same height. So moving focus
Weight → Reps → RIR → RPE — or expanding a lower row while the keyboard is
already up and tapping into it — posts no keyboard notification at all. No
notification, no native scroll, field stays hidden. That is exactly the
reported experience, and it is the only case
`components/KeyboardAwareScroll.tsx` needs to handle.

**The wrong explanation was not harmless, which is the point.** Believing the
platform did nothing, I had the keyboard listeners scroll as well as the
`onFocus` path — so on every keyboard appearance two mechanisms raced for one
scroll position. `offset.current` lags (it updates from throttled `onScroll`
events), so a JS scroll computed after the native one landed used a stale
offset and dragged the list *back down*, hiding the field again —
intermittently, depending which won. A plausible mechanism, unverified,
produced a real bug that the feature working most of the time would have
hidden.

The listeners now only record where the keyboard is; `onFocus` alone scrolls,
and only when the keyboard is already up. That also dissolves the "two event
orderings" problem the first version was carefully managing: there is one
path now.

**The lesson is the one this log already records once** — the Nixpacks entry
that had to be corrected because the recorded mechanism was disproven by our
own code. A mechanism you have not read is a guess, however well it predicts
the symptom, and writing it down as fact is how it gets built on.

Two details that would each have made it subtly wrong:

- **Measured, not assumed.** The tempting version scrolls by a fixed amount or
  by the keyboard's height. Set rows vary in height by the exercise's measures
  (reps-only vs weight+reps vs distance+seconds) and by whether the row is
  expanded, so any constant is wrong for most rows. `measureInWindow` asks
  where the field actually is; the scroll is the overlap plus a margin.
- **Both event orderings are real.** Tapping a field with no keyboard up fires
  focus first and the keyboard frame after; moving to a second field with the
  keyboard already up gives the frame first. Handling only the first is the
  common bug — it works the once you test it and fails the moment you move
  between fields, which is exactly what logging a set is.

No new dependency. `react-native-keyboard-controller` does this and more, but
it is native code, and this is about forty lines against an API RN already has.

### Android was silently getting nothing, for two separate reasons

The first version was iOS-only without saying so, and both causes are the kind
that review does not catch because the code looks right.

**`keyboardWillShow` and `keyboardWillHide` are iOS-only events.** Android
never emits them. So the listeners were not a degraded experience on Android —
they were dead code, and the feature did nothing at all there while reading as
complete. The event names are now chosen by platform, and because that is one
line that decides whether a whole feature exists, it is a tested pure function
rather than a comment.

**The two platforms hide the field in different ways.** iOS leaves the window
alone and puts the keyboard over it, so the keyboard's top edge is the
boundary. Android's default `softwareKeyboardLayoutMode` is `resize`, so the
*window shrinks*: the scroll view is now short, the keyboard is not over it at
all, and the field is **clipped by the view's own bottom** rather than
covered. Comparing against the keyboard alone would read that field as
comfortably visible and scroll nothing.

Rather than branch on `Platform` for the geometry, the scroll view is measured
too and the boundary is the *higher* of the two edges. That describes both
platforms with one rule, and it degrades sensibly if a third case shows up
(a split keyboard, a floating window) — whichever edge is actually cutting the
field off is the one used.

**Not verified on an Android device.** There is still no Android build of this
app — never prebuilt, never run. The platform logic is tested and reasoned;
that is not the same as seen working, and it should not be recorded as if it
were.

### Swipe left to remove a set

Removing a set was already possible — tap the row open, scroll past every
field and the set-type chips, tap "Remove set". That is a reasonable place for
it when you are correcting a session at a desk, and a bad one when you have
just added a set by mistake between two working sets.

`components/SwipeToDelete.tsx` is **reveal-then-tap, deliberately not
full-swipe-to-delete.** The other half of the iOS convention was left unwired
on purpose: the thing being deleted is a set that was actually performed, the
hand is mid-workout, and the row lives in a vertically scrolling list where a
slightly diagonal flick is completely normal. One deliberate tap costs nothing
at the speed this is used at; an accidental delete costs real training.

`PanResponder` rather than `react-native-gesture-handler`, which is not a
dependency — adding native code for one row interaction would mean a prebuild
and a fresh device build for everyone.

Two things that are less obvious than the animation:

- **The gesture claim is the whole difficulty.** Claim too eagerly and the
  list intermittently refuses to scroll, because a row decided a
  mostly-vertical drag belonged to it. So a claim needs the drag to be past a
  threshold *and* decisively horizontal — either test alone lets the wrong
  gestures through.
- **Rows are keyed by index, and now carry animation state.** `LoggedSet` has
  no stable id, only a `position` that is reassigned on delete, so an instance
  outlives the set it was showing: swipe set 3 open, remove set 1 by some
  other route, and that instance now renders set 2 while still holding set 3's
  open swipe — a Delete armed against a row nobody swiped. A `closeOn` prop
  keyed on the set count closes open rows on any list mutation, which is what
  iOS does for the same reason.

### Testing, and what is honestly not tested

`apps/mobile` has jest and a real SQLite fixture but **no component test
runner**, so nothing here can assert that a row slides or that a field ends up
on screen. Rather than write tests that render nothing and prove nothing, the
two actual decisions were extracted into pure functions — `scrollTargetFor`,
`shouldClaim`, `settleTarget` — and tested directly. Ten mutations, ten
caught.

One was vacuous first time round, and the mistake is worth recording because
it is the same shape as the mocked-`ApiError` test earlier today: the
zero-height-node case used `fieldY: 0, fieldHeight: 0`, which the *overlap*
check already rejects on its own — so the test passed with the height guard
deleted. It named one guard and exercised another. Fixed by measuring a
zero-height node *below* the keyboard, which only the height guard rejects.

**Still untested:** the render path, the gesture wiring, the context plumbing,
and all on-device behaviour. Adding a component runner is tracked separately.

### What else the review caught

- **`pointerEvents` is not an accessibility gate.** It maps to
  `userInteractionEnabled`, which governs hit testing; the accessibility tree
  is walked independently. So VoiceOver was reading "Delete set 1, button"
  before every closed row — double the elements, a destructive action
  announced on rows nobody had swiped, including on finished sessions. On
  Android it is worse than noise: TalkBack activation goes through
  `performClick()`, which `pointerEvents` does not gate, so it could plausibly
  have fired. Now hidden from assistive tech as well as from touch.
- **The Delete label failed the project's own contrast bar.** White on
  `danger` measures 2.78:1 — under AA's 4.5 and under even the 3:1 large-text
  floor — on a destructive control read in gym daylight. `navy` on the same
  red is 6.75:1. Notably it was also the only colour in the app without a
  measured ratio recorded next to it, which is exactly the one that turned out
  to be wrong.
- **`enabled` gated the swipe claim but not the open state**, so finishing a
  session with a row already swiped left a live Delete on a read-only record.
  It now force-closes, and the guard moved *inside* `shouldClaim` so the one
  thing here that can destroy a logged set is covered by tests at all.
- **Global keyboard listeners fire for other screens.** The session screen
  stays mounted under the exercise picker, so focusing the picker's search
  field scrolled the invisible list underneath. Gated on screen focus.
- **`closeOn={sets.length}` was right by luck.** A count catches add/remove but
  not a reorder that preserves length; the reorder case survived only because
  the group key happens to remount the subtree. Now keyed on identity.
- **My PanResponder rationale was inverted for iOS.** `blockNativeResponder`
  is Android-only and `RCTSurfaceTouchHandler` refuses to be prevented from
  inside the surface, so on iOS an over-eager claim cannot freeze the list —
  it causes a diagonal drag to swipe and scroll at once. The frozen-list
  failure I wrote the guard against is the *Android* one. The guard is right;
  the stated reason was not.
- **A test that could not fail for its own reason.** The margin test imported
  `KEYBOARD_MARGIN` on both sides of its assertion, so changing the margin's
  *value* could not break it — coverage existed, but in a different test than
  the name implied. Pinned to a literal now. Same shape as the mocked-`ApiError`
  problem earlier in the day, one degree milder, and the second time in one
  session that a test agreed with its own fixture.

## 2026-08-01 — A component test runner, because two real bugs lived where no test could see

`apps/mobile` had jest and a real SQLite fixture, and the config said in as
many words that rendering tests "would be a lot of ceremony aimed away from
where the bugs are" — with a note to widen it when a component test earned its
place. The PR #80 review is when it did.

Two of that review's blocking findings were defects **only in the render
path**, with the store underneath behaving perfectly:

- The workout detail screen adopted the server's copy over an unpushed local
  edit. The CAS in SQLite correctly refused to mark the newer edit as sent,
  and the screen undid that visually — reopen an offline-edited plan while
  online and the edit vanished, Save went inactive, and editing on from what
  was displayed wrote stale items back over the local row.
- The workouts list rendered the raw `listWorkouts` response instead of the
  reconciled cache, so a workout created offline disappeared the moment a
  stale response landed. Not an unlucky race: creating one fires the sync
  request and the reload together.

No SQLite-level test can see either. `@testing-library/react-native` now
covers both, and each is mutation-verified — revert either fix and its test
turns red.

### What the setup cost, and what it taught

Three things went wrong that are worth writing down, because they are the
generic ones:

- **A mock that quietly diverged from the hook it replaced.** `useFocusEffect`
  was stubbed as `useEffect(cb, [])`. The real hook re-runs when its callback
  identity changes, and screens depend on that — the workouts list wraps
  `load` in a `useCallback` keyed on `scope`, so switching tabs is what
  triggers the refetch. Pinned to `[]`, the mock produced a screen that could
  never reload, and the scope test failed for a reason that existed only in
  the mock.
- **RNTL must be imported at module scope in setup**, not inside a hook.
  Importing it registers its own cleanup hooks, and doing that from inside a
  running test throws "Hooks cannot be defined inside tests" — which broke
  every pure-logic suite in the project, not just the new ones.
- **`verify` caught what jest did not.** The suite went green while `tsc`
  failed on the mock signatures. That is the check chain doing exactly the job
  it was built for after the two occasions this year when tests were pushed
  without a typecheck.

### The act() warnings are still there, on purpose

The detail-screen tests emit seven "not wrapped in act(...)" warnings. The
screen chains its loads — cache, then `getWorkout`, then the exercise catalog
for whichever sport that returned — and the tail resolves while the test body
is still running.

Every fix tried was worse than the noise, and each was measured rather than
assumed: extra flush rounds in shared setup change nothing (the updates have
already happened); act-wrapping `render` clears the warnings but makes each
assertion observe the fully-settled state instead of the frame under test, and
collides with RNTL's auto-cleanup. So they stay, documented at the top of the
file, with the note that the assertions under them are mutation-verified.

This is a deliberate acceptance rather than an unnoticed mess — the reason to
write it down is so the next person doesn't spend the same hour on it.

## 2026-08-01 — Offline-first PR5: a fresh install fills itself, and the catalog stops lying

Three related gaps, all versions of "the offline work protected what you had
and never made sure you had anything".

### The exercise cache was lossy, and it looked like a product decision

`exercise_cache` stored seven typed columns and **reconstructed the rest as
empty** — `primary_muscles: []`, `equipment: []`, `instructions: ''`. So
offline, every exercise in the Library rendered with no muscles, no equipment
and no explanation, which reads as an app with thin content rather than a
cached copy of a full one.

Schema v10 adds `payload_json`: the exercise exactly as the API sent it. The
typed columns stay, because they are what SQL filters and sorts on — the blob
is for fidelity, the columns are for queries, and storing only the blob would
mean filtering the whole catalog in JS.

`payload_json` is deliberately **nullable with no backfill**. There is nothing
to backfill *from* — the dropped fields were never stored — so a default would
be a fabricated exercise that reads as real and never gets refreshed, rather
than a missing one the next fetch fills in. Pre-v10 rows fall back to the old
reconstruction, which is worse but findable.

**And the Library never read the cache it had been writing since v2.** It
warmed the catalog on every visit and then went to the network anyway, so the
one screen that feeds the mid-workout exercise picker was online-only in the
room with the worst signal in the building.

### Preferences get a real outbox

The `*_OWED` companion keys worked but did not generalise: every new syncable
preference needed its own flag, its own read and its own clear, and forgetting
one meant a preference that silently reverted on the next profile fetch.

v10 puts `dirty` on `prefs` itself. Two details are load-bearing:

- **`dirty = max(prefs.dirty, excluded.dirty)` on conflict**, not
  `excluded.dirty`. A write that says nothing about the debt must leave it
  standing — clearing it would drop a change made offline seconds earlier,
  which is the exact failure the OWED keys existed to prevent.
- **`clearPrefOwed` is a compare-and-swap on the pushed value.** A change made
  while the push was in flight stays owed instead of being marked as sent —
  the same CAS the session and workout outboxes use.

Existing OWED flags are *migrated*, not dropped: the flag means "the athlete
changed this offline and the account still has not heard", so discarding it on
upgrade reverts their choice.

### The first-run seed

Every cache in this app is filled as a side effect of opening a screen while
online. Fine after a week of use; useless for the case that actually happens —
install VOLA at home, open it, go to the gym, find the exercise picker empty
because you never opened the Library.

`lib/seed.ts` runs once per account per device, ordered by dependency rather
than importance: profile (carries the unit system, and a weight in the wrong
unit for one frame is the bug that started the units work) → exercises (a
plan's items are exercise ids; a plan of raw UUIDs is not a plan) → workouts →
sessions (same order as the push, for the same reason) → pinned.

Two properties worth stating because both are easy to get backwards:

- **A failed step does not abort the run.** Offline every step fails, so there
  is nothing to abort early for, and a failed workouts fetch must not also
  cost the athlete their sessions.
- **A partial run is NOT recorded as seeded.** Marking it done would leave the
  missing pieces missing until someone happened to open the right screen —
  precisely the situation this exists to prevent.

It does not block the UI. Screens already paint cache-first with honest empty
states; blocking a first launch on five network calls would trade a rare bad
gym session for a bad first impression on every single install.

### Two process notes

**The backtick-in-SQL-comment trap fired a fourth time**, in my own comment.
The guard added for it *does* catch it — the earlier entry claiming "the guard
did not help" was wrong about why. The real problem was ordering: `verify` ran
`typecheck:mobile` before `test:mobile`, so a broken template literal surfaced
as a pile of unrelated TS errors and the named guard never got to speak. The
two are now swapped, which was verified by breaking it on purpose.

**A mutation run reported CAUGHT for a file that was already failing.** Adding
the v10 schema test broke three existing assertions (they pin the version
number deliberately), and the mutation harness read those pre-existing
failures as the mutants being caught. A mutation result only means anything
against a green baseline — checked, fixed, and re-run.

## 2026-08-01 — Offline-first PR6: the sync state finally says something

`SyncState` has carried `pending`, `deferred`, `online` and `lastError` since
PR2, and the only place any of it surfaced was a Retry button on one screen.
So the honest answer to the question an athlete has after a basement workout —
*did that make it off my phone* — was to open the right screen and infer it.

### The chip, and what it deliberately does not say

It lives in `ScreenHeader`, so every tab gets it and a screen added later gets
it for free rather than being the one place that quietly doesn't report.

**It is silent when everything is synced.** A permanent "Synced ✓" badge is
furniture: it trains you to stop reading that corner, which is exactly where
you need to look on the day it says something else. The chip appearing *is*
the signal.

The priority order is the design, and each step of it is a claim:

- **Offline outranks the pending count**, because it explains it. "3 waiting"
  beside a phone with no signal invites a pointless retry; "Offline · 3
  waiting" says the app is behaving correctly.
- **Offline also outranks the error.** The last run failing because there was
  no signal is not a fault, and calling it one teaches people to distrust the
  indicator.
- **Deferred outranks the plain count**, and gets its own wording. Those rows
  are waiting on a workout that hasn't landed and resolve themselves; they are
  counted inside `pending`, so checking `pending` first would describe them as
  an ordinary backlog.
- **An error outranks "Syncing…"**, because a retry is usually already
  underway when someone looks, and hiding the failure behind progress makes it
  invisible exactly when it is being looked for.

### A permanent rejection had nowhere to live

It surfaced as one screen-level message for the whole run and vanished on the
next attempt — so a session the server will refuse forever looked identical to
one that simply hadn't been tried. No way to see which row, what the server
said, or to retry just that one after fixing it.

Schema v11 puts `last_error` on `local_sessions` and `workout_cache`, and
`app/sync.tsx` is where it is answerable: what is stuck, the server's own
words, and a button per row.

**Only permanent refusals are recorded.** A transient failure is the ordinary
state of a phone in a basement; writing "Network request failed" onto every
row would turn a repair list into a list of everything ever logged offline,
none of which needs a person.

### Two things this round taught, both about tests

**A test that passed for the wrong reason, caught by mutation.** "Clears the
error once the row goes through" asserted via `blockedRows` — but a successful
push also clears `dirty`, and `blockedRows` filters on that, so the row left
the list whether or not the message was cleared. It now asserts on the column.
That is three times in this programme that a passing test was measuring a
neighbour rather than the guard it named.

**The migration fragility from PR5 was still there and bit again.** The v11
`ALTER` on `local_sessions` failed against fixtures that never created it,
same as v10's did for `exercise_cache`. All the `CREATE ... IF NOT EXISTS`
statements now run unconditionally before any versioned `ALTER` — they are
idempotent, an existing table keeps its shape, so the ALTERs are still what
upgrades a real device and still what the tests exercise.

**And a local-only false failure worth knowing about:** `.expo/types/router.d.ts`
is generated and gitignored, so a new route fails `typecheck:mobile` locally
against a stale copy while CI — which has no copy at all — is perfectly green.
Verified by deleting it and re-running. Neither state is wrong; they just
disagree, and the local one looks like a real error.
## 2026-08-01 — BJJ rank: the backend and the belt, with the clients still to wire

**Partial work, committed deliberately.** The backend module and the belt
component are complete and tested; the client wiring is not started. Written
up now rather than at the end so the next session picks up decisions rather
than re-derives them.

### Where it lives, and why not on `profile`

`profile.go`'s package comment already called this before there was anything
to put in it: *"BJJ-specific profile data (belt, stripes, academy, promotion
history) belongs to the future bjj module, not here."* Profile is the
account-level record four disciplines share, and a belt is meaningless to
three of them. So the data is `internal/modules/bjj` behind `/v1/bjj/*`, and
the *screens* still show it inside the profile — a UI decision, not a reason
to put a belt column on the shared account record.

### Rank is derived, and derived by RANK — not by date

The obvious schema is `profiles.belt` + `profiles.stripes`. It is wrong twice
over.

**A current-rank column and a promotion history are two sources for one
fact.** Edit a date, delete a mistaken entry, and the column still says brown.
Deriving the rank from the history means there is nothing to keep in step.

**And the derivation is by rank order, not by most-recent date.** Dates are
optional — plenty of people genuinely do not remember when they got their blue
belt — and they are hand-entered, so ordering by them makes the current belt a
function of data-entry care. Rank in BJJ is monotonic: nobody is demoted. So
the highest recorded rank *is* the current one, and that holds whether the
promotions went in forwards, backwards, or with no dates at all.

The test that pins it is `white/4` versus `blue/0` — the pair a naive
`belt + stripes` score gets wrong, and not an edge case: every athlete passes
through it. `Rank.Order()` multiplies by the maxima so a belt change always
dominates stripes within a belt.

Two smaller calls in the same vein:

- **No promotions means no belt, not white.** A new account has no rank, and
  defaulting to white puts a belt on someone who has never trained.
- **An unknown belt is skipped, not sorted as zero.** A row written by a newer
  build (coral, say) must not read as *below* white and lose to a real white
  belt. Acting as though the row is absent is the honest degradation.

### The belt is drawn, not illustrated

`components/Belt.tsx` is three views: strap, rank bar, stripes. No
`react-native-svg` — a native dependency means a prebuild and a fresh device
build for everyone, which is a lot to pay to draw four straight lines. It also
means the web and admin versions are the same shapes in CSS rather than an
asset pipeline nobody remembers to regenerate.

Details that matter to anyone who trains: the rank bar is **black on coloured
belts and red on a black belt**, because that is how belts are made. The white
belt carries a hairline border or it reads as a floating rank bar on VOLA's
near-black ground. Stripe count is **clamped at render**, so a cached row from
an older build degrades to a sensible belt instead of drawing off the end of
the strap.

One near-miss worth recording: the stripe gap was first written as `gap: '8%'`,
which **typechecks and is not honoured** — RN accepts a percentage there in its
types but does not apply it like a percentage padding, so four stripes would
have bunched into one thick line and read as a different rank. It is computed
numerically now.

### Deliberately not built yet

Answered up front, so the next session does not re-litigate:

- **Adult IBJJF belts only** (white→black, 0–4 stripes, 1st–6th degree). Kids
  and coral/red are absent from the enum; there is **no CHECK constraint** on
  the column precisely so adding them is a code change, not a migration.
- **Academy is free text per promotion**, not a shared entity. Shared academies
  need dedupe, a naming authority and an admin merge surface, and nothing yet
  asks "who else trains here".
- **Promotion ids are server-minted** via `gen_random_uuid()`, unlike sessions
  and workouts. Those are client-generated because they are created offline and
  pushed later and the id is what makes the retry idempotent; a promotion is
  entered at a desk, so a client id buys nothing — and the column default costs
  no Go dependency.

### What is left

1. `lib/bjj.ts` client + the You screen (belt, time at belt, history) and an
   add/edit promotion flow.
2. The same rendering on web and admin — admin's user detail should show rank
   beside the athlete.
3. **Filtering the technique library by belt**, using the `TypicalBelt` and
   `GiAllowedBelts`/`NoGiAllowedBelts` fields the technique module already
   carries. Agreed as a separate PR.

### Why belt is not decoration

[bjj-tracking-design.md §5](bjj-tracking-design.md) already decided that
curricula are **belt-level tracks** where each step sets the current focus —
the top-down entry for an athlete who cannot yet self-select one. So belt is
the entry point into the progression loop, and the promotion timeline is what
makes "three years at blue" a fact the system can reason about instead of a
memory. That is the thread from this record to the gameplan; the library
filter in (3) is the first honest read along it.

## 2026-08-02 — BJJ rank: the clients, wired end to end

Closes the gap the previous entry left open: `lib/bjj.ts` + the You screen +
add/edit/delete on mobile, the same on web's Settings page, and admin's
read-only rank badge. The library filter (item 3 above) stays its own PR, as
already agreed.

### Mobile

`lib/bjj.ts` mirrors the backend's wire shape exactly (`Belt`/`Rank`/
`Promotion`/`Standing`), through `apiRequest` rather than the older
hand-rolled `request` helper `profile.ts`/`records.ts` still carry — the
newer convention, extracted precisely so a fourth copy wouldn't happen.

The You screen gets a `BjjRankCard`, gated on the `bjj` module being
**enabled**, not on a history existing — the same reasoning as web's
Records/Library sidebar gating, so turning BJJ off hides the card even for an
account with a recorded belt.

`/bjj` is the hub: hero belt, time-at-belt, and the promotion timeline
(already newest-first from the repository's own `ORDER BY`). `/bjj/promotion/new`
and `/bjj/promotion/[id]` share one `PromotionForm` — add and edit are the
same fields, and the only differences are which request goes out and whether
Delete is offered. There's no GET-by-id promotion endpoint (only the list),
so the edit screen doesn't fetch at all — it receives the row it already has
from the hub's list as route params, all scalar. Delete goes through
`Alert.alert`, the first native destructive-confirm this app has needed
outside `SwipeToDelete` — deliberately not reused, since that component's own
reasoning (sweaty hands, mid-set, a scrolling list of sets) doesn't describe
editing a promotion at a desk.

### Web and admin

Web's `dashboard/settings/page.tsx` gets a `BjjRankSection`, gated the same
way as mobile: belt swatch, promotion history, inline add/edit — no modal, no
separate route, because Settings is already the account-facts page and a belt
is an account fact. `apps/web`'s `Belt.tsx` is a third, deliberate copy of the
same three-rectangle CSS drawing — no shared package across the three apps,
so this duplication matches the reasoning the mobile component already gave
for not reaching for `react-native-svg`. Admin gets its own fourth copy,
read-only (no picker, no stepper — it never edits a rank).

Admin needed a route the self-service API doesn't have:
`GET /v1/admin/users/{userID}/bjj/standing`, under `RequireAdmin`, reusing
`ListPromotions`/`StandingFrom` over a path `userID` instead of claims.
Rendered as a small belt and label beside the display name in the header —
beside the athlete, per the brief — with no edit affordance, matching the
rest of admin.

**Found in verification, not design:** an account that has recorded a
promotion but never logged a session, activity or profile is invisible to
admin entirely — `AdminGetUser` 404s, and `AdminListUsers` doesn't scan
`bjj_promotions` for user discovery either. Not fixed here, since it's a
discovery gap rather than part of wiring the display, but real — worth
closing if a BJJ-only, never-trained-yet account ever needs support.

### A real bug the live walkthrough caught

Switching belt to black in the add/edit form left the old `stripes` count
sitting in state. The stripes stepper is hidden once black is picked, so
nothing on screen *looked* wrong — until the live preview label, which
computes its text from `describeBelt` independently of the swatch, read
"Black belt, 2 stripes" while the swatch correctly drew none. `describeBelt`
checks `stripes > 0` before falling through to a bare belt name, with no way
to know that value was stale for the belt now selected. Fixed by zeroing the
field that stopped applying, not just the one that started — the belt-chip
handler now clears `stripes` on a switch to black and `degree` on a switch
away from it, symmetrically, in both the mobile and web forms. This was only
caught because the promotion was walked through end-to-end on a real
Simulator and a real browser against a real Postgres, not read off the diff.

### A dev-environment footgun, unrelated to the feature

Verifying this needed a live backend, and `docker compose up -d` in this
worktree silently created a second, unused `bjj-postgres-1` container — the
primary checkout's own Postgres (`fitness-platform-postgres-1`, already
running, four days old) already held host port 5432, so the worktree's
container came up with no port published and every connection kept reaching
the older one. Nothing was actually wrong with the data — the primary's
Postgres was the real target the whole time — but `docker compose exec`
against the *worktree's* compose project queried a completely empty database,
which looked like a fresh-migration bug for several minutes before `docker ps
-a` explained it. Worth knowing before running two worktrees' `docker compose
up -d` back to back: only the first one actually gets the port, and the
second fails silently rather than erroring.

### Verified live, not just typechecked

Full CRUD walked end to end on a real iOS Simulator (empty state → add → edit
→ delete → back to empty, against a real Postgres-backed API) and a real
browser (the same cycle on web's Settings section, plus admin's read-only
badge on an account with a recorded rank). `pnpm run verify`, `build:web`,
`build:admin`, the Go integration suite against a real database,
`docker build`, and `pnpm run lint:openapi` all pass.

### What `/pre-merge`'s reviewers caught that the live walkthrough didn't

`backend-reviewer` signed off on `AdminGetStanding` outright — the
authorization boundary (`RequireAdmin`, never `RequireAuth`) and the
non-disclosure shape both hold, with one non-blocking suggestion (no test
pins that boundary, but no admin endpoint in this codebase has one, so it's
filed as a follow-up rather than invented ad hoc for this one route).

`frontend-reviewer` found one genuine blocking gap the manual walkthrough
never would have hit, because the walkthrough only ever reached `/bjj`
through the You-screen card: **the route itself had no self-check.** Gating
lived only at the door (`BjjRankCard`), so a stale back-stack entry from
before BJJ was turned off — or any other way of landing on `/bjj` — reached
the full rank hub and the add/edit form regardless of the module toggle,
directly contradicting the functional-scenarios.md entry written in this same
change. Fixed by moving the same `bjjEnabled` check into `app/bjj/index.tsx`
and `PromotionForm.tsx` themselves, so the route refuses on its own rather
than trusting whoever links to it.

It also caught a real, reproducible bug in web's form: wrapping the Belt and
Stripes/Degree button groups in `<label>` meant a click on the caption text
— not a button, the word "Belt" itself — forwarded to the first button in
the group via plain HTML label semantics, silently resetting whatever was
selected. `workouts/page.tsx`'s discipline picker already gets this right
with `<fieldset>`/`<legend>`; `BjjRankSection.tsx` now matches it, and its
belt/stripe pickers switched from `aria-pressed` to the same
`radiogroup`/`radio`/`aria-checked` pattern the Units picker on the same page
already uses. Mobile's edit route also gained a guard against a malformed
deep link falling through to an edit form that silently defaults to
White/0/blank — `BELTS.includes(...)` is checked before treating the params
as a real row, redirecting to `/bjj` otherwise.

## 2026-08-02 — Filtering the technique library by belt

Closes item 3 from the BJJ rank entries above, agreed at the time as its own
PR. The whole feature turned out to be client-only: `typical_belt` is already
on every technique summary both apps already fetch and cache, so no new
query param or endpoint was needed — only a new axis on a filter mechanism
that already existed.

### One new backend line, for a reason worth stating

The only backend change is adding `"belt"` to BJJ's `Facets` in
`internal/platform/discipline`, alongside the existing `"position"`. Clients
already had a mechanism for "extra filter axes this discipline supports,
gated on the module being enabled" — the position chip row reads it rather
than hardcoding "BJJ has positions" — so the belt row is the second thing to
ever use that extension point rather than a new one.

### Capped, not exact-match

Picking "Blue" shows White and Blue material, not Blue alone. A curriculum
is cumulative — a Blue-belt technique doesn't stop being relevant at Brown —
so an exact-match filter would hide material a higher belt still uses, which
contradicts what "commonly taught from" already means on the detail screen.
`atOrBelowBelt()` (one copy per app, matching how `inPositionFamily` already
has one copy per app) compares rank order, the same shape as the bjj
module's own `Rank.Order()`: an unrecognised belt on either side is treated
as "don't filter this out" rather than excluded, for the same reason
`StandingFrom` skips an unknown belt instead of sorting it as zero — hiding
real content because its categorisation is unreadable is worse than showing
one extra row.

**Deliberately not the same axis as IBJJF legality.** `gi_allowed_belts` /
`no_gi_allowed_belts` live on the `Ruleset` a technique references, not on
the technique itself, and an empty list there means "this division doesn't
apply," not "no belt may use this" — the exact mistake the technique-library
history entries already record being made three times. This filter only
ever reads `typical_belt`. Competition eligibility stays exactly where it
already was, in the detail panel's `Legality` section, un-touched.

### Defaulted from the athlete's own rank, once

Opening the Library with BJJ selected suggests the athlete's own current
belt as the cap — mobile fetches `getStanding`, web `getBjjStanding`, and
capitalises the lowercase `bjj.Belt` value to match the technique catalog's
own casing (the two vocabularies were never linked; this is the one place
they now have to agree, and only informally). It's a suggestion, not a
lock — every chip stays reachable either side of it, for browsing above or
below your own rank. Mobile remembers a manual choice afterward, the same
way it already remembers the sport chip, and does NOT clear it when the
sport chip moves elsewhere the way the position filter does — a belt is a
standing fact over years, not a transient narrowing that should silently
reappear and surprise someone, so it behaves like "I train BJJ," not like
"I'm looking at Mount right now." Web has no persistence for any Library
filter (sport and position both reset on reload too), so belt matches that
scope instead of inventing storage for one axis.

### A real, hours-long red herring: the backend was stale, not the code

Verifying this cost most of the time it took to build it, and the cause had
nothing to do with the filter. `go run ./cmd/api`, killed with
`pkill -f "go run ./cmd/api"`, leaves its **compiled child process** running
— the actual binary's command line is a `/var/folders/.../exe/api` temp
path, which that pattern never matches. Every "restart" this session
appeared to work (the port answered, `/v1/healthz` returned 200) while the
real server, from hours earlier, kept serving requests underneath, with
no "belt" in its module facets because it predated the whole change. The
belt row never rendered, on a real Simulator and against a real backend,
because the athlete-facing app was correct and the thing answering its
requests wasn't. Found by checking `lsof -iTCP:8080` for the actual PID and
its real start time rather than trusting that a `pkill` pattern matching the
command *name* had matched the process. Killing the backend for real means
killing the PID `lsof` names, not the invocation that spawned it.

### Verified live against the fixed backend

Real Simulator: belt row renders under BJJ, defaults to the signed-in
athlete's recorded rank, changes the list on tap. Real browser: the same,
plus the count moving exactly as expected across caps on one account's real
data — 150 shown at White, 450 at Purple, 466 (the full technique count) at
All levels. `pnpm run verify`, `build:web`, and the discipline/technique Go
packages' tests all pass.

### What `/pre-merge`'s reviewers caught

`backend-reviewer` traced the whole `/v1/modules` path specifically to
confirm there is no caching layer anywhere in it — `ModulesFor` calls
`discipline.All()` fresh per request, `WriteJSON` sets no `Cache-Control`
or `ETag` — which is worth having written down, because the stale-server
episode above briefly made a cached facets list look like a plausible
explanation. It wasn't; the process was. It also confirmed nothing reads
`Facets` positionally or exhaustively, so adding a string really is inert.

`frontend-reviewer` found no blocking issues but four things worth fixing,
all of which were:

- **An account-identity race with a documented guarantee behind it.** The
  mobile belt-default effect awaited a network round trip and then wrote
  state and prefs against a closed-over `userId`, with no check that the
  same athlete was still signed in — the exact race `ModulesProvider`
  already carries a `currentUser` ref for. It mattered more than usual
  because the functional-scenarios entry written in this same change
  *asserts* "signing in as a different athlete does not carry over the
  previous athlete's belt cap." The effect now mirrors `ModulesProvider`'s
  ref guard, and `beltDefaultedFor` holds the account it defaulted for
  rather than a boolean — a boolean conflated "already spent a request" with
  "for the person currently signed in," so the second athlete on a shared
  device would have been skipped entirely.
- **A lost default on web**, from folding two concerns into one ref: the
  effect's own cleanup cancelled the in-flight request whenever `modules`
  changed reference, while the already-set flag stopped the re-run asking
  again. Split into `beltFetched` (don't re-ask) and `mounted` (don't write
  after unmount), which are genuinely different questions.
- **`isFiltered` didn't match what `rows` filters on.** It counted
  `belt !== ''` unconditionally, but the filter itself is gated on
  `usesBelt(...)`. Since the belt cap deliberately survives the sport chip
  moving off BJJ, a cap could sit in state with its row hidden and inert —
  and an empty catalog would then read "Nothing matches this filter" when
  nothing was filtering. Cosmetic, but a real mismatch.
- **The offline fallback registry** in `apps/mobile/lib/modules.ts` still
  listed `facets: ['position']`, the one place duplicating the old
  assumption.

Plus one accessibility gap it named precisely: mobile reads each chip as
"Filter up to Blue," conveying the cap semantics, while web's chips said
only "Blue" — leaving a screen-reader user no way to learn the filter is
cumulative. `SmallChip` now takes an optional accessible name, used by the
belt row and deliberately not by the position row, where the visible text
already means what it says.
## 2026-08-02 — The library's positions stop being filter labels and become content

The user, reading the BJJ library as a beginner would, noticed what was
missing: every one of the 466 entries is a *move*, and nothing anywhere says
what a closed guard, a side control or a back mount actually **is**. Their
framing is the whole justification — "imagine a novice starts the journey and
they will download the app and learn from there... when we put together a
course plan for belts etc., these should be there."

They were right that it was absent, and it was absent by design rather than by
oversight. `docs/decisions/bjj-tracking-design.md` §4 already describes the
library as a graph — techniques are edges, positions are the organizing
dimension they run between — and the July-31 "One Library" work built a
position filter chip row on exactly that idea. But the nodes of that graph
never had any content of their own. Positions existed as free text on
`techniques.position` and as a seven-item client-side taxonomy: enough to
narrow a list, useless to someone who does not already know the vocabulary.

**What was built:** ten curated glossary entries (Standing, Closed Guard, Open
Guard, Half Guard, Side Control, Knee on Belly, Mount, North-South, Back
Control, Turtle), each with two prose fields — `description` (what it is and
how you arrive there) and `priorities` (what each player is trying to do,
written for both top and bottom, because every position is someone's good news
and someone else's problem). Backend + mobile in this PR; web follows.

**Why it lives in the `technique` module rather than its own.** Straight
precedent from `ibjjf_rulesets`, which is already a secondary table inside that
module: it is reference content for the library, read on the same screens,
seeded by the same command. A module boundary would have bought a package and
cost a cross-module call on every library render. Two things were deliberately
*not* copied from the rulesets precedent, because they exist there for reasons
that do not apply: positions have hand-authored stable ids rather than
content-addressed hashes, so there is no orphan-pruning step, and nothing holds
an FK to them, so there is no upsert-ordering constraint against `UpsertAll`.

**`SeedPositions` is separate from `Seed` for a concrete reason.** `Seed`
returns the technique count, and `postgres_test.go` compares that number
against the length of the technique list. Folding a second content type into
the same return value would have broken that assertion in a way that reads as
an unrelated failure. One exported function per content type, one log line
each in `cmd/seed`.

**The failure mode this feature ships with, if it ships with one, is silent.**
`family` is the join key back to the library, and it is prefix-matched against
side-qualified technique values — so back control's family must be the string
`Back`, not `Back Control`, because the rows say `Back - Top (Back Control)`. A
typo there produces a screen that renders perfectly and lists no techniques,
with nothing logging a fault anywhere. Hence two guards: Go-side seed
validation rejects any family outside the known set, and
`TestPositionsCrossLinkToTechniques` seeds both tables and asserts every
position matches at least one real technique.

**Known and accepted:** Closed Guard and Open Guard cross-link to the *same*
techniques. `techniques.position` only distinguishes `Guard - Bottom` from
`Guard - Top`; the closed/open split lives in free-text `position_detail`.
Refining that is a later change. Knee on Belly has no techniques of its own in
the library at all (verified — no row carries that position), so it borrows the
Side Control family and its description says outright that it is a transitional
control reached from there, rather than quietly rendering a thinner card.

**Two things found while verifying, both worth more than the feature.**

*The shared component-test mock manufactured the exact bug the real hook exists
to prevent.* `jest.setup.js` mocked `useAuthToken` as `() => async () => 'tok'`
— a fresh function per render. The real hook goes to deliberate lengths to be
identity-stable, and its own doc comment lists the three live bugs an unstable
`getToken` caused (infinite refetch loops, wiped local state, defeated
debounces). The mock reintroduced all of it inside the test harness: the new
screen re-entered its loading state forever, and every assertion after the
first `waitFor` failed. It read exactly like a bug in the screen. Fixed by
hoisting one getter — and it is worth noting the harness had this wrong for
every screen test written since PR #82.

*A test that passed for the wrong reason, caught by mutating the code it
claimed to cover.* The cross-link test asserted that `Half Guard - Top` and
`Mount - Bottom` are excluded from the Guard family. Removing the `- ` from the
prefix rule — the separator the comment calls load-bearing — did not fail it,
because neither fixture value starts with `Guard` at all. The assertion was
decorative. A `Guardless Scramble` fixture now makes it real, and the mutation
is caught. Same discipline as PR #75 and #78; the same lesson keeps arriving.

**Not verified on device.** The Simulator was not able to exercise this. Expo
Go on the booted simulator kept serving a cached bundle — it rendered a belt
filter that, at the time, existed in no branch of this repo, and made no
request to the local API even after Metro served a fresh bundle twice with the
right URL inlined. (The belt filter turned out to be real: #87 landed
mid-session. That resolved the mystery of *where* the stale bundle came from,
not why Expo Go kept preferring it.) Along the way this reconfirmed two
documented traps — `npx expo start` without
`NODE_OPTIONS=--dns-result-order=ipv4first` binds Metro to `[::1]` only, and
`.env.local` overrides a shell-supplied `EXPO_PUBLIC_*` unless
`EXPO_NO_DOTENV=1` is set. Clearing Expo Go's data container would likely fix
it but signs the account out of the simulator, so it was left for the user to
decide. The render path is covered instead by ten component tests
(`app/__tests__/positionScreen.test.tsx`), which is where this screen's bugs
would live.

**And the reviewers found two the tests could not.** Both were the direct cost
of not having run it:

*The cross-link was wrong-but-plausible, which is worse than empty.* The
invariant note above worried about a family typo producing a silently EMPTY
list. What actually shipped was the opposite failure: `family` is coarse, so
Closed Guard and Open Guard resolve to the same 187 techniques — and the Open
Guard screen listed entries named "Closed-Guard …" directly beneath its own
sentence saying the ankles are *not* locked. An empty list looks broken and
gets reported; an authoritative-looking wrong one does not, least of all by the
beginner this feature exists for. The section header now names the scope
("TECHNIQUES FROM THE GUARD FAMILY") instead of claiming "FROM HERE", and both
guard entries disclose the limitation in prose — the mitigation Knee on Belly
already had and they didn't.

**And the first attempt at that disclosure was itself false, which is the
lesson worth keeping.** It told the reader the library "records only which side
of the guard a technique happens on, not whether the guard is closed or open,"
and offered a rule for spotting the strays: anything whose name begins
"Closed-Guard". Both claims are wrong. `position_detail` *does* carry the
distinction — 35 Closed Guard, 37 Open Guard — and the name rule catches 6 of
those 35, implicitly endorsing the other 29 as open guard. Replacing a vague
wrong claim with a specific checkable one aimed at the reader least able to
check it is a worse outcome than doing nothing, and it took a second review
pass to catch. The prose now says only what is true: the list is the whole
guard family, closed and open together, and should be read as "guard".

**The real fix landed in the end, and it was smaller than the deferral
implied.** `Position` gained `detail_includes`/`detail_excludes`, which narrow
the family match using `techniques.position_detail`. Two columns rather than
one because the two entries need opposite operations: closed guard whitelists
a short enumerable set (`Closed Guard`, `Rubber Guard` — 37 techniques), while
open guard is "the rest of the family" across 26 detail values that grow with
the library, so it blacklists the same two (150). Every other position leaves
both empty and takes its whole family. With the split real, the disclaimer
prose came back out — the honest thing to say became nothing at all — and the
section label stopped qualifying the two guards, since their lists are now
genuinely their own. Knee on Belly is the only entry still labelled "FROM THE
SIDE CONTROL FAMILY", which is correct: it has no techniques of its own.

*A 187-row list was mounted eagerly.* `technique/[id]`'s `ScrollView` was
copied wholesale, which is safe there because its edge lists are 6-29 items.
Here it meant ~900 native views on the two entries a beginner opens first —
and `library.tsx` already carries the comment explaining why that stalls a
phone. Now a `FlatList` with the prose as `ListHeaderComponent`. Purely a
runtime defect: it typechecks, it tests green, and only a device shows it.

*And the fix for it introduced a third.* Adding a 10-second request deadline —
copied from `library.tsx`, whose comment explains that iOS otherwise takes ~60
seconds to give up — reproduced a spinner that never resolves. Both an unmount
and a timeout abort the same controller, and they need opposite handling: one
must set no state, the other must set an error. `library.tsx` passes a *reason*
to `abort()` and discriminates on it; only the timer was copied, not the
reason, so an unconditional `signal.aborted` guard returned before clearing
`loading`. That is strictly worse than having no deadline: the screen used to
recover with an error at ~60s and now never recovered, from a branch with no
retry control on it. Both directions are now tested, and the test was checked
by restoring the bug.

Smaller review outcomes worth keeping: the position tile code is keyed on the
position id rather than its family, because keying on family printed `GRD`
twice and `SDE` twice — and with every glossary tile deliberately achromatic,
the three letters are the *only* differentiator, so an ambiguous code breaks
`LibraryTile`'s stated rule from the other side. Two factual errors in the seed
prose were corrected (side control does not score three points — the *pass*
does; and mount's four points are tied with back control, not "the most").
`UpsertPositions` now deletes rows no longer in the seed: stable ids mean
editing prose can't strand anything, but *renaming* an id would have shown the
athlete two entries for one position. And the DB-gated cross-link test was
rewritten to run offline against the two embedded JSON files — it was both
circular (asserting the same map the validator enforces) and skipped on every
local run, so the strongest guard on the load-bearing invariant only ever
executed in CI.

---

## 2026-08-02 — Logging classes, drilling and rolling

The first real BJJ logging increment, and the one
[bjj-tracking-design.md](bjj-tracking-design.md) was written to specify. It
implements §1's two-layer split and §3's capture order more or less
literally; the parts of that document it does **not** implement are listed at
the end rather than quietly skipped.

### The inversion, and why Today's BJJ button changed

Strength starts a session and logs into it while you train. On the mat that
is impossible — sweaty hands, a mouthguard, six-minute rounds, gis without
pockets — so BJJ inverts it: **zero interaction during the session,
everything recalled straight after.**

Today's BJJ button therefore no longer goes to `/session/start`. It went
there because every sport did, and the destination was a live set logger
that a BJJ session **cannot legally hold a single row in**:
`session_sets.exercise_id` is NOT NULL and references `exercises`, the
repository asserts each set's `exercises.sport` matches, and migration
000019 removed the last BJJ exercises. So the old path offered an empty
form that could never be filled — not a missing feature, an unreachable one.

The button is keyed on `capabilities.catalog === 'techniques'` rather than
on `key === 'bjj'`, so a future technique-shaped discipline gets the right
flow without Today learning its name.

### Two layers, and the floor is the product

`system-design.md §4` sets a hard budget: a BJJ session logged in ≤3 taps.
The floor screen honours it by pre-filling everything from the last session
of that kind, so the three taps that remain are **pick the kind, pick how
hard, log it**. Mat time, rounds, round length and gi all arrive already
answered.

That screen is a complete valid session on its own, and the copy says so.
The reflection wizard is a separate, optional continuation. This split is
the whole design rather than a nicety: a two-minute mandatory wizard kills
the habit, and consistency data has to survive the lazy day.

**`ended_at` is written at log time, from the duration.** Easy to miss and
load-bearing: training history derives every duration from
`ended_at - started_at`, so a BJJ session without one contributes nothing to
mat time — and because the history chart falls back to *time* when there is
no tonnage, a BJJ-only athlete would have got a flat zero line rather than
their actual training.

### The schema is graph-ready now because it cannot be later

`bjj_session_details` is a 1:1 companion to `sessions`, not columns on it —
the same reasoning that kept a belt off `profiles`. The session row itself
stays exactly where every other sport's lives, which is what keeps BJJ
visible to history, the consistency grid and the cross-sport load currency.

`bjj_session_tags` is the part worth arguing about, and §4 of the design doc
insisted it land in the **first** migration: every tag carries **position
context and an outcome direction**, because both are nearly free to record
today and expensive to retrofit onto months of history that lacks them.

The vocabulary is one enum: `drilled → attempted → scored` is the technique
funnel, and `conceded` is the symmetric half. That fourth value is the one
that earns the table. "Where do I keep getting stuck" is the question every
serious grappler is trying to answer and almost nobody has data on, and a
schema recording only what worked could never answer it. It is why the live
grid has a **Them** column at all.

Tags carry a `count` rather than one row per repetition — reflection is
recalled in counts ("got swept about three times"), and a row per rep would
make editing a chip mean reconciling N rows.

### No cross-module writes, and authorization for free

The BJJ session is created through the ordinary `POST /v1/sessions`; the
reflection goes to `PUT /v1/bjj/sessions/{id}`. That mirrors
`PUT /v1/sessions/{id}/sets` exactly, and it means the bjj module writes only
its own tables — no module reaching into another's.

Both BJJ tables reference `sessions (id, user_id)` as a **composite** pair,
the pattern `session_sets` already uses. The effect is that authorization is
the foreign key: there is no ownership SELECT anywhere in `PutDetail`,
because a write naming a session that does not exist *or* belongs to
somebody else fails in the database. Both map to 404, indistinguishably, for
the same non-disclosure reason the admin module was fixed for. The
cross-user test goes red when only that mapping is removed, so the guard is
genuinely load-bearing rather than decorative.

### It works with no signal, because that is when it is used

Reflection happens within ~20 minutes of stepping off the mat, which is
reliably a car park. So the reflection is not pushed directly: schema v12
adds `bjj_json` to `local_sessions`, written locally first and carried by
the **existing** outbox — same tombstones, same compare-and-swap, same
blocked-row repair screen, no second sync path to keep honest. In `pushRow`
it sits exactly where the sets push sits, for exactly the same reason: it
references a session that has to exist server-side first.

Nullable rather than defaulted to `{}`, because "not a BJJ session" and "a
BJJ session with an empty reflection" are different facts and only the first
should skip the detail call.

`startLocalSession` also gained optional `started_at`/`ended_at`. Retroactive
logging is first-class per §4 of system-design — most BJJ sessions get
written down that evening — and a function that always assumes "now" makes
every one of them wrong.

### What this increment deliberately does not do

All of these are in the design doc and none are in this PR:

- **Voice notes** (§3.6). Needs a native module, and the doc already flags it
  as landing on the same pile as HealthKit and widgets.
- **Focus mode** (§5), insights, the funnel and heatmap views, gap detection,
  curricula. Every one of them is a pure read over the tags this now
  accumulates, which was the point of settling the schema first.
- **The post-class notification** that opens the wizard (§1). Needs
  scheduling infrastructure that does not exist yet.
- **Per-round detail and partner belt/size** — open questions 1 and 2, both
  suggested as "aggregate for MVP" and left that way.
- **Perceived performance** (§3.3). Dropped from the effort step on purpose:
  it is the weakest signal in the flow and §2's own stance is evidence over
  self-assessment. RPE and the body note are kept.
- **Web review of a BJJ session.** Correcting a session at a desk is
  legitimate under the platform rule, and reading a reflection back on web
  is the natural next increment.

### A local-environment note, not a code one

`docs/decisions` and the shared dev Postgres disagreed for a while: an
uncommitted `000024_positions` in the primary checkout had already been
applied to the shared database, so golang-migrate refused to run anything
numbered 24 from this branch and then refused to run *at all* (it wants a
down file for the version the DB is on). This branch's migration is
therefore **000025**, leaving 24 to the positions work in progress, and
verification ran against its own `vola_bjjsess` databases rather than
disturbing that state. Worth knowing before assuming a migration failure is
a migration bug.

That renumbering then turned out to have a consequence past this checkout,
which review caught: **`feat/bjj-position-glossary` (000024) is not on main,
and main stops at 23.** golang-migrate tracks one integer, and `migrate up`
only runs versions *above* it — so if 25 lands first the version becomes 25
and 24 is skipped **permanently and silently**, on every database that took
25 first, staging included. No error is ever produced; the glossary tables
just never exist. The constraint is only the counter — nothing here depends
on 24 — so either branch may land first as long as the one that lands
second holds the higher number. Flagged in a banner at the top of the
migration itself, because the failure mode leaves no trace anywhere else.

**Resolved, and the paragraph above got one thing wrong.** 25 landed
first (PR #88), and the glossary branch was renumbered on top of it:
`000024_positions` → **000026**, and a second migration that branch had
gained since, `000025_position_detail_scope` → **000027**. Both then
merged as PR #89. `main` now runs 23 → 25 → 26 → 27; the gap at 24 is
harmless, because `migrate up` runs every version above the current one
and does not care about gaps.

The correction: by the time this was resolved the glossary branch carried
its *own* `000025`, so the real collision was a **duplicate version, not a
skipped one** — and that does not fail silently. Verified directly against
`golang-migrate`'s file source rather than assumed: it returns `duplicate
migration file` and refuses to open the migrations directory at all, so
every `migrate` command fails loudly, including on a deploy. The silent
skip described above was the correct analysis of the branch as it stood
when the banner was written; it stopped being the whole story when that
branch grew a second migration. Both hazards are worth knowing, and they
have opposite signatures — a skip is invisible, a duplicate is total.

Verified end to end rather than by inspection: the post-merge migration
set applied to a throwaway database reaches version 27 clean, with each
migration's actual effect present (`bjj_promotions`, `bjj_session_details`
/`bjj_session_tags`, `positions`, and 27's `detail_includes`/
`detail_excludes` columns — that last one being precisely what a silent
skip would have omitted). A full `migrate down` then leaves zero tables
behind, so the down files are genuine inverses.

The durable lesson is about *when* the check is worth running, not about
these two branches: two unmerged branches each adding a migration is a
collision that neither branch's CI can see, because each is green in
isolation. Nothing in the tooling catches it, and the number is chosen at
the moment the file is created — long before the conflict exists.

### What review changed, and one thing this log got wrong

Three findings were worth the round:

- **The upsert's `WHERE bjj_session_details.user_id` is the authorization
  boundary on the update path, not the decoration this code's own comment
  claimed.** The composite owner FK does reject a foreign session on
  INSERT — but Postgres **skips the referential-integrity check entirely on
  `ON CONFLICT DO UPDATE` when no referencing column changes**, and the
  upsert rewrites only payload columns by design. So once a detail row
  exists the FK stops running and that predicate is all that stands between
  two athletes. The original comment described it as "belt and braces, and
  unreachable today", which is an invitation to delete it. Removing it
  reproduces a clean cross-user overwrite. It now carries the real
  explanation and a test
  (`TestExistingDetailCannotBeOverwrittenByAnotherUser`) that writes the
  owner's row *first* — the case the existing tests missed, because they
  all exercised the INSERT path where the FK does the work. That test sends
  **no tags** deliberately: the tag table's own FK would refuse first and
  mask whether the detail upsert was guarded at all.
- **Nothing checked `sport`.** A BJJ reflection attached happily to a
  strength session — the owner FK only knows `(id, user_id)`. Now an
  explicit ownership-and-sport `SELECT` opens the transaction, mirroring
  `assertSportsMatch` in the session module. Both answer `ErrNotFound`
  rather than distinguishing "not yours" from "not BJJ", same
  non-disclosure rule as everywhere else.
- **The optional reflection could cost the mandatory session its
  duration.** The push ran the reflection PUT *before* the finish call, so
  a permanently-refused tag — one naming a retired technique — threw before
  `ended_at` was ever sent. History derives every duration from
  `ended_at - started_at`, so that session would have counted for nothing,
  permanently, with the athlete seeing a generic sync error. Fixed twice
  over: `ended_at` now rides along on the create (the API already accepted
  it), and the finish is ordered ahead of the reflection. `bjjPush.test.ts`
  pins both, and all three assertions go red when the order is put back.

The pattern in the first two is the same one this project keeps
re-learning: a foreign key that *looks* like it enforces something often
enforces it on one path only, and a comment asserting "unreachable" ages
into a licence to remove the thing holding the line. The check suite was
green throughout.

A second review pass over the fixes then caught two things worth recording,
because both are the *fix* being subtly wrong rather than the original code:

- **The test written to pin the `WHERE` predicate did not pin it.** Adding
  the explicit ownership SELECT made the two guards independent, so the
  SELECT answers first and the whole suite stays green with the `WHERE`
  deleted — while the comment above it claimed a named test would fail.
  The line was documented as load-bearing and was, in practice, untested.
  Fixed by testing it where it actually lives:
  `TestUpsertPredicateRefusesACrossUserUpdateAtTheSQLLevel` issues the
  upsert directly against Postgres as an attacker and asserts zero rows
  affected. Deliberately not routed through `PutDetail`, because nothing
  routed through `PutDetail` can reach the predicate any more.
- **The counter-scoping fix reintroduced its own bug one chip along.** The
  live grid's counters were scoped to the selected position so display and
  controls agree, with a line explaining what is recorded elsewhere — but
  that line was gated on a *named* position being selected. The first chip
  said "Anywhere", which reads as "all" and is actually the *unspecified*
  bucket, so returning to it hid every position-tagged entry with no
  explanation: the same "did I lose that?" moment the fix existed to
  remove. The chip is now "Not saying" (matching the gi tri-state) and the
  line shows for both cases.

Both are the same failure mode as the original: a guard or an affordance
that is *nearly* right, described by a comment that is confidently wrong.
The reviewers were given the design intent, which is why they found the
gap between what the code claimed and what it did rather than only what it
did.
## 2026-08-03 — Positions are nouns, techniques are verbs

A taxonomy for the library, and the first half of implementing it. The idea
is one sentence: **every technique is a verb applied at a noun.** A double
leg and a berimbolo are not different in kind — one is *advance* at
standing, the other is *advance* from De La Riva with an inversion. Once
that is in the data, "complex" decomposes and the library becomes
queryable in the way a deterministic rule engine will need.

### What was already true, and what wasn't

The nouns existed: `techniques.position` plus the ten-entry glossary from
the position PR. What did not exist was a verb axis — and the reason is
that `category` **already contains one, fused to a noun.** "Takedown"
means advance-at-standing. "Pass" means advance-at-guard-top. "Sweep"
means reverse-at-guard-bottom. The where half is recorded twice.

Two columns holding the same fact can disagree, so the first thing checked
was whether they already had. They had not: zero takedowns filed off
standing, zero sweeps from a top position, zero passes from the bottom,
across all 466 entries. That is what made this cheap — the verb could be
*derived* rather than curated, and the check would have been much more
expensive to run later.

The cost of the fusion is that the library cannot answer its own central
question. "Every way to advance from here" spans three categories;
"every way to escape" spans two. After the change, each is one value —
and the split really is cross-cutting: advancing from standing spans
`Takedown, Transition`, from guard-top spans `Pass, Transition`.

### The five verbs

`advance` (takedowns, passes, back takes) · `reverse` (sweeps) · `escape`
(pin escapes, submission defence, guard retention) · `control` (pins,
rides, grip and frame systems) · `finish` (submissions).

Eight of the nine categories map onto one verb each. `Transition` (76
entries) was the only genuine work: it is not one verb. "X-Guard Back
Take" is advance, "Butterfly Technical Stand-Up" is escape, "Side Control
to North–South" is control. Classified by an explicit rule table rather
than by feel, so the reasoning is reviewable and re-runnable.

**`category` was kept, not replaced.** It is not wrong, it is colloquial —
"Sweep" is the word a coach says out loud, and "reverse-at-guard-bottom"
is not. It stays the display label; `function` is the queryable axis
underneath. Replacing it would also have silently rewritten the belt
filter and every client that groups by it, for nothing.

### Four entries that have no verb, and were left that way

Side Breakfall, Backward Breakfall, Forward Shoulder Roll, and Grappling
Stance and Motion. These are movement fundamentals — library content, not
techniques. They have no noun and no verb, and forcing them into one of
the five would make the taxonomy assert something false. `function` is
nullable for exactly this, and the test pins the count at four so a
*fifth* unclassified entry fails loudly rather than joining a quiet second
population.

### Leg entanglements became their own noun

The sharper of the two fixes. Modern grappling treats the ashi garami
family as its own positional subsystem — guards for the legs — and the
schema disagreed: all 26 entries were filed as `Guard - Bottom`, so a heel
hook from the saddle resolved to the same position as a spider-guard
sweep, and appeared on the Open Guard screen. `position_detail` had
carried the distinction all along; the coarse axis the glossary and the
tag stream both use could not express it.

They are now `position = "Leg Entanglement"` with a glossary entry and a
new family. The interesting part is what was deliberately *not* swept in:
**"Judo Ashi-waza" is foot sweeps, not ashi garami** — same word, unrelated
technique — and "Single-Leg Defense"/"Single-Leg Finish" are takedown
work. All three read as leg-adjacent; matching is exact for that reason,
and a test asserts each stays out by name.

This moved a pinned count that a previous PR deliberately hardcoded: open
guard was 150 techniques and is now 124, because the 26 left the family.
That test failing was the system working — the count is pinned precisely
so a change like this cannot pass unnoticed.

### The file that looked dead and wasn't

`techniques.additions.json` was deleted on the reasoning that its 16 records
are byte-identical to their counterparts in `techniques.json` and no Go file
embeds it. Both halves are true. The conclusion was wrong: **the importer
reads it.** `scripts/import-exercise-catalog.py` merges it into every
regenerated library, precisely so re-importing the sheet — a full
replacement, not a patch — cannot silently drop the hand-authored
bottom-position gap-fill that exists nowhere else. Deleting it turned that
merge into a silent no-op, and a scenario in `functional-scenarios.md`
("re-importing must not delete the 16 techniques") into something
unsatisfiable. Restored.

The wider version of that mistake was worse and is the reason this section
exists. `seed.go` says `techniques.json` is *"generated from the authored
spreadsheet — the spreadsheet is the authoring surface, this is the build
artifact."* Hand-editing 462 `function` values and 26 positions into the
artifact made that false without changing the sentence that asserts it: the
next re-import would have reverted the entire taxonomy, quietly, and the
comment would still have claimed everything was fine.

So the rules moved into the pipeline rather than the sentence being softened.
`import-exercise-catalog.py` now derives `function` from category and name
(the same table used for the one-time pass, `Transition` and all) and applies
the leg-entanglement position rule, with the same exact-match discipline —
`ENTANGLEMENT_DETAILS` is a set, not a substring test, for the Judo Ashi-waza
reason. Verified the only way worth verifying: running the derivation over
the pre-taxonomy data reproduces the committed `techniques.json` **byte for
byte across all 466 records**. The artifact is reproducible again, so the
comment is true again, and the classification logic lives in the repo instead
of a scratch script.

### Review caught the change hiding 26 techniques

The taxonomy work was right and the client work was not. Moving the
entanglements out of the Guard family moved them out from under the **Guard
filter chip** on both clients, and neither had a chip for their new home —
so 26 techniques became reachable by typing and nothing else. Mobile's chip
coverage went 465/466 → 439/466, web's 458/466 → 432/466, and web is worse
because it has no position glossary at all, so there was no second route to
them. Both clients would have rendered a glossary card advertising a
position their own filter could not produce.

The deeper finding is why that happened. The position vocabulary is copied
into **four** client files and one backend map, enforced in none of them,
and this PR updated one of the four. It had already drifted once the same
way — North-South was added to the glossary and left off the chips — and
that was also caught by a human reading a diff, which is not a mechanism.

So there is now a mechanism: `positionVocabulary.test.ts` reads
`positions.json` and all three hardcoded client arrays off disk and asserts
they agree in both directions — no family the clients miss, no chip keyed on
a family that does not exist (which filters to an empty list and reads as
"nothing here" rather than as a bug). Deleting the leg-entanglement entry
from the web file reproduces the exact defect review found. It lives in the
mobile jest suite because that is the only one in the repo; a test in a
slightly wrong app is a smaller problem than a filter that silently hides a
quarter of the leg-lock library.

Fixing this properly means one shared constant per app, or keying the chips
on the glossary ids outright. Both are design work rather than a patch, so
the test is the floor: hand-maintenance continues, but drift now fails in CI
instead of in a gym.

### Two guards that were right, and held there by nothing

Review confirmed the three properties this change depends on are correct as
written — and that two of them stayed correct only by luck, because no test
would have noticed them breaking.

The sharper one is the seed's `IS DISTINCT FROM` tuple, which decides whether
a row updates at all. `function` was in it correctly. But removing it left
the entire suite green while writing **zero** functions on the upgrade path —
rows that already exist with the column NULL, which is exactly what deploying
this migration produces. That is the `completed`-flag failure the project has
already shipped once: a SET clause that looks right, a seed that logs "466
upserted", and a value that never lands. `TestReseedPopulatesFunctionOnRows­
ThatPredateTheColumn` now simulates that path and fails with the diagnostic
rather than silently.

The other: `validFunctions` is the only thing between a typo and a value no
client can render, since there is deliberately no CHECK — and replacing the
guard with `case false:` also left the suite green. `TestValidate_Rejects­
BadContent` gained the case it was built for.

Also dropped the `(position, function)` index this branch added. Measured on
the seeded table it is never chosen, because no query supplies both: the
axis is resolved client-side against the summary payload by design, and
there is no `?function=` filter. Migration 000018 dropped an index from this
same table for exactly that reason — "it reads as reassurance that search is
indexed when it isn't" — and adding one back with no caller would have been
the same mistake with a different name.

### What this does not do

**Nothing reads `function` yet.** No client filters on it, and the session
tag stream still uses its own six-value vocabulary (`submission`, `sweep`,
`pass`, `escape`, `takedown`, `control`) which fuses verb and noun exactly
as `category` did. Aligning it is the natural next step and was kept
separate on purpose: it changes a wire contract the installed phone build
depends on, and this PR does not.

The third axis of the taxonomy — the *mechanic* (inversion, back-step, leg
drag) — is deliberately absent. It has no consumer, and unlike the other
two, nothing currently depends on getting it right.
## 2026-08-03 — The BJJ log could be written and never read

User feedback, and the sharpest kind: *"the bjj class gets logged with the
details or wout and then I see nothing in the Class. Cant edit title, cant
see any logs i have entered — doesnt seem complete."*

All of it was true, and worse than "unfinished". The reflection was
**write-only**. `readLocalBjjDetail` had exactly one caller — the wizard that
writes it. Today's list sent every session to `/session/[id]`, which has zero
BJJ awareness, so a class opened onto the strength record: "Sets 0 · Reps 0 ·
Volume —" over an empty group list. And the wizard was reached by `replace`
from the log screen and linked from nowhere else, so it was a one-way door:
a session logged with "Log it" could never gain detail, and a mis-tapped
counter could never be corrected.

The previous two entries both noted "nothing reads the tags back yet" and
treated it as acceptable sequencing. Putting it on a real phone proved that
wrong. A capture surface with no read surface does not read as *incomplete*,
it reads as *broken* — and it removes the reason to fill the thing in.

### What landed

`app/bjj/session/[id].tsx`, routed to by sport from Today via the **same**
`logsAfterwards` predicate the log button uses — so the two cannot disagree
about what a BJJ session is. It shows what a mat session has: time, rolling
minutes, RPE with its word, what was drilled, and the scored/conceded grid.
Deliberately no volume tile; that is the column BJJ can never fill, and
showing it was the original bug.

Reload happens on **focus**, not mount: the wizard is reachable from here, and
returning from an edit to unchanged numbers would read as the edit being
lost — the exact doubt the screen exists to remove.

### Renaming needed a backend endpoint, which is why it nearly shipped broken

The name defaults to the kind ("Class"), which is wrong the moment it was a
seminar or an open mat. The UI was easy. Then: `POST /v1/sessions` is
`ON CONFLICT (id) DO NOTHING`, and `pushRow` sent sets, finish and the BJJ
detail — **no name**. So renaming a synced session would mark the row dirty,
sync would mark it clean, and the change would never leave the device. The
same silent-drop shape as the `completed` flag and the `IS DISTINCT FROM`
tuple, found for the third time in two days by asking "does this actually
reach the server?" rather than "does the button work?".

So `PATCH /v1/sessions/{sessionID}` exists now — deliberately rename-only
rather than a general update, because `sport` decides which screen renders
the session, the timestamps are what history counts, and sets have their own
replace endpoint. A general PATCH would make all of those editable by
accident. Ownership goes through the same `requireOwner` as `Finish`; ids are
client-generated and therefore guessable, which is the IDOR this module has
closed once already.

Verified end to end rather than by unit test alone: renamed on the Simulator,
watched the PATCH land, and read the new name back out of Postgres.

### Still open

Web has no BJJ session view — this is mobile only. Reading history back on a
desk is squarely web's half under the platform rule, and it is the natural
companion, but a working phone screen beat half of both.
## 2026-08-03 — Where a technique leaves you

`to_position`, closing the last axis of the taxonomy. `position` says where a
technique starts, `function` says what it does, and until now nothing said
where it ends — so the library could answer "what can I do from here" and
"what follows this" but not "where does this put me", which is the question a
gameplan or a curriculum is made of.

### It was measured twice before a line was written, and both said "author it"

1. **Name parsing** ("X to Y", back takes, guard pulls) reaches 42% — and 97
   of those are submissions, whose destination is the end of the exchange
   rather than a position.
2. **Inverting `setup_from`** looked like the clever answer and was not. Of
   the 159 techniques with followers, **137 have followers in the same
   position**: that edge links control-to-attack *within* a position, not
   transitions between them. It infers a real position change for 22 of 466.

So this was authoring work. Synthesising the other ~270 would have produced
plausible-looking data that a rule engine cannot distinguish from the truth —
the same failure this project keeps circling, and the reason the column is
deliberately sparse instead of complete.

**149 of 466 populated**, scoped to advance/reverse — the transitions a
gameplan is made of. The destinations were authored by the user; every id and
every destination was validated against the library before being written,
because the failure mode is silent: `Side Control` instead of
`Side Control - Top` produces an edge that resolves to nothing on every
traversal with nothing reporting a fault. Seed validation catches exactly
that, by name, and resolves against the library's own position vocabulary
rather than a second hardcoded list — that set already grew by one when leg
entanglement was promoted.

### What it buys, immediately

```
from                  to                          ways
Guard - Top        -> Side Control - Top            31
Standing           -> Guard - Top                   29
Guard - Bottom     -> Guard - Top                   16
Guard - Bottom     -> Mount - Top                   13
Half Guard - Top   -> Side Control - Top            10
Guard - Bottom     -> Standing                      10
```

The passing game, the takedown game, and the sweep game splitting between
coming up in their guard and going straight to mount.

### NULL means "not recorded", never "goes nowhere"

The distinction is load-bearing, and the 7 **self-loops** are what make it
work: a guard *break* leaves you in guard-top having not yet passed, a
single-leg entry leaves you standing having not yet finished. Recording
"stays put" as a fact rather than an absence is what lets a missing value
mean one unambiguous thing. A client must not infer a self-loop from a
missing key.

### Lessons half-applied, and the half that was missed

The fixes `function` learned under review were applied up front. **The tests
that hold them were not** — which is the same gap the immediately preceding
commit had just closed for `function`, reproduced one column over, and
review caught it: `to_position` is in the `IS DISTINCT FROM` tuple (a field
missing from it updates nothing and no delta-syncing client ever learns —
the `completed`-flag shape, found twice already); validated in Go with no
CHECK per 000021; **no index** per 000018, because nothing filters on it yet
and an unused index reads as reassurance; on the summary payload *and* its
OpenAPI schema; normalised at the client parse boundary; and carried forward
by the importer, because the spreadsheet does not have this column and a
re-import would otherwise silently blank every authored destination.

What was missed, and is now fixed: all three of those guards were written
correctly and held there by **nothing**. Deleting `to_position` from the
tuple left the entire suite green while writing zero destinations on the
upgrade path; replacing the validator with `case false:` did the same; and
the new test's headline assertion was unreachable, because `SeedData()` had
already validated the slice the assertion's own map was built from. There is
a reseed test and a validator case now, both mutation-checked.

Two more the same review found. `knownPositions` was package-level and only
ever grew, which made `validate()` **order-dependent** — a bad destination
was rejected in a clean process and accepted after any earlier `SeedData()`,
so a validator test would pass alone and go silently weaker in the suite —
and it was a concurrent map write under `-race`. It is a local now. And
`carry_to_position` preserved the values but appended the key, so all 149
records differed in key order and the artifact stopped being byte-
reproducible **one commit after that property was established**. It rebuilds
the dict now, and fails the import outright if a renamed id would drop a
destination that exists nowhere else.

The pattern worth naming: applying a fix is not applying the lesson. The
lesson was "a guard nothing exercises is a guard that gets deleted", and it
had to be learned twice.

### Open

`situp-guard-arm-drag` was given conditionally ("Back - Top if taught as a
completed arm-drag to the back, otherwise SAME") and recorded as the
completed reading. The remaining 317 are unrecorded by choice, not oversight;
the pinned count means coverage can only rise.

Nothing reads `to_position` yet — no screen, no suggestion. That is the same
foundation-before-feature order as `function`, which took a round of user
feedback to justify. The difference is that `function` now has two surfaces
reading it, so the pattern has at least been shown to close.
## 2026-08-03 — Response compression

`apihttp.Compress`, wired into the API's middleware chain. The technique
library's list endpoint is ~175 KB of JSON and **~17 KB gzipped** — a 10x
saving on the single largest thing this API serves, paid on every cold app
open.

It came out of a post-merge audit that was arguing about whether one field's
+20 KB was affordable. It was the right question and the wrong altitude: with
compression that field costs ~3 KB, and the same middleware applies to every
endpoint rather than one column. Worth remembering the next time a payload
debate starts — check whether the transport is doing its job first.

### Why it is not four lines

**The size threshold has to be deferred.** Most responses here are tiny — an
error body is ~60 bytes and gzip's header alone is 18, so compressing those
makes them *bigger* and burns CPU. But the size is not knowable up front:
handlers stream through `WriteJSON` and almost never set `Content-Length`.

So the writer buffers, and only commits to gzip once the response is provably
past 1 KB. Anything that finishes under it is written through verbatim — no
`Content-Encoding`, no gzip framing. That deferral is the entire reason there
is a state machine rather than a wrapper.

Three things it gets right that are silent when wrong:

- **`Content-Length` is deleted** when compression starts. It describes the
  uncompressed body, and a response whose declared length disagrees with its
  bytes makes clients truncate or hang rather than error.
- **`Vary: Accept-Encoding` is set on every response**, compressed or not,
  or a cache keying on the URL alone hands a gzipped body to a client that
  cannot read it. It is `Add`, not `Set` — and `withCORS` was changed to
  `Add` its `Vary: Origin` for the same reason. `Vary` is a list; `Set`
  silently drops whichever middleware ran first.
- **`Accept-Encoding` is parsed, not substring-matched.** "notgzip" contains
  "gzip", and `gzip;q=0` means the client explicitly refuses it.

Ten tests, all on the edges rather than the happy path: small bodies left
alone, no double-encoding when a handler set its own `Content-Encoding`,
status preserved, empty responses (204 and bare `WriteHeader`) neither
hanging nor gaining framing.

### Verified live, and one gap

Wired into the real chain and confirmed end to end: a small 401 passes
through uncompressed with `Vary` set, and `httplog` still records the correct
status despite the header write being deferred past `ServeHTTP` — which was
the interaction most likely to break quietly.

**Not verified live: a large compressed response.** Every endpoint big enough
to cross the threshold is behind `RequireAuth`, and no Clerk token was
available. The 100 KB round trip is unit-tested, so this is inference from a
test rather than an observation of the deployed path.

### Not done

No `ETag`/conditional GET. Reference content changes only on deploy and every
row carries `updated_at`, so `max(updated_at)` is a ready-made validator —
the natural next step, and a bigger saving still for repeat opens.
## 2026-08-03 — Conditional GET

`apihttp.ConditionalGet`, the other half of the compression saving and the
larger one for the case that actually recurs. This takes the *repeat* fetch to
a ~150-byte header exchange.

Most of what this API serves on a cold open is reference content that changes
only on deploy. Measured against the seeded database rather than estimated —
the compression entry above had been quoting a guess, and it was wrong about
which endpoint is biggest:

| endpoint | rows | raw | gzip |
| --- | --- | --- | --- |
| `GET /v1/exercises` | 504 | 211.7 KB | 12.6 KB |
| `GET /v1/techniques` | 466 | 164.2 KB | 17.4 KB |
| `GET /v1/techniques/positions` | 11 | 16.6 KB | 5.7 KB |
| `GET /v1/techniques/rulesets` | 25 | 15.8 KB | 1.9 KB |

The **exercise catalog**, not the technique library, is the largest thing this
API serves. Worth knowing before optimising the wrong endpoint — and a
reminder that "~175 KB" survived two PRs' worth of doc comments without anyone
measuring it.

### Why a body hash and not `max(updated_at)`

The cheaper design computes a validator from the data *before* running the
query and skips the query too. It was rejected for two reasons. It needs a
per-module `LastModified` on every repository that wants it, and
`updated_at` does not cover the parts of a response that are not rows — the
derived volume summary, the embedded ruleset object, a filter applied in SQL.
A hash of the bytes about to be sent cannot disagree with what it describes.

The cost is honest and worth stating: **this saves bandwidth, not database
work.** The query still runs and the JSON is still marshalled, because the
hash is of the finished body. Over a phone connection the bytes are the
dominant cost, and they are the half fixable without touching every module.

Per-repository validators remain the next step, and the middleware now leaves
a seam for them rather than foreclosing on it — see below.

### The order is load-bearing, and the test that "pinned" it did not

`ConditionalGet` sits **inside** `Compress`, so it hashes the identity body.
Outside, the ETag would change with `Accept-Encoding` and every gzip-capable
client — which is all of them — would be a permanent cache miss.

A test asserted exactly that: plain and gzipped responses share one ETag, and
a 304 comes back out through the compressor with no body and no gzip framing.
It could only ever pass. It built `Compress(ConditionalGet(handler))` **inside
the test**, so it was asserting against an order it had just constructed
itself — review swapped the real order in `cmd/api/main.go` and the entire
backend suite stayed green.

The fix is structural rather than a better assertion: `apihttp.Stack()` now
owns the composition, `main.go` calls that, and the test exercises `Stack`.
Assembly belongs somewhere a test can reach. **This is the sixth time this
session a test passed for the wrong reason** — the recurring shape is an
assertion that re-derives its own premise instead of reading the shipped one.

### A handler's own ETag is now honoured, not just echoed

The first version left a handler-supplied `ETag` alone — it emitted it and
then ignored `If-None-Match` entirely. That is a validator that looks like it
works: the client dutifully sends it back on every request and always gets the
full payload. And it is precisely where a cheap `max(updated_at)` validator
would have landed, so the intended next step would have arrived and silently
done nothing.

Now the middleware steps aside *and* answers the conditional request against
the handler's validator. It also honours one set **after** the first `Write` —
stdlib freezes headers there, but this middleware defers the header write, so
the tag is still in the map and would otherwise have been silently overwritten
by a body hash. `compress.go` already carried the same fix for
`Content-Encoding`; this is the same bug in a second place.

### Buffering made an unbounded list a memory question

Hashing the body means holding it. Benchmarked at the size of the largest
response above: 461 KB/op through `Compress` alone, 806 KB/op through both —
roughly **+344 KB per in-flight request**.

That is bounded by the largest response the API can produce, which turned an
old latency smell into a real ceiling problem: `activity.ListByUser` had no
`LIMIT` at all and was reachable by both a user and an admin. (Nothing writes
that table today — mobile's `lib/activities.ts` outbox is intact plumbing with
no caller. The bound does not depend on that changing: the rows that exist are
real, and an append-only audit log is the one shape guaranteed to grow the
moment it is re-armed.) Now capped at 500,
newest-first, with a real-database test that fails both when the `LIMIT` is
removed and when the `ORDER BY` is flipped so the cap keeps the *oldest* rows
instead — an audit log quietly answering with its own prehistory is the
failure worth catching, and a regex over the query string would catch neither.

### Browsers needed two CORS headers, natives needed none

`If-None-Match` is not a CORS-safelisted request header, so without it in
`Access-Control-Allow-Headers` the preflight rejects every conditional request
`apps/web` makes. And `ETag` had to join `Access-Control-Expose-Headers` or JS
cannot read the validator it is supposed to send back. Both were missing.

The trap is that neither affects iOS or Android at all — the feature would
have worked in every place it was tested and been dead code in the browser.
Same shape as the `traceparent`/`x-request-id` exposure fix that sits three
lines above it in `withCORS`.

### Scope, and the two things that would be bugs

GET and HEAD only, 200 only.

- **A 304 on a POST** would be a silent data-loss bug: the client believes
  its write was a no-op.
- **A 304 on a 404 or 500** would cache the failure — the client keeps
  treating a stale copy as valid because the server said nothing changed.

Both are tested. Also: `*` matches, a comma list matches, a `W/`-prefixed
echo matches (If-None-Match comparison is explicitly weak), a handler's own
ETag is honoured, and a 304 carries no `Content-Length` — a declared length
with no bytes behind it is what makes a client hang waiting for them.

That last assertion was itself vacuous at first: a `ResponseRecorder` never
synthesises a `Content-Length`, so "it is absent" proved nothing. The handler
in the test now sets one explicitly, and the 200 is asserted to keep both
headers so the test cannot pass by deleting them unconditionally. Every guard
added here was mutation-checked — deleted, confirmed red, restored.

### Two blocking defects a second review round found

**Weak comparison was one-sided.** `matches` stripped `W/` from the client's
candidate but never from the server's tag. Every strong-ETag test passed, and
a handler supplying a *weak* validator never revalidated — the client echoed
it back verbatim, the strings differed by four characters, 200 every time.

That is not a corner: `max(updated_at)` is precisely a validator that must be
weak, because it cannot promise byte-identity (two writes inside one second, a
derived field that moves without it). So the seam this middleware advertises
for per-repository validators was broken for the exact shape it was built for,
and broken in the specific way its own doc comment says the design avoids —
"a validator that looks like it works". RFC 9110 §13.1.2: If-None-Match uses
weak comparison, strip both sides.

**A `LIMIT` without a unique tiebreak.** `ORDER BY occurred_at DESC` alone,
with a ceiling newly on top of it. `occurred_at` is client-supplied (mobile
writes it from local SQLite), so ties are realistic, and Postgres gives no
stable order for equal sort keys. Two consequences: membership of the cap can
change between identical requests (a row the caller can never see), and the
array reorders, so the hash changes and the endpoint becomes a permanent cache
miss — defeating the feature on the very endpoint the cap was added for. This
module already documents the rule on `ListUsers`; the new query was the one
query in `internal/modules` that added a `LIMIT` without honouring it.

Measured rather than argued: on an index of `(user_id, occurred_at DESC)` with
no `id`, a plain `UPDATE` to one row of a tied pair flipped which of the two
survived the cap.

### The test written to prove the fix could not catch the bug in it

The integration test spaced every row an hour apart, so the ordering was total
and the tie case was never exercised. It now creates a real tie straddling the
cut and pins the exact expected order.

And a limit worth stating rather than papering over: **deleting `, id DESC`
still does not turn that test red.** Migration 000030 adds
`(user_id, occurred_at DESC, id DESC)` — every ORDER BY column, same
direction — so an index scan hands back that order whether or not the SQL asks
for it. The tiebreak stays because it is what keeps the order total if the
plan changes to a seq scan or the index is altered; the index stays because it
turns a fetch-everything-then-sort into a scan that stops at 500. Neither is
redundant with the other, and the test comment says so, because a guard that
only looks covered is the failure this project keeps repeating.

### Every list now has a ceiling, because the memory claim depends on it

"Peak memory is bounded by the largest response the API can produce" is only
true if no list is unbounded. `workout.List` still was — and it is the one
list whose size is driven by *total user count* rather than one athlete's
history, since `visibleTo` admits every user's public workouts. Capped at 500.

Its `ORDER BY name, id` was already total, which a third review round showed
is not the same as correct. A cap over a **multi-owner** list evicts across
ownership: once 500 public workouts sorted ahead of it, a user's own workout
named "Z…" silently vanished from the default list. Measured with 501 public
rows. The order is now `(owner_user_id IS NOT DISTINCT FROM $1) DESC, name,
id`, so the eviction lands on other people's content.

`IS NOT DISTINCT FROM` rather than `=`, and the difference is the whole bug in
miniature. `owner_user_id` is nullable — NULL means a VOLA-authored official
template, which the `workouts_official_is_public` CHECK forces public, so they
are always in the default list. `NULL = $1` is NULL, and `ORDER BY … DESC` is
NULLS FIRST, so `=` sorted every official template **above** the caller's own:
the identical eviction, reintroduced by the one row class that outranks them.
No official template exists yet, so nothing was broken in practice — the
comment confidently claiming the opposite was the part that would have cost
someone a day. The fixture now includes a NULL-owner row, because one where
every row has a real owner cannot see any of this.

### Smaller things from the same round

- **`Cache-Control: private, no-cache`** now accompanies the ETag. An ETag
  makes a response revalidatable, which is an invitation to intermediaries
  that did not exist before. RFC 9111 §3.5 already forbids a shared cache from
  storing a response to an `Authorization`-carrying request, so this is
  defence in depth — but "every proxy honours §3.5" is not something to rely
  on silently when the stated default is privacy by default.
- **`Compress` no longer gzips a status that cannot carry a body.** RFC 9111
  §4.3.4 has a cache copy a 304's headers onto the stored 200 it validates, so
  `Content-Encoding: gzip` on an empty 304 gets grafted onto a stored identity
  body and the client gunzips plaintext. Unreachable today; 304s only just
  entered this codebase's vocabulary, and the damage would land in someone
  else's cache.
- **A handler ETag set after its *last* write** was silently overwritten by
  the body hash — a third ordering neither earlier fix covered, and the one a
  natural `WriteJSON`-then-stamp handler produces.
- **`If-None-Match` is now read with `Header.Values`**, joined. `Get` returns
  only the first field line; RFC 9110 §5.3 makes repeated lines equivalent to
  one comma-joined line. Fails safe, which is why it would never be noticed.
- **`Flusher`/`Hijacker`/`ReaderFrom` are deliberately not supported** and now
  say so. Buffering to hash is incompatible with mid-response flushing, and
  exposing them via `Unwrap` would let a handler emit the body twice. A
  streaming endpoint has to be routed around this stack, not accommodated
  inside it.
- **One test now runs through a real `httptest.NewServer`.** Every other test
  drives a `ResponseRecorder`, which does not enforce `bodyAllowedForStatus`,
  does not suppress HEAD bodies, and does not apply the stdlib's own 304
  header suppression — and nothing was testing HEAD at all, the method where
  that divergence is widest.

The review also flagged a contradiction between the new comment ("the offline
mobile outbox appends to this table on every sync") and the contract ("nothing
writes that table now"), and leaned toward the comment. The contract was
right: `apps/mobile/lib/activities.ts` has the `POST` code but no caller, and
says so in its own header. The comment was corrected — the bound does not
depend on the outbox being live.

### A third round, and one rule that disagreed with itself

`Cache-Control: no-store` opts a route out of conditional GET entirely — the
rule `/v1/healthz` relies on, since a constant body means a validator that
never changes and a prober sending `If-None-Match` would be answered `304` for
the life of the deployment while a checker asserting `200` reported an outage
that wasn't happening.

But the check lived only in the post-handler block, which is unreachable once
a handler supplies its own `ETag`. So a route setting both got `304` or `200`
depending purely on **where** it stamped the tag — before `WriteHeader`,
mid-stream, or after the last write. Three orderings that disagree is worse
than any one of the three answers, and `api-conventions.md` stated the rule
categorically while the code honoured it in one case of three. Now checked in
`adoptHandlerETag` as well, with a test that runs all three.

The same round found `Cache-Control` missing from the handler-ETag path
entirely — `adoptHandlerETag` commits the status line, so the post-handler
default could never reach it. That is the branch a per-repository validator
over user-scoped data lands in, so the one branch needing `private` most was
the one not getting it.

And a constraint on that seam worth stating, because the body-hash design is
immune to it: `Vary` is `Accept-Encoding, Origin`, **not** `Authorization`. A
handler-supplied validator that isn't user-scoped — a bare `max(updated_at)`
over a shared table, the obvious first draft — would revalidate user B against
user A's stored body. A hash of the bytes cannot, because the bytes differ.
Nothing enforces this; it is documented where the seam is documented.

### The contract said none of this

`contracts/public.openapi.yaml` had no `304`, no `ETag`, no `If-None-Match`
anywhere — the wire contract described an API that did not behave the way the
API behaves. Fixed across all 29 GET operations via reusable
`components/{headers,parameters,responses}` entries, plus a note in
`info.description` covering both this and compression, since middleware-applied
behaviour is not a per-operation choice even though OpenAPI can only express
it per-operation.

### Verified live

Against the running API, not only in tests. `GET /v1/healthz` initially served
as the probe — it returned `ETag: "_fdCXnLztuTSo0buAHtRdg"` and the whole
revalidation matrix behaved on the wire: the exact tag, a `W/` weakened echo,
`*`, and a comma list all returned `304` with **0 body bytes**, while a wrong
tag returned `200` with 32. `HEAD` carried the same validator. Two separate
`If-None-Match` field lines with the match in the *second* returned `304`,
confirming the `Header.Values` fix rather than assuming it. A `304` requested
with `Accept-Encoding: gzip` came back with no `Content-Encoding`.

That route has since opted out (`no-store`, below), and re-verified as such:
`Cache-Control: no-store`, no `ETag`, and `200` with a body against `*`, the
old tag, and a weakened echo alike.

A trap worth recording, because it produced a confidently wrong reading for
several minutes: killing `go run`'s PID does **not** kill the compiled binary
it spawned. The second verification run silently answered from the *first*
run's still-listening process, which predated the change — so the new
behaviour looked broken while the unit test for it passed. `lsof -i :PORT -P
-n` names the real process; kill that one.

Every endpoint over the gzip threshold is behind auth while `/v1/healthz` is
not, so the large-payload path is verified instead by
`TestTheStackThroughARealServer` — a real `net/http` server over a real
socket, asserting a gzipped ~66 KB body, a matching ETag on `GET` and `HEAD`,
and a `304` that keeps `Vary` while carrying no body, no `Content-Encoding`
and no `Content-Length`. That closes the "never verified on the wire" thread
the compression entry left open.

## 2026-08-03 — The technique funnel had no middle

Asked to track technique proficiency. The schema was built for it —
`bjj_session_tags` records `event` (`drilled → attempted → scored`, plus
`conceded`), `position` and `technique_id`, and migration 000025's own comment
says the deferred features "are all pure reads over" it. The capture side had
quietly stopped holding up its end:

| funnel stage | captured before this |
| --- | --- |
| `drilled` | yes, with `technique_id` |
| `attempted` | **never produced by anything** — a dead enum in `session.go:109` and `bjjSession.ts:45` alike |
| `scored` / `conceded` | category + position only; the live grid filters technique-tagged rows *out* by design |

So a per-technique proficiency view would have read "drilled 12 times" and
nothing else, for every technique. The drop-off the design doc calls the most
actionable number in the sport — "drilled 12 times, attempted 0 is a finding,
not a statistic" — was structurally uncomputable. Confirmed against the
database before writing any code: 4 tag rows, **0 carrying a technique**.

This is the `completed`-flag failure inverted. There the field was written and
never read; here the reader was deferred and the writer quietly stopped
carrying the field. Same outcome — a column that looks populated in the schema
and is empty in practice — and the same reason it survived: nothing fails when
an optional field goes unwritten.

### Where the counters went, and why not in the live grid

On the **drilled step**, under each technique the athlete just named. The live
grid was the obvious home and is the wrong one: it is a category×outcome grid
with no technique in it, so putting the funnel there means a second technique
search during the fastest screen in the flow. On the drilled step the
candidate list is already on screen — the question "did you try any of it
live?" costs one tap per answer.

No new wizard step, so no extra Next tap. The J4 criterion (a full session
logged in under a minute) is the number this design is ruthless about, and a
step boundary is the most expensive thing you can add to a wizard.

Left at zero the counters still say something: "drilled, never tried live" is
the finding, not an empty cell. Nothing here is required.

### Attempted and scored are disjoint, and the labels have to carry it

Per the migration's own wording, `attempted` is "tried it live, it didn't
land" — not "total tries". Went for it four times and hit one is
`attempted: 3, scored: 1`. So attempts + scores is how often you went for it,
and `scored / (attempted + scored)` is the hit rate. The copy says this
explicitly, because the other reading is at least as natural and the two
produce different numbers from the same taps.

### The two surfaces have to partition the tag list

`tagCount` already excluded technique-tagged rows, with a comment noting
nothing could produce one yet "but the API accepts one, so a reflection
authored elsewhere and read back would hit it". That foresight is what made
this change safe on the wizard side — the live grid and the funnel now own
disjoint halves of the tag list, so no event is displayed twice and every
displayed event has a control that can change it.

The **read-back screen had not been given the same treatment**, and this
change would have broken it two ways: its live grid summed technique-tagged
`scored` rows into the category totals, so it would have reported a bigger
number than the wizard for the same session with nothing to explain the gap;
and `attempted` appeared nowhere on it at all. The second one is the funnier
failure — recreating the exact write-but-never-read defect this feature exists
to fix, one screen along. Both fixed here: the grid mirrors `tagCount` for
`scored`, and the Drilled section carries each technique's tried/landed
numbers. Not for `conceded` — see below.

### No backend change

`Tag.Validate()` already accepted `attempted` with a `technique_id`, and the
table already had the columns. The whole PR is `apps/mobile`. Worth recording
because it is what the schema-first decision bought: the expensive half was
done months ago, on purpose, and the feature landed as a pure client change.

### What review caught, and it was the dangerous kind

`removeDrilledTechnique` lost the `event === 'drilled'` guard the inline
filter it replaced had carried, leaving the technique-id match as the only
bound. A nullish id then matches every **untagged** row — and the API sends
`"technique_id": null` on every one of them, because the Go field has no
`omitempty`. So removing a drilled row that had lost its technique deleted the
live grid's entire "You" column. Reachable, not theoretical: migration 000025
sets `technique_id` NULL when a technique is retired from the library, on
purpose, so the athlete's record of having drilled it survives. And
`PUT /bjj/sessions/{id}` replaces the tag set wholesale, so it would have
synced to the server and every other device.

The test named for that exact property could not catch it. Its only untagged
fixture row was `conceded`, which the guard excludes independently of the id
match — replacing the whole function body with `filter(t => t.event ===
'conceded')` kept it green. Every fixture in the file also omitted
`technique_id` entirely (giving `undefined`, the locally-authored shape)
rather than the `null` the API actually sends, which is where the bug lived.

That is three in a row now — the conditional-GET order test, the activity
LIMIT tie test, and this — where the test written to demonstrate a property
was satisfied by something other than that property. The common shape: the
fixture accidentally contains the value the broken code produces.

One thing worth stating rather than papering over: with the nullish-id guard
in place, the explicit `drilled | attempted | scored` allow-list is
**equivalent** to `!== conceded`, since there are only four events. No test
distinguishes them and none pretends to. It is written the long way so a fifth
event cannot silently join the set this function deletes.

Review also caught the read-back screen making a technique-tagged `conceded`
row invisible everywhere — a row the delete path goes out of its way to
preserve — and, because `hasAnyDetail` counted only what was displayed, a
reflection holding nothing else would have rendered "No detail recorded" on
the screen that exists because detail was being recorded and never shown. The
grid now carries those rows: there is no editor for them to disagree with, so
it is the honest place for them.

### What review caught, and one thing my own mutation test did

**The screen opened on yesterday.** `viewDay` was a `Date` captured at mount and
refreshed by nothing, while `now` re-reads on focus and on AppState. Leaving the
app on Today overnight therefore reopened it in *past mode* — yesterday in the
switcher, plans dimmed and marked "Not logged" — with the athlete having
navigated nowhere. It is a day **offset** now, derived from `now`, so every
refresh re-derives it and the class is gone rather than patched at the two
places that happened to refresh.

**A blanket `opacity: 0.55` on the past card** composited every ink inside it:
"Not logged" fell to 1.96:1 and the BJJ eyebrow to 2.51:1 — the latter being the
exact figure the palette cites as its reason for banning `textDim` from a done
row, and failing specifically for this app's headline discipline. The card is
not dimmed at all now; "Not logged" is `warn` at full strength, which is also
what it means.

And one that arrived from my own mutation testing rather than from review: the
first fix for the outside-the-week bug passed *two* plan lists and matched their
union. Three mutations of it stayed green, which is how it came out that the
wider list was **inert** — `matchPlans` groups by day, so plans on other days
can never compete for this day's sessions, and plans on the same day are the
same rows. A parameter that cannot change the answer reads as a safeguard and is
scenery. `owedOn(sessions, dayPlans)` is what was ever needed.

### Gaps this leaves

- **Nothing reads the funnel across sessions yet.** This is the capture half;
  the web proficiency view is the next PR. Until it lands the athlete sees
  per-session numbers only, which is thin justification for the taps.
- **`conceded` still has no technique.** "They armbarred me" stays
  category+position, so the *defensive* funnel does not exist. Deliberate for
  now — the drilled list gives the offensive side a free candidate list and
  the defensive side has no equivalent, so it would cost a search.
- **The counters are only reachable through a drilled chip.** Hitting a
  technique live that you did not drill today has nowhere to go except the
  untagged live grid. Fine while the funnel's purpose is measuring the
  drilled→attempted drop-off specifically; wrong if the goal becomes complete
  per-technique history.
- **The two displays partition the tag list; the evidence stream does not.**
  Tap "Landed 1" on the armbar row and then "Submissions / Hit" once, for one
  armbar, and two `scored` rows exist for a single real event — one
  technique-tagged, one not. Each screen renders them correctly and
  separately, so nothing looks wrong anywhere. The follow-up web view has to
  pick a convention (technique-tagged rows are the specific record, untagged
  the catch-all) rather than sum both, or the same armbar counts twice.
  Recorded here so that lands as a known decision and not as a data bug
  discovered later.
- **A drilled row whose technique was retired gets no counters at all.** It
  renders as a named row with no funnel, because outcomes cannot attach to
  nothing. Correct, but it means retiring a library entry silently ends the
  funnel for anyone mid-way through collecting on it.
- **NOT VERIFIED ON A DEVICE.** `pnpm run verify` is green and the transforms
  are mutation-tested, but nothing has drawn these rows: Expo Go 57.0.6
  segfaults (`EXC_BAD_ACCESS` in `worklets::jsi_utils`) on both an iOS 17.2
  iPhone 15 Pro and an iOS 26.5 iPhone 17 Pro. Confirmed unrelated to this
  change by reproducing the identical crash on the app **root route**, which
  this branch does not touch — so it is an Expo Go/simulator problem, not a
  regression here, but the layout and VoiceOver behaviour are unconfirmed.


## 2026-08-03 — Reading the funnel back

`GET /v1/bjj/proficiency` and `/dashboard/proficiency`. The other half of the
capture PR that landed earlier today: the evidence stream now has a reader.

Web, per the platform rule — this is review and analysis, done sitting down.
The phone captures the evidence mid-reflection and nothing here belongs on it.

### Not a score, and that is the design

`docs/decisions/bjj-tracking-design.md` rules out asking anyone to rate their
triangle 1–5: people are bad at it, it goes stale, and it produces a number
with no provenance. So the endpoint returns facts — drilled twelve times, went
for it three times, landed twice, across five sessions — and the page shows
them. Every judgement it invites is one the reader can see the basis for.

The **drop-off leads**, not the totals. "You have drilled 34 techniques and
taken 6 of them into a live round" is something to act on this week; "210 reps"
is a statistic. The page is ordered funnel-first, list-second for that reason
alone, and the summary counts TECHNIQUES rather than reps.

A hit rate appears only past five live tries. One landed out of one is not a
100% hit rate, and rendering it as one invites a conclusion the data cannot
carry — the same honesty the rest of the screen is built on, applied to the
one number that would otherwise flatter.

### The double-count convention, now enforced

The capture PR recorded a trap rather than fixing it: tapping "Landed" on the
armbar row *and* "Submissions / Hit" in the live grid, for one armbar, writes
two `scored` rows — one technique-tagged, one not. Both screens render them
correctly and separately, so nothing looks wrong anywhere.

This endpoint is where that had to be decided, and the rule is: **a
technique-tagged row is the specific record, an untagged row is the catch-all**,
so per-technique reads take the former and only the former. It is enforced by
one clause (`AND t.technique_id IS NOT NULL`) and pinned by a test that seeds
an untagged `scored: 5` alongside the tagged rows and asserts it is nowhere in
the technique's number. Deleting the clause turns that test red.

### The summary is folded, not queried

`SummariseProficiency` is a pure function over the rows the client is being
shown, not a second aggregate with its own `WHERE`. Two reasons: it cannot
drift from the list underneath it, and it is testable without a database. The
failure it forecloses is specific — once a cap binds, a separate `COUNT(*)`
reports a total the visible list contradicts.

### Ordering, and one guard that cannot be tested

`ORDER BY SUM(t.count) DESC, t.technique_id` — most evidence first, because
that is where a conclusion is safest, with the id making the order total.

**Deleting the tiebreak does not turn any test red**, and the test says so
rather than implying coverage. The first version of this entry also gave the
*wrong reason* — it claimed a HashAggregate. `EXPLAIN` at two scales says
otherwise:

	Limit -> Sort(sum DESC, technique_id) -> GroupAggregate -> Sort(technique_id, ...)

`COUNT(DISTINCT t.session_id)` forces that inner sort, and it leads with
`technique_id`, so the aggregate hands the outer sort an already-ordered stream
and Postgres preserves it for equal keys. Getting this right matters because it
names the real fragility, which the wrong explanation hid: **the tiebreak is
redundant only while `COUNT(DISTINCT session_id)` keeps the aggregate sorted.**
Drop that column and the planner picks a HashAggregate, whose group output is
bucket order — measured on 466 tied techniques, 459 of 466 positions moved.
So the guard is load-bearing *and* currently invisible, which is the worst
combination to leave undocumented.

`LIMIT 500` for the same reason every list has one now, and it **cannot bind**
today — but the first version of this entry was wrong about why, too. It said
"only a client inventing ids could reach it"; a client cannot invent ids at
all, because `technique_id` has an FK and an unknown one is rejected as invalid
input. The row count is capped by the library, at 466. The only way it ever
binds is **the library growing past 500**, at which point the funnel truncates
silently and the summary — folded from the truncated rows — under-reports in
step. That is now pinned by a test asserting the catalog stays under the cap,
which is the version of this guard that can actually fail.

### Nav gating stays capability-based

`catalog === "techniques"`, not `key === "bjj"` — the check this codebase has
deliberately avoided everywhere else. Mild over-inclusion accepted and recorded:
the evidence stream is `bjj_session_tags`, so a future discipline with a
technique catalog (judo, wrestling) would surface the link and find it empty.
That is the right failure — an analytical screen with an honest empty state.

### The two defects only rendering could catch, caught by reading the CSS

**`bg-lime-rule` is not a class.** `@theme` maps `--color-lime`, `--color-lime-ink`
and the rest; it never maps `--color-lime-rule`, which exists only as a raw var
that `.accent-rule` consumes. So the funnel bars — the one element carrying the
drop-off visually — emitted no background rule and rendered transparent. Three
invisible bars on the section the page is built around.

The fix was not to add the token. `--c-lime-rule` is `#b8ff2c` in *both* modes,
which is 1.21:1 on a light card; globals.css says as much. `--c-lime` is
theme-stepped (3.27:1 light, 15.12:1 dark) and is the right one.

**The bar widths resolved against the wrong box.** A percentage width on a flex
item resolves against the flex *container's* content box, not the track left
after the label and the number. The bar was the only shrinkable item, so it
absorbed the overflow — and by construction the longest bar always requested
exactly 100%, so it was always the one clamped while shorter bars sat at their
true percentage. Net effect: the drop-off was drawn consistently shallower than
it is, on the screen whose entire purpose is showing that drop-off. Fixed by
giving the fill its own `flex-1` track. The denominator now spans all three
stages too, since `tried_live` can exceed `drilled` (they are counted
independently) and would otherwise ask for >100% and clamp two different
numbers to identical bars.

Both were found by reading the branch's own compiled stylesheet, not by looking
at the page — which is the part worth remembering. **No unit test would ever
catch a Tailwind class that does not exist**, and the functional scenarios
written for this feature are all behavioural. The page still has not been
rendered.

### A bucket that was reachable and had nowhere to go

`bucketOf` returned `null` for a technique with no drilled, attempted or scored
evidence — which the endpoint can absolutely return, because its only filter is
`technique_id IS NOT NULL` and a `conceded`-only row passes it. That row counted
toward "Everything" and toward no sub-bucket, so the chip counts silently failed
to sum, and it rendered as a line of dashes that reads like a data bug. It is
now its own bucket ("Used on you"), which also gives `conceded` its first
display surface anywhere in the product.

### The OpenAPI gate had been dead for months

The two new schemas landed in `components.parameters` rather than
`components.schemas` — an insertion anchored one section too low — so the
endpoint's documented 200 body pointed at nothing. `pnpm run lint:openapi`
reported "Woohoo! Your API description is valid."

It always did. `.redocly.yaml` declared a root-level `rules:` block with **no
`extends:`**, and that *replaces* redocly's default ruleset rather than amending
it. The gate ran zero rules. Long enough that four `$ref`s to
`#/components/responses/InvalidInput` — a response that has never existed, it
is called `BadRequest` — and one `security: [{ bearerAuth: [] }]` naming a
scheme that is actually `ClerkBearerAuth` were sitting in the contract
unnoticed.

This is precisely the shape `CLAUDE.md` already records for `fmt:api`: a check
that cannot fail is worse than no check, because it is counted as having
passed. `extends: [recommended]` is back, the five pre-existing breakages are
fixed, two flow-style descriptions containing commas (which YAML parsed as
extra properties — one of them mine) are quoted, and the gate is now verified
to go red on a dangling `$ref` rather than assumed to.

### Three guards that were invisible, and one number that could stick a 500

Review found seven surviving mutations where I had expected two. Three were
cheap to close and are now asserted: `MAX(started_at)` could be `MIN` (both
fixture sessions were stamped `time.Now()` microseconds apart, so the fixture
needed fixing before the assertion could exist), the whole `conceded` pivot
could be `0`, and `position`/`category` could be swapped in the SELECT list —
the standing hazard of a ten-column positional `Scan`, and both fields are
`required` in the contract.

Separately, `Tag.Count` had a lower bound and no upper one. `SUM(count)` is a
bigint that this query narrows with `::int`, so two rows near `MaxInt32` on one
technique make the endpoint fail with "integer out of range" — durable data, so
it stays broken for that athlete until the sessions are deleted. Now capped at
1000, which constrains only nonsense.

### And then CI found the one thing four reviewers could not

The integration tests used real catalog ids (`americana-mount`, `aoki-lock`)
and passed locally while failing in CI on a foreign-key violation. The reason
is embarrassing and worth recording: I had run `cmd/seed` against my local
`vola_test` earlier in the session, by hand, for unrelated reasons. **CI only
runs `cmd/migrate up`.** So the tests were depending on ambient database state
that had nothing to do with what they were asserting, and the local green was
an artifact of my own shell history.

Every fixture now seeds the technique rows it needs. And the guard on the
library size stopped querying the database at all — it reads the *embedded*
catalog via `technique.SeedData()`, so it runs everywhere instead of skipping
in precisely the environment it most needed to run in. That first version was a
silently-skipping test, which is the failure `CLAUDE.md` already records about
`TEST_DATABASE_URL` reproduced inside a single test.

Verified the fix the only way that means anything: created a fresh database,
ran `migrate up` and *not* `seed`, confirmed `count(*) FROM techniques` is 0,
and ran the whole backend suite against it green.

### What review caught, and one thing my own mutation test did

**The screen opened on yesterday.** `viewDay` was a `Date` captured at mount and
refreshed by nothing, while `now` re-reads on focus and on AppState. Leaving the
app on Today overnight therefore reopened it in *past mode* — yesterday in the
switcher, plans dimmed and marked "Not logged" — with the athlete having
navigated nowhere. It is a day **offset** now, derived from `now`, so every
refresh re-derives it and the class is gone rather than patched at the two
places that happened to refresh.

**A blanket `opacity: 0.55` on the past card** composited every ink inside it:
"Not logged" fell to 1.96:1 and the BJJ eyebrow to 2.51:1 — the latter being the
exact figure the palette cites as its reason for banning `textDim` from a done
row, and failing specifically for this app's headline discipline. The card is
not dimmed at all now; "Not logged" is `warn` at full strength, which is also
what it means.

And one that arrived from my own mutation testing rather than from review: the
first fix for the outside-the-week bug passed *two* plan lists and matched their
union. Three mutations of it stayed green, which is how it came out that the
wider list was **inert** — `matchPlans` groups by day, so plans on other days
can never compete for this day's sessions, and plans on the same day are the
same rows. A parameter that cannot change the answer reads as a safeguard and is
scenery. `owedOn(sessions, dayPlans)` is what was ever needed.

### Gaps this leaves

- **`conceded` has a bucket but still no column.** The "Used on you" filter
  surfaces those rows; the table has no count for them. The defensive funnel —
  "which submission keeps catching me" — is the obvious next feature, and both
  the API and the bucket now exist for it.
- **No web test suite exists at all.** `bucketOf`, the chip-count fold and the
  hit-rate withholding rule are pure functions over plain data, each encoding a
  load-bearing property, and nothing can assert any of them. Lifting them into
  `src/lib/` would make them testable without a renderer. Named here because
  the mobile suite exists precisely for this shape of logic and web has no
  equivalent.
- **No position or category rollup.** The design doc's position heatmap is a
  different read over the same rows and is not this PR.
- **No time axis.** Everything is all-time. "Improving" is not answerable from
  this screen, only "how much evidence exists", and that gap is the reason
  `sessions` and `last_seen` are in the payload.
- **The page is unverified against a signed-in session.** It builds, the route
  registers, and the endpoint returns 401 unauthenticated as designed — but
  rendering it with real rows needs credentials, which is not something to
  automate. Worth a look before it is trusted.


## 2026-08-03 — The focus list, and unbuilding a redundancy

Raised by the user, and correct: the reflection wizard had started asking for
the same thing twice. The drilled step captured tried/landed *per technique*;
the live grid captured scored/conceded *per category*. Hit one armbar and there
were two places to record it.

The previous PR met this by writing a **convention** — technique-tagged rows
are the specific record, untagged the catch-all — and teaching the query which
to read. That was papering over it. Two capture paths for one event means the
model is wrong, not the query.

### What the data is actually for

Laying the deferred features against what each one needs makes the answer
obvious:

| feature | needs |
| --- | --- |
| position heatmap ("where do I get stuck") | position + outcome. **No technique.** |
| gap detection | position graph + which edges have evidence |
| technique funnel | technique + stage |
| gameplan | curation over the above |

The design doc's own model is positions-as-nodes, techniques-as-edges, and an
edge already knows its position — a technique row carries one. So the category
grid and the technique funnel are **not two datasets. They are one dataset at
two resolutions.** You capture low-resolution always, and high-resolution only
where it earns its cost.

### The asymmetry that decides where technique detail goes

Position/category outcomes are cheap — a 5×2 grid of taps, no typing — and feed
the two highest-value questions in the sport. Technique-level data is expensive:
naming one means searching 466 entries. Across the whole library that data is
mostly noise; across the three-to-five things you are actually developing it is
the most valuable evidence in the system.

So technique capture stops being a search step and becomes **a short focus
list**, surfaced as one-tap chips inside the same grid. A focus technique's chip
*is* the row. There is no second place to record it, and the redundancy is gone
structurally rather than by convention.

This is the design doc's own "focus mode" — the tier it calls highest-leverage
and cheapest to build. Building it collapses the redundancy instead of managing
it, and it is the thing curricula later drop into with no new plumbing, since a
curriculum step is just a pre-authored focus.

### `started_on`, and the edit that would have destroyed it

The column exists so "you have been on this five weeks, consider rotating" is
answerable. Which makes the obvious implementation wrong: `SetFocus` replaces
the list wholesale, and a delete-then-insert would re-stamp every entry with
today's date on **every reorder** — the most ordinary edit there is. The clock
would reset constantly and nothing would report it.

So the write upserts on `(user_id, technique_id)` updating `position` **only**,
then prunes what is no longer listed. A test backdates an entry 35 days,
re-saves the list with a new technique in front of it, and asserts the old
entry's date survived while the new one starts today. The delete-first
implementation passes every other test in the file and fails that one.

### Cap of five, and the cap is the feature

A focus list holding twenty techniques is the library again, and would put the
wizard straight back to searching. Coaches structure development a few things at
a time; the constant enforces that rather than describing it.

### Two honest notes on what this leaves

- **`drilled` counts across the library are near-worthless long-run.** What you
  drilled is a record of your coach's curriculum, not your development — you did
  not choose it. Its only real job is being the denominator in the drop-off.
  Worth keeping for focus techniques; it should stop being the funnel's entry
  point, which is the next PR.
- **Nothing captures who you rolled with**, and it is probably the highest-value
  missing axis. "Landed a triangle" against a fresh white belt and against a
  brown belt are the same row today. One tap per session — mostly higher / same
  / lower — would multiply the meaning of every outcome already recorded. The
  design doc names it ("hit-live vs a same-rank partner") and nothing implements
  it.

### Four things review caught, two of which were live bugs

**A `PUT` with no body returned 200 and changed nothing.** `[]string(nil)` binds
to pgx as SQL NULL, and `technique_id <> ALL(NULL)` is NULL for every row — so
the prune deleted nothing, and the response *looked* right because it is a
read-back of the untouched list. That is precisely the failure the `<> ALL`
choice was made to avoid; the NULL just moved from an element of the array to
the array parameter. Guarded twice now: the handler rejects an absent field
(which also makes the contract's `required` true), and the repository
normalises nil to empty.

**Two devices reordering the same list deadlocked, 23 times in 40 rounds.** The
upsert takes one row lock per technique and iterated in the *athlete's* order,
so two saves of the same techniques ranked differently took the same locks in
opposite orders. It now iterates in `technique_id` order while keeping
`position` from the original index — same locks, same sequence, ranking
untouched. Measured 0 in 40 after.

**`started_on` went on the wire as `2026-08-04T00:00:00Z`** while the contract
promised `format: date`. Worse than a spec mismatch: a midnight-UTC instant
localises to the *previous day* for anyone west of UTC, on the one field whose
job is "how many weeks has this been here". Now a formatted string, matching
`Promotion.PromotedOn` one file over.

### The suite was quietly parallel over a shared database

The fixtures correctly bring their own library rows rather than depending on
`cmd/seed` — that lesson from the last PR landed. But `go test ./...` runs
packages **in parallel against one database**, and the technique package has
seven assertions counting `techniques` globally. Another package's fixtures sit
inside those counts.

Latent on `main` (measured 0 failures in 6 runs there, a narrow window) and
reproducible here: 3 in 6. Scoping each assertion was tried and abandoned —
fixing one left the other six, and every future assertion would have to
remember. Both `test:api` and CI now run `go test -p 1`, which kills the class:
0 in 6 after.

### What review caught, and one thing my own mutation test did

**The screen opened on yesterday.** `viewDay` was a `Date` captured at mount and
refreshed by nothing, while `now` re-reads on focus and on AppState. Leaving the
app on Today overnight therefore reopened it in *past mode* — yesterday in the
switcher, plans dimmed and marked "Not logged" — with the athlete having
navigated nowhere. It is a day **offset** now, derived from `now`, so every
refresh re-derives it and the class is gone rather than patched at the two
places that happened to refresh.

**A blanket `opacity: 0.55` on the past card** composited every ink inside it:
"Not logged" fell to 1.96:1 and the BJJ eyebrow to 2.51:1 — the latter being the
exact figure the palette cites as its reason for banning `textDim` from a done
row, and failing specifically for this app's headline discipline. The card is
not dimmed at all now; "Not logged" is `warn` at full strength, which is also
what it means.

And one that arrived from my own mutation testing rather than from review: the
first fix for the outside-the-week bug passed *two* plan lists and matched their
union. Three mutations of it stayed green, which is how it came out that the
wider list was **inert** — `matchPlans` groups by day, so plans on other days
can never compete for this day's sessions, and plans on the same day are the
same rows. A parameter that cannot change the answer reads as a safeguard and is
scenery. `owedOn(sessions, dayPlans)` is what was ever needed.

### Gaps this leaves

- **`started_on` is stamped from `CURRENT_DATE`, the server's date in UTC.** An
  athlete adding a technique after ~8pm Eastern gets tomorrow's date. Cosmetic
  at five-week granularity, but `/v1/sessions/history` already does calendar-day
  work in the caller's timezone, so this is inconsistent with an established
  convention.
- **The four handler validations have no automated coverage** — the cap, the
  duplicate check, the empty-id check, `MaxBytesReader`. There are no handler
  tests anywhere in this repo, so this matches convention rather than breaking
  it; worth naming because the cap in particular exists nowhere else, with no
  database constraint behind it, so deleting the check would be silent.
- **Backend only.** Nothing sets or reads a focus list yet — the web authoring
  surface and the mobile capture collapse are the next two PRs, and the
  redundancy stays until the second of them lands.
- **No rotation prompt.** `started_on` is stored and returned; nothing reads it
  to suggest rotating.
- **No focus history.** Removing a technique from the list deletes the row, so
  "what was I working on in June" is not answerable. Deliberate for now — the
  evidence in `bjj_session_tags` survives regardless, which is the part that
  matters.


## 2026-08-03 — The capture collapse

The redundancy the user spotted is now actually gone, rather than managed.

Before this, one armbar could be recorded in two places: tried/landed **per
technique** on the drilled step, and scored/conceded **per category** in the
live grid. Two PRs ago that was met with a convention about which rows a query
should read. This removes the second path.

### What moved

- **The drilled step gives up its counters.** It records what was covered and
  nothing else — which is all it was ever good for. What you drilled is your
  coach's curriculum, not your development; its only real job is being the
  denominator in the drop-off.
- **The live step gains a "Working on" block**, one row per focus technique,
  Tried / Landed. One tap each, no search, because the focus list already named
  them. Below it the category grid is unchanged and relabelled "Everything
  else", which is the instruction: log each thing once, in the most specific
  row available.

Net taps are *lower* than before for the athlete who was double-recording, and
unchanged for everyone else. For a technique drilled outside the focus list,
per-technique live capture is simply gone — fewer taps because less is
captured, which is a different claim and the deliberate trade: that data was
the expensive half and mostly noise.

### The union, and why focus alone would have stranded rows

The block shows the focus list **plus any technique this session already has
live evidence for**. Focus alone is not enough: drop a technique from the list
on web after logging against it, and its `attempted`/`scored` rows stay in the
session with no control able to edit them — saved, synced, invisible.

That is exactly how the drilled-step counters stranded rows when a chip was
removed, and repeating it one screen along would have defeated the point. The
union keeps "what is displayed" and "what is stored" the same set. It is
extracted as `focusRows()` rather than left in a `useMemo`, so it is testable
without a renderer — and four mutations of it go red, including removing the
union itself.

### One property inverted on purpose

`removeDrilledTechnique` used to take a technique's `attempted`/`scored` rows
with it. That was right while the drilled step was the only place they could be
authored. It is wrong now: live outcomes come from the focus rows, which are
reachable whether or not the technique was drilled today. "I did not actually
drill this" and "I did not hit this live" are different statements, and
un-saying one must not un-say the other. The test that asserted the old
behaviour now asserts the new one, and says why it flipped.

### Two vocabulary helpers moved into `lib/`

`toCategory` and `familyOf` were local to the reflection screen and are now
needed by two modules. They are the translation from the library's vocabulary
("Submission", "Guard - Bottom") to the tag vocabulary ("submission", "Guard"),
and getting them applied in only one of the two places would file a focus row's
evidence under a different position from a drilled row's for the same
technique — splitting it in half with no error anywhere. One test pins that.

### What review caught

**The "Everything else" heading escaped its conditional**, so every athlete
today — nobody has a focus list — saw a single grid headed "EVERYTHING ELSE"
with nothing for it to be else to.

**And technique-tagged live outcomes had no display surface on the session
read-back screen.** It keyed the whole Techniques section off the drilled list,
so a technique tried live but not drilled showed nowhere. Reachable *today*,
with no focus list in existence: remove a drilled chip and its
`attempted`/`scored` rows deliberately survive — then `hasAnyDetail` went false
and the screen rendered "No detail recorded" over data that exists. The
write-but-never-read-back defect, third appearance, one screen along each time.
Fixed by taking the same union the live step takes, so display and storage are
the same set on both screens.

Also: the two functions this PR promoted into `lib/` had their fallbacks
entirely untested — `familyOf` returning `''` for an unknown family and
`toCategory` defaulting to `control` both survived mutation against the whole
suite. Those are exactly the branches the code calls dangerous, and the stated
reason for the move is that a mis-applied translation splits evidence silently.
Both now pinned.

And `removeDrilledTechnique`'s JSDoc still described the behaviour this PR
inverted — hover text reading as an instruction to restore it.

### What review caught, and one thing my own mutation test did

**The screen opened on yesterday.** `viewDay` was a `Date` captured at mount and
refreshed by nothing, while `now` re-reads on focus and on AppState. Leaving the
app on Today overnight therefore reopened it in *past mode* — yesterday in the
switcher, plans dimmed and marked "Not logged" — with the athlete having
navigated nowhere. It is a day **offset** now, derived from `now`, so every
refresh re-derives it and the class is gone rather than patched at the two
places that happened to refresh.

**A blanket `opacity: 0.55` on the past card** composited every ink inside it:
"Not logged" fell to 1.96:1 and the BJJ eyebrow to 2.51:1 — the latter being the
exact figure the palette cites as its reason for banning `textDim` from a done
row, and failing specifically for this app's headline discipline. The card is
not dimmed at all now; "Not logged" is `warn` at full strength, which is also
what it means.

And one that arrived from my own mutation testing rather than from review: the
first fix for the outside-the-week bug passed *two* plan lists and matched their
union. Three mutations of it stayed green, which is how it came out that the
wider list was **inert** — `matchPlans` groups by day, so plans on other days
can never compete for this day's sessions, and plans on the same day are the
same rows. A parameter that cannot change the answer reads as a safeguard and is
scenery. `owedOn(sessions, dayPlans)` is what was ever needed.

### Gaps this leaves

- **Nothing sets a focus list yet.** The web authoring surface is still
  unbuilt, so for most athletes the block is *absent* — not empty; it is gated
  on having rows — and the category grid is the whole capture surface. The
  exception is anyone holding a reflection with technique-tagged outcomes from
  the previous build: they get a "Working on" block of raw technique slugs,
  because the live step does not fetch the library. That is a strictly better place than before —
  the redundancy is gone either way — but the technique funnel gets no new data
  until web lands.
- **Choosing "the most specific row" is copy, not structure.** An athlete can
  still tap both their armbar row and Submissions/Hit for one armbar. Both
  screens render that correctly and the proficiency read takes only the
  technique-tagged row, so it does not double-count — but nothing prevents it.
  Making it structural would mean the grid knowing which categories a focus
  technique covers, which is more machinery than the problem currently earns.
- **`conceded` still has no per-technique row.** "Which submission keeps
  catching me" remains unanswerable at technique granularity. The defensive
  funnel is the obvious next feature and the API side already accepts it.
- **Not verified on a device.** `pnpm run verify` is green and the transforms
  are mutation-tested, but nothing has drawn the new block.


## 2026-08-03 — Setting the focus, beside the numbers that justify it

The last piece of the three-PR arc. `/dashboard/proficiency` can now set the
focus list, which is what makes the mobile collapse actually do anything —
until this, the wizard's "Working on" block was absent for everyone because
nothing could populate it.

### Where it went, and why it is not its own screen

A star per row in the proficiency table, plus a panel above it. Same pattern
and the same reasoning as pinning on the Records page: on a wide screen the
choice and the thing being chosen sit side by side, so you decide what to work
on **while looking at the drop-off that says you should**. A technique showing
"drilled 12, tried 0" is one click from becoming this month's focus.

That adjacency is the design doc's insights→focus loop, and it only works if
the two are one screen. A separate focus editor would make you remember the
number rather than see it.

Web, per the platform rule: choosing what to work on for the next few weeks is
planning. The phone reads the list and never writes it.

### `started_on` finally gets read

The panel shows "3 weeks" per entry — the reason that column survives a re-save
on the server, and until now stored and returned but **rendered** by nothing.
It is parsed as UTC midnight and compared in whole days, so the count is
globally consistent: identical everywhere at any instant. Not aligned to the
viewer's calendar day — someone at UTC-8 sees it tick over at 16:00 on their
day 6 — which is the right trade for a five-week granularity. The empty-string
placeholder the optimistic update writes
renders as nothing rather than as "0 weeks", which would be a number the
athlete could read as real.

### The cap is enforced in the UI as a refusal, not a silent truncation

Starring a sixth technique sets an error naming the number and does not fire
the request. The server rejects it too — this is the message, not the guard.

### Three blocking findings, all in the plumbing rather than the idea

**`Promise.all` did the opposite of the comment above it.** The comment
promised "a failed focus read must not blank the funnel"; `Promise.all` rejects
the moment either leg does. A 500 from the secondary read took the whole page
down, under a banner saying the funnel had failed. `allSettled` now applies
whichever leg resolved, and only the primary read's failure blanks anything.

**Two saves in flight could leave the UI and the server disagreeing, in both
directions.** Responses need not complete in request order, so a stale *success*
could re-fill a star just cleared; and a per-click `previous` snapshot meant a
late *failure* rolled back past edits that had already succeeded — emptying the
panel while the server held a full list. Both reachable by ordinary clicking:
setting three focus techniques is one round trip's worth. Every save is now
stamped and only the newest outcome is applied, so the last write the athlete
made is the one that stands. Both handlers were also collapsed into one writer,
since two copies of this logic is how they drifted apart in the first place.

**The cap refusal rendered under "Couldn't load your funnel."** `error` had
become three channels — load failure, save failure, and the refusal — sharing
one banner with a "Try again" button. So the one refusal guaranteed to happen
told the athlete a load had failed that hadn't. Refusals and save failures now
have their own quieter `role="status"` notice.

### What review caught, and one thing my own mutation test did

**The screen opened on yesterday.** `viewDay` was a `Date` captured at mount and
refreshed by nothing, while `now` re-reads on focus and on AppState. Leaving the
app on Today overnight therefore reopened it in *past mode* — yesterday in the
switcher, plans dimmed and marked "Not logged" — with the athlete having
navigated nowhere. It is a day **offset** now, derived from `now`, so every
refresh re-derives it and the class is gone rather than patched at the two
places that happened to refresh.

**A blanket `opacity: 0.55` on the past card** composited every ink inside it:
"Not logged" fell to 1.96:1 and the BJJ eyebrow to 2.51:1 — the latter being the
exact figure the palette cites as its reason for banning `textDim` from a done
row, and failing specifically for this app's headline discipline. The card is
not dimmed at all now; "Not logged" is `warn` at full strength, which is also
what it means.

And one that arrived from my own mutation testing rather than from review: the
first fix for the outside-the-week bug passed *two* plan lists and matched their
union. Three mutations of it stayed green, which is how it came out that the
wider list was **inert** — `matchPlans` groups by day, so plans on other days
can never compete for this day's sessions, and plans on the same day are the
same rows. A parameter that cannot change the answer reads as a safeguard and is
scenery. `owedOn(sessions, dayPlans)` is what was ever needed.

### Gaps this leaves

- **You can only focus on a technique you already have evidence for.** The
  table lists what you have drilled or tried; something you have never touched
  cannot be starred, so a coach saying "work on the berimbolo" has nowhere to
  go until you have drilled it once. Adding a library search here is the
  obvious follow-up and is deliberately not in this PR. The panel itself is now
  rendered whenever a list exists, even with no evidence at all, so an athlete
  can always see and clear what their phone is reading.
- **No ordering control.** The list is the order techniques were starred, and
  the API preserves whatever order it is sent — but nothing lets the athlete
  rearrange it. Fine while the phone shows all five as equals; wrong once
  anything treats the first entry as the primary focus.
- **No rotation prompt.** The panel shows how many weeks; nothing suggests
  rotating at four to six, which is the thing the number is for.
- **Still not rendered.** Every class used was checked against the compiled
  stylesheet — the defect that shipped two PRs ago was a class that did not
  exist — but nothing has been seen on screen, because the page is behind Clerk
  auth.


## 2026-08-03 — Content stops needing a deploy

Asked for after a class taught a pass — the São Paulo — whose name was not in
the library, and there was no way to record it without opening a laptop.

Two corrections framed the work. **Content never needed migrations**: those are
schema, and adding a technique was always "edit `techniques.json`, commit,
deploy, re-seed". Still a code round-trip, but not the treadmill it looked
like. And **the seed was never going to fight admin rows**: `UpsertAll` for
techniques and exercises does not delete ids it does not know about. What it
*would* do is revert an admin edit to a row the JSON also knows, on every
deploy, because a re-seed runs on every release.

### The decision that shaped everything: ids are permanent

`bjj_session_tags.technique_id` is a foreign key. A technique id is a reference
in athletes' training records for as long as those records exist. So:

- **ids are derived, never typed** — `Slug("São Paulo Pass")` → `sao-paulo-pass`,
  with accents folded so it is not `s-o-paulo`.
- **ids are immutable.** The update takes its id from the path, never the body.
  Renaming the technique later leaves the id alone, which looks inconsistent
  and is correct: an id that tracks the name is an id that changes.
- **create is not an upsert.** A collision is a 409, because silently rewriting
  the technique behind an existing id changes what somebody's history says
  they did.

### `source`, and what it buys

One column, `seed` | `admin`, on `techniques` and `exercises` (migration
000032). The seeder's upsert gained `WHERE source = 'seed'`, and that single
clause is what allows a second writer to exist at all — without it every deploy
silently reverts admin content.

The reverse also had to hold, and is tested separately: the guard must not stop
the seed updating *its own* rows, which would be a content freeze that looks
exactly like "nothing changed".

Admin edits are refused on seeded rows rather than allowed-then-reverted, and
the refusal explains itself — a bare 404 at an id the console is displaying
reads as a bug, when the real answer is "that one lives in the JSON".

### One validator, not two

`ValidateFields` was split out of the seeder's `validate()` and exported, so
admin writes and the deploy apply the same rules. A position family or a
function verb no client recognises is the worst data this catalog can hold: it
writes, it renders, and it returns an empty list forever with nothing
reporting a fault.

Position is validated against **the catalog's own distinct values**, not a
constant — the same choice `validate()` already makes for `to_position`. The
first version of this hardcoded "must be a known family" and three existing
tests immediately failed: the shipped library holds 16 distinct positions, and
one of them is the literal "Other" (the technical standup, which happens from
nowhere in particular). A rule invented from the shape of the data rather than
read off it.

### The two-writers hazard, demonstrated on day one

The seed's upsert wraps three columns in `NULLIF($n, '')` — `ibjjf_ruleset_id`
has a foreign key, and `function`/`to_position` are validated vocabularies
where empty means "not recorded". The new INSERT did not, and failed the
ruleset FK on the first test that ran. Exactly the divergence this feature has
to avoid, surfacing before a line of UI existed.

### How content reaches production

Author live in an environment, then export the `source = 'admin'` rows back
into the seed JSON, review the diff, and deploy. Promotion is the existing
pipeline, the seed artifacts stay reproducible, and the one permanent thing —
the id — gets read by a human before it is in anyone's training record.

### What review caught — three defects, all in the layer that could not be tested

**PATCH was a full replace while the contract promised partial.** `TechniqueWrite`
marks four fields required and the method is `PATCH`, so a client author is told
in writing the other fourteen are optional — and a console form posting only the
edited field silently erased the rest. Omitting `description` wiped the prose.
Every field is a pointer now, so absent is distinguishable from empty and
clearing a field stays expressible.

**Both writes returned `0001-01-01T00:00:00Z`.** `created_at`/`updated_at` were
missing from the returning projection — well-formed enough to satisfy a schema
validator and to render as "Created 1 Jan 0001".

**An unbounded name minted a permanent id.** A ~3000-character incompressible
name 500'd on Postgres's btree limit; a compressible 4000-character one
*succeeded* and minted a 4000-character id that is now a foreign key in training
records. The longest name in the shipped catalog is 41 characters, so a 200-cap
rejects nothing real and guards the seeder too. Given this feature's own premise
— the id outlives everything and cannot be taken back — an unbounded permanent
id was the one input that must not have been accepted.

All three were handler-layer, and **the handler could not be tested**: the
constructor took `*PostgresRepository` rather than the interface, unlike every
other module here. Taking the interface cost three lines and the layer now has
nine tests.

### The guard with zero coverage

The exercises half of the seed guard had none — deleting
`WHERE exercises.source = 'seed' AND` left the *entire* backend suite green. It
is inert today because there is no exercise write path, which is exactly why it
would still have been untested when one lands and makes it load-bearing. It now
has the same test the techniques half does.

Also worth recording: the timestamps fix is in SQL, so the handler test cannot
see it — the fake repository supplies its own timestamps and stays green with
the projection broken. That assertion lives in the integration test instead, and
both mutations were checked separately.

### What review caught, and one thing my own mutation test did

**The screen opened on yesterday.** `viewDay` was a `Date` captured at mount and
refreshed by nothing, while `now` re-reads on focus and on AppState. Leaving the
app on Today overnight therefore reopened it in *past mode* — yesterday in the
switcher, plans dimmed and marked "Not logged" — with the athlete having
navigated nowhere. It is a day **offset** now, derived from `now`, so every
refresh re-derives it and the class is gone rather than patched at the two
places that happened to refresh.

**A blanket `opacity: 0.55` on the past card** composited every ink inside it:
"Not logged" fell to 1.96:1 and the BJJ eyebrow to 2.51:1 — the latter being the
exact figure the palette cites as its reason for banning `textDim` from a done
row, and failing specifically for this app's headline discipline. The card is
not dimmed at all now; "Not logged" is `warn` at full strength, which is also
what it means.

And one that arrived from my own mutation testing rather than from review: the
first fix for the outside-the-week bug passed *two* plan lists and matched their
union. Three mutations of it stayed green, which is how it came out that the
wider list was **inert** — `matchPlans` groups by day, so plans on other days
can never compete for this day's sessions, and plans on the same day are the
same rows. A parameter that cannot change the answer reads as a safeguard and is
scenery. `owedOn(sessions, dayPlans)` is what was ever needed.

### Gaps this leaves

- **The export does not exist yet.** Until it does, admin content lives only in
  the environment it was authored in. That is the next PR and the thing that
  makes this promotable rather than local.
- **No admin UI.** This is the API and the data rules; the console screens are
  a separate PR.
- **Techniques only.** Exercises got the `source` column and the seed guard but
  no write path — the shapes differ enough (position/category/function vs
  sport/equipment/muscles) that one generic editor would be more machinery than
  two content types earn.
- **No delete.** Deliberate: a technique with training records pointing at it
  cannot be removed without deciding what happens to them, and that is a real
  design question rather than a missing endpoint.
- **Two techniques whose names slug identically can never both exist**, and
  there is no escape hatch — "Kimura (from Guard)" and "Kimura from Guard"
  collide, and the only recourse is naming it something you did not want.
  Auto-appending `-2` would be worse: it makes a permanent id depend on
  insertion order. An optional server-validated `id_suffix` is the likely
  answer, and is not in this PR.
- **`source` is on the write response but not on any read path**, so the console
  cannot render an "editable" badge without attempting a PATCH and reading the
  409. Worth adding to the detail projection before the UI PR.
- **The merged row is re-validated on update**, so a stored technique that fails
  current validation cannot be edited until its data is fixed. Defensible, and
  not obvious — it surfaced when a test fixture was incomplete.
- **`cmd/seed` still logs "466 upserted" regardless of how many rows the guard
  skipped**, so a JSON entry permanently shadowed by an admin row is invisible.


## 2026-08-04 — The export, and the bug it uncovered

`cmd/exportcontent` carries admin-authored rows back into the seed JSON, which
is the half that makes console authoring more than a local convenience: without
it, a technique added in staging exists only in staging's database.

### It writes BOTH files, and the first version wrote only one

This is the correction review forced, and it is the whole design.

`techniques.json` is the **deploy artifact**: `//go:embed` bakes it into the
binary, `SeedData()` returns it, `cmd/seed` writes it to the database.
`techniques.additions.json` is the **record of non-spreadsheet content**:
`scripts/import-exercise-catalog.py` rebuilds `techniques.json` from a
spreadsheet and merges this file back in.

All 16 existing additions are in both files. That is the invariant, not an
accident — and the first version of this command missed it, writing only the
additions file because the generated-file warning is the loud one. Content
landing in only one is lost by a different route each time:

- **additions only** — the deploy does not carry it. `-adopt` then hands the row
  to a release that cannot reseed it, so the next fresh environment simply does
  not have the technique, and nobody can edit it either: the console refuses
  seeded rows, and no seed owns it.
- **techniques.json only** — the next spreadsheet re-import deletes it, silently,
  because the sheet is a full replacement rather than a patch.

So the export writes both, merging rather than replacing: both files hold
content this command never wrote — 16 hand-authored additions, and 466 generated
entries — so overwriting either destroys content with no other copy.

### Empty arrays, and the seed transaction they take down

The first version omitted empty values, and a test asserted it as correct. It
was a data-loss bug with a wide blast radius.

`aliases`, `setup_from`, `common_counters` and `common_next_moves` are
`TEXT[] NOT NULL`. An omitted key unmarshals to a nil slice, pgx encodes a nil
slice as NULL, and the insert runs inside `UpsertAll`'s transaction. So one
exported technique with no aliases fails the **entire seed** — all 467
techniques, not just its own row. Reproduced against real Postgres:

	null value in column "aliases" of relation "techniques"
	violates not-null constraint (SQLSTATE 23502)

Every entry in both shipped files already writes `[]` and `""` explicitly; the
export now matches. `function` and `to_position` stay optional, because they
genuinely are — `to_position` is absent on 317 of 466 entries and migration
000029 is explicit that absent means "not recorded", a different fact from any
value.

### The diff has to be readable, and key order is what breaks it

A re-export with no changes is **byte-identical**, and so is a re-serialisation
of the untouched files. Without that the promotion path is unusable: the one
review step standing between a typo and a permanent foreign key is a whole-file
rewrite nobody reads.

The threat is not formatting, it is **key order**. Go marshals a map with its
keys sorted; both files are written by Python in semantic order (`id`, `name`,
`aliases`, `category`, …). Reading into `map[string]any` therefore reorders every
key of all 482 entries on the first export. The files are now read and written
through an ordered key/value type, and the test asserts byte-identity against the
real shipped files rather than a fixture — a fixture would only prove the code
agrees with itself.

**Neither file is in id order** — that was checked rather than assumed, after
an earlier version sorted "only if the file is already sorted" and review
pointed out the branch never fired. `techniques.json` inverts at index 1
(`grappling-stance-motion` > `breakfall-backward`), the additions file at index
2. So existing entries keep the file's own order, full stop, and new ids are
appended sorted among themselves — which keeps the output independent of the
order the database returned the rows in, without touching a single existing
line.

### Two keys in the wrong slot, and the test that held them there

The first version appended `function` and `to_position` to the end of every
entry it wrote. Measured against the shipped catalog, that is wrong for both:

	462 of 466   function     sits between category and position
	149 of 466   to_position  sits between position_detail and gi_no_gi

And it is not cosmetic. `apply_taxonomy` inserts `function` right after
`category`, and `carry_to_position` rebuilds each record to place `to_position`
after `position_detail` — so the next spreadsheet re-import silently relocates
both keys on every entry the export wrote, producing exactly the whole-file diff
the ordered-writer exists to prevent.

The test made it worse: it compared `keyOrder[i]` index-for-index against the
additions file's first entry, which carries **neither** optional key. So the
wrong order passed, and correcting the constant turned the test red. It now
checks the order as a **subsequence** across every entry in both files, plus a
second test naming the two interior slots specifically — because a subsequence
check over entries that omit them passes either way.

### Export and adopt are two commands, deliberately

`-adopt` flips exported rows to `source='seed'`, handing them to the deploy.
It is separate because until the JSON is committed AND released, the database row
is the only copy — flipping early leaves content owned by a deploy that does not
carry it, editable by nobody. The order is: export, review, merge, deploy, adopt.

Adoption is scoped to `source='admin'`, and the reason is not the value —
setting `seed` on a row that is already `seed` is invisible — but `updated_at`.
Clients delta-sync on it, so an unscoped adoption makes every named seeded
technique look changed to every device. The first version of that test asserted
on `source` and could not tell the two queries apart.

### What testing it uncovered, which is the real story

The first end-to-end run exported a **fully-populated** São Paulo Pass rather
than the stub inserted. `sao-paulo-pass` — "São Paulo Pass", alias "Tozi pass",
Guard - Top, with description and `to_position` — **has been in the catalog all
along.** The test had flipped a real seeded row to `admin`; that was reverted.

The technique was never missing. **The search cannot find it.**
`searchTechniques` does `toLowerCase().includes(q)` with no diacritic folding:

	"sao paulo"  -> not found
	"sao"        -> not found
	"são paulo"  -> found, but nobody types the tilde on a phone
	"tozi"       -> found

So the request that started this whole line of work — "the name is not in the
list" — was a lookup bug, not missing content. And the content manager, useful
as it is, would have made it worse: authoring a second São Paulo pass gives two
ids for one technique, permanently, in training records. Exactly what that PR's
design is most careful about, arrived at from the other direction.

The fix is small and is the next piece of work: fold diacritics on both sides
before comparing. `Slug`'s `foldASCII` map already does it and can be shared.

### The invariant with no test, which is how it shipped broken the first time

Review deleted the `techniques.json` write from the export and the entire suite
stayed green. Every test covered a pure function — `mergeInto`, `writeJSON`,
`refuseSheetOwned`, `entryOf` — and the two-file invariant lived inline in
`main()`, which had no coverage at all. That is the exact regression the second
revision exists to fix, invisible to the tests written alongside the fix.

The write now goes through `run(seedPath, additionsPath, authored, logger)` and
a test asserts both files carry the exported id. Deleting either write is red.

Three more came out of the same pass:

- **`-adopt` adopted content it had just written.** It re-runs the export, then
  adopted everything `AdminAuthored` returned — so adopting last week's batch
  also adopted a technique authored an hour ago and written to the file seconds
  earlier, handing it to a release that cannot reseed it and that the console
  will no longer let anyone edit. It is now scoped to ids the seed file carried
  **before** this run touched it, which is exactly "already committed and
  deployed".
- **A duplicate id in an existing file was silently deduped**, keeping the last
  and deleting the other on the next write — the content loss this command
  exists to prevent, committed by the command. `techniques.json` cannot reach
  that state (`validate()` rejects it); the additions file had no such check.
  Now refused by id.
- **Nothing validated what was written.** The file is what `go:embed` bakes into
  the binary, so an invalid `category` or `function` fails `SeedData()` on the
  next deploy, far from the operator who could still fix it. `ValidateFields`
  now runs before either write. It caught an incomplete test fixture of mine
  immediately.

### One place Go and Python disagree

Verified with an adversarial corpus rather than assumed: en dash, em dash, CJK,
non-BMP emoji, U+00A0, C1 controls, `\b`, `\f`, quotes, backslashes and nested
arrays all round-trip identically between Go's encoder and Python's
`json.dumps(indent=2, ensure_ascii=False)`.

**U+2028 and U+2029 do not.** Go escapes them unconditionally —
`SetEscapeHTML(false)` does not suppress it — where Python writes the raw
character. Reachable by pasting prose from an editor that uses U+2028 as a soft
line break. Consequence is a one-line cosmetic diff on the next re-import, and
both forms parse identically, so it is recorded rather than fixed.

### What review caught, and one thing my own mutation test did

**The screen opened on yesterday.** `viewDay` was a `Date` captured at mount and
refreshed by nothing, while `now` re-reads on focus and on AppState. Leaving the
app on Today overnight therefore reopened it in *past mode* — yesterday in the
switcher, plans dimmed and marked "Not logged" — with the athlete having
navigated nowhere. It is a day **offset** now, derived from `now`, so every
refresh re-derives it and the class is gone rather than patched at the two
places that happened to refresh.

**A blanket `opacity: 0.55` on the past card** composited every ink inside it:
"Not logged" fell to 1.96:1 and the BJJ eyebrow to 2.51:1 — the latter being the
exact figure the palette cites as its reason for banning `textDim` from a done
row, and failing specifically for this app's headline discipline. The card is
not dimmed at all now; "Not logged" is `warn` at full strength, which is also
what it means.

And one that arrived from my own mutation testing rather than from review: the
first fix for the outside-the-week bug passed *two* plan lists and matched their
union. Three mutations of it stayed green, which is how it came out that the
wider list was **inert** — `matchPlans` groups by day, so plans on other days
can never compete for this day's sessions, and plans on the same day are the
same rows. A parameter that cannot change the answer reads as a safeguard and is
scenery. `owedOn(sessions, dayPlans)` is what was ever needed.

### Gaps this leaves

- **The console UI still does not exist**, so authoring is `curl` and the export
  has little to carry.
- **Exercises are not exported.** They have the `source` column and the seed
  guard but no write path, so there is nothing to export yet.
- **Adoption is still all-or-nothing within what is deployed** — it takes every
  eligible id, with no way to adopt a subset of those.
- **The adopt log counts what was requested, not `RowsAffected`.** A row adopted
  concurrently makes it overstate.
- **A category the console accepts can break the importer.** `ValidateFields`
  deliberately does not constrain `category` ("this vocabulary is still
  settling"), but `derive_function` in the importer exits on anything outside
  its nine. Before this command console content never reached the importer; now
  a technique filed as "Guard Pass" seeds, renders and exports fine, then breaks
  the next re-import. Loud and recoverable, but it is a new coupling.
- **`cmd/exportcontent` ships in the deployed API image.** The Dockerfile builds
  `./cmd/...` wholesale, so a content-authoring CLI is now in the runtime image.
  Existing behaviour, not a regression, but it is a choice rather than an
  accident now.
- **Nothing verifies the exported JSON round-trips through the PYTHON importer.**
  The Go side is now verified end to end — export against a real database, then
  `cmd/seed` from the exported file, 467 upserted, `aliases = {}` — but running
  `scripts/import-exercise-catalog.py` over the result needs the spreadsheet and
  is not automated. The collision guard prevents the known failure mode.
- **The collision rule is about ownership, not existence.** An id in
  `techniques.json` but not in the additions file belongs to the sheet, and an
  edit to it would be reverted by the next import — so it is refused. An id in
  both is ours, already promoted once, and re-exporting it is the normal update
  path. A rule of "refuse anything already seeded" would have refused every
  legitimate update, which is what the first version did.

## 2026-08-04 — The technique was never missing; the search could not find it

`searchTechniques` folded case and nothing else, so a query and the catalog
compared as literally different strings whenever an accent was involved:

	"sao paulo"  -> nothing
	"sao"        -> nothing
	"são paulo"  -> found, and nobody types the tilde on a phone
	"tozi"       -> found, by alias

`sao-paulo-pass` — "São Paulo Pass", alias "Tozi pass", Guard - Top, with a
full description and a `to_position` — had been in the library the whole time.

### How it surfaced, which is the part worth keeping

Not from a bug report. It came out of **testing the content-export command**:
the first end-to-end run exported a fully-populated São Paulo Pass rather than
the stub that had just been inserted, because the test had flipped a real
seeded row to `source='admin'`. The export was working; the surprise in its
output was the finding.

The request that started three PRs of work — admin authoring, so a technique
seen in class could be added without a deploy — was a **lookup** bug. And the
work would have made it worse: authoring a second São Paulo pass mints a second
id for one technique, permanently, in every training record referencing either.
That is the exact catastrophe the authoring PR's design is most careful about,
reached from the direction the design does not defend.

### The fix

`foldForSearch` normalises NFD and strips U+0300–U+036F (the combining-marks
block), so "ã" becomes "a" + a mark that is then dropped. Applied to both the
query and the haystack, so a Portuguese keyboard is not the thing that breaks
instead.

### The larger half, which review found and the first cut missed

Diacritics were 3 of the 26 non-ASCII characters in the searchable fields. The
other 23 are **U+2013 EN DASH**, which NFD does not decompose — and they sit in
**16 technique names**:

	"north-south pass"          -> nothing
	"crossface-underhook"       -> nothing
	"north–south pass"          -> found, with the dash pasted in

Same defect, eight times the blast radius, and not a misspelling: the two
characters render nearly identically and only one is on a keyboard. The
catalog already disagrees with itself about it — `positions.json` spells the
position `"North-South"` with a plain hyphen (and carries the alias
`"north south"`) while every technique name in that position uses the en dash,
so the chip and the names disagree on screen.

So the fold also maps every dash — U+2010–U+2015, U+2212, and the ASCII hyphen
— **to a space**, not to a hyphen. Folding to a hyphen closes the 16; folding
to a space also makes "north south", "kesa gatame" and "crossface underhook"
work, because nobody reaches for a hyphen when searching. Measured over every
name and alias in the catalog, folding to a space finds everything folding to a
hyphen finds, plus six more query forms, and loses nothing:

	                       ->hyphen   ->space
	  "north south"              0        13
	  "north south choke"        0         1
	  "crossface underhook"      0         1
	  "kesa gatame"              7         8

The first cut of this PR shipped the accent fix and a "Gaps" note saying the
blast radius was small because only 2 entries carried diacritics — true, and
90% of the hazard was still open. The reviewer inventoried the actual code
points rather than trusting the claim.

`String.prototype.normalize` is not universal on Hermes, so it was verified in
the binary that actually ships in the app rather than assumed from jest, which
runs on Node: the framework carries the NFKC/NFKD form names and the "Invalid
normalization form" error string alongside its other `String.prototype` errors.

Folded haystacks are memoised in a `WeakMap` keyed on the technique object.
Search runs per keystroke over 466 entries × name + aliases + position — around
2000 `normalize` calls per character without it — and the catalog objects are
immutable and module-cached, so the map invalidates itself when a refetch makes
new ones. Fields are joined with a separator so a query cannot match across the
seam between a name and a position.

### The screen that made a lookup failure look like missing content

The reflection wizard's technique picker had no empty state — a query matching
nothing rendered blank space, indistinguishable from an unfilled box. That is
the exact surface where an athlete is trying to attach a technique to a session
they just trained, so a blank result reads as "not in the library" rather than
"not found". It now says which query found nothing. The Library tab already did
this correctly; reflect did not.

### Duplicated, deliberately

`apps/mobile/lib/techniques.ts` and `apps/web/src/lib/api.ts` each have a copy.
The two apps share no package and mobile's has to work offline — the same
reason the position vocabulary is duplicated four ways. Both carry a comment
saying so.

### The test that derived its cases from the fix instead of the defect

Worth recording because it is this repo's recurring failure and it happened
again, inside the PR whose whole point was that a false negative is invisible.

The sweep started as "every entry whose fields change under the fold", guarded
by `expect(count).toBeGreaterThan(15)`, with a comment claiming a no-op fold
would empty the set and fail. Backwards: under an identity fold the predicate
`fold(f) !== f.toLowerCase()` is true for anything containing a capital letter,
so the set grew from 432 to all 466 and the test **passed**. The threshold was
meaningless against 432 either way, and the loop always queried the *name*, so
for the 197 entries that qualified only through an alias or a position it
asserted "a technique is findable by its own name" — true with or without any
folding.

It now derives from the **defect**: for each searchable field the typed form is
its folded spelling, and an entry counts if the *old* search would not have
found it by that spelling. Three ids are named explicitly —
`sao-paulo-pass`, `north-south-pass`, `rear-naked-choke` — one per fold step,
so removing any step drops its id from the set, and an identity fold empties
the set entirely.

Ten mutations were run against the final version and all ten go red. The last
one found a real hole: weakening the field separator from `\n` to a space was
still green, because the fold collapses whitespace and the span query was glued
with no space in it. A spaced variant closes it.


### What review caught, and one thing my own mutation test did

**The screen opened on yesterday.** `viewDay` was a `Date` captured at mount and
refreshed by nothing, while `now` re-reads on focus and on AppState. Leaving the
app on Today overnight therefore reopened it in *past mode* — yesterday in the
switcher, plans dimmed and marked "Not logged" — with the athlete having
navigated nowhere. It is a day **offset** now, derived from `now`, so every
refresh re-derives it and the class is gone rather than patched at the two
places that happened to refresh.

**A blanket `opacity: 0.55` on the past card** composited every ink inside it:
"Not logged" fell to 1.96:1 and the BJJ eyebrow to 2.51:1 — the latter being the
exact figure the palette cites as its reason for banning `textDim` from a done
row, and failing specifically for this app's headline discipline. The card is
not dimmed at all now; "Not logged" is `warn` at full strength, which is also
what it means.

And one that arrived from my own mutation testing rather than from review: the
first fix for the outside-the-week bug passed *two* plan lists and matched their
union. Three mutations of it stayed green, which is how it came out that the
wider list was **inert** — `matchPlans` groups by day, so plans on other days
can never compete for this day's sessions, and plans on the same day are the
same rows. A parameter that cannot change the answer reads as a safeguard and is
scenery. `owedOn(sessions, dayPlans)` is what was ever needed.

### Gaps this leaves

- **Misspellings still miss.** "sao paolo" — which is how the request was
  actually written — finds nothing, because folding is not fuzzy matching.
  The honest fix is an alias, not a distance metric: aliases already exist for
  exactly this and are how "scarf hold" finds "Kesa-Gatame".
- **The web copy has no test and nothing enforces it matches mobile's.**
  `apps/web` has no test runner at all and `verify` runs `test:mobile` only, so
  the only guard against the two copies drifting is a comment in each saying
  "change one, change the other". Deliberate for now — a cross-app import from
  a jest-expo suite into a `"use client"` Next module is uglier than the risk,
  and the position vocabulary is already duplicated four ways on the same
  terms — but it is the weak point of this shape, and it is where the next bug
  of this kind will live.
- **The exercise catalog's search still folds nothing.** Both library screens
  compute `query.trim().toLowerCase()` for exercises and hand the raw query to
  `searchTechniques`, so one input box now has two matching rules. No live
  defect: 0 of 504 exercise names contain a non-ASCII character. It becomes one
  the first time a seeded exercise does, and the backend's own exercise search
  presumably folds nothing either.
- **Not verified on a device.** The unit tests run against the real shipped
  `techniques.json`, and the Hermes check was made against the installed
  binary, but nobody has typed "sao paulo" into the app.
- **`positions.json` and the technique names still disagree** about how
  "North-South" is punctuated. Folding makes that invisible to search, which
  is the point, but the underlying data is still inconsistent and anything that
  joins on the literal string — a future import, a report — will trip on it.


## 2026-08-03 — A shared UI kit for mobile, and the line between borrowing a look and borrowing a metric

Prompted by four screenshots of a competitor training app the user liked the
look of. The ask was explicitly provisional — "something that looks good while
I test what we build" — so this is a visual pass, not a redesign.

### What was taken, and what deliberately wasn't

The reference's *anatomy* transfers: a week strip across the top, figures with
their units set smaller than their digits, grouped rows with an icon and a
right-aligned value, activity rows carrying a state rule and icon'd measures.
All of it is layout and typography, and all of it works over data VOLA
already has.

Its *metrics* do not, and that is the whole line. HybridCharge, VO₂ max, HRV,
sleep duration, skin temperature, calories, BPM, badges — VOLA collects none
of them, and the web dashboard's own comment already refuses placeholder
dials on the grounds that the home screen must never lie. Worth noting the
reference agrees: its own core-metrics card renders `--` for the figures the
device didn't capture. The honest pattern and the good-looking pattern were
never actually in tension.

### The kit

`components/ui/` — `Icon`, `WeekStrip`, `Stat`/`StatValue`/`StatRow`,
`SessionCard`, `SectionHeader`. Two decisions in it are load-bearing:

**Icons are drawn from views, not SVG.** `Belt.tsx` already made this call and
the reasoning holds: `react-native-svg` is a native dependency, so adding it
costs a prebuild and a fresh device build for everyone. The geometry comes
from `assets/brand/icons/*.svg` — `barbell` is a literal transcription of
`workout.svg`, which is five straight strokes and nothing else.

**`StatValue` splits on digit runs with a regex** rather than changing the
formatters. `formatDuration`, `formatVolume` and `formatElapsed` each have
their own rounding rules and callers elsewhere; reshaping three lib functions
into a display type to save one regex would put presentation concerns where
they don't belong. It also means the Today screen's third stat — chosen at
runtime from what the athlete actually logged — needs no branch to render.

### Today, rebuilt on it

The week strip is **not interactive**, deliberately: the reference uses its
strip as a day picker, and VOLA has no per-day screen to pick into. Day cells
that highlight and then do nothing are worse than cells that never offered.
Trained days get a dot, not a fill — lime means "act here" in this app and
there is only one day you can act on.

The strip's lit days and the stat row's count come from **one pass over one
list** (`summariseWeek` now returns `dayKeys`, not a count). Five lit cells
above a card reading "4 days" is the kind of quiet contradiction that costs
more trust than either number earns.

The third stat now follows the data rather than the toggles — volume when
there is tonnage, time when there isn't. That is the registry's own rule and
the web dashboard's `loadMetric` already did it; it also closes half of the
"a BJJ-only athlete sees strength-shaped zeroes" gap listed below, for the
Today screen at least. Session cards omit a measure rather than zeroing it,
for the same reason `describeSession` does.

### Two things found by running it

**The tick was a chevron.** Drawn with `borderLeft` + `−45°`, both arms come
out pointing upward — a symmetrical V, which inside a filled circle reads as
a disclosure control on a card that doesn't expand. It is `borderBottom` +
`borderRight` + `+45°`; the asymmetry *is* the glyph. Typecheck, lint and 241
tests were all green with it wrong, which is the argument for looking at the
screen.

**Expo Go auto-upgraded itself and segfaulted the app.** See the CLAUDE.md
gotcha added alongside this entry — it is environmental, predates this work
(confirmed by reproducing it on a clean tree), and costs the whole session if
misread as your own bug.

### Still open

Only Today and the You tab's tiles use the kit. Plan and Library still carry
their own styles, and `apps/web` is untouched — it remains on its
pre-design-system look. The mobile app also still has no `react-native-svg`,
so any future icon has to be straight rules, a circle, or a rotated corner.

## 2026-08-04 — The app learns what you intend to do, not just what you did

Same session as the entry above, continuing from the user's reaction to it:
the two full-width filled buttons at the top of Today ("Start Strength", then
"BJJ") read as shouting, and the screen should lead with *the session you
planned* instead.

That is a bigger change than it sounds, because the app had no notion of a
plan at all. It could record what happened and had no way to say what was
meant to happen — so the only thing Today could offer was a menu.

### The real logo lands

`assets/brand/logos/source/` now holds the designed kit (a faceted tick in
`#D0E950` / `#9CC740` / `#71912F`, plus horizontal and stacked lockups, mono
and colour). The header's hand-drawn stand-in — "VOL" plus a chevron built
from two rotated rules, with arithmetic in `ScreenHeader` to make them mitre —
is gone; the mark sits before a plain "VOLA" wordmark, which is how the logo
is actually drawn. A PNG, because unlike `Belt` and `ui/Icon` this one is
overlapping filled polygons and genuinely cannot be drawn from views. It is
exported from the SVG by a documented trim-and-square step, so it is
regenerable rather than hand-cropped.

### `planned_sessions`, and its one honest caveat

A local SQLite table (schema v14) holding `(day, sport, workout_id?)`. Three
decisions worth keeping:

- **`day` is a `YYYY-MM-DD` local date, not a timestamp.** "Tuesday's session"
  is a claim about the athlete's calendar; an instant slides across a day
  boundary when they travel. The format is also what lets the range query use
  string `>=` / `<=`.
- **`workout_id` is nullable.** "Tuesday is BJJ" is a complete plan, and the
  mat sessions this app is built around have no template at all. `sport` is
  the required half.
- **No foreign key to `workout_cache`.** That cache is refilled from the
  server and its rows come and go; a constraint would delete the plan whenever
  it was rebuilt. A plan whose template is missing degrades to its discipline.

**The caveat: this is local-only, with no server table behind it.** Every
other table in `db.ts` is an outbox for something the API owns. This one is
not, so a plan made on the phone does not reach the web app — and the
platform rule puts authoring on web. It was built this way because the
alternative was leaving Today unable to say anything about the day; a `plans`
module is the real answer and is the blocker for the web half (below).

### Today, and the calendar behind it

Today now leads with the planned session and a single lime **Start**;
`+ Start something` is outlined, quiet, and always present, opening a
`PickSessionSheet` that both Today and the Plan tab share. Starting a planned
day passes `?workout=` to `/session/start`, which auto-begins it — the plan
already named the template, so re-asking would make it a chooser again. It
falls through to the normal chooser when the id matches nothing, which is
reachable precisely because there is no foreign key.

`TrainingCalendar` replaced the flat week strip with three states, cheapest
first: collapsed (seven cells, dots), expanded (the week as a day list), and a
month sheet behind the month name (grid, legend, month totals, and the tapped
day's detail). The escalation is the point — a month grid pinned to Today
would push the thing you came to do below the fold to answer a question you
ask once a week.

**Two dot colours, two different facts**: green for a session that happened,
lime for one that is planned; where a day has both, what happened wins. And
the month sheet **loads its own 200-row window** rather than colouring the
Today screen's list, which is capped at 30 — a grid decorated from a truncated
list would claim rest days that were trained.

### Two bugs, both found by looking at the screen

**The tick was a chevron** — see the entry above; typecheck, lint and 241
tests were green with it wrong.

**`no such table: planned_sessions`, with the version already stamped at 14.**
Fast Refresh re-evaluates a changed module, which resets `db.ts`'s memoised
`dbPromise` and re-runs `migrate()`. It did so on an intermediate save — after
`SCHEMA_VERSION` was bumped, before the `CREATE` was written — so the device
stamped v14 with no table and every Add tapped into a SQL error. A shipped
build cannot split those two edits, so this is a dev artifact rather than a
release risk; the fix on a device is to reset `user_version` and relaunch.
`schema.test.ts` now covers the v13→v14 upgrade branch specifically, which is
the assertion that would have caught it.

### Still open — and what web is blocked on

**Web planning needs a backend `plans` module first.** The user asked for "a
more defined calendar and planning" on web, and it cannot be built honestly
against a table that lives in one phone's SQLite. The module is also the right
place for the questions this local version dodged: whether a plan may recur,
whether it belongs to a block or programme, and what happens to a plan when
the session that fulfils it is logged (today: nothing — a plan is an intention
and is never reconciled, so a day can be trained twice and a plan can be
ignored, which is deliberate but is a decision the server should ratify).

Also open: the plan has no conflict story on a second device; the Plan tab's
week is rows rather than a grid (a 45pt column cannot hold "Maestro Push Day");
and past days are read-only in the planner, so you cannot backfill an
intention you failed to record.

## 2026-08-04 — Plans become a real resource, and web gets the calendar

The follow-up the previous entry named as blocked. The phone's local
`planned_sessions` proved the interaction was right; this gives it a server so
the web app can see it and so planning stops being one device's private notes.

### The shape, and the one decision everything else follows from

`plans` is `(id, user_id, day, sport, workout_id?, notes)` — migration 000033,
served at `/v1/plans` with list-by-range, create, patch and delete.

**`day` is a DATE, not a timestamptz.** `sessions.started_at` is correctly a
timestamp because it records a moment that occurred; a plan records a square on
a calendar. Store it as an instant and "Tuesday's session" moves to Monday the
first time the athlete flies east. This propagates all the way out: the Go
type is a `string`, the projection is `to_char(day, 'YYYY-MM-DD')` rather than
a scan into `time.Time`, the wire format is `YYYY-MM-DD`, and a timestamp sent
to the API is **rejected rather than truncated**. Every one of those
conversions was a chance to move the plan by a day, so none of them happen.

**A plan is never reconciled against a session.** No `fulfilled_by`, no status
column. "Does this session count as that plan" has no statable rule — same
sport? same template? same day? — and inventing one would silently rewrite the
athlete's own record of what they meant to do. A planned day can be trained
twice, ignored, or trained with something else, and all three are ordinary.
Adherence is therefore a *comparison the reader makes*, and later a query, not
a status the write path has to keep true.

Consequences worth stating: no unique constraint on `(user_id, day)`, because
two-a-days are normal; `workout_id` is nullable, because "Tuesday is BJJ" is a
complete plan and mat sessions have no template; and the FK is `ON DELETE SET
NULL`, so deleting a template leaves the day planned as its discipline rather
than erasing it.

### API details that are easy to get wrong

`from`/`to` are **required and inclusive**. Not defaulted to "this week": a
default makes the commonest client bug — forgetting the range — look like an
empty calendar rather than a mistake, and the response cannot tell them apart.
The range is capped at 400 days so a caller cannot ask for a decade.

`workout_id` on PATCH is **three-state**, and needs a double pointer in Go
(`**string`) plus a `CASE WHEN $5` in the UPDATE rather than a bare COALESCE.
Absent means leave it, a value sets it, an explicit `null` clears it. With a
single pointer the last two collapse and "clear the template" silently does
nothing.

Every single-row operation is scoped by `user_id`, not just `id`, and a plan
belonging to someone else returns **404 rather than 403** — ids are
client-generated and guessable, so another user's plan must be
indistinguishable from one that does not exist. This is the IDOR the reviewers
have caught twice before in other modules; here it is covered by a test that
asserts Get, Update and Delete all refuse across users *and* that the row is
untouched afterwards.

### Web: the calendar

`/dashboard/calendar`, second in the rail — after Today, before Workouts,
because planning the week is the step between seeing today and editing a
template.

A month grid with the two layers side by side: green chips for what was
trained (from `/sessions/history`, the same per-day rollup the heatmap
already uses — no new endpoint) and lime for what is planned. Two panes, matching
the workout builder: the grid keeps its shape while the selected day's detail
and its planning form sit beside it, because a dialog over the grid would hide
the thing you are planning against.

Two smaller notes. The **spill days** that square off the first and last weeks
are dimmed, not blanked — a hole in the corner of a grid reads as a rendering
fault. And the sport/template selects are **derived, not stored-then-corrected
by an effect**: the effect version rendered a stale template for one frame when
the discipline changed, which is exactly what `react-hooks/set-state-in-effect`
exists to catch, and it did.

### What was verified, and what was not

Verified: 10 integration tests against real Postgres (range inclusivity,
cross-user refusal on all three single-row ops, the three-state workout clear,
`ON DELETE SET NULL`, duplicate-id conflict, two-a-days keeping insertion
order, and that the Postgres constraint name never reaches the client). The up
and down migrations both run. The three routes are wired and 401 without a
token. `monthGrid` was checked against real calendar boundaries — a month that
fits exactly four rows, one that needs six, a leap day, and normalisation from
any day in the month.

**Not verified: the calendar's interactive flow in a browser.** `/dashboard`
is Clerk-gated and signing in needs credentials, so the furthest an automated
check gets is the redirect to Clerk — which does at least prove the route
exists and is protected. Build, typecheck and lint are green. Someone should
click through it once while signed in before this is trusted.

Also worth knowing for anyone running migrations locally: the dev `vola` and
`vola_test` databases are both stamped at **version 32**, ahead of this
branch's 29, from some newer branch whose files are not here. `migrate up`
therefore fails on them. This work was verified against a throwaway database
rather than by forcing their version backwards.

### Still open

Mobile still writes plans to its own local SQLite and does **not** yet talk to
`/v1/plans` — so a plan made on the phone still does not reach web, and vice
versa. Pointing `lib/plan.ts` at the API (through the existing outbox, with
the `synced` flag the local table was designed to grow) is the next step and is
what actually closes the loop.

Beyond that: no recurrence, no notion of a block or programme, no conflict
resolution across devices, and adherence is still only a comparison a human
makes rather than a query anything computes.

## 2026-08-04 — The plan loop closes: mobile joins the outbox

`lib/plan.ts` now talks to `/v1/plans` through the same outbox every other
local table uses. Schema v15 adds `notes`, `updated_at`, `dirty`, `remote`,
`deleted_at` and `last_error` to `planned_sessions`, and `syncPlans` does a
push-then-pull reconciliation alongside `syncSessions`.

### The defaults on the upgrade are the interesting part

v14 shipped the table local-only, so every plan an early adopter made has
never been sent anywhere. The v15 ALTERs therefore default `dirty = 1,
remote = 0` — **the opposite of the workout_cache v9 ALTERs**, which default
`0 / 1` because those rows came *from* the server. Getting it backwards would
strand every existing plan with nothing to push it, silently. There is a
schema test on a v14-shaped table specifically, because on a fresh install
these columns come from `CREATE TABLE` and the ALTER defaults are never
exercised at all.

### Ordering, and why plans go second

The orchestrator runs `syncSessions` first, then `syncPlans`. `syncSessions`
is what pushes dirty workouts, and `plans.workout_id` is a real FK
server-side — so a plan whose template has not landed is refused with a 4xx,
which classifies as `permanent` and would make the orchestrator give up on a
plan that is perfectly fine. Running second means `unsyncedWorkoutIDs` is
accurate when the plan push reads it to decide what to **defer** (held back,
not counted as failed — the same distinction sessions already draw).

A tombstone is never deferred by its template: deleting a plan does not depend
on its workout existing, and holding the delete back would keep the plan on
screen, and on the server, until an unrelated template synced.

### One bug the tests caught, and two that mutation testing caught

**The sweep deleted rows it had just pushed.** The pull ends by deleting
local rows the server no longer lists — otherwise a plan removed on the web
stays on the phone forever. But "not in the response" was also true of a row
this very run had just created, whenever the list did not echo it back. The
row vanished from under the athlete seconds after they planned it. Fixed by
excluding ids pushed this run: our own write is newer information than any
list we fetch.

Then, running mutations over each pull guard, **two tests passed for the wrong
reason** — the exact failure mode `apps/mobile/lib/__tests__` was created to
stop:

- the "never overwrites a local edit" test was actually being saved by the
  *refuse-to-go-backwards* check, because the server snapshot's `updated_at`
  was in the past. It now uses a future timestamp, so only the dirty guard can
  save it.
- the "tombstone is not resurrected" test was being saved by the dirty guard,
  because every tombstone this module writes is also dirty. There is now a
  second test that forces a *clean* tombstone and asserts the row is left
  **entirely untouched** — the guard's only unique effect, since the upsert
  does not clear `deleted_at` and visibility alone cannot distinguish them.

All four pull guards (buried, dirty, backwards, just-pushed) are now
individually mutation-verified: delete any one and exactly one test goes red.

### Verified over real HTTP, and what is not

Against a locally-run API on a real Postgres: the v15 migration applied on a
real device with the correct `dirty = 1, remote = 0` defaults; `GET /v1/plans`
returned 200 authenticated; and `POST /v1/plans` correctly returned 400 for a
genuine FK violation, which the device classified as **permanent** and wrote
to the row's `last_error`. That last one matters more than it looks: it
exercises the whole push → error → classify → record chain over real HTTP, and
it is the exact path that was dead code in `lib/workouts.ts` for a while
because that module threw plain `Error`s instead of `ApiError`s.

**Not verified on-device: a successful create landing a row in Postgres.**
Expo Go kept crashing on launch (the `react-native-worklets` version skew
already documented in CLAUDE.md), and the blocker is that environment rather
than this code. Everything about the success path is covered by the 23 sync
tests. It is worth one manual pass once the Expo Go/SDK versions are aligned.

Note also that `apps/mobile/.env.local` points at **staging**, which does not
have migration 000033 yet — so the plan sync will 404/400 there until the
backend is deployed. Nothing on the phone will work against staging until it
is.

### Still open

No conflict resolution beyond last-write-wins on `updated_at`. The pull window
is fixed (45 days back, 120 forward), so a plan made a year out syncs but is
not pulled back on a fresh install. Blocked plans are recorded on the row but
`blockedRows()` — the repair screen — still only reads sessions and workouts,
so a permanently-refused plan has nowhere to be surfaced yet.

## 2026-08-04 — What `/pre-merge` caught on the plans work

Seven blocking findings across the two reviewers, on a change whose check
suite was entirely green. Recorded because the pattern is the argument for the
gate: none of these were compile errors, and none of the 279 tests noticed.

### The security one, for the third time

`plan.Create`/`Update` passed `workout_id` straight through, guarded only by
the bare foreign key. So a caller could reference **any** workout id — the two
outcomes are distinguishable (a visible id inserts and returns 201, an unknown
one trips the FK and returns 400), which makes the endpoint an enumeration
oracle for other people's private templates, with the plan row then persisting
a pointer into their data.

`session.assertWorkoutUsable` exists precisely for this and its comment says
the bug "came back through a different door". This was a third door. Ported
verbatim, plus the sport-agreement check it also carries, and
`TestCannotReferenceAnotherUsersPrivateWorkout` now asserts the two errors are
byte-identical — the property that actually matters.

### `**string` cannot express three states

The whole `workout_id` three-state design rested on a comment claiming
`encoding/json` leaves an absent field nil and sets an explicit `null` to a
non-nil pointer holding nil. **It does not.** For a settable pointer field the
decoder calls `SetZero()` on a literal null, so `{}` and `{"workout_id":null}`
are identical and "clear the template" was a silent no-op.

Replaced with `OptionalWorkoutID`, a named type whose `UnmarshalJSON` observes
the difference — the documented hook, since `encoding/json` calls Unmarshaler
*including* for JSON null.

The test that was supposed to prove this built the `PlanUpdate` struct
directly, bypassing the decoder entirely. It proved the SQL and could not fail.
It now decodes from a request body, and there is a table test over all four
input shapes.

### A CHECK that undid migration 000021

`plans` carried `CHECK (sport IN (...))` with a comment saying it mirrored
`sessions_sport_valid` — a constraint dropped in 000021 precisely because a
CHECK listing the values *is* the per-discipline migration cost the registry
exists to remove. The existing tripwire could not catch it: it only writes
sessions and workouts. Constraint dropped, and the tripwire extended with a
plan half.

### Four data-loss defects in the mobile outbox

- **`unplanSession` hard-deleted when `remote = 0`**, which is racy: `remote`
  is only set once the create *resolves*, so a delete landing mid-flight left
  no tombstone, and the pull in the same run re-inserted the plan the athlete
  had just removed. Now always tombstones; the hard delete lives in `pushRow`,
  inside the serialised sync, which is the only place the question can be
  answered.
- **The sweep computed its window separately from the fetch.** Two
  `new Date()` calls: cross local midnight between them and the sweep deletes
  on a day the server was never asked about.
- **The sweep trusted whoever the response belonged to.** `getToken` follows
  the *current* Clerk user while the run holds the one it started with, and
  `setSyncIdentity` does not abort a run in flight — so an account switch
  mid-run would adopt user B's plans into user A's account *and* delete all of
  A's real ones as "missing". The guard now covers the whole reconciliation,
  not just the sweep; that widening was itself found by the test written for
  the narrow version.
- **`TrainingCalendar` froze its session pool.** `monthSessions` was loaded
  once per sheet opening and then permanently shadowed the live `sessions`
  prop, so paging back reported *zero sessions for a month that was trained* —
  a fabricated zero — and a session finished after opening the sheet never lit
  its dot. Now merged with the caller's list (caller wins) and re-read when the
  anchor moves.

### Two more the fixes' own tests then found

Writing the race test surfaced that **a successful delete removes the
tombstone**, so a lagging server list would re-insert the plan; the pull now
consults `pushedThisRun` for deletes as well as creates.

And the push's compare-and-swap could match a row that had become a tombstone
mid-push — `updated_at` is millisecond ISO text, so a delete in the same
millisecond produces an identical string. The CAS cleared `dirty` on the
tombstone, so the delete was never pushed: gone from the phone, alive on the
server, `pending` reading zero so nothing retried. Fixed with
`AND deleted_at IS NULL`.

### Smaller, taken

`errorKind` was merged across the two outboxes with `??` rather than the
precedence both modules define, so a permanently-refused session suppressed the
retry ladder for a plan that failed on a retryable 5xx. Timestamps were
compared as strings across two formatters that disagree about trailing
fraction zeros. Notes were length-checked in bytes against a `char_length`
constraint. `List` was bounded by days but not rows, and its `ORDER BY` had no
total order. Bodies were unbounded. `DROP TABLE` had no `IF EXISTS`. One
integration test left a workout behind on failure, so the suite only passed
once — now `t.Cleanup`ed and verified with `-count=2`.

### On mutation testing

Every guard in the sync path was re-checked by deleting it and confirming
exactly one test goes red. That exposed three tests passing for the wrong
reason — each masked by a neighbouring guard — which were rewritten to assert
`result.pulled` (the thing only that guard controls) rather than the row's
contents. One guard, the UPSERT's own `WHERE`, is honestly documented as *not*
mutation-pinned: it backstops an interleaving the harness cannot orchestrate.

## 2026-08-04 — The app writes its own name on open

The splash was a placeholder nobody had drawn for VOLA: a gradient tick, on a
navy that was not even the app's navy. `#0B1220` against a `#080B12` ground, so
the first screen stepped a shade darker the moment it mounted — the kind of seam
that reads as *wrong* without anyone being able to name it. It is now the real
wordmark, and it arrives one letter at a time.

### The wordmark had to be extracted before it could be used

The brand kit ships lockups, not a wordmark. `vola-stacked-color.svg` is mark
plus "VOLA" plus tagline, and no file contained only the name. The four
letterforms are their own `<g>` in the Corel export, so the wordmark is that
group lifted out and re-cropped to the letters' true bounding box — **bezier
extrema included, not just anchor points**, or the crop is short wherever a
curve bulges past its control points.

Two traps on the way out, both silent. The root sets `fill-rule: evenodd` but
the letter class overrides it to `nonzero`; take the root's value and the O
loses its counter. And the wordmark is white, so on its own it is invisible
against every default background a preview will composite it against — which
is why there is a black variant beside it in `assets/brand/logos/source/` that
nothing in the app uses.

### The native splash carries no image, and that is the whole trick

A native splash cannot animate. The OS shows it before any JS exists, so
whatever it draws is a *finished frame*. Put the wordmark on it and the launch
reads as logo → blank → logo being written, which is worse than either half
alone. So `app.json` now configures nothing but `backgroundColor` (the plugin
handles a missing `image` explicitly — it removes the imageset and returns), and
`AnimatedSplash` opens on that same bare `#080B12` field. The handover has
nothing to give it away whichever frame it lands on; `SplashScreen.setOptions({
fade: true })` is belt and braces over an already-invisible join.

This does undo, deliberately, the thing that was asked for first — a static
wordmark splash. It is one four-line revert in `app.json` if the writing ever
stops being worth it.

### Wiped, not stroked

"Writes letter by letter" suggests a pen travelling down each glyph. There is no
pen available: the wordmark is a set of **filled outlines**, and a filled
outline has no centreline to travel down. The honest alternatives were tracing
each glyph's *perimeter* with `strokeDashoffset` — which needs `react-native-svg`
this app deliberately does not have (see `ScreenHeader`'s `Mark()` and
`ui/Icon.tsx`), and which outlines the O's counter too — or uncovering each
letter left-to-right. It uncovers: a rectangle in the background colour shrinks
onto its own right edge. On a solid ground the rectangle does not exist, and the
letter simply appears to have been written.

The four curtains are cut at the **midpoint of each gap**, not at the glyph
edges, so they tile the strip with no seam. Cut on the edges instead and every
join is a place a half-pixel of rounding shows the next letter arriving early.

### Nothing animates that the JS thread has to compute

Every animated property is `opacity` or `transform`, which is what lets all of
it run with `useNativeDriver`. This is not a micro-optimisation: the obvious way
to write a wipe is to animate the covering view's `width`, `width` cannot use
the native driver, and a JS-driven animation stutters exactly when the JS thread
is busy — during fonts, Clerk, and the SQLite migrations, i.e. during precisely
the launch the splash exists to cover.

Everything positional is a ratio measured off `vola-stacked-color.svg` in its
own coordinate space rather than eyeballed, so the finished frame *is* the
stacked lockup minus its tagline, and a re-export moves the splash instead of
leaving it drifting from the brand.

### It holds rather than lifting onto a blank screen

`RootLayoutNav` used to `return null` until Clerk resolved. The splash now
covers that gap and — this is the load-bearing part — takes a `ready` prop and
waits for it. An animation that simply plays and exits would fade onto the blank
screen it replaced, on exactly the slow cold starts where it matters. With
Reduce Motion on, the assembled lockup and the fade still happen; only the
assembly is skipped. Reduce Motion is a request not to be moved, not a request
to be shown nothing.

### What Expo Go can and cannot show you

`npx expo config --type public --json` reports **no `splash` key at all** —
since SDK 54 the `expo-splash-screen` plugin writes native launch assets at
prebuild and puts nothing in the manifest, and Expo Go renders from the
manifest. So the native half of this is invisible in Expo Go and only appears in
a dev or EAS build. The JS half plays everywhere, which is what made it
verifiable at all.

Verified by relaunching (`xcrun simctl openurl <udid> "exp://127.0.0.1:8081/--/"`)
and taking back-to-back `simctl io screenshot` frames, then classifying them by
pixel signature to find the ones that matter. Captured frames show V-O-L-A
uncovering in order, the mark landing above the finished wordmark, and the fade
into Today. Worth reusing: a ~1.7s animation is not catchable by taking one
screenshot and hoping.

### What review caught, and one thing my own mutation test did

**The screen opened on yesterday.** `viewDay` was a `Date` captured at mount and
refreshed by nothing, while `now` re-reads on focus and on AppState. Leaving the
app on Today overnight therefore reopened it in *past mode* — yesterday in the
switcher, plans dimmed and marked "Not logged" — with the athlete having
navigated nowhere. It is a day **offset** now, derived from `now`, so every
refresh re-derives it and the class is gone rather than patched at the two
places that happened to refresh.

**A blanket `opacity: 0.55` on the past card** composited every ink inside it:
"Not logged" fell to 1.96:1 and the BJJ eyebrow to 2.51:1 — the latter being the
exact figure the palette cites as its reason for banning `textDim` from a done
row, and failing specifically for this app's headline discipline. The card is
not dimmed at all now; "Not logged" is `warn` at full strength, which is also
what it means.

And one that arrived from my own mutation testing rather than from review: the
first fix for the outside-the-week bug passed *two* plan lists and matched their
union. Three mutations of it stayed green, which is how it came out that the
wider list was **inert** — `matchPlans` groups by day, so plans on other days
can never compete for this day's sessions, and plans on the same day are the
same rows. A parameter that cannot change the answer reads as a safeguard and is
scenery. `owedOn(sessions, dayPlans)` is what was ever needed.

### Gaps this leaves

`vola-mark.png` was regenerated at 1024px from the brand source — same
squared-and-centred convention `ScreenHeader` already relies on, and an aspect
within 0.05% of the artwork rather than 1.4% off — so the header got sharper as
a side effect nobody asked for. `splash-icon.png` is now referenced by nothing
and was left in place rather than deleted.

## 2026-08-04 — The tick becomes the icon, and the header stops impersonating the wordmark

Two complaints from the phone, one cause. The home-screen icon was not the
logo, and the in-app header was not the wordmark. Both had stand-ins that had
outlived the reason they existed.

### The icon was a placeholder all the way down

`icon.png` was a rounded-stroke checkmark on a `#42F58D`→`#B8FF2C` gradient —
drawn before the real artwork arrived and never replaced. The important part is
that **the masters were placeholders too**: `assets/brand/app-icons/*.svg` drew
the same stand-in tick, so the repo's own "edit the SVG and regenerate" rule
would faithfully have reproduced the wrong logo. Regenerating the PNGs was
never the fix on its own; the masters had to be rebuilt on the real mark first.
Worth remembering the next time a raster looks stale — check whether its source
is stale too, or the regeneration just launders the mistake.

Three things the rebuild had to get right:

**The iOS icon is full-bleed and opaque.** The old dark master drew a rounded
rect inset 16px with `rx="220"`, which is a preview affordance, not an icon:
iOS applies its own corner mask, and a 1024 PNG with transparent corners is an
App Store rejection. It is now a flat square with no alpha anywhere.

**The Android foreground is held to 458px on a 1024 canvas, and the first
answer was 560px and wrong.** Adaptive icons get cropped to whatever shape the
launcher likes, and the guaranteed-visible region is a 66dp **circle** — radius
312.9px on this canvas — not a square. 560px was sized against the square,
justified on the reasoning that a tick's bounding-box corners are empty so the
overhang has nothing in it. That is exactly backwards for this shape: the
tick's longest arm *ends* at its own bbox's top-right corner, so the corner
that overhangs is the fullest point on the mark, not the emptiest. Measured, it
put the tip 376px from centre, and a circular mask amputated it.

Review caught it by rendering the committed PNG under circle, squircle and
square masks rather than reading the SVG — which is the lesson worth keeping.
The masters were right about what they were drawing; the claim that failed was
a geometric one about the *result*, and only the result could disprove it.
458px lands the tip at 307.3px, inside the circle with a few pixels to spare so
an antialiased edge is not resting on the guarantee.

**The monochrome layer collapses to one silhouette.** The mark is three
overlapping polygons in three greens; drawn in a single flat colour they abut
into one shape, so the themed-icon layer is the same geometry with the fills
replaced rather than a separately drawn silhouette.

### The header wordmark was typed, not drawn

The header set the tick followed by "VOLA" in the system font at weight 800
with 3pt of tracking. That is not a smaller version of the logo — it is a
different logo. The real letterforms disagree with the typed ones on the two
most recognisable glyphs: the A is a bare apex with no crossbar, and the O is a
rounded rectangle rather than an ellipse. Set beside the actual mark, the
impersonation was the thing making the header look heavy.

It is now `vola-wordmark.png` at 88pt, and the tick is gone from the header
entirely. Both halves of that were the ask, and they reinforce: once the
letters are the real ones, the header no longer needs a glyph sitting beside
them to say what the brand is. 88 is where the wordmark carries the same weight
as the screen title opposite it; the height is the artwork's own 14030:1759
ratio rather than a rounded number, because any other box shape letterboxes
under `contain` and quietly shrinks the letters inside their own footprint.

The tick keeps the two jobs it earns: the app icon, and the landing beat of
`AnimatedSplash`.

### What review caught, and one thing my own mutation test did

**The screen opened on yesterday.** `viewDay` was a `Date` captured at mount and
refreshed by nothing, while `now` re-reads on focus and on AppState. Leaving the
app on Today overnight therefore reopened it in *past mode* — yesterday in the
switcher, plans dimmed and marked "Not logged" — with the athlete having
navigated nowhere. It is a day **offset** now, derived from `now`, so every
refresh re-derives it and the class is gone rather than patched at the two
places that happened to refresh.

**A blanket `opacity: 0.55` on the past card** composited every ink inside it:
"Not logged" fell to 1.96:1 and the BJJ eyebrow to 2.51:1 — the latter being the
exact figure the palette cites as its reason for banning `textDim` from a done
row, and failing specifically for this app's headline discipline. The card is
not dimmed at all now; "Not logged" is `warn` at full strength, which is also
what it means.

And one that arrived from my own mutation testing rather than from review: the
first fix for the outside-the-week bug passed *two* plan lists and matched their
union. Three mutations of it stayed green, which is how it came out that the
wider list was **inert** — `matchPlans` groups by day, so plans on other days
can never compete for this day's sessions, and plans on the same day are the
same rows. A parameter that cannot change the answer reads as a safeguard and is
scenery. `owedOn(sessions, dayPlans)` is what was ever needed.

### Gaps

**None of this is verifiable in Expo Go.** App icons are native — Expo Go shows
Expo Go's icon, whatever the project config says — so the icon half needs a real
build (`expo run:ios --device`) to see at all, which is also how it was
reported. The header half is ordinary JS and shows up on a reload.

`apps/mobile/assets/images/splash-icon.png` is **deleted** here rather than
left orphaned as the previous entry left it. It was the placeholder tick, it
was referenced by nothing, and this change's whole thesis is that a stale
placeholder in the tree is how the wrong logo ships — leaving one behind while
arguing that would have been funny in the wrong way.

`assets/brand/splash/vola-splash-dark.svg` and its light twin are the remaining
case: also unreferenced, also still drawing the placeholder tick. They are left
alone because a splash master implies a design decision about what the native
splash shows, and that decision is currently "nothing" — regenerating them
would be inventing an answer to a question nobody has asked yet.

## 2026-08-04 — The console that makes authoring real

`cmd/exportcontent` landed with nothing to carry: authoring a technique meant
`curl`. `apps/admin` now has `/content` — list, create, edit — so the loop that
started with "the pass we did today is not in the list" is finally end to end.

### One new endpoint, and why the public list could not serve this

`GET /v1/admin/techniques` returns admin-authored rows only. The console can
edit nothing else — `PATCH` refuses a seeded row, because the JSON owns those
and an edit would be reverted by the next deploy — so listing the whole catalog
would offer 466 rows of which a handful are actionable.

The public `GET /techniques` cannot answer it: `Summary` carries no `source`,
and adding one would put the string "seed" on 466 entries of every client's
catalog to serve one admin screen. `AdminAuthored` already existed on the
repository for the export, so it moved onto the `ContentRepository` interface
and both read it — one definition of "what the console owns" rather than two
queries that can disagree about which rows the export will carry.

### Ownership is membership of that list, not a field

The edit screen first read `technique.source !== "admin"` from the public
detail endpoint, which marked **everything** deploy-owned — including the row
the console had just written. `GET /techniques/{id}` does not select `source`,
and the contract does not promise it there. So ownership is decided by
membership of the authored list, which is the same definition the list screen
and the export use and cannot drift from either.

Three states, all reachable by typing a URL: in the list → the form; not in it
but real → the seeded explanation, naming the file to edit and the deploy to
run; 404 → not found. A seeded id gets an explanation rather than a form,
because a save button that always fails is worse than no save button.

### Category is the one place the console is stricter than the API

`ValidateFields` deliberately does not constrain `category` — the vocabulary is
still settling — but `derive_function` in the importer exits on anything outside
its nine. Before the console existed, authored content never reached the
importer. Now it does, so the field is a `<select>` of exactly those nine. This
closes the coupling recorded as a gap on the export entry: a technique filed as
"Guard Pass" seeds, renders and exports perfectly, then breaks the next
spreadsheet re-import long after anyone connects the two.

### What browser verification caught that nothing else would have

Three defects, all of which typechecked, linted and built clean:

1. **The response shape.** The public detail endpoint returns the technique at
   the top level; the admin write endpoints wrap theirs in `{"technique": …}`.
   Reading `.technique` from the former yields `undefined`, not an error, so the
   edit page rendered a 404 for an id that plainly exists. The type assertion
   was the lie, so the typechecker agreed with it.
2. **React 19 resets a form after its action completes.** A rejected save wiped
   all seventeen fields — the console told you the name was taken and threw away
   the paragraph of prose in the same render. The action now hands the
   submission back and the form re-seeds its defaults from it.
3. **Selects did not come back with the rest.** Text inputs pick up a changed
   `defaultValue` on re-render; a `<select>` does not, because React marks the
   matching option at mount. Every text field restored correctly while category,
   position and belt fell back to the placeholder — the half-restore is worse
   than none, because it looks like it worked. Each select now carries a `key`
   derived from its own value, so only an error render remounts it.

### Server actions are their own endpoints

`assertAdmin` runs inside both actions rather than relying on the layout above
them. A server action is a POST endpoint the router exposes independently of the
page it was declared beside: nothing about sitting in a gated route segment
protects it, and a caller who never loads the page can invoke it. The backend's
`RequireAdmin` is the real boundary and would reject them, but a write path
gated by coincidence is one refactor from being gated by nothing. The allowlist
moved to `lib/admin.ts` so `/users`, `/content` and the actions share it.

### What review caught, and one thing my own mutation test did

**The screen opened on yesterday.** `viewDay` was a `Date` captured at mount and
refreshed by nothing, while `now` re-reads on focus and on AppState. Leaving the
app on Today overnight therefore reopened it in *past mode* — yesterday in the
switcher, plans dimmed and marked "Not logged" — with the athlete having
navigated nowhere. It is a day **offset** now, derived from `now`, so every
refresh re-derives it and the class is gone rather than patched at the two
places that happened to refresh.

**A blanket `opacity: 0.55` on the past card** composited every ink inside it:
"Not logged" fell to 1.96:1 and the BJJ eyebrow to 2.51:1 — the latter being the
exact figure the palette cites as its reason for banning `textDim` from a done
row, and failing specifically for this app's headline discipline. The card is
not dimmed at all now; "Not logged" is `warn` at full strength, which is also
what it means.

And one that arrived from my own mutation testing rather than from review: the
first fix for the outside-the-week bug passed *two* plan lists and matched their
union. Three mutations of it stayed green, which is how it came out that the
wider list was **inert** — `matchPlans` groups by day, so plans on other days
can never compete for this day's sessions, and plans on the same day are the
same rows. A parameter that cannot change the answer reads as a safeguard and is
scenery. `owedOn(sessions, dayPlans)` is what was ever needed.

### Gaps this leaves

- **Exercises still have no write path.** They carry the `source` column and the
  seed guard, so the schema is ready, but there is no endpoint and therefore no
  screen. "Add a technique or exercise for any module" was the original ask;
  this is half of it.
- **No delete.** Authoring a technique with a typo in the name means a dead id
  that cannot be removed from the console, only edited. Deliberate for now —
  the id is a foreign key in training records, so deleting one is a data
  question, not a CRUD gap — but the answer is currently "ask a developer".
- **No confirmation that a name is nearly taken.** The console warns in prose to
  search first, and the API refuses an exact id collision, but "Knee Cut Pass"
  and "Knee-Cut Pass" slug identically while "Knee Cut Guard Pass" does not.
  Nothing surfaces the near-miss.
- **The form is unvalidated beyond `required` and the API.** A `setup_from`
  naming a technique that does not exist is accepted, and the graph edge simply
  points nowhere. The seeder validates those cross-references; this path does
  not reach that check until export.
- **Not verified against staging.** Everything here ran against local Postgres
  with a real Clerk session.

## 2026-08-04 — Green never got a light step, and a fix that measured worse than it looked

The calendar distinguished a day *trained* from a day *planned* by hue alone.
On a day that is both, and both the same discipline, the two chips rendered the
identical word — "BJJ" above "BJJ" — separated only by mint versus olive at 10%
opacity. Confirmed by looking at deployed staging, not inferred.

### The first fix was a fix in name only

Filled dot for trained, hollow ring for planned, solid border versus dashed.
It reads well and it does not work, because `--c-green` is `#42f58d` in **both**
themes — the only hue in `globals.css` without a light step, since until now it
was only ever drawn on the dark app where it measures 12.8:1. On white:

    green dot                 1.43:1
    green border at 40%       1.19:1
    lime border at 60%        1.95:1
    chip text                18.28:1

WCAG 1.4.11 wants 3:1 for a non-text graphic. So *both* new channels were
invisible for the trained state, and "solid versus dashed" was comparing an
invisible border against a faint one. `globals.css` already said so in its own
words — the brand green "is only legible as a fill against dark" — which is
the sort of note that only helps if you go and read it before shipping.

### What landed

- **`--c-green-ink`** (`#1f7a4a` light, `#42f58d` dark), the step lime already
  had. The hue itself is untouched: the palette notes record that darkening a
  hue directly collapsed the lime/danger separation for a protanope.
- **Web's marker is a text glyph**, ✓ and ○, in the ink colour — 5.95:1 light,
  6.85:1 dark, and greyscale-safe by construction because the two differ by
  shape rather than colour. Borders now draw at near-full alpha, because they
  need ≥70% (green-ink) and ≥95% (lime) to clear 3:1 at all.
- **Mobile keeps filled-versus-ring**, which genuinely works on the dark ground
  (12.8:1 and 15.1:1) — but the dot went 4pt → 8pt, because the *hole* is the
  signal and at 6/1.5 it was 3pt: fine in a screenshot, not at arm's length
  mid-workout. On mobile the shape carries 100% of the load, since the two
  markers are 1.18:1 apart in greyscale.
- **`aria-label` stopped erasing the cells.** It was the date alone, and
  `aria-label` replaces the accessible name rather than adding to it, so the
  chips were never announced. Both calendars now name both layers — and name
  them *independently*, because a ternary silently dropped "planned" on a
  both-day, which is the day a reader most needs told.

### Worth keeping

Two claims in comments were wrong in the same direction: that the border and
marker were channels "either of which is enough on its own", and that the dot
colours were the distinction. Both have been corrected to say what measurement
supports — the glyph (web) and the shape (mobile) are the channel; colour is
reinforcement. A comment that overstates a guarantee is an invitation to
delete the thing actually holding it up.

Not verified: the glyphs at 11px and the ring on a real Android device. Both
are computed, not observed.

## 2026-08-04 — The web app gets the real logo, and the horizontal lockup does not survive losing its tagline

`apps/mobile` got the real artwork earlier today; `apps/web` was still on
stand-ins. Its sidebar inlined a hand-drawn checkmark — two rounded stroke
segments on a `#42F58D`→`#B8FF2C` gradient — beside the string "VOLA" set in the
display font, and `src/app/icon.png` was that same placeholder tick. `public/`
still held the five Next.js starter SVGs (`next.svg`, `vercel.svg` and friends),
referenced by nothing.

### Inlined SVG, not two rasters, and the reason is light/dark

The brand needs a light-ground and a dark-ground treatment, and the obvious
shape is two image files plus a rule to pick one. Inlining the wordmark with
`fill="currentColor"` avoids that entirely: the letters take the ambient text
colour — measured `#10151F` on light and `#F3F6FA` on dark — with no query, no
second asset, and no rule to keep in sync. The mark keeps its own three greens:
it is a coloured object rather than an icon, and it reads on both grounds
unchanged.

**The first version of this entry justified that with a flash-of-wrong-logo
argument, and review disproved it.** The claim was that a two-file rule would be
wrong for one frame, because the theme is read from `localStorage`. It isn't:
`ThemeScript` is a *blocking inline script in `<head>`*, so `data-theme` is set
before the body is parsed, and a CSS rule keyed on it resolves before first
paint. The reviewer went further and rendered the SSR HTML with every `<script>`
stripped — both themes still paint correctly, which proves the colour resolution
involves no JS at all.

So the right reason to inline is the boring one: one asset instead of two, no
rule to get wrong, and the colours come from the theme's own tokens rather than
being baked into two files. Worth recording because the wrong reason was the
more persuasive-sounding one, and it would have justified this pattern in places
where it isn't warranted.

### The horizontal lockup was tried first and was wrong

This is the part worth keeping. The first attempt used
`vola-horizontal-color.svg`'s proportions — mark beside wordmark, all ratios
measured off the source rather than eyeballed, which felt like the careful
thing to do. It looked bad, and the user said so: the tick towered over the
letters.

The measurement was right and the conclusion was wrong. In that lockup the mark
is 4222 tall against a 1229-tall wordmark — 3.4× — and that is balanced **only
because a line of tagline text sits under the letters**, filling the vertical
space beside the tick. We drop the tagline everywhere. Remove it and those
proportions are holding up nothing, so the mark simply dwarfs a single line of
letters.

The stacked lockup carries the same size relationship without needing the
tagline, because the mark sits *above* the wordmark rather than beside it. So
web now assembles the same stacked lockup `AnimatedSplash` builds on mobile,
from the same ratios. **The general lesson: lifting proportions from artwork
carries an assumption about what else is in the frame.** Faithful ratios plus a
deleted element is not faithfulness.

### Also

`icon.png` and a new `apple-icon.png` are rendered from
`assets/brand/app-icons/vola-app-icon-dark-1024.svg` — the same master
`apps/mobile` uses, so the two apps cannot drift. The five starter SVGs are
deleted after confirming zero references.

### What review caught, and one thing my own mutation test did

**The screen opened on yesterday.** `viewDay` was a `Date` captured at mount and
refreshed by nothing, while `now` re-reads on focus and on AppState. Leaving the
app on Today overnight therefore reopened it in *past mode* — yesterday in the
switcher, plans dimmed and marked "Not logged" — with the athlete having
navigated nowhere. It is a day **offset** now, derived from `now`, so every
refresh re-derives it and the class is gone rather than patched at the two
places that happened to refresh.

**A blanket `opacity: 0.55` on the past card** composited every ink inside it:
"Not logged" fell to 1.96:1 and the BJJ eyebrow to 2.51:1 — the latter being the
exact figure the palette cites as its reason for banning `textDim` from a done
row, and failing specifically for this app's headline discipline. The card is
not dimmed at all now; "Not logged" is `warn` at full strength, which is also
what it means.

And one that arrived from my own mutation testing rather than from review: the
first fix for the outside-the-week bug passed *two* plan lists and matched their
union. Three mutations of it stayed green, which is how it came out that the
wider list was **inert** — `matchPlans` groups by day, so plans on other days
can never compete for this day's sessions, and plans on the same day are the
same rows. A parameter that cannot change the answer reads as a safeguard and is
scenery. `owedOn(sessions, dayPlans)` is what was ever needed.

### Gaps

The lockup sources themselves (`vola-horizontal-color.svg`,
`vola-stacked-color.svg`) still contain the tagline, so the next person to reach
for one gets it and has to know to crop. Tagline-free variants in the kit would
make the common case the easy one; not done here because it is a brand-kit
decision rather than a web one.

`apps/admin` has had none of this pass — it is still on whatever it was using,
and it is the third app that will need the same components.

## 2026-08-04 — The admin console gets the same marks, and the second copy is a deliberate one

Third and last app. `apps/admin` was still on `src/app/icon.png` as the
placeholder tick and rendered "VOLA Admin" as type in Barlow Condensed on its
signed-out entry. It now shows the stacked lockup with "Admin" set beneath it,
and its favicon and apple-icon are byte-identical to `apps/web`'s — both
rendered from `assets/brand/app-icons/vola-app-icon-dark-1024.svg`, which is
also what `apps/mobile` uses.

### Only the entry screen was branded, and that is a deferral rather than a
### complete pass

The first draft of this entry claimed `apps/admin` has "no shell masthead" and
that the signed-out entry is therefore the only place a logo belongs. Review
checked the route tree and that is wrong. What admin lacks is a **shared layout
owning a masthead**; the masthead itself exists **six times over** — an
identical `<header className="… border-b border-border bg-card px-10 py-5">`
in `users/page.tsx`, `users/[id]/page.tsx`, `content/page.tsx`,
`content/new/page.tsx`, `content/[id]/page.tsx` (twice) and `health/page.tsx`.
The three `layout.tsx` files really are pure authorization gates, so the
reasoning about *why* there is no shared home for it was right; the conclusion
drawn from it was too strong.

That matters because the web pass immediately before this one branded **both**
the signed-out entry and the signed-in shell. Admin got the entry only, so
against that precedent this is incomplete. Two further unbranded full-page
surfaces exist as well: the three identical "Not authorized" screens, and
`error.tsx` — whose own comment notes the 403 case is the likeliest in
practice.

Branding six duplicated headers means extracting an `<AdminMasthead>` first,
which is a component refactor rather than an artwork pass, so it is **deferred
and tracked**, not absent. The distinction is the point: the original wording
would have told the next person there was nothing left to consider.

### "Admin" stays type, and is not part of the lockup

The old heading read "VOLA Admin" as one string, which invites folding the
qualifier into the wordmark. It shouldn't be: "Admin" says *which console you
are looking at*, not what the brand is, and the brand kit has no such lockup.
It sits under the wordmark in condensed caps with wide tracking — related to
the mark, clearly not part of it.

### The duplication is deliberate

`apps/admin/src/app/Brand.tsx` is a copy of `apps/web`'s. Both apps are separate
Next projects with no package between them, and the workspace's `packages/*`
glob is declared but empty, so a shared `@vola/brand` was available as an
option. It was **not** taken, because the direction already agreed for killing
this duplication is a *generator* — a script that reads `logos/source/*.svg` and
emits one module per app, with CI failing on `git diff --exit-code`. That makes
drift a red build rather than something review has to catch, and it covers
`apps/mobile` too, which a runtime React package never could (it needs
`react-native-svg`, which that app deliberately does not have). Introducing a
package now would cut across that plan to reach the same end state.

The cost is stated in the file rather than left implicit: both copies carry a
comment saying that changing one means changing the other. That is a weak
guarantee and is meant to be temporary.

### What review caught, and one thing my own mutation test did

**The screen opened on yesterday.** `viewDay` was a `Date` captured at mount and
refreshed by nothing, while `now` re-reads on focus and on AppState. Leaving the
app on Today overnight therefore reopened it in *past mode* — yesterday in the
switcher, plans dimmed and marked "Not logged" — with the athlete having
navigated nowhere. It is a day **offset** now, derived from `now`, so every
refresh re-derives it and the class is gone rather than patched at the two
places that happened to refresh.

**A blanket `opacity: 0.55` on the past card** composited every ink inside it:
"Not logged" fell to 1.96:1 and the BJJ eyebrow to 2.51:1 — the latter being the
exact figure the palette cites as its reason for banning `textDim` from a done
row, and failing specifically for this app's headline discipline. The card is
not dimmed at all now; "Not logged" is `warn` at full strength, which is also
what it means.

And one that arrived from my own mutation testing rather than from review: the
first fix for the outside-the-week bug passed *two* plan lists and matched their
union. Three mutations of it stayed green, which is how it came out that the
wider list was **inert** — `matchPlans` groups by day, so plans on other days
can never compete for this day's sessions, and plans on the same day are the
same rows. A parameter that cannot change the answer reads as a safeguard and is
scenery. `owedOn(sessions, dayPlans)` is what was ever needed.

### Gaps

Two copies of the path data now exist (web, admin) plus a third copy of the
lockup *ratios* in `apps/mobile`'s `AnimatedSplash`. Nothing enforces that they
agree. The generator is the fix and is tracked separately, along with the
brand kit's top-level placeholder logos.

`apps/admin` has no dark theme at all — one `--color-accent-dark` token, no
`data-theme`, no `prefers-color-scheme`, no `dark:` utilities. The wordmark's
`currentColor` therefore buys nothing here today; it costs nothing either, and
it means the console is already correct if a dark mode ever lands.

## 2026-08-04 — The You tab gets a masthead, and four spans break every chart on it

The You tab held a belt card, a two-span consistency grid, three tiles and a
stack of record boxes, all at the same visual weight. The ask was for the belt
to lead, for the grid to offer a week / month / six months / a year, and for the
records to be compact and worth looking at. Only the first is a design change;
the other two turned out to be a lesson in how a chart built for two spans
fails at four.

### The belt is the masthead now

`BjjRankCard` sat below the training summary — one card among several. For a
grappler the belt is not a fact about them, it is the thing the screen is
*about*. It now leads the page full-width: the belt drawn large, "YOUR RANK"
and its name beneath, then School / Promoted / At this rank as three labelled
facts under a rule.

Details that mattered more than they look:

- **The school comes from the promotion, not the rank.** `Standing.current` is
  derived server-side as the *highest* recorded rank and carries no academy or
  date, so the awarding promotion has to be found by matching belt + stripes +
  degree, breaking ties on the latest `promoted_on` with undated rows last.
  Returns null when nothing matches — reachable, since the athlete can edit the
  promotion the rank was derived from — and the header then shows the belt
  alone rather than inventing a school.
- **Each fact is omitted rather than shown empty.** A promotion may legitimately
  have no academy and no date; "School: —" is furniture.
- **The date is parsed from parts**, never `new Date('2024-03-12')`, which reads
  a bare date as UTC midnight and renders as the previous day west of
  Greenwich — the same trap `lib/plan.ts` documents.
- On the device, two of the three facts truncated: a third of a phone is ~92pt,
  and "March 12, 20…" had lost the year — the one part of a promotion date
  anyone quotes. Short month plus two-line values fixed it.

**`BjjRankCard` is deleted, not kept for the empty case.** Rendering both meant
two components each fetching `/bjj/standing`: two requests for one fact, and
they can disagree while one is in flight. The no-rank state is now one quiet row
inside the header — a masthead saying "no rank yet" in 200pt of chrome would be
the loudest thing on the screen saying nothing.

### Four spans, and what broke

`SPANS` went from two entries to `1W / 1M / 6M / 1Y`, and three separate things
turned out to have been sized for the old pair.

- **The consistency grid overflowed silently.** Weeks-as-columns at a fixed
  13pt cell is 52 × 16 = 832pt inside a ~315pt card: three quarters of the year
  ran off the right edge with no scroll and nothing to say so. The cell is now
  derived from an `onLayout`-measured width, and the gap tightens as columns
  multiply (3 → 2 → 1), because at 52 columns a 3pt gap is half the card.
- **And the same fix made a month look broken the other way** — four columns of
  16pt is 61pt of grid marooned in the same card. So the *shape* is per-span
  too: five weeks or fewer lays out as a **calendar**, seven across with weekday
  letters; more lays out as a **heatmap**, weeks across and days down. Filling
  the width also proved wrong when actually looked at — at ~42pt a month is
  twenty-eight chips the size of the Today screen's date buttons, and
  twenty-seven grey ones shout over the one lime one that is the point of the
  card. Capped at 30 and centred.
- **The weekly volume chart stopped being readable at all.** A bar per week over
  a year is 52 bars in ~315pt — a texture, at exactly the range someone picks to
  answer "how much did I move". It is now always **seven bars, this week**, one
  per day, deliberately *not* tied to the span control above it: the grid
  answers "am I showing up, over months" and this answers "how is this week
  going". A Thursday shown as a bar of any height on Tuesday reads as a session
  you missed, so days that haven't happened yet draw **nothing** where a rest
  day draws a stub — see below for why the first attempt at that was wrong.
- **The Time figure overlapped its neighbour.** A year is "312h 45m", and at
  size 26 in a third-width tile that runs into the next stat. Two fixes:
  `formatDuration` drops minutes past 100 hours (nobody states a year at minute
  precision, and it stops the rendered width growing), and `StatValue` shrinks
  the figure on a length ladder. A ladder rather than `adjustsFontSizeToFit`,
  which measures after layout and is unreliable across the nested `Text` runs
  this component renders by design.

### Records, compact

Five records were five bordered boxes — a lot of chrome for five numbers. Now
one card of divided rows: medal, name with the evidence and any secondary
records beneath, and the headline figure right-aligned. The medal is drawn from
Views (same no-`react-native-svg` rule as `ui/Icon` and `Belt`), and its tier
means something — gold is `is_recent`, silver is a standing record — with a ★ on
the gold so the tiers survive greyscale, since the two metals are only 1.26:1
apart.

One real bug fell out of reading the row on the device: the estimated 1RM
rendered as "74.48kg". `formatEstimate` had existed for exactly this since the
exercise screen, but `formatRecord` took a `fmtWeight` callback and routed both
weight kinds through it. It now takes the `UnitSystem` and picks the formatter
itself — a caller passing its own formatter would have had to know which kinds
are estimates, which is this function's job.

### What review caught, and both were the same mistake

`/pre-merge`'s frontend reviewer found one blocking defect and, on the re-check,
a second. They are worth recording together because they are the same error
twice: **a distinction that exists in the code and not on the device.**

- **The future bars were dimmed into invisibility.** The first version drew a
  future day at 3% height in `lineSoft` and a rest day at 3% in `gridRest` —
  1.7pt of one colour beside 1.7pt of another, 1.28:1 apart, on a ground
  neither clears 1.5:1 against. The branch was correct and both read as blank,
  which is exactly the "you missed Thursday" the branch existed to prevent. The
  channel is now presence-versus-absence of a mark: a stub means a measured
  zero, nothing means no data yet. The weekday letters carry it too, and stopped
  using `opacity: 0.4` — which had taken `textDim` to 1.59:1. The elapsed days
  step *up* to `textMuted` instead. The rest stub then went 4% → 7%, because at
  2.2pt `bar`'s 3pt top radius renders it as a lens rather than a bar.
- **The timezone test was a no-op that passed against the exact bug it
  covered.** `formatAwardDate` parses from parts precisely so a bare
  `YYYY-MM-DD` doesn't render as the previous day west of Greenwich, and the
  test set `process.env.TZ = 'America/Los_Angeles'` in a `beforeAll` to prove
  it. **Jest hands the sandbox a copied `process`**, so the assignment never
  reaches the runtime, V8 is never notified, and the zone silently stays UTC —
  where the bug is invisible and the buggy implementation passes all three
  assertions. Fixed by setting the zone at process launch instead:
  **`apps/mobile`'s `test` script is now `TZ=America/Los_Angeles jest`**, so the
  whole mobile suite runs outside UTC, which is the condition these bugs
  actually manifest under and the reason CI never catches them. The file also
  carries a guard asserting `getTimezoneOffset() > 0`, so the configuration
  cannot rot back into a no-op without going red. The full suite passed
  unchanged under the new zone — nothing else had been depending on UTC.

### Verification

Every span, both grid shapes, the masthead with a real promotion, the medal row
and the seven-bar week were checked on the iPhone 15 Pro Simulator — the grid
overflow, the marooned month, the truncated facts and the two-decimal 1RM were
all found by looking at it, not by reading it. Two test files are new
(`history.test.ts`, `rankFacts.test.ts`) covering the pure maths and the two
facts the screen *asserts about the athlete* — which promotion awarded the held
rank, and the estimate-versus-measurement split on a record. Five guards were
mutated to confirm the assertions go red when the code they cover changes,
including the timezone one above.

## 2026-08-04 — One hook in the wrong place, and the linter that was never there

Opening a BJJ class from Today → Recents was a black screen and "Something
went wrong":

	Rendered more hooks than during the previous render.

One `useMemo` sat below the screen's two early returns. React matches hooks
positionally, so the loading render — which returns the spinner before reaching
it — called one fewer hook than every render after the load resolved. The
reading half of BJJ logging, which exists precisely because the feature shipped
write-only once, was unreachable again.

### The fix is one line. The finding is that nothing was checking.

`apps/mobile` **had no linter at all.** `verify` ran `lint:web` and
`lint:admin`; the mobile app got `typecheck:mobile` and `test:mobile` and
nothing else. `react-hooks/rules-of-hooks` catches this exact defect by name,
and nothing else can: hook order is a RUNTIME property, so the typechecker is
structurally blind to it, and `lib/__tests__/` is deliberately not component
tests.

The app with the most stateful screens in the repo was the one app not being
linted. `eslint-config-expo` now runs over it, wired into `verify` and into
CI's mobile job — the rule this file already states, that a check added to one
must be added to the other.

### 55 warnings, on purpose, and a ratchet

Turning lint on for the first time on thirty never-linted screens surfaced 55
findings — measured, after review caught three different numbers written in
three places, none of which matched what `eslint` printed. One was the crash.
The rest are real but not crashes: 24 `react-hooks/refs` (refs read or written
during render) and 15 `set-state-in-effect` (cascading renders) dominate.

`rules-of-hooks` is an **error**; everything else is a **warning**. Folding
fifty-odd unrelated edits into a one-line crash fix would make the fix
unreviewable, and switching the rules off would throw the information away.

But "the backlog stays visible" is not true of a passing CI job that nobody
reads, and this branch proved it: **it added two warnings without anyone
noticing**, which is exactly how a soft limit rots. So the script carries
`--max-warnings=55`. The count is now a ratchet — clearing findings means
lowering it, and adding one fails the gate and forces a deliberate decision.
Neither `apps/web` nor `apps/admin` does this; it is a new convention here
because this is the app with a documented backlog.

`rules-of-hooks` is also not the only error. v7's recommended set errors on
`purity`, `set-state-in-render`, `immutability` and several more that this
config leaves alone — they report zero today, so new code can fail on a rule
nobody named. That is intended, and now written down.

### One thing the review corrected about the config

The `@typescript-eslint/*` findings are left alone, and the first version of
this entry gave the wrong reason: "flat config only lets a config object change
a rule whose plugin it registers". That is contradicted three lines up in the
config itself, where `react-hooks/*` rules registered by `eslint-config-expo`
are overridden without trouble.

The real constraint is narrower and worth having right: `eslint-config-expo`
registers the React plugins **globally** but registers `@typescript-eslint`
only for TypeScript globs. So a rules block naming one of its rules has to be
`files`-scoped to those globs — an unscoped one fails to LOAD the entire config
the moment a `.js` file is linted, rather than lowering a severity. Tested both
directions.

### Two guards, because they catch different things

- **The lint rule** catches the class, statically, before the code runs.
- **`app/__tests__/bjjSessionScreen.test.tsx`** catches this screen at runtime.
  It renders through the LOADING TRANSITION deliberately: the mocks resolve on
  a later tick so the loading branch genuinely renders first. Asserting only on
  the settled state would pass against the broken code, because by then the
  hook count is consistent again.

  Verified by reverting the fix — the test reports React's own diagnostic,
  named to the component: "React has detected a change in the order of Hooks
  called by BjjSessionScreen."

  A second assertion checks the technique row still renders, so "made the crash
  go away" (an early `return null`) cannot pass for "made the screen work".

### What review caught, and one thing my own mutation test did

**The screen opened on yesterday.** `viewDay` was a `Date` captured at mount and
refreshed by nothing, while `now` re-reads on focus and on AppState. Leaving the
app on Today overnight therefore reopened it in *past mode* — yesterday in the
switcher, plans dimmed and marked "Not logged" — with the athlete having
navigated nowhere. It is a day **offset** now, derived from `now`, so every
refresh re-derives it and the class is gone rather than patched at the two
places that happened to refresh.

**A blanket `opacity: 0.55` on the past card** composited every ink inside it:
"Not logged" fell to 1.96:1 and the BJJ eyebrow to 2.51:1 — the latter being the
exact figure the palette cites as its reason for banning `textDim` from a done
row, and failing specifically for this app's headline discipline. The card is
not dimmed at all now; "Not logged" is `warn` at full strength, which is also
what it means.

And one that arrived from my own mutation testing rather than from review: the
first fix for the outside-the-week bug passed *two* plan lists and matched their
union. Three mutations of it stayed green, which is how it came out that the
wider list was **inert** — `matchPlans` groups by day, so plans on other days
can never compete for this day's sessions, and plans on the same day are the
same rows. A parameter that cannot change the answer reads as a safeguard and is
scenery. `owedOn(sessions, dayPlans)` is what was ever needed.

### Gaps this leaves

- **53 warnings outstanding**, listed above. `react-hooks/refs` in particular
  is worth a pass of its own; reading a ref during render is the kind of thing
  that works until it doesn't.
- **Not verified on a device.** Metro was already serving the primary checkout,
  and the component test is the stronger guard anyway — but nobody has opened a
  real class from Recents on a phone since the fix.
- **The other screens were not audited by hand.** The linter now covers them,
  which is the point, but it reports zero `rules-of-hooks` violations today
  rather than anyone having read all thirty.

## 2026-08-04 — The console's masthead becomes one component, and the mark comes in with it

Closes the deferral recorded in *"The admin console gets the same marks, and
the second copy is a deliberate one"* — three entries up, since two mobile
entries landed between them. `apps/admin` had its six copies of an identical
`<header>` collapsed into one `<AdminMasthead>`, and that component
carries `VolaMark`. The three "Not authorized" screens — byte-identical
triplets living in `users/`, `content/` and `health/`'s layouts — became one
`<NotAuthorized>`, and it and `error.tsx` both now carry `VolaLockup`. Nothing
in `apps/admin` that fills a screen is unbranded any more.

### A component each page renders, not a shared layout

This was the open question, and the route tree answers it rather than taste
doing so. **Every masthead's content is the page's own, and arrives with the
page's own data**: a technique's name, an athlete's display name and belt,
"N known to the API" counted from the very list the table underneath renders. A
layout renders *around* a page without seeing any of that, so a layout-owned
masthead needs the title pushed back up from the page — a client context, a
title that lands a frame after the header paints, and a `"use client"` boundary
around chrome that is otherwise entirely static.

The case that settles it is `content/[id]`, which renders **two different
mastheads on two branches of one page** (the seeded dead-end and the edit
form). One layout can only render one header.

Review added the argument this reasoning was missing, and it is the strongest
one: a `(console)/layout.tsx` holding the masthead would sit **above** the
three gate layouts, so a non-allowlisted account would get branded console
chrome — the mark, the title, all three nav links — wrapped around its own
"Not authorized" screen. The thing that refuses you would be framed by the
navigation it is refusing you.

So the six copies collapse to six *call sites*, which is the honest shape: the
markup exists once, the content stays where the data is.

### The mark in the bar, the lockup on full-page surfaces

Three presentations of one identity, chosen per surface rather than for
uniformity. The bar is ~64px tall and `VolaLockup` is 0.66x its own width in
height, so at any width where the wordmark is legible it roughly doubles the
header. `Brand.tsx` already records that there is no wide-and-short arrangement
to reach for either — the horizontal lockup's mark is 3.4x its wordmark's
height and only balances beside a tagline this product does not ship. Dense
chrome therefore gets the mark alone, with "VOLA Admin" carried by the
accessible name on its link.

`NotAuthorized` and `error.tsx` are centred full-page surfaces, which is the
arrangement the stacked lockup was measured for, so they get it. They do
**not** get the "ADMIN" qualifier the signed-out entry sets beneath it: there
the lockup is the page's subject and the qualifier is its heading text, whereas
here the heading is the refusal or the failure, and a second line of display
type above it competes with the thing the reader needs. Both lockups are inert
rather than links — on a 403 the only place to go is the route that just
refused you, and on the error screen "Try again" is the way out while a logo
linking to a currently-throwing route is a loop.

`Brand.tsx` itself was not touched, so `check:brand-copies` stays green without
the paired edit it exists to force.

### The nav now says where you are

Each page used to hand-write the cross-console nav **minus itself**, so the set
of links changed as you moved and nothing in it said where you were. With one
component the current section has to be a parameter regardless, so it is now
shown and marked with `aria-current="page"` rather than omitted — the same
reasoning as `NavLink` in `apps/web`, where colour alone was not allowed to
carry the fact either. Collapsing the copies also settled a disagreement nobody
had noticed: `health/page.tsx` styled its links `hover:underline` while the
other two used `underline`. Detail screens keep the single up-link they had
instead of gaining the nav.

### Two defects the extraction surfaced

**`users/[id]` had no `h1`.** Its title was a `<span>` while every other
screen's was a heading, so the athlete's name was styled like a heading and
exposed as nothing. The masthead always renders one, so it is fixed by
construction.

**All three "Not authorized" screens read "user_2xYz…isn't on the admin
allowlist"** — the Clerk id welded to the next word. Fixed with an explicit
`{" "}`.

The interesting part is that **this is toolchain-specific, and the widely
documented behaviour says it shouldn't happen.** Review pushed back on the fix
as unnecessary, correctly citing Babel: `cleanJSXElementLiteralChild` trims
leading whitespace only on lines *after* the first, so a space between an
expression and same-line text is preserved. That is true of Babel and false of
SWC, which is what Next 16 / Turbopack actually builds this app with. Measured
against the running dev server, all four variants:

| JSX                                        | space |
| ------------------------------------------ | ----- |
| `{expr} text…` wrapping onto a second line | lost  |
| `{expr} text…` all on one line             | kept  |
| `{expr}` then text starting its own line   | lost  |
| `{expr}{" "}` then text                    | kept  |

The first row is exactly the shape all three originals had — the wrap is the
variable, and it is invisible at a glance because it is produced by ordinary
line-length formatting rather than by anything anyone chose. So: **do not
restore the plain space on the strength of Babel's documented behaviour**, and
be wary of reasoning about JSX whitespace from any transform other than the one
in the build. The reason it shipped three times is that nothing catches it but
reading the rendered page — no typecheck, no lint, no test.

### What review caught, and one thing my own mutation test did

**The screen opened on yesterday.** `viewDay` was a `Date` captured at mount and
refreshed by nothing, while `now` re-reads on focus and on AppState. Leaving the
app on Today overnight therefore reopened it in *past mode* — yesterday in the
switcher, plans dimmed and marked "Not logged" — with the athlete having
navigated nowhere. It is a day **offset** now, derived from `now`, so every
refresh re-derives it and the class is gone rather than patched at the two
places that happened to refresh.

**A blanket `opacity: 0.55` on the past card** composited every ink inside it:
"Not logged" fell to 1.96:1 and the BJJ eyebrow to 2.51:1 — the latter being the
exact figure the palette cites as its reason for banning `textDim` from a done
row, and failing specifically for this app's headline discipline. The card is
not dimmed at all now; "Not logged" is `warn` at full strength, which is also
what it means.

And one that arrived from my own mutation testing rather than from review: the
first fix for the outside-the-week bug passed *two* plan lists and matched their
union. Three mutations of it stayed green, which is how it came out that the
wider list was **inert** — `matchPlans` groups by day, so plans on other days
can never compete for this day's sessions, and plans on the same day are the
same rows. A parameter that cannot change the answer reads as a safeguard and is
scenery. `owedOn(sessions, dayPlans)` is what was ever needed.

### Gaps

**The masthead was never seen above real page content.** Every admin read in
this environment returns 500 from the API (`/admin/users`, `/admin/techniques`,
`/admin/health` alike), with the local database fully migrated at version 33
and every table present — so it looks like a stale API binary rather than a
schema problem, and it is unrelated to this change. Verification was done on a
temporary preview route rendering all five masthead shapes with realistic props
(including the real `BeltSwatch`), plus `NotAuthorized`; the route was deleted
before commit. `error.tsx` is the one screen verified for real, at `/users`,
because the 500 renders it.

**Only the screen was shared, not the gate.** Each layout still calls
`currentUser()` and `isAllowedAdmin` itself. That is deliberate — the check is
the load-bearing line and a reader should not have to follow an import to learn
whether a route is guarded — but it does mean the triplication is reduced, not
removed, and a fourth admin section still has to remember to write it.

**No long title has been through the title row.** The left group has no
`min-w-0` and the `h1` does not truncate, while the nav is now `shrink-0`, so a
long technique or display name wraps and grows the bar rather than overflowing
it. That is the benign outcome and it matches what the six originals did, but
it is reasoned rather than observed — the real names never rendered.

**`MARK_ASPECT` is a second copy of the mark's `viewBox`** that nothing checks:
`check:brand-copies` compares the two `Brand.tsx` files only. A drift
letterboxes the tick by a few pixels rather than distorting it, and the
generator that is meant to replace the hand-copied brand modules would take
this with it.

## 2026-08-04 — The session summary was a second copy of a component that already existed

"The things done has volume that truncates and the overall that thing is ugly."
Accurate on both counts, and the cause was the same one:

	2:39      1       8      480kg
	Time     Sets    Reps    Volume

Four rigid `flex: 1` columns, three of them holding a single digit while the
fourth carried a figure and its unit at the same size. The unit shrank the
figure it belonged to, and at a real volume — pounds run an order of magnitude
longer, so one session reads `553.7k lb` — `adjustsFontSizeToFit
minimumFontScale={0.6}` dropped it to two-thirds the size of the `8` beside it.
Three numbers at three sizes in one row.

### It was already solved, one directory away

`components/ui/Stat.tsx` has done this properly for months. It splits figures
from units with a regex, sets units to 62% and a step quieter, and shrinks long
figures with a deterministic **ladder keyed on string length** rather than
`adjustsFontSizeToFit` — whose own comment explains why: that prop measures
after layout and is unreliable across nested `Text` runs, which is exactly what
a figure-plus-unit renders. `StatRow` adds hairline dividers, which is what
makes several numbers read as one panel instead of three adjacent cards.

Today and You have used it all along. That is why the same 480kg reads as
**480**<sub>kg</sub> on Today and read as `480kg` on the session — one screen
kept a private copy written before the shared one existed, and the private copy
used the technique the shared one exists to avoid.

So this deletes the copy. The session summary is now `StatRow` + `Stat … fit`,
and the two screens agree.

### Tested, because "looks nicer" is not a regression guard

`components/__tests__/statValue.test.tsx` pins the four properties that make the
difference: the unit is smaller than the figure, a thousands separator stays
INSIDE the figure (split on the comma, the `,` renders small and muted
mid-number), the ladder shrinks a long value and leaves a short one alone, and
an em dash stays full size rather than being read as a unit. Six mutations run,
all red — including reverting the ladder, which is the specific thing a future
"simplify this" would reach for.

Verified on the Simulator against the real session, before and after.

### What review caught, which was two new defects for one old one

Both on the exact row the report was about:

1. **The colon became a unit.** `FIGURES` treated `.` and `,` as inside-figure
   but not `:`, so `2:39` rendered as two full-size figures either side of a
   muted 14pt colon — and `1:23:45` did it twice. Worse than what it replaced.
   The colon is now in the character class for the same reason the comma is:
   a clock is one quantity.

2. **The ladder was tuned for thirds and this row is quarters.** Measured, a
   quarter-width slot has ~60pt of content against a third's ~90pt, and
   `1:23:45`, `251.1t` and `12,450lb` all overflowed it at the three-column
   sizes — `numberOfLines={1}` would have tail-truncated them. So the fix would
   have swapped one truncation for another.

   `StatRow` now tells its children how many they are; `fitSize` drops a rung at
   four or more, and the slot gives back 12pt of horizontal padding. Verified by
   forcing the worst realistic case — a 1h23 session, imperial, five-figure
   volume — onto the Simulator and looking at it, rather than predicting it.

The same review also found that `StatRow`'s `Array.isArray(children)` renders an
empty slot for a SINGLE falsy child, which is exactly the shape the session's
`{finished && <Stat/>}` gate has. It happened not to bite (four children, so the
array branch), but it is now `Children.toArray` and there is a test.

### What review caught, and one thing my own mutation test did

**The screen opened on yesterday.** `viewDay` was a `Date` captured at mount and
refreshed by nothing, while `now` re-reads on focus and on AppState. Leaving the
app on Today overnight therefore reopened it in *past mode* — yesterday in the
switcher, plans dimmed and marked "Not logged" — with the athlete having
navigated nowhere. It is a day **offset** now, derived from `now`, so every
refresh re-derives it and the class is gone rather than patched at the two
places that happened to refresh.

**A blanket `opacity: 0.55` on the past card** composited every ink inside it:
"Not logged" fell to 1.96:1 and the BJJ eyebrow to 2.51:1 — the latter being the
exact figure the palette cites as its reason for banning `textDim` from a done
row, and failing specifically for this app's headline discipline. The card is
not dimmed at all now; "Not logged" is `warn` at full strength, which is also
what it means.

And one that arrived from my own mutation testing rather than from review: the
first fix for the outside-the-week bug passed *two* plan lists and matched their
union. Three mutations of it stayed green, which is how it came out that the
wider list was **inert** — `matchPlans` groups by day, so plans on other days
can never compete for this day's sessions, and plans on the same day are the
same rows. A parameter that cannot change the answer reads as a safeguard and is
scenery. `owedOn(sessions, dayPlans)` is what was ever needed.

### Gaps this leaves

- **One more private `Stat` copy is worth converging**: `app/exercise/[id].tsx`
  is the same shape and a near drop-in, but it is not broken — its values are
  short, its column is ~96pt, and it has no `numberOfLines`, so a long value
  wraps rather than clips. Cleanup, not a fix.
  `app/bjj/session/[id].tsx` has a `Stat` too and it is **not** the same
  component: its second prop is a prose caption ("min on the mat", "moderate"),
  which `Stat` would uppercase with letter-spacing. Leaving it is correct.
- **Still only seen on the Simulator, and only at values I forced.** The worst
  case was rendered by hardcoding it, not by training for 83 minutes; real
  device metrics (SF Pro Text vs the Core Text the review measured with) and
  larger Dynamic Type settings are unverified.
- **A row can still show three different sizes.** The ladder is per-stat, so a
  long Time and a short Sets shrink independently. Harmonising would mean
  `StatRow` taking the minimum across its children — a bigger change than this.
- **The Today week-summary row and this one now share a component but not a
  size** — Today renders at the component default, this at 22. Deliberate (the
  session header is denser) but it is a number in two places.

## 2026-08-04 — Exercises get the write path, and the export grows a second catalog

"Add a technique or exercise for any module" was the original ask; techniques
were half of it. `/v1/admin/exercises` and `/content/exercises` are the other
half, and the export now carries both libraries.

### Mirrored deliberately, not abstracted

The exercise module's `content.go` / `content_postgres.go` / `content_handler.go`
are the technique module's, adapted. Every hard-won property came across
intact: pointer-per-field so PATCH is genuinely partial, `source = 'admin'` in
the UPDATE's WHERE rather than a check in Go, the id derived once and never
moved, `[]`-never-null guaranteed in the handler, the seeded-row refusal that
explains itself.

Not extracted into a shared generic. The two catalogs have different columns,
different vocabularies and different nullability rules — techniques need
`NULLIF` on three columns where empty is a distinct fact from absent, exercises
have none — so the shared part would have been the comments.

### The field that a plain bool cannot express

`is_unilateral` is the reason the pointer-per-field rule is load-bearing here
and not just inherited discipline: a plain `bool` cannot distinguish "not sent"
from "false", so a form posting one edited field would silently flip every
unilateral exercise to bilateral. There is a test for exactly that, and it goes
red if the pointer is removed.

### Media, and why an admin write cannot touch it

Media lives in `exercise_media`, keyed by exercise id, and the write path does
not name it — not in the request type, not in the UPDATE, not in the export's
read. That is what makes authoring safe without an upload path: an exercise
created here simply has none, and a later deploy can attach some without the
console knowing or being able to clear it.

The export needed one rule for this that techniques did not: `media` is the
FILE's, not the database's. `AdminAuthored` does not select it, so every
exported exercise carries `"media": []` — and re-exporting an exercise a deploy
had given media to would otherwise reset it, deleting the only record of an
asset still sitting in the bucket. `mergeInto` now takes a `preserve` list, and
the exercise catalog passes `media`.

### The trap the exercise catalog had and techniques did not

`techniques.json` is generated from a spreadsheet **and merges
`techniques.additions.json`**. `exercises.json` was generated from its
spreadsheet and merged nothing. So shipping the write path alone would have
meant every authored exercise was deleted by the next exercise re-import —
silently, because the sheet is a full replacement rather than a patch.

That is the same class of bug the export PR existed to fix, one catalog over.
`exercises.additions.json` now exists and
`scripts/import-exercise-catalog.py` merges it, refusing ids that collide with
the sheet exactly as the technique path does.

### The export became catalog-shaped

`cmd/exportcontent` was technique-specific throughout. It now runs over a
`catalog` — two files, the rendered rows, the keys the file owns, and a
validator — with both libraries going through the same `run()`. One
implementation because the invariant is the same and it is the invariant that
is easy to get wrong: content in only one of the two files is lost, by the
deploy not carrying it or by the next re-import deleting it.

`validate` is a field on the catalog and runs INSIDE `run()`. It was briefly
moved up into `main()` while generalising, which would have repeated this
command's own history — main() has no test, and that is precisely how the
two-file invariant shipped broken here once, invisible to its own suite. A
catalog with no validator is refused rather than written unchecked.

### Verified end to end

Console → Postgres (`source=admin`) → `cmd/exportcontent` → a one-entry,
19-line diff on `exercises.json` in the file's own key order → `cmd/seed` loads
it (505 upserted). Editing `movement_pattern` alone left the other ten columns
untouched, `is_unilateral` included. A seeded id renders the explanation rather
than a form. "Zercher Squat" was refused as already taken, which was correct —
it is in the shipped catalog, and the refusal is what stopped a duplicate id.

Ten mutations run against the backend, all red — including one that only a real
database could catch: deleting `AND source = 'admin'` from the UPDATE left the
entire handler suite green, because the fake repository implements its own
ownership check.

### What review caught, and one thing my own mutation test did

**The screen opened on yesterday.** `viewDay` was a `Date` captured at mount and
refreshed by nothing, while `now` re-reads on focus and on AppState. Leaving the
app on Today overnight therefore reopened it in *past mode* — yesterday in the
switcher, plans dimmed and marked "Not logged" — with the athlete having
navigated nowhere. It is a day **offset** now, derived from `now`, so every
refresh re-derives it and the class is gone rather than patched at the two
places that happened to refresh.

**A blanket `opacity: 0.55` on the past card** composited every ink inside it:
"Not logged" fell to 1.96:1 and the BJJ eyebrow to 2.51:1 — the latter being the
exact figure the palette cites as its reason for banning `textDim` from a done
row, and failing specifically for this app's headline discipline. The card is
not dimmed at all now; "Not logged" is `warn` at full strength, which is also
what it means.

And one that arrived from my own mutation testing rather than from review: the
first fix for the outside-the-week bug passed *two* plan lists and matched their
union. Three mutations of it stayed green, which is how it came out that the
wider list was **inert** — `matchPlans` groups by day, so plans on other days
can never compete for this day's sessions, and plans on the same day are the
same rows. A parameter that cannot change the answer reads as a safeguard and is
scenery. `owedOn(sessions, dayPlans)` is what was ever needed.

### Gaps this leaves

- **Still no delete, in either catalog.** An exercise authored with a typo in
  the name is a dead id that can only be edited. Deliberate — the id is a
  foreign key in workout items and logged sets, so removing one is a data
  question rather than a CRUD gap — but the answer is currently "ask a
  developer".
- **No media upload.** The console can say an exercise has assets and cannot
  add, replace or remove them.
- **`movement_pattern` is a guess the console cannot check.** The dropdown is
  the right sixteen, but nothing tells an operator that "isolation" is the
  honest bucket for a single-joint movement rather than the nearest big lift.
  Filing it wrong renders perfectly and is invisible to every cross-sport rule.
- **Muscle and equipment names are free text.** They are what the library's
  filters group on, so a new spelling makes its own bucket of one. The catalog
  has 63 distinct muscles and 33 equipment values; neither is offered as a
  vocabulary because neither is closed.
- **The exercise importer merge is unrun.** The Go side is verified end to end,
  but `scripts/import-exercise-catalog.py` needs the spreadsheet, so the merge
  block is reasoned-and-mirrored rather than executed.


## 2026-08-04 — The Plan tab gets a week you can move, and four `startOfWeek`s become one

The Plan tab's calendar was pinned to the current week with **no navigation of
any kind** — no arrows, no month, no way to reach any other week. You could not
plan next week, which is most of what a planner is for. `lib/plan.ts`'s
`listPlannedBetween` already took an arbitrary range, so the gap was entirely in
the UI.

**The request was "make it like Today's calendar"; that was deliberately not
done literally.** Today's `TrainingCalendar` is a 7-across grid of dots, and
`WeekPlanner`'s own header comment already records why this screen is rows
instead: a 45pt column cannot hold "Maestro Push Day", so a grid degrades every
planned day to a coloured dot and the calendar stops saying *what* you planned.
Today's calendar answers "did I train?"; Plan has to answer "with what?". So
what was taken from Today is the **navigation**, not the shape:

- A month title (`AUGUST ⌄`) that opens a month grid, and a `‹ ›` stepper that
  moves a week at a time.
- The month grid is a **jump target only** — tap any day and that day's week
  loads into the rows, which stay the day representation. Its cells carry a dot
  and nothing else, which is precisely why it cannot replace them.
- A `Today` pill, shown only when you are away from the current week, since it
  is also the only thing telling you that you have navigated at all.

**Two controls that both wanted a chevron.** The first cut read `‹ AUGUST › ›`
— the title's disclosure and the next-week arrow, two identical right-chevrons
side by side doing entirely different things. Grouping the stepper on the right
and rotating the title's chevron down is what makes them readable; it was only
obvious on the Simulator, not in the code.

**`refreshedAnchor` snaps a *past* week forward on focus, and leaves a future
one alone.** A past anchor can only be the clock moving, so correcting it is
what stops a tab left open overnight from planning into last week — the same
staleness `now` was already guarded against. A future anchor was chosen
deliberately, and resetting it every time the tab lost focus would make planning
two weeks out a fight.

**The bug that rule nearly caused.** `refresh` depends on the anchor, so the
first version's `useFocusEffect(..., [refresh])` re-ran on *every navigation* —
and the snap then fired against the week just chosen, bouncing any past week
straight back to today. The whole left half of the month grid was dead. The fix
is that the focus effect holds `[]` and does not read the anchor, with the data
read split into its own effect keyed on a `reloadAt` counter. Both directions
are now Simulator-verified: a past week loads and stays, a future week survives
a tab switch, and a plan made on 10 August lands where it was made.

**Four copies of `startOfWeek` became one.** `lib/plan.ts`,
`components/TrainingCalendar.tsx` and `app/(tabs)/index.tsx` each had their own,
and the month grid would have made a fifth. They now live in a new pure
`lib/calendar.ts` with `monthGrid`, `addDays`, `weekDays` and `refreshedAnchor`,
which `TrainingCalendar` also adopts — so the two calendars genuinely share one
implementation rather than two that happen to agree today. It deliberately holds
no data, so a test for a grid shape needs no database. Three of the copies were
identical, which is the problem and not the reassurance: Monday-first is a
decision about what a week *is* in this product, and four places to change it
means three places to forget. `lib/history.ts` keeps its own, and is not a fifth
copy — it takes and returns a `YYYY-MM-DD` string because it works over rows
already keyed by day.

**A test that passed against the broken implementation.** `addDays` uses
`setDate` rather than `+ n * 86400000` because a day is not 24 hours on the two
DST boundaries a year. The first test for that used 25 October — Europe's
changeover — and the suite runs pinned to `America/Los_Angeles`, so it held
under the millisecond version and proved nothing. Rewritten onto 1 November
(25 hours) and 8 March (23 hours), it fails as it should. All four new guards
were mutation-checked: each goes red when the code it covers is broken.

### What review caught, and one thing my own mutation test did

**The screen opened on yesterday.** `viewDay` was a `Date` captured at mount and
refreshed by nothing, while `now` re-reads on focus and on AppState. Leaving the
app on Today overnight therefore reopened it in *past mode* — yesterday in the
switcher, plans dimmed and marked "Not logged" — with the athlete having
navigated nowhere. It is a day **offset** now, derived from `now`, so every
refresh re-derives it and the class is gone rather than patched at the two
places that happened to refresh.

**A blanket `opacity: 0.55` on the past card** composited every ink inside it:
"Not logged" fell to 1.96:1 and the BJJ eyebrow to 2.51:1 — the latter being the
exact figure the palette cites as its reason for banning `textDim` from a done
row, and failing specifically for this app's headline discipline. The card is
not dimmed at all now; "Not logged" is `warn` at full strength, which is also
what it means.

And one that arrived from my own mutation testing rather than from review: the
first fix for the outside-the-week bug passed *two* plan lists and matched their
union. Three mutations of it stayed green, which is how it came out that the
wider list was **inert** — `matchPlans` groups by day, so plans on other days
can never compete for this day's sessions, and plans on the same day are the
same rows. A parameter that cannot change the answer reads as a safeguard and is
scenery. `owedOn(sessions, dayPlans)` is what was ever needed.

### Gaps this leaves

- **The review caught a false gap in this very entry.** An earlier draft
  listed "plans are still local-only" here. They are not: `planned_sessions`
  joined the outbox at schema v15, `lib/sync.ts` runs `syncPlans`, and this
  component calls `requestSync('plan-added')` itself. The claim was copied from
  `WeekPlanner`'s own header comment, which had been stale for some time — and
  copying it into this log was the worse half, because this is the document
  every future session is pointed at first. Both are corrected. Worth
  remembering that a component comment is not a source: it records what was
  true when someone last touched that file.
- **The focus rule was focus-only, and the comment promised more.** The snap
  runs on `useFocusEffect`, which does not fire when the app is foregrounded on
  the tab it was left on — the exact overnight case the comment claimed to
  cover. An `AppState` listener now mirrors the Today screen, which had needed
  the same thing for the same reason.
- **The month grid does not show what kind of session is planned.** Every
  planned day gets the same lime dot, where Today's calendar distinguishes done
  from planned. Two-a-days and a strength/BJJ split are both invisible there.
  Acceptable for a jump target; wrong if it ever becomes something people read.
- **The grid's dots do not react to a sync while it is open.** They are loaded
  when it opens and when its month changes; the rows behind it are the live
  surface. A plan arriving mid-open shows up on the next open.
- **One unexplained Expo Go crash, seen once and not reproduced.** During a
  Fast Refresh reload mid-verification the app dropped to the home screen:
  `EXC_BREAKPOINT`, a Swift `assertionFailure` inside
  `ExpoFabricView.injectInitializer` under `RCTComponentViewFactory`. Native,
  not a JS error. It is **not** the Hermes `EXC_BAD_ACCESS` this repo already
  documents — the other seven reports from the same day all carry that
  signature and this one does not, so it cannot be waved off as the known
  one. A full repeat of the same interaction sequence, including opening and
  closing the month sheet, produced no further crash. Most likely a dev-only
  Fast Refresh remount racing Fabric view registration, but that is a guess,
  and it is written down here rather than dropped so the next person who sees
  it has a second data point.
- **The screen below the calendar is untouched and still rough**: the
  My workouts / Shared tabs, the very heavy `New workout` button, and the hint
  line that the button overlaps. That is the next item on the user's list.


## 2026-08-04 — A workout template can be renamed, which needed a verb that did not exist

"I can't edit the title of the Workout Templates" turned out not to be a
missing button. `/v1/workouts/{id}` had `GET` and `DELETE`, `/items` had `PUT`,
and **there was no third verb** — the name was fixed at creation, on every
client, by the contract. The only correction available was to rebuild the
template, which mints a new id and orphans every plan pointing at the old one.

**`PATCH /v1/workouts/{workoutID}`, not a field on `PUT /items`.** Renaming and
re-ordering happen at different moments. Folded together, correcting a typo
would mean resending the whole item list — and a client holding a slightly
stale copy would silently rewrite the workout while doing it. Keeping them
apart also keeps the hot path cheap: the item list is written on a debounce as
you edit, and a combined verb would put the name on every one of those writes.

The handler mirrors the session module's rename exactly, including the two
things that module got wrong first: a blank name is **refused rather than
stored** (it renders as a gap in the template list with nothing to identify or
tap, and every plan pointing at it loses its label too), and the length cap
counts **runes, not bytes** — `len()` on a Go string would cap a Portuguese or
Japanese name at a third of the published 120, in a product whose domain
vocabulary is "kesa gatame" and "raspagem".

The repository's ownership gate is the load-bearing part. Ids here are
client-supplied, so without `requireOwner` any id you can guess is renameable —
this module has already had to close that hole once. The test proves it against
a **public** workout, so a stranger can genuinely read the row and the refusal
has to come from the write gate rather than from invisibility; it then asserts
the name did not move. Deleting the gate turns it red.

**Offline, on mobile, with its own flag.** `workout_cache` gains `name_dirty`
at schema v16, separate from `dirty`, because the two are cleared by different
requests — `dirty` is owed to `PUT /items`, `name_dirty` to the new `PATCH`.
One flag for both would make every item edit also PATCH the name. The migration
defaults it to **0**, and that direction is the whole risk: every existing row's
name is whatever the server already holds, so none is owed anything. Defaulting
to 1 would make the first sync after upgrade re-send every cached template's
name, including VOLA's own ownerless ones, which the server refuses with a 403
the outbox would then hold forever. There is a test for exactly that.

The push renames **before** replacing items. Both calls return the workout, and
with the rename second a failure there leaves the server holding new items under
the old name — the confusing half-state. This order fails the other way: the
name lands, the items retry, the row stays dirty.

**Both clients, because both own this.** Mobile gets the "tap to rename" row the
BJJ session screen established — the name moves into the body, since a native
header title is not a control and cannot be tapped. Web gets an editable `h1`,
which stays an `h1` in both states so the page does not lose its only level-1
landmark mid-edit; Escape abandons, since a blur-to-save field otherwise offers
no way out that does not write. Web has no offline store, so there the server IS
the save and a refusal restores the old name rather than leaving a rename on
screen that never happened.

### What review caught, and one thing my own mutation test did

**The screen opened on yesterday.** `viewDay` was a `Date` captured at mount and
refreshed by nothing, while `now` re-reads on focus and on AppState. Leaving the
app on Today overnight therefore reopened it in *past mode* — yesterday in the
switcher, plans dimmed and marked "Not logged" — with the athlete having
navigated nowhere. It is a day **offset** now, derived from `now`, so every
refresh re-derives it and the class is gone rather than patched at the two
places that happened to refresh.

**A blanket `opacity: 0.55` on the past card** composited every ink inside it:
"Not logged" fell to 1.96:1 and the BJJ eyebrow to 2.51:1 — the latter being the
exact figure the palette cites as its reason for banning `textDim` from a done
row, and failing specifically for this app's headline discipline. The card is
not dimmed at all now; "Not logged" is `warn` at full strength, which is also
what it means.

And one that arrived from my own mutation testing rather than from review: the
first fix for the outside-the-week bug passed *two* plan lists and matched their
union. Three mutations of it stayed green, which is how it came out that the
wider list was **inert** — `matchPlans` groups by day, so plans on other days
can never compete for this day's sessions, and plans on the same day are the
same rows. A parameter that cannot change the answer reads as a safeguard and is
scenery. `owedOn(sessions, dayPlans)` is what was ever needed.

### Gaps this leaves

- **The review found a test that could not fail, and two properties with no
  test at all.** The `updated_at` assertion was `renamed.UpdatedAt.Before(
  renamed.CreatedAt)` — both columns default to `now()`, and Postgres `now()`
  is transaction time, so straight after an insert they are identical and that
  comparison can never be true. Deleting `updated_at = now()` from the UPDATE
  left it green. It now compares against the pre-rename value and goes red.
  Separately, the two rules the endpoint publishes — blank refused, cap counted
  in runes — lived entirely in the handler, which had no tests, so swapping
  `utf8.RuneCountInString` for `len` left the whole suite passing. There is a
  handler test now, and the case that catches that swap is the **accepting**
  one: under a byte cap, 120 Japanese runes are 360 bytes and get refused,
  while 121 is still refused for the wrong reason — so a test asserting only
  "121 → 400" passes against the exact bug it was written for.
- **`Create` was not holding the invariant `Rename` publishes.** `POST` stored
  `"   "` and a 5000-rune name happily (the column is plain `TEXT`, no CHECK),
  so the "renders as a gap in the list with nothing to tap" harm this endpoint
  refuses was fully reachable through creation — and a template created with a
  5000-rune name could never be renamed to anything comparable. Both paths now
  trim and cap on the same rules.
- **The client review found the data-loss bug this endpoint exists to prevent,
  reintroduced in the client.** `renameLocalWorkout` set `dirty` as well as
  `name_dirty`, and the push called `replaceItems` unconditionally — so a
  rename re-uploaded `items_json` from the cache. And the cache can be stale:
  the detail screen reads the server's copy into React state without ever
  writing it back. Add an exercise on the web, open the workout on the phone,
  rename it, and the phone's older list silently replaced the server's, with no
  signal anywhere. `dirty` now means only "the items are owed"; every "is this
  row owed anything" query tests both flags through one shared `workoutOwed`
  fragment, so the next flag cannot be added to the push loop but forgotten in
  the pending count.
- **The push order was flipped to items-first, rename-last**, matching the
  session module — whose ordering was settled by a real incident and which this
  branch had reasoned its way out of. Rename-first sounds safer (it avoids "new
  items under the old name") but that state is transient and self-correcting,
  while a *permanently* refused rename sent first aborts the row before the
  items go out, so every retry replays the same doomed request and the item
  edits never land at all. That is not hypothetical: an app deployed ahead of
  the API gets 405 here, which the client classifies as permanent.
- **A migration test that tested the wrong thing.** The v16 test was named
  "upgrading an existing database" but built its fixture with `openFixture()` +
  `migrate()` — a blank database at v0, i.e. a *fresh install*. So it exercised
  the `CREATE TABLE`, which already declares the column, and deleting the whole
  `if (current < 16)` branch left it green. It now hand-builds a v15-shaped
  database the way the v6 and v7 tests already did. Both mutations (deleting the
  branch, and flipping the default to 1) now turn it red.
- **Two Tailwind classes on the web input were not tokens at all.**
  `border-border` and `focus:border-accent` generated no CSS — `globals.css`
  defines `--color-line` and `--color-lime`, not those — so the underline fell
  back to `currentColor` and, worse, `outline-none` suppressed the base
  `:focus-visible` outline with nothing replacing it. The focused field was
  visually identical to the unfocused one, a WCAG 2.4.7 failure on a control
  whose entire job is text entry. **Nothing in `verify` can catch an undefined
  Tailwind colour** — lint and typecheck both pass on it, which is worth
  remembering the next time a class name is invented rather than copied.
- **Mobile's Done button ate its first tap.** The `ScrollView` lacked
  `keyboardShouldPersistTaps="handled"`, so React Native spent the first tap
  outside the focused input dismissing the keyboard and the button never saw
  it. Ten other screens already set it. It hides on the Simulator, where a
  hardware keyboard means the soft keyboard is never up — which is exactly how
  it survived the device verification above.
- **Only the name.** `notes`, `goal` and `visibility` are still fixed at
  creation. `PATCH` is the natural home for them and the shape already allows
  it, but adding fields nobody asked for would have been speculative — the
  request was the title.
- **A rename does not renumber anything.** Sessions already logged from the
  template keep the name they were started with, which is correct (they record
  what happened) but means the history list and the template can disagree after
  a rename. Nothing surfaces that.
- **The web rename is not device-verified against a running backend** the way
  the mobile one is; it typechecks and builds, and the API underneath it has
  integration tests, but the browser flow was not exercised end to end here.


## 2026-08-04 — The Plan screen's chrome stops shouting, and the button stops sitting on the text

Three complaints about one screen — "My workouts / Shared on top is rough and
ugly", "New Workout is too bold", "we need more graceful design" — and they turn
out to be one problem: **everything on this screen was drawn at the same
weight.** The scope switch was two full-width pills whose selected half took the
accent as a solid fill, sitting directly above a full-width accent slab. Two
lime bars, one above the other, neither reading as more important than the
other, and no way to tell which one was the thing you press to *do* something.

**The scope switch is chrome, not an action.** Choosing between two views of the
same list is navigation; it does not deserve the colour reserved for "this
button does something". It becomes a tab strip: a hairline under the row and a
2pt accent bar under the selected half, with the label in `accent.ink`.

**It was a raised thumb first, and review caught two things wrong with that.**
Putting `accent.ink` on `surfaceRaised` measured **4.37:1** on the blue theme —
under the 4.5 the palette rule requires, and on the one surface
`validate_palette.mjs` never checks. It asserts `ink` against `surface` only, so
the gate was green and structurally blind to it. Moving the label to the page
ground puts it back under the existing assertion; blue, the worst case, is
5.15:1.

The second problem was worse and I had not seen it at all: `surfaceRaised` on
`surface` is a **1.09:1** step. The "raised thumb" was invisible, so which
segment was selected came down to hue alone — and on the blue and purple themes
the selected label is *darker* than the unselected one, so the active segment
read as the recessed one. A bar that is present or absent is not a colour, and
as a non-text indicator it clears 3:1 on every theme (purple, the worst, 3.92).

**The primary action becomes a compact pill in the corner.** `New workout` was
`left: 16, right: 16` with 16pt of vertical padding — an accent bar the full
width of the display, which is the loudest thing an interface can do, for what
is (on a screen already listing your templates) an occasional action. It keeps
the accent, because it *is* the primary action, but at the size of one.

### The bug hiding underneath the complaint

The full-width bar **sat on top of the planner's "Long-press a planned session
to remove it" hint**, which is why the screen read as cluttered rather than
merely loud. The list reserved `TAB_BAR_CLEARANCE` (28pt) below its content
while the floating bar occupied roughly 68 — so the last ~40pt of scrollable
content could never be seen at any scroll position. That is a layout bug, not a
style preference, and no amount of restyling would have fixed it; the list now
reserves `TAB_BAR_CLEARANCE + FAB_CLEARANCE`, verified on the Simulator by
scrolling to the end and confirming the final card clears the pill.

The clearance is unconditional even though only the `mine` scope shows the
pill — otherwise switching scope changes the scroll extent under the reader's
thumb.

### What review caught, and one thing my own mutation test did

**The screen opened on yesterday.** `viewDay` was a `Date` captured at mount and
refreshed by nothing, while `now` re-reads on focus and on AppState. Leaving the
app on Today overnight therefore reopened it in *past mode* — yesterday in the
switcher, plans dimmed and marked "Not logged" — with the athlete having
navigated nowhere. It is a day **offset** now, derived from `now`, so every
refresh re-derives it and the class is gone rather than patched at the two
places that happened to refresh.

**A blanket `opacity: 0.55` on the past card** composited every ink inside it:
"Not logged" fell to 1.96:1 and the BJJ eyebrow to 2.51:1 — the latter being the
exact figure the palette cites as its reason for banning `textDim` from a done
row, and failing specifically for this app's headline discipline. The card is
not dimmed at all now; "Not logged" is `warn` at full strength, which is also
what it means.

And one that arrived from my own mutation testing rather than from review: the
first fix for the outside-the-week bug passed *two* plan lists and matched their
union. Three mutations of it stayed green, which is how it came out that the
wider list was **inert** — `matchPlans` groups by day, so plans on other days
can never compete for this day's sessions, and plans on the same day are the
same rows. A parameter that cannot change the answer reads as a safeguard and is
scenery. `owedOn(sessions, dayPlans)` is what was ever needed.

### Gaps this leaves

- **An intermittent SQLite error was seen on this screen and is NOT fixed here.**
  "Calling the 'execAsync' function has failed → Caused by: cannot rollback - no
  transaction is active", rendered in the screen's own error slot. It appeared
  once and did not reproduce; it also reproduces nothing about this change,
  which touches only `StyleSheet` entries. The likely cause is that
  `expo-sqlite` shares one connection while `lib/sessionStore.ts` has two
  `withTransactionAsync` blocks (`cacheWorkouts` and `cacheExercises`) that the
  Plan and Library screens can enter concurrently — the inner BEGIN is a no-op,
  the first COMMIT ends the transaction for both, and the second block's error
  path then rolls back nothing. Left for its own change, with the note that a
  *caching* failure probably should not be a red banner over the athlete's plan
  at all.
- **`validate_palette.mjs` checks `ink` against `surface` and nothing else.**
  That is why a 4.37:1 label passed the gate. Any future component that puts
  accent text on `surfaceRaised` — or on a card, or on any ground but the two
  the validator knows — is unchecked in exactly the same way. Extending it to
  every ground the palette actually renders on is the real fix; this change
  only stopped standing on the hole.
- **A second review round found the font-scale fix was itself half a fix.**
  `PixelRatio.getFontScale()` is a snapshot of `Dimensions`, so reading it into
  a module-level `const` freezes it at bundle load — and iOS does not restart
  the JS bundle when you change the text size and come back. The exact person
  the formula existed for would have kept the old clearance until the next cold
  start. It reads `useWindowDimensions().fontScale` now. The same pass caught
  that the formula is linear in *one* line box, and that at the largest sizes
  "New workout" is wider than the screen — so the label is `numberOfLines={1}`,
  which is what keeps the arithmetic true rather than merely tidy.
- **`FAB_CLEARANCE` is derived from the font scale, and that was a second
  near-miss.** A fixed 72 clears at default and through XXXL but re-creates the
  overlap from Accessibility Large upwards, because the label grows and the
  paddings do not. Nothing in this app caps `maxFontSizeMultiplier`, so that is
  reachable. It is `44 + 20 * PixelRatio.getFontScale()` now — but note the
  Simulator run that verified the fix was at default size, so the large-text
  behaviour is reasoned, not observed.
- **The lint ratchet has no headroom, and this change nearly spent it twice.**
  Moving a `const` above the import block cost eleven `import/first` warnings in
  one edit — 66 against a limit of 55. It is worth knowing that the ratchet
  catches formatting accidents, not just new code smells.
- The `Shared` scope still has no empty state distinct from "nobody has
  published anything", which is a content problem the restyle does not touch.

## 2026-08-04 — The belt becomes a photograph, and the accent becomes a setting

Two pieces of the mobile redesign, and both turned into arguments about
measurement rather than taste.

### The palette gate that was cited for months and never existed

`constants/Colors.ts` and `lib/libraryTiles.ts` had both been telling readers
to run `validate_palette.js` before adding a colour. It was never committed —
`git log --diff-filter=A` finds nothing. Every hue added since was justified
against a tool that did not exist, and the figures in those comments were
measured once, by hand.

`scripts/validate_palette.mjs` is now that tool: WCAG contrast plus CIEDE2000
ΔE, the latter recomputed under simulated protanopia, deuteranopia and
tritanopia. Two safeguards make it trustworthy rather than decorative — it
**reproduces all seven hand-measured figures already in `Colors.ts` before it
reports anything**, and it **reads the palette out of `Colors.ts` rather than
keeping a copy** (the first draft kept a copy and within one edit was
validating a colour the app no longer used).

It has now refuted three recorded claims, none of which were visible by eye:

- The accent drawn in the mockup (#8B5CF6) fails twice — white on it is
  4.23:1, under AA for a label like "1M", and it sits ΔE 16.5 from the
  categorical `info` blue, with pinker purples falling to 14.3. That is the
  exact collision the note on `info` had been warning about. #7A50EC clears
  both at 5.02:1 and ΔE 20.7.
- The first black-belt accent sat **ΔE 8.0 from `danger` under tritanopia**,
  where reds converge: a black belt's masthead would have been the colour of
  an error message. A gamut search under every constraint at once found 1099
  admissible colours; #DF0010 is the most belt-like, and is a truer belt red
  than the coral it replaced.
- `LibraryTile` recorded its four intents as clearing "worst adjacent pair ΔE
  21.7 CVD". Run properly, defend-versus-hold measured **14.7 for a
  protanope** — a mid blue and a mid grey converge. The neutral moved a step
  darker into `vola.tileHold`; worst pair is now 19.5.

The sport colours were caught the same way before shipping: BJJ's light purple
and running's light blue measured **ΔE 4.7 for a deuteranope** while looking
21.9 apart to me. A mat day would have been indistinguishable from a run in
the one view meant to separate them.

### The accent is a setting, not a constant

Five themes — green (default), yellow, blue, purple, orange — each validated on
fill contrast, ink-on-fill and as-text, picked in Settings from swatches rather
than a sub-screen (a unit system is a fact you verify by reading a word; an
accent is a look, and tapping a swatch recolours the tab bar two inches below).

The rule that makes a swappable accent safe: **the accent is identity and
interaction; anything encoding a reading stays fixed.** 77 of 87 `vola.lime`
references moved. The ten that stayed are the readings — the grid ramp, the
weekly bars, ticked sets, scored rounds, the planned-day marker, a technique's
category. A measurement whose colour depends on a preference is a measurement
nobody can learn to read.

Legibility was never the constraint; every candidate cleared it. What decides
the set is that the palette already spends hues on meaning — pink is out at ΔE
3.6 from `danger`, teal at 7.9 from `info`, and orange ships with its
measurement recorded because `danger` is a filled surface in exactly one
component and the two never meet as peers.

### Icons stopped being drawn from Views

The rule was that `react-native-svg` is a native dependency and therefore a
prebuild for everyone. **That premise was wrong for this SDK** — it is in
Expo's `bundledNativeModules.json`, so it ships inside Expo Go. The old rule
had a real cost: a check mark drawn from two borders rendered as a downward
chevron for a stretch, with 241 tests green, caught only by looking at a
Simulator.

Geometry is now **generated** from `assets/brand/icons/*.svg` by
`scripts/generate_icons.mjs` — 25 icons, `--check` in `verify`, and the
generator asserts the kit's own uniformity rather than assuming it.

### The belt, photographed

Five supplied renders, transparent webp, 416KB for the set. The masthead uses
them; `Belt.tsx` stays for lists, where a 1024px photograph in a 44pt row is
mush.

**A stripe render was supplied and is deliberately unused.** At the size this
draws, a photographic stripe's weave is invisible while the arithmetic to place
0–4 of them is identical — and drawing them makes every combination exact,
including black-belt degrees on the red bar. Getting the geometry right took
two wrong turns worth recording: a **bounding-box diagonal is not an angle**
(42° instead of 28.5°), and a second measurement from the purple belt came out
at 20.7° because its predicate caught the belt's own shading. Only the black
belt's red bar segments cleanly; its numbers render correctly on all five,
confirmed by compositing every belt offline with the component's own
arithmetic before any of it went into the app.

### Worth keeping

Three of this stretch's defects were found by looking at a Simulator and could
not have been found any other way: the tab underline clipped by the safe area,
the same underline then rendering transparent on every tab because the
navigator sets `aria-selected` rather than `accessibilityState.selected`, and
future-day bars dimmed to 1.28:1 apart from rest days — a distinction that
existed in the branch and not on the screen.

And a dev-loop trap that cost real time and looks exactly like a regression:
**Metro's HMR wedges** on a change that adds a hook across many files, serving
a stale bundle while logging `ReferenceError` and re-bundling one module at a
time. Screenshots in that window show the old UI. `expo start --clear` is the
fix; typecheck stays clean throughout, which is the tell.

## 2026-08-04 — The session screens, and a card fill that cost a measured figure

The last of the redesign: the live logging screen, the start picker and the
exercise picker take the language the dashboard screens already have.

**The live screen gets deliberately less decoration.** It is used standing up,
one-handed, with twenty seconds between sets, so what it needed was structure
rather than ornament: each exercise is now a card, where before it was a bare
stack separated from the next by an 8pt gap — the same gap that sits between
the set rows *inside* it, so the boundary between movements was carried
entirely by a name in bold.

### The fill that had to come back out

The first version of that card filled it with `surface` and stepped the set
rows up to `surfaceRaised`. Review caught that both halves were wrong, and the
reasoning is worth keeping because neither is visible in a screenshot:

- **The step bought nothing.** `surfaceRaised` on `surface` is 1.09:1 — the
  same pair this log already records as invisible, which is why the Plan tab's
  raised thumb became an accent bar.
- **The fill cost something real.** `setDone` is lime at 15% *solved against
  `surface`*, so moving the rows to `surfaceRaised` took done-versus-undone
  from 1.46:1 to 1.34:1 — most of the margin that justified 15% over the
  rejected 10% (recorded at 1.26:1 as "stops being obvious in daylight").
- **And it could not be re-tinted back.** Lime at 15% re-solved over
  `surfaceRaised` is #2F402B, which restores 1.50 done-versus-row and drops
  `textMuted` to 4.17:1 — under the 4.5 the original tuning was held to. The
  ground got lighter and there was no headroom left.

So the card is a border and padding with no fill: the boundary is a line rather
than a ground, and every figure recorded in `Colors.ts` stays true.

**Nothing would have caught this.** `validate_palette.mjs` asserts inks against
`surface` and against `setDone`, and checks `surfaceRaised` only for accent and
belt *fills*. It passes green either way. That is the same gap this log already
records — a ground the validator does not know about is unchecked — reached by
a second route.

### Two bugs found by looking rather than reading

- **The exercise picker was drawing 520 blank squares.** It rendered an image
  when an exercise had one, and only 4 of 524 do. That is exactly the bug
  `LibraryTile` was written to solve, repeating in a second screen.
- **Today's week row was clipping `1,05…`** where the volume reads `1,058lb`.
  The `fit` ladder had never been switched on there — added for the You
  screen's tiles, and Today's stats left at full size. Invisible while the
  account was metric and `480kg` fitted; imperial pushed it over. Review then
  found the *same* bug one tap above it, in the calendar's month totals, where
  the figures are strictly larger and so clip sooner.

### Worth keeping

The commit message claimed the set rows "step up to `surfaceRaised` to stay
distinct". They did not — 1.09:1 is not a step. A message that describes an
intention rather than a measurement is how a wrong change survives review, and
this one only did not because the reviewer recomputed it.

## 2026-08-04 — The Library gets strength filters, by taking two rows away

"The library for strength should also have filters — muscle group, push/pull.
They should not be all visible; first they see two things and when clicked they
can choose a specific filter. Same for BJJ so it's not crowded."

Two requests in one, and they pull against each other: **add** axes to a header
that is already the screen's biggest problem. The log has recorded that problem
for a while — search, sport chips, position chips, belt chips and the glossary
all sit pinned above the list, roughly 300pt before the first result on a screen
whose entire job is showing results. Two more rows would have made it worse.

So the rows became **buttons**. Each axis is one control that names itself and
shows its current value; tapping it opens a sheet with the options. Position and
belt stop being two full scroll rows, muscle and movement arrive without adding
any, and the header gets shorter while gaining capability.

**The raw fields are unusable as filters, so the grouping is the feature.** The
catalog carries **58 distinct `primary_muscles`** — `teres-minor`,
`brachioradialis`, `lateral-neck` — and 15 `movement_pattern`s. Nobody browses a
gym app looking for their subscapularis. And "push", the thing actually asked
for, **is not a value in the data at all**: it is `horizontal_push` and
`vertical_push`. `lib/exerciseFacets.ts` maps both vocabularies to nine muscle
groups and eleven movement groups, chosen to be things a person would say out
loud.

Two judgement calls in that map worth recording. **Glutes are their own group
rather than part of Legs** — anatomically odd, and right here, because `glutes`
is the single most common primary muscle in the catalog (138 of 504) and folding
it into Legs makes that group a third of everything. And **only `primary_muscles`
count**: almost every exercise works almost everything secondarily, so including
secondaries makes "Chest" return most of the catalog and the filter stops
meaning anything.

**The mapping is hand-maintained, so a test holds it to the real catalog.** An
unmapped muscle fails *silently* — its exercises stay in the list, stay
searchable, and simply cannot be reached through the filter, so nothing looks
broken and a handful of exercises are quietly undiscoverable. The suite reads
the shipped `exercises.json` (not a fixture, which would only ever assert that
the map covers what someone remembered to put in the fixture) and asserts every
raw value lands in a group, every group is reachable by something, and no value
is claimed twice. Adding a muscle to the catalog without adding it here turns it
red. All four failure modes were mutation-checked.

**Client-side, and declared in the registry anyway.** `GET /v1/exercises` takes
only `q` and `sport`, but `movement_pattern` and `primary_muscles` are already
on every row the screen has loaded — so this filters data in hand, works
offline, and needs no query parameter. Strength still gains
`Facets: ["muscle", "movement"]` in the discipline registry, because that list
is what tells a client which axes a discipline is browsed on; the buttons are
driven by it rather than by `sport === 'strength'`, so a control is never
rendered against a catalog it cannot filter. Same rule the position and belt
rows already followed.

**The lint ratchet went DOWN**, 55 → 54: deleting the two hand-written scroll
rows took a warning with them. That is the direction the ratchet is supposed to
move and the first time it has.

### What review caught, and one thing my own mutation test did

**The screen opened on yesterday.** `viewDay` was a `Date` captured at mount and
refreshed by nothing, while `now` re-reads on focus and on AppState. Leaving the
app on Today overnight therefore reopened it in *past mode* — yesterday in the
switcher, plans dimmed and marked "Not logged" — with the athlete having
navigated nowhere. It is a day **offset** now, derived from `now`, so every
refresh re-derives it and the class is gone rather than patched at the two
places that happened to refresh.

**A blanket `opacity: 0.55` on the past card** composited every ink inside it:
"Not logged" fell to 1.96:1 and the BJJ eyebrow to 2.51:1 — the latter being the
exact figure the palette cites as its reason for banning `textDim` from a done
row, and failing specifically for this app's headline discipline. The card is
not dimmed at all now; "Not logged" is `warn` at full strength, which is also
what it means.

And one that arrived from my own mutation testing rather than from review: the
first fix for the outside-the-week bug passed *two* plan lists and matched their
union. Three mutations of it stayed green, which is how it came out that the
wider list was **inert** — `matchPlans` groups by day, so plans on other days
can never compete for this day's sessions, and plans on the same day are the
same rows. A parameter that cannot change the answer reads as a safeguard and is
scenery. `owedOn(sessions, dayPlans)` is what was ever needed.

### Gaps this leaves

- Verified on the Simulator against a local API carrying the new registry
  facets: both buttons appear under Strength, `Muscle → Chest` narrows to chest
  primaries, and `Movement → Push` composes with it — returning Bench Press
  (horizontal) and Assisted Dip (vertical) under one option while dropping the
  isolation work, which is the fold doing its job. Position and Belt render the
  same way under BJJ, with the saved belt cap intact. **Note the staging API
  does not carry these facets until this deploys**, so the buttons will not
  appear on a client pointed at it — the registry is the gate.
- **`Movement → Pull` used to contain no biceps curl**, and that was the
  mapping decision most likely to read as broken. `movement_pattern` is
  single-valued and `isolation` holds 142 of 504 rows — 51 arms, 28 shoulders —
  so every curl, fly and lateral raise sat under Isolation and under *neither*
  Push nor Pull. The data was being reported faithfully and no lifter would
  have agreed. An isolation row now also answers the axis its muscle implies,
  so a curl appears under both Pull and Isolation, which is honest: it is an
  isolation pull. **This is a training convention, not anatomy** — a lateral
  raise is abduction, neither pressing nor pulling, and it lands in Push
  because that is the day it is programmed on. Anything with no such
  convention is deliberately in neither and stays reachable through Isolation
  and its muscle group — including the two upper-body exclusions someone will
  query, rotator cuff (prehab) and spinal erectors (hinge work).

  **The fix for the silent-failure problem reintroduced it.** Review
  mutation-proved that deleting `lats`, `upper-traps` or `chest` from the new
  sets removed 4–8 real exercises from a facet with the whole suite still
  green: 17 of the 21 members had no assertion at all. The sets are now held to
  the catalog by NAME — Cable Fly is a push, Barbell Shrug is a pull — which is
  a non-circular oracle, plus a check that every member is a muscle string the
  catalog actually uses, since a typo like `lateral-delt` is otherwise a silent
  no-op. The generic `shoulders` and `serratus` came back out on the same
  evidence: this catalog records `shoulders` as a stabiliser, so it was pulling
  a Kettlebell Windmill and a Suspension Pike into Push.
- **The picker is a glass sheet, not a page.** It shipped as
  `presentationStyle="pageSheet"` — the whole display taken over to offer nine
  short options, a modal context switch for what is really a dropdown. It is
  `transparent` now, sized to its content, anchored to the bottom, with a grab
  handle and tap-outside-to-dismiss, so the list you are filtering stays
  visible behind it. The glass follows `BjjRankHeader`'s recipe including its
  reasoning — **not** `expo-blur`, because a BlurView samples what is behind it
  and would cost a native view to blur a nearly-flat ground; glass on a dark
  ground is a translucent panel, a lit top-left edge and a wash. One deliberate
  deviation: the rank card uses `0.72` because it sits on empty ground, while
  this sits over a dense list where the exercise names read straight through
  the option labels at that value. `0.93` is the brief — enough to see what you
  are filtering, not enough to read it.
- **Review found the coverage test was watching the wrong door.** Its oracle
  was the shipped catalog, so `grappling` — legal in the API's closed
  vocabulary, used by no row — was unmapped and invisible to it. The first
  console-authored exercise using it would have been silently unreachable,
  which is precisely the failure the suite exists to prevent. It now asserts
  the API vocabulary as well as the rows, and reads `exercises.additions.json`
  too, since that is the file console-authored content actually lands in.
- **`primary_muscles` is validated against no vocabulary anywhere in the
  backend** — not in the seed's `validate`, not in `ValidateForWrite`. So the
  admin console can mint free-text muscles that no test here can see. The
  coverage guarantee is "everything a deploy ships", not "everything the API
  accepts", and the module comment now says so.
- **Only reachable once a sport is chosen.** With the sport chip on "All" no
  facet buttons appear, because `moduleFor('')` matches no module — exactly the
  behaviour position and belt already had. It is consistent, and it does mean
  the strength axes are two taps away rather than one.
- **`apps/web`'s Library did not get this.** The belt filter went to both
  clients; this went to mobile only, because the request was about the crowded
  phone screen. Web still has its own filter row, so the two libraries now
  differ in what they can narrow by.
- **Nine muscle groups and eleven movement groups is a lot of options in a
  sheet**, and no data says these are the right cuts — they are a reading of
  the catalog, not a measured taxonomy. Worth revisiting once anyone has used
  it against a real training week.


## 2026-08-05 — A plan stops being drawn twice, by building the query the migration promised

> "when we plan something that workouts should pop up on todays screen as to be
> completed, currently I had planned and then logged and I see both which is
> not correct."

A day that was planned and then trained showed two rows: the session, and the
plan still sitting beside it saying "Planned". It reads as two sessions when
there was one.

### This was not a merge bug

`TrainingCalendar`'s `DayRow` concatenated `sessions` and `planned` with no
cross-check, and it did so **deliberately**. Non-reconciliation was documented
in five independent places — the migration, the Go module, the mobile client,
the web calendar, and the OpenAPI schema — and the migration argued it at
length:

> Auto-consuming a plan when a session lands would need a rule for "does this
> session count as that plan" that nobody can state — same sport? same
> template? same day? — and would silently rewrite the athlete's own record of
> what they meant to do. Adherence is therefore a *query* over both tables,
> computed when asked, rather than a status column that has to be kept true.

The second clause is about **storing** a status, and does not survive contact
with a read-time query — the complaint is about **seeing** two rows. The
comment's own last sentence describes the fix, and nobody had written it.

But the first clause is not about storage at all. "Nobody can state the rule"
is a claim about the *rule*, and an unstatable rule computed on read is still
unstatable. Answering it means **overturning half that argument, not completing
it** — legitimate, since the comment asserted rather than proved, but it should
be recorded as a reversal. Review caught the first draft of this entry framing
it as a fulfilment. Same for one of the five sites: `apps/web`'s calendar said
adherence is "a comparison the reader makes", which is a display claim, so the
blanket "it was only ever about writing" was wrong there specifically.

### The rule the comment said nobody could state

**A plan is met by a logged session on the same day in the same sport, matched
one-to-one and greedily.** `apps/mobile/lib/adherence.ts`, ~40 lines, pure.

Each clause answers one of the cases the migration was protecting, and each is a
test:

- **Same day, same sport — the template is not part of it.** You planned
  Workout 1 and did Workout 2; you did your strength session. Requiring the
  template to match would leave "Workout 1 · Planned" sitting next to the
  workout you actually logged, which is the duplication being removed.
  **This one is a reversal, not a preservation** — the migration listed
  "trained with something else entirely" among the cases it was protecting and
  named "same template?" as unanswerable. This answers it *no*, narrowing
  "something else" to a different sport. The first draft of this entry claimed
  the case was kept while the test asserted the opposite; both could not stand.
- **One-to-one.** Two planned BJJ sessions need two logged ones. A two-a-day is
  not half-erased by a single class — and `(user_id, day)` is deliberately not
  unique for exactly this reason.
- **A day trained twice, or trained with something else, still shows every
  session.** Sessions are never hidden by this. Only a *met* plan stops being
  drawn a second time.
- **Greedy, in input order.** Which of two indistinguishable same-sport plans
  gets credited is arbitrary — they differ only by id and render identically.

Nothing writes. There is still no status column, no `session_id`, no
`completed_at`. Recomputing on read buys something a column could not: **delete
the session and its plan is pending again**, verified on the Simulator by doing
exactly that. A stored flag would survive the delete and keep claiming the day
was trained. That is the strongest argument for the query, and it is the
migration's own argument, honoured rather than overridden.

The day-list marker moved rather than disappeared: the session that met a plan
carries `planned` in its meta line, last, because what was done outranks what
was meant.

### Two surfaces, and the second was louder

The day list was the reported one. The Today lead card was worse: it filtered
today's plans **inside the loader that read them**, so the answer froze at the
moment plans were fetched and finishing a session left the card still offering
"STRENGTH · Strength session · Start" for the class just logged. It is a
`useMemo` over both lists now, so it cannot go stale.

### What was updated, and one thing worth flagging

All five documentation sites now say what actually ships — storage
reconciliation still does not happen, display reconciliation does, here is the
rule. That includes **editing an already-applied migration's comment**
(`000033_create_plans.up.sql`). `golang-migrate` tracks version numbers and does
not checksum, so this is safe, and the alternative was leaving the file where
readers look stating the opposite of the behaviour. Worth knowing it was a
deliberate call rather than an oversight.

### What review caught, and one thing my own mutation test did

**The screen opened on yesterday.** `viewDay` was a `Date` captured at mount and
refreshed by nothing, while `now` re-reads on focus and on AppState. Leaving the
app on Today overnight therefore reopened it in *past mode* — yesterday in the
switcher, plans dimmed and marked "Not logged" — with the athlete having
navigated nowhere. It is a day **offset** now, derived from `now`, so every
refresh re-derives it and the class is gone rather than patched at the two
places that happened to refresh.

**A blanket `opacity: 0.55` on the past card** composited every ink inside it:
"Not logged" fell to 1.96:1 and the BJJ eyebrow to 2.51:1 — the latter being the
exact figure the palette cites as its reason for banning `textDim` from a done
row, and failing specifically for this app's headline discipline. The card is
not dimmed at all now; "Not logged" is `warn` at full strength, which is also
what it means.

And one that arrived from my own mutation testing rather than from review: the
first fix for the outside-the-week bug passed *two* plan lists and matched their
union. Three mutations of it stayed green, which is how it came out that the
wider list was **inert** — `matchPlans` groups by day, so plans on other days
can never compete for this day's sessions, and plans on the same day are the
same rows. A parameter that cannot change the answer reads as a safeguard and is
scenery. `owedOn(sessions, dayPlans)` is what was ever needed.

### Gaps

- **`apps/web`'s calendar has not adopted the rule and still shows both.** Its
  answer to the same duplication was to make the two chips legibly different (a
  check glyph vs a hollow ring), which works there because a day is a chip
  rather than a list. But two clients computing adherence differently is
  precisely how the position vocabulary rotted, and this should be reconciled
  deliberately rather than left to drift.
- **"Nothing planned for today" is now reachable by completing your plan**,
  which is the wrong sentence for that state — you did not have nothing
  planned, you finished it. The empty state needs to distinguish *nothing
  scheduled* from *all done*. Being addressed in the Today-surface work.
- **Matching is by sport, so a mislabelled session cannot meet a plan.** Log a
  BJJ class as a strength session and both rows come back. Correct, arguably,
  but it will look like a bug to whoever does it.
- **An unfinished session meets a plan.** `session/start.tsx` auto-starts a
  planned template on mount, so opening the chooser is enough to clear the plan
  from the pending list. Back out and the day shows a session that will read
  UNFINISHED. Masked on Today (the active session outranks the card) but not in
  the week list. Undecided rather than decided — an `ended_at` filter is one
  line, and the argument against it is that a session in progress *is* the plan
  being met.
- **Adherence is computed in two places** — `index.tsx` for the lead card and
  `TrainingCalendar` for the list — against slightly different session lists.
  They agree today only because the plan list never leaves the current week and
  the current week is always inside the most recent 30. Should be computed once
  and passed down; the file already warns against exactly this class of
  disagreement.
- **The rule cannot be shared with `apps/web`**, which is why the divergence
  above has nowhere to land: `apps/web` cannot import from `apps/mobile`.
  `pnpm-workspace.yaml` already declares `packages/*` with no such directory —
  that, or a backend-computed answer, is the actual destination.
## 2026-08-05 — The Library glossary stops calling the reader a beginner

"In Library it should not say new to BJJ. Just have start with positions."

The row was labelled **"NEW TO BJJ? START WITH THE POSITIONS"**. It is one line
of copy and worth the entry, because the problem is not the wording — it is
that the label **names its reader**.

Naming the reader does two things, both bad. It tells everyone who is not new
that the row is not for them, when a purple belt looking up Leg
Entanglement is exactly who it serves — the glossary is a reference, not an onboarding step.
And it greets a returning athlete as a beginner every time they open the tab,
which is the one thing `docs/decisions/*` has been explicit about avoiding
since the UX direction was written down: no shame-based framing.

**"START WITH POSITIONS"** is an instruction. It addresses everyone, says the
same thing, and is shorter. Changed on **both** clients — `apps/web`'s Library
carried the identical string, and leaving one behind is how the two drift.

### Gaps this leaves

- The glossary is still the largest single block in the Library header, which
  the log has flagged before. Shortening its label does not change that; moving
  it into the list's `ListHeaderComponent` so it scrolls away is still the real
  fix, and is still unstarted.
## 2026-08-05 — The stripes get measured per belt, because a bar is not a rectangle

The rank card shipped with its stripes visibly off the bar — far enough that
the user marked them on a screenshot. Two separate mistakes, and the second is
the interesting one.

### One geometry for five different renders

`BeltPhoto` carried a single `BAR` constant — centre, angle, length, width —
measured off the **black belt's** red bar and applied to all five. The comment
defending that choice was honest about how it was arrived at (a second attempt
measured from the purple belt came out worse, so the red bar's numbers won) but
the conclusion was wrong: the renders share a framing, not a bar position.
Measured against each render's actual bar, the shared numbers put white's
stripes ~25px high and purple's ~23px at 1024px wide. Brown and black sit
noticeably further up the belt than the other three, which is exactly what the
user described.

### The angle was wrong, and the reason it was wrong is not obvious

The shipped angle was 28.48°. The bars' long edges actually run at 33.6°–38.1°.
The old figure was not a sloppy measurement — it was the **principal axis of
the bar's pixels**, computed carefully, and recorded in the comment as a
deliberate improvement over an earlier bounding-box diagonal.

It was wrong because the bar is not a rectangle on screen. It is a rectangle in
the world photographed at an angle, so it arrives as a quadrilateral in
perspective: its two long edges are not parallel, and the angle between long
and short edges runs from 2.2° off square (brown) to 10.6° (black). **The
principal axis of a skewed parallelogram is not parallel to its long edges.**
PCA answers the question correctly and the question was the wrong one.

That also explains why no amount of nudging the centre had fixed it. A single
`rotate` applies one angle to a shape that has two; whichever end you line up,
the other hangs off.

### What replaced it

`lib/beltBar.ts` holds a measured quadrilateral per belt, and derives stripes by
interpolating **between the bar's own two long edges**. That is
perspective-correct without any perspective arithmetic: the edges already
converge the way the photograph does, so a stripe drawn between them converges
with it, and a stripe near the tip comes out fractionally shorter than one near
the body — as it does on the render. `BeltPhoto` draws them as `react-native-svg`
polygons, since a rotated `View` cannot express a skew.

Measuring them needed a per-belt threshold rather than one rule: brown's bar is
only ~36 away from brown in colour distance, white's is ~300 away from white, so
a single cutoff finds nothing on one belt or selects the whole belt on another.
Mask, largest connected component, convex hull, simplify to four corners —
then verified by drawing the corners back over each render, and confirmed on the
Simulator at the real 215pt.

### The test that is not circular, and the ones that are

Containment — every stripe inside its bar, on every belt, at every count — is
the load-bearing assertion, and it is **circular by construction**: it checks
the stripes against the same quads it is testing, so a table measured off the
wrong artwork satisfies it perfectly. Mutation testing showed this plainly.
Six mutations of the placement arithmetic all go red; replacing all five quads
with one belt's does not, and is caught only by a separate identity check.

So the suite also **pins the SHA-256 of the five renders**. If a render is
replaced the numbers stay valid-looking, the app keeps drawing, and the stripes
drift off a bar that has moved — invisible in a diff of a binary asset. That
test failing means re-measure, not update the hash.

One mutation survived the first pass: spacing for `1/slots` instead of
`1/(slots + 1)` keeps every stripe inside the bar and merely crowds both ends.
Containment cannot see it because it is not a containment failure. Added an
explicit clearance assertion for it.

### Gaps this leaves

- **The quads are facts about five specific image files, and re-measuring is
  still a hand operation.** The hash test says when they go stale; nothing
  re-derives them. A `scripts/measure_belt_bars.py` was written and then
  dropped, because it only reproduced four of the five: **brown is the hard
  case** and any future attempt should start there. Its bar is ~36 away from
  the belt in colour distance where white's is ~300, which is small enough that
  the belt's own ribbing and the shadow under the crossed strap outrank it —
  a fixed threshold, Otsu, and a solidity-scored threshold sweep all pick the
  strap shadow or fragment the bar into pieces. Colour distance from a global
  belt median is the wrong feature for brown; something local, or something
  using darkness rather than distance, probably is not. Shipping a script that
  needed a hand-tuned exception for one belt would have made the numbers look
  reproducible without being so.
- **`Belt.tsx` — the flat drawn belt used in lists — clamps stripes to 6 for
  every belt** (`Math.max(0, Math.min(belt === 'black' ? degree : stripes, 6))`),
  while `MAX_STRIPES` is 4. A coloured belt with a bad rank would draw five or
  six stripes in a list and four on the card. Untouched here: different
  component, flat geometry, no perspective involved.
- **The stripe colour is one constant for all five belts.** Correct on the
  current renders; if a belt is ever supplied with a differently-lit bar it
  will need its own value, and there is no seam for that.

## 2026-08-05 — One shape for "which period", and the Plan week folds away

> "anything that will be changing other page on a specific view I want this way
> of doing it, minimal and nice" — with a reference showing `‹ TODAY 📅 ›`.
> "the calendar should be collapcable in the planning section."

### The switcher

`components/ui/PeriodSwitcher` — a chevron, a label, a chevron. The chevrons
step; the label, when pressable, opens the calendar that jumps somewhere
distant. Anything that changes which period a screen shows should use it.

It also resolves an old objection rather than ignoring it. The Plan header's
first cut was `‹ AUGUST › ›` — the title's disclosure chevron immediately
followed by the next-week arrow, two identical glyphs side by side doing
entirely different jobs. The fix at the time was to pull them apart: title
left, stepper pair right, plus a Today pill in the middle when you had
navigated. Three controls, three places, one job.

Putting the label *between* the arrows solves the same collision differently:
exactly one left-chevron and one right-chevron, both steppers, and the
disclosure carried by an icon inside the label. Nothing looks like anything
else, and it is one control instead of three.

### The Today pill is gone, and the label took its job

That pill was defended on the grounds that it was the only thing telling you
you had navigated at all. True, and the label is better at it: it reads
**THIS WEEK** on the current week and the date range otherwise. Text, so it
survives greyscale and reaches a screen reader — neither of which the pill's
colour did — and it says *which* week rather than only that it is not this one.

**The cost is real, and my first estimate of it was wrong.** I priced it at two
taps. `openMonth` opens on the *navigated* week's month, so from three months
out today is not even on the grid and it is five — unbounded, really. Review
caught that, and the fix is in this branch rather than deferred: the month
sheet now has its own **Today**, which is the place you already came to jump
from, and which also balances a header that was centring ~30pt off true.

### Three things review caught, all of them real

**`accent.accent` used as text.** The strip's today marker took the accent
*fill*, which is 3.92:1 on purple against an 11.25pt bold run needing 4.5:1.
Every other coloured string in the file already used `accent.ink` (7.23:1), and
the host screen carries the rule verbatim. One token, a measurable AA failure.

**A filled dot for "planned", and my justification was inverted.**
`TrainingCalendar` spends a legend teaching that filled means trained and a
hollow ring means intended, because green and lime are 1.18:1 apart in
greyscale. The new strip looks like that component and used a filled dot for
plans — reporting every planned day as trained to anyone who learned the
legend. The comment defending it said a ring "would be claiming a distinction
it cannot make"; the ring claims *planned*, which is the only thing this strip
knows. The filled dot was the unsupportable claim. It also used the athlete's
accent for what is a *reading*, which the palette explicitly reserves fixed
colours for — a planned day was orange on Plan and lime on Today.

**Label in Name.** The pill's visible text is THIS WEEK; its accessible name
began "August, week of 11 August…". The visible string was not a substring, so
Voice Control could not activate it — on the one control that is now the only
route to the month grid. The visible label leads the name now.

### A contrast bug caught before it shipped

The first cut marked the "you have navigated" state with a border on the pill.
It measures **1.35:1** against the screen — a state indicator nobody can see,
and the same mistake as the tab thumb that was 1.09:1 from its own track two
entries ago. Deleted rather than recoloured: the label already carries the
fact, and a second channel is not worth a colour that fails.

The pill's own fill is 1.15:1 and that is *fine* — it is decoration. What
identifies the control is the label and its icon (14:1 and 6.26:1), which is
what WCAG 1.4.11 asks for. The chevrons are `textDim` at 3.86:1 on the screen,
clear of the 3:1 a meaningful graphic needs — but note `textDim` is not
universally safe here: it measures 2.51:1 on a completed set row. This passes
because of what it sits on.

### The Plan week collapses

Same shape as Today: a compact seven-cell strip with a dot on days that have
something, and the authoring rows behind a HIDE WEEK / SHOW WEEK toggle.

**Open by default**, which is the opposite of Today's calendar and deliberate.
Today's question is "what day is it and have I trained", so its rows are an
escalation from the strip. This screen exists to fill the rows in; starting
collapsed would hide the only thing on it. The collapse is for reading the
shape of a month — step weeks with the strip alone, then open the one you want
to change.

The strip shows **planned only**. This screen never loads sessions, so a hollow
ring here would be claiming a distinction it cannot actually make.

### What review caught, and one thing my own mutation test did

**The screen opened on yesterday.** `viewDay` was a `Date` captured at mount and
refreshed by nothing, while `now` re-reads on focus and on AppState. Leaving the
app on Today overnight therefore reopened it in *past mode* — yesterday in the
switcher, plans dimmed and marked "Not logged" — with the athlete having
navigated nowhere. It is a day **offset** now, derived from `now`, so every
refresh re-derives it and the class is gone rather than patched at the two
places that happened to refresh.

**A blanket `opacity: 0.55` on the past card** composited every ink inside it:
"Not logged" fell to 1.96:1 and the BJJ eyebrow to 2.51:1 — the latter being the
exact figure the palette cites as its reason for banning `textDim` from a done
row, and failing specifically for this app's headline discipline. The card is
not dimmed at all now; "Not logged" is `warn` at full strength, which is also
what it means.

And one that arrived from my own mutation testing rather than from review: the
first fix for the outside-the-week bug passed *two* plan lists and matched their
union. Three mutations of it stayed green, which is how it came out that the
wider list was **inert** — `matchPlans` groups by day, so plans on other days
can never compete for this day's sessions, and plans on the same day are the
same rows. A parameter that cannot change the answer reads as a safeguard and is
scenery. `owedOn(sessions, dayPlans)` is what was ever needed.

### Gaps

- **Today has not adopted the switcher yet.** It is the screen the reference
  screenshot was actually of, and day-stepping there is the next piece.
- **The month-grid render guard had quietly lost its margin.** It asserted
  fewer than 100 `toLocaleDateString` calls on mount, measured at 45 gated /
  195 ungated. The strip's own seven labels moved that to **87 / 237** — 13
  points of slack, so the next label anywhere in a seven-times-repeated
  position would have turned it red for a reason unrelated to the gate. Both
  sides re-measured and the bound restated at the midpoint.
- **Ten dead style keys** were removed from `WeekPlanner` along with the old
  header. Nothing catches an unused `StyleSheet` key — not the typechecker, not
  ESLint — so they accumulate silently; this lot was found by grepping.

## 2026-08-05 — Today stops being one day, and the escape hatch stops leading

Five changes to the Today screen, from one message. They are one entry because
they are one argument: the screen was ordered by what was easy to render rather
than by what an athlete opens it to find out.

### A day you can step

The screen could only ever answer "what is on today", so "am I training
Thursday" lived in another tab. It now carries the same `PeriodSwitcher` as the
Plan tab, stepping a day at a time.

**Only the Upcoming block follows it.** The calendar, the week summary, Recent
and the trend are week- or history-scoped: stepping to Thursday to see what is
on it must not rewrite what you did this week. `viewDay` is separate from `now`
for the same reason the Plan tab keeps `anchor` apart from its own `now` — "is
this day past" is a claim about the real date and cannot move.

The label doubles as the way back: on any other day it is a button reading that
date, and pressing it returns to today. On today it is a readout, because a
control that does nothing is worse than no control.

**A past day cannot be started.** That was never reachable before — the screen
only ever showed today — and the switcher is what makes "Start" on last Tuesday
possible. Starting it would date the session today and leave the plan it
appears to satisfy still owed. Past plans render dimmed, marked *Not logged*.

### Upcoming, and three states where there were two

The previous screen had exactly two: a plan, or "Nothing planned for today". The
plan-reconciliation work made the second one reachable **by finishing your
plan**, which is the one moment it is flatly untrue. There are three states:

- **Owed** — the plan cards, as before.
- **Planned and all logged** — "That is everything planned", a statement rather
  than a control, since there is nothing left to press.
- **Nothing planned** — a rest line, circulated by date.

The rest lines are keyed on the day, not random: a line that changes on every
render flickers, and one that changes on every visit cannot be quoted back. None
congratulate or scold — the recorded UX direction rules out shame, and a
cheerful "enjoy your rest day!" aimed at someone injured is the same mistake
wearing a smile.

**One caught on the Simulator:** the first draft's lines said "Today looks like
a rest day", which went on screen under a heading reading THU, AUG 6 — the line
contradicting the date directly above it. None of them name the day now, and a
test enforces it.

### New Log, floating

"Start something" was a dashed full-width card directly under the plan, third
thing on the screen. Two problems. It spent the most valuable space on the
*fallback* — the answer to "what should I do today" is the plan, and the escape
hatch was as loud as it. And it is wanted most often at the *end* of the flow,
when you came to log something you already did, by which point you had scrolled
past it.

It is a floating pill now, deliberately the same shape as the workouts tab's:
two floating primary actions that looked different would be two conventions. Its
clearance scales with the text size for the same reason that one does — a fixed
one leaves the pill sitting on the content at the largest accessibility sizes.

### The belt, centred, and only where it belongs

The hero bled off the right edge of *every* plan card, including a squat day,
where a BJJ belt is decoration claiming something untrue. It is centred and
`contain` now — a cropped belt reads as a layout accident, which is what it
looked like — and gated on `usesBelt`.

`usesBelt` moved from `library.tsx` into `lib/modules.ts` rather than being
copied. A second copy is exactly how the position vocabulary rotted across four
files.

### Eight weeks, as bars

Recent answers "what did I just do". Nothing answered "have I been showing up",
which is the only question about training a list cannot answer and the one worth
putting on a screen whose job is to get you to the gym.

**Days trained, not tonnage.** A tonnage chart is one a BJJ athlete cannot
appear in: mat time produces no kilograms, so a mixed week renders as a
strength-only week and a pure BJJ month as an empty chart. This app has already
shipped that bug, in the week summary that told a BJJ-only athlete "0kg volume".
Days trained is the one measure every discipline produces — and days rather than
sessions, because two-a-days are normal here and counting sessions makes a heavy
Tuesday look like a heavy week.

Empty weeks are kept rather than closed up: a chart that cannot show a lay-off
cannot show a comeback. **Which is exactly why the window can never be longer
than the data.** The first cut asked for eight weeks from a capped session read,
so the two oldest bars rendered as zero for anyone training five times a week —
a fortnight off that never happened, shown first to the most consistent
athletes, whose rows fill the cap fastest. This entry originally called that
"degrading to a quieter past, never a busier one", and review was right that it
is nothing of the sort: an under-count is a shorter bar, a missing row is a
*hole*, and the holes are the whole argument. Five honest bars beat eight with
three invented. It is the same fabricated zero this app has already deleted
twice. The current week is drawn hollow because it is not over
— a part-week bar beside finished ones would report a slump every Monday
morning. The whole strip is hidden until something has been logged, since eight
empty columns is a chart telling a new athlete they have failed.

### What review caught, and one thing my own mutation test did

**The screen opened on yesterday.** `viewDay` was a `Date` captured at mount and
refreshed by nothing, while `now` re-reads on focus and on AppState. Leaving the
app on Today overnight therefore reopened it in *past mode* — yesterday in the
switcher, plans dimmed and marked "Not logged" — with the athlete having
navigated nowhere. It is a day **offset** now, derived from `now`, so every
refresh re-derives it and the class is gone rather than patched at the two
places that happened to refresh.

**A blanket `opacity: 0.55` on the past card** composited every ink inside it:
"Not logged" fell to 1.96:1 and the BJJ eyebrow to 2.51:1 — the latter being the
exact figure the palette cites as its reason for banning `textDim` from a done
row, and failing specifically for this app's headline discipline. The card is
not dimmed at all now; "Not logged" is `warn` at full strength, which is also
what it means.

And one that arrived from my own mutation testing rather than from review: the
first fix for the outside-the-week bug passed *two* plan lists and matched their
union. Three mutations of it stayed green, which is how it came out that the
wider list was **inert** — `matchPlans` groups by day, so plans on other days
can never compete for this day's sessions, and plans on the same day are the
same rows. A parameter that cannot change the answer reads as a safeguard and is
scenery. `owedOn(sessions, dayPlans)` is what was ever needed.

### Gaps

- **The strip still cannot see past the session cap** — it now shortens rather
  than inventing, so it under-*reports history length* instead of fabricating
  rest. A dedicated read would let it always show eight.
- **"Not logged" is only true within the session window.** Step far enough back
  and a genuinely trained day has no rows loaded to be matched against, so its
  plan reads as missed. Same cap, and the switcher has no bound, so the
  falseness is unbounded — the honest fix is a windowed read keyed to the
  viewed day.
- **`fabClearance` is now duplicated** between here and the workouts tab,
  deliberately — the two pills are allowed to diverge and a shared constant
  would hide it when they did. If a third appears, share it.
- **The switcher has no bound.** Nothing stops stepping into 2029 one day at a
  time. Harmless, and a month jump would be the fix if anyone ever does it.

## 2026-08-05 — The first suggestion, and the endpoint shape I assumed instead of read

Tier 1 of the curriculum design: *"you drilled the arm drag nine times and never
tried it live."* The cheapest tier, deliberately first.

### Why the cheap claim ships before the interesting one

The design doc prices all three. "Where do you concede most?" needs **~18
position-tagged concede events** before one of nine families can be told from
noise. A funnel gap is an **absence**, not a rate: if you would normally take a
drilled technique live 30% of the time, nine drills with zero attempts is
p<0.05 on its own. It needs no position tagging at all, and it fires at three to
five detailed sessions rather than eight to fifteen.

It is also the better instruction. "Try the thing you have been drilling" is
something you can do on Wednesday. "Work on half guard" is a topic.

### No backend

`/v1/bjj/proficiency` already aggregates drilled/attempted/scored/conceded per
technique with a session count and a `last_seen`, built when the tag table was.
The whole tier is a client read plus a pure function.

### The rule, and the line that decides whether it is true

    drilled >= 6  &&  attempted + scored === 0  &&  sessions >= 2  &&  seen within 60d

`attempted + scored`, **not `attempted`**. The two are disjoint in this schema —
`attempted` is "went for it and it did *not* land" — so a technique drilled nine
times and landed twice has plainly been tried. Gating on `attempted === 0` alone
would tell that athlete to go and try the thing they are already hitting. That
is the difference between a suggestion and noise, and it is one `+ r.scored`.

`sessions >= 2` uses the field the endpoint added as "the honesty check on every
number above": nine reps in one class is one class, not a habit, and a technique
the coach taught once is not something the athlete is avoiding.

Six drills, not nine. Nine is where the statistics stand alone; six is where the
*observation* is worth making, and the card shows its evidence rather than
asserting — "drilled 9 times across 3 sessions, never live" is checkable, where
"work on your arm drag" is a verdict the recorded design rules out.

### Tier 0, which is the half that creates the evidence

An athlete using the fast path and skipping the wizard is told, once, that the
detail is what unlocks the rest. Bounded on **both** sides: not on the first
session, because one is not a habit; never past the fourth, because by then they
have heard it and are choosing. A prompt that repeats forever is the shame the
UX direction rules out, however politely worded.

### The bug that only running it could find

`fetchProficiency` was typed `Promise<Proficiency[]>`. The endpoint returns
`{ techniques, summary }`. It compiled, it passed every check, and it took the
Today screen down on first render with *"undefined is not a function"* —
`rows.filter` on a response with no such property.

TypeScript cannot catch this: the cast at a parse boundary is an assertion about
a server, not a check. `apps/web` had the shape right; I did not read either it
or the contract. The fix carries the same `?? []` that `bjjFocus.ts` already
has, and that file's comment describes the consequence exactly — a drifted
server hands `undefined` to a consumer inside a `useMemo`, taking the render
down rather than degrading to nothing.

Worth stating plainly because `pnpm run verify` was green through all of it.

### What review caught, and the one that undermined the rule

**The load-bearing gate could not fail.** `attempted + scored === 0` is right
for the schema and wrong for the capture surface: the only writer of a
technique-tagged `attempted`/`scored` row is the wizard's "Working on" grid,
which renders only for techniques on the athlete's `bjj_focus` list — set on
**web** — plus any already carrying live rows that session. For a technique
never on that list the value is **structurally zero**, so the rule collapsed to
"drilled a lot, recently" and the card asserted "never live" about rounds the
app was never told about. The tier is preconditioned on `countersInUse` now,
and the copy claims only what the record shows ("never logged live").

**`sessions >= 2` was dead code, and the card said one number twice.** The
wizard writes `drilled` once per session with a per-session dedupe, so `drilled`
is a count of *classes*, and the backend's `sessions` is
`COUNT(DISTINCT session_id)` over the same rows — they are equal, and
`drilled >= 6` already implies `sessions >= 6`. The gate could never reject
anything. Removed, and the card reads "Drilled in 6 sessions" rather than
"drilled 6 times across 6 sessions".

That also reframes the threshold: **six is six separate classes, not six reps**,
which is a much higher bar than the docstring's "six, not nine" argued for. The
number was reviewed and kept; the reasoning beside it now describes the right
quantity.

**Tier 0's bound was computed over the wrong window.** `bjjSessions <= 4` counts
BJJ sessions among the most recent ~20–30 *local* rows, not a lifetime — so a
reinstall put a three-year athlete back at "session 2", and for a strength-heavy
athlete the old BJJ sessions aged out of the window, the count fell back into
the band, and the prompt returned. Indefinitely, which is the one thing the
bound exists to prevent. It counts **times shown**, persisted in prefs.

**The Tier 0 card was unreachable by Voice Control** — its accessible name
shared no words with its visible title (WCAG 2.5.3) and never said what pressing
it did. And it pushed to the technique *library* while its copy said "add what
happened in rolling"; the copy and the destination now agree.

Also: the card's justification line was `textDim` at **3.67:1**, under AA at
12pt, on the one line carrying the evidence the card asks to be judged on.
`textMuted` is 6.85:1.

The three thresholds were unpinned — the fixture sat at `drilled: 9` and the
rejection at 5, so `MIN_DRILLED` could be raised to 9, and the window moved
anywhere in roughly [27, 212] days, with the suite green. Each has its boundary
pair now, and all five mutations are red.

### Gaps

- **`refreshFunnel` fires on every day-step, not once per focus.** The comment
  claimed otherwise and was wrong: the focus callback depends on `refreshPlan`,
  which depends on `dayOffset`, so stepping a week is seven round trips. Harmless
  (same query, same answer) but wasteful, and the fix is to split the effect.
- **No seq guard on the funnel read**, unlike the plan read beside it, and
  `fetchProficiency`'s `signal` has no caller. Concurrent reads are routine
  because of the above, so last-to-*resolve* wins.
- **The funnel is not tagged with the account it was read for**, so an account
  switch can briefly show athlete A's suggestion to athlete B. `AccentProvider`
  documents this exact class and tags its state `{ for: userId }`.
- **A stale unfinished session suppresses the suggestion indefinitely** — the
  card is inside the `!active` branch, and `active` includes a session this
  screen itself labels UNFINISHED and treats as abandoned.
- **The funnel is fetched for athletes who do not train BJJ**, on every focus,
  always answering empty.
- **Nothing dismisses a suggestion.** It recomputes on every focus, so the same
  card returns until the evidence changes. The design doc's own answer is that
  the suggestion should be recomputed but a *dismissal* must persist; that is
  the next piece and this tier is unpleasant without it.
- **Tier 0 counts techniques, not sessions.** `funnel.length === 0` is "no
  technique-level evidence ever", which is the closest signal available on this
  screen. An athlete who fills the category grid every session but never names a
  technique is told to add detail they are arguably already adding.
- **Only on today.** Stepping the day switcher hides the card, on the argument
  that a suggestion is about what to do next rather than a claim about a day you
  are looking at. Worth revisiting once anyone uses it.
- **No web surface.** The funnel page shows the numbers; nothing there says
  which one is worth acting on.
## 2026-08-05 — `defended` completes the 2×2, and an error message stops being able to lie

The roadmap design needs a defensive completion criterion — *"defend the guard
pull three times"* — and the schema could not express one.

### The gap, stated as a shape

Every live event answers two questions: who started the exchange, and did it
land.

|                    | it landed  | it did not  |
| ------------------ | ---------- | ----------- |
| **I initiated**    | `scored`   | `attempted` |
| **they initiated** | `conceded` | *(nothing)* |

Three cells shipped. The fourth — they went for it and you stopped them — did
not, which made **defensive success the one outcome the app could not record**.
It could only be inferred from absence ("you weren't caught in it for ten
sessions"), and an absence argues *more* strongly the less you roll. That is the
fabricated zero this codebase has deleted twice already, in a new costume.

`defended` fills it. **No migration.** `bjj_session_tags.event` is `TEXT` with
no `CHECK`, and 000025 said why: the vocabulary is validated in Go so it can
grow by an enum edit. That stance was taken for `kind` and paid off here.

### Where it is captured, and where it deliberately is not

On the **per-technique funnel chips**, beside Tried and Landed — not as a third
column in the category grid.

The grid is five rows of two counters and is the fastest structured input in the
app. A third column taxes every session, for every athlete, to serve a defensive
criterion belonging to a roadmap they may not be on. The funnel chips only
render for techniques already in focus — which is exactly the handful a roadmap
cares about, and the place where naming a specific technique already earns its
cost.

`defended` is also the mirror of `attempted`, which already lives there. Putting
the two halves of "it didn't land" in different places would have been the
strange choice.

Both wins now colour the same: `Landed` and `Stopped` read as `scored`, `Tried`
stays neutral. Colouring only the offensive one would say the quiet part out
loud about which half the app values.

### The error message could lie, and now cannot

`session_handler.go` returned a 400 naming every accepted value — with the
vocabularies **spelled out as a literal**, directly under a comment explaining
that the message exists because client and server can drift. Adding a fifth
event made it wrong immediately: `Valid()` accepted `defended` while the
rejection text still told the client there were four.

It is built from `Kinds()`, `Categories()` and `Events()` now, extracted into
`invalidInputMessage()` so a test can assert it mentions every value each one
holds. A message about drift that can itself drift is worse than no message.

### Tests

The 2×2 test asserts the **shape**, not the list: it maps each live event to
its (who-initiated, did-it-land) cell and fails if any cell is empty or two
events claim the same one. A test that spelled the five values out would go
green the moment someone deleted `defended` and updated it to match.

Mutation-checked, and one of the checks was itself wrong first. Removing
`defended` from the vocabulary goes red. The error-message test originally
asserted `strings.Contains` over the whole message, and review proved that was
theatre: **swapping `join(Kinds())` and `join(Events())` — so the 400 told a
client that kinds were "drilled, attempted, scored…" and events were "class,
drilling…" — left it green**, because every value was still *somewhere* in the
string. It asserts per clause now, and that the clause does *not* name another
vocabulary's values, which is what makes it a claim about identity rather than
presence. That mutation is red.

Worth being exact about the limit: a five-value literal that happens to be
correct still passes. No test can tell a correct literal from a derivation —
which is why deriving it is the fix and the test is only the backstop against
it going wrong.

### What review caught: the event was threaded forward and not backward

Three blocking findings, and all of them the same shape — `defended` was
**write-only**. It was added to the type, the wizard and the API, and none of
the places that read events back were widened with it.

- **`focusRows` narrowed to `attempted|scored`**, so a technique whose *only*
  evidence was `defended` — "I never went for it, I just kept stopping theirs",
  exactly the athlete the defensive criterion is for — got no row at all. Three
  recorded stops were saved, synced, then invisible and uneditable on reopen.
  That is the property that file's own test calls **THE property**, and it did
  not need anyone to drop a focus technique: `LiveStep` swallows a `fetchFocus`
  failure deliberately, so every offline reflection at a gym took that path.
- **The session read-back screen showed a blank funnel line** for a
  defended-only technique. The comment three lines above it says writing an
  event and displaying it nowhere is "the exact defect this feature exists to
  fix, recreated one screen along". It was recreated one event along. The
  `·`-joined conditional chain was already awkward at two values and silently
  wrong at three; it builds a list and joins now.
- **`apps/web`'s proficiency page bucketed a defensive win as "Used on you —
  Caught in it, with nothing of your own recorded"**, the precise inversion of
  what happened, with every funnel column showing a dash. `conceded` reaching
  that bucket is fine because no client can author one; `defended` is written
  by every athlete who taps the counter.
- **The aggregate arm was untested.** Misspelling `'defended'` as `'defence'`
  in the SQL left the entire package green — every count silently 0 forever,
  and the contract's newly-required field always zero. The fixture now seeds a
  defended row at **3 against conceded's 4**: equal counts would make a
  transposition of the two invisible, since both are ints and pgx cannot catch
  it. Both mutations are red.

And one wording change that is not cosmetic. The counter read **"Stopped"**,
which flips the subject: the other two counters are about the athlete's own
execution, so "Armbar · Stopped: 3" reads most naturally as *my armbar got
stopped*, which is what `attempted` already means. Two counters reading as
synonyms on the screen that feeds completion criteria is inverted evidence, not
a nit. It says **"Stopped theirs"**.

The grid header was also hardcoded as two cells for three counters, so
"Landed" sat over the Stopped column and actively mislabelled it. It is derived
from `FUNNEL_OUTCOMES` now.

### Gaps

- **`defended` cannot be recorded without a focus technique, and focus is set
  on web.** It is the only one of the five events with no capture path outside
  the per-technique chips — offensive outcomes at least degrade to the category
  grid's "You" column, and there is no category-level defensive equivalent.
  So the population that can never record one is not just "athletes who set no
  focus" but every mobile-only athlete, plus anyone reflecting offline while
  `fetchFocus` fails silently. Any future defensive-rate query is therefore
  biased toward web users, and should say so.
- **`SummariseProficiency`'s `Tried()` excludes `defended`**, so a technique
  taken into a live round defensively counts toward `techniques` but toward
  none of drilled/tried_live/landed. Defensible — it was not an attempt — but
  it means the page's headline undercounts real live evidence. Recorded as a
  decision rather than left as an accident.
- **Nothing reads `defended` yet.** `/v1/bjj/proficiency` reports it and the
  wizard writes it; no roadmap consumes it, because roadmaps do not exist. That
  is the intended order — the criterion is worthless without months of evidence
  behind it, so the capture path has to exist first — but it does mean a column
  that is written and not yet read, which is the failure mode this project has
  been bitten by before. It is deliberate here, and it should not stay true for
  long.
- **The category grid still cannot express a defensive success**, only the
  per-technique chips can. An athlete who never sets a focus technique produces
  no `defended` evidence at all. Acceptable while criteria are per-technique;
  revisit if a position-level defensive claim is ever wanted.
- **`Proficiency.Conceded` is still unwritable by any client** — the same note
  it carried before. `defended` did not change that; a technique-tagged
  `conceded` row still has no capture path.

## 2026-08-05 — A suggestion you can say no to

Tier 1 shipped without one, and the design doc had already named the
consequence: the card recomputes on every focus, so the same suggestion
returns until the evidence changes. On a surface whose whole argument is that
it must not nag, that was the wrong thing to leave for later.

### The split: recompute the suggestion, store the "no"

The same argument `lib/adherence.ts` makes about plans. A stored *suggestion*
goes stale against the evidence behind it — delete the sessions and it would
still be claiming something. A stored *dismissal* is a fact about the athlete
and cannot go stale. So the suggestion is derived on every read as before, and
`funnelGap` takes a set of technique ids to skip.

### Dismissed means dismissed

Not "until the evidence gets stronger". An athlete who has said no to the arm
drag at six classes has not asked to be asked again at fourteen, and a
suggestion that returns because you ignored it is precisely the shape this
surface exists not to be.

The cost is that it is permanent for that technique, which is a real trade
rather than a free one: someone who dismisses early never hears about it again.
Two things make it acceptable — the funnel page still shows every number, so
nothing is hidden, only un-nagged; and dismissing is a deliberate tap on an
explicit control rather than something you can do by accident.

### An explicit ×, not the long-press this app uses elsewhere

Long-press is the established idiom here for removing a *planned session* — a
row the athlete deliberately created and is deleting, where a hint line can sit
underneath and discovery is cheap. A suggestion is unsolicited, and the moment
anyone wants it gone is the moment they should not have to work out how.

It replaces the chevron rather than joining it. The chevron said "this opens",
which the card already implies, and two glyphs on a small card would have made
the destructive one the quieter of the two.

### Storage

One pref key holding a JSON array, not a key per technique: the rule needs the
whole set to pick its *next-best* candidate, and a per-technique key could only
answer "is this one dismissed". Device-local like the Tier 0 offer count, and
for the same reason — `writePref` only pushes what is explicitly marked owed,
and dismissing on a phone then seeing it once more on a tablet is a smaller
cost than the sync surface.

Capped at 100, dropping the oldest. Unbounded it is a string in a key/value row
that only ever grows; and the ones dismissed longest ago are the ones whose
evidence has most likely changed shape since.

`parseDismissed` is total — anything unparseable, or parseable but not an array
of strings, reads as an empty set. This is read on the app's home tab, and
`lib/proficiency.ts` already carries the scar from trusting a shape at a parse
boundary: the cost of a bad value here has to be a returning card, never a
screen that will not render.

### Verified

Six mutations, five red: removing the filter, inverting it, capping from the
wrong end, allowing duplicates, and dropping the string check in the parser.
The sixth — replacing the array guard with a cast — is an **equivalent mutant**:
`new Set(42)` throws and the existing `try/catch` already returns an empty set,
so the early return is clarity rather than behaviour. Recorded as equivalent
rather than papered over with a test that would only be asserting the catch.

On the Simulator: dismissing "Arm drag" revealed "Scissor sweep" immediately,
and the dismissal survived a full app restart.

### Settings: a master switch, one per discipline, and the undo

Three answers to "why am I not getting suggestions", on one screen, because
they are only comprehensible together.

**The master wins, and is not destructive.** Turning everything off has to be
one action rather than N — an athlete who wants silence should not have to find
every discipline. But it must not forget which ones they had turned off
individually, so the two are stored apart and combined on read rather than the
master rewriting the per-module set. Flipping it back restores exactly what they
had.

**Default on, expressed as an OFF list.** Absence means enabled, so a discipline
added to the registry later is suggestible with no migration and this code never
has to know the full set of modules. Same shape as `bjj_focus` recording what
you chose rather than what you did not.

**The per-discipline rows stay visible when the master is off**, greyed rather
than hidden, with a line saying the choices are kept. Hiding them would lose the
answer to "which ones did I turn off" — which is precisely what someone turning
the master back on wants to know.

**Undo lists dismissals by name**, resolved from the technique library after the
rows render, falling back to the id. Best-effort: a name is what makes the row
useful, but a failed lookup must not stop someone undoing a dismissal they can
already recognise. Confirmed on the Simulator against a real dismissal whose id
was not in the library — it rendered the id, exactly as designed.

**The Tier 0 offer is gated by the same switch.** It is a suggestion too, and an
"off" that still asked for more evidence to make suggestions would only mean
"off once it has something to say".

Failing OPEN throughout: an unreadable preference reads as enabled. A feature
that silently disables itself on a bad read is worse than one that shows a card
someone has to dismiss again.

### What review caught: the undo silently did not work

**Today never re-read the preferences.** The effect was keyed `[userId]`, and a
tab screen stays mounted for the life of the process — a fact this same file
documents two lines away. `/settings/suggestions` is a Stack route pushed over
the tabs, so after visiting it and coming back: master off still showed the
card, a silenced discipline still showed the card, and **"Suggest again" did
nothing**. All three only took effect after killing the app.

The write direction worked, which is exactly why testing it by hand missed it —
Settings is pushed fresh every time and reads correctly. Worse, this entry and
`functional-scenarios.md` both *asserted* the behaviour the code did not
deliver. The reads moved into the existing focus effect.

**The per-discipline switches contradicted their own promise.** They rendered
`master && !off.has(key)`, so every row read OFF when the master was off — while
the note beside them said "Your choices are kept" and the comment above said the
rows stay visible precisely so the athlete does not lose the answer to "which
ones did I turn off". Rendering them all false lost it as completely as hiding
them would. `disabled` and the group opacity carry the master state; the value
carries only the athlete's choice.

**VoiceOver could not reach the ×.** It is a `Pressable` inside a `Pressable`,
and UIKit does not descend into a view that is itself an accessibility element —
so its label and hint were never announced and neither VoiceOver nor Voice
Control could invoke it. The card now carries an `accessibilityActions` rotor
action, which keeps it one swipe for a screen-reader user and leaves the visible
× for everyone else.

Also: the settings screen flashed "everything on" before the read landed, so an
athlete who had switched suggestions off saw the master flip ON then snap OFF on
every visit; and the ×'s symmetric 12pt `hitSlop` swallowed the whole gap
between it and the evidence line, putting an invisible destructive target
against a harmless one.

**And a correction to the last entry's reasoning.** It called the
`Array.isArray` guard an equivalent mutant because `new Set(42)` throws. The
equivalence is real but the reason was wrong: it holds because `.filter` is
absent from every non-array JSON value. `new Set("abc")` does *not* throw — it
yields three fabricated ids. So `'"abc"'` is now in the corrupt-input table, and
the guard stays.

### Gaps

- **Nothing lists the per-discipline switches on web.** Suggestions are a mobile
  surface today, so there is nothing to configure there yet — but the settings
  are device-local, which means they are also *client*-local, and the moment web
  grows a suggestion the two will disagree.
- **The Settings→Today round trip is fixed but NOT confirmed on a device.** The
  read moved into the focus effect and the reasoning is sound, but the
  Simulator pass ran out before the toggle could be flipped and the return
  observed. Given this is the exact path whose failure review had to find,
  it should be watched by eye before merge — and the missing test for it is
  the first item below.
- **No test covers the Settings→Today wiring**, which is where the blocking bug
  lived and which a pure-logic test structurally cannot reach. `app/__tests__/`
  already holds five screen tests, so the pattern exists.
- **Device-local.** A second device will offer a dismissed technique once more.
  Deliberate, but it becomes wrong if suggestions ever grow past a nudge.
- **Dismissal is per technique, not per tier.** When the position hot-spot tier
  lands there will be nothing that says "stop suggesting positions", and reusing
  this set for it would silently conflate two different refusals.

## 2026-08-05 — The description field was parsed and the form never said so

Authoring a technique in the admin console fills a `Description` box hinted
only "The mechanics." That text is **not displayed** — `executionSteps` splits
it into the numbered sequence the mobile technique screen renders, and the two
ways an author would most naturally write a step list are the two that break.

Measured by running the parser rather than reading it:

- One sentence, comma-separated clauses → clean steps. This is what the seeded
  library does, and it works for 458 of 466.
- One step per line, each ending in a full stop → also clean. `\s` covers the
  newline, so the full stop is what does the splitting.
- **Numbering them yourself** → the numerals become steps of their own:
  `"1"`, `"Grip the far collar, 2"`, `"Step your foot across, 3, Fall back"`.
- **Bullets, or lines with no terminal punctuation** → a line break is not a
  separator, so the whole thing stays one paragraph with the hyphens in it.
- **Any clause under ten characters** → folded into the clause before it. So
  `"Break the grip, step in, and finish."` collapses to a single step, and a
  single step is deliberately rendered as prose because a one-item numbered
  list reads as a bug. Ordinary phrasing, no warning, no step list.

The last is the one that justified building something rather than answering the
question: it is invisible at authoring time and invisible in review.

### What landed

`/content/guide` in the admin console — the rules, and for each authoring style
the parser's *actual* output rather than an illustration. Linked from the
techniques list and from the Description field itself. It also covers the other
fields whose failure mode is silence: graph edges (`setup_from`,
`common_next_moves`, `common_counters`) match other techniques **by name
exactly**, and a near-miss is not an error — the edge simply does not resolve;
`typical_belt` is a filter, so blank hides the technique from anyone using it;
and category must be the importer's nine or the next spreadsheet re-import
breaks.

Alongside it, `docs/content/technique-research-prompt.md` — a prompt for
producing a form-ready entry that carries the same constraints, since a general
"write me a BJJ technique" prompt produces text that looks right and renders as
a paragraph. Its most important instruction is to leave a field empty and say
why rather than guess: an empty field renders as nothing at all, so a blank is
always safe, and an invented IBJJF legality claim is not.

### Worth keeping

Both files are documentation of *behaviour*, not of intent, and both say so at
the top. If `executionSteps` or the vocabularies change they are wrong, and
nothing enforces that — the parser's own test file is where those input/output
pairs should also live, which the functional-scenarios entry now records.

Not verified visually: the console is Clerk-gated. `build:admin` compiles the
page and emits the route, and typecheck and lint pass.

## Open items / known gaps as of this entry

- **The Library header is ~300pt before the first result, and the glossary is ~40% of it.** Search + sport chips + position chips + belt chips (#87) + the glossary row all sit outside the `FlatList` in `styles.controls`, so they are permanently pinned; on a 4.7" screen that leaves roughly two catalog rows visible. The fix is the pattern the position screen already uses — move the glossary block into the list's `ListHeaderComponent` so it scrolls away. Not done here because it is a structural change to a screen this branch could not verify on a device, and two of this branch's three worst defects were runtime-only.
- **Two position taxonomies now sit on one Library screen.** The filter chips are nine coarse families; the glossary is eleven curated entries. Since the guard split they disagree in a visible way: a beginner can read the Closed Guard card, learn the distinction, and then find no chip that filters to those 37 techniques. Adding North-South, and later Leg Entanglement, closed the cheap half each time (a position the glossary advertised that no chip could reach) — but doing it twice by hand is the evidence that hand-maintenance is the actual bug: the vocabulary is copied across four client files and one backend map, and the taxonomy PR updated one of the four until review caught it. Keying the chips on the glossary's ids, or a shared constant with a test asserting it matches positions.json, is the real answer and is design work, not a patch.


- **The opening animation's native half is unverified.** The JS animation is Simulator-confirmed, but the bare `#080B12` native launch screen it hands over from cannot be seen in Expo Go at all (the plugin writes native assets at prebuild and leaves the manifest empty). Nothing proves the two grounds match until someone runs a dev or EAS build; if they don't, the join flashes on every cold start.
- **`assets/brand/logos/` still holds four placeholder lockups** built from Arial text and a hand-drawn checkmark, dating from before the real artwork existed. The genuine Corel exports now sit one level down in `logos/source/`, so the top-level directory is the stale one — anything that reads from it (the web app has not been re-pointed) silently gets the stand-in logo.
- **`secrets.txt`** — an untracked file sitting in the repo root containing what looks like a live Anthropic API key in plaintext. Flagged to the user repeatedly; never staged or committed; not yet deleted or rotated as far as this log knows.
- Functional test suite not yet passing — blocked on applying the `--hostname` fix to `tests/functional/support/start-stack.mjs` (the user's own in-progress file — not something to edit unilaterally).
- No Railway `api` or `web` services exist yet, only Postgres — `railway/*.toml` configs are ready but unconnected.
- No production Postgres — `staging` is currently doing double duty for dev/staging/testing.
- JWT verification doesn't check the `azp` claim (fine for one frontend origin; revisit if that changes).
- Mobile app shell exists (`apps/mobile`) and is now fully Simulator-verified (screenshot-confirmed on a real iPhone 15 Pro Simulator). Still has no auth, no other tabs (Plan/Log/Progress/Profile), and no dev client (Expo Go only) — all deliberately deferred to future increments.
- Web app shell exists (`apps/web`, `/dashboard`) with `Dashboard`, `Workouts`, `History`, `Records`, `Library` and `Settings` wired. BJJ rank now lives inside Settings (belt + promotion history) rather than as its own sidebar destination — it's account data, not a screen's worth of content on its own. Calendar/Nutrition/Insights are still just IA on paper, no routes or stub pages yet.
- Admin console exists (`apps/admin`) with `User Lookup`/`User Detail` running on **real backend data** — no mock data anywhere. `User Detail` now also shows BJJ rank beside the athlete, read-only, for accounts with one. Still missing: subscriptions/device-platform/integration-sync/support-ticket data (no real system behind any of them, so those columns are simply not shown rather than faked), and the `Jobs & Webhooks`/`Audit Log` screens (not designed yet). No in-app log viewer — trace correlation is by grepping the real log stream for a `request_id`. **New gap:** an account visible to nothing but `bjj_promotions` (a rank recorded, no session/activity/profile ever) is invisible to `User Lookup` and 404s on `User Detail` — user discovery scans profiles/sessions/activities only.
- `apps/web`'s current visual style predates the shared hi-fi design system (Barlow/Barlow Condensed, the light palette used in `apps/admin`) and doesn't yet follow it — reconciling that is unstarted.
- Structured logging + request/trace IDs exist in the API (`backend/internal/platform/httplog`), and `apps/web`/`apps/mobile` now propagate a `traceparent` on their real backend calls. `apps/admin` still doesn't — it has no backend calls of any kind yet, not a tracing gap specifically.
- Feature flags exist (`GET /v1/flags`, `internal/modules/featureflag`) but are read-only — no write endpoint or admin-console screen yet (real backend admin authorization now exists, see below, so this is no longer the blocker it was). No frontend app fetches or gates on one yet.
- First end-to-end vertical slice: **complete** — all five phases done and verified together on a real Simulator (offline log → sync → Postgres → web → admin → log grep). Remaining gaps within it, all deliberate: mobile sync is manual/on-log with **no background sync**; there's **no conflict resolution** (activities are append-only); only one activity `kind` is loggable from the UI; and there's still no in-app log viewer (tracing is by grepping the real log stream for a `request_id`).
- Mobile auth now covers **sign-in** (email+password plus TOTP/SMS/email-code/backup second factors), **sign-up** (`app/sign-up.tsx`) and **password reset** (`app/forgot-password.tsx`). Only **OAuth** is still missing, and it's a want rather than a hole — every account is reachable without it. The old note here said email-code 2FA needed a cast around Clerk's typings "worth revisiting when `@clerk/clerk-expo` updates": that revisit happened, and the cast was already unnecessary at the pinned version — see the entry above. **None of the three screens is device-verified** — see the sign-up entry for why neither the web preview nor the Simulator could render one.
- **BJJ sessions are loggable and their evidence accumulates, but nothing reads it back yet.** The tags table is deliberately shaped for the technique funnel, the position heatmap and gap detection; none of those views exist, so today the data goes in and only the session itself comes out. That is the intended order (settle the schema, then read over it), but until a view lands the athlete has no reason to trust the tags are worth entering.
- **A BJJ-only athlete still sees strength-shaped zeroes.** Today's week summary reads "0kg volume" and the history chart's tonnage is structurally 0 for BJJ — the client already falls back to a time metric when tonnage is zero everywhere, but the volume tile itself does not. Mat time and rounds now exist as real numbers; nothing surfaces them yet.
- **The technique library is not cached in SQLite** (only in memory, for the app's lifetime). So the reflection wizard's drilled step is empty on a cold launch with no signal — the one moment it is most likely to be used. It degrades honestly and stays skippable, but a `technique_cache` table (or a prefs blob, as `PREF_MODULES` already does) is the fix.
- The new `backend-module-scaffolder` agent and `/new-module` skill are still unverified in practice — the feature-flags module was scaffolded by hand instead, since its shape (global, ownerless, read-only) didn't fit the agent's per-user-CRUD template. No module has gone through the agent for real yet (the `profile` module it's modeled on predates it) — worth checking it actually produces correct output the first time it's used for a module that *does* fit the template (e.g. a future `goals` module).
