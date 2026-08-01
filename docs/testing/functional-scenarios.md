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

## Theming (`apps/web` light + dark, `apps/mobile` dark-only)

**Web**
- Loads **light** by default on a browser with no stored preference.
- The rail toggle switches to dark and back; the choice survives a reload and applies to every route.
- **No flash of the wrong theme on navigation.** A dark-mode user must never see a white frame — the theme is applied by a blocking inline script before first paint, not after hydration.
- Storage being unavailable (private mode) must not break the toggle; it just stops persisting.
- Solid buttons stay legible in both: lime fill only works against dark, so light uses navy with a lime label.

**Mobile**
- Dark in every case, regardless of the OS appearance setting — the palette exists in one direction only, so following the OS would render a half-styled app on a light phone.
- **No layout container may paint the page background.** Text inside a card sits directly on the card; a nested `View` stamping the page colour over its parent shows as a darker box behind every row, which is what happened before `Themed.View` stopped painting by default.
- The navigator supplies the screen, header and back-chevron colours from the VOLA palette rather than React Navigation's defaults.

---

## Workout authoring on web (`/dashboard/workouts`)

**Happy path**
- Create a workout from the list; it goes straight into the editor, since creating a template is never the goal and filling it is.
- The catalog pane is **always visible** beside the template — adding eight exercises is eight clicks with no modal cycle.
- Targets are edited inline in each row, with the fields decided by the exercise's `load_type`.
- Reorder by dragging, or with the per-row arrow buttons.
- ⌘/Ctrl-S saves; `/` focuses catalog search; Escape closes the create dialog.

**Edge cases & errors**
- Save is disabled unless something actually changed — an always-live Save trains people to ignore it.
- Leaving the page with unsaved edits warns before unload.
- A workout you don't own (shared, or a VOLA template) renders read-only with an explicit banner; the backend remains the boundary.
- The catalog pane scrolls independently, so the template beside it never moves.

**Not yet covered**
- No rename or visibility change after creation. No logging a session against a template.

---

## Workout templates UI (`apps/mobile` Workouts tab, `apps/web` /dashboard/workouts)

Domain: building and browsing workout templates. Mobile is the build surface; web is the read/planning surface, per the mobile-first split in `docs/decisions/system-design.md`.

**Happy path — mobile**
- The Workouts tab lists your templates with discipline, goal, and exercise count; a "Shared" scope shows public ones.
- "New workout" takes a name, a discipline, and — **only for strength** — a goal, since powerlifting/hypertrophy/endurance are things you do with the same barbell squat.
- Opening a workout shows its ordered exercises; "Add exercise" opens a picker.
- Reordering with up/down and removing an item both work; **Save appears only when something actually changed.**
- Verified live on a Simulator: created "Push Day A" (Strength · Hypertrophy), opened it, and the picker listed 498 strength exercises with movement pattern and equipment.

**The picker is filtered to the workout's own discipline**
- A strength workout's picker shows only strength exercises. This isn't cosmetic: workouts are single-discipline and the API rejects a mismatch, so an unfiltered picker would let someone choose an exercise only to be refused on save. Filtering makes the invalid choice **unreachable rather than merely rejected**.

**Target fields are driven by the exercise's `load_type`**
- A barbell squat asks for sets/reps/weight; a plank asks for sets/seconds; a run asks for distance/time. The editor branches on `load_type` alone, so adding an exercise to the catalog never means touching the UI. This is the payoff of carrying `load_type` as data.
- A unilateral exercise says so explicitly — "8 reps here means 8 each side".

**Permissions in the UI**
- A shared workout you don't own, and a VOLA template, both render read-only with an explicit banner rather than edit controls that would fail on save.
- The backend is still the boundary; this only avoids offering an action that would be refused.

**Edge cases & errors**
- **No screen may render an empty state before its first successful load.** The picker, the workouts list, and the library all gate their "nothing here" message on having loaded at least once — otherwise "No matching strength exercises" appears during the first fetch and reads as "this discipline has none". Caught live in the picker during testing.
- A failed load shows the API's own error message where it's actionable (a sport mismatch names the offending exercise), not a bare status code.
- Errors clear on the next *successful* load, not at request start, so a retry doesn't briefly look fine.

**Routing**
- **Pushing a screen over the tabs must not bounce back to the tab root.** The root auth effect redirected any signed-in user off any route outside `(tabs)` — harmless while sign-in was the only such route, and it made the workout detail screen unreachable the moment one existed. Now keyed on the sign-in screen specifically.

**Web**
- `/dashboard/workouts` lists templates in a scannable table; `/dashboard/workouts/[id]` shows every exercise with targets **and coaching notes** — the thing a large screen is genuinely better at and a phone mid-set is worse at.
- The table scrolls inside its own container so the page body never scrolls sideways.

**Not yet covered / deferred**
- No drag-to-reorder (up/down only), no rename or visibility change after creation, and no way to log a session *against* a template — which is the point of templates and the natural next increment.

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

## BJJ technique library (`/v1/techniques`)

Domain: the BJJ technique library — 450 entries with position, category, gi/no-gi, and the graph edges (`setup_from`, `common_counters`). Reference content, read-only, seeded from version-controlled JSON generated from the authored spreadsheet.

**Happy path**
- `GET /v1/techniques` returns the library ordered by position, then category, then name.
- `?position=Guard - Bottom`, `?category=Submission`, `?q=armbar` each narrow it; all filter server-side.
- `GET /v1/techniques/{id}` returns one entry with its full edge lists.

**Edge cases & errors**
- **`?gi=Gi Only` must also return techniques marked `Both`** — 304 of 450 are `Both`, so a filter that excluded them would hide most of the library rather than narrow it. Tested explicitly in both directions: `Both` entries appear, `No-Gi Only` ones don't.
- An invalid `?gi=` value → `400`, rather than silently returning nothing.
- LIKE metacharacters are literal: `?q=%` matches nothing.
- `?q=` over 100 characters → `400`.
- `GET /v1/techniques/{unknown}` → `404 not_found`.

**Seeding**
- Idempotent and value-idempotent: a re-seed with unchanged content leaves `updated_at` alone, so delta sync isn't defeated by a deploy.
- Malformed content fails before any write: duplicate ID, missing name/category/position, or an unknown `gi_no_gi` (the one field with a DB CHECK behind it).
- **A test asserts the library still carries graph edges** — if fewer than 90% of entries have `setup_from` or `common_counters`, the library has gone flat and the whole reason for a separate module from `exercises` has evaporated. That's the invariant worth guarding, not the row count.

**Auth & security**
- No `Authorization` header → `401`. Nothing here is user-scoped, so there's no IDOR surface — every authenticated caller gets an identical response.

**Not yet covered / deferred**
- Edges are name strings, not resolved references, so nothing validates that a named counter exists.
- `workout_items` can't reference a technique yet, so BJJ workouts remain exercise-only.
- No UI in any client.

---

## Exercise catalog (`/v1/exercises`)

Domain: the global, operator-authored exercise catalog — 524 entries imported from the authored spreadsheet — reference content shared by every user, with no owner. Read-only over HTTP; seeded from version-controlled JSON via `cmd/seed`.

**Happy path**
- `GET /v1/exercises` with a valid token returns the whole catalog, ordered by sport then name.
- `GET /v1/exercises?sport=bjj` returns only BJJ entries; `?q=squat` matches on name.
- `GET /v1/exercises/barbell-back-squat` returns that single entry with its full field set.
- Every entry carries a `load_type` from the fixed set — a client can decide which inputs to render from the catalog alone, with no hardcoded per-exercise knowledge.

**Media URLs**
- **A replaced image produces a different `url`.** Change `exercise_media.updated_at` for one row (or upload under a new storage key, the preferred workflow) and confirm the `url` in the API response differs. This is the whole mechanism: storage keys are stable, so without the `?v=` a replaced picture is served from `expo-image`'s disk cache until the app is deleted.
- **An unchanged image produces an identical `url`.** Equally load-bearing — a URL that varied per request would miss every cache and make the CDN pointless.
- **`url` is opaque.** No client reconstructs it from `storage_key`. Worth grepping for on any new client, because rebuilding the URL silently throws the version away and the only symptom is a stale photograph on someone else's phone.
- **Placeholder media is versioned too.** Exercises with no media of their own fall back to the per-sport defaults, which have no database row — their `url` must still carry a `?v=`, or `_defaults/` assets become the one set that can never be replaced.
- **No media origin configured** (local dev, CI) still yields `url: ""` and no stray `?v=`, and clients treat empty as "no image" rather than attempting a load.
- **A storage key that would break the URL is rejected at seed time.** `cmd/seed` fails on a key containing `?` or `#` rather than escaping it — a `?` truncates the path and a `#` becomes a fragment the server never receives, which disables cache-busting for that one asset with nothing reporting it. The 524-entry catalog must keep passing `TestSeedData_IsValid`.

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

**Default media**
- An exercise with no photo of its own returns its **sport's placeholder**, flagged `is_default: true` — so the grid never has holes.
- The flag must survive to the client. A placeholder indistinguishable from a real photo makes the coverage gap invisible, and an invisible gap never gets filled — with 463 of 523 exercises lacking their own image, that distinction is most of the catalog.
- An exercise that *does* have its own media never has it replaced.
- A sport with no configured placeholder returns an empty array, not a broken image.
- Placeholders are resolved at read time, not seeded — seeding would be ~1000 rows pointing at six files and would make "which exercises actually have a photo" unanswerable.

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

## Session logging (`/v1/sessions`, `apps/mobile` session screen, `apps/web` `/dashboard/sessions`)

Domain: a training session that **actually happened**, and the sets in it — reps, weight, RIR, RPE, and a set *type* (warm-up / working / back-off / drop / AMRAP / to failure). Deliberately distinct from a workout template: keeping the plan and the performance apart is what makes the prescribed-vs-actual gap measurable. Sets are rows, not an aggregate, because "3×5 @ 100" can't say the third set was heavier or the first two were warm-ups.

**Happy path**
- `POST /v1/sessions` with `{id, sport}` starts an empty session; with `sets[]` it starts pre-filled (the template case).
- `GET /v1/sessions/{id}` returns `{session, volume}` — the volume summary is computed server-side so both clients report identical numbers.
- `PUT /v1/sessions/{id}/sets` replaces the whole ordered list — the shape "log another set" and "fix a typo in set 2" both take.
- `POST /v1/sessions/{id}/finish` stamps `ended_at`; the session then reads as finished.
- `GET /v1/sessions` lists the caller's own, newest first; `?sport=`, `?exercise_id=`, `?limit=` narrow.
- `DELETE /v1/sessions/{id}` removes it; sets cascade.
- Retrying `POST` with the same `id` as the same user returns the original — an offline start must be safe to resend.
- **Every measure round-trips**: reps, weight, seconds, distance, RIR *and* RPE on one set, read back unchanged (`TestPostgresRepository_RecordsEveryMeasure`).

**Progressive volume — the property that matters most**
- A session opened from a template shows **zero** working sets, reps and tonnage until sets are ticked off. It must never open at the plan's total (`TestSummarise_CountsOnlyCompletedSets`).
- Each tick moves the numbers by exactly that set's contribution.
- An **uncompleted set contributes no effort** either — it must not set `hardest_rpe` (`TestSummarise_IgnoresEffortOnUncompletedSets`).
- The progression lookup ignores uncompleted sets: a weight planned but not lifted must never become evidence for the next recommendation.
- **Ticking a set starts the rest timer only when "Auto rest timer" is on.** It defaults **off**, so out of the box the Rest button is the only trigger. Un-ticking never starts rest, on or off. Un-ticking is allowed.
- **`completed` must survive the Postgres round trip.** It was written by `insertSets` and never selected back by `attachSets`, so every response reported zero volume and the mobile sync cycle would have written `false` over real flags. Assert it in `TestCreateAndGet_RecordsEveryMeasure` — adding it to that test's *fixtures* without an assertion is what let the bug ship green.
- **Migration check:** existing sets backfill to completed, so historical sessions keep their volume. Only new sets default to not-done.
- **There are five copies of the working-volume rule.** `Summarise` (Go), `localVolume` (mobile session), `workingSets` (mobile Today), the web history list's `working` filter, and the web session header. Changing the rule means changing all five — four of them drifted the first time, and the symptom is two screens reporting different numbers for the same session.
- **Every client that can create a set must be able to mark it completed.** The web logger couldn't, so web-logged sessions reported zero volume and vanished from the progression history entirely (then `LastPerformances`, now `RecentEfforts`).
- **The client's `localVolume` must match the server's `Summarise` exactly.** It's a deliberate duplicate so the header works offline, and it has already drifted once — the completion rule went into Go only, and a live session showed the plan's full tonnage against unticked sets.

**What the header shows**
- While training: time, sets, reps. **No tonnage, no top RPE.**
- Once finished: tonnage appears. Top RPE never does.
- Both remain in the `Volume` API response — dropping them from the UI must not drop them from the contract, since the trends screen will want them.

**Request cost of logging — worth actually measuring, not just reading**
- One set edit must cost **one** `PUT /v1/sessions/{id}/sets` and nothing else — no `POST /v1/sessions`, no `GET /v1/sessions`. It used to trigger a full `syncSessions` (every dirty session at 2–3 requests each, plus a pull of twenty) *and* re-send the idempotent create every time. Ninety-one requests for fifteen saves.
- The create fires **once per session**, not once per save — the `remote` flag records that the server has it. Deleting the session elsewhere and saving again must recreate it rather than fail forever.
- A push the server *refuses* (404, 409, `invalid_input`) must surface; a push that fails because the network did must not. A failed **local** write must always surface — that one is the save.
- A session whose local blob is unreadable must be skipped by the push, never sent as an empty set list (which would delete the server's copy).
- Reconciliation (`syncSessions`) belongs on screen focus, once — never on the save path.
- A failed push must not raise a banner mid-workout: the local write succeeded and the row stays dirty for the next sync. Only validation errors are worth showing.
- Capture the API's stdout to a file when checking this; `pnpm run dev:api` doesn't persist it anywhere.

**Session duration**
- The header clock runs from `started_at` and keeps time across backgrounding — derived per tick, never accumulated.
- A finished session's duration is fixed and stops ticking; it appears in the mobile recent list and the web history page.

**Rest, per exercise**
- Each exercise header starts its own rest, always available regardless of the auto setting.
- "Auto rest timer" is a **local** preference — the rest timer is mobile-only, so there's no second client to sync with.
- ±15s during a rest **persists to that exercise**, so the correction isn't repeated every set.
- Durations are local to the device by design — the rest timer is mobile-only, so there's no second client to sync with.

**Exercise detail (`apps/mobile` library → exercise)**
- Shows last weight, reps, effort and date, from the same endpoint as the progression suggestion — the two must never disagree.
- An exercise never logged shows an explicit "not logged yet" state, not zeros.
- The catalog entry renders even when the history lookup fails.

**Effort tracking preference (`profiles.track_effort`)**
- Default **on** — the progression rule has no other input, so off-by-default would make the app look broken rather than simple.
- Off hides the RIR and RPE fields entirely, not greyed out.
- Toggling it never alters recorded values; effort already logged stays in the database.
- **It must work with the API unreachable.** The switch reads and writes a local cache and pushes to the profile opportunistically — an earlier version reverted in a `.catch`, so a stopped API was indistinguishable from a broken control.
- Settings and the session screen read the same hook, so the switch and the visibility of the fields can never disagree.

**Volume arithmetic**
- **Warm-ups count toward neither working sets nor tonnage** (`TestSummarise_ExcludesWarmups`). Counting them inflates every number and makes a light day look like a hard one, which would poison anything built on top.
- `hardest_rpe` covers **working sets only** — a hard warm-up single mustn't set the session's headline difficulty. (It originally counted warm-ups, contradicting the schema's own wording; caught in review.)
- `exercise_ids` is the one field that *does* count warm-ups — it answers "what did I train", not "how hard did I train".
- Tonnage is `reps × weight` summed over non-warm-up sets; a set with reps but no weight adds reps and no tonnage.

**Auth & security**
- **A session is never shared, so someone else's is indistinguishable from a nonexistent one** — `GET`, `PUT .../sets`, `POST .../finish` and `DELETE` all return `404 not_found`, never `403` (`TestSession_OtherUsersSession_IsIndistinguishableFromMissing`). IDs are client-generated and therefore guessable; a 403-vs-404 split would confirm one exists. Same property regression-tested on workouts.
- `POST` with an `id` already owned by someone else → `409 already_exists`, carrying none of their data (`TestSession_RejectsAnotherUsersID`).
- `user_id` always comes from the token, never the body.
- `GET /v1/sessions` returns only the caller's rows, whatever the query parameters say (`TestList_IsUserScopedAndFiltered`).
- **A `workout_id` naming someone else's private template is indistinguishable from one naming nothing at all** — both `400`, same message (`TestCreate_PrivateWorkoutIsNotAnExistenceOracle`). Found in review: the field was written straight from the body to the FK, so a visible ID returned `200` and a nonexistent one tripped the foreign key and returned `400` — a working enumeration oracle over private workouts, since their IDs are client-generated and often guessable. Same bug class already fixed on the workout write paths, arriving through a different door.
- A **public** workout (or a VOLA template) *is* usable by anyone — the check gates on visibility, not ownership, or performing a shared workout would break (`TestCreate_AcceptsAPublicWorkoutFromAnotherOwner`).

**Edge cases & errors**
- **No mixed sessions**: a set whose exercise belongs to a different sport → `400`, naming the exercise (`TestSession_RejectsSportMismatch`).
- RPE outside 1–10, or RIR outside 0–20 → `400 invalid_input` naming the offending set index — **not `500`**, and never carrying raw Postgres constraint text (`TestSession_RejectsImpossibleEffortValues`).
- A non-positive rep count, weight, duration or distance → `400` **naming the set**, validated in the handler rather than left to the database's set-less "a value is out of range".
- A session whose `sport` disagrees with its `workout_id`'s sport → `400`; `sessions.sport` is denormalised from the workout and nothing in the schema keeps them honest (`TestCreate_RejectsWorkoutOfAnotherSport`).
- More than 500 sets → `400`; each set is a statement in a batch.
- An unrecognised `?sport=` or a non-positive `?limit=` → `400`, rather than silently returning everything.
- `PUT` with `{"sets": []}` empties the session rather than erroring.
- **Deleting the workout a session followed keeps the session** — `workout_id` goes null (`ON DELETE SET NULL`). History outlives the plan it came from (`TestSession_DeletingWorkout_KeepsSessionHistory`).

**Clients — the behaviours worth testing at the UI level**
- **There is no Save button on either platform.** Every edit writes through, coalesced ~700ms so a three-digit weight is one request rather than three. Killing the app mid-session must not lose the last set typed; navigating away, opening the exercise picker, or finishing the session must each flush a pending edit first.
- A save landing while a field is being typed must not overwrite it — the response updates the volume summary, never the set rows.
- **The previous set's weight and reps carry forward** on "+ Set"; **RIR and RPE deliberately do not**, since the third set at the same weight isn't the same effort as the first.
- Which inputs a set shows is driven by the exercise's `load_type` — a plank asks for seconds, a squat for weight and reps.
- The exercise picker is filtered to the session's own discipline, so a sport mismatch the API would reject is unreachable rather than merely refused.
- Starting from a template pre-fills one row per prescribed set with the prescribed numbers; the session opens ready to confirm, not to retype.
- A finished session is read-only on both clients — no set editing, no "+ Set", no "Add exercise".
- Mobile reloads on screen focus, so a set added in the picker sheet is present on return.
- Web warns before unload while an edit is still pending.

**Regressions worth keeping tests for (all found by using the app, not by review)**
- **`getToken` identity must not change between renders on mobile.** `@clerk/clerk-expo` rebuilds it every render; any screen listing it as a hook dependency then refetches in a loop, overwrites local state mid-edit, and runs unmount cleanups every render. Symptoms to assert against: reordering a workout's exercises must persist on screen, and a set added must stay visible. Use `useAuthToken()` rather than destructuring `getToken`.
- **"+ Set" must insert into its own exercise group**, not at the end of the session — otherwise in a multi-exercise session it forms a second block of the same movement at the bottom while the summary counts it.
- **A decimal weight must be typable** ("72.5" via "72." must survive) — the input holds the raw string, not the parsed number.
- **Saves must be serialised**, and `flush()` must await an in-flight save, or the exercise picker's read-modify-write can silently drop a set.
- **Swapping an exercise keeps the sets already logged**, rewriting them in place. Measures carry over only when the load types match; effort is always cleared.

**Not yet covered / deferred**
- **Weights and distances are kilograms and metres everywhere** — there is no unit preference, so a lifter who thinks in pounds can't use the app as-is. Needs a stored preference plus conversion at every display and input site; not built.
- **Sessions are online-only** — unlike `/v1/activities` they don't go through the SQLite outbox, so logging in a basement gym with no signal currently fails. The idempotent client-generated ID is already the right contract for fixing this; the local queue isn't built.
- No rest timer, no supersets (a set belongs to one exercise, and grouping is by adjacency), no per-set notes surfaced in either UI, and no editing of a session's name or notes after it starts.
- No history analytics — nothing yet reads sessions back to show progress over time, which is the point of collecting RIR/RPE at all.
- `GET /v1/sessions` is capped (50 default / 200 max) but has no cursor, so "all of last year" isn't expressible.

---

## Progression rules — double progression (`GET /v1/sessions/suggestions`, both clients)

Domain: what to load today and for how many reps, computed from the caller's own last few sessions. The thing in the product that advises rather than records, so it follows the standing rule — deterministic, and it always states its evidence.

Replaced the earlier single-set rule (`increase`/`repeat_consolidate`, now gone). **There is only one progression rule and it lives on the server** — no client has a copy, deliberately, because the working-set definition has drifted between copies twice before.

**The cycle** (all covered by pure-function tests, no database needed)
- Reserve left but the range unfinished → `add_reps`: same load, one more rep. Where most sessions land.
- Every working set at the top of the range **with reserve to spare** → `add_load`: add the movement's increment and reset reps to the bottom of the range.
- Three consecutive sessions at one load **with no rep gained** → `deload`: ~10% off, rebuild from the top of the range.
- **Climbing reps at a fixed weight is not a stall — it is the scheme working.** A lifter going 6 → 7 → 8 in a 6–10 range must never be deloaded. Counting "sessions at this weight" without checking reps deloaded them on session 3, and since a deload takes 10% off while the next `add_load` returns ~5%, the prescribed load ratcheted **downward** ~5% every four sessions forever. The regression test is an 8-session simulation of an athlete who does exactly what they're told, asserting the prescribed load never falls.
- At least one set short of the target reserve → `hold`.

**The gates, each independently testable**
- **The weakest set gates load, not the top one.** A session running 10 → 8 → 6 must never earn a load increase; it builds from the 6. The old top-set-only rule would have added weight to it.
- **Effort gates independently of reps.** Top of the range at 1 RIR is `hold`, not `add_load` — reaching the range by grinding is not the same lift. (This branch escaped the first round of mutation testing; it is covered now.)
- RIR 0, or RPE ≥ 9.5 → `repeat_hard`, whatever the reps said.
- No RIR **and** no RPE anywhere in the session → `repeat_unknown_effort`. **It must never guess** — absent effort data is not evidence a set was easy.
- Last performed over 28 days ago → `repeat_stale`, **and this outranks effort**.
- Not `weight_reps` → `not_applicable`. Never logged → `no_history`. **These two must be tested with an input built the way the handler builds it** (indexing a map that has no such key), not from a fixture that hardcodes `load_type`. A fixture-shaped test hid a bug where every exercise in a new user's first session was told a barbell squat "isn't measured in weight" — the query only learned an exercise's load type from a set row that existed, so no-history exercises arrived with an empty load type and hit the `not_applicable` guard first.
- **`target_reps` is always inside `rep_range`**, including on the "repeat what you did" branches. The range belongs to the *current* workout's goal while the history may come from a block with a different one, so a 15-rep hypertrophy set re-read under a powerlifting goal must not return "range 3–5, target 15".
- **`sessions_at_load` and `hit_target_effort` describe the history, not the branch taken.** They must be populated even on `repeat_stale` / `repeat_unknown_effort`, which return early.
- **An unusable newest session must not erase a real one behind it.** The SQL admits a row with any measure; the rule needs reps *and* weight. A weight-only row on a weighted lift passes one filter and fails the other, so the rule walks forward to the first usable session rather than reading only the newest.
- **Uncompleted sets are plan, not performance** — a template opened and abandoned must not become the next session's prescription.

**Rep range follows the workout's `goal`, not the exercise**: powerlifting 3–5, hypertrophy 6–10, endurance 12–20, general (and any unrecognised value) 5–8. The same 5-rep set at 2 RIR is `add_load` in a powerlifting block and not even at the top of the range in a hypertrophy one. An unknown `goal` must **not** 400 — it falls through to the general range.

**Increments** scale with the movement (5 kg squat/hinge/olympic, 2.5 kg push/pull/lunge, 1.25 kg isolation) **and are capped at 5% of the bar** — 2.5 kg is 1.8% of a 140 kg bench and 6% of a 40 kg one. Every suggested weight lands on a loadable 1.25 kg step; 63.7 kg is arithmetic, not a plate.

**Stall counting is consecutive.** A lifter who deloaded and worked back up to the same weight is on a fresh attempt, not a continuing plateau — counting every historical appearance would deload them the moment they returned. (This also escaped the first round of mutation testing.)

**Which sets the advice comes from** (`RecentEfforts`)
- The **working sets of the last 3 sessions** containing the exercise — whole sessions, because the rule reads the weakest set and repeated loads, and neither is answerable from one row.
- **Driven from the requested ids** (`unnest($2) JOIN exercises`, sets `LEFT JOIN`ed), so every requested exercise returns its catalog fields whether or not it has history — that's what makes "never logged" tellable from "not a weighted lift". Consequence for the security test: a leak is no longer "is the key present" (it always is) but "did any of another user's sets come with it".
- **The window numbers sessions, not rows** (`DENSE_RANK`, not `ROW_NUMBER`). A row-based window cuts a session in half and the surviving sets then look like the whole session to the weakest-set gate — the exact failure that gate exists to prevent.
- **Warm-ups are excluded**, even when heavier than the working sets. Tested with a deliberately heavier warm-up.
- **Sets with nothing recorded are excluded.** Found against real data: an exercise added to a session and never performed was winning over a real set behind it, erasing genuine history.

**Evidence must describe one real set**
- `last_weight_kg` / `last_reps` / `last_rir` / `last_rpe` all come from the **same top set**. `last_min_reps` / `last_max_reps` are the session-wide spread.
- Pairing the top set's weight with the session's best rep count describes a set nobody performed — and the 1RM estimate derived from it inherits the fiction. Caught during wiring; pinned by a test where the back-off set carries the most reps.

**Auth & security**
- Scoped to the caller — this reads training history, and `TestRecentEfforts_IsUserScoped` is the test that would catch it leaking.
- Missing `exercise_ids` → `400`. More than 100 → `400`.
- The route must not shadow `GET /v1/sessions/{sessionID}`; both are live (verify with two unauthenticated calls, each `401` rather than one `404`).

**Clients**
- Starting a session from a template pre-fills **weight and reps**: the plan's prescription wins, the recommendation fills the gaps. Reps are filled now where they deliberately weren't before — under double progression the rep target is half the recommendation.
- **The workout cache carries `goal`** (mobile SQLite schema v6). Without it the offline-first path — the one mobile exists for — always sent null and started sessions on the general 5–8 range while the session screen re-derived on 3–5. Test with the device offline and a cached template.
- **Applying a recommendation must never touch a completed set or a warm-up.** It writes only to sets still ahead of you. Rewriting a completed set's reps to a target puts numbers in the log that nobody performed and then counts them in the volume — and `add_reps`, where most sessions land, makes the control visible precisely when the early sets hold fresh real data.
- **The `goal` must be passed on every start path** (web workout detail, web history, mobile workout detail, mobile session start) and on the session screen itself. Missing it on one path fails nothing loudly — it pre-fills on the general 5–8 range that the session screen then re-derives on 3–5, and the two disagree quietly. Worth an explicit test per path.
- A failed suggestions lookup must not block the session starting — an empty weight is an inconvenience, a blocked workout is a lost one. A deleted template must likewise only cost the narrower rep range.
- **Recommendations must follow the exercise list, not just the initial page load.** Adding an exercise from the catalog mid-session has to fetch a suggestion for it. Fetching once on mount meant a freeform session — which starts empty, so the call asks about zero exercises — never showed a card for anything the athlete added. The refetch is keyed on the deduped, sorted exercise ids, so it fires once per change to *which movements are in the session*, not per set or per keystroke.
- Web (`ProgressionCard`) shows the phase, the target as `weight × reps`, the reason verbatim, the rep-range track, and the evidence. The rep-range track sits in the *evidence* section and is correctly absent for a first-time exercise; the range still reaches the athlete through the reason text. The rep-range pips fill to `last_min_reps` — filling to the best set would explain the wrong thing.
- Mobile shows the same recommendation compressed: phase, pips, target, one line of reason, one of evidence.
- The apply control is hidden once the first set already carries both halves, and on a finished session. Judged on the first set specifically: a session mid-flight legitimately has later sets empty.
- Rep ranges wider than the pip cap (endurance, 12–20) must degrade to a labelled bar (web) or text (mobile) rather than an uncountable row of dots.
- Phase colour is never the only carrier of meaning — every phase states its name in full-contrast text. `--c-lime` on a light surface is 3.27:1, fine for a graphic and not for a word.

**Not yet covered / deferred**
- No awareness of a programme's own periodisation — this is per-exercise autoregulation, not a block plan.
- No per-muscle-group or weekly volume landmarks, so "you are doing too much" is unanswerable.
- The rep range is the workout's goal, not a per-exercise choice — an accessory movement in a powerlifting session still gets 3–5.
- Deload adjusts load only, never set count or frequency.

---

## Rest timer (`apps/mobile` only)

Domain: the countdown between sets. **Mobile only, permanently** — an in-progress session is a phone thing, and a rest countdown on a desktop you aren't standing next to is decoration. Do not add scenarios for it under web.

**Happy path**
- The Rest button on an exercise header always starts the countdown. Adding a set never does. Ticking a set does only with "Auto rest timer" on.
- The default comes from the exercise's movement pattern: 180s squat/hinge/olympic, 120s push/pull/lunge, 60s otherwise, and 60s for time/distance work regardless of pattern.
- The bar shows remaining time, the exercise it belongs to, and a progress track that drains.
- ±15s adjusts; tapping the clock pauses and resumes; Skip dismisses.
- At zero it turns green, says "Rest done", and fires a success haptic.

**The property that matters most**
- **The countdown is derived from a stored end timestamp, never from an accumulated tick count.** Background the app for two minutes and the remaining time must be correct on return — a tick-based timer stops when iOS throttles the JS thread, which is exactly what happens when the phone goes in a pocket mid-rest. Test by backgrounding and restoring, not just by watching it run.
- Adjusting while paused must change the frozen remainder, not the (absent) deadline.
- The progress track must never overflow: +15s grows the total as well as the remainder.

**Edge cases**
- Starting a new rest while one is running replaces it and re-arms the completion haptic.
- Leaving the session screen ends the rest — it belongs to the session on screen, not to the app.
- The bar sits outside the scroll view, so scrolling the set list never hides it.

---

## Offline workout execution (`apps/mobile`)

Domain: logging a session with no connectivity. **Test this by actually stopping the API**, not by mocking a failure — both gaps found during development were things a mocked failure would have hidden.

**Happy path, with the API stopped**
- Starting a session (empty or from a cached workout) succeeds and opens immediately.
- The session screen renders: exercise names, the right measures per `load_type`, and a working volume summary — all from local data.
- Editing sets, adding, removing and swapping all persist locally.
- The exercise picker falls back to the cached catalog and filters it by substring.
- The start screen lists **cached workouts**. It must never say "no workouts yet" when the account has some — that's a lie at the worst possible moment.
- Finishing a session works offline.

**On reconnect**
- The session pushes and the dirty flag clears; Today's "N not synced" count goes to zero.
- **`started_at` is the real start time, not the sync time.** Verified: a session created at 22:42:30 with the API down arrived in Postgres with that timestamp.
- A retried push cannot duplicate — the ID is client-generated and create is idempotent.
- Push happens **before** pull, or the server's older copy overwrites unsynced local work.
- A session the device holds dirty is never overwritten by the pull.

**Edge cases**
- A corrupt `sets_json` blob must leave the session openable (empty set list), not throw.
- Local rows are scoped by `user_id` — a shared device must not show or push one account's sessions under another's token.
- Deleting offline removes it locally and best-effort remotely.
- A session started on another device cannot be opened offline; it must say so rather than appear empty.

**Known gaps to write scenarios for once built**
- **Sync is trigger-based** (screen focus, next edit, session start) — there is no connectivity listener, so regaining signal doesn't itself push. A `NetInfo`-driven retry is the next step.
- Suggestions are server-computed and don't appear offline.
- The workout cache covers `scope=mine` only.

---

## Units and settings (`profiles.unit_system`, both clients)

**The property everything else depends on: storage is always kilograms and metres.** Units are display and input only.

- Switching units must **never** change a stored value. Verified by round trip: with Imperial selected, typing `225` into "Weight lb" stores `102.06` kg, which renders back as exactly `225.0` lb.
- Switching to Imperial and back to Metric must leave every logged number identical.
- `PATCH /v1/profile` with `unit_system` outside `metric|imperial` → `400` naming the field.
- **`PATCH` on an account with no profile row** must not dead-end: the clients create the profile and retry, because Settings is reachable without onboarding.
- The preference is per **account**, not per device — set it on the phone, and the web app shows it too.
- Mobile reads it from a local cache first, so a session opens in the right units with no signal.
- The progression suggestion's `reason` must contain **neither "kg" nor "lb"** — the client renders the target in the athlete's own units, and a hardcoded unit would leak metric into a pounds interface. Asserted in `TestSuggest_IncreasesWhenRepsWereLeftInReserve`.
- Distance display switches by magnitude in both systems (m/km, yd/mi) — nobody says "0.02 miles".

**Per-exercise overrides** (`GET`/`PUT /v1/profile/exercise-units`)
- A **missing key means "use the profile default"** — no third state. Clearing an override deletes the row; the client drops the key rather than storing a sentinel.
- Flipping an exercise back to the account default must remove the override, not store a duplicate of the default.
- Overrides are per user: another account's must never appear in yours (`TestExerciseUnits_SetClearAndScope`).
- Setting the same exercise twice upserts rather than erroring.
- An unknown `exerciseID` → `400`, **not `500`** — the foreign-key violation is translated (`TestExerciseUnits_RejectsUnknownExercise`).
- A unit outside `metric|imperial` → `400`.
- **No raw Postgres text may reach the client.** A check violation is mapped by constraint name; the module used to echo `pgErr.Message`, which includes the offending value and the constraint body.

**Unit-aware surfaces:** session logger, workout template editor, workout cards, start chooser. The exercise library shows no weights, so there is nothing to convert there.

**Not yet:** the override applies on the session screen only — the workout editor uses the account default. Distance conversion is implemented but no screen takes a distance input yet, so that path is untested in anger.

## Library filter and search memory (`apps/mobile` Library tab)

- The **sport filter persists** across visits and app launches; it's a standing fact about the athlete.
- The **search box clears** on leaving the tab; it's a question already answered, and finding it still there makes the list look short for no visible reason.
- Both are stored per user — a shared device must not hand one account's filters to the next person.

## Today (`apps/mobile` Today tab)

The screen answers one question — *what am I doing right now, or next* — so
almost every scenario is about **hierarchy**: is the most urgent thing also the
most prominent thing.

**Happy path**

- **An unfinished session dominates.** With one open, `resume-session` renders
  above everything, the sport start buttons do **not**, and the elapsed time
  ticks. This is the regression that matters: it used to be a small "in
  progress" label on a row in a list, indistinguishable from finished sessions.
- **With no session open**, the start buttons render and `resume-session` does
  not. `start-session-strength` is the primary; `start-session-running` is
  visibly secondary.
- **`week-summary` counts only this week**, Monday-based, in the device's
  timezone. Log a session, check the count rises; a session from last Sunday
  must not be included.
- **Volume matches the session screen.** Working sets only — completed and not
  warm-up. A session showing "Sets 0" internally must contribute 0 here; the two
  screens disagreeing is the specific bug this rule exists to prevent.
- **`session-{id}` opens that session.**

**Edge cases & errors**

- **`start-session-bjj` does not exist.** BJJ is temporarily off Today because
  there is no BJJ module. When one lands, this scenario inverts.
- **The elapsed clock survives backgrounding.** Background the app mid-session
  for a minute and return: the time must be correct, not a minute behind — it
  recomputes from `started_at` rather than incrementing.
- **The date is never stale.** The regression to watch, because a tab screen
  never unmounts: use the app late on Sunday, background it, reopen on Monday.
  The header must read Monday and `week-summary` must be **empty or this
  week's** — not Sunday's date over last week's totals, which is what a
  mount-frozen clock produces. Both the focus and the app-foreground path need
  checking; they are different code paths and only one involves a tab change.
- **A session left open overnight stops pretending to tick.** Past 24h the card
  reads UNFINISHED with the start date instead of a running clock, and offers
  "Finish or discard". A resume button reading `506:24:12` is not information.
- **A second unfinished session is still reachable.** Start one on web (or from
  a workout) while another is open: the newest owns the resume card and the
  older appears in the list marked `unfinished`. It must not vanish — it still
  counts toward `week-summary`, so hiding it makes the header disagree with the
  list below it.
- **A permanently-refused session says why.** Retry must surface `sync-error`
  rather than spinning silently; `syncSessions` reports failures in its return
  value instead of throwing, so a discarded result means a stuck row is
  invisible forever.
- **`sessions-pending` appears only when something is pending.** With everything
  synced there is no counter and no Retry — the old permanent "0 pending · 0
  synced" is gone.
- **`retry-sync` drains and the counter clears.** Offline, log a session, come
  back online, tap Retry.
- **`today-empty` only after a successful local read.** A brand-new account sees
  it; a *failed* read must show `session-list-error` instead. An empty state is
  a claim about the athlete and has to be earned.
- **Everything renders offline** — the whole screen is local-first, including
  the week summary.

**Gone, and should stay gone**

- No activity logging UI. `activity-notes`, `log-activity`, `pending-count`,
  `sync-now` and `sync-status` were removed with the scaffolding. Nothing in the
  app creates activities now, so the admin activity list shows only historical
  rows — expected, not a bug.

## Mobile shell (`apps/mobile` tab navigator)

- **No seams.** Header, content and tab bar share one background; there must be no hairline rule or colour step between them, on tab screens *and* pushed stack screens.
- **The tab bar is flat and type-only**: uppercase labels on the app's own ground, a dot above the active tab, one hairline separator. No icons, no pill, no fill. It sits in normal flow, so nothing scrolls underneath it.
- Absolutely-positioned controls (the "New workout" button) sit above the bar, not behind it.
- **The wordmark must not collide with the Dynamic Island** — it sits below it. Check on a device with an island, not just a notch.
- The wordmark's chevron apex must be closed, and must point up.
- Screen names are small, uppercase, top-left; the wordmark is centred and stays centred regardless of the title's width.

## You, profile editing, and Settings (`apps/mobile`)

- **You** shows the display name, enabled sports and current units, and refreshes on focus so a save in Edit is visible on return.
- No profile row yet is an ordinary first-run state, not an error — You shows "Add your name" and Edit starts empty.
- **Edit** saves name, date of birth, sex and sport toggles. It must create the profile first when there isn't one: `PATCH /v1/profile` 404s otherwise, and Settings is reachable without onboarding.
- Tapping the selected sex again clears it — this feeds calorie maths and "unset" has to stay reachable.
- An empty name box saves as null, not an empty string.
- **Settings** is grouped rows with drill-downs, not a flat screen of controls. Units is its own sub-screen.
- **Sign out is in Settings under Account**, confirms first, and appears exactly once in the app.

---

## Modal sheets (`apps/mobile`)

- **Every `Modal` must paint its own background.** A modal renders outside the navigator, so the usual dark ground isn't behind it and `Themed.View` deliberately paints nothing — the sheet falls through to iOS white and near-white text vanishes. Regression-checked on the exercise picker and the new-workout sheet; check any future modal the same way.
- Body text must be legible against the sheet in both the picker and the composer — a screenshot check, since a typecheck can't see it.

---

## Training history (`GET /v1/sessions/history`, `apps/web` `/dashboard/sessions`)

**Happy path**
- A period with training shows five totals, a heatmap cell per trained day, weekly bars and the session list. Every figure comes from the API — none is recomputed in the browser.
- Switching period (4 weeks / 3 months / year) rescopes totals, calendar, chart and list together. No pane keeps stale numbers.
- Clicking a calendar day filters the list to that day and retitles the section; `Clear day` restores the full period.
- Sport chips carry counts from the **unfiltered** breakdown, so each says how much it would find. Selecting one narrows the totals *and* the comparison window — BJJ is measured against BJJ.
- Deltas compare against the immediately preceding window of the same length, not the previous calendar month.

**Edge cases & errors**
- Zero history renders the empty state, not zeroes; filtered-to-empty says so differently from never-trained.
- A sport with no tonnage (BJJ, running) shows `—` for tonnage with no delta caption, and the weekly chart switches to time. It must never draw a flat zero tonnage line and call it training.
- A day with two sessions counts as one active day and two sessions.
- Warm-up sets and sets never marked done contribute to no working-set, rep or tonnage total — the same rule as the session screen. `TestHistoryAgreesWithSummarise` pins the SQL to `Summarise`; it must fail if either moves.
- **Timezone**: a 19:00 session in a UTC-negative zone belongs to that evening's square, not the next day's. Check with `tz=America/New_York` against a session stored at 02:30Z.
- `from` after `to`, a malformed date, an unknown sport, an unknown timezone, or a range over five years each return `400 invalid_input`.
- `to` is inclusive — a session logged this evening appears when `to` is today.
- Distinct exercises and active days are period-wide, so they cannot be reproduced by summing the days.

**Auth / security**
- Unauthenticated → `401`. Another athlete's sessions never appear in any total, day bucket or sport count, whatever `from`/`to`/`sport`/`tz` are set to.

**Visual / accessibility**
- Solid buttons must have legible text in both themes. The `text-*` utility on a `<button>` was silently overridden for the whole app while the button reset sat unlayered — worth an explicit contrast assertion rather than trusting the class name.
- Trained calendar days are focusable and labelled with date, session count and sports; empty days are not focus stops.
- The weekly chart exposes each bar's value as text, so the trend is readable without seeing it.
- Large tonnage renders as `251.1t`, not `251147kg`.

## Training summary on the phone (`apps/mobile` YOU tab)

**Happy path**
- The YOU tab shows Sessions / Days / Time for the span, each with its change against the preceding span of the same length, then a day grid and a bar per week.
- Switching 4 weeks ↔ 12 weeks rescopes tiles, grid and bars together.
- Returning to the tab refetches, so a session logged since is reflected.

**Edge cases & errors**
- A day with training must never render in the rest-day colour. Specifically: a BJJ session with **zero working sets** inside a period that also contains lifting — the intensity measure is chosen per period but read per day.
- A week with sessions but no tonnage is dimmed, not drawn as absent, and the "N weeks in a row" count is taken from sessions rather than from the axis measure.
- No history → an invitation, not zeroes. A failed fetch says so and is distinguishable from "nothing logged".
- The streak counts **weeks**, not days: rest days must not break it. An unbroken run must not appear to reset on Monday morning before that week's first session.
- Large tonnage renders as `251.1t` / `231,196lb`, never `251147kg`.

**Visual / accessibility**
- The three grid colours must stay ≥3:1 against the card and ≥15 ΔE apart under normal vision — re-validate if the ramp or the surface changes, don't eyeball it.
- Trained days carry a date + session-count label; empty days are not accessibility stops.
- Bar heights: a trained week never rounds to invisible, and bars are capped in width so a 4-week span doesn't render as slabs.

## Session list paging, search and filters (`GET /v1/sessions`, `apps/web` History)

**Happy path**
- The list shows one page at a time with "1–20 of 43"; Newer/Older move between pages and disable at each end.
- Every session appears on exactly one page. Ordering is `started_at DESC, id` — without the id tiebreak, two sessions logged in the same second can swap places and one is shown twice while another is never shown.
- Searching by name narrows the list and the count together; clearing it restores them.
- Search and paging compose with the period, sport and picked-day filters, and any change of scope returns to the first page.
- `total` is counted with the same predicate in the same request, so the count can never disagree with the rows.

**Edge cases & errors**
- A search for `%` or `_` matches those characters, not everything — LIKE wildcards are escaped.
- Search is case-insensitive.
- `offset` below zero, `limit` below one, or `q` over 100 characters → `400 invalid_input`.
- A page past the end returns zero rows with the correct total rather than an error.
- A failed list fetch says so and is distinguishable from "no sessions match".

**Client aborts (`apihttp.WriteInternal`)**
- Cancelling an in-flight request must produce **499 and no ERROR log**, not 500. The history page aborts on every filter change, so this is the common path, not an edge case.
- The classification must survive the repository's `fmt.Errorf("%w")` wrapping — assert against a genuinely cancelled query, not a hand-made `context.Canceled`.
- `context.DeadlineExceeded` must still be a 500: that one is ours.
- A real failure must still log and must never leak the cause to the client.

**Wording**
- Cumulative load reads "Volume" everywhere it's visible, on both platforms. The wire field stays `tonnage_kg`.

## Estimated 1RM (`GET /v1/sessions/suggestions`, both clients)

**Happy path**
- Each exercise with a weighted last set carries `estimated_1rm_kg`, shown on the session logger's "last time" card and on the mobile exercise detail screen.
- `best_1rm_kg` is the highest estimate in the caller's history; when the current one matches it, the UI says "your best" instead of repeating the number.

**The arithmetic — assert the values, not just presence**
- A true single must estimate **itself**: 1 × 100kg → 100kg. (Epley would say 103kg; that's the regression this guards.)
- 5 × 100kg, no effort → 112.5kg.
- Effort changes the answer: 5 × 100kg at 3 RIR → 124.1kg; at 0 RIR → 112.5kg; at RPE 8 → 120kg.
- RIR wins when both RIR and RPE are present.
- Above 12 **effective** reps there is no estimate at all — 13 reps, or 10 reps at 3 RIR, both return null.
- Monotonic: more reps at the same weight, and more weight at the same reps, must both estimate higher.

**Personal best**
- The best is **not** the heaviest set: 5×100 (112.5) must beat a 110 single. A pre-filter on weight would fail this.
- Warm-ups, sets never marked done, and other athletes' sets are all excluded.
- An exercise with no qualifying history is absent from the map, not zero.

**Display**
- Estimates render at whole-unit precision (`144kg`, not `143.88kg`) — they're modelled, not measured.
- Exercises with no weight (BJJ, timed work) show no estimate rather than a dash-filled row.

## Search escaping, set ownership, and theme hydration

- A search for `%` or `_` in **any** search box (exercises, techniques, sessions) matches those characters, not everything. All three go through `database.LikeTerm` + `LikeClause`; the `ESCAPE` half is the one that gets dropped, and dropping it makes `50%` silently find nothing.
- `session_sets.user_id` must always equal its session's. It's derived inside the INSERT, so a mismatch means someone added a second write path: `SELECT count(*) FROM session_sets ss JOIN sessions s ON s.id=ss.session_id WHERE ss.user_id <> s.user_id` must be 0.
- The personal-best lookup must use `session_sets_user_exercise_idx` once a table has many users — `EXPLAIN` it with several athletes sharing one popular exercise, not with a single-user fixture, where a seq scan is correctly cheaper.
- Loading any page must produce **no hydration error** while `data-theme` is still applied before first paint. The two are in tension: removing the script kills the error and reintroduces the dark-mode flash.

### The candidate prefilter must never discard a record

`BestOneRMs` can't run Brzycki in Postgres, so it narrows candidates with `weight_kg * 1.44 >= heaviest` and estimates the survivors in Go. `heaviest` is a MAX **over the candidates**, which makes the pool load-bearing:

- **Candidates must be estimable rows only.** A row that survives the filter but cannot be estimated sets the bar and scores nothing, pruning every lighter set in its favour. Regression data: `100 kg × 10 @ 3 RIR` (13 effective — passes a reps-only filter, estimates nothing) alongside `60 kg × 12 @ 0 RIR` (estimates 86.4). Before the fix this returned **no record at all**.
- The property to assert is "if a set beats the best surviving **estimate**, the filter keeps it" — *not* "beats the heaviest weight". Those coincide only when the heaviest candidate is itself estimable, which is exactly the case that breaks.
- A fixture's deliberately-unestimable set has to be non-estimable **on effort**, not on raw reps. A 25-rep set is excluded from the pool entirely and never exercises this.
- The Go (`BestOneRM`) and SQL (`BestOneRMs`) implementations of "best estimate" must agree over the same history — and the fixture has to include the disagreeing class above, or the agreement is by construction.

---

## Personal records (`GET /v1/records`, `PUT /v1/records/pinned`, mobile YOU tab)

**Happy path**
- The YOU tab shows a card per pinned exercise with each record it holds, the set behind it, and a NEW badge when it was set recently.
- With nothing pinned, the API answers for the most-trained exercises — the view must never open empty asking to be configured.
- `Choose` opens the shortlist; tapping saves immediately and reflects on return.

**What must not count as a record**
- Warm-up sets, sets never marked done, and any other athlete's sets. Seed a heavier warm-up and a heavier unticked set than the real best — both must lose.
- Deleting the session behind a record, or correcting its weight, must change the record on the next read. Records are derived; there is no cache to invalidate and no stale PR to retract.

**The two kinds**
- Heaviest weight and estimated 1RM frequently cite **different sets**: 5×100 estimates 112.5 and beats a 110 single. A test that uses data where they coincide proves nothing.
- Which kinds appear follows `load_type`: a plank offers longest-time only, a run furthest-distance, bodyweight work most-reps. No exercise should advertise a record for a measure it doesn't take.
- Evidence travels with every record — reps, weight, effort, date and session.

**Web (`/dashboard/records`) — the fuller view**
- Lists every exercise trained, not the shortlist, with pinned ones first.
- Each record shows its value, the set behind it, and a link to that session. Following the link must land on the session the record actually came from.
- Search and sport filters narrow the list; an empty result is distinguishable from "no records at all".
- The star toggles the phone shortlist inline and persists — reload and it holds. At the cap it explains rather than silently ignoring the click.
- A record for a timed or distance exercise shows no reps/weight evidence rather than a row of dashes.

**Shortlist**
- At most 12; duplicates, blanks and unknown exercise ids each return `400 invalid_input` rather than a 500.
- Order is the athlete's, preserved on read; clearing is an empty list, not a special case.
- Another athlete's pins are never visible or writable.

## Strength calculation seams (`backend/internal/modules/session/strength_test.go`)

Domain: the properties that hold **across** the strength arithmetic rather than within any one function. `onerm_test.go` covers what `EstimateOneRM` returns; `progression_test.go` covers what `Progress` decides. These cover the joins between them, which is where things break silently — each side stays internally correct while quietly disagreeing with the other.

**The SQL prefilter must never discard a personal best**
- `BestOneRMs` can't run Brzycki in Postgres, so it narrows candidates with `weight_kg * 1.44 >= heaviest` and estimates the survivors in Go. Property: **if a set would beat the incumbent, the filter keeps it.**
- Asserted as that implication, not as `est <= weight × 1.44`, because the simpler form is false by one ulp: `w * 36 / (37 - r)` for w=42.5, r=12 is 1530/25 = 61.2 exactly, while `42.5 * (36.0/25.0)` is 61.199999999999996. The gap can only swallow an exact tie, and ties are discarded downstream anyway (`est <= best` skips).
- The bound must also be **tight** — a loose bound would satisfy the safety property while making the query read every set the athlete has ever logged.
- The constant is derived from `maxEstimableReps`, so raising the ceiling stays correct automatically. What it does *not* survive is a change to the formula, which is why the test sweeps the input space rather than trusting a comment.

**One domain rule, written twice, must agree**
- `EstimateOneRM` and `reserveOf` both convert RPE → reps in reserve, in different files. Same shape that has drifted here before (the working-set definition, twice).
- Both must prefer RIR over RPE where both are recorded, or a set reads as easy to one and hard to the other.
- `BestOneRM` (Go, over whole sets) and `BestOneRMs` (SQL prefilter + Go pass) must return the same answer over the same history — the pairing `TestHistoryAgreesWithSummarise` established.

**Prescriptions must be physically loadable**
- Every branch that returns a weight returns a multiple of 1.25 kg. A 63.7 kg recommendation renders fine and simply can't be followed.
- A deload must actually reduce the load. Below ~12.5 kg a 10% cut rounds back to where it started, and the rule correctly declines to call that a deload rather than prescribing the weight the athlete just failed to progress from.

**The increment table is a training judgement, not an implementation detail** — 5 kg squat/hinge/olympic, 2.5 kg push/pull/lunge, 1.25 kg for everything unmapped. Pinned explicitly so changing it is a deliberate edit to a test.

---

## Honest failure states (`apps/mobile`, every screen that loads before it writes)

The property under test is one sentence: **an empty state may only claim "you
have none" after a successful read.** Everything below is a variation on
running the same screen twice — once with a genuine 404, once with no network —
and asserting the two look different. Nothing structural enforces this, so a
new screen can reintroduce it silently.

Run every scenario in **airplane mode**, not against a stubbed 500: a dead
socket and an HTTP error take different code paths, and the offline one is what
athletes actually hit.

**Profile editing (`app/profile/edit.tsx`)**

- **A failed load withholds the form.** Offline, the screen shows
  `profile-edit-unavailable` and no fields — never a blank form with a live
  Save button.
- **The destructive case, explicitly.** With a profile that has a name, a date
  of birth and a sex set: go offline, open Edit, and confirm there is nothing
  to save. Then reconnect and confirm all three fields survive. This is the
  regression that matters — the old behaviour PATCHed nulls over all of them.
- **A genuine first run still works.** A brand-new account (real 404, online)
  must still get an empty form with Strength pre-enabled, and saving must
  create the profile.

**Pinned records (`app/records/pinned.tsx`)**

- **A failed load withholds the list.** Offline, `pinned-unavailable` shows and
  no exercise rows render — an all-unticked list asserts "none pinned" just as
  loudly as the old empty array did.
- **The destructive case.** With twelve lifts pinned: go offline, open the
  screen, confirm no tick boxes are reachable. Reconnect and confirm all twelve
  are still pinned.
- **A genuine empty list is still distinguishable.** Online with nothing
  pinned, "Nothing pinned — your profile shows the lifts you train most."

**You tab (`app/(tabs)/you.tsx`)**

- **A failed refocus keeps the profile.** With a loaded profile, go offline and
  navigate away and back. The name, sports and units must all survive, with an
  error line explaining the refresh failed. The old behaviour reverted an
  established athlete to "Add your name".
- **A failed *first* load withholds the body.** Cold-start the app offline and
  open You: `you-unavailable` shows, and none of "Add your name" / "None chosen
  yet" / "kilograms · metres" render. These are defaults standing in for
  unknowns, and an error banner above them doesn't stop them being read as
  fact — the refocus fix alone left this case wrong.
- **A genuine 404 still shows the empty state**, with no error line.

**Exercise detail (`app/exercise/[id].tsx`)**

- **"You haven't logged this yet" is never shown on failure.** Offline, an
  exercise you *have* logged shows `exercise-stats-unavailable`, not the
  never-logged copy.
- **The heading is never a UUID.** Offline the name comes from
  `exercise_cache`; with a cold cache it reads "Exercise" plus a note, never
  the raw id.
- **A cached entry admits it is partial.** Offline with a warm cache,
  `exercise-details-partial` shows and **no equipment suffix** is rendered. The
  cache doesn't store equipment, so printing the movement pattern alone would
  make a barbell lift read exactly like a bodyweight one — a new false claim
  introduced by the cache fallback rather than fixed by it.

**Units (`app/settings/units.tsx`)**

- **An offline change says it is local-only.** Switch units in airplane mode:
  the app switches immediately, `units-unsynced` appears, and no unhandled
  rejection fires.
- **The admission survives leaving the screen.** Still offline, navigate away
  from Settings and back. `units-unsynced` must still be there — it is stored
  in `prefs`, not component state, because the claim is still true and Settings
  is a screen people leave straight away.
- **Reconnecting propagates the choice rather than reverting it.** Come back
  online and reopen the app: the change must reach the account, `units-unsynced`
  must clear, and the *web app* must show the new setting. The regression to
  watch for is the opposite — the profile read winning and silently restoring
  the old units, which is what happened before the pending flag gated it.

**Error classification (`lib/apiError.ts`) — pure, no device needed**

- **401 is transient, not permanent.** The regression guard: an expired token
  mid-drain must leave the row pending, never blocked. It was classified as
  permanent on the session path and transient on the activity path, and the
  session path's answer would mark real training data dead.
- 408 and 429 transient; other 4xx permanent; 5xx and non-`ApiError` transient.
- `isNotFound` true only for a real 404, false for a network failure — this is
  the predicate every load screen above branches on.
- `isPermanentStatus` and `isPermanentRejection` agree for every status, since
  the whole point of the module is that they cannot drift apart.
## Local schema migration (`apps/mobile/lib/db.ts`)

The gap this closes: every scenario above starts from an app that already works,
so they all exercise the **upgrade** path. The **install** path — a database
that does not exist yet — had no coverage at all, and that is precisely where
`duplicate column name: remote` bricked every new install (see the 2026-07-30
history entry). A simulator that has run any earlier build cannot reproduce it.

**Happy path**

- **Fresh install can log an activity.** Delete the app (or the `vola.db` file),
  launch, sign in, log an activity, and confirm it appears with a pending count.
  This is the single scenario that would have caught the bug; nothing subtler is
  needed.
- **Fresh install can start and save a session.** Same starting state: Start
  session, add an exercise, enter a set, confirm it persists across an app
  restart.
- **Every offline surface works on a fresh install** — Today's activity list,
  the workout cache, the exercise catalog cache, and unit prefs. They share one
  database and one migration, so a migration failure takes all of them at once
  and any single one of them proves the migration ran.

**Upgrade paths** — each should reach the current shape and stamp the version.
Worth driving from a database seeded at a given `user_version` rather than by
installing historical builds:

- **v0 (no database)** — runs every branch. The case that broke.
- **v1** (`activities` only) — creates `local_sessions` and `workout_cache` at
  current shape, then must *skip* both `ADD COLUMN` steps.
- **v3, v4** — genuinely lack `remote`/`goal`, so both `ALTER`s must *run*. The
  mirror of the above: a guard that always skipped would pass the v1 case and
  fail these.
- **v6** — early return, no statements issued.

**Edge cases & errors**

- **A device bricked by the old code self-heals.** Seed the exact broken state —
  all tables at current shape, `user_version = 0` — launch, and confirm the app
  works with its rows intact. No reinstall, no data loss.
- **The v5-era mixed state heals too**: `local_sessions` *has* `remote`,
  `workout_cache` *lacks* `goal`, version 0. One guard must skip while the other
  fires, in the same run.
- **Interrupted migration.** Kill the app mid-migration and relaunch; it should
  converge rather than fail. `migrate()` is not transactional, so this asserts
  that every step is individually idempotent.
- **A failed migration doesn't cache its own failure.** `getDb()` nulls its
  promise on rejection, so a transient failure must not present as the database
  being permanently gone.

**Regression guard for the next column**

- **Adding a v7 column must not break fresh installs.** Whatever form it takes,
  the v0 scenario above has to keep passing. This is the check that keeps the
  invariant honest, since nothing structural enforces it.

## Health and observability (`/v1/client-errors`, `/v1/admin/health`, admin `/health`)

The property: **a problem that loses an athlete's data must become visible to an
operator.** Everything else here is in service of that.

**Happy path**

- **`user_id` appears on every authenticated request line.** The field the whole
  change hangs off — without it "which athlete hit this 500" is unanswerable.
  Check an authenticated call and an anonymous one (`/v1/healthz`); the latter
  should carry an empty user, not a fabricated one.
- **A 5xx returned through `apihttp.WriteInternal` lands in `health_events`**
  and shows on `/health` with its `request_id`, and that id finds the full
  request in the log stream. The pivot is the point.
- **A *panicking* handler currently records nothing** — `net/http` recovers per
  connection above this middleware, so neither the log line nor the recorder
  runs. That is the most severe 5xx class and it is invisible. Worth a scenario
  now so it isn't mistaken for coverage; closing it needs a recover layer in
  `httplog`, which is a behaviour change and deliberately not in this PR.
- **A slow request is recorded** past `SLOW_REQUEST_MS` even though it
  succeeded — set the threshold low to force one.
- **`POST /v1/client-errors` with `sync_blocked` shows up as "reported by
  client"** and links to that athlete.

**The exclusions, which are as load-bearing as the inclusions**

- **A 404 or 401 records nothing.** Routine client mistakes must not fill the
  screen; a health page that cries wolf is one nobody opens. Delete a session
  and re-request it — the 404 must leave no row.
- **A successful fast request records nothing.** Confirm the table is untouched
  after ordinary traffic — a row per request would be a write on the hot path of
  every call.

**Auth and trust**

- **A client cannot claim `server_error` or `slow_request`** — `POST
  /v1/client-errors` with either must 400. This is what keeps *measured* and
  *claimed* distinguishable, which is the table's whole value.
- **A client cannot report as another user.** There is no user field; the
  attribution comes from the token. Report as A, confirm the row is A's.
- **An oversized message is rejected** (>500 chars), so the endpoint can't be
  used as storage.
- **`GET /v1/admin/health` is admin-only** — 403 for an authenticated
  non-admin, 401 unauthenticated. The backend allowlist is the real boundary;
  the admin app's own gate is defence in depth.
- **`/health` in the admin app requires sign-in**, via `proxy.ts` — it matched
  only `/users(.*)` before this, so the scenario is that a signed-out visitor
  gets a sign-in prompt rather than the layout's "not authorized".

**Edge cases**

- **A quiet page reads as good news**, not as a failed load: "nothing recorded"
  rather than an empty table. A *fetch* failure must surface through
  `error.tsx` instead, so the two can't be confused.
- **Reporting never breaks the app.** With the API unreachable, a permanent sync
  rejection still shows its message on the session screen and no unhandled
  rejection fires — the report is fire-and-forget and its loss is acceptable.
- **Affected-athlete count is distinct users, not events.** Record five events
  for one user; the summary must say 1.
- **A recorder failure doesn't fail the request.** Point the pool at a dead
  database mid-request and confirm the user still gets their response —
  observability failing must not become an outage of its own.

## Mobile sign-up (`apps/mobile/app/sign-up.tsx`)

The property: **an athlete with a phone and no account can get from the App
Store to a logged set without ever opening a desktop browser.** Every scenario
below is either that path or a way of falling off it.

**Happy path**

- **Create an account end to end.** Email + password → the emailed code → landed
  in the app, signed in, with a session token that authenticates a real backend
  call. The last clause is the one worth asserting: `setActive` succeeding is
  not the same as the app being usable.
- **Both entry points reach the screen.** "Create an account" from sign-in, and
  a direct load of `/sign-up`.

**Routing — this is where the screen was nearly unreachable**

- **A signed-out user opening `/sign-up` stays there.** The root layout's guard
  keyed on `segments[0] === 'sign-in'` alone before this; anything else got
  `router.replace('/sign-in')`, so the screen would have bounced instantly.
  Test the redirect in both directions: signed-out reaches either auth screen,
  and a **signed-in** user opening either one is bounced into the app.
- **The address survives the hop between the two screens.** Sign-in → sign-up
  and sign-up → sign-in both carry `email` as a route param. Typing an address
  twice on a phone keyboard is the thing this prevents.

**Interruption and resumption — the dead end this screen is built to avoid**

- **Force-quit at the verify step, reopen: you are still at the verify step.**
  Two separate mechanisms have to both work, and testing only the second one
  proves nothing:
  1. **The root guard sends you to `/sign-up`, not `/sign-in`.** A relaunch is
     signed-out, and the guard's default for signed-out is sign-in. It checks
     for an in-flight `signUp` first. Without this the resume below is dead
     code — reachable only by a user who happens to tap "Create an account".
  2. **The screen restores the verify step** from `status ===
     'missing_requirements'` + `unverifiedFields`.
  Skip either and the app reopens on a blank form that then rejects *its own*
  half-registered email as already taken, with no way forward but a different
  address. This is the highest-value scenario on the page.
- **The password you just chose cannot sign you in yet.** Worth asserting
  explicitly, because it is *why* the routing above matters: an unverified
  account fails password sign-in with an error that says nothing about sign-up.
- **Resend is immediately available after a resume**, not behind a cooldown
  counted from a mount that knows nothing about when the first code was sent.
- **The resume cannot fire twice.** It is guarded by a ref, not by dependencies;
  a re-render while someone is typing on the details step must not yank them
  back to verify.

**Edge cases and errors**

- **A rejected code clears the field; a network failure does not.** Wrong code →
  cleared, ready to retype. Airplane mode mid-verify → the six digits you
  correctly typed are still there. Retyping a code because the wifi dropped is a
  punishment for the wrong mistake.
- **The sixth digit submits on its own**, exactly once — no double-submit when
  the button is also tapped, and no retry loop when the code is wrong.
- **A short password never reaches the network.** Under 8 characters is caught
  locally, focuses the offending field, and costs no round trip.
- **Clerk's own password rejection lands under the password field** — a
  breached-password or too-common rejection, surfaced verbatim rather than
  paraphrased. The instance is the authority on its rules; the screen asserts
  only the 8-character minimum it can back.
- **An already-registered email errors on the email field** and offers "Sign in
  to that account instead", carrying the address across.
- **`create` succeeds but the code send fails** → you land on the verify step
  with "tap Resend", not back on a details form that would now claim your own
  brand-new account's email is taken. **And the heading must not say "we sent a
  code"** — the send is precisely what failed. Same rule on a resumed sign-up,
  where whether a code is waiting is genuinely unknown.
- **Verification succeeds but `setActive` fails.** The verification is spent, so
  a second Verify tap can only produce a confusing rejection. The button must
  become **Continue** and retry the activation alone. Force it by killing
  connectivity in the instant between the two calls.
- **A pasted code with spaces or padding still works** — `"123 456"` must
  verify. A native `maxLength` would truncate it to five digits before any
  sanitizing runs, silently.
- **Resend cooldown counts down and then re-enables**, and a successful resend
  says so.
- **A network failure never claims a field is wrong.** With the API unreachable,
  the message is form-level and honest — no `errors` array means nothing is
  known to be wrong with the input.
- **Verified but still `missing_requirements`** names the fields the instance
  wants instead of dead-ending, the same way sign-in names an unsupported second
  factor. Only reachable by reconfiguring the Clerk instance, but the branch
  exists precisely so a config change surfaces as a sentence and not a hang.

**Verified on a simulator already (2026-07-31) — keep as regression checks**

- The `AUTH_ROUTES` guard: sign-in → "Create an account" reaches sign-up and
  stays. This is the one that silently breaks when a new auth screen is added.
- Unknown email on reset routes Clerk's message to the **email field**, with the
  create-an-account affordance.
- Sign-up local validation flags both fields, focuses the first bad one, and the
  content scrolls clear of the keyboard.

**Accessibility and input**

- **Nothing is signalled by colour alone** — every invalid field carries a
  written message beneath it as well as a red border.
- **The password can be revealed.** Typing a strong password blind on a phone
  keyboard is a top source of sign-up abandonment.
- **The keyboard doesn't bury the submit button** on a small device (iPhone SE
  is the case that matters), and the code field autofocuses on arrival.
- **Autofill hints are right**: `emailAddress`, `newPassword`, `oneTimeCode`.
  The one-time-code hint is what puts the emailed code in the QuickType bar.

## Mobile password reset (`apps/mobile/app/forgot-password.tsx`)

The property: **forgetting a password must not cost an athlete their account.**
Before this screen it effectively did — there was no reset path on the phone at
all, and the web one is only findable if you already know the web app exists.

**Happy path**

- **Reset end to end**: email → emailed code + new password → signed in, with a
  token that authenticates a real backend call.
- **The new password actually works.** Sign out afterwards and sign in with it.
  Worth its own scenario: everything else here can pass while the reset silently
  didn't take.
- **Reachable from sign-in** via "Forgot your password?", with the typed address
  carried across.

**The 2FA window — the part unique to reset**

- **On a 2FA account the password is saved *before* sign-in completes.** Clerk's
  `attemptFirstFactor` sets the password and *then* reports
  `needs_second_factor`. Test with a 2FA-enabled account and assert the screen
  says the password is saved on the second-factor step. A user who abandons here
  believing nothing happened will reset again — and the second reset invalidates
  the password they now actually have.
- **Abandoning at the second factor still leaves the new password live.** Kill
  the app at that step, then sign in normally with the new password.
- **An unsupported second factor names itself** and says the password is saved,
  rather than dead-ending.
- **The second-factor *send* failing must still say the password is saved.**
  Preparing an emailed code is a network call on the common path — kill
  connectivity between accepting the code and sending the 2FA code. The screen
  must not fall back to a generic "check your connection and try again" over a
  spent code, which is the one message that makes someone reset a second time.
- **`needs_new_password` must NOT claim the password was saved** — that status
  means the code was accepted and the password was not set. Only reachable by
  omitting the password from the attempt, but it is the one status where the
  claim would be exactly backwards.
- **A `complete` attempt with no session id doesn't silently do nothing.**
  `setActive({ session: null })` is a legal deactivate call that resolves —
  navigating nowhere and reporting nothing.

**Edge cases and errors**

- **Unknown email** reports that no account was found and offers to create one,
  carrying the address to sign-up. See the note below on why this is not the
  neutral "if an account exists…" wording.
- **Wrong or expired code** errors on the code field and clears it; a **network
  failure does not clear** a correctly typed code.
- **Weak new password** is caught locally under 8 characters; Clerk's own
  rejection (breached, too common) surfaces verbatim under the password field.
- **Resend cooldown** counts down, re-enables, and confirms on success.
- **Send failure** must not produce a heading claiming a code was sent — the
  send is exactly what failed. Same on "Use a different email".
- **`setActive` fails after a successful reset** → the button becomes
  **Continue** and retries only the activation. The verification is spent; a
  second Verify could only be rejected.
- **A network failure never claims a field is wrong** — form-level only.
- **A pasted code with spaces** (`"123 456"`) still verifies.

**Security**

- **The screen never signs anyone in without the emailed code.** The obvious
  one, worth an explicit negative test: submit the reset with a wrong code and
  assert no session is created and the old password still works.
- **Enumeration is deliberately not hidden here**, because `sign-up.tsx` already
  reveals whether an address is registered by refusing to reuse it. Neutral copy
  on reset alone would close nothing and would cost the user who mistyped their
  address a silent wait for an email that was never coming. **If sign-up ever
  stops leaking it, change both together** — that is the scenario to write then.
## Web auth presentation (`apps/web`, Clerk prebuilt modal)

The property: **the auth modal is the first VOLA surface a web athlete sees, so
it has to look like VOLA and it has to actually offer every route in.**

- **The landing page's Sign in control is a visible button.** Sounds trivial;
  it shipped as transparent text because `bg-foreground` isn't a token in this
  app's theme and Tailwind fails silently on unknown utilities. Assert a
  non-transparent computed `background-color`, not just that the element exists.
- **The modal says "Sign in to VOLA"**, never the Clerk dashboard's application
  name.
- **It follows the theme toggle.** Open the modal, switch light↔dark, and the
  card, inputs and buttons all re-theme — including the primary button
  inverting its fill/label pair. A hardcoded colour anywhere in `appearance`
  gives a white modal in dark mode.
- **Sign up is reachable** from the modal footer and lands on a VOLA-titled
  sign-up view.
- **Password reset is reachable** — the "Forgot password?" link on the password
  step. *Currently unverified*: it only renders after a real email is
  submitted. Worth doing once by hand.
- **Contrast holds in both themes** for the primary button and the footer link.
- **Check styling in BOTH themes, never just one.** `--c-lime` and
  `--c-accent-fill` are the same colour in dark and different in light, so a
  style that never applied can look perfectly correct in dark mode. The light
  theme is the one that exposes it.

## Google sign-in on mobile (`apps/mobile`, `lib/useGoogleSignIn.ts`)

The property: **every account that can be created on web can sign in on the
phone.** Google accounts have no password, so before this they simply could not
— which is the scenario to lead with.

**Must be run on a real device.** OAuth redirects through the `vola://` scheme
and Expo Go registers `exp://`, so the simulator/Expo Go flow used for the other
auth screens cannot exercise this at all. `expo run:ios --device`.

**Happy path**

- **An account created with Google on web signs in on the phone.** The
  regression test for the entire feature — **manually confirmed working on a
  real device (2026-07-31)**. Create via web's modal, then sign in on mobile
  with Continue with Google, and confirm an authenticated backend call succeeds
  afterwards.
- **A brand-new Google identity signs *up* from the mobile sign-up screen** and
  lands in the app — Clerk's OAuth covers both directions through one call.
- The button renders identically on sign-in and sign-up (shared component).

**Edge cases**

- **Cancelling the browser sheet shows no error.** Open Continue with Google,
  dismiss it, and assert the screen is unchanged — no error text, button
  re-enabled. Reporting a deliberate back-out as a failure is the same lie as an
  empty state claiming "you have none" after a failed read.
- **A Google account with 2FA** completes through the *existing* second-factor
  step on sign-in, not a second copy of that UI.
- **The same case from sign-up** points the user at sign-in, where **tapping
  Continue with Google again** completes it. Assert the instruction says that,
  not merely "go to sign in": sign-in does **not** auto-resume the in-flight
  attempt — it has no mount-time check of `signIn.status` — so a user who just
  navigates there sees an email+password form for an account with no password.
  Deliberate: auto-resuming would mean calling `prepareBestSecondFactor` on
  mount, which *sends* a code nobody asked for.
- **The primary submit is disabled while the OAuth sheet is open**, on both
  screens, so a password attempt can't race the SSO flow.
- **Password sign-in against a Google-only account** should surface "this
  account was created with Google". *Unverified*: it keys on Clerk's
  `strategy_for_user_invalid`, which hasn't been confirmed for this instance. If
  it never fires, the generic error still shows and the button is still visible.

**Security**

- **No token, code or session id is ever logged.** The OAuth flow handles
  credentials; grep the changed files for `console.*` as part of review.
- **Cancelling must not leave a partial session** — assert still signed out.

## BJJ technique library (`/v1/techniques`, mobile Library tab)

> **Superseded in part (2026-07-31):** techniques no longer have their own
> screen — they are merged into the Library list. The API scenarios below still
> apply as written; for the mobile UI see "Unified Library" at the end of this
> document.

The property: **every field the authoring spreadsheet carries is readable when
a technique is opened, and the library stays instant as it grows.**

**Happy path**

- The Library tab lists all 466 alongside the exercise catalog, scrolls smoothly, and opening one
  shows mechanics (`description`) *and* the decision (`when_to_use`) as separate
  sections.
- The IBJJF panel shows rule class and both divisions' belts.
- `setup_from` entries that name a real technique are tappable and navigate;
  everything else is plain text.

**Performance — the reason the API is shaped this way**

- **The list response must not contain prose.** Assert `description` and
  `when_to_use` are absent from `/v1/techniques`. Regressing to full rows takes
  the payload from ~65 kB to ~274 kB and nothing visible breaks — which is why
  it needs a test.
- **Typing in search issues no network request.** Search is local over an
  already-fetched list.
- `/v1/techniques/rulesets` is fetched once, not per row.

**The traps, each of which fails silently**

- **`is_restricted` must come from the API, never be re-derived.** A client
  computing it from belt-list length marks ~130 ordinary techniques as
  restricted (adult no-gi has no white belt division, so Blue/Purple/Brown/Black
  is the *baseline*). Assert the restricted count is ~20, not ~130.
- **An empty belt array means "division doesn't apply", not "no belts".** A
  gi-only technique must not render as prohibited in no-gi.
- **Unresolvable edges must not look tappable.** ~71% of `common_next_moves`
  and ~94% of `common_counters` name things absent from the library.
- **No video section when `video_reference` is empty** — it is empty for all
  466, so an always-present heading implies 466 missing assets.
- **Alias search works**: "scarf hold" finds "Kesa-Gatame Escape".
- **Empty states only claim emptiness after a successful read** — a failed
  fetch says the library is unavailable, not that there are no techniques.

**Seeding**

- Rulesets upsert before techniques (techniques carry the FK); a dangling
  reference fails with the technique named, not an opaque constraint error.
- Re-seeding is value-idempotent: `updated_at` must not move on a no-op.
- Re-importing the spreadsheet must not delete the 16 techniques in
  `techniques.additions.json`.

## Not yet covered (tracked here so it isn't lost, not because it's blocking)

- **Sign in with Apple.** App Store review requires it once an app offers a
  third-party social login, so shipping Google to TestFlight makes Apple a
  requirement rather than an option.

- Mobile auth has **no OAuth**.
- Mobile sign-up **collects no terms/privacy consent**, because there is no
  terms or privacy URL to link to yet. Add the scenario when there is one.
- Web/mobile nav destinations beyond Dashboard/Today (Calendar, Strength, BJJ, Nutrition, Insights, Account / Plan, Log, Progress, Profile) don't exist yet — add their scenarios here when each one is actually built, not preemptively.
- Admin has no real backend data (subscriptions, device/platform tracking, integration sync, support tickets) and no `Jobs & Webhooks`/`Audit Log` screens — none of these are designed yet; add scenarios once each lands for real.

## Unified Library — exercises + techniques in one list (`apps/mobile` Library tab)

Domain: one Library tab lists the exercise catalog **and** the 466 BJJ
techniques in a single alphabetically-sorted list, behind one search box and
one set of sport chips. There is deliberately **no separate techniques screen**
— a previous version had one and it is the specific thing these scenarios
guard against regressing to.

### Happy path

- The Library shows both kinds of row. Searching "armbar" returns techniques;
  searching "bench" returns exercises; **one box does both.**
- Every row draws a tile: the photo when the item has one, otherwise a
  three-letter code (`SUB`, `ESC`, `PIN`, …). No row is text-only.
- Tapping the **BJJ** chip shows techniques *and* the BJJ exercise drills — not
  drills alone. This is the exact bug the merge fixed; assert the list contains
  at least one technique.
- Under BJJ, a second row of position chips appears. Selecting **Mount** returns
  both Mount-Top and Mount-Bottom techniques (family match, not exact match).
- Selecting a non-BJJ sport hides the position chips **and clears** any position
  filter, so the list is not silently narrowed by an invisible control.
- The sport chip is remembered across visits; the search box is not.

### Edge cases & errors

- Techniques fail to load, exercises succeed → the exercise list still renders,
  with a distinct "Techniques couldn't load" message. The two halves fail
  independently and must not be reported as one outage.
- Exercises fail, techniques succeed → the exercise error shows; technique rows
  still render.
- Neither has loaded yet → spinner, **never** "Nothing here yet". The empty
  state may only claim emptiness after a successful read.
- A 10s timeout on the exercise fetch surfaces a message with a working
  recovery path (pull-to-refresh), not a silent empty list.
- Typing fast does not fire a request per keystroke, and a superseded request
  never overwrites a newer result or shows an error.

### Technique detail (`/technique/[id]`)

- Opening a technique from the Library shows the same tile and code as the row,
  so the transition reads as the row expanding.
- A graph edge that resolves to a library entry is tappable; one that doesn't
  renders as plain text and **looks** like plain text (no dead links).
- **A resolved edge shows the label the author wrote**, not the target's
  canonical name — except when the author wrote a raw id, the only unreadable
  form. Regression guard: "Straight Armbar" must not render as "Armbar from
  Closed Guard".
- `is_restricted` comes from the API and is never re-derived from belt counts.
  A no-gi list of Blue/Purple/Brown/Black is the **baseline** (adult no-gi has
  no white belt division), not a restriction — deriving it flags ~130 ordinary
  techniques instead of the real 20.
- An empty belt list renders its note ("N/A — gi-specific"), never "allowed at
  no belt".
- Sections with no content (e.g. `video_reference`, empty in all 466) do not
  render an empty heading.

### Auth / security

- Signed out, the Library tab is unreachable (the `AUTH_ROUTES` guard).
- Techniques are global reference content, identical for every user — the
  module-level summary cache surviving a user switch is correct, not a leak.
  Assert the API applies no user scoping to `/v1/techniques`.

## Unified Library on web (`apps/web`, `/dashboard/library`)

Domain: the same one library as the phone — exercise catalog plus the 466 BJJ
techniques in a single alphabetical grid, one search box, one set of sport
chips. The wide-screen difference is the detail panel beside the grid rather
than replacing it.

### Happy path

- The grid shows both kinds. "armbar" returns techniques, "bench" returns
  exercises, from one box.
- Every card draws a tile: photo when present, otherwise a three-letter code.
  No card is text-only, in **either** theme — regression guard for the
  achromatic tile that was invisible on white.
- The **BJJ** chip returns techniques *and* the BJJ drills, never drills alone.
- Under BJJ, position chips appear; **Mount** returns Mount-Top and
  Mount-Bottom (family match). Leaving BJJ hides the chips *and* clears the
  filter.
- Selecting a technique opens the panel with description, when-to-use, the
  gi/no-gi legality table and all three edge lists.
- **Clicking a resolved edge swaps the panel and leaves the grid, its scroll
  position and the search untouched.** This is the whole reason the web layout
  differs from the phone's; assert the search box still holds its query.
- `/` focuses search; `Escape` closes the panel.

### Edge cases & errors

- Techniques fail, exercises succeed → exercise cards still render, with a
  separate "BJJ techniques couldn't load" message carrying a **working** retry.
- Neither loaded → no "Nothing here yet"; an empty state may only claim
  emptiness after a successful read.
- A 10s timeout on the technique fetch surfaces the retry rather than leaving
  that half silently absent.
- Selecting a technique whose detail fetch fails shows an honest panel error,
  not a blank one.
- Rapidly selecting several techniques must not paint an earlier one's body
  under a later one's title (the panel is keyed on id and remounts).

### Auth / security

- Signed out, `/dashboard/library` redirects to Clerk sign-in (`proxy.ts`).
- Techniques are global reference content — the module-level cache surviving a
  user switch is correct, not a leak. Assert `/v1/techniques` applies no user
  scoping.

## Technique detail readability (mobile `/technique/[id]`, web detail panel)

### Happy path

- Opening a technique shows **numbered execution steps**, not a paragraph.
  Regression guard: "Armbar from Closed Guard" renders 5 steps beginning
  "Control wrist and elbow" and "Break posture" as *separate* steps — merging
  those two was a real bug in the first implementation.
- The hero shows the category eyebrow and name over the category watermark, and
  the title is legible against it (the scrim exists for this).
- Sections sit on distinct surfaces: How it works, When to use it, IBJJF, and
  the three graph lists are visually separable at a glance.

### Edge cases

- A technique whose description does not split into 2+ steps (6 of 466) renders
  the original prose under the same heading — **never** a one-item list.
- `executionSteps` must produce zero steps under 10 characters across the whole
  library; a stray "and" as its own numbered step is a failure.
- The mobile and web parsers must stay logically identical — a step boundary
  that differs between platforms is a content difference, not a styling one.
- Sections with no content still do not render (`video_reference` is empty in
  all 466).
- **Retry must not flash "Technique not found."** Tapping Try again shows the
  spinner for the duration of the request, never the not-found fallback.
- The step splitter must contain no regex lookbehind: `lib/api.ts` is imported
  by every dashboard page, and an untranspiled unsupported construct is a
  parse-time failure for the whole dashboard on older Safari.

### Media

- `heroImage` is not populated yet. When it is, the hero must swap to the photo
  with no layout shift, and the title must stay legible over a light image.

## Library after the BJJ drill removal

- Filtering the Library to **BJJ** returns techniques only — **no** Bear Crawl,
  Sprawl, Granby Roll or other conditioning drills. `GET /v1/exercises?sport=bjj`
  returns an empty list, and that is correct, not a failure.
- No exercise row renders a stock placeholder *for BJJ*; strength and running
  still do (unchanged, deliberately).
- A BJJ drill that a user has genuinely logged against survives migration 000019
  and remains visible — training history is never broken to tidy a catalog.
- Technique detail: `Set up from`, `Common next moves` and `Common counters`
  render as **plain text**. Nothing in those lists is tappable, and nothing in
  them should look tappable.
- Opening a technique makes **no** request for the full technique list — the
  detail screen no longer needs an index to decide what links.
- **A `sport='bjj'` session cannot contain a set, and a bjj workout cannot
  contain an item** — there is no bjj catalog entry to reference and techniques
  are not loggable yet. Any client that offers to add a set to a bjj session is
  offering something the API will reject.

## Discipline registry (`GET`/`PATCH /v1/modules`)

Domain: the server owns which disciplines exist, their labels and their
capabilities (`internal/platform/discipline`); per-user enablement lives in
`profile_modules` rows. `/v1/profile` no longer carries module booleans.

### Happy path

- `GET /v1/modules` returns every module in display order with `label`,
  `is_sport`, `default_on`, `enabled` and `capabilities`.
- A user who has never toggled anything gets `enabled == default_on` for every
  module, and **zero rows are stored** — defaults belong to the registry.
- `PATCH /v1/modules` with `{"bjj": false}` changes only BJJ and returns the
  full merged set.
- Labels carry acronyms: BJJ is `"BJJ"`, never `"Bjj"`.

### Edge cases & errors

- `PATCH` with an unknown key → 400 `invalid_input`, naming the key. A typo must
  not look like it worked.
- `PATCH {}` → 400. An empty body is a mistake, not a no-op request.
- `PATCH` for a user with no profile row → error (the FK is the guard).
- `nutrition` is a valid **module** but not a valid **sport**: `POST /v1/sessions`
  with `sport: "nutrition"` must be rejected.
- `GET /v1/exercises?sport=cycling` → **400**, matching sessions and workouts.
  It previously returned 200 with an empty list.

### Invariants

- Every registry sport has a `defaultMedia` entry — otherwise its exercises
  render imageless with no error anywhere.
- Adding a discipline requires no migration and no change to `profile_modules`.
  **Guarded by a test that writes a session for every registry sport** — this
  claim was false until migration 000021 dropped two SQL CHECK constraints, and
  nothing would have caught it.
- Toggling modules for a user with no profile returns a message that says so,
  not "unknown exercise".
- The four legacy `*_enabled` columns are unread; the down migration carries row
  values back into them before dropping the table.

## Module gating on mobile (Phase B)

### The loop that has to work

- Toggle a discipline in profile edit, save, go back: the tab bar, Today's start
  buttons and the Library chips **all reflect it immediately**, with no app
  restart. This failed completely in the first cut — the save never reached the
  provider — so it is the first thing to check.

### Cold start

- The tab bar must **not** rearrange after first paint, and Today must not flash
  "Choose what you train" before the real buttons. Both mean `ready` is being
  honoured.
- Offline, with a warm cache: everything gates from the cache; no spinner in
  front of the app.

### Network

- With BJJ off, opening the Library fires **no `/v1/techniques` request** — check
  the network log, not the pixels.

### Edge cases

- Every discipline off: Today offers "Choose what you train"; the new-workout
  sheet says so rather than showing a Discipline heading over zero chips; no
  workout can be created in a disabled discipline.
- A stored library filter naming a now-disabled discipline is not restored, and
  a filter whose discipline is disabled *mid-session* resets rather than
  narrowing the list invisibly.
- Sign out and sign in as a different user: the second user must never see the
  first user's tabs, chips or start buttons — including when the second user is
  offline and has never used the device.

## Module gating on web (Phase C)

Same registry, same rule as mobile — but the fetch is server-side, so the
failure modes differ. `/dashboard/layout.tsx` reads modules before anything
paints and hands them to `ModulesProvider`.

### The loop that has to work

- Turn BJJ **off** in `/dashboard/settings` → the Library nav item and every
  BJJ chip disappear **without a reload**, because `PATCH /v1/modules` returns
  the merged set and `apply` feeds it straight to the provider.
- Turn it back **on** → they return, same request count.
- The toggle survives a full page load (it is per-account, not per-browser).
- A discipline switched off **on the phone** can be switched back on here.
  That was the hole this closes: before it, web ignored the toggles entirely
  and offered no way to change them.

### Nav gating

- **Records** is hidden only when *no* enabled module has `record_kinds`.
  A BJJ-only athlete loses it; a runner keeps it (`longest_time`,
  `furthest_distance`). Assert on the capability, not on `sport === "strength"`.
- **Library** is hidden when no enabled module has a `catalog`.
- With **every** discipline off, the nav keeps Today/History/Settings — there
  must always be a way back to the toggles.

### Requests, not just pixels

- With BJJ off, loading `/dashboard/library` fires **no `/v1/techniques`
  request**. Verify in the network panel, not by reading the code.
- Toggling BJJ off *while on the Library page* clears the technique rows and
  fires no further technique request.
- Rendering N sessions must not fire N `/v1/profile` requests — the 200-request
  bug this provider shape exists to avoid.

### Failure

- If `GET /v1/modules` fails during the server render, the nav renders
  **ungated** rather than empty. A preference endpoint blinking must never hide
  the app.
- Settings with an unreachable API: the discipline section says so, and the
  units control still works.

## Today (`/dashboard`) reads real training

It previously read `GET /v1/activities` — a table with no writer — so it showed
0/0 and "Nothing logged yet" to athletes who had logged. Regression scenarios:

- An account with sessions but zero `activities` rows shows **non-zero**
  session and set counts. (This is the exact case that was broken; a test
  fixture with only `activities` rows would pass the old code and prove
  nothing.)
- The third stat follows **the data**, not the toggles: a strength-enabled
  athlete whose week was all BJJ sees *Mat time*, not `0 kg`.
- Week-over-week deltas are absent, not `+100%`, when the previous window is 0.
- Exactly three requests on load. Not one per session row.
- Volume renders in the athlete's unit system.

## Admin console on real training

### User lookup (`/users`)

- Columns are sessions / sets / disciplines / last session — all derived, no
  new write path.
- A user with a `sessions` row but **no `profiles` row** appears, with a blank
  display name. This is the regression that has now been introduced twice;
  it is the single most important scenario on this page.
- The header count says "known to the API", and that is literally what it
  counts — profiles ∪ sessions ∪ activities.
- Ordering is most-recently-trained first, with never-trained users last.

### User detail (`/users/{id}`)

- Shows summary stats, enabled disciplines, recent sessions and that user's
  health events — **two requests total**.
- Counts here **equal** the same user's row in the lookup table. The two come
  from different queries sharing one projection; a mismatch is a real bug.
- An id that exists nowhere returns **404**, not an empty page. Distinguishing
  "wrong id" from "idle account" is the point — the old page admitted it could
  not.
- A session with no `ended_at` renders as *In progress*.
- If the health fetch fails, the page still renders with a note; if the detail
  fetch fails with anything other than 404, it reaches the error boundary.
- Non-allowlisted signed-in user: blocked. Signed-out: redirected. The backend
  enforces this independently of the UI gate.

### Health retention

- Events older than 90 days are deleted when `cmd/seed` runs; newer ones
  survive. Verified by inserting rows either side of the boundary.
- A prune failure must not fail the deploy.

## Offline is not signed out (mobile token broker)

The scenario that produced this: an athlete at a gym, on a phone that had been
signed in for days, met "Not signed in." on every screen.

### The loop that has to work

- Sign in, use the app, then **kill the network** (airplane mode) and keep
  using it. Nothing may say "sign in" — not a screen, not a toast, not a
  redirect. The tab bar stays; the session stays.
- Wait past the token's lifetime (about a minute on Clerk's default, longer if
  `EXPO_PUBLIC_CLERK_JWT_TEMPLATE` is set) and try again. Failures must read as
  connectivity ("Can't reach VOLA. You're still signed in…"), never as auth.
- Restore the network. Everything resumes with no sign-in step.

### Cold start offline

- Force-quit while offline, relaunch still offline. The app must open to the
  signed-in shell, not the sign-in screen — the token is restored from the
  keychain.
- Same, but after the stored token has expired: still no sign-in screen, still
  a connectivity message.

### Clerk call volume

- Loading several screens in quick succession must not produce several Clerk
  token requests. A cold start followed by 40 API calls should cost **one**.
- The activity outbox draining N rows costs one token acquisition, not N.

### Auth that really is auth

- Sign out. The keychain entry is cleared, and the next account on the same
  device never authenticates as the previous one.
- A genuinely revoked/expired session (signed out elsewhere) must still reach
  the sign-in screen — offline tolerance must not become "never re-auth".

### Regression guards for the test itself

- Any test of "a valid token is still served while Clerk is unreachable" must
  assert **that a refresh was actually attempted**. With a long-lived token the
  broker answers from cache without consulting Clerk, so the test passes with
  the entire feature deleted — this happened, and is why the harness counts
  reaching the getter.

## In-session editing (mobile)

### Adding an exercise mid-session

- Edit a set's weight, then **immediately** tap `+ Add exercise` (inside the
  700ms debounce). Pick one, come back. **Both the edit and the new exercise
  survive.** This is the regression: the screen's queued write used to land
  after the picker's and silently revert the addition.
- Same for `Swap`, which already flushed.
- The new exercise appears without a pull-to-refresh.

### Prefill

- A session from a 3×5 template: fill set 1, tick it done → sets 2 and 3 take
  the same weight and reps, and stay editable.
- A value already typed into set 2 is **not** overwritten; its blank measures
  still fill.
- A completed set is never modified.
- Effort (RIR/RPE) is never prefilled.
- Squat / bench / squat: filling the first squat block does **not** reach the
  second one.
- Un-ticking a set fills nothing.

### Reorder / remove an exercise

- Move an exercise up: all of its sets travel with it, order survives a
  reload (positions are renumbered, not just reordered on screen).
- The up arrow is absent on the first exercise, the down arrow on the last.
- Remove asks first, and says how many logged sets it will delete.
- Neither control appears on a finished session.

### Done-set highlight

- Ticking a set tints the whole row, and the set number stays legible on it.
- Un-ticking returns it.

## Account preferences (units, effort tracking)

Both are account-level, cached locally, and now held once each rather than per
screen.

### Consistency

- With units set to imperial, **every** screen that shows a weight or volume
  shows pounds — Today, the finished-session summary, exercise detail, the
  workout editor. They previously resolved independently and could disagree.
- No screen shows a figure in kilograms first and corrects itself.
- A cold start makes **one** `GET /v1/profile` for units, not one per screen.

### Offline changes must not revert

- Turn effort tracking **off** with no signal. Leave Settings, come back: still
  off. Regain signal, wait for a profile read: **still off**, and the account
  now agrees. This used to flip back on by itself.
- Same for units.
- While the change is local-only, Settings says so.

### Account switching

- Sign out and in as someone else: neither preference carries over from the
  previous athlete.

## Sync orchestration (mobile, offline-first PR2)

### The loop that has to work

- Log a full session with the network off. Kill the app. Restore the network,
  reopen it: the session syncs **without visiting any particular screen**.
  Foreground alone is enough. This is the scenario the whole PR exists for.
- Same, without killing the app: background it, restore signal, foreground it.
- With the network still off, the pending count stays honest and the error
  reads as connectivity, never as auth.

### Coalescing

- Editing many sets quickly must not produce a sync per edit. A burst during a
  run costs the run in flight plus at most one follow-up.
- Opening Today, a session, and the picker in quick succession does not
  produce three concurrent syncs.

### Backoff

- With something pending and the network down, retries follow 5s / 15s / 60s /
  5min and stop lengthening there.
- With **nothing** pending, a failure schedules no retry at all — no waking up
  forever on the chance the network improved.
- A successful sync resets the schedule.

### Online vs refused

- An unreachable server marks the app offline.
- A server that answers and **refuses** (4xx) does not — it is online, with a
  problem worth showing.
- Retry (the button) always attempts, even when the orchestrator would have
  waited, and reports the outcome rather than spinning.

### Account changes

- Sign out with work pending: no queued retry fires against the previous
  athlete's rows.
- A signed-out app does not report "0 pending" as if everything were safely on
  the server — that state is unknown, not clean.

## Offline deletes (mobile, offline-first PR3)

### The loop that has to work

- Delete a synced session **with the network off**. It disappears immediately.
  Restore the network. It stays deleted — on the phone *and* on the web.
  Before tombstones it came back minutes later with nothing said.
- Force-quit between the delete and regaining signal: still deleted, and the
  delete still reaches the server.

### Edge cases

- Deleting a session the server has never seen (logged offline, never synced)
  clears on the next sync tick without any network call — the decision is made
  in the push, not at delete time, because reading it at delete time races a
  first push that is mid-flight.
- Deleting the same session twice, or deleting it on the web first, clears
  cleanly: a 404 on the delete counts as success.
- Opening a deleted session's screen by a stale link does **not** resurrect it
  from the server, and does not quietly cancel the pending delete.
- A pending delete counts toward "waiting to sync" — it is unsynced work.
- Tombstones are per-athlete: one account's deletes never hide another's
  sessions.

## Workouts readable offline (mobile, offline-first PR4a)

### The loop that has to work

- Open Plan with the network on, then kill it and reopen the app. **Your
  templates are there**, not an error. Before this the screen went straight to
  the network despite the workouts already being cached.
- The Shared tab still needs the network, and says so — an empty local list
  would falsely claim nobody has shared anything.

### Ownership and visibility survive the cache

Only `mine` lists are cached, so a VOLA template or another athlete's workout
cannot be in there today — scenarios about *those* belong to PR4b, when shared
templates start being cached. What is testable now:

- Your own **public** template keeps its "Shared" marking when the Plan tab
  renders it from cache. It previously lost it — the cache hardcoded
  `private` — which is the one genuinely user-visible half of that bug.
- A template whose visibility changed server-side shows the new value after
  the next successful refresh.
- Upgrading a device that already had cached workouts leaves them owned by the
  athlete they were filed under — **not** relabelled "VOLA template".

### Deleted workouts must leave

- Delete a workout, return to the Plan tab: it does **not** flash back. It
  used to, on every focus, forever — nothing ever removed a cached row.
- Delete one on the web, refresh on the phone: it disappears here too.
- Offline, a workout deleted while online is not listed.

### What is still online-only in PR4a

- Opening a workout's **contents** needs the network — the detail screen has no
  cached read, so offline it shows an error. Only the *list* is offline, plus
  the session-start path that already had its own cache.

## Workouts writable offline (mobile, offline-first PR4b)

### The loop that has to work

- With the network off: **create** a workout, **add exercises**, **save**. All
  of it sticks. Force-quit and reopen — still there. Restore the network: it
  appears on the web with the same contents.
- Edit an existing plan offline; the edit survives a refresh that pulls the
  server's older copy over it.
- Delete offline: it goes, and stays gone once signal returns.

### Ordering — the case that needs a gym

- Offline: create a workout, then **start a session from it** and log sets.
  Restore signal. The workout syncs first, then the session. Neither errors.
- While the workout is still unsynced, the session is reported as **waiting on
  a plan**, not as a failure — and the retry ladder keeps going. Calling it a
  failure would be wrong twice over: it alarms, and a 4xx would classify as
  permanent and stop the retries.
- The same holds for a **single** save, not only a batch sync: tick one set
  just after signal returns, while the workout is still unsynced. The debounced
  per-save push must defer too — not show an error and file a `sync_blocked`
  report mid-workout for a row that heals itself on the next run.
- **Delete the workout while a session started from it is still unsynced.** The
  session must still reach the server, with its plan link simply cut — the same
  thing the server's own `ON DELETE SET NULL` does. This is the case where the
  workouts-first ordering works *against* the session, and it fails
  deterministically rather than as a race, so a passing run proves nothing
  unless this exact sequence is the one exercised.
- If a workout create is **permanently** refused, every session referencing it
  defers forever — reported as waiting, indefinitely, with no repair path.
  Known gap; low probability, permanent when hit.

### Conflicts

- Edit a plan on the phone while offline, and the same plan on the web. On
  reconnect the phone's pending edit is not silently overwritten by the pull.
- An edit made *during* a push is not marked as sent — it goes out next pass.

### Never destroy local work

- A workout created offline is **not** removed by a server refresh that
  doesn't list it. The server has simply never heard of it.
- The same for a pending edit or a pending delete.
- **Check this on screen, not only in the store.** Reopen an offline-edited
  plan while online, before its push lands: the edit must still be displayed.
  Rendering the server's older copy undoes the edit visually while SQLite
  still holds it — and if the athlete edits on from what is shown, the save
  writes stale items over their own work. Same for the list: a
  just-created, unpushed workout must not vanish when a stale list response
  arrives.
- A save or delete that matches **no local row** (deleted on the web and
  reconciled away mid-edit) must report a failure, not navigate away as
  though it had worked. Deleting the same workout twice, however, is not a
  failure — a delete that isn't idempotent is the worse bug.

## In-session input ergonomics (mobile)

Both of these are about logging while standing up, so they only mean anything
tested on a device with a real keyboard and a real thumb.

### The keyboard must not cover the field

- Tap a set field near the BOTTOM of a long session. The field lifts clear of
  the keyboard with a margin under it — not merely "becomes scrollable to".
  Testing this on a short session proves nothing; the content has to be long
  enough that the field is genuinely behind the keyboard.
- Move from one field straight to another while the keyboard is already up.
  The second field lifts too. This is a *different* event ordering from the
  first tap and has its own failure mode — it is the one that breaks when
  only the focus event is handled.
- Dismiss the keyboard: the content slides back down.
- Repeat on a row with different measures (a distance/seconds exercise vs a
  weight/reps one) and on an expanded row — row heights differ, so any fix
  that assumed a constant height passes on one and fails on the others.
- **Repeat on Android, and treat it as a separate feature.** Two things differ,
  either of which makes it do nothing: Android emits `keyboardDidShow`, never
  `keyboardWillShow`; and its default `resize` mode shrinks the window instead
  of covering it, so the field is clipped by the scroll view's bottom rather
  than hidden behind the keyboard. A pass on iOS says nothing about Android
  here. (No Android build of this app exists yet, so this is untested.)

### Swipe a set away

- Swipe a set row left: a Delete button is revealed. Tap it; the set goes.
- **Scroll the list vertically, repeatedly, with slightly diagonal flicks.**
  It must scroll every time. A row claiming a mostly-vertical drag is the
  expected failure, and it is intermittent — one clean scroll proves nothing.
- Swipe a row open, then remove a *different* set using the row's own "Remove
  set" button. No row is left showing an armed Delete for a set that shifted
  into its place.
- Tap the done tick and the row's expand toggle while the swipe exists — both
  must still work, since the gesture must not claim on touch-down.
- Swipe on a FINISHED session: nothing happens. A finished session is a
  record, not a workspace.
- Delete the set that is currently being edited, and confirm the right one
  goes — rows are keyed by index, so this is where an off-by-one would show.

## Render-path regressions (mobile, automated)

These are covered by `apps/mobile/app/__tests__/` rather than by hand, and are
listed here because they are invisible to any store-level check — the SQLite
layer is correct in both cases and the screen is what goes wrong.

- Reopen an offline-edited plan while online, before its push lands: the edit
  is still on screen. Adopting the server's older copy here loses the
  athlete's work with their unwitting help, since editing on from what is
  displayed writes the stale items back.
- The converse, which is why it cannot simply always prefer the cache: with
  nothing owed locally, an edit made on the web must appear.
- A workout created offline stays in the list when a stale `listWorkouts`
  response arrives. Creating one fires the sync request and the list reload
  together, so this is the ordinary path, not a rare interleaving.
- The shared tab still renders the network list — only `mine` is cached, and
  the cache-first path must not swallow it.

## First run, and the catalog offline (mobile)

- **Install fresh, open once with signal, then go fully offline.** The
  exercise picker, the Library and the plan list all have content. This is the
  scenario the seed exists for and the one that used to fail: caches were
  filled only as a side effect of opening the screen that reads them.
- Kill the app mid-seed (or start it offline) and relaunch with signal: it
  seeds again. A partial run must not be recorded as done.
- **An exercise offline shows its muscles, equipment and instructions** — not
  an empty shell. Before v10 the cache stored seven columns and reconstructed
  the rest as blank, which looks like thin content rather than a cache.
- Change units offline, leave Settings, come back online: the choice sticks
  and reaches the account. Then do it on a device upgrading from an older
  build with an outstanding change — the debt must survive the upgrade.
- Change units twice in quick succession while the first push is in flight:
  the second value is the one that ends up on the account.
- Sign in as a second athlete on the same device: their first run seeds
  independently, and neither one's owed preferences leak to the other.
