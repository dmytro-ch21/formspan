# Functional test scenarios

Recommended end-to-end scenarios for every shipped piece of functionality — one section per feature, written to be translated directly into Playwright tests (`tests/functional/`, the user's own in-progress suite) or the equivalent for mobile. This is a planning/reference document, not test code itself, and doesn't assume or depend on `tests/functional/`'s current shape.

**How to use this doc:** each scenario is a concrete situation + expected outcome, grouped as Happy path / Edge cases & errors / Auth & security. Not every scenario needs its own test — some are natural to combine — but every one listed here should be *covered* by something before a feature is considered done.

**Keeping this current:** this is a living document, same discipline as `docs/decisions/history.md`. Whenever a new module or user-facing feature lands, add its scenarios here as part of finishing that work — see the standing rule in `CLAUDE.md`.

---

## Backend health check (`GET /v1/healthz`)

**Happy path**
- Request returns `200` with `{"service": "api", "status": "ok"}`.

**Edge cases & errors**
- API process down / unreachable — dependent clients (web, mobile) show a clear error state, not a silent hang or crash.

---

## Authentication (Clerk + JWKS verification)

**Happy path**
- Signed-out user can complete Clerk sign-in (email or OAuth) and reach an authenticated view.
- A valid session token sent as `Authorization: Bearer <token>` on `GET /v1/me` returns `200` with the correct `user_id`.
- Signed-in user can sign out via `UserButton` and is returned to a signed-out state.

**Edge cases & errors**
- No `Authorization` header on a protected route → `401 unauthorized`.
- Expired or malformed token → `401 unauthorized`, never a `500` or a raw JWKS/parsing error leaked to the client.
- Token signed by a different Clerk instance/environment (wrong `iss`) → rejected.
- JWKS endpoint temporarily unreachable from the backend → requests fail closed (reject), not open (accept).

**Auth & security**
- Confirm the error body on every rejected-auth case matches the standard `{"error": {"code": "unauthorized", "message": "..."}}` shape — no stack traces or internal error text.

---

## Profile module (`GET/POST/PATCH /v1/profile`)

Domain: one profile per Clerk user — display name, date of birth, sex, and four module toggles (`bjj_enabled`, `strength_enabled`, `nutrition_enabled`, `running_enabled`; BJJ/strength/nutrition default on, running default off).

**Happy path**
- `POST /v1/profile` with a new user's token creates a profile and returns it with default module toggles.
- `GET /v1/profile` returns the authenticated user's own profile.
- `PATCH /v1/profile` with a partial body (e.g. just `display_name`) updates only that field, leaving the rest unchanged.
- Toggling a module off (e.g. `running_enabled: false`) and back on preserves prior data rather than deleting it.

**Edge cases & errors**
- `POST /v1/profile` twice for the same user → second call fails with `409 already_exists`, doesn't silently overwrite.
- `GET`/`PATCH /v1/profile` before ever creating one → `404 not_found`.
- Invalid `date_of_birth` format or invalid `sex` value → `400 invalid_input`, not a raw DB constraint error.
- One user's token can never read or modify another user's profile (no `user_id` param to spoof — enforced entirely via the authenticated token).

---

## Web app shell (`apps/web`)

**Happy path**
- Signed-out visit to `/` shows the "VOLA" landing with a sign-in button (no sidebar).
- After signing in, landing on `/dashboard` shows the sidebar (wordmark, nav, account menu) plus a live healthz check and the authenticated `/me` result.
- Signed-in visit to `/` redirects straight to `/dashboard` (no dead-end landing page for authenticated users).

**Edge cases & errors**
- Signed-out visit directly to `/dashboard` (e.g. a bookmarked/shared link) redirects to Clerk's hosted sign-in, then lands back on `/dashboard` after completing sign-in (`redirect_url` round-trip).
- Backend unreachable while on `/dashboard` → the page shows "Failed to reach API: ..." rather than an unhandled exception or blank screen.
- Sign-out from `/dashboard` returns the user to a fully signed-out state — reloading `/dashboard` afterward redirects to sign-in again, it doesn't serve stale authenticated content from cache.

---

## Mobile auth + offline activity logging (`apps/mobile`)

Domain: Clerk auth (same instance as web/admin) with the session token in the OS keychain, plus offline-first activity logging — local SQLite write, then sync to `POST /v1/activities`.

**Happy path**
- Signed out, the app shows the sign-in screen; the tabs are unreachable.
- Email + password sign-in reaches the tabs. If the account has 2FA, a second-factor step appears with the right prompt for the strategy Clerk offers (TOTP / SMS / **email code** / backup code).
- Session survives an app restart (token cached in `expo-secure-store`, not lost on relaunch).
- Logging an activity while online writes it locally and syncs immediately → shows "synced".
- "Sync now" with nothing pending reports "Nothing to sync."
- Sign out returns to the sign-in screen.

**Offline & sync (verified end-to-end on a real Simulator)**
- With the API unreachable, logging an activity still succeeds locally and shows **pending**, with an explicit error (`Synced 0, 1 still pending — …Could not connect to the server.`) — never a false success.
- The pending row is genuinely in the device's SQLite with `synced = 0` (confirmed by querying the Simulator's `vola.db` directly).
- When the API returns, "Sync now" pushes it → "Synced 1.", the row flips to `synced = 1`, and the same client-generated ID appears in Postgres.
- Because the ID is client-generated and the API's create is idempotent, a retried sync of an already-synced row is a no-op, not a duplicate.
- Not yet covered: no automatic background sync (manual/on-log only), and no conflict resolution — activities are append-only so far.

**Multi-user on one device**
- The local outbox is scoped by `user_id`: signing out and signing in as someone else shows **their** activities, never the previous account's. A shared or handed-over phone is the realistic case here, not a contrived one.
- A row logged offline by user A and still pending when user B signs in must never sync under B's token — idempotency would make that mis-attribution permanent server-side.

**Edge cases & errors**
- Missing `EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY` → the app throws a named error at startup rather than rendering an app that silently can't authenticate.
- A second factor the app doesn't implement → the error names the strategy Clerk asked for, so the gap is diagnosable rather than a dead end.
- A **local database failure** (failed read, failed insert, bad migration) surfaces as an explicit message — never as "No activities yet.", which would disguise a failure as a legitimate empty state on an app whose whole promise is that the local write survived. This caught a real migration-ordering bug the moment it was added.
- Activity IDs come from a CSPRNG (`expo-crypto` `randomUUID()`), not `Math.random()` — the server treats this ID as an idempotency key, so a guessable one is security-relevant, not just a collision risk.
- A permanent rejection (4xx other than `401`/`408`/`429`) is reported as un-syncable rather than retried forever, so a poison row can't quietly inflate the pending count.
- Verified on the Simulator (loopback); a physical device needs `EXPO_PUBLIC_API_URL` pointed at the dev machine's LAN IP rather than `localhost`.

---

## Exercise library screen (`apps/mobile`, Library tab)

Domain: the mobile-facing view of the global catalog — browse, filter by sport, search by name, with images served from R2 via the API's assembled URLs.

**Happy path**
- The Library tab lists every catalog entry with its thumbnail, movement pattern, load type, and primary muscles.
- Tapping a sport chip filters server-side; "All" clears it.
- Typing in search filters by name, debounced so it doesn't fire per keystroke. Verified live on a Simulator: "press" narrowed to Bench Press and Overhead Press.
- Images come from Cloudflare R2 and are disk-cached by `expo-image`, so a second visit doesn't re-download.

**Edge cases & errors**
- An exercise with no media shows an explicit placeholder, not a broken image or an empty gap.
- `pickImage` falls back (thumbnail → demo → start) rather than showing nothing when the preferred kind is missing — an upscaled thumbnail beats an empty box.
- A failed fetch shows an explicit error; it must never render as an empty catalog, which would read as "no exercises exist".
- A filter matching nothing says "No exercises match this search", distinct from the never-loaded empty state.
- Rapid typing must not show stale results: each request aborts the previous one, so a slow early response can't overwrite a newer one.
- An aborted request is not an error — superseding our own request must not surface a failure message.

**Not yet covered / deferred**
- The catalog is fetched, not cached locally, so the Library needs a connection. Given the offline-first design this is a real gap — the catalog is exactly the kind of rarely-changing global content worth persisting on device.
- No exercise detail screen yet: rows are pressable but don't navigate.

---

## Web activities display (`apps/web`)

**Happy path**
- The dashboard lists the signed-in user's synced activities (kind, notes, occurred-at) from `GET /v1/activities` — the receiving end of mobile's sync.
- Timestamps render in explicit UTC (fixed locale/zone), avoiding an SSR-vs-browser hydration mismatch.

**Edge cases & errors**
- No activities → "Nothing yet — log an activity in the mobile app and sync it," not a blank panel.
- API unreachable or non-2xx → an explicit "Failed to load activities: …" message.

---

## Admin app shell (`apps/admin`)

Domain: fully separate from `apps/web`, not athlete-facing. Reuses the same Clerk instance; gated by both middleware (must be signed in) and an `ADMIN_USER_IDS` allowlist check matching the backend's own. **Runs on real backend data** (`/v1/admin/users`, `/v1/admin/users/{userID}/activities`) — no mock data anywhere in this app.

**Happy path**
- Signed in as an allowlisted admin, `/users` (User Lookup) lists every known user — with a profile or with activities: user ID, display name, activity count, last-activity timestamp — all from Postgres.
- Typing in the search field filters rows client-side by user ID or display name substring.
- Clicking a lookup row navigates to `/users/[id]` and renders that user's real activities (kind, occurred-at, notes) with the `request_id`/`trace_id` of the sync request that created each one.

**Edge cases & errors**
- Signed out, visiting `/users` or `/users/[id]` → redirected to Clerk's hosted sign-in, returns to the original URL after completing sign-in.
- Signed in as a **non-allowlisted** user → `/users` renders a plain "Not authorized" message instead of the shell.
- A user with no activities → honest "This user hasn't logged any activities yet" empty state, not a fabricated row.
- Zero users overall → "No users yet — a user appears here once they have a profile."
- Search matching nothing → "No users match this search" (distinct from the zero-users case).

**Auth & security**
- The allowlist check happens server-side (`app/users/layout.tsx`, via `currentUser()`), not hidden client-side UI. More importantly, the **backend independently enforces `RequireAdmin`** on every `/v1/admin/*` route — a non-admin can't reach this data by calling the API directly, so the UI gate is defence in depth rather than the security boundary.
- Admin fetches use `cache: "no-store"` — an admin tool showing a stale render of someone's account would be a correctness bug.

**Log tracing (verified end-to-end)**
- Create a real activity → the admin User Detail row shows its `request_id`; grepping the API's structured log output for that exact ID returns the `POST /v1/activities` line that created it (method, path, status, duration). Confirmed live: `request_id=f7e0fa0c589688d5` appeared in both the admin UI and the backend log.
- There is deliberately **no in-app log viewer** yet — the correlation ID is durably stored so a human can grep the real log stream (local terminal today, Railway's log viewer once deployed).

---

## Structured logging, request IDs, and trace context (`backend/internal/platform/httplog`)

**Happy path**
- Any request to the API gets an `X-Request-ID` response header and a `traceparent` response header (W3C format), and one structured JSON access-log line (`method`, `path`, `status`, `duration_ms`, plus `request_id`/`trace_id`/`span_id`).
- Sending a request with an `X-Request-ID` header already set → the same value is echoed back, not overwritten with a freshly generated one.
- `apps/web`'s dashboard generates one trace ID per page view (`src/lib/trace.ts`) and sends it as `traceparent` on both its `healthz` and `/me` fetches — the backend's access-log lines for both requests share the same `trace_id` with distinct `span_id`s, proving client-side trace correlation actually works.
- `apps/mobile`'s Today screen does the same (`lib/trace.ts`) for its one `healthz` fetch.

**Edge cases & errors**
- Sending a malformed or garbage `traceparent` header → ignored, a fresh trace ID is generated, the request still succeeds (never fails a request over a bad trace header).
- A rejected auth attempt (missing or invalid bearer token on `GET /v1/me`) → a `WARN`-level structured log line (`auth: rejected`, with `reason`) is emitted, correlated (same `request_id`/`trace_id`) with that request's access-log line.
- An unmapped internal error in the profile module → logged server-side via the request-scoped logger (`profile: internal error`), while the client still only sees the generic `{"error":{"code":"internal",...}}` body — the raw error never leaks over the wire.
- The backend's CORS middleware must allow `traceparent` as a request header (`Access-Control-Allow-Headers`) — a real bug caught during verification: without it, the preflight `OPTIONS` succeeds but the actual browser request fails with a CORS error, silently breaking every web-based request the moment a custom header is added.

**Not yet covered / deferred**
- `apps/admin` now propagates `traceparent` on its own admin reads too (added when it started calling the backend for real), so all three apps correlate.
- `cmd/migrate` (the one-shot CLI) intentionally keeps its plain `log.Printf` output — request/trace IDs don't apply to it.

---

## Server-controlled feature flags (`GET /v1/flags`)

Domain: operator-controlled, global on/off switches — distinct from the profile module's per-user `bjj_enabled`/`strength_enabled`/etc. toggles. Global booleans only, no percentage rollout or per-user targeting. **Read-only** — there's no write endpoint or admin UI yet; flags are toggled via direct SQL.

**Happy path**
- `GET /v1/flags` with a valid bearer token returns `200` with `{"flags": [...]}`, one entry per row in `feature_flags` (`key`, `enabled`, `description`, `updated_at`), sorted by key.
- The two flags seeded by the migration (`new_recommendation_engine`, `bjj_technique_video_upload`) come back with `enabled: false` by default.

**Edge cases & errors**
- No `Authorization` header → `401 unauthorized`, same as every other non-`healthz` endpoint.
- Zero flags in the table → `{"flags": []}`, never `{"flags": null}`.

**Not yet covered / deferred**
- No write endpoint (`PATCH`/`POST`) and no admin-console screen to toggle flags — real backend admin authorization exists now (`RequireAdmin`, see below), so this is no longer blocked on that; just not built yet. Toggling today is direct SQL only.
- No frontend app (web/mobile/admin) fetches or gates on any flag yet — this pass is backend-only, same scoping call as structured logging.
- No per-user/cohort targeting or percentage rollout — add if a real use case shows up.

---

## Workout templates (`/v1/workouts`)

Domain: user-owned workout *templates* — an ordered list of exercises with target sets/reps/loads. Distinct from a logged session (`/v1/activities`); keeping them separate is what preserves the planned-vs-actual gap. Shareable via `visibility`, with a nullable owner for VOLA-authored official templates. One discipline per workout.

**Happy path**
- `POST /v1/workouts` with `{id, name, sport, goal?, items[]}` creates it and returns it with items in the order sent.
- `GET /v1/workouts` returns the caller's own plus every public one; `?scope=mine` / `?scope=shared` narrow.
- `PUT /v1/workouts/{id}/items` replaces the whole ordered list — the shape both "add an exercise" and "reorder" take.
- `DELETE /v1/workouts/{id}` removes it; items cascade.
- Retrying `POST` with the same `id` as the same owner returns the original rather than erroring — offline creation must be safe to retry.

**Auth & security — the properties that matter most here**
- **A private workout is indistinguishable from a nonexistent one, on every path.** A stranger calling `GET`, `PUT .../items`, or `DELETE` gets `404 not_found`, never `403`. A 403-vs-404 split would confirm the ID exists, and since IDs are client-generated they're often guessable rather than random — that makes enumeration practical. Regression-tested (`TestPrivateWorkout_IsNotAnExistenceOracle`) because the original implementation had exactly this bug on the write paths while `GET` was correct.
- **A *public* workout returns `403`, not `404`, on write** — the caller can already read it, so there's nothing to hide, and a 404 would disguise a permission problem as a missing row.
- **Visible ≠ writable.** A public workout is readable by anyone, editable only by its owner. Official (null-owner) templates are read-only over the API entirely.
- `POST` with an `id` already owned by someone else → `409 already_exists`, and the response contains none of their data.
- A refused write must also not mutate: the victim's workout is unchanged afterwards.
- `owner_user_id` always comes from the token, never the request body.

**Edge cases & errors**
- **No mixed workouts**: an item whose exercise belongs to a different sport → `400`, and the whole create rolls back rather than leaving a partial row.
- An unknown `exercise_id` → `400 invalid_input`, not a raw foreign-key error.
- An out-of-range target (`target_sets: 0`, an oversized weight) → `400 invalid_input`, **not `500`** — a CHECK violation is bad input, not an internal failure. The message must not carry raw Postgres text, which names constraints and values.
- An unrecognised `?scope=`, `?sport=`, or `?goal=` → `400`, rather than silently returning everything or nothing.
- More than 200 items → `400`; each item is a statement in a batch.
- `visibility` defaults to **private** when omitted — sharing must never be the consequence of a missing field.
- `PUT` with `{"items": []}` clears the list rather than erroring.

**Not yet covered / deferred**
- No mobile or web UI consumes this yet.
- No way to rename a workout or change its visibility after creation — "I published this by accident" is currently a dead end.
- `GET /v1/workouts` is unbounded and `scope=shared` grows with the whole user base; needs a limit/cursor before real traffic.
- BJJ workouts only work because two BJJ entries live in the exercise catalog; a real technique library is its own module.

---

## Exercise catalog (`/v1/exercises`)

Domain: the global, operator-authored exercise catalog — reference content shared by every user, with no owner. Read-only over HTTP; seeded from version-controlled JSON via `cmd/seed`.

**Happy path**
- `GET /v1/exercises` with a valid token returns the whole catalog, ordered by sport then name.
- `GET /v1/exercises?sport=bjj` returns only BJJ entries; `?q=squat` matches on name.
- `GET /v1/exercises/barbell-back-squat` returns that single entry with its full field set.
- Every entry carries a `load_type` from the fixed set — a client can decide which inputs to render from the catalog alone, with no hardcoded per-exercise knowledge.

**Edge cases & errors**
- Name search is **case-insensitive** (`?q=SQUAT` matches "Barbell Back Squat") — a search that only matched exact case would be useless on a phone keyboard.
- A filter matching nothing returns `{"exercises": []}` with `200`, not `404` — an empty result is a valid answer to a valid question.
- **LIKE metacharacters are literal, not wildcards**: `?q=%` and `?q=_` match nothing rather than the whole table. Binding the parameter prevents SQL injection but not *pattern* injection — different problem, same untrusted input.
- `?q=` longer than 100 characters → `400 invalid_input`; no exercise name comes close, so anything longer is a mistake or an attempt to make the database work for nothing.
- `GET /v1/exercises/{unknown-id}` → `404 not_found`.
- `is_unilateral` is set on per-side exercises (the lunge) — 8 reps per side is not 8 reps, so any volume maths downstream must read it.

**Seeding**
- `cmd/seed` is idempotent: running it twice upserts the same rows, doesn't duplicate them, and preserves `created_at`. It's meant to run on every deploy, so a non-idempotent seed would be a live defect rather than a nuisance.
- Editing the JSON and re-running is how a catalog entry is corrected — there's no write API.
- Malformed seed content fails **before** touching the database: a duplicate slug (which would silently overwrite a different exercise), a missing required field, an unknown `load_type` (which no client could render), or a misspelled `sport`/`movement_pattern` each abort the run with a named error. The typo cases matter because the JSON is the authoring interface — `"strenght"` would otherwise seed a row that no `?sport=strength` filter can ever return, and a bad `movement_pattern` would silently break a future cross-sport rule.
- Seeding is **value-idempotent, not just row-count idempotent**: a re-seed with unchanged content must leave `updated_at` alone. Otherwise it degrades into "time of last deploy" and a client asking "what changed since X" gets the whole catalog back after every deploy — which defeats delta sync on an offline-first app.
- The whole catalog is written in **one transaction**, so a failure partway leaves the previous content intact rather than a half-updated catalog visible to readers.
- **The deployed environment must actually run the seed.** Migration `000004` creates an empty table; without a seed step the API serves `{"exercises": []}` forever, and because that's a valid `200` no healthcheck or error surfaces it. Covered by `railway/api.toml`'s `preDeployCommand`.
- The starter set covers all five `load_type` values, asserted by a test rather than left to drift as content is added.

**Auth & security**
- No `Authorization` header → `401 unauthorized` on both routes. The catalog isn't secret, but it's app content rather than public marketing, so it sits behind auth like everything else under `/v1`.
- Nothing here is user-scoped, so there's no IDOR surface: every authenticated caller is entitled to the identical response.

**Not yet covered / deferred**
- No media (images/video) — planned for object storage with Postgres holding only a key; no bytes exist yet.
- No user-authored custom exercises, no admin write path, and no pagination (12 rows). Filters are applied in SQL rather than in Go, so pagination can be added without rewriting the query.

---

## Activity module + real backend admin authorization (`/v1/activities`, `/v1/admin/*`)

Domain: the unified "activity envelope" (one table, `kind` + flexible `details` JSONB, not per-sport tables) — Phase 1 of the first end-to-end vertical slice (log on mobile → sync → display on web → find + trace in admin). Also the first real backend-side admin authorization: `RequireAdmin` (Clerk user ID allowlist via `ADMIN_USER_IDS`), closing a gap flagged when the admin console shipped mock-only.

**Happy path**
- `POST /v1/activities` with a valid bearer token and `{id, kind, occurred_at, notes?, details?}` creates the activity, stamped server-side with the caller's `user_id` and the current request's own `request_id`/`trace_id` — `200` with the full row.
- `GET /v1/activities` returns the caller's own activities, newest `occurred_at` first.
- `GET /v1/admin/users` with an `ADMIN_USER_IDS`-listed token returns every user the system knows about — anyone with a profile **or** any activity — as `user_id`, `display_name`, `activity_count`, `last_activity_at`.
- That includes a user with a profile but zero activities, **and** a user with activities but no profile yet (someone who logged before finishing onboarding — exactly the person an admin is most likely searching for). Their `display_name` is null rather than the row being missing. Regression-tested (`TestPostgresRepository_ListUsers_IncludesProfilelessUsers`) because the first implementation started `FROM profiles` and hid them entirely.
- `GET /v1/admin/users/{userID}/activities` with an admin token returns that specific user's activities, each with its `request_id`/`trace_id` — the "trace the request" mechanism: grep the backend's own log output for that ID to see the full request that created it.

**Edge cases & errors**
- **Idempotent create**: `POST`ing the same `id` twice (a real offline-sync retry scenario) returns the *original* row both times — same `request_id`, same `created_at` — never a duplicate, never an error. Verified directly: two live `curl` calls with the same `id` returned byte-identical `request_id`/`created_at`.
- **Idempotency is per-user, not global**: `POST`ing an `id` that already belongs to a **different** user → `409 already_exists`, and the response contains none of that user's data. The caller must never receive someone else's activity, and their own activity must never be silently discarded as a "duplicate". Regression-tested (`TestPostgresRepository_Create_RejectsAnotherUsersID`) — the first implementation looked the conflicting row up by ID alone, which made a guessed or replayed ID an IDOR.
- Missing `id`/`kind`/`occurred_at` → `400 invalid_input`.
- No `Authorization` header on any of these routes → `401 unauthorized`.
- A valid, authenticated token that **isn't** in `ADMIN_USER_IDS` → `403 forbidden` on both admin routes — verified live: a real signed-in token, temporarily excluded from the allowlist, got `403`, then succeeded once restored.

**Auth & security**
- Admin authorization is enforced server-side (`auth.Verifier.RequireAdmin`), not just `apps/admin`'s frontend allowlist gate — a non-admin authenticated user genuinely cannot reach `/v1/admin/*` by calling the backend directly, closing the exact gap `apps/admin`'s own history entry flagged as unresolved.

**Not yet covered / deferred**
- `apps/admin` now consumes the admin endpoints for real (Phase 5, done). Still not built: mobile offline logging + sync (Phases 2–3) and web activity display (Phase 4) — so the only way to *create* an activity today is a direct API call.
- `apps/admin` now uses the same `ADMIN_USER_IDS` allowlist as the backend (done in Phase 5) — one admin-identity convention across the stack.

---

## Not yet covered (tracked here so it isn't lost, not because it's blocking)

- Mobile has no auth yet (Clerk Expo SDK is a separate future increment) — no sign-in/sign-out scenarios apply to mobile today.
- Web/mobile nav destinations beyond Dashboard/Today (Calendar, Strength, BJJ, Nutrition, Insights, Account / Plan, Log, Progress, Profile) don't exist yet — add their scenarios here when each one is actually built, not preemptively.
- Admin has no real backend data (subscriptions, device/platform tracking, integration sync, support tickets) and no `Jobs & Webhooks`/`Audit Log` screens — none of these are designed yet; add scenarios once each lands for real.
