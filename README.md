# VOLA

VOLA is a unified training and nutrition platform for BJJ athletes who also strength train and track nutrition — one athlete profile and calendar connecting BJJ, strength training, and nutrition, with deterministic, explainable cross-sport recommendations.

- [docs/decisions/history.md](docs/decisions/history.md) — chronological project history: what's been built, why, and what's still open. Start here if you're new to this repo.
- [docs/testing/functional-scenarios.md](docs/testing/functional-scenarios.md) — recommended functional test scenarios per feature.
- [docs/architecture/deployment.md](docs/architecture/deployment.md) — dev/staging/production environment setup.
- [docs/architecture/api-conventions.md](docs/architecture/api-conventions.md) — REST/OpenAPI conventions.
- [contracts/public.openapi.yaml](contracts/public.openapi.yaml) — the wire contract.

This repo is a pnpm + Go monorepo, built incrementally, one verified piece at a time.

## Current state

- `backend/` — Go API (`cmd/api`), stdlib `net/http`. `/v1/healthz` (public), `/v1/me`, `/v1/profile` (CRUD), `/v1/modules` (read/patch — the discipline registry merged with the caller's own toggles; **the one place a new discipline is declared** is `internal/platform/discipline`, and per-user enablement is rows in `profile_modules`, so adding one needs no migration), `/v1/flags` (read-only, server-controlled feature flags), `/v1/activities` (create/list — the unified activity envelope, idempotent create for offline sync), `/v1/exercises` + `/v1/exercises/{id}` (the 524-entry exercise catalog), `/v1/techniques` + `/v1/techniques/{id}` (the 466-entry BJJ technique library — separate from exercises because a technique isn't measured and lives in a position graph. Every entry carries **what it does** (`function`: advance, reverse, escape, control, finish) alongside **where it happens** (`position`), which is what makes "every way to advance from here" one query instead of three category lookups — `category` stays as the colloquial label a coach would say; both are read-only reference content seeded via `cmd/seed`), `/v1/workouts` (+ `/{id}`, `/{id}/items` — shareable single-discipline workout templates, owner-scoped writes), `/v1/sessions` (+ `/{id}`, `/{id}/sets`, `/{id}/finish` — performed sessions and the sets in them: reps, weight, RIR, RPE and a set type, with a server-computed volume summary so both clients agree), `/v1/profile` (now carrying `unit_system` — display units only; training data is always stored in kilograms and metres), `/v1/sessions/history` (training history rolled up per calendar day in the caller's timezone, with period totals and the preceding window's totals for comparison — aggregated server-side so the working-set rule lives in one place and a total can't be under-reported from a capped listing), `/v1/sessions/suggestions` (progressive overload, and an **estimated 1RM** per exercise — Brzycki with RIR/RPE folded in, so a set stopped 3 reps short isn't read as a strength loss, plus your best estimate to date; progression: what to load today per exercise **and for how many reps** — double progression autoregulated by reported effort, so reps advance inside a goal-derived range until every working set reaches the top of it, then load moves and reps reset, and three sessions stuck at one weight trigger a deload rather than another repeat. Deterministic, and it returns the evidence alongside the recommendation), `/v1/bjj/standing` + `/v1/bjj/promotions` (+ `/{promotionID}`) (an athlete's BJJ rank, **derived** server-side from the promotion history rather than stored as a column — the highest recorded rank wins regardless of promotion order or missing dates, so there's exactly one source for "what belt am I"), `/v1/bjj/sessions/{sessionID}` (the BJJ half of a session — kind, gi, rounds × length, session RPE, and the tag stream. A BJJ session is an ordinary `sessions` row so it stays visible to history and the cross-sport load picture; this carries what a mat session has and a barbell one does not, exactly as `/{id}/sets` does for strength. Every tag records **position context and an outcome direction** — `drilled → attempted → scored` is the technique funnel, `conceded` is the symmetric half that answers "where do I keep getting stuck"), `/v1/admin/users` + `/v1/admin/users/{userID}` (admin-only, gated by a Clerk-user-ID allowlist — user lookup and per-athlete detail, both derived from `sessions`/`session_sets` rather than from any admin-specific write path; `/v1/admin/users/{userID}/activities` remains as the legacy read path for `activities` rows written before the in-app logging form was removed; `/v1/admin/users/{userID}/bjj/standing` is the same rank derivation over a path user rather than the caller, read-only). Structured JSON logging with request-ID/W3C-trace-context correlation on every request. Real Postgres via `golang-migrate` migrations (`backend/migrations/`), both locally (`docker-compose.yml`) and on a real Railway `staging` Postgres.
- `apps/web/` — Next.js customer app: Clerk sign-in, `/dashboard` showing a live API health check and the caller's synced activities, plus `/dashboard/workouts` (authoring workout templates two-pane, catalog always visible) `/dashboard/records` (**Records** — every exercise trained, each record with the set behind it and a link to that session, plus inline control of which ones show on the phone), `/dashboard/sessions` (**History** — period selector, totals with period-over-period deltas, a consistency heatmap, weekly load bars and the session list; plus logging a session as a table of live inputs, the right shape for typing one up from paper), and `/dashboard/settings` (units, which disciplines are on, and — for a BJJ-enabled account — the belt itself: current rank, promotion history, and full add/edit/delete, gated on the module being enabled rather than on a history existing).
- `apps/mobile/` — Expo/React Native app (Expo Router, Expo Go). Clerk sign-up (email+password, then an emailed code), sign-in (incl. two-factor) and password reset — an athlete can create their account, sign in, and recover a forgotten password entirely on the phone, no desktop required, a `Library` tab browsing the exercise catalog with images, a `Workouts` tab for building templates (the exercise picker is filtered to the workout's discipline, and target fields are driven by each exercise's `load_type`), a session logger reached from a template's `Start session` or from `Today` (sets carry forward, effort doesn't, no Save button — every edit writes through), with a **rest timer** and mid-session exercise swapping — mobile owns live logging, web owns planning and analysis (see CLAUDE.md), and a **You** tab carrying a phone-sized training summary (sessions/days/time with period-over-period change, a consistency grid and a bar per week — the glance; the analytical surface stays on web) plus, for a BJJ-enabled account, a belt card opening `/bjj` — the current rank, time at it, and the full promotion history, with add/edit/delete sharing one form. **BJJ logging inverts the strength flow**: you cannot touch a phone mid-roll, so Today's BJJ action opens `/bjj/log` (a three-tap floor — kind, how hard, log — pre-filled from last time, and a complete session on its own) with an optional reflection wizard behind it for what you drilled and what happened live, both directions. And a `Today` tab that logs activities **offline-first** into local SQLite (sessions are offline-first too — start, log and finish with no signal; the catalog and your workouts are cached so the screen is readable, and everything pushes on reconnect) and syncs them to the API when connectivity allows — retries are safe because the activity ID is client-generated and the API's create is idempotent.
- `apps/admin/` — Next.js admin console, fully separate from `apps/web` (not athlete-facing). `User Lookup`/`User Detail` run on **real backend data** via the `/v1/admin/*` endpoints above, gated by an `ADMIN_USER_IDS` allowlist the backend independently enforces. Lookup lists everyone the API knows about — including users with training but no profile row, who are exactly the accounts support gets asked about — with sessions, sets, disciplines and last-session date. Detail adds recent sessions, that athlete's health events, and — for a BJJ-enabled athlete with a recorded rank — a belt beside their name, read-only, in a third request. Every number is an aggregate over rows that already exist; nothing was added to the write path to produce them.
- `tests/functional/` — a Playwright-based functional test suite (user-authored, in progress).
- `assets/brand/` — the VOLA brand kit and source of truth for identity: logos, app-icon/splash masters, 25 `currentColor` UI icons, and `design-tokens.json`. All SVG; the PNGs under `apps/mobile/assets/images/` are generated from these.

#### Observability

`GET /v1/admin/health` returns recent operational problems with a summary, and
`POST /v1/client-errors` lets a client report a failure the server cannot see —
a push it has given up retrying, which would otherwise leave training on the
device while every server metric stayed green. The admin console reads them at
`/health`.

Only notable events are stored (5xx and requests slower than `SLOW_REQUEST_MS`,
default 2000) — never every request. On a healthy system the table stays close
to empty, and that emptiness is the signal.

## Run it locally

```bash
docker compose up -d              # local Postgres on :5432
cd backend && go run ./cmd/migrate up
cd backend && go run ./cmd/seed   # reference content (exercise catalog); idempotent

pnpm run dev:api                  # backend API on :8080
pnpm run dev:web                  # web app on :3000
pnpm run dev:mobile               # Expo — Metro on :8081, press i/a/w for iOS Sim/Android/web
pnpm --filter admin dev --port 3001   # admin console on :3001 (needs its own port — apps/web also defaults to :3000)
```

Then open http://localhost:3000 (web) or http://localhost:3001 (admin). Each app needs its own `.env.local` (copy from `.env.example`) — the admin console additionally needs `ADMIN_USER_IDS` set to your Clerk user ID, matching the same var in `backend/.env`, before `/users` will let you in (find your ID via `GET /v1/me` or the Clerk dashboard).

### Run the backend tests

The Postgres integration tests **skip silently** unless `TEST_DATABASE_URL` is set, so `go test ./...` can look green while testing almost nothing. Give them their own database:

```bash
docker compose exec postgres createdb -U vola vola_test
cd backend && DATABASE_URL='postgres://vola:vola_dev_only@localhost:5432/vola_test?sslmode=disable' go run ./cmd/migrate up
```

Then set `TEST_DATABASE_URL` in `backend/.env` (see `backend/.env.example`) and run `pnpm run test:api`. Expect `PASS`, not `SKIP`.
