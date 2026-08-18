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
- `PATCH /v1/workouts/{id}` changes the name and nothing else — see its own section below.
- `DELETE /v1/workouts/{id}` removes it; items cascade.
- Retrying `POST` with the same `id` as the same owner returns the original rather than erroring — offline creation must be safe to retry.

**Auth & security — the properties that matter most here**
- **A private workout is indistinguishable from a nonexistent one, on every path.** A stranger calling `GET`, `PUT .../items`, `PATCH`, or `DELETE` gets `404 not_found`, never `403`. A 403-vs-404 split would confirm the ID exists, and since IDs are client-generated they're often guessable rather than random — that makes enumeration practical. Regression-tested (`TestPrivateWorkout_IsNotAnExistenceOracle`) because the original implementation had exactly this bug on the write paths while `GET` was correct.
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

Domain: the BJJ technique library — 542 entries with position, category, gi/no-gi, and the graph edges (`setup_from`, `common_counters`). Reference content, read-only, seeded from `techniques.json`, which is hand-authored in the repo. It was generated from a spreadsheet until that was retired in 2026-08 — see docs/decisions/content-authoring-design.md.

**Happy path**
- `GET /v1/techniques` returns the library ordered by position, then category, then name.
- `?position=Guard - Bottom`, `?category=Submission`, `?q=armbar` each narrow it; all filter server-side.
- `GET /v1/techniques/{id}` returns one entry with its full edge lists.

**Edge cases & errors**
- **`?gi=Gi Only` must also return techniques marked `Both`** — 377 of 542 are `Both`, so a filter that excluded them would hide most of the library rather than narrow it. Tested explicitly in both directions: `Both` entries appear, `No-Gi Only` ones don't.
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
### Function — what a technique does (`function`)

The verb axis, separate from `category`. Test the properties, not the counts —
except where a count is the property.

- **Every technique has a `function`, except the movement fundamentals.** The
  eight exceptions (Side Breakfall, Backward Breakfall, Forward Shoulder Roll,
  Grappling Stance and Motion, and — since the 2026-08 gap-fill — Alligator
  Walk, Backward Roll, Bridge Drill (Upa), Penetration Step) are library
  content rather than techniques and carry none. A *ninth* entry with no
  function should fail: it is far more likely an oversight than a new
  fundamental.

### Knee-on-belly — a glossary position with resident techniques (2026-08)

Knee on belly was a curated glossary position with **zero** techniques of its
own — only ever a transition destination. The gap-fill gave it eight resident
rows (`position_detail: "Knee on Belly"`), and `positions.json` now partitions
the Side Control family the way closed/open guard partition Guard.

- **The knee-on-belly glossary entry resolves exactly its own rows** — the
  eight `Knee on Belly`-detail techniques, not all of side control's.
- **Side control's entry excludes them** — the two lists partition the family:
  their counts sum to the Side Control family total, same invariant the
  closed/open guard split already pins.
- A `detail_includes`/`detail_excludes` string that no technique carries must
  fail seeding-side validation (a typo empties a list silently otherwise).
- **`function` is one of the five** — advance, reverse, escape, control,
  finish. The column has no CHECK constraint, so seed validation is the only
  thing between a typo and a value no client can render.
- **It is absent, not empty, in JSON** for the fundamentals — clients treat
  missing as "not applicable" rather than special-casing `""`.
- **It appears on the list payload, not only the detail one.** Clients answer
  "every way to escape from here" against the summaries they already hold; if
  it were detail-only that becomes one request per technique.
- **The axis genuinely cross-cuts `category`.** Advancing from standing spans
  Takedown and Transition; from guard-top spans Pass and Transition. A test
  asserting one category per function would be asserting the bug.
- **Changing only `function` still bumps `updated_at`.** The seed upsert gates
  on an `IS DISTINCT FROM` tuple; a field missing from it updates nothing and
  no delta-syncing client ever learns. Same class as the `completed` flag that
  was written but never read back. Test the **upgrade** path specifically —
  seed, `UPDATE techniques SET function = NULL`, re-seed — because a fresh
  seed into an empty table populates the column either way and proves nothing.
- ~~A re-import reproduces the library.~~ **Retired 2026-08** along with the
  spreadsheet: `techniques.json` is the source of truth now, not a build
  artifact, and `import-exercise-catalog.py` refuses to run. What replaced this
  scenario is the entanglement biconditional in `ValidateFields` — the one rule
  of the import-time derivation that is an invariant rather than a guess.

### Destination — where a technique leaves you (`to_position`)

Sparse ON PURPOSE (170 of 542). Test the invariants, not the coverage.

- **Every value names a real position.** The load-bearing one. `Side Control`
  instead of `Side Control - Top` produces an edge that resolves to nothing on
  every traversal, and nothing anywhere reports a fault — the seed validator is
  the only guard. Inject the typo and confirm the seed refuses by name.
- **The validator resolves against the library's own position vocabulary**, not
  a second hardcoded list. That set grew by one when leg entanglement was
  promoted; a list to keep in step is a list to forget.
- **Absent means NOT RECORDED, never "goes nowhere".** A client must not infer
  a self-loop from a missing key. The distinction only works because "stays
  put" is recorded explicitly — see below.
- **Self-loops exist and are correct.** A guard *break* records Guard - Top (you
  have broken it, not passed it); a single-leg entry records Standing (you have
  the leg, not the takedown). A test asserting zero self-loops would be
  asserting the bug.
- **Populated count only rises.** Pinned at 170 (was 149 before the 2026-08
  gap-fill; raising the pin is part of landing new content). A fall means
  authored data was
  lost rather than a decision being made — the values are hand-authored and
  exist nowhere else.
- ~~A re-import preserves them.~~ **Retired 2026-08**: nothing regenerates the
  file, so there is no longer anything for `to_position` to be carried forward
  THROUGH. The values live in `techniques.json` and are only lost if someone
  deletes them.
- **Changing only `to_position` still bumps `updated_at`** — it is in the seed
  upsert's `IS DISTINCT FROM` tuple. A field missing from that tuple updates
  nothing and no delta-syncing client ever learns.
- **The transition map answers.** `GROUP BY position, to_position` should show
  the passing game (Guard-Top → Side Control-Top), the takedown game (Standing →
  Guard-Top) and sweeps splitting between Guard-Top and Mount-Top. If those
  three shapes are absent, the data is wrong regardless of what validates.

### Leg entanglement as a position

- **The 26 ashi garami entries resolve to Leg Entanglement, not Guard.** Saddle,
  50/50, backside 50/50 and single-leg X. A heel hook from the saddle must not
  appear on the Open Guard screen beside a spider-guard sweep.
- **The near-misses stay out, by name.** `Judo Ashi-waza` is foot sweeps —
  same word, unrelated technique — and `Single-Leg Defense`/`Single-Leg Finish`
  are takedown work. Matching is exact; a substring match on "ashi" or
  "single-leg" sweeps all three in and the taxonomy starts lying.
- **Open guard is 124 and closed guard 37, and they partition the family.**
  The counts are pinned deliberately: "the two differ" passes on the exact
  regression this guards. They moved from 150/187 when the entanglements left,
  and should not move again without a position being added or removed.
- **Every technique position has a glossary entry behind it** (bar the single
  `Other`), or the Library offers a filter family the glossary cannot explain.
- **The mobile session-tag position chips include it.** That list is hardcoded
  for offline use, so it can silently fall behind the glossary — without it,
  "got swept from 50/50" has nowhere to go.

## Exercise catalog (`/v1/exercises`)

Domain: the global, operator-authored exercise catalog — 762 entries in `exercises.json`, hand-authored in the repo (imported from a spreadsheet until that was retired in 2026-08) — reference content shared by every user, with no owner. Read-only over HTTP; seeded from version-controlled JSON via `cmd/seed`.

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

### Timing any set (N4)

- **A duration makes a squat timeable.** Open a `weight_reps` set, type a
  duration into the Timer field, collapse the row: the play button appears.
  Clear the field: it goes away again. This is the whole feature — the timer
  follows the number, not the exercise.
- **Nothing is invented.** A `weight_reps` set with no duration gets no play
  button, and neither does a `distance_time` row with a distance and no time.
  A plank with nothing prescribed still defaults to 60s. The regression to
  watch for is a default leaking onto untimed sets.
- **A timed squat is still a weight×reps set** where it counts: tonnage,
  records and the fields offered must be unchanged by putting 40s on it. Its
  collapsed summary DOES gain "· 40s" — that is intended, and an earlier draft
  of this list asserted the opposite, which would have made a passing test out
  of a wrong expectation.
- **The target survives the timer.** Put 40s on a squat, run it, stop at 25:
  the row must still say 40. On a plank the opposite must hold — a 60s hold let
  go at 40 records 40. Same completion path, opposite answers, decided by
  whether `seconds` is the exercise's measure.
- **A dual-mode exercise is not offered the field at all.** Open a burpee set
  logged in reps: there must be no Timer field, because writing one would flip
  the row to time mode and strand the rep count. The mode toggle is the
  affordance there. This is the case that has no automated coverage — the gate
  is tested, its call site is not.
- **The circuit follows.** An exercise mixing a timed burpee set and a squat
  set with a duration should offer "run all"; remove the squat's duration and
  the offer must disappear, since the run is all-or-nothing.
- **Units.** The seconds/minutes chip should appear on an exercise that carries
  a timer target but does not measure time, otherwise the field has no unit
  control. Switching it must reinterpret the displayed number, not the stored
  one.
- **The server accepts it.** `seconds` on a `weight_reps` set is valid on the
  wire (the API only enforces `> 0`), so this must round-trip through sync
  rather than being repaired away on the client. Worth an explicit sync test:
  log a timed squat offline, sync, reload.

### Authoring grip on web (N10)

- **A deadlifter corrects a session at a desk.** Open a finished hinge session
  on web, set two sets to `mixed`, reload: the value persisted. This is the
  correcting case the platform rule already grants web — it does not make
  logging a desk activity.
- **The picker only appears where the movement has a vocabulary.** A leg press
  or a squat row shows no grip control at all; a deadlift, a carry and an
  olympic lift do. An empty picker is a question with no answers.
- **Back to unrecorded.** Set a grip, then choose the empty option: the set
  must return to no grip, not to "regular". The row summary should then show
  nothing rather than a default.
- **A grip outside the movement's subset stays clearable.** A set holding
  `angled` on a hinge (recorded before the subset changed, or by a newer
  server) must still appear in the picker as a selectable option — otherwise it
  is visible in the row and impossible to remove.
- **Carry-forward.** Add a set after one with a grip: the new row inherits it,
  the way weight and reps do. Effort (RIR/RPE) must NOT be inherited.
- **Parity.** Whatever web offers for a movement, mobile offers the same.
  `check:grip-parity` enforces *that* in CI — it compares the three `gripsFor`
  tables and nothing else. **Server acceptance is a separate guarantee**, held
  by `ValidGrip` and the CHECK constraint, which the script never reads. A
  functional test is what would catch the two disagreeing, as a 400 on save.

### Sync races on the pull side (T8)

- **An edit made while a sync is running survives it.** Start a sync, edit a
  session while it is in flight, let it finish: the edit must be on screen AND
  still queued. Losing either half is the bug — a kept name with `dirty` cleared
  is the quieter version, right on screen and never sent.
- **Ordinary editing is unaffected.** Two edits in a row before anything syncs
  must both land. (Note for whoever translates this: they land via direct
  `UPDATE`s that bypass the guarded upsert entirely, so this scenario is not
  actually exercising the T8 clause — it is here because it is what an athlete
  would check, not because it pins the fix. The clause is pinned at the fixture
  level in `pullClobber.test.ts`.)
- **A deleted session is not resurrected by a pull**, which is the older half of
  the same clause and must keep holding.

### The repair screen and deleted rows (F5)

- **A session deleted while blocked leaves the repair screen.** Get a session
  into the blocked state, delete it, reopen the screen: it is gone. Before the
  fix it stayed and offered "Open the session", which navigated to a screen
  showing nothing — the row could not be repaired or dismissed.
- **The same for a plan.**
- **A failing delete is still visible somewhere.** It leaves the repair screen
  but must keep counting in the pending badge; the sync it needs is the
  ordinary one, not a per-row repair.
- **The stale error does not outlive its operation.** A row blocked on one
  failure, then deleted, must not carry the old message.
- **Where a failed delete is reported, precisely.** Not on the repair screen:
  `blockedRows` filters `dirty = 1`, and a permanently-rejected delete has
  already been restored to `dirty = 0`, so its error is never listed there. The
  surface that reports it is the sync run's banner. Written out because the
  obvious scenario — "the repair screen should then show the delete's error" —
  is one a test would correctly fail.

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
- The stat row was `week-summary` and is now `week-review-stats`, inside a
  `week-review` group that ALWAYS renders (the old row was hidden at zero
  sessions; the group now shows a verdict line instead). A test asserting the
  row's absence on an untrained week must assert the row, not the group.
- **`week-review-stats` counts only this week**, Monday-based, in the device's
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
  The header must read Monday and `week-review-stats` must be **empty or this
  week's** — not Sunday's date over last week's totals, which is what a
  mount-frozen clock produces. Both the focus and the app-foreground path need
  checking; they are different code paths and only one involves a tab change.
- **A session left open overnight stops pretending to tick.** Past 24h the card
  reads UNFINISHED with the start date instead of a running clock, and offers
  "Finish or discard". A resume button reading `506:24:12` is not information.
- **A second unfinished session is still reachable.** Start one on web (or from
  a workout) while another is open: the newest owns the resume card and the
  older appears in the list marked `unfinished`. It must not vanish — it still
  counts toward `week-review-stats`, so hiding it makes the header disagree with the
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

**Measured, modelled, reported** (see `backend/internal/modules/session/basis.go`)
- **The estimated 1RM is marked as an estimate wherever it renders** — mobile records card, `/dashboard/records`, and the session detail's records list. It is computed from RIR/RPE as effective reps, so it is the one record that is not a measurement, and it sits directly beside ones that are.
- **The set's evidence keeps the two halves apart.** `5 × 100kg` is what was on the bar; `2 RIR` is what the athlete reckoned was left. They must not be joined by the same separator into one string — that was the defect. Check a record whose set carries a rating *and* one whose set does not.
- **A rating with nothing before it opens the line.** A timed or distance record whose set carried only an RPE has no measured evidence, so the `·` separator must only render when a measurement stands before the rating — on the mobile records card and `/dashboard/records` alike, "· RPE 8" with nothing to its left is the defect.
- **A missing rating renders as nothing, not as a zero or a dash in a row of numbers.** `TrackEffortProvider` lets an athlete turn effort collection off, so absence is ordinary and must not read as an effort of zero.
- **A record is never ranked or gated by a rating.** Seed two sets where the heavier one reports a *lower* RPE: the heavier still wins `heaviest_weight`. (Deliberately not true of `estimated_1rm`, which consumes RIR by design — that is what the marking is for.)
- Every record kind must have a basis. Adding a kind without classifying it fails `TestBasisFor_ClassifiesEveryRecordKind`, and the Go/TypeScript copies are pinned together by `basisParity.test.ts`.

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

The property: **every field a technique carries is readable when it is opened,
and the library stays instant as it grows.**

**Happy path**

- The Library tab lists all 542 alongside the exercise catalog, scrolls smoothly, and opening one
  shows mechanics (`description`) *and* the decision (`when_to_use`) as separate
  sections.
- The IBJJF panel shows rule class and both divisions' belts.
- `setup_from` entries that name a real technique are tappable and navigate;
  everything else is plain text.

**Performance — the reason the API is shaped this way**

- **The list response must not contain prose.** Assert `description` and
  `when_to_use` are absent from `/v1/techniques`. Regressing to full rows takes
  the payload from ~197 kB to ~587 kB and nothing visible breaks — which is why
  it needs a test.
- **Typing in search issues no network request.** Search is local over an
  already-fetched list.
- `/v1/techniques/rulesets` is fetched once, not per row.

**The traps, each of which fails silently**

- **`is_restricted` must come from the API, never be re-derived.** A client
  computing it from belt-list length marks 441 ordinary techniques as
  restricted (adult no-gi has no white belt division, so Blue/Purple/Brown/Black
  is the *baseline*). Assert the restricted count is 27, not 468.
- **An empty belt array means "division doesn't apply", not "no belts".** A
  gi-only technique must not render as prohibited in no-gi.
- **Unresolvable edges must not look tappable.** ~71% of `common_next_moves`
  and ~94% of `common_counters` name things absent from the library.
- **No video section when `video_reference` is empty** — it is empty for all
  542, so an always-present heading implies 542 missing assets.
- **Alias search works**: "scarf hold" finds "Kesa-Gatame Escape".
- **Empty states only claim emptiness after a successful read** — a failed
  fetch says the library is unavailable, not that there are no techniques.

**Seeding**

- Rulesets upsert before techniques (techniques carry the FK); a dangling
  reference fails with the technique named, not an opaque constraint error.
- Re-seeding is value-idempotent: `updated_at` must not move on a no-op.
- An entanglement `position_detail` and the `Leg Entanglement` position imply
  each other, in both directions. Ported from the retired importer, and the
  reverse half is the one a one-way check misses.

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

Domain: one Library tab lists the exercise catalog **and** the 542 BJJ
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
  no white belt division), not a restriction — deriving it flags 441 ordinary
  techniques instead of the real 27.
- An empty belt list renders its note ("N/A — gi-specific"), never "allowed at
  no belt".
- Sections with no content (e.g. `video_reference`, empty in all 542) do not
  render an empty heading.

### Auth / security

- Signed out, the Library tab is unreachable (the `AUTH_ROUTES` guard).
- Techniques are global reference content, identical for every user — the
  module-level summary cache surviving a user switch is correct, not a leak.
  Assert the API applies no user scoping to `/v1/techniques`.

## Unified Library on web (`apps/web`, `/dashboard/library`)

Domain: the same one library as the phone — exercise catalog plus the 542 BJJ
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

- A technique whose description does not split into 2+ steps (7 of 542) renders
  the original prose under the same heading — **never** a one-item list.
- `executionSteps` must produce zero steps under 10 characters across the whole
  library; a stray "and" as its own numbered step is a failure.
- The mobile and web parsers must stay logically identical — a step boundary
  that differs between platforms is a content difference, not a styling one.
- Sections with no content still do not render (`video_reference` is empty in
  all 542).
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

## A grip the server refuses (`invalid_grip`, backend + mobile, T4)

The client stopped nulling grips it does not recognise — only the server owns
that vocabulary — so the safety net moved to the push, which drops a grip
**after** the server refuses it by code. Everything below needs a fifth grip to
exist server-side (see N9) or a stubbed response; none of it is reachable today,
which is exactly why it is written down.

### API

- `POST /v1/sessions` and `PUT /v1/sessions/{id}/sets` with a set naming an
  unknown grip both answer **400 with code `invalid_grip`**, never
  `invalid_input`. The code is the contract; the message is not.
- Every other validation failure on those endpoints still answers
  `invalid_input` — an out-of-range RPE must not be reported as a grip problem,
  or a client will drop grips trying to fix it and be refused identically.
- The message names the offending set ("set 2"), because the repair screen shows
  it to a person.
- The four grips the enum defines are accepted, and an unrecorded grip (`null`)
  stays legal.
- Sets are validated **before** the session is looked up, so a request that is
  both unknown-gripped and aimed at a deleted session answers 400, not 404.

### Sync

- A session logged **offline** and first pushed with a refused grip still lands:
  the create is retried without grips. This is the primary case — `remote = 0`
  is every offline session — and the repair covering only the sets push left it
  stranded permanently.
- A session the server already holds, edited to carry a refused grip, repairs on
  the sets push and still reaches `finish`: an unknown grip must never cost the
  session its `ended_at`, or it counts for nothing in history.
- The repair is **persisted locally**, so the next push cannot resend the value.
- Only grips are dropped — `ended_at`, reps and weights survive the retry.
- **Editing the session while it is pushing must not lose the edit.** If a save
  lands between the push reading the sets and the repair writing them back, the
  repair is declined and the row stays dirty; the next sync repairs the newer
  sets instead. Verifiable by saving during a slow push.
- A non-grip 400 changes nothing locally and still surfaces on the repair
  screen.
- A 404 on the **retry** still marks the session non-remote, so the next sync
  recreates it.

### Deploy order

- A client sending a grip a **stale** server has not deployed yet gets
  `invalid_input`, not `invalid_grip`, and strands. The server must be live
  everywhere before any client offers a new grip value.

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

## Sync status and repair (mobile)

- With everything synced and online, **no chip is shown**. Its presence is the
  signal; a permanent badge trains people to stop reading that corner.
- Go offline with unsynced training: the chip says Offline and the count, not
  a failure. Restore signal and it clears on its own.
- Start a session from a workout that hasn't synced: the chip says *waiting on
  a plan*, not a number of failures. It resolves without intervention.
- Force a permanent refusal (log a set on a session the server considers
  finished). The chip turns to a failure, tapping it opens the repair screen,
  and the row is listed **by name with the server's own message**. Fix the
  cause, tap Try again, and the row leaves the list.
- Kill and relaunch the app: the blocked row is still listed. The message is
  on the row, not in memory — that is when people actually go looking.
- A transient failure (airplane mode) must NOT appear on the repair screen.
  It resolves itself and needs no one.
- Sign in as another athlete: their repair list is their own.
## BJJ rank (mobile, web, admin)

Rank is derived server-side from the promotion list — none of these scenarios
should ever be about a client computing a belt itself, only about it
rendering, submitting and reflecting what the server derived.

### Standing, happy path

- A new account with `bjj` enabled and no promotions shows "No rank recorded
  yet" — on the You screen card, the `/bjj` hub, web's Settings section, and
  (silently, no badge at all) on admin's user detail.
- Add a promotion: the belt, stripes/degree, and time-at-belt update
  everywhere that reads standing — the You screen card, the `/bjj` hero, and
  web's Settings card — without a manual refresh.
- Add a second, higher-ranked promotion: current rank becomes the higher one
  regardless of which was entered first or which has the later date.
- Add a lower-ranked promotion after a higher one is already recorded:
  current rank does **not** regress — rank is monotonic.
- An undated promotion still sets the current rank; "time at this rank" is
  simply not shown when its date is absent.
- Deleting the only promotion returns the account to "No rank recorded yet",
  not to a default belt.

### Add / edit form

- Switching belt to Black hides the stripes stepper and shows a degree
  stepper 0–6; switching away from Black does the reverse. The live preview
  label and the drawn belt must agree in both directions — this is the exact
  shape of the stale-state bug already found and fixed once (belt switched to
  Black must clear stripes, not just leave degree at what it was).
- Degree cannot be set on any belt but Black — the control for it isn't
  offered on a coloured belt in the first place.
- Stripes are capped 0–4, degree 0–6, matching the stepper's own range — there
  is no way to reach an out-of-range value through the UI to have the server
  reject it.
- Leaving the date blank saves successfully; typing an unparsable date is
  rejected before or by the server, not silently dropped.
- Editing a promotion pre-fills every field from the row that was tapped, not
  from a blank form.
- Cancelling an edit discards changes — the list and hero still show the
  pre-edit values.
- Deleting a promotion asks for confirmation first (`Alert.alert` on mobile,
  `confirm()` on web) and does nothing if declined.

### Module gating

- With `bjj` disabled, the You-screen card, the `/bjj` route, and web's
  Settings section are all absent — including for an account that has a
  recorded promotion history from before the module was turned off. Nothing
  you've logged is deleted; turning BJJ back on brings the belt back too.

### Admin (read-only)

- A non-admin account visiting `/users/{id}` is refused before any BJJ data
  would even be requested.
- An admin viewing a BJJ-enabled athlete with a recorded rank sees the belt
  and rank text beside the display name.
- An admin viewing a BJJ-enabled athlete with **no** recorded rank sees no
  belt at all — not an empty swatch, not a loading state stuck open.
- An admin viewing an athlete with `bjj` disabled sees no belt, regardless of
  whether one was ever recorded — the fetch is gated on the module the same
  way the athlete-facing apps are.
- There is no edit or delete affordance anywhere on this page for a rank —
  admin only ever reads it.

## Technique library belt filter (mobile and web Library)

A second filter axis on the same screen as the position row — see "Unified
Library" above for the base screen this extends.

### Gating

- The belt row is absent unless BJJ is both enabled and the active sport
  chip — same rule as the position row, checked the same way.
- Turning BJJ off hides the belt row even if a cap was selected; nothing
  about the technique list is affected for a discipline with no belt axis.

### The cap, not an exact match

- Selecting a belt shows techniques `typical_belt`'d at or below it, not
  only that belt — White techniques remain visible with Blue selected.
- Raising the cap only ever adds rows; it never removes one that was already
  showing at a lower cap.
- "All levels" (mobile: the leftmost chip; web: its own explicit chip) shows
  every technique regardless of `typical_belt`, identical to no filter.
- A technique with an unrecognised or blank `typical_belt` is never hidden
  by this filter, at any cap — a categorisation gap must not read as "not
  for you."

### Not the same axis as IBJJF legality

- Capping by belt never changes what the detail screen's legality section
  (mobile) / `Legality` panel (web) shows for a technique — that reads
  `gi_allowed_belts`/`no_gi_allowed_belts` and `is_restricted` independently
  and is unaffected by this filter's selection.
- A technique legal only for Blue-and-up in competition still appears under
  a White cap if its `typical_belt` is White — the filter answers "commonly
  taught from," not "may I compete with this."

### Default from the athlete's own rank

- Opening Library with BJJ selected and a recorded rank pre-selects that
  belt as the cap — on both mobile and web.
- An account with BJJ enabled but no recorded promotion opens on "All
  levels" — no rank is not silently read as White.
- The default is a starting point, not a lock: every other chip is tappable
  immediately, on both platforms.
- Mobile only computes this default once per app session (a stored manual
  choice from a prior visit is never overwritten by it); web computes it
  once per page load, since web has no persisted Library filters at all.

### Persistence (mobile only — web resets every filter on reload)

- A manually chosen belt cap is remembered across visits, the same as the
  sport chip.
- Unlike the position filter, the belt cap is **not** cleared when the sport
  chip moves away from BJJ and back — it is a standing fact about the
  athlete ("I've reached Blue"), not a transient narrowing tied to what's
  currently on screen.
- Signing in as a different athlete on the same device does not carry over
  the previous athlete's belt cap.

## Logging a BJJ session (mobile)

The floor and the reflection are two layers and have to be tested as two —
most of the value is in the floor working alone.

### The three-tap floor

- Today's BJJ action opens **`/bjj/log`**, not the live session logger. A BJJ
  session cannot legally hold a set, so reaching `/session/start` for BJJ is
  a regression however empty the screen looks.
- A brand-new account can log a session in three taps: pick a kind, pick an
  RPE, tap **Log it**. Everything else is already answered.
- The second session of the same kind opens with the previous one's mat time,
  rounds, round length and gi already filled in.
- Changing the kind to **Drilling** clears rounds; changing back restores a
  sensible default rather than leaving a drilling session with five rounds of
  sparring attached.
- **Gi has three states.** "Not saying" is a real answer and must round-trip
  as distinct from No-gi — never coerced to one of the two.
- The rolling readout (`≈ N min rolling`) is rounds × round length, and is
  absent when rounds are "None".
- **Logging works with the network off**, and the session appears on Today
  immediately. It syncs later with no further interaction.
- The logged session carries a real duration: Today shows the mat time, not
  `unfinished` and not `0:00`. This is `ended_at` being written at log
  time — without it BJJ contributes nothing to training history at all.
- A BJJ session in any session list shows **no set count**. "0 sets" is not a
  neutral default; it reads as an abandoned session.
- With BJJ disabled, `/bjj/log` refuses rather than logging to a discipline
  that is switched off — including from a stale back-stack entry.

### The reflection wizard

- Every step is skippable, **Done** is available from any step, and leaving
  early keeps everything entered so far. Nothing here is required for the
  session to count.
- Backing out of the wizard entirely still leaves the floor session logged.
- Drilled: searching finds techniques by name and by alias; adding one shows
  it as a removable row; adding the same technique twice does not duplicate
  it.
- A drilled technique records the **position family** derived from the
  technique's own position ("Half Guard - Bottom" → "Half Guard") and a
  category mapped from the library's ("Escape" → `escape`).
- With the technique library unavailable (fresh install, offline, never
  opened the Library tab), the drilled step says so honestly and stays
  skippable — it must not block the rest of the wizard.
- Live grid: tapping a cell increments it, long-pressing decrements, and
  decrementing to zero removes the tag rather than storing a zero.
- Tapping **the same cell three times produces one tag with count 3**, not
  three tags.
- Selecting a position before tapping attaches it; tapping the same category
  again under a *different* position produces a **separate** tag, because
  "swept from half guard" and "swept from guard" are different evidence.
- The **Them** column records as `conceded` and is as easy to reach as the
  You column. This is the half that answers "where do I keep getting stuck",
  and a build where it is slower or hidden has lost the point of the screen.
- Re-saving the same reflection (a retry, a second sync) does not duplicate
  its tags — the whole set is replaced, not appended.
- **Note step, keyboard up:** focusing either free-text field keeps that field
  visible, keeps the Skip/Save footer above the keyboard and reachable, and
  leaves **no band of blank** between the last line of content and the footer.
  The blank is the regression to watch: the footer's padding already shortens
  the scroll view clear of the keyboard, so a scroll view that *also* carries
  the platform's keyboard inset ends up with scroll range that has nothing in
  it. A field already clearing the keyboard should not scroll the step at all.
- The same screen, **drilled** step, whose content is long enough to scroll:
  with the search keyboard up the last result stays reachable. That is the
  other side of the same trade — the platform inset has to stay on for
  scrollables that have no footer, or those screens lose their reach.

#### The technique funnel (`drilled → attempted → scored`)

- **The drilled step records what was covered and nothing else.** It has no
  tried/landed counters — those moved to the live step, and a build where both
  exist has reintroduced the redundancy this design removed.
- **The live step's "Working on" block shows the focus list PLUS any technique
  this session already has live evidence for.** Drop a technique from focus
  after logging against it and its rows must still be editable; focus alone
  would leave them saved, synced and invisible.
- A technique in both focus and the session's tags appears **once**, labelled
  with the library's name rather than its id.
- **The vocabulary translation must be applied.** A focus entry carries
  "Submission" / "Guard - Bottom"; its tags must be written as "submission" /
  "Guard", or a focus row's evidence and a drilled row's for the same technique
  file under different positions and split in half silently.
- **Removing a drilled technique must NOT remove its live outcomes** — inverted
  from the previous design, deliberately. The two are different statements now
  that live outcomes have their own control.
- With no focus set the block is absent entirely and the category grid is the
  whole surface. That is the default state until the web authoring surface
  ships, so it must be a first-class layout rather than an empty container.


- Each **focus** technique carries **Tried** and **Landed** counters. Tap
  increments, long-press decrements, decrementing to zero removes the row
  rather than storing a zero — a zero-count row fails the backend's
  `count > 0` CHECK, so the whole reflection would 400 on save because
  someone tapped once and undid it.
- The attempted/scored rows **inherit `category` and `position` from the
  source** — usually a focus entry, translated through `toCategory`/`familyOf`
  — not from a second derivation. `familyOf()` returns `''` for
  a family the hardcoded POSITIONS list has fallen behind on — which has
  happened twice — so deriving it again could file the drilled row under
  "Half Guard" and the attempted row under nothing, splitting one technique's
  evidence with no error anywhere.
- **Attempted and scored are disjoint.** `attempted` is "went for it and it
  didn't land", so four tries with one hit is `attempted: 3, scored: 1`. The
  copy has to say so — the cumulative reading is at least as natural and
  produces different numbers from the same taps.
- Removing a drilled technique **leaves its Tried/Landed rows alone.** They are
  reachable from the live step's focus block whether or not the technique was
  drilled today, so nothing is stranded and the two facts are independent.
- ...but a **technique-tagged `conceded`** row survives that removal. This
  screen cannot author one, but the API accepts one, so a reflection authored
  elsewhere and read back can carry it; deleting someone's "they armbarred
  me" record because they removed a drilled chip is data loss.
- **The category grid and the focus rows must partition the tag list.** The
  grid owns untagged rows, the focus rows own technique-tagged ones. If either
  counts the other's, a number appears that its own control refuses to move
  and nothing explains why.
- **The session read-back screen must agree with the wizard on `scored`**: its
  grid excludes technique-tagged `scored` the same way, and the **Techniques**
  section shows each technique's tried/landed instead — keyed off *any*
  technique with evidence, NOT off the drilled list. Keyed off drilled, a
  technique tried live but not drilled shows nowhere, and a session holding
  only such rows renders "No detail recorded" over data that exists. Getting the second half wrong
  recreates the exact write-but-never-read defect the funnel exists to fix.
- **...but NOT on `conceded`, deliberately.** The read-back grid *includes*
  technique-tagged `conceded` rows. No screen in this app can author one, so
  there is no editor for the grid to disagree with — and filtering it out
  would leave that row with no display surface anywhere, saved and synced and
  invisible. A test written from "the grid mirrors tagCount" would fail
  against correct code here.
- **Every tag must be displayed somewhere.** The stronger property behind both
  bullets above, and the one worth testing directly: take a reflection with
  one row of every (event × tagged/untagged) combination and assert each is
  visible on the read-back screen. `hasAnyDetail` must agree — a reflection
  holding only a technique-tagged `conceded` row must not render "No detail
  recorded".
- **Do not record the same live event twice.** Tapping "Landed" on the armbar
  row *and* "Submissions / Hit" in the live grid, for one armbar, writes two
  `scored` rows — one technique-tagged, one not. Both screens show them
  correctly and separately, so nothing looks wrong; any cross-session view
  that sums `scored` across both shapes double-counts. Pick one convention
  and test it.
- Leaving every counter at zero is a valid, meaningful answer — "drilled,
  never tried live" is the finding, not an empty cell.

### Reading it back

- A logged BJJ session appears in training history and the consistency grid
  alongside strength sessions, and contributes its mat time.
- Deleting the session removes its reflection and tags with it — no orphaned
  evidence attached to nothing.
- A reflection written on one account is never visible or writable from
  another; both "no such session" and "not yours" answer identically.

### Auth & security

These are the cases the composite owner foreign key does **not** cover on its
own, so none of them is redundant with "the FK exists".

- **Overwriting an existing reflection cross-account is refused.** Distinct
  from writing a new one: once the detail row exists the upsert takes the
  `DO UPDATE` path, where Postgres skips the FK check because no referencing
  column changes. Write as the owner first, *then* attempt as another
  account, and assert the owner's note survives unchanged.
- That attempt must send **no tags** — a tag would hit the tag table's own
  FK and fail there, so a test with tags passes whether or not the detail
  write is guarded.
- **A BJJ reflection cannot attach to a session of another sport.** Attempt a
  reflection against a `strength` session owned by the same caller: refused
  as `not_found`, and no detail row is left behind.
- Both refusals answer `not_found` rather than `forbidden`, so neither
  confirms that a session id exists on another account.

### Sync durability

- **A permanently-refused reflection never costs the session its duration.**
  Force the reflection PUT to fail with a 400 (a tag naming a technique the
  catalog no longer has) and assert the session still carries `ended_at`
  server-side, and still contributes its mat time to history. The reflection
  is optional; the session's timing is not.
- The row stays dirty after such a failure, so the reflection is retried
  rather than silently dropped.
- A reflection blob that no longer parses is skipped, not fatal — the session
  and its timing still push and the row still settles clean.


### Setting focus on the proficiency page

- **Starring a technique adds it to the focus list and it survives a reload.**
  The star, the panel above, and the stored list must agree at all times.
- **Un-starring removes it**, as does "Done" in the panel — two controls, one
  list.
- **Starring a sixth technique refuses**, names the cap, and **does not fire a
  request**. The server rejects it too; the UI message is a courtesy, not the
  guard.
- **A failed save puts the previous list back.** Optimistic update, so a
  network failure must not leave a filled star next to a list that never
  changed.
- **Two rapid toggles settle with the UI matching the server**, in both
  directions. Responses need not complete in request order: a stale success can
  re-fill a star just cleared, and a stale rollback can restore a snapshot that
  predates edits which already succeeded. Star then un-star inside one round
  trip; and star two techniques where the first save fails and the second
  succeeds.
- **A failed focus read must not blank the funnel.** They are two independent
  reads; the secondary one failing leaves the table readable with the stars
  simply unfilled.
- **A cap refusal is not presented as a load failure.** It must not appear
  under the "Couldn't load your funnel" banner or beside a "Try again" button —
  nothing failed to load.
- The panel shows **weeks since `started_on`**, not since the last save —
  reorder or add an entry and an existing one's count must not reset. That is
  the property the column exists for and it is enforced server-side.
- A newly starred technique shows **no** week count until the server answers,
  never "0 weeks": the optimistic entry has no real `started_on` and a zero
  would read as a fact.
- **An empty list renders a first-class empty state**, not an empty box — it is
  the default for every athlete who has not set one.
- **A stored list is visible even with no proficiency rows at all.** The phone
  is reading that list; an athlete whose evidence is empty must still be able
  to see and clear it.
- The star column has an accessible name **naming the technique**; a column of
  identical "Working on" buttons is unusable otherwise.

### Exporting authored content (`cmd/exportcontent`)

**Happy path**

- With no admin rows, **both** files are byte-identical afterwards — not
  rewritten, not reformatted. Assert this against the real shipped files, not a
  fixture: the property is "matches what Python wrote", and a fixture only
  proves the code agrees with itself.
- An authored technique is merged into `techniques.json` — the deploy artifact,
  embedded and seeded — without disturbing the 542 entries already there.
- The diff for one new technique is **one entry**, in the file's own key order.
  A whole-file reorder is the failure: Go sorts map keys, the file is written
  in semantic order, and 542 reordered entries bury the change.
- **`function` and `to_position` sit in their interior slots** — after `category`
  and after `position_detail` respectively, which is where 538 and 170 of the
  shipped entries put them. Appending them to the end seeds and renders fine and
  is invisible until something rewrites the file and relocates them on every
  entry the export wrote. Assert the order as a SUBSEQUENCE across entries: an
  index-for-index check against an entry that omits both optional keys passes
  whatever the order is, and that is what pinned the wrong one in place.
- **Neither file is in id order**, so a merge must not sort. Existing entries
  keep their position; new ids append. Assert an existing entry did not move.
- **`-adopt` must not adopt what the same run just wrote.** Author a technique,
  run the export, and adopt in one go: the new id stays `source='admin'`,
  because it is in the file but not in any deploy. Only ids the seed file
  carried beforehand are eligible.
- **A duplicate id in a catalog file is refused, not deduped.** Keeping the last
  deletes the other on the next write.
- The exported file **actually seeds**. Run `cmd/seed` from it and count the
  rows; a file that is pretty but unloadable is worse than a noisy one.
- An entry with no aliases writes `"aliases": []`, never an absent key. Absent
  unmarshals to nil, pgx sends NULL, the column is `TEXT[] NOT NULL`, and the
  insert is inside a transaction — so one such entry fails the entire seed.
- A re-export with no changes produces a byte-identical file. The promotion path
  depends on a readable diff.
- `-adopt` flips the exported rows to `source='seed'`, after which the seeder can
  update them and the console cannot.

**Edge cases and errors**

- Re-exporting an id the file already carries is the normal update path and
  must be allowed. (There was a rule refusing spreadsheet-owned ids; it was
  deleted with the spreadsheet in 2026-08, since every row is repo-owned now.)
- Ampersands and angle brackets survive **unescaped**. Go escapes them by
  default; neither catalog file contains one today, so nothing exercises this
  until someone types "Over-Under & Stack Pass" into the console.
- A malformed catalog file is refused, not overwritten — a stray character
  must not cost hand-authored content.
- A missing file (or directory) is created rather than fatal.
- Only `function` and `to_position` are omitted when empty — everything else is
  written explicitly. `to_position` is absent on 372 of 542 entries and absent
  means "not recorded", which is a different fact from any value.
- **Adoption must not touch `updated_at` on rows the deploy already owns.**
  Assert the timestamp, not `source` — setting `seed` on a `seed` row is
  invisible in the value, and clients delta-sync on the timestamp.

### Authoring the catalog (`/v1/admin/techniques`)

**Happy path**

- Creating a technique returns it with a **derived id** — "São Paulo Pass" →
  `sao-paulo-pass`, accents folded, not `s-o-paulo`.
- It is immediately visible in `GET /v1/techniques`, on the phone's library and
  as a tag target. That immediacy is the whole point of the feature.
- Editing a technique applies; the id does not move. **Any** technique — the
  refusal of seeded rows went with the authoring spreadsheet in 2026-08.
- `GET /v1/admin/techniques` with no `q` returns the admin-authored set;
  with `?q=` it searches the WHOLE catalog by name, id **or alias**, seeded rows
  included, and each carries a `source` so the console can show who owns it.

**The property everything rests on**

- **A re-seed must not touch an admin row.** Create one, run `cmd/seed` with a
  JSON that carries the same id and different content, and assert the admin
  content survives and `source` is still `admin`. Without this guard every
  deploy silently reverts authored content, and a deploy happens on every
  release.
- **...and the seed must still update its own rows.** The inverse failure is a
  content freeze that looks exactly like "nothing changed".
### The exercise catalog has the same three, on the same terms

Search (`?q=`), drafts (`status`) and revisions all landed for exercises after
the technique versions. **Every scenario in the two sections below applies to
`/v1/admin/exercises` as written** — the implementations mirror each other
deliberately, and a scenario that holds for one and not the other is a bug in
whichever diverged.

Two exercise-only points worth their own assertions:

- **A revision payload excludes `media`.** It lives in `exercise_media`, the
  console cannot author it, and the content write path does not touch it — so a
  restore must not claim to put pictures back. Assert media is absent from the
  payload rather than present-and-empty, which would read as "it had none".
- **The search matches name and id, not aliases** — exercises have none. If they
  gain them, this scenario is the reminder that the query needs the extra arm.

### Revision history and rollback

Every console write leaves a revision. The deploy leaves none.

- **The history SECTION RENDERS AT ALL.** Load a content detail page — either
  catalog, with history and without — and assert a 200 with the form present.
  This reads like a test of nothing, and it is first because for two increments
  the feature was completely broken and every other check passed: the page
  passed a closure to a client component, React refused to serialize it, and the
  whole route 500'd into an error boundary claiming the API was unreachable. It
  typechecked, it built, and no test rendered a page. Any scenario below that
  runs against the API only will stay green through a repeat.
- **Restore posts the revision as a form field, with the id bound server-side.**
  Assert a restore button's form carries `revision=<n>` and that tampering with
  it cannot reach another row — the id is not in the form, by construction.

- **Create, update and publish each append one**, numbered from 1 per technique,
  newest first on read.
- **The payload is the state AFTER that write**, so reading the history needs no
  replay. Assert an old revision's payload still carries the old name.
- **`actor` comes from the request's claims, never the body.** Send
  `{"actor":"impostor"}` and assert it is not what gets recorded — an audit
  trail the writer can forge records nothing.
- **A re-seed writes no revisions.** Run `cmd/seed` and assert the count is
  unchanged; 542 rows per release would bury the operator's own edits.
- **A seeded technique has an empty history**, and that is a 200 with `[]`
  rather than a 404.
- **Restoring APPENDS.** After restoring revision 1 of a 3-revision technique
  there are 4, and the newest action is `restore`. The regression is a restore
  that truncates — the state rolled back from disappears and the rollback
  cannot itself be undone.
- **Restoring does NOT change `status`.** Restore a revision from before the
  technique was published and assert it is still published: a content rollback
  that withdraws a live technique from the library is not an undo.
- **Restoring a revision that does not exist is 404**, and writes nothing.
- **The write and its revision are atomic.** They share a transaction; an edit
  that lands without its revision is an edit nobody can see or undo.

### Drafts (`status`)

A console-created technique is a **draft** and athletes cannot see it. Publishing
is a separate, one-way action.

- **A draft is absent from `GET /v1/techniques`** and `GET /v1/techniques/{id}`
  returns 404 for one. The 404 rather than 403 is the point: a caller has no
  business learning an id exists before it is published.
- **There is no parameter that includes drafts.** Assert that adding one
  (`?status=draft`, `?include_drafts=true`) changes nothing — a draft that
  becomes visible by passing a query string is not a draft.
- **The console CAN see its own drafts**, or they would be unfinishable.
- **Creating through the console produces a draft**, not a published row. The
  column default is `published` because it has to describe the 542 backfilled
  rows, so this is the write path being explicit — delete `'draft'` from the
  INSERT and it silently publishes instead.
- **Publishing makes it appear** in the public list and detail.
- **Publishing twice is a 404**, not a silent success: the caller is working
  from a stale view and should learn that. Same for publishing an absent id.
- **Editing a published technique leaves it published.** The regression is a
  design that returns an edited row to draft — every typo fix would withdraw the
  technique from the library until someone re-published it.
- **A re-seed must not publish a draft.** Seed a row whose id matches an
  unfinished console draft and assert the draft stays a draft; the `source`
  guard is what stops it.
- **Deleting the status filter from the public list leaves the rest of the suite
  green** — the console paths return drafts on purpose. That is why this section
  exists rather than relying on coverage elsewhere.

#### Drafts and the things that reference them

Invisible is not the same as unreferenceable, and the two catalogs currently
differ here — deliberately, and stated rather than implied.

- **A draft EXERCISE cannot be added to a workout item or a session set**, and
  the refusal is `unknown exercise` — byte-identical to a nonexistent id. Assert
  the message, not just the error type: a distinct "that is a draft" hands any
  authenticated caller an existence oracle over unpublished content, and a
  sport-mismatch error does the same by naming the sport.
- **The same exercise becomes addable once published.** Without this the test
  above passes against a filter that rejects everything.
- **A draft TECHNIQUE can still be tagged** into a BJJ session, a focus list, a
  curriculum or a sequence — those four paths validate through the foreign key,
  which does not read `status`. This is a KNOWN GAP, recorded in the contract.
  A scenario written today should pin the current behaviour and be inverted
  when the gap is closed, not assert the behaviour we want.
- **Fixture discipline for all of the above:** a draft row seeded for one of
  these tests must be registered for cleanup BEFORE the workout or session that
  references it. `t.Cleanup` is LIFO and the FK has no `ON DELETE`, so the other
  order leaves the draft in the shared database whenever the test fails — which
  is exactly when it is least likely to be noticed.

- **Editing a SEEDED technique takes ownership of it.** PATCH one, assert
  `source` became `admin`, then run `cmd/seed` with the ORIGINAL content and
  assert the edit survives. The re-seed is the whole test: without the
  ownership flip every assertion about the edit landing still passes, and the
  next release quietly undoes it. This is the single most important scenario in
  this section — it is one SQL clause away from silent data loss.
- **`exportcontent -adopt` must not adopt a row this run changed.** Edit a
  seeded technique, export and adopt in one invocation, and assert the row is
  NOT adopted: the JSON is uncommitted and undeployed, so handing it to the
  deploy means the next release re-seeds the old content over the edit. The test
  is whether the file already carried this exact content, not whether it carried
  the id — an id check passes here and is wrong.

**Edge cases and errors**

- A duplicate id is a **409, never an upsert** — the id may already be a
  foreign key in somebody's training record.
- A 404 from PATCH now means exactly one thing — no such id. It used to also
  mean "that one is seeded" and answer 409; there is no second case.
- **Search escapes LIKE metacharacters**: `?q=%` and `?q=half_guard` match
  literally rather than as wildcards. Binding the parameter stops injection but
  not *pattern* injection — and a trailing backslash escapes the pattern's own
  closing `%`, turning a contains-search into something else entirely, with
  wrong results and no error.
- **Search is capped at 100 and says nothing about it.** A result set of exactly
  100 may be truncated; the response carries no total. Worth a scenario because
  the failure is an operator concluding a technique does not exist.
- A position, function or gi_no_gi outside the catalog's vocabulary is a 400
  naming the legal set. This is the worst data the table can hold: it writes,
  it renders, and it returns nothing forever with no fault reported.
- A name that slugs to nothing ("!!!") is a 400, not a NOT NULL violation far
  from the cause.
- `to_position` must resolve to a position the library uses, or the graph edge
  points at nothing.
- A body over 64 KB is rejected rather than read.

**Auth and security**

- `RequireAdmin` on every route — this writes shared reference content that
  every athlete's library and every training record points at. A signed-in
  non-admin gets 403, not 404.
- `source` is server-set: a client cannot mark its own row `seed` (which would
  hand it to the deploy). Note a PATCH does move a seeded row to `admin` — that
  is the ownership flip, applied server-side, not something a client can ask
  for.

### The focus list (`GET`/`PUT /v1/bjj/focus`)

**Happy path**

- `PUT` replaces wholesale: saving `[c, a]` then `[a, b]` leaves exactly `a, b`.
  Merge semantics would make removing a technique impossible.
- **Array order is the athlete's ranking and comes back unchanged.** Assert with
  a list that is neither alphabetical nor id-order, or a `ORDER BY technique_id`
  passes by accident.
- The response carries library `name`/`position`/`category`, so a client renders
  the list without a second fetch.

**Edge cases and errors**

- **A re-save must NOT reset `started_on`.** The property the column exists for.
  Backdate an entry, re-save the list with a new technique in front of it, and
  assert the old entry's date survived while the new one is today. A
  delete-then-insert implementation passes every other scenario here and fails
  only this one — and it fails silently in production, resetting the rotation
  clock on every reorder.
- An **empty array clears the list** — finishing a block is normal and must be
  expressible. Returns `[]`, never `null`.
- More than 5 techniques → 400, and the message names the number, because the
  cap is the feature rather than a limit.
- A repeated technique → 400. Without the check the primary key silently
  collapses it and the client's list and the stored one disagree about length.
- An unknown technique id → 400 (not 500), **and the whole save rolls back** —
  a partially applied list leaves the athlete with one they never asked for.
- An empty-string id → 400.
- **`technique_ids` omitted entirely, or `null` → 400.** Both decode to a nil
  slice, and before this was guarded they were a 200 that changed nothing —
  with a response body that looked correct, because it is a read-back of the
  untouched list. Clearing is spelled `[]`; absent is an error.
- A body over 8 KB is rejected rather than read.
- **Concurrent saves of the same techniques in different orders must not
  deadlock.** The upsert takes a row lock per technique; iterating in the
  athlete's ranking makes two devices take the same locks in opposite orders.
  Two goroutines, one forward and one reversed, over ~25 rounds.

**Auth and security**

- Self-scoped, no path parameter. Another athlete's list must never be readable.
- **A save must not prune anyone else's list.** Seed two athletes, replace one's
  list, assert the other's is untouched — the delete is the easiest place to
  drop a `user_id` and the easiest to not notice.
- Unauthenticated → 401.

### The technique funnel, read back (`GET /v1/bjj/proficiency`, `/dashboard/proficiency`)

**Happy path**

- A technique drilled in two sessions reports the SUM of both, and
  `sessions: 2`. Counts from one class are weaker evidence than the same count
  across six weeks, which is why that field exists and should be shown.
- A technique drilled but never taken live reports `attempted 0, scored 0` and
  lands in the "Never tried live" bucket. That is the headline finding, not an
  empty row.
- The summary counts **techniques, not reps** — 40 reps of one technique is
  `drilled: 1` in the summary. A build that reports 40 has misread the point of
  the screen.
- The summary is folded from the rows the client is shown, so the two can never
  disagree. Assert that directly: the headline must equal what you get by
  counting the visible list.

**Edge cases and errors**

- **An untagged live-grid row must never be summed into a technique's number.**
  The same real armbar can be recorded twice — once technique-tagged from the
  drilled step, once as the category catch-all from the live grid. The
  convention is that the tagged row is the specific record; per-technique reads
  take it and only it. Seed both and assert the untagged count is absent.
- An athlete whose only evidence is untagged rows gets an **empty funnel**, not
  a phantom row — and `[]`, never `null`, so a client can iterate without a
  null check.
- A hit rate is **withheld below five live tries**. One landed out of one is
  not 100%, and showing it as such invites a conclusion the data can't carry.
- The order is `SUM(count) DESC, technique_id` and must be stable across
  identical requests. Note removing the tiebreak does **not** currently turn a
  test red — the plan happens to be stable — so this is a property to assert,
  not one a mutation can prove.
- The `LIMIT` cannot bind in practice (800 vs a 542-technique library; the cap
  was raised 500 -> 800 when the gap-fill pushed the library past 500). It is a
  memory backstop, not pagination; do not write a test that implies it
  truncates real data.
- On a failed load the page shows an error banner with a retry, **not** the
  empty state — "no evidence yet" is a different and wrong claim.

**Auth and security**

- Self-scoped: no path parameter, and another athlete's evidence must never
  appear. Seed two users and assert the caller sees only their own — this is
  the same cross-user shape that has been caught twice in other modules.
- Unauthenticated returns 401, not an empty list.
- The nav link is gated on `catalog === "techniques"`, so an athlete with no
  technique-catalog discipline never sees it. That is UI tidiness only — the
  endpoint's own auth is the real boundary.

## Reading a BJJ session back (mobile)

The half that was missing when logging shipped. Its absence did not read as an
incomplete feature — it read as a broken one, because the reflection could be
written and then never seen again.

### What the numbers are

- **Mat time and rolling time are tiles; effort is not.** The screen used to put
  "60 min on the mat", "25 min rolling" and "— effort" in three identical tiles
  — two measurements and an opinion, given equal weight by the layout. Effort
  now sits below them under its own label, and the layout is the assertion: a
  build where the three render alike has lost the distinction. See
  `backend/internal/modules/session/basis.go`.
- **A session with no effort recorded says so**, rather than showing a dash
  where a number goes. The three-tap floor never asks for effort, so absent is
  the common case and must not read as zero.

### Routing

- **Tapping a BJJ session in Today opens the BJJ screen, not the set logger.**
  The regression to guard is the original bug: `/session/[id]` renders "Sets 0
  · Reps 0 · Volume —" over an empty group list for a sport that cannot hold a
  set. Strength sessions must still open the set logger.
- **The route and the log button agree.** Both are keyed on the same
  `logsAfterwards` predicate. A test that lets them diverge lets a session open
  a screen built for a different shape.

### What it shows

- **A logged reflection is visible.** Drill three techniques, record two sweeps
  scored and one pass conceded, leave, come back — all of it is on the screen.
  This is the whole point; if only this one scenario is ever automated, make it
  this one.
- **A floor-only session is complete, not broken.** Logged with `Log it` and no
  detail: still shows mat time, rolling minutes and RPE, and offers "Add
  detail" rather than an empty state that implies something failed.
- **No volume tile, ever.** BJJ cannot hold a set, so a zero there is
  structural. Showing it was the original defect.
- **Unresolvable technique ids degrade to the id, not to nothing.** On a cold
  offline launch the catalog is in-memory only and unfetched, so the drilled
  chips cannot be named — "you drilled 3 things we can't name" still beats a
  section that vanishes.

### Editing

- **The wizard is reachable after the fact.** It used to be entered by
  `replace` from the log screen and linked from nowhere, so a session logged
  with `Log it` could never gain detail and a mis-tapped counter could never be
  corrected.
- **Returning from an edit shows the edit.** The screen reloads on focus; stale
  numbers after an edit read as the edit having been lost, which is the exact
  doubt this screen exists to remove.

### Renaming

- **A rename reaches the server.** The load-bearing one. `POST /v1/sessions` is
  `ON CONFLICT DO NOTHING`, so a replayed create does NOT carry a later rename
  — before `PATCH /v1/sessions/{id}` existed, renaming marked the row dirty,
  sync marked it clean, and the change never left the device with nothing
  reporting a fault. Assert the new name in the database, not just on screen.
- **A brand-new session does not send a separate rename** — the create already
  carries the name. Easy to get wrong: `remote` is flipped by the create, so a
  guard reading it afterwards fires on every first push.
- **Blank names are refused**, client and server. A session with no name is a
  gap in the history list with nothing to identify or tap.
- **Renaming someone else's session is `not_found`.** Ids are client-generated
  and therefore guessable; this module has had a cross-user IDOR closed once
  already. "Not yours" and "doesn't exist" must stay indistinguishable.
- **Only the name changes.** Not sport (it decides which screen renders the
  session), not the timestamps (they are what history counts), not the sets
  (they have their own replace endpoint).

## BJJ position glossary (backend, mobile)

The library's 542 entries are all *moves*; these ten are what those moves
happen inside of. Every scenario here is about reference content a signed-in
athlete reads — nothing writes, so there is no offline outbox and no
conflict story.

### Reading the glossary, happy path

- With `bjj` enabled, the Library tab shows a "Start with positions" row of eleven
  cards, in pedagogical order: Standing first, Turtle last. The label must not
  name the reader ("New to BJJ?") — that told everyone who is not new that the
  row was not for them, and greeted a returning athlete as a beginner on every
  visit. Alphabetical order is the bug to watch for — it opens the row on
  Back Control.
- Tapping a card opens the position screen with the header title "Position",
  and it shows the name, its aliases, "What it is", and "What matters here".
- A position whose priorities are written for both players renders two
  labelled blocks (BOTTOM, TOP); Standing, which has one paragraph and no
  labels, renders as plain prose with no empty heading above it.
- "Techniques from here" lists real techniques with a count, and tapping one
  opens that technique's detail screen. Back returns to the position, not to
  the Library.
- Knee on Belly is the entry that reads oddly if the cross-link is wrong: no
  technique carries that position, so its list comes from the Side Control
  family. It must not render an empty section.
- Closed Guard and Open Guard must show **different** lists (37 and 150). They
  share the `Guard` family and are separated only by `position_detail`, so a
  client that applies `family` but not `detail_includes`/`detail_excludes`
  silently collapses them back into one 187-entry list — with Open Guard
  showing closed-guard material under a description saying the ankles are not
  locked. Spot-check: "Armbar from Closed Guard" appears under Closed Guard and
  NOT under Open Guard; a De La Riva or butterfly technique does the reverse.

### The cross-link is the part that breaks silently

- Every position's family must match at least one technique. A family typo
  ("Back Control" instead of "Back") still renders a perfectly normal-looking
  screen with an empty techniques list and no error anywhere — the failure
  mode this feature is most likely to ship with.
- The list is resolved from the already-fetched library, so it must render
  with the device offline once the Library has been opened, and it must not
  issue a per-position request.

### Edge cases & errors

- An unknown position id returns 404 in the standard error envelope, and the
  screen shows "Position not found." with a working Try again — never a blank
  page with empty fields.
- If the technique library fails to load but the position itself succeeds,
  the prose still renders and the "Techniques from here" section is simply
  absent. The glossary must not fail on behalf of its cross-links.
- If the glossary itself fails to load, the Library shows no glossary row and
  **no error** — it is an extra on that screen, and the existing "BJJ
  techniques couldn't load" message must not fire for it.

### Module gating and auth

- With `bjj` disabled, the glossary row is absent from the Library and no
  request for it is made at all — hiding a module has to cut the fetch, not
  just the pixels.
- Both endpoints reject an unauthenticated request with 401.
- The content is identical for every user: there is nothing user-scoped here,
  and no endpoint takes a user id.

## Response compression (`internal/platform/apihttp`)

Every response now carries a new header and large ones change encoding, so
this is API-surface behaviour even though no endpoint changed.

- **A large response round-trips.** Fetch the technique list with
  `Accept-Encoding: gzip` and confirm the decompressed body equals the
  uncompressed one byte for byte. `fetch` and Go's `http.Client` decompress
  transparently, so a client-side test sees only that it still parses.
- **A small response is NOT compressed.** An error body is ~60 bytes and
  gzip's header alone is 18 — compressing it makes it bigger. Assert no
  `Content-Encoding` on a 404/401.
- **The threshold test needs an INCOMPRESSIBLE payload.** Repeated text gzips
  below the threshold, so a test built on it exercises the small-body path and
  passes whatever the compression logic does. This bit the original
  double-encode test.
- **`Vary: Accept-Encoding` on every response**, compressed or not — plus
  `Vary: Origin`. Both are `Add`ed; a middleware using `Set` silently drops
  the other, which is how a cache serves a gzipped body to a client that
  cannot read it.
- **No double encoding.** A handler that sets its own `Content-Encoding` owns
  it; the middleware must pass those bytes through untouched.
- **`Content-Length` is absent when compressed.** Left in place it describes
  the uncompressed body, and clients truncate or hang rather than error.
- **Empty responses survive** — 204 and a bare `WriteHeader` must not hang,
  gain gzip framing, or lose their status.
- **The access log still records the right status.** The header write is
  deferred past the handler returning; if that ordering breaks, every log line
  reports the wrong code while responses look fine.

## Conditional GET (`internal/platform/apihttp`)

- **A repeat request returns 304 with no body.** Fetch, keep the `ETag`, send
  it back as `If-None-Match`. Assert zero bytes — that is the entire feature.
- **A changed body returns 200 and a different ETag.** Otherwise clients pin
  themselves to stale content forever.
- **The ETag does not change with `Accept-Encoding`.** It is computed inside
  the compression middleware for exactly this reason; if it moves, every
  gzip-capable client is a permanent cache miss and the feature does nothing.
- **Never 304 a write.** A conditional POST/PUT/PATCH/DELETE must proceed
  normally — a 304 tells the client its write was a no-op.
- **Never 304 an error.** A 404 or 500 must keep its status, its body, and
  carry no ETag, or a client caches the failure.
- **A 304 carries no `Content-Length`.** A declared length with no bytes makes
  a client hang waiting for them. **Set it in the handler first** — a
  `ResponseRecorder` never synthesises one, so asserting it is absent proves
  nothing unless something put it there. Assert the 200 still has it, or the
  test passes just as well against code that deletes it unconditionally.
- **A handler's own `ETag` is honoured, not just echoed.** Set one in a
  handler, send it back as `If-None-Match`, assert 304. Emitting a validator
  and ignoring it is the failure that looks exactly like success: the client
  sends it on every request and always gets the full payload. This is the seam
  a `max(updated_at)` validator lands in.
- **A handler's `ETag` set after its first `Write` still wins.** The header
  write is deferred, so the tag is still in the map — and without an explicit
  re-check it gets silently overwritten by a body hash. Assert the bytes
  written before the tag appeared aren't lost either.
- **Assert against the real middleware stack, not one the test assembles.**
  `apihttp.Stack()` exists because the order test built its own
  `Compress(ConditionalGet(...))` and so could only ever pass — the production
  order in `cmd/api/main.go` was swapped and the whole suite stayed green.
  Anything asserting composition must reach the shipped composition.
- **Browser clients need the CORS headers.** `If-None-Match` in
  `Access-Control-Allow-Headers`, `ETag` in `Access-Control-Expose-Headers`.
  Neither affects iOS or Android, so a native-only test pass says nothing —
  this needs a real cross-origin fetch from `apps/web`.
- **A WEAK `ETag` from a handler must still revalidate.** Comparison for
  If-None-Match is the weak one, so `W/` is stripped from **both** sides.
  Stripping only the client's candidate passes every strong-ETag test and
  silently breaks `max(updated_at)`-style validators, which must be weak
  because they cannot promise byte-identity. Test the verbatim echo — that is
  what a real client sends. And test that a *different* weak tag is still a
  200, or the strip has become "any weak tag matches".
- **A status that cannot carry a body is never gzipped.** RFC 9111 §4.3.4 has
  a cache copy a 304's headers onto the stored 200 it validates, so
  `Content-Encoding: gzip` on an empty 304 gets grafted onto a stored identity
  body. The damage lands in someone else's cache, never in a response anyone
  here would look at.
- **`Cache-Control: no-store` opts a route out entirely** — no `ETag`, no
  `304`, even against `If-None-Match: *`. `/v1/healthz` relies on it: a
  constant body means a constant validator, so a prober would be answered
  `304` for the life of the deployment while a checker asserting `200`
  reported an outage that isn't happening.
- **A handler-supplied validator must be user-scoped.** `Vary` does not
  include `Authorization`, so a bare `max(updated_at)` over a shared table
  would revalidate user B against user A's stored body. The body-hash default
  cannot do this; nothing enforces it for a handler's own tag.
- **The `Cache-Control` default reaches all four ETag paths** — handler tag set
  before `WriteHeader`, mid-stream, after the last write, and the middleware's
  own hash. The three handler paths commit the status line early, so the
  header cannot be added afterwards and has to be set on each.
- **The ETag comes with `Cache-Control: private, no-cache`.** Making responses
  revalidatable invites intermediaries that were not there before, and almost
  everything served is per-user data on an authenticated route.
- **List endpoints stay bounded.** The identity body is buffered whole to hash
  it, so an unbounded row count is an unbounded per-request allocation. Any
  new list endpoint needs a real-database test that it caps — and that the cap
  keeps the **newest** rows, since a flipped `ORDER BY` still passes a
  count-only assertion while quietly answering with the table's prehistory.
- **A bounded list needs a TOTAL `ORDER BY`, and the test needs a real tie.**
  A cap on a non-unique sort key makes membership nondeterministic: which row
  falls outside can change between identical requests, and the reordered array
  hashes differently, so the ETag on that endpoint becomes a permanent cache
  miss. Space every fixture row apart and the test cannot see any of it —
  create rows that tie *across the cut*. Note a covering index whose columns
  match the `ORDER BY` supplies the order too, so removing the SQL tiebreak
  may not turn the test red; say that in the test rather than implying
  coverage that isn't there.
- **A cap over a MULTI-OWNER list must sort the caller's own rows first.**
  `workout.List` mixes your workouts with every user's public ones, so a plain
  alphabetical cap evicts across ownership — your own workout named "Z…"
  disappears once 500 public "A…" ones sort ahead of it. A count-only
  assertion sees none of this; the fixture needs the caller's row to sort
  last by name.
- **Distinguish outcome from mechanism.** Two guards that produce the same
  status code can both be deleted one at a time with the suite still green,
  because each covers for the other. If a guard exists for a reason the status
  code cannot show (streaming instead of buffering, say), assert that reason
  directly or write down that the test does not pin it.

## Searching the technique library (mobile Library tab, web `/dashboard/library`)

- **An accented technique is findable by its ASCII spelling.** "sao paulo" must
  find "São Paulo Pass". This was broken for months and looked like missing
  content rather than a broken lookup — the response was to start building a
  way to add the technique, which would have minted a duplicate id.
- **And by its accented spelling**, so a Portuguese keyboard is not the thing
  that breaks instead. Fold both the query and the haystack.
- **The same for dashes, which is the bigger half.** All three of "north-south
  pass", "north–south pass" and "north south pass" must find the same thing.
  The catalog spells 16 names with U+2013, the keyboard offers the hyphen, and
  people type neither — so every dash folds to a space. The position chip for
  those techniques says "North-South" with a plain hyphen while the names use
  the en dash, so the screen contradicts itself before search even runs.
- **Position is searchable, not just name and aliases.** 37 half-guard
  techniques are named nothing like "half guard" and are reachable only by
  typing the position — assert on those specifically, or the case passes on
  name matches and proves nothing.
- Derive the cases from the catalog rather than hardcoding them — assert that
  *every* entry whose name carries a combining mark is findable by its folded
  form, so a future import is covered without anyone remembering.
- Aliases still match ("tozi" → São Paulo Pass), and case still does not matter.
- **A query must not match across two fields.** The haystack joins name,
  aliases and position; without a separator a query spanning the seam returns a
  technique that matches neither field.
- Repeating a search returns the same result — the folded haystack is memoised,
  and a stale or mis-keyed cache shows up as one query answering differently.
- Misspellings are **out of scope**: "sao paolo" finds nothing, and the fix for
  that is an alias, not fuzzy matching.
- **A search that finds nothing says so.** The reflection wizard's picker
  rendered blank space on zero results, which on that screen reads as "the
  technique isn't in the library" — the misreading that started three PRs of
  work. Assert the empty state names the query that failed.
## Planning a week, and starting what's planned (mobile)

Covers `lib/plan.ts`, `components/WeekPlanner.tsx`,
`components/TrainingCalendar.tsx`, `components/ui/PickSessionSheet.tsx`, and
the plan-shaped lead card on Today.

**Local-only for now** — plans live in the device's SQLite (`planned_sessions`,
schema v14) and never reach the server, so none of these scenarios should
assert anything about sync, and a second device is expected to show nothing.

### Planning a day (happy path)

- Plan tab → `+ Add` on a future day → pick a discipline with no template →
  the day shows that discipline with a lime rule and "Planned".
- `+ Add` → pick one of your workout templates → the day shows the template's
  name, not the discipline's.
- A day accepts more than one entry (lift in the morning, mat in the evening)
  and shows both, in the order they were added.
- Long-press a planned entry → confirm → it disappears, and **nothing logged
  changes**. Removing a plan must never touch a session.
- Renaming a template renames it wherever it is planned, without replanning —
  the plan stores the id, not the name.
- **Tapping a planned entry that names a template opens that workout**, and the
  entry draws a chevron. Long-press must still remove it — adding a tap handler
  to a `Pressable` is exactly how a long-press gets swallowed, so check both on
  the same row.
- **An entry with nowhere to go draws no chevron and does nothing when tapped.**
  Two ways to get one: plan a discipline with no template at all, and plan a
  template then delete it (the plan keeps no foreign key, so the row survives
  pointing at nothing and falls back to "<Sport> session"). The chevron is the
  part that matters — a row that advertises a screen it cannot open reads as
  broken, which is how this was found.

### The period switcher, and the week that folds away

One control — `‹ LABEL 📅 ›` — for anything that changes which period a screen
shows. On Plan it is the week; inside the month sheet it is the month.

- The label reads **THIS WEEK** on the current week and the date range of the
  shown week otherwise. That label is the only thing saying you have navigated
  (the old "Today" pill is gone), so it must be right for the week on screen,
  not for today.
- Left steps back a week, right steps forward, and they are not swapped.
- Tapping the label opens the month grid; the grid is not built until then.
- **The month sheet has its own Today**, which returns to this week and closes.
  This is the route back now that the header pill is gone — check it from a
  month far enough away that today is not on the visible grid at all.
- Inside the sheet the month name is a readout, not a button: it must not be
  announced as a disabled control.
- Voice Control: "tap THIS WEEK" must activate the pill — the visible text has
  to lead the accessible name, and this pill is the only route to the month.
- The week's authoring rows collapse behind **HIDE WEEK / SHOW WEEK**, and are
  **open by default**. Collapsed, the rows and every `+ Add` are gone and the
  compact strip remains.
- The strip's marker is a **hollow ring**, matching "planned" on the Today
  calendar, and it is fixed lime rather than the athlete's accent — a planned
  day must not read as trained, and must not change colour with a preference.
- Today's date in the strip uses the accent's *ink*, which stays legible on the
  purple theme where the fill does not.

### Today reads the plan back

- Plan today, return to Today → the lead card names it and offers **Start**.
- Start a planned day whose plan names a template → the session begins on that
  template directly, with **no chooser in between**.
- Start a planned day planned as a bare discipline → the normal chooser opens.
- Plan a BJJ day → the card says **Log**, not Start, and goes to the BJJ log —
  the same `logsAfterwards` predicate everything else uses.
- Nothing planned → the dashed rest-day card, which routes to Plan.

### The first suggestion (Tier 1: funnel gaps)

*"You drilled the arm drag 9 times and never tried it live."* Read from
`GET /v1/bjj/proficiency`; no local data involved.

- Fires only when a technique has **6+ drilled (which is 6 separate classes —
  `drilled` is written once per session), 0 attempted AND 0 scored, seen in the
  last 60 days** — and only for an athlete who has used the live counters on
  *some* technique. Without that last condition the gate cannot fail, because
  nothing but the focus grid can write those counters. Each gate is separately
  observable: land it once and the card must disappear.
- **Landing it counts as trying it.** A technique drilled 9 times and scored
  twice must NOT be suggested — `attempted` and `scored` are disjoint, so
  testing only `attempted` would suggest something the athlete already hits.
- The card shows its own evidence ("drilled 9 times across 3 sessions, never
  live"), never a bare verdict.
- **At most one card**, and it sits UNDER the plan, not above it.
- It appears only on today — stepping the day switcher hides it.
- Tapping it opens that technique in the library.
- With the API unreachable, there is **no card and no error banner**. A failed
  read must not be mistaken for "this athlete has logged no detail".

### Dismissing a suggestion

- The card carries an explicit **×**, not a long-press. Tapping it removes that
  suggestion and the **next-best one appears in its place**, immediately.
- The dismissal **survives an app restart**, and survives the evidence getting
  stronger — drill the dismissed technique ten more times and it must not
  return.
- Tapping the card body still opens the technique; only the × dismisses.
- With every candidate dismissed, no card shows — and no error.
- A corrupt or absent stored value reads as no dismissals: the screen must
  still render.

### Settings → Suggestions

- **Master off silences everything**, including the Tier 0 "add what happened in
  rolling" offer — an off that still nags for evidence is not off.
- **Master off does not erase the per-discipline choices.** Turn BJJ off, turn
  the master off, turn the master back on: BJJ must still be off.
- The per-discipline rows stay **visible and greyed** when the master is off,
  never hidden.
- A discipline the athlete has not configured is **on** — a new module in the
  registry must be suggestible with no migration and no write.
- **Dismissed techniques are listed by name**, or by id when the library cannot
  resolve one. "Suggest again" removes it and the technique becomes eligible
  once more.
- An unreadable or corrupt preference reads as **enabled**, never as off. A
  feature must not silently disable itself.
- The screen says the settings are device-local.
- **Every one of the above has to be observed back on Today, after returning to
  it — not on the settings screen.** This is the scenario that shipped broken and
  the one every bullet here silently assumed: the settings screen is pushed over
  the tabs and Today stays mounted behind it, so a Today that reads its
  preferences once per mount reads them once per *process*. Settings itself is
  pushed fresh every visit and always reads back what it just wrote, so checking
  it there proves nothing. Turn the master off, go back, and the card must be
  gone before the first frame settles; turn it on, go back, and it must return.
  Covered at unit level by `app/__tests__/suggestionPrefsRefocus.test.tsx`, which
  has to override the shared `useFocusEffect` mock to be capable of failing —
  worth reading before writing the functional version.

### The cold start (Tier 0)

- After the **2nd** BJJ session logged with no technique-level detail, Today
  offers "Add what happened in rolling". Not after the 1st.
- It stops after being **shown three times**, counted and persisted — not after
  a session count, which is computed over a rolling ~30-row window and would let
  the prompt return forever after a reinstall or a strength-heavy stretch.
- Its accessible name begins with its visible title, so Voice Control can reach
  it, and it says where it goes.
- It never shows to someone with any technique evidence, and never at the same
  time as a suggestion.

### Today steps a day, and says three different things about it

- The switcher reads **TODAY** on today and the weekday + date otherwise, and
  the line under it follows. Stepping is the only way to see a future day's
  plan without leaving the tab.
- **Only the Upcoming block moves.** The calendar, week summary, Recent and the
  trend must stay on the real week — step to Thursday and this week's stats
  must not change.
- On any day but today the label is a button that returns to today; on today it
  is a readout and must not announce as a control.
- **A past day offers no Start.** Its plans render dimmed and marked "Not
  logged". Starting one would date the session today and leave the plan owed.
- Three distinct states, and the middle one is the one that regressed before:
  plans owed → cards; **plans all logged → "That is everything planned"**, not
  "nothing planned"; no plans at all → the rest line.
- The rest line **never names a day** — it appears under a heading that may read
  THU, AUG 6 — and never congratulates or scolds. Same day, same line; next
  day, a different one.

### New Log, and the belt

- `+ New log` floats bottom-right and must never cover the last row, at any
  text size. It replaces the inline "Start something" card, which should be
  gone from the top of the screen entirely.
- The belt hero appears **only on a plan card for a discipline that wears one**
  — never on a strength card — and is centred, not cropped by the card edge.

### Last 8 weeks

- Hidden entirely until something has been logged.
- Counts **days trained, not sessions and not tonnage**: a BJJ-only athlete
  must produce visible bars, and two sessions in one day count once.
- Empty weeks stay as gaps in the ramp rather than being closed up.
- The current week is drawn hollow — a part-week bar must not read as a slump.
- One accessibility stop for the whole strip, and its label carries the whole
  series — a sighted reader gets eight values off the bars.
- **Never more bars than there is data for.** With six weeks of sessions
  loaded, the strip shows six bars, not eight with two empty ones.

### Recording a defensive success (`defended`)

The four live events are a 2x2 of who started the exchange and whether it
landed; `defended` is "they went for it, you stopped them" — the mirror of
`attempted`.

- The **per-technique focus chips** offer three counters: Tried, Landed,
  **Stopped**. The category grid stays **five rows of two** — Stopped must NOT
  appear there.
- Landed and Stopped both read as wins; Tried reads neutral.
- A Stopped count belongs to its own technique and its own event: bumping it
  must not move that technique's Landed or Tried, and must not touch another
  technique.
- Long-press to decrement stops at zero rather than going negative.
- `GET /v1/bjj/proficiency` returns a `defended` count per technique alongside
  drilled/attempted/scored/conceded.
- **It must be visible after it is written.** Record only "Stopped theirs" for
  a technique, save, and reopen the reflection: the technique still has a row
  with its counter editable. Open the session summary: its chip reads
  "N stopped", not a blank line. On web's proficiency page it is **not**
  bucketed as "Used on you".
- The counter reads **"Stopped theirs"**, not "Stopped" — a bare label reads as
  "my technique got stopped", which is what Tried already means, and would
  invert the evidence.
- The column headers line up with the counters beneath them at every text size.
- Posting a tag with `event: "defended"` is accepted; an unknown event is
  rejected with a 400 whose message **names every accepted value**, including
  `defended`. That message is generated from the vocabulary, so a new event can
  never be accepted while the message still denies it.

### A plan that has been met stops being drawn twice

The rule is `apps/mobile/lib/adherence.ts`: a plan is met by a logged session on
the same day in the same sport, matched one-to-one. Nothing is written — every
one of these is recomputed on read, which is what makes the deletion case work.

- Plan a strength day, then log a strength session on it → the week list shows
  **one** row (the session, with `planned` in its meta), not the session plus a
  "Planned" row. The lead card stops offering it.
- The week strip's dot for that day goes from hollow ring to filled.
- **Delete that session** → the plan is pending again: the row returns, the dot
  goes hollow, the lead card offers Start. This is the case a stored
  `completed` column cannot get right.
- Plan a BJJ day and log a **strength** session on it → both still show. The
  plan was not met; nothing was consumed.
- Plan one BJJ session and log **two** → one plan row disappears, both sessions
  show. Plan two and log one → one plan row remains.
- Plan "Workout 1" and log "Workout 2" on that day → the plan is met. The
  template is a starting point, not a contract.
- A session logged the **evening before** must not meet the next day's plan, and
  a 9pm session must meet *its own* day's plan (the day comes from local time,
  not the UTC date — this is invisible to a UTC-only test).
- Open the month sheet on a day that was planned and trained → one row there
  too. The month read is a wider snapshot and must be matched against, not
  ignored.
- The **Plan tab still lists every plan**, met or not. Reconciliation is a
  reading of Today, not a deletion — a met plan must remain editable.

**Not yet true on web.** `apps/web`'s calendar shows both, differentiated by
glyph. If that changes, these scenarios apply there too.
- A session already in progress outranks the plan card entirely.

### The calendar

- Collapsed: today is filled; a **filled** dot marks a day trained, a **hollow
  ring** a day planned. A day that is both shows the filled dot — what happened
  outranks what was intended.
- **The shape, not the colour, is the distinction.** Green and lime are 1.18:1
  apart in greyscale, so a screenshot with hue removed must still tell trained
  from planned. Check the ring's hole is visible at arm's length, not just in a
  screenshot — and on Android specifically, where border widths round.
- Every marker clears 3:1 against its own ground in **both** themes.
- `Week in review` expands to seven day rows; a trained day shows its
  duration/sets/volume and opens the session, a planned day shows "Planned"
  and is inert. An empty day says "No activity".
- Tapping the month name opens the month sheet; the arrows move both the grid
  **and** the "so far" totals, which must never keep the previous month's
  figures under a new month's heading.
- Tapping a day in the grid shows that day's entries beneath it.
- **The month grid must not under-report.** Log more than 30 sessions, then
  open the month — days beyond the Today screen's 30-row list must still be
  dotted. (The sheet loads its own wider window precisely for this.)

### Edge cases & errors

- Past days offer no `+ Add` and render "—" rather than "Rest": a day that has
  gone cannot be planned.
- A plan naming a template that is no longer cached degrades to its discipline
  and still starts, via the chooser — it must not vanish or crash.
- With every discipline disabled, the picker says so and offers the profile;
  it must not render an empty sheet.
- A day planned across a month boundary stays on the day it was planned for
  when the device timezone changes — the plan stores a local date, not an
  instant.

### Auth & data separation

- Signing in as a different account on the same device shows **none** of the
  first account's plans (shared-device rule — every row is user-scoped).
- Removing a plan while signed in as another account does nothing.

## The opening animation (mobile)

Covers `components/AnimatedSplash.tsx` and the splash handover in
`app/_layout.tsx`.

**Not a screen anyone navigates to**, so there is no route to drive — every
scenario below starts from a cold launch, and the only exit is the animation
finishing. The native splash is a bare `#080B12` field with no image (app.json),
which is the half that makes the letter-by-letter reveal possible; a native
splash carrying the finished wordmark would show the logo, hide it, then write
it again.

### The sequence (happy path)

- Cold launch → a bare `#080B12` field, then **V, O, L, A** uncovered
  left-to-right in that order, then the mark lands above the finished wordmark,
  then the whole lockup fades and Today is underneath it.
- The ground never changes shade across the handover — the native splash, the
  animation and the app all sit on the same `#080B12`. A step in brightness at
  any of the three joins is the bug this is most likely to regress into.
- The assembled lockup matches `vola-stacked-color.svg` minus its tagline:
  mark centred above, same gap, same relative sizes.

### It must not lift onto a blank screen

- Throttle the network so Clerk takes several seconds → the animation plays
  once and then **holds** the finished lockup until the app is ready. It must
  not fade out onto an empty screen and it must not loop or replay.
- Ready before the animation ends (warm launch) → the animation still completes;
  being ready early shortens nothing.
- Signed out → the fade lands on **sign-in**, not on a flash of the tab bar.

### Accessibility

- With **Reduce Motion** on, the finished lockup is shown immediately and still
  fades — nothing writes itself, nothing scales. The splash must not simply
  disappear, and must not animate anyway.
- A screen reader announces the splash once, as "VOLA" — not as its separate
  images, and not once per letter.

### Edge cases

- Background the app mid-animation and return → it does not resume into a
  half-written wordmark or strand the user on a splash that never lifts.
- Launch on the smallest supported width → the 240pt wordmark still clears the
  screen edges with margin.

## Plans API and the web calendar

Covers `backend/internal/modules/plan`, `/v1/plans`, and
`apps/web/src/app/dashboard/calendar`.

Mobile now uses this endpoint too (schema v15) — see the sync scenarios at the
end of this section for the cross-device cases.

### `/v1/plans` (happy path)

- `POST` with `{id, day, sport}` returns 201 and the plan, `workout_id` null.
- `POST` with a `workout_id` returns it set.
- `GET ?from=&to=` returns plans oldest first, insertion order within a day.
- `PATCH` with only `{notes}` leaves `day`, `sport` and `workout_id` alone.
- `PATCH` with `{"workout_id": null}` **clears** the template; omitting the key
  entirely leaves it. These two must not behave the same.
- `DELETE` returns 204 and the plan stops appearing in `GET`.

### Range and dates

- `from`/`to` are inclusive: a plan on `from` and one on `to` are both
  returned; one on `to + 1 day` is not.
- Missing `from` or `to` is 400 — **not** an empty list.
- `to` before `from` is 400. A range over 400 days is 400.
- `day: "2026-08-04T00:00:00Z"` is **rejected**, not truncated. Same for
  `04/08/2026`.
- A plan created for `2026-08-04` reads back as exactly `2026-08-04` from a
  client in any timezone — run this from a UTC-negative offset, which is where
  a timestamp round-trip would show up as the 3rd.

### Auth and ownership

- All four operations 401 without a bearer token.
- `GET` never returns another user's plans.
- `PATCH` and `DELETE` on another user's plan id return **404, not 403**, and
  leave the row untouched.
- `DELETE` of an id that never existed is 404, not 204.

### Edge cases & errors

- An unknown sport is 400 and the response must **not** contain
  `plans_sport_valid` or any other constraint name.
- An unknown `workout_id` is 400, not 500.
- Notes over 500 characters are 400.
- A duplicate `id` is 409 — the offline retry contract.
- Deleting a workout that days are planned around leaves those plans, with
  `workout_id` now null. They must not disappear.

### The web calendar

- The month grid marks logged sessions with a **✓** chip and planned days with
  an **○** chip; a day with both shows both, stacked.
- **The glyph, not the colour, is the distinction** — the borders and tints are
  reinforcement. With hue removed the two must still be tellable apart, and on
  a day both trained and planned as the same discipline (two chips reading the
  same word) that is the case worth checking.
- Borders draw with the **ink** steps at near-full alpha because they must
  clear 3:1: green-ink needs ≥70% on white, lime ≥95%. A regression to the old
  `/40` and `/60` renders them invisible in light mode while still looking
  deliberate in the source.
- The day cell's accessible name includes **both** layers — `aria-label`
  replaces the accessible name rather than adding to it, so a cell whose label
  is only the date announces none of its contents.
- Days spilling in from the neighbouring months are visible and dimmed, never
  blank, and carry their own marks.
- `←`/`→` move the month and reload both layers; `Today` returns and selects
  today.
- Clicking a day selects it; the side panel shows that day's logged total and
  its plans.
- Adding a plan appears in the grid without a manual refresh; removing one
  disappears from both.
- Changing the discipline in the form resets the template select to "None" —
  and must not flash the previous discipline's template for a frame.
- With a discipline that has no templates, the select offers only "None" and
  the plan still saves.
- A failed create or delete surfaces the API's message and leaves the grid as
  it was.
- With every discipline disabled, the form says so rather than rendering an
  empty select.

### Plan sync (mobile ↔ server)

Covers `lib/plan.ts`'s outbox and `lib/plansApi.ts`. Schema v15.

**Round trip**

- Plan a day on the phone → it appears in the web calendar after a sync.
- Plan a day on the web → it appears on the phone's Plan tab and, if it is
  today, as the Today lead card — **without leaving and re-entering the tab**
  (the screens re-read on `lastSyncAt`).
- Remove a plan on the web → it disappears from the phone.
- Remove a plan on the phone → it disappears from the web.

**Offline**

- Airplane mode → plan three days → all three appear immediately and the
  pending count rises. Restore the network → all three land, count returns to
  zero, nothing duplicates.
- Airplane mode → delete a synced plan → it disappears from every screen at
  once, and the server is told when the network returns.
- Force-quit between the local write and the sync → the plan survives and
  still syncs.

**Conflicts and ordering**

- Edit the same plan on both devices → last write wins on `updated_at`; the
  loser is not silently resurrected on the next pull.
- A plan referencing a template that has not synced yet is **deferred**, not
  failed — the pending count includes it, no error banner appears, and it goes
  out once the template lands.

**Deleting while a push is in flight — sessions and workouts (T6)**

The same race as the plan case above, in the other two outboxes, where the guard
was missing entirely rather than merely untested. Reproduce against a slow or
throttled network.

- Delete a **session** while its push is in flight → it stays owed, the pending
  count still shows it, and the delete reaches the server on the next sync. It
  must not end up gone from the phone and alive on the server with pending
  reading zero — that state never retries and nothing reports it.
- Delete a **workout** mid-push → same, and the `DELETE` actually goes out on
  the following sync rather than merely staying dirty forever.
- A push with nothing deleted underneath it still clears to zero pending, in
  both cases.
- An ordinary **edit** mid-push still keeps the row owed too — the older guard
  must survive alongside the new one.

**Editing or deleting while a push is in flight (T5)**

The window between the sync reading a plan and writing "sent" back. The Plan
screen writes through on every change, so landing in it is ordinary. Easiest to
reproduce against a deliberately slow or throttled network.

- Edit a plan while its push is in flight → the newer edit is **still pending**
  afterwards and reaches the server on the next sync. It must not be marked as
  already sent; the pending count must not drop to zero with the edit only on
  the phone.
- Delete a plan while its push is in flight → the tombstone survives, the
  pending count still shows it, and the server is told on the next sync. The
  plan must not end up gone locally and alive on the server, which is the state
  nothing ever retries out of.
- The same delete done fast enough to share a millisecond with the push's own
  snapshot behaves identically — that collision is the case `updated_at` alone
  cannot catch.
- A push with nothing landing underneath it still clears to zero pending, so the
  guards above are not just "never mark anything sent".
- Deleting a plan whose template has not synced is **not** deferred.
- A create whose response is lost retries and reconciles via 409 — it must not
  create a second plan, and must not be reported as permanently failed.

**The destructive edges** (each of these has already been a bug in this
codebase's other outboxes)

- A plan deleted on the phone must not be resurrected by the next pull.
- A plan created on the phone must not be deleted by the same run's pull just
  because the server's list did not echo it back yet.
- A local edit still waiting to go out must not be overwritten by a pull, even
  when the server's copy has a newer `updated_at`.
- A plan the server has never seen must not be swept by the "deleted
  elsewhere" pass.

**Errors**

- A permanently-refused plan (unknown sport, notes too long) records the
  server's message and stops being retried; it must not grind forever.
- A transient failure records **nothing** on the row.
- A refused plan that later succeeds clears its error.
- Signing out and into another account on the same device shows none of the
  first account's plans and pushes none of them.

## Brand marks in the app (mobile)

Covers `components/ScreenHeader.tsx`, the icon entries in `app.json`, and the
generated rasters in `apps/mobile/assets/images/`.

**Mostly not testable in Expo Go.** The app icon is native — Expo Go shows its
own icon regardless of project config — so every icon scenario below needs a
real build (`expo run:ios --device` or EAS). The header scenarios are ordinary
JS and show up on a reload.

### The header

- Every tab screen shows the drawn wordmark centred, and **no tick beside it**.
  The tick appearing again means someone re-added the old lockup.
- The wordmark is the artwork, not text: the A has no crossbar and the O is a
  rounded rectangle. If the A has a crossbar, a font is being rendered.
- It stays centred on the screen, not centred in the space left over by the
  title — a long screen title must not push it off centre.
- A screen reader announces it once, as "VOLA", with the header role. Not twice
  (wrapper and image both labelled), and not as a filename.

### The icons

- Home screen after a real build: the faceted three-green tick on `#080B12`-ish
  navy, **no wordmark and no lettering** — at home-screen size, letters that
  small are mud.
- No transparent corners on iOS. A 1024 icon with alpha is an App Store
  rejection, so this is worth asserting on the artifact, not just by eye.
- Android: the tick survives every launcher mask shape — circle, squircle,
  rounded square — without a limb being cropped.
- Android themed icons on: the monochrome layer renders as one solid tick
  silhouette, not three separate facets with seams between them.

### Regeneration

- Editing `assets/brand/app-icons/*.svg` and re-rendering reproduces the shipped
  PNGs. If it doesn't, the master and the raster have drifted and the master is
  no longer the source of truth it claims to be.

## Content authoring in the admin console (`apps/admin` `/content`)

### Happy path

- The list shows **only admin-authored** techniques, not the catalog. Seed the
  library, author one, and assert the list has exactly one row — 542 seeded
  entries must not appear, because the edit path refuses every one of them.
- Creating a technique returns a **derived id** and the screen shows the real
  one from the API, not only the typed preview. "Cabeçada Counter" →
  `cabecada-counter`, accents folded.
- The new technique is immediately visible in `GET /v1/techniques` and on the
  phone. That immediacy is the point of the feature.
- Editing changes only what was edited. Change `typical_belt` alone and assert
  the description, aliases, `setup_from`, `function` and `to_position` are all
  still there — a console that sends partial bodies erases prose it never
  displayed, which is the failure the API's pointer-typed request exists to
  survive.
- The position dropdown comes from `GET /v1/admin/techniques/positions`, not a
  hardcoded list. Add a position to the catalog and it appears without a
  frontend change; that is what stops a technique being filed under a position
  no filter matches.

### Edge cases & errors

- **A rejected save must not clear the form.** Submit a name that collides,
  then assert every one of the seventeen fields still holds what was typed —
  *including the selects*. React resets a form after its action, and the
  selects and text inputs restore by different mechanisms, so a half-restore is
  the likely regression and it looks like success.
- The API's own message is shown verbatim: "a technique with that name already
  exists — ids are derived from the name". Do not replace it with a generic
  string; with eighteen fields, naming the offending one is the difference
  between fixing it and guessing.
- A name of only punctuation is refused ("must contain letters or digits") and
  the id preview shows empty, so the cause is visible before submitting.
- **A seeded id gets an explanation, not a form.** Visit `/content/knee-cut-pass`
  and assert there is no save button and the copy names `techniques.json`. The
  API would refuse the edit; a form that always fails is worse than none.
- An id that exists nowhere is a real 404, distinct from the seeded case.
- Category offers exactly the importer's nine. Anything else seeds and renders
  fine and then breaks the next spreadsheet re-import.

### Auth and security

- `/content(.*)` is in the `proxy.ts` matcher, so a signed-out visitor gets the
  sign-in prompt rather than the layout's own refusal.
- A signed-in account **not** on `ADMIN_USER_IDS` gets "Not authorized".
- **The server actions check the allowlist themselves.** Invoke the action
  endpoint directly as a non-admin, without ever loading the page, and assert it
  refuses — a server action is exposed independently of the route it was
  declared beside, so the layout gate does not cover it. The backend's
  `RequireAdmin` is the real boundary and must also refuse.
- The Clerk token never reaches the browser: writes go through server actions,
  and `lib/api.ts` is `server-only`.


## Brand marks in the app (web)

Covers `apps/web/src/app/Brand.tsx`, the sidebar in `dashboard/layout.tsx`, the
signed-out entry in `page.tsx`, and `icon.png` / `apple-icon.png`.

Unlike mobile's, all of this **is** verifiable in a browser — the marks are
inlined SVG, so they are in the DOM and can be asserted on directly rather than
compared as pixels.

### The lockup

- Sidebar and signed-out entry both show the **stacked** lockup: mark above,
  wordmark below, centred. Side-by-side means someone reinstated the horizontal
  arrangement, which does not survive without the tagline.
- No tagline anywhere. The lockup is exactly **7 paths** — three mark facets and
  four letterforms — and **zero `<text>` elements**. An eighth path or any text
  node means a source SVG was pulled in whole instead of cropped.
- The wordmark is the artwork, not type: the A has no crossbar and the O is a
  rounded rectangle.

### Light and dark

- Toggle the theme: the wordmark's computed `fill` follows the text colour
  (`#10151F` light, `#F3F6FA` dark) while the mark's first path stays
  `#D0E950` in both. Assert the computed style, not a screenshot — the whole
  point is that one asset serves both.
- Hard-reload on each theme: **no flash of the wrong colour**. This is what
  choosing between two image files would have cost, so it is the regression to
  watch if anyone swaps the inline SVG for `<Image>`.
- Neither mark is themed by `prefers-color-scheme` — the app's own toggle wins,
  so an OS set to dark and the app set to light must show the light treatment.

### Accessibility

- The sidebar link exposes one accessible name, **"VOLA — dashboard"**, and the
  two SVGs are `aria-hidden`. Not "VOLA VOLA", and not an SVG announced as a
  graphic.
- The signed-out page still has an `h1` reading "VOLA" — visually hidden, but
  present, so the page has a heading. Removing the `sr-only` heading because the
  logo "says it" leaves the page with none.

### Icons

- `/icon.png` and `/apple-icon.png` serve the faceted mark on navy — no
  wordmark, no lettering. Browser tab and iOS home-screen bookmark both.
- Both are generated from `assets/brand/app-icons/vola-app-icon-dark-1024.svg`,
  the same master `apps/mobile` renders from. If the two apps' icons ever differ
  visually, one of them was hand-edited.

## Brand marks in the app (admin)

Covers `apps/admin/src/app/Brand.tsx`, the signed-out entry in `page.tsx`, the
shared `AdminMasthead.tsx` and `NotAuthorized.tsx`, `error.tsx`, and
`icon.png` / `apple-icon.png`.

**Every full-screen surface in this console is branded now** — the deferral
recorded here previously is closed. The six duplicated mastheads are one
`<AdminMasthead>` rendered by each page, the three "Not authorized" screens are
one `<NotAuthorized>`, and `error.tsx` carries the lockup too. The identity is
deliberately **not** the same artwork everywhere: the mark alone in the
masthead bar, the stacked lockup on centred full-page surfaces, and the lockup
plus an "ADMIN" qualifier only on the signed-out entry. A scenario asserting
one uniform treatment is asserting the opposite of the design.

### The entry screen

- Signed out at `/`: the stacked lockup with **"ADMIN"** in condensed caps
  beneath it. Not "VOLA Admin" as a single typed string, and "Admin" is not part
  of the artwork.
- The lockup is the same 7 paths as web's — three mark facets, four letterforms,
  no tagline.
- Signed in: `/` redirects to `/users` and the entry screen is never seen, so
  every scenario here starts signed out.

### Accessibility

- One accessible name: the `h1` carries `aria-label="VOLA Admin"` and *contains*
  the lockup and the word "Admin", so a linear pass announces it once. It must
  not announce as "VOLA Admin … Admin" — that stutter is what the earlier
  `sr-only`-duplicate arrangement produced, because the visible "Admin" stayed
  exposed alongside a hidden heading saying the same thing.
- The visible content is the heading. Replacing it with a hidden heading plus
  decorative graphics reintroduces the stutter; removing the heading entirely
  because the lockup "says it" leaves the console's entry with no heading.
- "Admin" is 4.5:1 or better against the page. It uses `text-button-text`, not
  `text-text-secondary` — the latter is 4.41:1 at this size and weight.

### The masthead

Every signed-in screen: `/users`, `/users/{id}`, `/content`, `/content/new`,
`/content/{id}` (both its branches) and `/health`.

- The faceted mark sits at the far left of the header on **all** of them,
  followed by a vertical rule, then the page's title. It is the mark alone —
  no wordmark. A stacked lockup here roughly doubles the header's height, so
  finding one means someone swapped the primitive without re-measuring the bar.
- The mark links to `/users`, not `/`. Signed in, `/` only redirects there, and
  a masthead logo should not cost a round trip to do it.
- Its accessible name is on the **link** ("VOLA Admin, user lookup"), because
  both brand primitives are unconditionally `aria-hidden`. The `svg` itself
  must stay `aria-hidden="true"` and expose nothing.
- The mark keeps its own three greens rather than `currentColor` — it renders
  identically against the header's `bg-card` and would against any other
  ground. Three `path` elements, no more.
- **Every screen has exactly one `h1`, and it is the masthead's title.**
  `/users/{id}` is the regression to watch: its title used to be a `<span>`, so
  that page had no heading at all while looking like it did.
- `content/[id]` renders a masthead on **both** branches — the editable form and
  the seeded dead-end. A change that brands only one is easy to miss, since
  reaching the second needs the id of a technique the console does not own.

### The masthead's navigation

- Top-level screens show **all three** destinations, not two. The current one is
  present and marked `aria-current="page"`; it is not omitted. A nav whose
  contents change as you move is the older behaviour and a regression.
- Exactly one link per header carries `aria-current`, and it matches the screen.
- The current link is styled by weight/colour and the others by underline — but
  the assertion belongs on `aria-current`, not the class. Colour and weight
  alone never carried this fact, which is why the attribute is there.
- Detail screens (`/users/{id}`, `/content/new`, `/content/{id}`) show their
  single up-link *instead of* the three destinations, and no `aria-current`.
  That up-link is **not** inside a `nav` — one link is not a navigation
  landmark, and a landmark labelled "Console" that holds only "Back to content"
  promises destinations it doesn't have. So the count of navigation landmarks
  on a detail screen is zero, not one.
- `/content` additionally shows the "New technique" action after the nav.

### "Not authorized"

Reached by signing in as an account whose Clerk id is absent from
`ADMIN_USER_IDS`, on any of `/users`, `/content`, `/health`.

- All three routes render the **same** screen — it is one component now. Copy
  drift between them means someone reintroduced a local copy.
- The stacked lockup sits above the heading, named `VOLA Admin` on a wrapper
  with `role="img"`. It is **not** a link: the only route to offer leads back to
  the one that just refused.
- No "ADMIN" qualifier here, unlike the signed-out entry. The `h1` is
  "Not authorized"; a second line of display type above it competes with it.
- **The offending id is followed by a space**: it reads "user_2xYz… isn't on the
  admin allowlist", never "user_2xYz…isn't". That defect shipped in all three
  copies, and nothing but reading the rendered page catches it — no typecheck,
  no lint, no test. Assert on rendered text, not on the JSX.
- The `<UserButton />` is still present, so a wrong-account sign-in is
  recoverable from this screen.

### The error boundary

Reached whenever an admin read fails — a stopped API, an expired token, or an
`ADMIN_USER_IDS` mismatch between this app and the backend.

- It replaces the **whole** page, masthead included, so the lockup on it is what
  keeps the screen looking like part of the console. Named the same way as
  `NotAuthorized`'s, and equally inert — "Try again" is the way out, and a logo
  linking to a route that is currently throwing is a loop.
- The three messages still key off the status: 403 names the two
  `ADMIN_USER_IDS` copies, 401 says sign out and back in, anything else points
  at `NEXT_PUBLIC_API_URL`.

### Icons

- `/icon.png` and `/apple-icon.png` serve the faceted mark on navy.
- They are **byte-identical to `apps/web`'s** — same master, same render. If
  they ever differ, one app's icons were regenerated and the other's weren't,
  which is the drift this whole pass exists to remove.

### The copies must agree

- `apps/admin/src/app/Brand.tsx` and `apps/web/src/app/Brand.tsx` are duplicates
  pending a generator. This is enforced, not remembered: `pnpm run
  check:brand-copies` compares both files from the `import type` line onward and
  fails on any difference. It runs in `verify` and in CI's admin job.
- The check must **fail** when the copies differ — mutate one file by a single
  character and confirm it goes red. A drift check that cannot go red is the
  same class of thing as the zero-assertion test this repo already deleted once.
- It must also fail, not pass, if its comparison anchor disappears. A file
  restructure that removes the `import type` line should error loudly rather
  than silently comparing nothing.

## The You tab: belt masthead, training spans, records (mobile)

Covers `components/BjjRankHeader.tsx`, `components/TrainingSummary.tsx`,
`components/RecordsCard.tsx`, `components/ui/Medal.tsx`, `lib/history.ts` and
`lib/records.ts`.

### The belt masthead

- BJJ on **and** a rank recorded: the masthead renders at the top of the tab,
  above the display name — the belt drawn full-width, then "YOUR RANK" and the
  belt's name, then the facts row.
- BJJ on and **no** rank: one quiet row, "No rank recorded yet", which navigates
  to `/bjj`. Not a full-height masthead, and **not two cards** — assert only one
  `/bjj/standing` request fires for the screen. Two components fetching it was
  the bug this replaced.
- BJJ off: no masthead and no placeholder at all.
- **The facts come from the awarding promotion, not the rank.** Record two
  promotions at the same belt/stripes/degree with different dates and academies;
  the masthead shows the *later-dated* one. Add an undated duplicate and assert
  the dated one still wins.
- Edit the promotion a rank was derived from so nothing matches it any more: the
  belt still renders, with no facts invented.
- A promotion with no academy and no date shows neither label — no "School: —".
- **Dates render as the day that was typed.** Record `2024-03-12` with the
  device in a UTC-negative zone (America/Los_Angeles) and assert it does not
  render as 11 March.
- Nothing truncates. "Gracie Barra Kyiv" wraps rather than becoming
  "Gracie Barra…", and the promotion date never loses its year.
- VoiceOver reads the masthead as one utterance — name then each labelled fact —
  not six fragments.

### The training spans

- All four of `1W / 1M / 6M / 1Y` are offered, and each refetches.
- **Nothing overflows the card at any span.** Assert the grid's rendered width
  is ≤ the card's inner width on 1Y — the failure this replaced was silent, with
  three quarters of the year off-screen and no scroll.
- Shape flips with the span: 1W and 1M lay out seven-across with weekday
  letters; 6M and 1Y lay out weeks-across with none. The letters must never head
  a heatmap column, where they would label a week.
- Switching span while a request is in flight must not show the previous span's
  totals under the new span's label — the numbers are tagged with the span they
  were fetched for.
- The streak is computed over its own fixed year window. Log one session a week
  for 12 weeks and assert the streak reads the same on every span — a streak
  that equals the span length is a function of the control, not the training.

### The weekly volume chart

- **Exactly seven bars, always** — including a week with nothing logged, and a
  week with a single session.
- The count is the current week regardless of the selected span: assert the bars
  do not change when the span does.
- Days later in the week than today are dimmed, not drawn as zero. On a Tuesday,
  Thursday must not look like a session that was missed.
- A day with training but no tonnage (a BJJ session under a volume axis) draws a
  visible bar, not nothing.
- The header reads "day N of 7", where N is today's position Monday-first — 7 on
  a Sunday, 1 on a Monday.

### The stat tiles

- A year of training does not overlap its neighbour. Assert `312h` and not
  `312h 45m`, and that the figure shrinks on long strings rather than clipping.
- `formatDuration` keeps minutes right up to 99h 59m and drops them from 100h.
- A metric with no data shows an em dash at full size, not a collapsed row.

### Records

- One card of divided rows, not a card per lift.
- **The medal tier tracks `is_recent`**: gold for a record set in the last 30
  days, silver otherwise, and the gold carries a star so the tiers survive
  greyscale.
- The estimated 1RM renders as a whole display unit (`74kg`), never
  `74.48kg` — an estimate rendered to two decimals reads as a measurement. The
  heaviest lift beside it keeps its real decimals.
- A record whose exercise is missing from the cached catalog renders its name,
  not its slug — and if the catalog is genuinely absent, it must not render a
  UUID to the athlete.
- Tapping a row opens that exercise; VoiceOver announces the lift, the headline
  record, the evidence set and any secondary records as one utterance.

## Reading a BJJ session back (mobile, regression)

- **Open a class from Today → Recents.** It must render, not crash. This was a
  black screen and "Something went wrong" — one `useMemo` below an early
  return, so the loading render called one fewer hook than every render after.
- Any test for this must render through the **loading transition**, not just
  the settled state: assert the spinner first, then the loaded content.
  Asserting only on the end state passes against the bug, because by then the
  hook count is consistent again.
- Assert something the hoisted memo produces — the technique rows — so that an
  early `return null` cannot pass for a fix.
- `pnpm run lint:mobile` must fail on a hook after an early return. That rule
  is the guard for the class; the component test is the guard for the screen.

## Session summary figures (mobile, `components/ui/Stat`)

- **The unit is smaller than its figure.** `480kg` reads as one quantity when
  the `kg` is ~62% the size and a step quieter, and as two things when it isn't.
- **A thousands separator stays inside the figure.** `12,450kg` must not split
  on the comma — that renders the `,` small and muted in the middle of a number.
- **A long figure shrinks; a short one does not.** Pounds run an order of
  magnitude longer than kilos (`553.7k lb`), and a row where one stat is smaller
  than its neighbours is the reported "truncates and looks ugly". Assert both
  directions, or a ladder that always shrinks passes.
- **A clock is one figure.** `2:39` and `1:23:45` must not split on the colon —
  that renders a muted 14pt `:` between full-size digits, which is worse than
  the problem the component exists to fix. Same class as the comma.
- **The ladder depends on how many stats share the row.** Four columns are ~a
  third narrower than three, so the same value has to shrink further; assert a
  four-column value comes out smaller than the same value at three, and that at
  least one real case actually moves.
- **A single falsy child renders no slot.** `<StatRow>{finished && <Stat/>}</StatRow>`
  is not an array, so an `Array.isArray` check falls through and renders one
  empty column.
- **The em dash is not a unit.** A missing figure holds a number's worth of
  space at full size rather than collapsing the column.
- Each stat announces as `"<value> <label>"` — ungrouped, VoiceOver reads the
  number and the word as two unrelated stops.
- **No screen should carry its own copy of this.** The session summary did, and
  it used `adjustsFontSizeToFit`, which the shared component deliberately avoids
  because it measures after layout and is unreliable across nested `Text` runs.

## Exercise authoring in the admin console (`/v1/admin/exercises`, `/content/exercises`)

Everything under "Content authoring in the admin console" applies here too —
the ownership rule, the seeded-id explanation, the restore-after-a-rejected-save,
the server actions checking the allowlist themselves. These are the ones this
catalog adds.

### Happy path

- The vocabularies come from `GET /v1/admin/exercises/vocabularies`, which is
  derived from the same maps the seeder validates against. Assert every offered
  value actually passes validation — the point of serving them is that picking
  one cannot be refused.
- An exercise created here is immediately in `GET /v1/exercises` and on both
  clients.
- **`cmd/exportcontent` merges it into `exercises.json`**, the file the deploy
  embeds and seeds, leaving the 504 entries already there untouched.
- The exported file seeds. Run `cmd/seed` from it and count the rows.

### Edge cases & errors

- **Editing one field must not flip `is_unilateral`.** This is the field a
  plain-bool decode cannot express — false and absent are the same value — so
  create a unilateral exercise, PATCH only `movement_pattern`, and assert it is
  still unilateral. Everything else on the row must survive too.
- **A re-export must not wipe media.** Give an exercise media in the file, edit
  it in the console, re-export, and assert the media is still there. The write
  path cannot author media and the export does not read it, so the naive
  behaviour is to reset it to `[]` — deleting the only record of an asset still
  in the bucket.
- A new exercise exports with `"media": []`, not a missing key: all 504 shipped
  entries carry the key.
- An unknown `movement_pattern` is refused and **the message lists the legal
  sixteen**. This is the one field where being wrong looks exactly like being
  right — the exercise renders and is silently invisible to every cross-sport
  rule — so a bare "invalid input" is not enough.
- An unknown `sport` and an unknown `load_type` are refused by name too.
- "Zercher Squat" is already in the seeded catalog. Creating it must 409 rather
  than mint a second id, and that is worth asserting with a real name from the
  catalog rather than a synthetic one.

### The properties only a real database can check

The fake repository implements its own ownership check, so these pass in the
handler suite no matter what the SQL says:

- **`UPDATE ... SET source = 'admin'`** — the write TAKES OWNERSHIP, in the
  statement rather than in Go. Any row is editable now (the refusal that used to
  live in the WHERE went with the spreadsheet), so the property that matters is
  the flip: edit a **seeded** row, then run `UpsertAll` with the original
  values, and assert the edit survives. Drop `source = 'admin'` from the SET and
  every assertion before that re-seed still passes while the next deploy quietly
  reverts the edit.
- **`AdoptAsSeeded` must not touch `updated_at` on already-seeded rows.** Assert
  the timestamp, not `source`: setting `seed` on a `seed` row is invisible in
  the value, and clients delta-sync on the timestamp, so an unscoped adoption
  makes every exercise look changed to every device.
- **A deploy re-seed must not revert an admin row.** Create one, run
  `UpsertAll` with a different name, assert the admin row is unchanged.


## Planning any week, not just this one (mobile, `components/WeekPlanner`)

The Plan tab was pinned to the current week with no navigation. These cover the
week stepper, the month grid used as a jump target, and the focus rule that
decides when the shown week is corrected.

### Happy path

- The header shows the month of the displayed week and a `‹ ›` stepper; the
  rows show Monday–Sunday of that week.
- `›` advances one week: the rows show the next seven days **and the plans
  shown are that week's**, not the current week's. (The read was pinned to
  `new Date()`; a test that only checks the dates would pass against the bug.)
- `‹` goes back a week, including across a month boundary and a year boundary.
- Tapping the month title opens a month grid: spill days from the neighbouring
  months are present and dimmed, today is marked, days holding a plan carry a
  dot, and the week currently in the rows is highlighted.
- Tapping any day in the grid closes it and loads that day's week into the
  rows — including a day in a **past** week, and a day in a spill row belonging
  to another month.
- The grid's own `‹ ›` pages months without changing the rows behind it; closing
  with `Done` leaves the rows on whatever week they were showing.
- A day in a future week can be planned end to end: `+ Add` → pick a template →
  the entry appears on that day, and is still there after leaving and returning
  to the tab.
- The `Today` pill appears only when the shown week is not the current one, and
  returns to it.

### Edge cases & errors

- **A week spanning two months is labelled by its Thursday** (ISO 8601): the
  week of 29 September–5 October reads "October", not "September".
- **The year appears in the label only when it is not the current year** — so
  navigating from December into January visibly changes the label.
- **On focus, a past week snaps forward to the current one; a future week does
  not.** Leave the tab on next week, return, and it is still next week. Leave it
  on a past week, return, and it is the current week. This is `refreshedAnchor`;
  covered by unit tests in `lib/__tests__/calendar.test.ts`, but the wiring —
  which effect reads the anchor — is only observable here.
- Past days offer no `+ Add` and render `—` rather than "Rest", on any week
  reached by navigation, not just the current one.
- A month with no plans at all shows a grid of bare dates and no dots.
- February in a common year starting on a Monday renders **four** rows, not six
  padded with a fortnight of foreign days.

### Accessibility

- The stepper buttons are named "Previous week" / "Next week"; the month title
  names the month and says it opens the month view.
- Every grid cell speaks its full date plus "today" and/or "planned" — a cell
  that reads out as a bare number tells a screen reader nothing, and the dot is
  the whole content of that grid.

## Renaming a workout template (`PATCH /v1/workouts/{id}`, mobile + web)

The name was fixed at creation until this existed — there was no verb for it.
These cover the new endpoint, its ownership gate, and the offline flag that
carries a rename made without signal.

### Happy path

- Open a workout you own, tap/click the title, type a new name, confirm — the
  title updates, and it is still the new name after a reload.
- **Mobile: the field opens with the whole existing name SELECTED, so the first
  keystroke replaces it.** This is the one that shipped broken —
  `selectTextOnFocus` does nothing alongside `autoFocus` on iOS and says
  nothing about it, so the field opened with a caret at the end and every
  rename appended. Check on a device, not in a test: the evidence is the
  highlight, and no jest runner applies a `selection`. The same applies to the
  BJJ session rename, which had the identical pair.
- **…and it stops selecting the moment you want the caret.** Tap into the text,
  or drag a selection handle, and the selection must stay where you put it. A
  field that snaps back to select-all on every tap is worse than the bug above,
  and it is the natural way to get this wrong.
- The item list is unchanged by a rename: the same exercises in the same order,
  with the same targets.
- Plans pointing at that template show the new name (they resolve it from the
  cache on each read rather than storing a copy).
- Web: Enter commits, blur commits, **Escape abandons** and leaves the old name.
- Mobile: renaming offline updates the row immediately; the change reaches the
  server on the next sync, and the pending count returns to zero afterwards.

### Edge cases & errors

- A blank or whitespace-only name is refused, and the old name stays. On mobile
  it is refused *locally* — it must never enter the outbox, or the pending
  count never reaches zero and nothing on screen explains why.
- Leading/trailing whitespace is trimmed, so the stored name matches what the
  server stores.
- A name of exactly 120 characters is accepted; 121 is refused. Counted in
  **code points**, so 120 Japanese or accented characters must be accepted —
  a byte-based cap would refuse at roughly 40.
- Renaming a workout deleted from another device reports honestly rather than
  silently succeeding.
- Web: a server refusal restores the previous name rather than leaving the new
  one on screen.
- An ordinary item edit must NOT also send a rename — worth asserting at the
  request level, since it is one extra request per debounced keystroke.
- After a rename AND an item edit, the rename is sent first: the reverse leaves
  the server holding new items under the old name.

### Auth / security

- A workout you can SEE but do not own (a VOLA template, or another athlete's
  public one) offers no rename control, and `PATCH` refuses it with 403 if
  called directly — the ids are client-supplied, so the gate is the only thing
  standing between a guessed id and someone else's template.
- A workout id that does not exist returns 404 — and so does someone else's
  **private** workout, which is the case that matters: a 403 there would
  confirm the id exists, and ids are client-generated and often guessable.
  Someone else's **public** workout is deliberately different, returning 403,
  because you can already read it and a 404 would disguise a permission problem
  as a missing row. This mirrors the rule stated for the other verbs above; an
  earlier draft of this bullet said "404" flatly and contradicted it.
- Upgrading an install with cached templates must not mark their names as
  owed — otherwise the first sync re-sends every one, including ownerless VOLA
  templates the server refuses.

## The Plan screen's chrome (mobile, `app/(tabs)/workouts.tsx`)

The scope switch and the New workout button. Mostly visual, but one of these is
a real layout guarantee rather than a preference.

### Happy path

- The scope control shows both segments under one hairline; the selected one
  carries a 2pt accent bar and its label takes the accent, the other is muted.
- Tapping `Shared` loads other people's public templates; tapping
  `My workouts` returns to your own. The selection survives leaving and
  returning to the tab.
- `New workout` opens the create sheet, and a workout created there appears in
  the list without a manual refresh.

### Edge cases & errors

- **Scroll to the very end of the templates list: the last card must be fully
  visible and not sit under the New workout pill.** This is the regression that
  prompted the work — the button used to cover the planner's "long-press to
  remove" hint permanently, at every scroll position, because the list reserved
  less bottom padding than the floating button occupied. Worth asserting at
  both extremes: an empty list, and a list long enough to scroll.
- The bottom clearance must not change between scopes — `Shared` hides the
  button, and if the padding went with it the list would jump under the
  reader's thumb on every switch.
- With no templates at all, the empty state is readable and the button does not
  overlap it.

### Accessibility

- The two segments carry `accessibilityState={{ selected }}`, which is what
  announces the active view — the role stays `button`, because React Native
  maps `"tab"` to no trait at all on iOS, so it would cost the "button"
  announcement and gain nothing outside a `tablist`.
- Selection is carried by the presence of the underline, not by colour alone:
  the bar is there or it is not. Worth checking with the blue and purple
  accents specifically, where the selected label is *darker* than the
  unselected one and hue alone would read backwards.
- The New workout pill carries both an icon and a label, not an icon alone.
- Both the segments and the pill are under 44pt tall and rely on `hitSlop` to
  reach it — worth verifying by touch rather than by eye.
- At Accessibility text sizes the pill grows; the bottom clearance is derived
  from the font scale so the last list row should still clear it. This is the
  case the original bug lived in, and it is the one least likely to be checked.

## The accent theme and the belt masthead (mobile)

Covers `lib/AccentProvider.tsx`, the picker in `app/settings.tsx`,
`components/BeltPhoto.tsx`, `components/BjjRankHeader.tsx` and
`scripts/validate_palette.mjs`.

### Choosing an accent

- Five swatches appear in Settings → Preferences. Tapping one recolours the tab
  bar's active icon, its label and the underline **without leaving the screen**.
- **Selection is marked by a ring and a tick, never by colour alone.** That
  matters more here than anywhere else in the app, because the thing being
  chosen is colour. Assert the chosen swatch has both.
- The tick uses each theme's own ink — dark on green and yellow, white on
  purple. A single hard-coded tick colour fails on at least one theme.
- The choice survives a cold start. It is stored per account in `prefs` and
  never synced, so a second device gets the default rather than an inherited
  colour.
- **Signing into a second account must not show the first account's accent**,
  even for one frame. The stored value is tagged with the account it was read
  for; untagged, the previous choice showed until the new read resolved.
- Signed out, the auth screens render the default. They deliberately reference
  the default constant rather than the provider.

### What the accent must NOT touch

Each of these is a reading, and a reading whose colour depends on a preference
is one nobody can learn. Switch to a non-default theme and assert they are
unchanged:

- the consistency grid's ramp and its legend
- the weekly volume bars
- a completed set's tick, a scored round, "New" on a fresh record
- the planned-day marker on the calendar
- a Library tile's category colour
- `warn` and `danger`

### The palette gate

- `node scripts/validate_palette.mjs` passes, and runs first in `verify`.
- **It self-checks before reporting**: it reproduces the figures recorded in
  `Colors.ts` and fails loudly if it cannot. A validator that cannot reproduce
  known-good measurements is not evidence about anything.
- It reads the palette from `Colors.ts` rather than holding a copy — change a
  hex there and the check must notice. Mutate one and confirm it goes red.
- Adding a theme, a belt accent, a sport colour or a tile intent that fails
  contrast or CVD separation fails the build rather than shipping.

### The belt masthead

- Renders only for an athlete with BJJ enabled **and** a rank recorded.
  Otherwise: one quiet row inviting a first promotion. Never both, and never
  two `/bjj/standing` requests for one screen.
- The card's accent, its left edge and its wash all come from the athlete's own
  belt — not the app accent, and not the belt's literal colour (blue, purple,
  brown and black all measure under 3:1 against the card).
- **Stripes match the rank exactly**, 0–4 on a coloured belt and 0–6 degrees on
  a black belt's red bar. Check every count, since a belt that misstates a rank
  is the worst thing this screen can do.
- The belt renders without overlapping the disclosure control.
- The facts come from the *awarding* promotion, and each is omitted rather than
  shown empty.
- A promotion dated `2026-04-10` renders as 10 April in a UTC-negative zone —
  never the 9th.
## Library facet filters (mobile, `app/(tabs)/library.tsx` + `lib/exerciseFacets.ts`)

Four axes — position and belt for BJJ, muscle and movement for strength — each
a button that opens a picker rather than a row of pinned options.

### Happy path

- With the sport chip on **Strength**, a `Muscle` and a `Movement` button
  appear. Tapping one opens a sheet; choosing an option filters the list and
  the button now reads that option's name.
- `Movement → Push` returns both horizontal and vertical pressing — the point
  of the grouping is that "push" is not a value in the data.
- **`Movement → Pull` must contain biceps curls**, and `Push` must contain
  triceps and lateral-raise work. Those rows are `movement_pattern:
  "isolation"`, which is single-valued, so without a derivation they appear
  under neither — the filter looking broken to anyone who lifts. They appear
  under Isolation *as well*, which is intended.
- Leg, core and forearm isolation appears under **neither** Push nor Pull —
  there is no training convention to derive from — and must still be reachable
  through `Movement → Isolation` and through its muscle group.
- A non-isolation row must NOT get the derivation: a mobility drill whose
  primary muscle is biceps is not a pull.
- `Muscle → Chest` returns exercises whose **primary** muscles are chest-ish
  (chest, upper-chest, lower-chest, serratus) and NOT things that merely work
  chest secondarily, like a pull-up.
- Two facets combine: `Muscle → Legs` plus `Movement → Hinge` narrows further
  than either alone.
- With the sport chip on **BJJ**, `Position` and `Belt` appear instead, and
  behave as the old chip rows did.
- Choosing the "All" option in a sheet clears that axis, and the button returns
  to naming the axis.
- The sheet is a **bottom sheet, not a full-screen page**: it is sized to its
  options, the filtered list stays visible (dimmed) behind it, and tapping
  outside it closes it without changing the selection. Worth checking the
  option labels stay legible against whatever is behind — the translucency is
  tuned for a dense list, which is the worst case.
- The belt choice still persists across launches; the strength axes are session
  state and are not expected to.

### Edge cases & errors

- **With the sport chip on "All", no facet buttons appear** — no module is
  selected, so no facet list applies. Consistent with the old behaviour, and
  worth asserting so it is a decision rather than a surprise.
- A facet set on one sport must not filter the other's catalog: set
  `Muscle → Chest`, switch to BJJ, and the technique list must be unfiltered by
  it. (The state deliberately survives the switch; the guard is that the filter
  is applied only when the registry says the axis applies.)
- A combination matching nothing shows the "nothing matches this filter" empty
  state, not the "empty catalog" one.
- Search and a facet compose — searching within `Muscle → Back` searches only
  the filtered set.

### The mapping itself (unit-tested, `lib/__tests__/exerciseFacets.test.ts`)

- **Every `primary_muscles` value and every `movement_pattern` in the shipped
  catalog maps to a group.** This is the load-bearing one: an unmapped value is
  silently unreachable through the filter while still appearing in the list, so
  nothing looks broken. Adding a value to `exercises.json` without adding it to
  the map must fail this.
- Every group is reachable — no option that always answers "nothing matches".
- No raw value is claimed by two groups.


## The technique writing guide (`apps/admin` `/content/guide`)

Covers `apps/admin/src/app/content/guide/page.tsx` and the Description hint on
`TechniqueForm`.

### Happy path

- `/content/guide` renders for a signed-in admin, reachable from the techniques
  list and from the Description field's hint.
- Every example on the page shows the parser's **actual** output. This is the
  one page whose content is a claim about code: if `executionSteps` changes and
  the page does not, it is lying.

### The claims it makes, which are testable against `executionSteps`

Each of these is a real input/output pair and belongs in a unit test beside the
parser, not only on a page:

- `"Grip the far collar deep, step your lead foot across the hip, and fall back
  while pulling the elbow tight."` → three steps.
- One step per line, each ending in a full stop → three steps.
- `"1. Grip the far collar. 2. Step your foot across. 3. Fall back."` → the
  numerals become steps. Assert the broken shape explicitly, so a future fix to
  the parser fails this test and the page gets updated with it.
- `"- Grip\n- Step\n- Fall back"` → no steps.
- `"Break the grip, step in, and finish."` → **no steps**, because clauses under
  ten characters fold into the previous one. This is the one that fails
  silently and the reason the page exists.
- Fewer than two resulting steps → renders as a paragraph, never a one-item
  numbered list.

### Auth

- `/content(.*)` is in the `proxy.ts` matcher, so a signed-out visitor gets the
  sign-in prompt rather than the guide.
- A signed-in account not on `ADMIN_USER_IDS` gets "Not authorized". The guide
  is documentation, but it sits inside the console's gate like everything else.

## Searching the technique library (`searchTechniques` / `rankTechniques`, both apps)

Covers the reflection wizard's drilled-technique picker (mobile), the Library
tab (mobile + web) and the curriculum builder's catalog pane (web). All four
search the same 542-entry catalog through one pair of functions, duplicated per
app.

The defect these exist for: a beginners' closed-guard passing class could not be
logged at all, because search required the typed string to be a contiguous
substring of ONE field. The techniques were all present.

### Happy path — the spoken form of a technique finds it

- `arm bar` finds the armbars. The catalog spells it `Armbar`; the keyboard
  produces two words. **This returned zero results while `armbar` returned 21.**
- `break the guard` and `pass the guard` find the guard breaks and passes,
  despite no catalog name containing "the".
- `guard break` and `break guard` both work — term order does not matter.
- `kimura side control` finds `Kimura from Side Control` with no joiner typed.
- `armbar guard` finds `Armbar from Closed Guard` — the name supplies one term
  and the position the other, which no single field holds contiguously.
- The original fold cases still hold: `sao paulo`, `north-south pass` with the
  keyboard hyphen against the catalog's en dash, `mata leao` by alias.

### Ranking — what a capped picker shows

- Searching `side control` in the reflect picker (50 matches, 20 shown) surfaces
  side-control techniques, not closed-guard ones. **Before ranking the first 8
  were whichever the seed file listed first.**
- An exact name typed in full lands first: `Knee-Cut Pass` → `knee-cut-pass`.
- Every name match precedes every position-only match for `armbar`.
- Re-typing the same query does not reshuffle equal-scoring rows under a thumb
  already moving toward one.

### Edge cases & errors

- Empty query, whitespace-only, and a lone `-` (which folds to nothing) all
  return the whole catalog rather than nothing.
- A query of nothing but joiners (`to the`) returns a narrowed list, not all 542
  — the athlete typed something.
- `armbar zzzznotathing` returns **nothing**. A real term paired with nonsense
  must not fall back to the real term's hits; that is the difference between
  ANDing and ORing the terms.
- `knee belly` returns strictly fewer than `knee` — adding a word narrows.
- A single term cannot straddle two fields: the name glued to its own alias with
  no space finds nothing.
- Search still runs with no network. It is entirely local over a list already
  held, so a gym dead-spot does not break it — but see the known gap: the
  catalog is memory-only, so a cold launch offline has nothing to search.

### Ordering (regression-prone, invisible when broken)

- `searchTechniques` returns **in the caller's order**. Both Library screens
  merge its output against the exercise catalog with a linear merge of two
  name-sorted runs; ranking inside it corrupts that interleave into an unsorted
  jumble with no error anywhere. Worth a scenario because the visible symptom
  (a jumbled Library list) looks unrelated to search.
- `rankTechniques` returns the same SET, reordered. A technique findable in the
  Library must be findable in the picker.

### Cross-app parity

- The same query returns the same techniques in the same order on web and
  mobile. The two apps carry independent copies of the search; a stop word or
  weight changed in one and not the other diverges them silently.

### Not covered yet

- **Grips are unsearchable.** `cross sleeve` finds nothing — the summary payload
  carries no description, and no alias names a grip. Add scenarios when the
  library-content pass adds grip aliases.

## Keyboard handling (mobile, cross-cutting)

Not a feature with a route — a property every screen that takes typing has to
hold. It is listed here because it broke on twelve screens at once while each
screen's own scenarios passed, so it cannot be covered from inside any one of
them.

Three distinct failures, and a scenario that only exercises one will miss the
other two. Run each on the SMALLEST supported device (iPhone SE) — every one of
these is invisible on a large screen, and all three are invisible on the
Simulator with a hardware keyboard attached, because then the soft keyboard
never appears at all. Toggle it off first (`⌘K`).

### The focused field stays visible

- Tap any field → it sits clear of the keyboard, not flush against it.
- **Move focus between two same-height fields** (Weight → Reps → RIR on the
  session screen — all number pads). No keyboard event fires here, so the
  platform does nothing: this is the case the app's own handling exists for, and
  the only one that catches its removal.
- Expand a row *below* the fold while the keyboard is already up, then tap into
  it.
- On `sign-in`, `sign-up`, `forgot-password`: reach the submit button with the
  keyboard up. `sign-in` had no scrolling container at all, so this was
  impossible rather than awkward.

### Content below the fold stays reachable (the reported bug)

- Library: focus the search field, type a query with many matches, then **scroll
  to the last result**. It must be reachable. This is what "the keyboard covers
  the techniques and you don't see them all" meant — the field was fine, the
  results were trapped.
- Same on the reflection wizard's technique search, the session exercise picker,
  pinned records, saved workouts, and the workout editor's picker.
- Regression shape to watch: a list that pads for a tab bar but not for the
  keyboard looks correct with the keyboard down and loses its last rows with it
  up.

### Fixed footers and action bars stay above the keyboard

- Reflection wizard, **note step** (its whole content is a text field): the
  Next/Save button must stay visible and tappable while typing. It is the only
  control that finishes the wizard, and a content inset cannot reach it — it is
  a sibling of the scroll view, not inside it.

### Android-specific (fails silently on iOS-only assumptions)

- **Dismiss-on-drag must work.** `keyboardDismissMode="interactive"` is iOS-only
  and Android neither errors nor warns — it just never dismisses. Two auth
  screens shipped with exactly that.
- The focused field must lift. `automaticallyAdjustKeyboardInsets` is iOS-only,
  so nothing does this for free on Android.
- Content must NOT gain a keyboard-sized gap under it. Android `resize` already
  shrinks the window; anything that also pads by the keyboard height
  double-counts.

### Cross-app parity (web)

- New Workout dialog on a phone browser: focus Name, then reach **Goal** and the
  Create button. A `fixed inset-0` centred dialog sizes to the layout viewport,
  which iOS Safari does not shrink for the keyboard.
- Long forms on small viewports: nothing clipped, page still scrolls.

### Covered by the suite already

`components/__tests__/keyboardCoverage.test.ts` fails if a screen renders a
`<TextInput` without going through the shared containers — so a NEW screen that
forgets is caught without anyone writing a scenario for it. It proves the import
is present, not that the container wraps the input, so the manual passes above
are still what proves the behaviour.

## Capturing a sequence on the phone (reflection wizard, `lib/sequences.ts`)

The mobile half of sequences: tag a chain you already have, or capture the one
your class just taught. Building and refining stay on web.

**Every scenario here should be run with the network OFF at least once.** The
capture moment is a changing room after class, which is a dead-spot more often
than not — that is the whole reason this is offline-first, and an online-only
pass proves the least interesting half.

### Happy path — tag a chain you already have

- With at least one sequence, the drilled step shows a horizontal row of chain
  chips above the search box. Tapping one adds **every** technique in it as a
  `drilled` tag, in order.
- Techniques already tagged are not duplicated by tapping the chain.
- A chain with zero steps does not appear as a chip — there is nothing to add.
- Chips show step count, and `not synced` for anything still in the outbox.

### Happy path — capture what you just drilled

- With **two or more** drilled techniques, "Save these N as a sequence" appears.
  With one, it does not — one technique is not a chain, and the affordance is
  hidden rather than disabled.
- Naming it and saving writes to the phone immediately and the confirmation says
  **"Saved to this phone"**, never "synced". The row may sit in the outbox for
  hours; claiming otherwise is the reassurance that must not be false.
- The captured chain appears as a chip straight away, marked not-synced —
  including with the network off.
- Steps are stored in the order they were tagged. Reorder the drilled list and
  the captured order follows.

### Offline and sync

- Capture with airplane mode on, then restore signal: the chain uploads with
  the next sync and the not-synced marker clears.
- The pending count on the sync screen **includes** captures. A chain owed to
  the server must not report zero pending.
- A flaky connection that retries the same push must produce **one** sequence,
  not one per attempt — the id is generated on the phone for this reason.
- Capture, then edit the same chain on web, then let the phone push its original
  copy: **the web edit must survive.** A late retry must not revert it.
- Three captures with no network make **one** request, not three.
- A permanently-refused capture (400) stops being owed, keeps its error, and
  stays on the phone. Pending must reach zero — an outbox that never drains
  nags forever about something that can never go.
- A transient failure (5xx) stays owed and retries.

### Edge cases & errors

- A cold launch with no signal: the technique library is memory-only, so the
  search box is empty and says so. Chain chips still render from the outbox.
- A server fault (500) while listing must NOT read as "you have no sequences".
  Offline resolves to the outbox; a 500 surfaces.
- Signing out and in as a different athlete on the same phone shows **none** of
  the previous account's captures, and pushes none of them under the new token.
- Capturing with an empty name is refused (the Save control stays disabled).

### Not covered yet

- **No browse or detail screen on mobile.** Chains are reachable only from
  inside the reflection wizard; reading one back is unbuilt.
- A captured chain has no step destinations until someone opens it on web.
## Linked cross-references in the technique library (web + mobile)

`setup_from` and `common_next_moves` rows navigate where they name a real
technique. `common_counters` never does. **The platforms deliberately differ**
on next-moves — see below.

### Happy path

- Open a technique with a populated `Set up from`. Most rows are tappable
  (84% of references resolve); the rest are plain text with no affordance.
- Tapping a row opens that technique. Its own `Set up from` is then tappable
  too — the graph is walkable.
- A tappable row shows the **library's own name**, which can differ from the
  reference string when the reference used an alias or the other dash. Not a
  bug; verify it is not confusing.

### The platform difference (deliberate — check both)

- **Web**: `Common next moves` links, at ~31%. Web has no "Leads to" section,
  so this is its only forward-graph surface.
- **Mobile**: `Common next moves` does **not** link, and must not. The phone
  already shows a fully-linked "Leads to" above it, which promotes out exactly
  the rows that would resolve — leaving 17% linked and **295 of 505 screens
  with zero links in that section**. A section that occasionally links is the
  half-works feel this exists to avoid.
- **Both**: `Common counters` is never tappable (10% resolve).

### Edge cases

- A technique whose `setup_from` names only concepts ("Overhook", "Open guard
  entry") shows an all-prose block with no tappable row — correct, not broken.
- A reference naming the technique you are already on renders inert. A row that
  navigates to the screen you are on is a dead control that looks live.
- A reference written with the keyboard hyphen where the catalog stores an en
  dash (`North-South Control`) still resolves.
- Mobile: following a link **replaces** the current screen rather than pushing,
  so Back returns to the Library from any depth. Confirm that is what you want
  after three or four hops.
- Mobile: a technique with no `ibjjf_ruleset_id` must not inherit the previous
  one's legality table (in-place navigation reuses the screen).

### Accessibility

- Tappable and inert rows are distinguishable **without colour** — a real
  button/link role, a chevron, and a heavier weight than the prose rows.
- Linked rows meet the 44pt touch target; they must not be smaller than the
  inert rows beside them.
- The announced name matches the visible text (both are the library's name, not
  the raw reference).
- Web: following a link inside the panel remounts it — focus must land on the
  panel heading, not on `<body>`.

## Weekly training themes (`/v1/themes`)

One sentence per week about what the week is for. Authored on web, read on the
phone.

### The property that matters most

- **A theme carries no technique ids and no exercise ids.** There is no picker
  and no list — prose only. If one ever appears, the theme has become a second
  focus list and `/bjj/focus` now has a rival answer to "what am I working on".
  Assert the API rejects nothing of the sort because it accepts nothing of the
  sort: the payload is `{title, notes}`.

### Weeks

- `PUT /v1/themes/2026-08-03` (a Monday) → 200, and a second PUT to the same
  week **replaces** it rather than creating a second. One theme per week.
- `created_at` does not move when the wording changes; `updated_at` does.
- **`PUT` on a Tuesday → 400 saying a week must start on a Monday.** Without
  this, two "weeks" overlap and both claim the same days.
- A malformed date → 400, not a 500.
- `GET /v1/themes?from=…&to=…` → weeks in the window, oldest first. Both bounds
  required.
- `to` before `from` → 400.
- `DELETE` a week with no theme → **404, not 204.** A client should be able to
  tell "there was nothing" from "it is gone".

### Auth / security

- **Another athlete's week is 404 on GET and on DELETE**, and their theme must
  still be there afterwards. This is the cross-user check that has caught real
  bugs twice in this project — assert the owner's row survives, not just that
  the request failed.
- `List` never returns a row belonging to anybody else, even for a week both
  athletes have a theme in. A single-user fixture cannot see this.

### Web (authoring)

- The calendar shows a theme row above each week. A week with no theme reveals
  a "+ Theme" affordance on hover — **check it is discoverable**; this is the
  most likely thing to read well in code and fail in practice.
- Clearing the text and saving removes the theme. A week with an empty title is
  not a state the model has.
- Escape cancels without saving.

### Mobile (read-only)

- Today shows this week's theme above the week's numbers, and **nothing at all**
  when there is none — no "no theme set" row.
- **There is no way to author one on the phone**, deliberately. Planning is a
  desk activity.
- **Offline → no theme and no error.** It is deliberately not cached: a stale
  theme is worse than none, since it would describe a block the athlete has
  already moved on from.


## VOLA Workouts

Renamed twice — "Shared" → "Public Workout Plans" → **VOLA Workouts** — and
populated with 17 VOLA-authored plans seeded by `cmd/seed`.

**The rename is UI copy only.** `?scope=public` on the wire and the seeded ids
(`public-ppl-push`) are deliberately unchanged: the scope describes visibility
rather than branding, and the ids are the seeder's upsert keys — renaming them
would orphan every copy an athlete has made. Assert both still work.

### The tiles

- **VOLA Workouts** shows square tiles, two to a row, each with generated
  artwork. **Your own** workouts stay full-width rows with no artwork.
- Switching between the two tabs must not crash: `numColumns` cannot change on
  the fly in React Native, so the list is keyed on scope. **Toggle back and
  forth several times** — this is the failure mode that only appears on the
  second switch.
- A tile's artwork is the same on every launch, and the seeded set is not all
  one colour or all one angle.
- **The same plan looks the same on the phone and on the web.** Web holds its own
  copy of the palette; `planHero.test.ts` compares them, but a spot-check of one
  plan on both is worth doing after any palette change.
- **Scroll to the very bottom.** The seeded catalog is an odd count, so the last
  row holds one tile — it must stay half-width rather than stretch across the
  row, since `aspectRatio: 1` turns a stretched tile into a full-width banner.
- A **community-published** plan — one with an owner, rather than seeded — reads
  `Community · N exercises`; a VOLA-authored one shows the count alone. To
  produce one: publish a workout from a second account, then browse from the
  first.
- Counts read "1 exercise", not "1 exercises", on both the tile and the row card.
- With VoiceOver on, a tile announces its name, **goal**, exercise count and, if
  community, its provenance. The artwork is silent — it is decorative, and the
  goal it encodes as a glyph is exactly why the label has to carry the goal.
- Switching tabs shows a spinner: never the other tab's workouts laid out in
  this tab's shape, and never a momentary "No VOLA Workouts yet".

### The browse surface

- **Workouts → VOLA Workouts** lists the seeded plans as square tiles. Empty
  state reads "No VOLA Workouts yet".
- Opening one shows it read-only: *"A VOLA Workout — yours to copy, not to edit."*
- **Copy to my workouts** creates an owned copy and navigates to it. Editing the
  copy must not change the original; re-running the seed must not change the
  copy.
- On mobile, copying works **offline** — it writes locally and syncs like
  anything else.

### The seed, and the property that matters most

- `go run ./cmd/seed` twice → 16 plans, not 32. Idempotent.
- Every seeded plan is ownerless, `visibility='public'`, `source='seed'`.
- **A workout somebody owns must survive a deploy.** Plant a user-owned workout
  on a seeded id, re-run the seed, and assert the name, owner, visibility AND
  its items are untouched. The item-replace needs its own guard — without it the
  plan keeps its name and loses everything in it, which is the worse failure
  because it looks like the athlete's own mistake.
- The seed log reports rows **written**, so a skipped collision shows as 15
  rather than 16.

### The wire rename

- `GET /v1/workouts?scope=public` → the plans. `?scope=mine` → your own.
- **`?scope=shared` must still work**, returning the same as `public`. An
  installed mobile build sends the old word until it updates; rejecting it
  presents as an empty Workouts tab rather than as a rename.
- `?scope=nonsense` → 400.

### Artwork

- A plan's gradient is the same on every launch and every device. Restart the
  app and compare.
- The seeded plans are not all one colour — that is what makes the list
  scannable.
- No image assets are downloaded or bundled for this.


## Swapping an exercise

The rule the old one broke: suggestions must be about what the exercise
**trains**, not only what shape it is.

- **Swap a bench press** → the first tier offers other chest work, including
  exercises with a *different* movement pattern (a cable fly). The old ranking
  scored that zero.
- **Swap a leg press** → quad/glute work, not everything sharing the `squat`
  pattern.
- The second tier is **Similar movement** — same pattern, different muscle — and
  nothing appears in both tiers.
- **A heading names the full catalog below as "Everything else"**, and searching
  still reaches every exercise. Neither tier is a restriction; assert you can
  swap to something in neither.
- **Every row shows its equipment.** The usual reason to swap is that a piece of
  kit is occupied, and the one suggestion that cannot help is another movement
  needing the same bar. Note the ranking deliberately does *not* prefer or
  penalise matching equipment — only displays it.
- Ordering within a tier: same movement *and* same measurement first, then same
  movement, then same measurement, then alphabetical. Deterministic — the same
  swap must produce the same order every time.
- Each tier caps at 10 **independently**, so a well-covered muscle cannot crowd
  the other tier off the screen.
- Swapping still keeps the logged numbers when the measurement carries, and
  clears them when it does not ("measured differently" on the row).

### Cross-app parity (web)

- The same two tiers, in the same order, with the same headings on
  `/dashboard/sessions/[id]`.
- **The same exercise must produce the same suggestions on both apps.** Web
  holds its own copy of the ranking and the muscle taxonomy;
  `swapParity.test.ts` compares them, but a spot-check of one exercise on both
  is worth doing after any taxonomy change.


## Finishing a session: the celebration card (mobile)

Most of these check that something does NOT appear. That is the shape of the
risk — this screen fails by congratulating someone for nothing.

### When it appears, and when it must not

- **Log some sets, hold Finish** → the card appears with a flare burst and a
  success haptic.
- **Open a session, log nothing, hold Finish** → **no card.** The plain
  read-only screen. Marking "opened it and finished it" is hollow praise.
- **The card must never block.** Done is tappable from the first frame, while
  the flares are still moving. Nothing waits on the animation, and the sync was
  already requested before the card mounted.

### The badge

- **An ordinary session → NO badge.** The most important assertion here: a badge
  on every session is wallpaper.
- **A session that set a PR** → a badge naming how many, and a medal instead of
  the tick.
- Long sessions, lots of exercises, big tonnage → still no badge. They describe
  a training style, not an achievement.

### Personal records

- **Online, session set a PR** → the PR row appears, listing each exercise and
  which kind of record. It may arrive a moment after the card — that is
  expected, the card does not wait for the network.
- **Offline** → no PR row at all, and no error. Silence, not a guess.
- The PRs listed must be **this session's**. Log a PR in one session, finish a
  second unrelated session → the second card shows none.

### Objective vs subjective

- Time / sets / reps / volume sit together as measurements.
- **"How it felt" (RPE) is in its own captioned block**, never among them.
- **Turn effort tracking off in Settings, finish a session** → no "How it felt"
  block at all. Not "RPE 0". This is the case that distinguishes "not collected"
  from "recorded as nothing".
- A bodyweight session → **no Volume tile**, rather than "0 kg".

### BJJ

- Finishing a BJJ session shows the card with **Rounds and Mat time**, never
  sets or tonnage.
- **No badge and no PR row**, deliberately — there is no BJJ record equivalent
  yet. Assert their absence; a "you showed up" badge here would be the bug.
- `session_rpe` appears under "How it felt", not beside the measurements.

### Cross-app parity (web)

- Finishing on web shows a **static panel** of any records set — no modal, no
  flares. Deliberate: this screen is for typing up a session that already
  happened.
- **No panel when no records were set** — a "no records today" note would be the
  app rubbing it in.


## Hold to confirm (mobile)

Guards the actions a stray touch must not perform. The whole point is what does
NOT happen, so most of these are negative assertions.

### It must ignore anything short of a real hold

- **Tap Finish session** → nothing. This is the regression that matters: before
  this control, that exact gesture ended the session outright.
- **Hold and release just before the fill completes** → nothing.
- **Two abandoned half-holds in a row** → nothing. They must not accumulate.
- **Hold through** → finishes, once, with a success haptic. Keep holding well
  past the end → still once.
- **Start a hold, then navigate away mid-hold** → nothing fires.

### Where it applies, and where a dialog is still correct

- Held: **Finish session**, **Finish BJJ session**, **Delete session**
  (strength), **Delete workout**.
- Still a dialog, deliberately — each states a fact a button label cannot, and
  must NOT also require a hold: **removing an exercise** ("3 logged sets will be
  deleted too"), **deleting a BJJ session** ("removed everywhere, not just on
  this phone"), **removing a planned day** ("nothing you logged changes"),
  **sign out**.
- Assert no action asks for both.

### VoiceOver (the silent-failure case)

- **Turn VoiceOver on.** The button must still work: it becomes a tap that opens
  a confirm dialog. A hold-only control is not merely awkward there — VoiceOver's
  double-tap synthesises a press and an immediate release, so there is no
  sustained contact and the control is *unreachable* while still being
  announced and focusable.
- **The tap alone must not perform the action** — only the dialog's confirm
  button does. Otherwise the accessible path is a single tap on a destructive
  control, which is the thing being fixed.
- With VoiceOver off, the button announces a hint saying it wants a hold. A
  button that ignores taps and explains nothing is indistinguishable from a
  broken one.

### Feel (device only)

- 900ms should read as deliberate but not broken. Watch for someone letting go
  early on the first try — that means the fill is not legible enough.

### Cross-app parity (web)

- Web's Finish session now asks a `confirm()` — it had none. Deliberately not a
  hold: a mouse misclick is unlikely and press-and-hold is not a desktop idiom.
  Assert the confirmation exists, and that cancelling leaves the session open.


## Timed sets and the work countdown (mobile)

The session screen's one countdown now serves two purposes — resting between
sets, and performing a timed one. Rest and work share a single state, so the
first scenario to run is the one that proves they cannot both exist.

### Where the button appears (and where it must not)

- A **plank** (`load_type: 'time'`) → the row shows a timer button.
- A **barbell squat** (`weight_reps`) → no button. A countdown there would be a
  stopwatch pointed at nothing.
- **Reps-only** and **distance-only** exercises → no button.
- A **row/run** (`distance_time`) with no prescribed duration → **no button**.
  The prescription there is the distance; a default duration would invent a
  target the athlete never set. The same exercise WITH a duration on the set →
  button appears.
- A finished (read-only) session → no button on any row.
- The row whose countdown is currently running hides its own button, rather than
  offering a restart mid-hold.

### The duration comes from the plan

- Start a session from a template prescribing **3 sets × 60s** → each row's
  timer starts at 60 without anything being typed. This is the reported case.
- Add a set by hand after one holding 45s → the new row's timer offers 45
  (carried forward), not the 60s default.
- A `time` exercise with nothing prescribed anywhere → 60s default.
- A set whose `seconds` is 0 → treated as no duration, not a zero-length set. A
  timer that is over before it starts fires its completion haptic immediately
  and logs nothing meaningful.

### Running out vs stopping early (regression-prone — they differ deliberately)

- **Let it run to zero** → `seconds` is written, the set **ticks itself**, the
  completion haptic fires, and if "Auto rest timer" is on, rest starts straight
  away.
- **Stop at 40 of 60** → `seconds` records **40, not 60**, and the set is
  **left unticked**. Assert both halves: logging the prescribed 60 is the
  failure this exists to prevent, and auto-ticking would let an accidental Stop
  commit a two-second plank.
- **Stop immediately** → 0 seconds recorded, nothing ticked.
- Tapping **Done** on an already-finished countdown only dismisses the bar — it
  must not write the set a second time.

### One countdown, not two

- Start a work countdown while a rest is running → the rest ends, the bar shows
  the work countdown. Never two bars, never a bar showing the wrong one.
- Start a rest (or tick a set with auto-rest on) while a work countdown runs →
  same, the other way.
- The bar's copy follows the kind: a finished rest says "Rest done / Next set",
  a finished work set says "Set done / Logged". A bar reading "Rest done" over a
  plank is the failure.

### It must survive the phone being put down

The whole reason the model is a deadline rather than a tick:

- Start a 2-minute countdown, **background the app for the full duration**,
  come back → it reads 0:00 and has fired, not "1:47 left".
- Background it halfway → the remaining time reflects real elapsed time.
- **Pause, wait a minute, resume** → the same seconds are left as when it was
  paused. Time passing must not drain a paused countdown.
- ±15s while paused adjusts the frozen seconds; ±15s while running moves the
  deadline. Neither may let the progress bar exceed its track.

### Adjustment persistence differs by kind (easy to get backwards)

- ±15s on a **rest** → persists as that exercise's rest preference; the next
  rest for that exercise uses the new figure.
- ±15s on a **work** countdown → does **not** persist anywhere. Holding a plank
  longer today is not a new prescription, and it must not change how long you
  rest.

### The countdown must not outlive the rows it points at (found in review)

Positional `setIndex` with no stable set id — every one of these silently wrote
to the wrong row, or to a read-only session, before it was fixed:

- Start a plank countdown, then **swipe-delete a set above it** → the countdown
  cancels. It must never complete onto the row that shifted up.
- Same for **reordering exercises**, **removing an exercise group**, and
  **swapping the exercise** under a running countdown.
- Start a countdown and **Finish the session while it runs** → the countdown
  stops. A completion landing after the finish would write into a session
  already shown as read-only, and the sync would push it.
- Open an **already-finished** session → no countdown can be running or started.

### ±15 on a finished work countdown (found in review)

- Let a 60s plank run out, then tap **+15** on the "Set done" bar → the logged
  `seconds` must still be 60. It must not become 75, and completion must not
  fire a second time. Tap **−15** → still 60.
- The same taps on a finished **rest** bar are fine and should re-arm: rest
  records nothing, so chiming again costs a haptic.
- +15 on an expired countdown gives a genuine 15 seconds, not a deadline moved
  from a stale one (which leaves it expired and does visibly nothing).

### Timer sounds

Every one of these fails silently by design — `lib/sounds.ts` swallows its own
errors so a bell can never break the countdown — so these have to be *heard*,
not inferred from the absence of an error.

- **Rest ends** → a rising two-note chime. **A timed set ends** → a lower single
  bell. They must be **audibly different**: you hear them with the phone on a
  bench, and they mean opposite things (one says start moving, the other says
  stop).
- **The last three seconds** tick, once per second, softly. Not four times a
  second — the countdown's interval runs at 250ms, and a tick per pass is a fire
  alarm.
- **The second rest of a session must chime too.** A player left at the end of
  its buffer plays silently, so the failure looks like "sounds worked, then
  randomly stopped" rather than like a bug.
- **Mute, then force-quit and relaunch → still muted.** This shipped broken:
  `userId` is undefined on first render, so the module was initialised before
  the preference could be read and a muted athlete got sounds back every
  launch — with the Settings toggle still showing OFF, because it reads the
  pref directly. Check the toggle AND the actual noise, not just the toggle.
- **The replay check, in 60 seconds.** Run one countdown of at least 5s and
  listen to the final three ticks. Three ticks means the rewind works (the tick
  is one short player replayed three times); one tick then silence means it
  does not. Confirm with a second rest in the same session. This is the only
  way to settle the iOS `seekTo`/`play` ordering — `play` is synchronous JSI
  there and `seekTo` is async-dispatched, so source order is not native order.
- **A work countdown that has finished, then +15** → no ticks. Work never
  re-arms its completion, so ticking would count down to an ending that never
  comes.
- **Ringer switch OFF → it still rings.** Deliberate. Verify on a phone with the
  physical switch flipped.
- **Play music, then let a rest finish** → the music ducks and comes back. It
  must not stop, and the chime must not vanish underneath it.
- **Settings → Sounds off** → silence, and it survives a relaunch.
  Toggling it back ON previews the chime immediately.
- **No microphone permission prompt, ever.** If iOS asks for the microphone,
  `allowsRecording` has been set true somewhere.
- **The tick has to beat gym noise; the chime must not be piercing.** These pull
  opposite ways, and the levels sit 11 dB apart on purpose (tick −15 dBFS,
  rest-over −4). Verify with music playing, through the **phone speaker**, not
  on a desk in a quiet room — the first synthesis pass failed exactly here, at
  −23 dBFS and an octave too dark, and sounded lovely on headphones.
- **All four are regenerable, and none should be hand-edited.**
  `python3 scripts/generate_sounds.py --check` reports whether the checked-in
  `.m4a` files match what this machine's ffmpeg produces. A mismatch usually
  means a different ffmpeg build rather than a changed sound, so it is reported
  and never fatal — do not wire it into `verify` on the strength of one green
  run.

### Set feedback, and the record chime

The set feedback is a **haptic**, not a sound — verify it with the phone in
your hand and the ringer irrelevant. The record chime still has to be heard.

- **Ticking a set buzzes, and so does un-ticking.** Both directions, unlike the
  chime this replaced: a haptic is a receipt that the tap landed, not a verdict
  on it, and confirming a mis-tap correction is worth as much as confirming the
  tick. Tick, un-tick, tick → three buzzes.
- **It is a haptic in Settings' sense, not the app's.** There is no in-app
  preference, and muting Sounds must NOT silence it — they are unrelated
  channels now. **On iOS**, turning off System Haptics must silence it:
  `expo-haptics` uses `UISelectionFeedbackGenerator`, which the OS gates. Do
  **not** assert this on Android — the module calls `Vibrator.vibrate` directly
  rather than `performHapticFeedback`, so the system touch-feedback setting may
  not gate it, and behaviour varies by version and OEM. That is a property of
  `expo-haptics`, not of this screen, and every other haptic in the app already
  makes the same bet.
- **A timed set that runs out buzzes ONCE, not twice.** The countdown reaching
  zero ticks its own set, and it has already fired its own success haptic by
  then — so you must feel one buzz, not two. This is the collision the wiring
  avoids by staying out of `recordTimedSet`. Stopping a work timer early does
  not tick, so it produces neither.
- **Twenty sets is twenty buzzes, and that is the point.** Log a full session:
  it should read as tactile confirmation, not as a phone going off. The sound
  that used to do this job was pulled for exactly this reason, so if the haptic
  wears too, the answer is removing it rather than making it softer.
- **A session that sets a PR plays two sounds, in sequence, never together.**
  The card opens with the session chime, then the PR chime lands about a second
  later as the record rows animate in. If they fire simultaneously the delay has
  regressed.
- **A session that sets no record plays one sound.** No PR chime.
- **Finish a session offline that WOULD have been a PR → session chime only.**
  Records need the network, `summary.records` is correctly empty, and silence is
  the honest answer: the phone cannot know it beat anything, and a chime fired
  on a guess would celebrate something the records screen may then contradict.
- **The PR chime fires once.** Leave the card open long enough for any refetch;
  it must not chime twice.
- **The streak chime, and it never doubles with the PR.** Finish the FIRST
  session of a week that sets no record → session chime, then the streak chime
  about a second later, and "N weeks in a row" on the card. Finish a first
  session of the week that DOES set a record → session chime, then the PR
  chime, and **no streak chime** — one celebratory sound per session, and the
  PR outranks it.
- **The second session of the same week is silent beyond the session chime.**
  The card still shows the streak line; only the first session of a week
  carries it. If you hear it on a Thursday, the rule has drifted to firing on
  every session.
- **A BJJ session opens the week too.** Finish the first BJJ session of a week
  → streak chime and the line, exactly as a strength session gives. The streak
  is sport-agnostic, so if the mat is silent and the barbell is not, the BJJ
  card has lost its props.
- **A stray Thursday chime is not automatically a bug.** A session STARTED
  offline mid-week and synced at finish can race its own row to the server; the
  week then counts one session and this one is told it carried the streak.
  Narrow and known. Reproduce it before treating it as the rule drifting.
- **Finish a session offline → no streak chime and no streak line.** History is
  online-only, and the week's count cannot include a finish the server has not
  seen. Same honest silence as the PR row beside it, and the same cost: a
  session logged in a dead spot loses its chime.
- **A PR can legitimately produce neither row nor chime, and it is not this
  wiring's bug.** Finishing online kicks off the sync and then fetches records
  more or less immediately; if the server has not ingested the finish yet, the
  card shows no record and so plays no chime. The chime reads the same state as
  the rows, so the two can never disagree — if you see a record row and hear
  nothing, that IS a regression, but seeing neither is the pre-existing fetch
  race and reproduces without any sound involved.

### The waiting-for-you chime

**This is not a push notification and must not be tested as one.** There is no
push system — no `expo-notifications`, no token, no APNs. This fires in-app,
on the YOU tab, when a focus refetch finds MORE waiting than the last count it
saw. Close the app and nothing happens, by construction.

- **Cold launch with requests already waiting → silence.** Every launch. The
  first count of a process has nothing to compare against, and a chime there
  would announce old requests as new on every single open.
- **Have someone send you a request while the app is open, then return to the
  YOU tab → one chime.** This is the whole feature. Focus is the trigger, so
  it lands when you look, not when it arrives.
- **Focus the tab again without anything changing → silence.** The common path
  by a wide margin, and the one that decides whether this is a cue or a
  nuisance.
- **Answer a request so the count falls → silence.** Rises only.
- **Go offline, focus the tab, come back online, focus again → silence.** The
  count endpoint is online-only and a failed fetch must leave the last-seen
  number untouched. If a blip makes it chime, the failure path is writing 0
  and then "rising" back — the bug this is guarding against.
- **Both sources, and only this tab.** Friend requests and shares each chime,
  because the YOU badge now shows both — the chime follows the badge, so a
  sound never announces something the screen cannot then show you.
- **A share arriving while you answer a friend request still chimes.** Totals
  are unchanged across that swap; the rule compares each source separately, so
  it must fire. If it does not, the implementation has drifted to comparing
  sums and the swap is silently invisible.
- **Muting Sounds silences it** — it goes through `playSound` like every
  other sound.

### The confirmation chime

Fires on four deliberate, once-per-action moments, all of which had **no
feedback at all** before — no haptic, no toast, only a row quietly changing.

- **Share a workout to a friend → chime.** Tap a second time and the server
  409s ("already in their inbox"); that chimes too, because the outcome is
  identical and the UI already renders it identically. A silent second tap
  reads as the press having missed.
- **A send that really fails → silence,** with the error on screen. A
  confirmation that also plays on failure is not a confirmation.
- **Accept a shared workout → chime.** Accepting navigates away, so the chime
  is the only feedback that survives the transition; a row vanishing reads as
  much like a failure as a success.
- **Send a friend request, accept a friend request → chime.**
- **Decline a request, cancel your own, unfriend someone → SILENCE.** All three
  run through the same helper as accepting and all three call `removeFriend`,
  so anything that confirms "the action succeeded" rather than an explicit
  opt-in will chime on them. **If unfriending someone makes a happy noise, that
  is the bug this scenario exists for.**
- **Saving is never confirmed.** Sets, BJJ detail and workout items all
  autosave continuously while you edit; a chime there would fire dozens of
  times a session. Finishing and deleting already buzz via `HoldToConfirm`.

### Known limitation, not a bug

- **Background the app mid-countdown → no chime.** iOS throttles the JS the
  sounds are driven from. The countdown itself is still correct when you come
  back (it is deadline-driven); only the sound is missed. A chime with the app
  closed needs a scheduled local notification, which does not exist yet.


### Cross-app parity (web)

- Web gets **no countdown** — deliberate, per the platform rule. Assert only
  that the prescribed duration is still visible and editable: the workout editor
  offers a seconds target for a `time` exercise, and the session screen asks for
  seconds when logging one.

## Session share card (`GET /v1/sessions/{id}/card`, mobile Share)

### The numbers

- Finish a 60-minute strength session at 80 kg bodyweight → calories land near
  **185**, not 400–600. A figure double that means gross is being reported
  instead of net.
- Remove the bodyweight check-in → calories are **absent**, and the card asks
  for one rather than assuming 70 kg.
- Weight is read **as at the session**: a check-in recorded after it must not
  change an old card's estimate.
- Score is absent below 8 prior sessions of that sport. With 10 easy priors and
  one much bigger session, the big one scores 100 — anything less means it is
  ranking against itself.
- Effort tracking off → `basis: "volume"`, and the number still appears.
- **Run the card tests at more than one time of day, or force the zone.** The
  bodyweight lookup once resolved the session's day through the machine's local
  timezone, so a session ending just after UTC midnight missed a same-day
  weigh-in and the calories vanished. It passed for seventeen hours a day. The
  day is computed in UTC now; a test that only ever runs in UTC cannot tell.

### One 404 for every miss

Somebody else's session, an id that never existed, and a session still running
must be indistinguishable. An unfinished session has no duration, so every
number would describe something still happening.

### Sharing

- Finish a session (strength or BJJ) → Share renders a card and opens the OS
  share sheet with Instagram among the targets.
- **The captured image must not be blank.** The card is mounted off-screen
  rather than hidden, because `display:none` captures nothing and `opacity:0`
  captures blank on some iOS versions — both fail silently.
- Cancelling the share sheet is silent, not an error.
- The same session always renders the same mountain, on the completion screen
  and in the exported image. Different sessions should visibly differ — if
  every card shows the same peak, the hash is clustering.
- Share is absent, not disabled, when there is no session id.

## Rate limiting (platform — every authenticated endpoint)

### The limit exists

- Burst through the default budget on any authenticated route → **429** with
  a `Retry-After` header and code `rate_limited`.
- **Obeying `Retry-After` exactly must succeed.** Wait the advertised seconds
  and retry; a second 429 means the header rounds down and is lying.
- Waiting less than advertised still fails.
- One athlete exhausting their budget must not affect another's. Test with two
  accounts, not one — an IP-keyed limiter passes a single-account test and
  throttles a whole gym in production.

### The limits that protect people

- `POST /v1/friends/requests` and `POST /v1/shares` are an order of magnitude
  tighter than the default. Burst through each and confirm the OTHER is
  unaffected (separate buckets), and that ordinary reads still work.
- Re-requesting after a decline is still possible but now bounded — that was
  the residual this closes.

### What must NOT break

- **A mobile sync burst.** The outbox pushes one request per pending row with
  no batching or cap. Log a long offline session, sync, and confirm every row
  lands. If some are throttled they must stay pending and drain on the next
  sync — `429` is in the client's `RETRYABLE_4XX`, so it must never be treated
  as a permanent rejection that drops the row.
- Polling `/v1/notifications` on every navigation must not trip the default.

### Security

- **An invalid or missing token must not spend anybody's budget.** Fire junk
  bearer tokens naming a victim; their real requests must be unaffected. A
  limiter charged before verification is a denial-of-service against a named
  account delivered through the anti-abuse mechanism.
- The 429 body must not say which limit was hit.
- The limiter fails OPEN when it cannot identify a caller, never closed.

## Notifications (`GET /v1/notifications`, nav badge + You-tab badge)

### What counts

- A friend request received → `friend_requests` is 1; the SENDER's count stays
  0 (an outgoing request is pending and is not waiting on you).
- A share received → `shares` is 1 for the recipient, 0 for the sender.
- Answering — accept OR decline — clears it. There is no read flag, so this is
  the only thing that can, which is what makes the number impossible to
  desync.
- An accepted friendship / accepted share stops counting.

### The answers it must never give

- A source that cannot be counted fails the WHOLE request (500), rather than
  reporting that source as 0. A zero means "nothing is waiting for you"; it
  must never mean "could not check".
- A key present at zero and a key absent are different things: zero is
  "nothing waiting", absent is "this build has no such source". Assert zeros
  are serialised rather than omitted.
- Empty registry → `{}`, never `null`.

### Clients badge only what they can act on

The rule is that a badge must point at a screen that can answer it. A number
you cannot open is a dead end.

- Web badges **Sharing** (the share inbox) and, since `/dashboard/friends`
  exists, **Friends** too. It used to badge only Sharing on the grounds that
  friend requests were answered on the phone and web had no screen for them —
  that reason is gone, so the rule is satisfied rather than waived.
- Mobile badges **Friends** and, now that `app/shared/` exists, **Sharing** too.
  The gap recorded when the counts first shipped — a mobile-only athlete never
  learning a share arrived — is closed; both numbers open something.
- A failed count leaves the previous number alone — it must not zero, since
  zero renders no badge and thereby asserts nothing is waiting. **Test this
  with a non-zero previous value**: from a cold start both behaviours render
  nothing, so the honest one and the wrong one look identical. Get a badge
  showing, go offline, leave the tab and come back — the number must still be
  there.
- A count that really does drop to zero DOES clear the badge. Without this the
  rule above is satisfied by a badge that can never go out.
- On mobile both badges sit on their rows under **People**, not in the header.
  At 100 or more the badge reads `99+`, and the row's spoken label says "over
  99 waiting" — "99+" is not a phrase, and a bare number beside a label is
  meaningless to hear.
- Web refetches on route change, not on a timer.

## The You tab's header and rows (mobile)

The header carries the screen name, the wordmark and the sync chip — **and no
controls**. Edit, Friends, Settings and Sharing are rows in the body.

- **The wordmark is visible and unobstructed on all four tabs.** It is centred
  absolutely, so anything competing for the row lands on top of it rather than
  pushing it aside. Check Today, Plan, Library and You.
- **Check it with the sync chip showing as well as hidden** — go offline, or
  log something and watch the pending count. The chip is half of the original
  bug: it used to be placed in the row's interior whenever a third element was
  present, which is why the fault came and went.
- **Check at 375pt (iPhone SE) and at Accessibility Large.** These are text
  labels, so they grow with the system setting; the header must still either
  fit the wordmark or drop it cleanly, never overlap it. Changing text size and
  returning to the app has to re-decide — the widths are measured, not read
  from a snapshot taken at launch.
- The four destinations all open: Friends, Sharing, Edit profile, Settings.
- With a pending friend request AND a pending share, both rows badge at once.

## Social — the friends' feed (`GET /v1/feed`, mobile `app/social/`)

**MOBILE ONLY.** There is no web feed and there should not be one. Web sees
shared content and manages friends; posts and feeds are a phone thing.

**This is the first athlete-to-athlete read of training data in the system**, so
most of what is worth testing is what must NOT appear.

### The three conditions, tested one at a time

A finished session reaches your feed only if its owner is an accepted friend,
has opted in, and the session is finished. Break each separately:

- A **stranger's** session never appears — and test this while you have at
  least one friend, or the client short-circuits before the query runs and the
  filter is never exercised.
- A **pending** friend request grants nothing. Send one, do not accept it.
- A friend who has **never opted in** is invisible. This is the default, and it
  is what "opt-in" means: accepting a friend request must not publish anything.
- An **in-progress** session does not appear; the same session does once
  finished.
- **Your own** sessions are not in your own feed — that is the Today tab.

### The privacy switch (Settings → Privacy)

- Off by default on every account, including existing ones.
- **Turning it OFF retracts everything, immediately** — including sessions a
  friend could see a moment ago. Have a friend watching their feed, switch off,
  refresh: gone. This is the property the whole design is built around.
- **Turning it ON is retroactive** — friends see finished sessions from before
  the switch. The hint text says so; check it still does.
- The switch is server state, not a local preference: with no signal, flipping
  it must revert and say so rather than appearing to have worked.
- On a **brand-new account with no profile saved yet** the switch is usable and
  reads off — not permanently greyed. (It was greyed, silently, and a dimmed
  privacy control reads as "off" whether it is or not.)

### The feed itself

- A failed load says so. It must NEVER render as "Nothing here yet" — that is a
  claim about other people's training invented from a failed request.
- An empty feed with no friends reads differently from an empty feed with
  friends who have not shared.
- Rows carry who, what, how long ago, and the measures. **Volume respects the
  athlete's unit system** — an imperial reader sees pounds, not kilograms.
- A measure is omitted rather than zeroed: a BJJ session shows no set count and
  no volume, because sets are not how that discipline is measured.
- "Show older" pages without duplicating or skipping rows.
- With VoiceOver, each row is ONE stop reading who, what, the measures and when
   — not four separate stops per card.
- Nothing is cached: the feed is other people's data, and a stale one is a
  claim that gets less true every hour.

### You → Social

- The row is labelled **Social** and opens the feed; friend management is a tap
  further, through the pane at the top.
- The friend-request badge still rides on that row.

### The feed shows the card

The feed row IS the session card — the same component the athlete saw when they
finished, at a different size. What follows is about the three numbers it must
NOT show, which is the part a well-meaning change would undo.

- A friend's card carries **no calorie figure**. It is computed from their
  bodyweight, height, age and sex; publishing it publishes an inference about
  their body.
- A friend's card carries **no VOLA Score**. It is a percentile against their
  own last twenty sessions, so it means nothing beside a history the reader
  cannot see.
- A friend's card carries **no PR badge**, even for a session that set one. The
  feed row does not carry records, and inferring one is the card claiming
  something the server never said.
- The strip is time, sets and volume — the three things a feed row has always
  carried — and volume reads in the READER's units, not the owner's.
- The top-right label is "2h ago", not a date. Your own card records a day; a
  feed is scanned for recency.
- The card's foot shows the wordmark, not `@handle` — the attribution is the
  strip above it, and printing the person twice per post is the bug this
  prevents.
- With VoiceOver the whole post is ONE stop, including the detail lines. The
  card itself must contribute nothing: if it is not hidden from the reader,
  every post is read twice.

### Sharing the detail — `share_training_details`

Two switches, and the second one only ever narrows what the first allows.

- Default is **off** for every existing and new profile. Nobody's programme
  becomes readable because they installed an update.
- Friend has sharing ON and details OFF → their sessions appear with the
  numbers and **no exercise or technique names**.
- Turn details ON → the same rows gain up to five names. Turn it off again →
  the names disappear from rows that were already visible, immediately. It is
  read live; a stamped-at-finish implementation passes the first half and fails
  this one.
- With the master switch OFF, the detail switch changes nothing at all — no
  rows, so nothing to add to. The settings toggle is **dimmed** in that state
  rather than hidden, and says why.
- **One friend's switch does not speak for another.** With two friends, one
  opted into detail and one not, a single page must show names for exactly one
  of them. A page-level read of the flag is the likely regression.
- A BJJ row never shows a **`conceded`** outcome, however it was logged — and
  it must not be counted into the "+N more" line either, which would publish
  that something happened while declining to name it. Your own card still shows
  it.
- More than five exercises → five lines and "+N more", with N counting the rest.
  The cap is applied server-side; a client that receives the whole list has
  already been sent what it should not have.
- The response's `detail` is an empty ARRAY when the owner opted out, never
  absent and never null — "hidden" and "an empty session" must render
  identically, or the UI advertises who has the switch off.

### Auth and scope

- Details never widen who can see a session. A stranger, a pending request and
  an unfinished session are all still invisible regardless of either switch.
- `PATCH /v1/profile` omitting `share_training_details` leaves it unchanged — an
  older client cannot publish anything by omission.

### Performance (the plan, not the result)

- **A friend with years of history does not slow the feed.** Seed one friend
  ~4000 finished sessions, all but a handful outside the 3-day window, then
  read the feed. The rows returned are the only observable at the API layer
  and they are correct either way — so the assertion has to be on the query
  plan: `sessions_user_ended_idx` chosen, and `ended_at` appearing under
  `Index Cond`, never under `Filter`. Covered by
  `feed.TestTheWindowIsASeekNotASift`; listed here because the same trap
  applies to any future window query (`sessioncard`'s neighbour lookups use
  the same shape) and a functional suite that only checks rows cannot see it.
- **The count and the list agree under load.** `visibleFrom` is shared by both
  for this reason; a total that promises rows the list will not return is the
  regression to watch when either query is edited.

## Sharing (`/v1/shares`, both clients' Share control + Sharing screens)

Two kinds are shareable: **sequences** and **workouts**. Everything in this
section that says "sequence" should be run for a workout too — the module is
generic, so a bug in one kind is usually a bug in the registration of the other,
not in the share module.

### Happy path

- A opens a sequence → Share → picks friend B → B's `/dashboard/shared` shows
  it, labelled with A's handle and the sequence name.
- B accepts → lands on **B's own copy**, with every step and note, in order.
- The copy is INDEPENDENT: A renames, reorders, then deletes the original; B's
  copy is unchanged and still there.
- Same round trip for a **workout**, and check the TARGETS survive: sets, reps,
  weight, seconds, distance and per-item notes, in order. A copy that carries
  only the exercise ids is a list of movements rather than a plan, and every
  field is separately omittable from the copy.

### Friends only, and one 404 for every miss

All of these must be indistinguishable 404s:
- share to a stranger; to someone with a request still pending; to a handle
  that does not exist;
- share a resource id that is not real; share another athlete's sequence id.

### One copy, ever

- Accept twice → second is 404, and exactly one copy exists (assert the count,
  not the status).
- Sender accepts their own share → 404. An outsider accepts → 404, and the row
  is untouched.
- Two concurrent accepts of the same share → one copy.

### Lifecycle

- Duplicate pending share → 409. After the recipient accepts, re-sharing the
  same thing **succeeds** (that is how an updated version is sent).
- Decline deletes; re-sharing afterwards works. The sender can also cancel.
- Sender deletes the resource, then recipient accepts → **410**, the share is
  cleared from the inbox, and no copy is created.
- Unknown `resource_type` → 400, rejected before the handle is resolved.

### The sent list (`GET /v1/shares/sent`)

- After sharing, the sender's "Waiting on them" shows the row, labelled with
  the RECIPIENT's handle (not their own — the mirror of the inbox is the thing
  a copied query gets wrong).
- The recipient does NOT see it in their own sent list; an outsider sees
  nothing. Assert the errors, not just the lengths — the zero value is an
  empty list, so an ignored error passes by failing.
- **Accepted and declined must look identical to the sender**: share to two
  friends, one accepts and one declines, and the sender's list goes empty
  either way. Assert the accept really copied, so the test cannot pass because
  nothing worked.
- Cancel from the sent card: the id on the card is the one DELETE takes, it
  leaves the recipient's inbox too, and the same thing can then be re-sent.
- **The sender must not be able to tell an accept from a decline through ANY
  channel.** Walk them all with two shares, one accepted and one declined:
  `DELETE` (404 for both — the sender may only delete a PENDING share, or this
  endpoint is a perfect oracle), `accept` as the sender, both lists, and
  re-sharing. Assert the accepted row still EXISTS after the sender's refused
  delete, so the test cannot pass by the row being erased.
- The RECIPIENT keeps full control: they may clear an accepted row, which is
  the half the asymmetry must not break.
- Web: both lists load in ONE round trip; the copy says rows disappear once
  answered and that the app does not say which way.

### Sharing a workout specifically

- **A shared VOLA Workout must arrive private and unmarked.** Share one of the
  seeded plans, accept it, then check the recipient's copy in the database:
  `source = 'user'` and `visibility = 'private'`. The first fails LOUDLY if
  wrong (the CHECK rejects an owned seeded row, so the accept 500s); the second
  fails silently, and its symptom is the recipient's private copy appearing on
  the VOLA Workouts shelf for every athlete on the platform.
- The original is untouched by all of it: still ownerless, still public, still
  seeded, and still refreshed by the next `cmd/seed` run.
- The copy gets a NEW id. Ids here are client-supplied, so reusing the sender's
  would collide — and would make the recipient's plan answer to the sender's
  offline sync retries.
- **Revoke between send and accept:** C publishes a plan, A passes it on, C makes
  it private again, B accepts → **410**, and B has no copy. Authorization
  happened when the share was sent; this is the check at the moment of copying.
- Accept a shared workout, then start a session from the copy — it must behave
  like any owned template (editable, deletable, startable).

### Web surfaces

- Share panel: friends load on OPEN, not on mount; `null` vs `[]` distinguished
  so a failed load never reads as "you have no friends"; Escape closes it.
- Share is offered on a sequence the athlete can READ but not edit (VOLA
  content) — visibility, not ownership. **Same on a workout**, where it sits
  outside the same `canEdit` gate that hides Save and Delete.
- **Share is disabled while a workout has unsaved edits**, with the reason
  visible — sharing sends the SAVED version, the same trap "Start session" is
  disabled for. Edit, do not save, and confirm the button explains itself
  rather than just going grey.
- Inbox: accepting navigates to the copy's own URL; a failed accept refreshes
  rather than leaving a button that can only fail again. A shared **workout**
  lands on `/dashboard/workouts/<new id>`.
- "Shared with you" is ungated in the nav even for an athlete with no BJJ
  module enabled — what arrives is decided by other people.

### Mobile surfaces (`app/shared/`, You → Sharing)

- The **round trip works phone-to-phone**: A shares from a plan's screen, B
  opens You → Sharing, accepts, and lands on their own copy. This is the reason
  the screen exists — the social graph lives on the phone, so a send path
  without a receive path was a message into a room nobody could open.
- **Share is refused on a plan the server does not have, and says SYNC not
  SAVE.** Build a template in airplane mode and open it: the button is disabled
  and the reason names syncing. Telling someone to save what they already saved
  is the wrong advice, and the two states are easy to collapse because an
  offline row is *both* unsynced and owed.
- Edit a synced plan without saving → the reason changes to "Save your changes
  first". Save → the button becomes usable.
- An accepted plan appears in the Workouts tab without a manual pull — the copy
  was made server-side, so this device has never heard of it until a sync.
- Both lists are online-only: with no signal, they say so rather than showing an
  empty inbox. "Nothing waiting" is a claim about other people's actions, and
  making it from a failed request is inventing the absence of a message.
- Accept, then background and reopen: the row does not come back.

## Friends (`/v1/friends`, mobile Friends screen + web `/dashboard/friends`)

### Happy path

- A searches B's exact handle → card → Add friend → B's inbox shows @A;
  A's "waiting on" shows @B.
- B accepts → both friends lists show the other; both pending lists drain.
- Renaming a handle updates every inbox and list it appears in (cards join
  live — no stored copies).

### The pair is one row

- A→B pending, then B tries to add A → **409**, same message as a duplicate.
  No state may exist where both sit in each other's inboxes.
- Already friends → the same 409 on a new request.

### One 404 for every miss (all pinned to exact errors)

- Sender accepts their own request → 404, indistinguishable from "no request".
- An outsider accepts/removes a pair they are not in → 404, and the pair is
  untouched (assert the row, not just the status).
- Request to a nonexistent handle → 404.

### Rules

- No claimed username → 400 telling you to claim one first.
- Self-request → 400.
- Decline deletes: re-requesting afterwards succeeds (the moderation residual
  is recorded, not hidden).
- DELETE covers decline / cancel / unfriend; unfriending is symmetric.

### Mobile screen (online-only by design)

- Airplane mode: every action surfaces the offline copy; nothing queues.
- Failed load leaves lists as loading-state, never as "no friends".
- Search 404 copy teaches exact-match ("handles are exact").
- A result already in any list shows "already in your lists", not Add.
- Remove is two-step in place, announced via live region.

### Web screen (`/dashboard/friends`)

Same four sections in the same order as mobile, and deliberately the same copy
— two screens that word the same refusal differently teach an athlete that one
of them is lying. So run the mobile list above here too, and then:

- **The route is auth-gated.** Signed out, `/dashboard/friends` redirects to
  sign-in like every other `/dashboard` route.
- **The nav badges it**, and the count is incoming-only — something you SENT
  must never raise a badge on a screen where the only thing you can do is
  cancel it.
- **A result card while the lists are still loading offers no Add button.** It
  says "Checking…". Offering Add to somebody already asked earns a 409 for a
  tap the screen knew would fail — search for an existing friend on a slow
  connection and watch what the card does before the lists land.
- The card distinguishes **already your friend** / **they have asked you** /
  **you have already asked** rather than collapsing them into one "linked".
- **Case does not matter**: searching `RHONDA` when `rhonda` is already a
  friend must not offer Add.
- Remove is two-step in place and **announces** — a label swapping on an
  already-focused button is silent to a screen reader otherwise. Clicking away
  (blur) abandons the confirmation rather than leaving it armed.
- Accept / Decline / Cancel are labelled per row: "Accept" repeated down a list
  is indistinguishable when navigating by buttons.
- A failed load renders as the error, never as "Nobody yet".
- **The share panel no longer sends you to your phone.** `ShareToFriend`'s
  empty state links to `/dashboard/friends`; check it does, since that string
  was true for as long as web could use the social graph without building one.

## Username lookup (`GET /v1/users/{username}`)

Exact-match handle resolution — the first athlete-to-athlete read. No client
surface yet; API-level scenarios.

### Happy path

- Look up a claimed handle → 200 with exactly `{username, display_name}`.
- `display_name` is null when the athlete never set one — not absent, not "".
- Case-normalised: `/v1/users/DMYTRO` finds `dmytro`.

### The serialization boundary (the test that matters)

- The response body contains EXACTLY two keys. `user_id`, `date_of_birth`,
  `sex`, `unit_system`, `track_effort` must never appear — assert on raw JSON
  keys, not on a decoded struct, or a type swap passes unseen.

### One 404 for every kind of nothing

- Absent handle → 404. Malformed (`1abc`, `Dmytro!`) → the same 404. Reserved
  (`admin`) → the same 404. Impersonation-shaped (`vola_official`) → the same
  404. All four must be indistinguishable in status, code and message.

### Auth

- Unauthenticated → 401. Lookup is deliberately signed-in-only.

### The shape rule (claim-time, `PATCH /v1/profile`)

- `vola_official`, `official_vola`, `admin2`, `vola_1`, `dmytro_support` →
  400 at claim time.
- `modest`, `supporter`, `systemic`, `adminton_fan` → claimable; the rule is
  whole-segment, never substring.

## Usernames (`PATCH /v1/profile`, mobile profile editor)

The unique claimable handle. Backend + mobile field only — nothing consumes it
yet.

### Happy path

- Claim a free handle → 200, `username` returned on every subsequent
  `GET /v1/profile`.
- Rename → old handle immediately claimable by another account.
- Re-submitting your own current handle → 200, idempotent, not a 409.
- PATCHing unrelated fields leaves the username untouched (nil = unchanged).

### Uniqueness

- A handle held by another account → **409 `already_exists`**, message names
  the fact ("that username is taken") — distinct from the create-time 409.
- **Case variants collide**: if `dmytro` is taken, `DMYTRO` must 409 — and via
  the repository directly (bypassing handler validation), which is what proves
  the `lower()` index rather than the Go format rule.

### Format & reserved (all 400)

- Under 3 / over 30 chars, uppercase, leading digit or underscore, whitespace,
  hyphens, unicode.
- Reserved words: `admin`, `vola`, `me`, `settings`, … — the 400 message states
  the format rule, not which reserved word matched.

### Mobile editor

- The field never fights the keyboard: no auto-capitalisation, input lowercased
  on save.
- An empty username box omits the key — saving must NOT clear a claimed handle.
- A 409 lands in the form's error banner with the server's message.
- The first-run (no profile yet) path still works with the field present.

## Sequences (`/v1/sequences`)

A sequence is a chain: what a class taught, in the order it flows. Backend only
so far — no client renders one yet, so these are API-level scenarios.

### Happy path — recording the class that motivated the feature

- Create with `start_position_id` = closed-guard and four steps (standing break,
  knee cut ending at side control, side control to knee-on-belly, armbar).
  Read it back: `step_count` is 4, `order` runs 0..3, and `name`, `position`,
  `category` and `function` on each step come from the **library**, not the
  request.
- Rename a technique in the catalog and re-read the sequence — the new name
  shows. Library fields are resolved on read, never stored on the step.
- A step with no `ends_at_position_id` reads back as `null`, not `""`. A client
  rendering `""` as a position called "" is the failure this prevents.
- `GET /v1/sequences` omits `steps` and includes `step_count`. Creating fifty
  sequences must not make the list carry every step of every one.

### Ordering — the content, not a presentation detail

- `order` is assigned server-side from array position. A client sending its own
  ordinals cannot collide with `UNIQUE (sequence_id, sort_order)`.
- Replace a 4-step chain with 1 step: the survivor is at `order` 0, re-indexed.
  Leaving it at its old ordinal collides on the next write and renders a gap.
- Reorder the steps and read back — the new order persists exactly.

### The omitted / null / empty distinction (regression-prone)

- `PATCH` with **no** `steps` key leaves the chain untouched. This is the one a
  client loses silently, and it wipes an athlete's work.
- `PATCH` with `steps: []` **clears** it.
- `PATCH` with **no** `start_position_id` key leaves it; `start_position_id:
  null` **clears** it. A single nullable field cannot express both.

### Edge cases & errors

- 21 steps → 400. The cap is 20.
- A step with an empty or unknown `technique_id` → 400 (`invalid_input`), never
  a raw SQL or constraint message.
- An unknown `ends_at_position_id` → 400.
- A sequence with no name → 400. A name is all a list row can render.
- A **repeated technique in one chain is legal** — sweep, get passed, sweep
  again. Unlike curriculum items, this must NOT be rejected.
- Notes over 1000 chars, name over 120, description over 2000 → 400.
- A body larger than 256 KB → 413, before any parsing.
- Deleting a sequence deletes its steps (no orphans left in
  `bjj_sequence_steps`).
- **A pruned position must not delete the chain.** Remove a position from
  `positions.json` and re-seed: sequences referencing it survive with the id
  nulled, both on the sequence's start and on any step. Both FKs are
  `ON DELETE SET NULL` for this reason, and `UpsertPositions` genuinely prunes.

### Auth / security

- Every endpoint requires auth → 401 unauthenticated.
- `GET /v1/sequences/{id}` for **another user's** sequence returns **404**, and
  it must be indistinguishable from a `{id}` that never existed. A 403 here
  would confirm that a guessed id is real — the ID-enumeration shape review has
  already caught twice in this codebase.
- `GET /v1/sequences` never includes another user's rows.
- `PATCH` and `DELETE` by a non-owner fail **and leave the sequence unmodified**.
  Assert the second part — an error response alone does not prove nothing was
  written.
- A VOLA-authored (ownerless) sequence is readable by everyone with
  `editable: false`, and writing to it returns 403. That is the only
  visible-but-unowned case, which is what makes 403 safe here.
- The response must never carry `owner_user_id`. `editable` is the only
  ownership signal a client gets, so no client is ever tempted to compare user
  ids itself.

### Not covered yet

- **Sharing.** No share endpoint exists here by design — it is a generic
  `/v1/shares` surface over every ownable resource, and it needs usernames
  first. Add scenarios with that module.

## Curricula and roadmaps (`/v1/curricula`)

Seven routes over four tables (curricula, phases, items, enrollments), and no
screen on any of the three apps yet — so every scenario below is an API-level
one until a client exists.

Two properties decide how these read. A curriculum is an ordered set of
techniques, and one whose items carry completion criteria is a **roadmap** — the
criteria are nullable per ITEM, so that is a property of a row and not of the
curriculum. And **mastery is derived from `bjj_session_tags` on every read**:
there is no column that could store it, no endpoint that could set it, and every
threshold is measured **since the athlete enrolled**. That makes two of the
scenarios here look like defects to whoever runs them first, which is exactly why
they are written down.

### Building one (happy path)

- `POST` with a name and no items → `201`, `visibility: private`,
  `editable: true`, `enrolled: false`. An empty list is legal — a curriculum is
  named before it is filled.
- **Items come back in the order they were sent**, and `sort_order` is dense from
  zero. Assert with a list that is neither alphabetical nor id-order: for a
  syllabus the sequence IS the content, and an `ORDER BY technique_id` passes
  every other scenario here.
- An item with no targets is **reading**: `criteria` null, `progress` null
  forever. An item with a volume target is a roadmap step.
- **One curriculum may hold both**, and progress counts only the criteria-bearing
  items — ten items of which three carry criteria is three items' worth of
  progress, not three tenths. Assert the MIXED curriculum; the two pure cases
  pass under either rule, so they prove nothing about which one was picked.
- A curriculum where **nothing** carries criteria has no progress at all. Not 0%,
  which reads as failure, and not 100%, which claims something. The assertion is
  the absence of a number, not a number.
- `PATCH` without `items` leaves the list alone; `[]` empties it; a list replaces
  it wholesale. Three distinct states, and the middle one is what a plain slice
  collapses — a metadata-only edit that silently deletes every item satisfies
  every other bullet in this section.
- `GET /v1/curricula` omits `items`; `GET` on one includes them. A dozen
  syllabuses of a dozen techniques on the list response is the N+1 in its lazy
  form.
- The list order is own rows first, then enrolled, then belt, then name, and it
  is **total** — a curriculum id breaks the tie. Two identically-named public
  rows that can swap between requests flap the ETag body hash for no reason.
- `belt` is a hint for ordering and never a gate: a white belt may author, read
  and enroll in a black-belt curriculum, and nothing refuses it. The server also
  does not sort belts white-to-black — that ranking belongs to the client, which
  knows the athlete's own rank.

### Enrolling, archiving, picking it back up

- `PUT .../enrollment` → `204`, and the curriculum now reads `enrolled: true`
  with `started_on` today.
- `PUT` twice → `204` both times, never `409`. A retry after a dropped response
  has to converge, and picking something back up is not an error.
- **Re-enrolling keeps the ORIGINAL `started_on`.** Backdate an enrollment,
  archive it, enroll again, assert the old date survived. This is the property
  the idempotent upsert exists for: resetting the date discards everything the
  athlete did the first time and silently reopens the measurement window. A
  delete-then-insert implementation passes every other scenario in this section
  and fails only this one — the same shape that already bit `bjj_focus`.
- `DELETE .../enrollment` archives rather than deletes: `enrolled` goes false,
  the row survives, and re-enrolling proves it did. **Archived does not mean
  completed** — archive a roadmap two items short of done, pick it back up, and
  the progress is still there.
- Archiving when not enrolled → `404`, not a cheerful `204`. "I put this down"
  and "nothing happened" are different answers, and collapsing them hides a
  client bug.
- **Deleting your own curriculum while enrolled in it must work.** Create →
  enroll → change your mind → `204`. The `ON DELETE RESTRICT` counts the
  caller's own enrollment too, so before the handler dropped it first this
  refused with "other athletes are working this" when nobody else was — an error
  that was not merely unhelpful but false.

### The window: evidence before enrolling does not count

The subtlest behaviour here and the one most likely to be filed as a bug. An
athlete who has drilled a technique for years starts at zero on enrolling, and
that is the design: over all time the hit rate includes the months during which
they could not do the technique, and a belt syllabus is mostly techniques they
have been failing at.

- Seed an athlete with 40 `scored` armbars over two years, enroll them today,
  read the curriculum: **`scored: 0`**. Then log one more and it reads `1`.
- The boundary is the **session's `started_at`**, not the tag's `created_at`. A
  class logged three days late still happened when it happened — backdate a
  session to the day before enrollment, write its tags today, and it must not
  count.
- A session started **on** `started_on` counts. The comparison is `>=`, and an
  off-by-one here silently discards the athlete's first day.
- Not enrolled → criteria are visible, **`progress` is null**. Browsing a
  syllabus shows what it asks of you; working one shows how far along you are.
  There is no window to measure an un-enrolled reader over, so a zero-filled
  progress block would be a lie about a measurement nobody took.
- Re-enrolling spans the gap: enroll, log evidence, archive for two months,
  re-enroll — the old evidence still counts, because the window never moved.
  Deliberate, and the reason a screen rendering "12 weeks in" has to say that
  some of them were spent away.

### Mastery needs all four, and can be lost

- All four criteria met → `mastered: true`; any single one short → false. Four
  cases, or one case with four mutations — and the mutation is the point, since
  a `Met` that ignores a criterion passes the all-met case.
- **Identical volume with a worse hit rate does NOT master.** Two athletes at 25
  scored, 8 defended, 12 sessions: one from 60 attempts (0.42), the other from
  100 (0.25). Only the first is mastered. This is the criterion that earns the
  word — drop `min_hit_rate` and every other bullet here still passes, which is
  precisely why it needs its own scenario.
- Volume is `SUM(count)`, never `COUNT(*)`. "Hit three armbars" is ONE row with
  `count: 3`, so a row-counting implementation reports a third of the truth for
  anyone who logs the natural way. Seed multi-count rows, not fifteen ones.
- **Drilled never satisfies `target_sessions`.** Twelve drilling classes and
  nothing live → `sessions: 0`. The requirement exists to stop one big open mat
  carrying an item; letting drills count would master a technique that has never
  been used on someone resisting.
- `target_sessions` counts DISTINCT live sessions: fifteen scores in one night is
  `sessions: 1`, which is the whole point of the criterion.
- Zero attempts → `hit_rate` null, not `0`. Zero-from-zero is not a rate, and 0%
  reports a failure the athlete has not had. Null must not clear a rate bar
  either.
- **Mastery can be LOST, and this is the scenario nobody thinks to write.**
  Because it is derived rather than stored, master an item and then keep logging
  misses until the rate falls under 0.35: it reads `mastered: false` on the next
  GET, with no write to the curriculum at all. Deleting the sessions that
  supported it does the same — the claim withdraws itself. A stored flag passes
  every other scenario in this document and fails only here.
- **Defence-only items are legal and must complete.** `target_defended` with no
  `target_scored` — "don't get caught in the guard pull N times" — is the
  requirement that justified adding the `defended` event at all. Assert it
  masters on defensive evidence alone, with zero scores logged.
- `min_hit_rate` without `target_scored` → `400`. A rate divides the offensive
  attempt count, so on a defence-only item it would gate on an unrelated number.
- `target_sessions` or `min_hit_rate` with neither volume target → `400`. A
  criterion is anchored on volume or it is not a criterion.

### Edge cases & errors (writes)

- `POST` with no name → `400`. `PATCH` with `"name": ""` → `400`; `PATCH`
  without a name leaves the existing one.
- `visibility` outside `private`/`public` → `400`, and the message names the two
  legal values.
- **The same technique twice in one list → `400`**, and the error says which.
  Two rows would derive their own progress from the same evidence and the item
  would complete twice. The unique constraint catches it, but a constraint name
  is not a usable error at item 34 of 60.
- An unknown technique id → `400`, never `500`, **and the whole write rolls
  back**. A partly-applied list leaves the athlete holding a curriculum they did
  not author; on create, no curriculum row may survive at all.
- 150 items accepted, 151 refused; 20 phases accepted, 21 refused.
- Zero or negative targets → `400`. `min_hit_rate` of `0` or above `1` → `400`;
  `1.0` is accepted and means every attempt lands.
- A body over 64 KB is refused rather than read. An authenticated user is still a
  stranger, and an unbounded decode of an item array is a memory exhaustion the
  auth check does nothing about.
- The list is capped at 200, and the cap matters here more than on a self-scoped
  list because this response spans **every** user's public curricula — one
  prolific author grows everybody else's payload. Assert that a cap applies, not
  the number.
- Deleting a technique from the library removes it from every curriculum
  silently (`ON DELETE CASCADE`), with no error anywhere. Nothing deletes
  techniques today; assert the current behaviour so that the day a prune lands —
  positions already have one — the consequence is visible rather than
  discovered.

### Phases, concept items, tracks, and the drilled criterion (2026-08-10)

The structure a real syllabus has. A phase is a named, described section; a
`concept` item is authored text (a principle, a graduation standard) with no
library pointer; `track` is the browse-section hint; and
`target_drilled_sessions` is the one criterion practice counts toward.

- **Phases and items round-trip together.** Create with two phases and items
  pointing at them by index → the read returns `phases` ordered with dense
  `order` from zero, and each item's `phase` index intact. A flat create (no
  phases) still works — every pre-existing curriculum is unphased and legal.
- An item whose `phase` index is out of range — negative, past the end, or any
  index when no phases were sent — → `400`. The stale-index case (items kept,
  `phases` forgotten) is the one a client actually hits.
- An untitled phase → `400`.
- **A metadata-only PATCH leaves phases alone.** Rename a curriculum without
  sending `items`: phases and item-phase assignments survive. Phases are
  content, and they travel with `items` — sending `items` without `phases`
  replaces the structure with none (flat), which is the documented contract,
  not a bug.
- Sending `phases` WITHOUT `items` → `400`, not a silent no-op. The phases
  would otherwise be thrown away with a `200`, which is a client bug nobody
  gets to see.
- **A concept item is text and nothing else.** `kind: concept` needs a `title`,
  refuses `technique_id`, and refuses every criterion field with `400` — no
  evidence stream could measure one, and nothing here is completable by hand.
  A technique item carrying its own `title` → `400` (its name is the
  library's).
- **A concept never counts toward progress.** A curriculum of one concept and
  one criteria-bearing technique has `countable_items: 1`. A concepts-only
  curriculum has no progress at all — the same absence-of-a-number assertion
  as the reading list.
- Concept items come back with `kind: "concept"`, their `title`, empty
  library fields, and no `technique_id` — and technique items still read
  exactly as they did before the kinds existed (`kind: "technique"`,
  no `title`), which is the backward-compatibility claim.
- **`target_drilled_sessions` counts SPREAD, not volume.** One class with
  `drilled, count: 40` → `drilled_sessions: 1`, not mastered against a target
  of 3; three separate classes → mastered. The volume-satisfies-it
  implementation passes every other drilled scenario, which is why the
  one-big-class case is the assertion.
- Drilled spread never leaks into the LIVE session spread: those three drilled
  classes leave `sessions: 0`, so `target_sessions` still cannot be satisfied
  by practice.
- A drilled-only criterion is legal (the movement-fundamentals case) and
  completes on drilled evidence alone. But `min_hit_rate` anchored only on a
  drilled target → `400` — a rate still divides the offensive attempt count.
- `drilled_sessions` appears in every progress block, even where no criterion
  reads it — a client may show practice alongside live use.
- **`track` copies `belt`'s PATCH semantics exactly**: omitted leaves it,
  explicit `null` clears it, and it never gates anything. The four seeded
  belt syllabuses read `track: "belt"`.

### Auth / security

- **A private curriculum belonging to someone else is invisible four ways**, and
  each needs its own assertion: absent from `GET /v1/curricula`, `404` on `GET`,
  `404` on `PATCH`, `404` on `DELETE`. A `403` anywhere on that list confirms the
  id exists.
- **And `404` on `PUT .../enrollment`** — which looks like a fifth copy of the
  same test and is not. Without the visibility check inside the INSERT, enrolling
  in a guessed id succeeds, and the following `GET` then passes its own check
  *because the caller is now enrolled*. Enrollment would be a read oracle for a
  stranger's private list.
- A **public** curriculum the caller does not own is readable (`200`,
  `editable: false`) and refuses writes with `403`, not `404`. Deliberately
  different from the private case: they can already read the row, so a `404`
  would disguise a permission problem as a missing one.
- **A VOLA-authored (ownerless) curriculum is nobody's to edit, however public.**
  `PATCH` and `DELETE` → `403` for every athlete. Ownership is
  `owner_user_id = caller`, not "not somebody else's" — an implementation that
  treats NULL as unowned hands every user the syllabus.
- **One athlete's evidence never reaches another's progress.** Two athletes
  enrolled in the same public roadmap, one logs everything: the other still reads
  zeros. This is the cross-user shape already caught twice in other modules, and
  the per-caller window makes it easy to reintroduce.
- Deleting a curriculum other athletes are working → `409` (not `403`: the caller
  is allowed to do this and the state says no). Assert the refusal **and** that
  the caller's own enrollment is intact afterwards — the delete drops it first
  inside the transaction, so a rollback that does not fire loses it on every
  refused attempt.
- Unauthenticated on all seven routes → `401`.
- **`owner_user_id` is never in a response.** `editable` answers the only
  question a client has, and shipping the owner id is what produces client-side
  authorization one refactor later.

### The web client (`/dashboard/curricula`)

Four routes: the list, the detail, and a two-pane builder shared by `new` and
`edit`. All of the API scenarios above still apply — these are the ones that can
only fail in the browser.

- **The denominator is `countable_items`, not the number of rows.** Build a
  ten-item curriculum where three carry criteria, master one, and the card must
  read 1 of 3 — never 1 of 10. This is the single most likely place for the two
  clients to disagree, which is why the API sends the count at all.
- **A criteria-free curriculum shows no progress bar**, and says it is a reading
  list. A 0% bar is the wrong answer: it reports failure at something that was
  never asked.
- **Mine vs Shared splits on `editable`, not `enrolled`.** A seeded belt
  syllabus you are working belongs under Shared — putting it under Mine promises
  an Edit button that 403s.
- **The Edit button appears only when `editable`.** Never decided by comparing
  user ids in the browser; the server resolves it.
- **Un-enrolled detail shows criteria and no progress.** Browsing a syllabus
  shows what it asks of you; working one shows how far along you are. Zero-filled
  progress for a non-participant is wrong, not merely ugly.
- **The hit rate renders `—` and not `0%` when there are no attempts.** The API
  sends null precisely so the client cannot report a failure the athlete has not
  had; coercing it back to a number undoes that.
- **The progress block states the window and the reversibility.** Both are
  surprising and correct, and a screen that omits them will have the window
  filed as a bug — an athlete who has drilled something for years sees zero on
  the day they enrol.
- **Editing loads before the builder mounts.** The builder seeds its state in
  `useState` initialisers, which run once, so mounting it against an
  unresolved curriculum leaves every field empty — and saving then wipes the
  curriculum. Worth an explicit test: open Edit on a slow connection and save.
- **Adding a technique adds it as reading**, with no criteria, and the criteria
  button is per row. Defaulting every addition to a roadmap step puts four
  numbers in front of someone who wanted a list.
- **Clearing the offensive target leaves a defence-only criterion**, which is
  legal and is the case that justified recording `defended` at all. Clearing
  both makes the row reading again.
- **An empty belt select sends `null` and clears the belt**, distinct from
  leaving the field alone. This is the only path that exercises the API's
  explicit-null handling.

Phases, concepts and tracks on the web client (2026-08-10):

- **The detail page groups items by phase**, phase title and description
  rendered above each group, unphased items FIRST — a mixed curriculum's
  unassigned items are the ones the author forgot, and burying them at the
  bottom is how they vanish from attention. A flat curriculum renders as one
  ungrouped list with no phase chrome at all.
- **An item pointing at a phase the response does not carry falls back to
  unphased rather than disappearing** — the FK makes it impossible today, and
  the guard is for the day a bug ships one. Covered by a unit test over
  `groupByPhase`; the E2E assertion is just that every item in the response
  appears somewhere on the page.
- **A concept renders as text** — title and body, no position, no category, no
  criteria block, no "something to study" footer — and never shows in the
  focus panel's proposal. Unit-covered in `roadmapFocus.test.ts`; assert the
  rendering here.
- **The drilled criterion renders as "Classes drilled"** with the same bar
  treatment as the live counters, reading `drilled_sessions` from progress.
- **Deleting a phase in the builder un-assigns its items and renumbers the
  rest** — build three phases with an item in each, delete the middle one,
  save, reload: the first and third phases' items are still theirs, the middle
  one's item is unphased. A stale index here silently files an item under the
  wrong section, which no error will ever surface.
- **Reordering phases carries their items with them** — swap two phases, save,
  reload, and each item is still in the phase the author put it in.
- **A concept with an empty title blocks the save client-side with a message
  naming the problem** — the server's whole-content 400 cannot say which row
  was the untitled concept.
- **Saving a curriculum that has phases sends them WITH the items; deleting
  the last phase saves a flat curriculum** (the wire's `items`-without-`phases`
  spelling), not a 400.
- **The Shared tab groups by track** — Belt roadmaps, then Foundations, then
  other athletes' published lists — and a section with nothing in it does not
  render its heading. The Mine tab stays flat: your own lists are yours to
  recognise by name.
- **Cards say "N items", not "N techniques"** — `item_count` counts concepts
  too.
- **Reordering and removing survive a save**, and order is the content of a
  syllabus rather than decoration.
- **Deleting a curriculum other athletes are working shows the API's own 409
  message** rather than a generic failure — the reason ("their enrollment is
  their record") is the useful part.


### Copy properties the schema dictates

Two copy properties belong to whichever screen lands first, and both come from
the schema rather than from taste:

- It must say **"your record shows"**, never "you have earned". Mastery is a
  statement about the record now, and a long enough bad run takes it back.
- Elapsed time on a re-enrolled roadmap has to name the gap, because
  `started_on` spans the months the athlete was away.


### The seeded belt syllabuses

- **`cmd/seed` is idempotent.** Run it twice: four curricula, 56 items, no
  duplicates. The stable ids in `curricula.json` are what make this an upsert.
- **Re-seeding after editing a syllabus keeps every enrollment**, because
  enrollment references the curriculum id and items are replaced beneath it.
  Enrol, reseed, and confirm you are still enrolled with the same `started_on`.
- **Re-seeding cannot destroy progress.** Log evidence against a syllabus
  technique, reseed, and the progress is unchanged — it lives in
  `bjj_session_tags` and is recomputed.
- **The seed refuses an unknown technique id** rather than writing a syllabus
  that points at nothing. Break one id in the JSON and confirm the seed fails
  naming that id and that curriculum.
- **A seeded syllabus cannot be edited or deleted by any athlete** — it is
  ownerless, so `editable` is false for everyone and writes 403.
- **The seed only ever touches `source = 'seed'` rows.** Author a curriculum in
  the admin console (when that exists) with a colliding id and confirm a deploy
  does not overwrite it.
- **Brown is mostly defence-only**, which is the case no other syllabus
  exercises: six items with `target_scored` null. Confirm they render, count
  toward `countable_items`, and can be completed with `defended` evidence alone.



### Roadmaps on Today and You

- **Today shows the roadmap as context, never as advice.** It says what is next
  in the syllabus order and how far along you are; it must not phrase itself as
  a recommendation, and it must not replace or compete with the suggestion card.
  The two are allowed to disagree — one is a plan, the other reads the evidence.
- **Today's roadmap line is hidden while a session is unfinished**, because the
  resume card replaces the whole Upcoming block. Worth deciding deliberately
  rather than discovering: a resume card is an action, the roadmap line is
  context.
- **Only on today.** Stepping the day switcher must hide it — a roadmap is not a
  fact about the Thursday you stepped to.
- **You shows mastered across roadmaps and the current focus chips**, and says
  the numbers can move both ways. It renders NOTHING for an athlete on no
  roadmap with no focus — a strength-only account must never see an empty BJJ
  block.
- **`/v1/curricula/working` excludes archived enrollments** and carries real
  `mastered_items`, unlike the list response where it is zero.

### Roadmaps on the phone

- **The Plan tab's Roadmaps strip shows belt syllabuses with their covers**, and
  the count is `countable_items` — how many have criteria — never the item count.
- **Tapping one opens the roadmap**, which shows TARGETS when browsing and
  PROGRESS when enrolled. Zero-filled progress for a non-participant is wrong.
- **"Put these in my focus" writes the focus list**, and the panel then says it
  already matches. Those techniques must then appear as one-tap chips in the
  reflection wizard — the only scenario that spans both halves of the loop.
- **Evicting hand-set focus asks first.** `PUT /v1/bjj/focus` replaces wholesale,
  so with five techniques already held and a roadmap wanting three, the athlete
  is asked before three of theirs go.
- **The hit rate shows `—`, not `0%`**, before any attempt.
- **`started_on` must not be in the future**, and evidence logged that same
  evening must count. Enrol at 22:00 from a zone behind UTC: the progress block
  must read today's local date, and a session logged an hour later must move the
  numbers. Both halves broke independently — the stored date and the window
  comparison — so fixing one and testing only that would look like a pass.
- **An unknown `tz` is a 400, never a silent fallback to UTC.** A silent
  fallback is precisely the bug the parameter exists to prevent. `tz=Local` is
  also rejected: to Go it means the server's zone.
- **The strip fails silently** when the endpoint is unreachable — it renders
  nothing rather than an error. Deliberate; test that an offline Plan tab still
  shows its templates.

The round map (2026-08-18):

- **`GET /v1/techniques/positions` carries `round_map`** beside `positions`, and
  the two are one fetch on purpose. Assert both are present; a client holding a
  map from one version and a glossary from another is the failure the single
  response prevents.
- **Every node's `position_id` is in the same response's `positions`**, and every
  node's `position` matches at least one technique in `GET /v1/techniques`. Both
  are covered by Go tests against the embedded catalogs, so the API-level check
  is a smoke test rather than the guarantee.
- **The API refuses to boot on a broken map** rather than serving a glossary
  without one. Hard to exercise from a functional suite; recorded because the
  alternative (a degraded response) would look identical to a feature that has
  not shipped.
- **Web `/dashboard/library/map`**: the diagram draws with `route` arrows only.
  Toggling "Getting out" and "Losing ground" adds theirs; each toggle reports
  its own count, so nothing is silently missing. Selecting a box opens the
  panel with the glossary's description and priorities, and dims every edge not
  touching it.
- **The page never scrolls sideways.** The diagram is wider than a narrow
  window and must scroll inside its own container. Check at 1024px and below.
- **Every position also appears as text below the diagram**, best to worst. Not
  a fallback for the SVG — this is reference material and should be readable
  without clicking sixteen boxes.
- **Mobile `/bjj/roundmap` is a ladder, not the diagram**, best at the top, with
  a band heading opening each of the three bands exactly once. Tapping a row
  expands its note, its edges as words, and the library link; the expanded state
  must be announced (`accessibilityState`), since collapsed and expanded sound
  identical otherwise.
- **Do not confuse it with `/bjj/positions`**, which is the athlete's own
  heatmap computed from their logs. Same word, different screens: assert the
  titles ("How a round goes" against the position map's own).
- **A node links to the POSITION, not to a filtered grid, and the number on the
  link must equal the number at the destination.** Web `?position=side-control`
  opens the library's position panel; mobile opens `/position/side-control`.
  Both resolve with `techniquesInPosition`, and the link says "· N techniques" —
  assert the two agree, since the first version counted a narrower sided set and
  led somewhere listing nearly twice as many.
- **A position id must never be sent to the position CHIPS.** They are keyed on
  family ("Mount", "Side Control"), so a glossary id filters the grid to zero
  with no chip looking active — not even "All positions". Regression test: the
  map's links carry `position=<glossary id>` and the grid stays unfiltered.
- **An unknown position id reports itself** rather than opening an empty panel —
  the same path a stale bookmark already took.
- **Both sides of a position share one link.** "Mount" and "Under mount" both
  read about `mount`, so both counts are the family's. That is the glossary
  describing a position for both players, not a duplicate.
Syllabuses on the phone (2026-08-18):

- **The Library's BJJ reference block shows four belt cards**, white → brown, in
  rank order not alphabetical, each with its entry count. Tapping one opens that
  curriculum.
- **They must NOT appear on the Plan tab's Roadmaps strip.** That strip is what
  you are working; assert it still shows five cards (foundations + four belts).
- **An athlete's own public curriculum on the syllabus track does not appear
  there.** Both `track` and `belt` are athlete-writable, so create one wearing
  both and assert only VOLA content shows.
- **The block degrades silently.** With the curricula endpoint failing, the map
  link and position cards must still render and no error banner appears — the
  Library's job is the catalog.
- **An 85-item syllabus opens without a visible pause.** The screen is a plain
  ScrollView and this is double the largest roadmap; worth timing on the oldest
  supported device, since nothing has measured it.

The drawn map's geometry (2026-08-18):

- **No arrow crosses a box it does not connect.** Covered by a unit test over the
  real content, which is the only practical way — it found six on the shipped
  version. An E2E equivalent would be a screenshot diff; the unit test is
  cheaper and names the offending edge.
- **The default view leaves no box without arrows.** Open the map cold: the four
  positions in the "you are behind" band must each have at least one edge. They
  had none when the default was route-only.
- **Toggling "Losing ground" on adds the dashed red edges and nothing else
  moves.** The boxes must not shift — layout is independent of which kinds are
  drawn.
- **The diagram scrolls inside its own container at narrow widths** and the page
  never scrolls sideways. The canvas grew by a routing gutter each side, so this
  is worth re-checking at 1024px and below.

The reference syllabuses (2026-08-18):

- **A syllabus draws no progress anywhere.** `countable_items` is 0 on all four,
  so the roadmap header, the progress card and the "N to master" line on the card
  must all be absent — not zeroed. A "0 of 0 mastered" anywhere is the bug.
- **The enrol button says "Keep this handy", not "Start working this"**, on any
  curriculum with no criteria — which includes an athlete's own list, not just
  these. Enrolment still works and still records `started_on`; it is a bookmark.
- **The web list groups them under "Reference syllabuses", after Belt roadmaps
  and Foundations.** Assert the section ORDER: somebody scanning for something to
  work should meet the roadmaps first.
- **A bookmarked syllabus must not appear on Today or the You tab.** This is the
  one review caught: `/v1/curricula/working` returned every enrolment, and
  `RoadmapLine` reads a null next step as "Every technique on this one is done",
  so bookmarking one put a false completion claim on the front screen over "0 of
  0 mastered". Enrol a criteria-free list — a syllabus OR your own reading list,
  both reproduce it — and assert it appears on neither surface while remaining
  enrolled and readable on the curricula list.
- **The mobile focus panel stays hidden on a bookmarked list.** Without the
  `isRoadmap` gate it claims "Nothing left to work on this one."
- **They must NOT appear on the mobile Plan strip.** They carry a belt, so a
  filter keyed on `belt` lets them through; the strip is keyed on `track`.
  Regression test: the strip shows five cards (foundations + four belts), never
  nine.
- **Every technique id resolves.** Covered by a Go test against the embedded
  catalogs, so an API-level check is a smoke test — but a syllabus rendering a row
  with an empty name is the visible symptom if it ever regresses.
- **A criterion must never appear on a syllabus item.** Guarded in Go from both
  directions (syllabuses have none, roadmaps have some). Worth an API-level
  assertion too, since it is the one property separating the two artifacts.
- **Opening a 73-item syllabus is not slow.** It is the largest single-curriculum
  read in the app by some margin; check the detail request and first paint.

The map and the progression (2026-08-17):

- **White belt's second phase is the map, and it moves no number.** `The map:
  how a round goes` holds four concepts and zero techniques, so adding it must
  leave `countable_items` and the step numbering exactly where they were.
  Regression check: the roadmap card's "N of M" and the last technique's step
  number, before and after. A concept-only phase that shifts either is the bug.
- **Every roadmap opens with a placement concept** — the first item of the first
  phase on all five. Titled `Where this belt sits` on the four belts and
  **`Where this sits` on the foundations track**, which is not a belt; a test
  asserting one literal string across all five fails on foundations. It is a
  concept either way, so it draws as text with no step disc, no criteria chrome
  and no progress row.
- **The four belt titles read as a progression** — learn the map, build reliable
  systems, connect the game, master your game — and are in RANK order, which is
  the client's job: the API sorts `c.belt` alphabetically on purpose (blue,
  brown, purple, white) because `belt` is unconstrained TEXT. Both clients
  re-sort (`beltRank` on web, `rankOf` on the Plan strip). Assert the order on
  both, and note the two ways it legitimately breaks: **an enrolled roadmap
  sorts to the front on both clients**, so the four are only adjacent while none
  or all are enrolled; and the two clients disagree about foundations —
  **mobile puts it before the belts, web puts it after** (a section under its
  own heading). Neither is a bug; a test written against one client's order
  fails on the other.
- **Belt descriptions lead with "Goal:"** and are not truncated on the phone at
  the smallest supported width — they got longer, and the roadmap header is
  where a clipped first line costs the most.

Phases, concepts and foundations on the phone (2026-08-10):

- **The roadmap screen groups items by phase**, phase title and description
  above each group, unphased items first (labelled "Unassigned" only on a
  MIXED curriculum; a flat one keeps no chrome). Every item in the response
  appears somewhere on screen — unit-covered by `groupByPhase`, assert the
  rendering here.
- **Step numbers count techniques continuously across groups and skip
  concepts** — "step 9" means the ninth thing to learn, and prose does not
  shift the milestones' numbers.
- **A concept renders as a text card** — title and body, no step disc, no
  criteria chips, no "reading" treatment — and never appears in the focus
  panel's proposal (unit-covered; assert the rendering).
- **The drilled criterion draws a "Classes drilled" chip** with the same
  enrolled/browsing split as the live counters, reading `drilled_sessions`.
- **Drilled-only training now draws the "started" rule** — the limitation the
  old `hasEvidence` comment recorded as forced is closed; an athlete twenty
  classes into a breakfall is no longer indistinguishable from one who never
  saw it. Mutation-tested in `curriculumRow.test.ts`.
- **The strip shows Foundations roadmaps** (track `foundations`, no belt) with
  a neutral cover and glyph — no belt photograph, which would claim a rank the
  curriculum never had — ordered before the belts (entry point, finishes
  first), with enrolled cards still leading everything.
- **The strip still hides athlete-authored curricula** — no edit path on the
  phone, and a dead-end card is worse than none.

#### What the technique row draws

Presentation, but each of these is a claim about the athlete's record and can
be wrong in a way a screenshot review would pass.

- **The rule has three states and they must not collapse into two.** Untouched
  (`lineSoft`), started (`textMuted`), mastered (the accent). **"Started" means
  any evidence the criteria count — not a cleared target.** Note the boundary:
  *drilled* evidence counts for nothing, because the backend filters `sessions`
  to live events and `Progress` carries no drilled count, so an athlete who has
  only drilled a technique reads as untouched. Worth its own scenario so it is
  found deliberately. The scenario that matters most is
  the near-miss: enrolled, 24 of 25 landed, 14 of 15 sessions, 38% against a
  40% floor, so *nothing* is met. That row must draw the started rule. Keying
  it off met criteria (the shipped-then-fixed bug) drew it identically to a
  technique never trained, for the whole span from first rep to first completed
  target — which is most of the journey, and exactly where "which am I close to
  finishing?" needs answering. A mastered item must also not read as merely
  started, and a non-enrolled viewer must see neither.
- **A met chip tints; it does not gain a second marker.** With three criteria
  where two are met, exactly two chips carry the accent.
- **The disc holds the step ordinal, and mastery replaces it with a check** —
  so the ordinal disappears exactly when the order stops mattering for that row.
  Item 3 of 14 shows `3`; master it and the same row shows a check, not `3` plus
  a badge.
- **Mastery must be announced, not only drawn.** The check glyph, the rule
  colour and the chip tint are all invisible to VoiceOver (`Icon` sets
  `accessible={false}` on every glyph by design), so the disc carries the
  label: `Mastered`, or `Step 3` when it does not. Assert it with a screen
  reader, not by looking — the row this replaced said `MASTERED` in visible
  text, and swapping that for a glyph silently removed the only statement of
  the row's state.
- **Every chip carries a spoken label.** `12/25` announced verbatim tells a
  screen reader nothing; assert the row announces "Landed, 12 of 25" and
  "Hit rate, 43 percent of 40 needed". Browsing (not enrolled) announces the
  target only — "Landed, 25 needed" — because there is no progress to report.
- **A criteria-free item says "Something to study" instead of chips**, and shows
  no zeros. Rendering an empty chip row would read as targets not yet met.
- **The strip's card eyebrow is `WORKING` when enrolled and `{BELT} BELT`
  otherwise**, and enrolled cards sort first. `mastered_items` is deliberately
  absent from the card: it is zero on the LIST response, so "0 of 14" there
  would be a placeholder rendered as fact.

### The roadmap → focus bridge

The loop this feature rests on: roadmap → `bjj_focus` → one-tap chips in the
mobile reflection wizard → technique-tagged events → the criteria. Test it end
to end across both clients; it is the only path where web and mobile have to
agree about the same rows.

- **Applying focus makes the roadmap's next unmastered steps appear as chips in
  the phone's reflection wizard.** The whole point, and the only scenario that
  crosses clients.
- **A mastered technique retires from focus** and the next one takes its slot.
  Without it the list never turns over.
- **Techniques the athlete set by hand survive** when there is room, and the
  panel names them when there is not. `PUT /v1/bjj/focus` replaces wholesale, so
  a silent drop here is data loss the athlete never agreed to.
- **Reading items never enter focus** — focus captures live outcomes, and an
  item with no criteria has nothing to complete.
- **Five is the cap**, and eviction is warned about in different words from
  retirement: one is the machine working, the other is the athlete losing a
  choice.
- **A roadmap already matching focus offers nothing**, rather than a button that
  writes an identical list. Reordering counts as a change — the chips render in
  that order.
- **Two enrolled roadmaps conflict, and nothing warns.** Known gap; worth a
  scenario so it is found deliberately rather than by an athlete.


## The session timer, timed sets and guided runs (mobile)

Mobile-only by the platform rule — a rest countdown on a desk you are not
standing next to is decoration. Everything here is `app/session/[id]`, plus the
pure modules behind it (`lib/countdown.ts`, `lib/setMode.ts`, `lib/duration.ts`,
`lib/intervalRun.ts`, `lib/voice.ts`).

### The timer surface

- **Work opens expanded, rest opens minimised.** The default is the whole
  argument: a timed set is time you spend watching a clock, a rest is not.
- **Minimise and expand round-trip**, and the same controls (±, pause, stop) work
  in both forms — an athlete who minimised a rest must not have to expand it to
  add fifteen seconds.
- **The collapsed bar pushes the list down; the expanded card overlays it.**
  Padding the log by 380pt every time a countdown starts and stops would make the
  screen jump under the thumb between every set.
- **Every colour is the accent's.** Switch to yellow, run a rest to completion,
  and nothing green appears — the old bar's completion state did exactly that.
- **A finished session kills any running countdown.** A work countdown reaching
  zero WRITES; landing that in a read-only session would push a full plank for a
  hold the athlete cut short by finishing.

### The count-in

- **Three seconds before every timed set**, not just the first one in a run.
- **± and pause are absent on a count-in**, not present-and-inert.
- **It ends on its own note**, audibly different from both rest-done and set-done.

### Ticks land on the second

The regression this replaced: ticks fired from a 250ms poll and landed up to
250ms late. Hard to assert in a UI test, so it is pinned on `tickSchedule` — but
worth one manual pass on a device, because "does the beep feel late" is the
whole user-visible property.

- The last three seconds are announced at `endsAt − n × 1000`.
- **A count-in is counted in from its first instant** — "3, 2, 1", never "2, 1".
- Adjusting mid-countdown re-derives only the ticks not yet played.
- A paused countdown announces nothing.

### Ending a timed set early

- **Stop mid-plank logs the elapsed seconds, not the prescribed ones**, and does
  NOT tick the set. Verified once by hand: 60 prescribed, stopped at ~40, logged
  `40s`, untouched tick.
- **"Done early" inside a run logs elapsed AND ticks**, then advances — skipping
  is not the same as pretending the set did not happen.
- **A countdown that simply runs out logs its full total.** Same code path, and
  the number happens to be the same.

### Reps or time, per exercise

- **The chip appears only on `load_type: 'reps'` exercises.** Not on a barbell
  squat, not on a plank.
- **Switching clears the other measure.** A row holding both 15 reps and 40
  seconds is a row two readers describe two different ways — and one of them is
  the volume rollup.
- **Completed sets are left alone.** They are records of something that happened.
- **A timed burpee gets the play button; a rep-counted one does not.** The toggle
  and the timer button must never disagree, because both read `seconds`.
- **Flipping to reps and back restores the prescribed duration**, not the generic
  default.
- **A progression suggestion does not put a rep target on a timed set** — it
  would flip the row's mode back with a duration still attached.

### Seconds or minutes

- **The chip appears on timed exercises only**, and the kg/lb chip only on
  weighted ones.
- **The stored value never changes.** Type 1.5 in minutes, switch to seconds,
  read 90.
- **±  follows the unit**: 15s in seconds, 30s in minutes, and the button says so.
- **The default follows the prescription** — a 4-minute round opens in minutes, a
  45-second plank in seconds, before anybody chooses anything.
- **The choice is per exercise and survives a relaunch.**

### Run all sets / guided workout

- **"Run all" appears only when every pending set of that exercise is timed.**
- **"Guided workout" appears only when every pending set in the SESSION is.** One
  untimed exercise anywhere hides it — a run that skipped them would stop guiding
  halfway through without saying so.
- **The sequence is ready → work → rest → …, with no trailing rest** after the
  final set.
- **Sets already logged are skipped**, and the run's estimate reflects that.
- **The rest between exercises is the one you just finished**, not the one coming.
- **Any structural change ends the whole run** — add, remove, reorder or swap.
  Every remaining step carries a `setIndex` the change has invalidated.
- **Nothing else starts a countdown while a run is live**: auto-rest is
  suppressed, and the per-set play button is hidden.
- **Adjusting a rest inside a run does not persist to the preference** — the
  plan's later steps were built from the stored value.
- **Ending a run mid-way leaves the sets already logged intact.**

### Spoken cues

- **Only during a guided run.** "Run all" on one exercise is silent.
- **The chime is replaced, not joined.** Exactly one of voice or chime per
  transition.
- **Voice off, sounds on, still chimes.** The two preferences must not interact
  to produce silence — that reads as the timer having stopped.
- **Stopping a run cuts the voice off mid-sentence.** Being told to get ready
  after you stopped is the app arguing with a decision already made.
- **"Set completed" is never said unless a work interval ended.**
- **The next exercise is named on the way into a rest**, and only when it changes.

### Monochrome

- **Choosing Mono recolours the accent immediately** and shows the relaunch note.
- **After a relaunch there is no hue anywhere** — error text, the consistency
  grid, sport rules, tile codes and exercise photography included.
- **Switching back to a colour restores everything**, also on relaunch.
- **The relaunch note appears only when the mode is actually mid-switch** — never
  on the five accents that need no relaunch.
- **The accent swatches keep their real colours in Mono.** They are the control
  for choosing a colour; greying them out would make the picker unusable.
- **A fresh install with no stored flag comes up in colour**, and an unreadable
  keychain does the same rather than taking the palette down with it.

## Body check-ins and phases (`/v1/body`, mobile Today + check-in screen)

Logged on the phone by the platform rule — a bathroom scale is not a desk. The
analytical surface (history, comparison, export) stays on web and does not exist
yet. The one exception is the weight trend below — see CLAUDE.md's carve-out.

### The daily check-in

- **A weight alone is a complete check-in.** The girths are behind a disclosure
  and must never be required; a form that asks for nine measurements every
  morning is the one people stop opening.
- **Re-saving the same day updates it** rather than creating a second row or
  failing. This is what makes a retry safe.
- **A girth-only save does not erase that morning's weight.** The single
  highest-value scenario here: absent means "not measured", never "clear it".
- **Notes ARE replaced by an empty string** — an empty note is a real edit where
  an absent measurement is not.
- **Deleting the day is the only way to clear a mistyped value**, and the copy
  says so. Deleting a day that is not there is a 404.
- **An empty check-in is refused** — no weight, no girths, no note, no photo.
  Otherwise it creates a day the trend has to skip over.
- Out-of-range values are refused with a sentence naming the field (a 900kg
  bodyweight, a 700cm waist — mis-keyed decimals, not medical limits).

### The trend, and what the card says

- **The card shows a 7-day rolling mean, never this morning's number.** Feed a
  week with a 1.4kg swing on it and confirm the card does not show the spike.
- **Under three readings there is no trend** and the card says so rather than
  showing one morning as a trend, or a zero.
- **A rate needs two trends at least a week apart.** A three-day span reports
  nothing.
- **A month-old run of readings is not this week's trend** — the window is
  anchored on the date, not on "the last N rows".

### Phases

- **At most one runs at a time.** Starting a second is a 409 telling you to end
  the first, not a 400.
- **Ending one frees the slot**; ending it twice is a 404 and does not move the
  recorded date.
- **A phase belonging to another athlete cannot be ended** — 404, not 403,
  because confirming the id exists is itself the leak.
- **`making_weight` is refused without both a date and a target weight.**
  Without them there is nothing to count down to.
- Past phases are kept. The numbers recorded during one are only readable
  against it.

### What the phase makes the card say

- **A cut running too fast reads as "faster than ideal", not as praise.** The
  sign is the trap here — a cut's rate is negative — so this is worth an
  explicit scenario at −2%/week.
- A cut barely moving reads as too slow, including one going the wrong way.
- **A bulk uses the opposite convention**: +1%/week is too fast, −0.4% too slow.
- **Recomp and maintenance treat drift either way as too fast**, because flat
  is the target.
- **A recomposition with weight flat, waist down and a limb up reads as
  working** — the one case the scale cannot answer and girths can.
- **Making weight shows kilos to go, days left, and whether the required rate is
  safe.** A deadline in the past must not produce a NaN or an Infinity on screen.

### Derived numbers

- **Waist-to-height appears only once waist and height both exist**, and is
  shown instead of BMI.
- **The body-fat estimate is labelled as an estimate**, with its error stated.
- **It refuses to compute without sex** rather than defaulting — defaulting
  applies the wrong regression and produces a confident wrong number. Worth
  testing with hips present, so a null cannot be mistaken for a missing input.
- **Mis-typed girths (waist below neck) produce nothing, never "NaN%".**
- The estimate moves down as the waist comes in — the direction is the reliable
  part.

### Photos

- **The upload never passes through the API.** The client asks for a signed URL
  and PUTs to storage directly.
- **The storage key is derived from the caller and the date.** A client cannot
  obtain a signature over another athlete's object — the security property of
  the whole endpoint.
- **A photo is never visible to anyone else**: not in the friends' feed, not in
  the admin console, not through any public origin.
- **The read URL expires**, so a cached one is a broken image. It is minted per
  response and must not be stored.
- **With no object storage configured the endpoint reports 503** and the rest of
  the check-in still works — unset is a supported state.
- **A partial R2 config fails at startup**, deliberately, rather than silently
  behaving as though storage were absent.
- Photos are downscaled on the device before upload; a raw 4–5MB frame must not
  be sent.

### The weight trend (`/checkin/trend`, N5)

- **Three ranges, one fetch.** Week / month / year switch instantly — the screen
  fetches a year once and slices locally. Switching must not re-request.
- **A gap stays a gap.** Log a fortnight, skip a fortnight, log again: the line
  must break, not run straight through the hole. This is the property most
  likely to regress, because interpolating is what a line chart does by default
  and the wrong version looks *better*.
- **The left edge does not climb out of nothing.** Open the month view with a
  year of daily readings: the line must start at full height on day one, not
  ramp up over the first week. A ramp means the input was windowed before the
  rolling mean was taken.
- **Not enough data says so.** Below three readings there is no line and no
  chart — a message instead. It must never draw a confident line through two
  points, and must never show 0 kg.
- **The delta refuses rather than misleads.** With only nine days of readings
  the month view must not claim "down 2 kg this month"; it says the range
  cannot be compared.
- **Units follow the athlete.** In imperial the delta and the bounds read in lb.
  The stored value is always kilograms; only the display converts.
- **Offline.** Reachable from a cached Today; a failed fetch shows a note, not
  an alert or a retry loop.
- **The card did not become a report.** Today still shows the decision card;
  the chart is one tap away and the "Check in" action is still the primary one.

## Nutrition: targets, food log and saved foods (`/v1/nutrition`)

Nutrition is the last frozen-MVP pillar, and its whole posture is that a number
you can argue with beats a verdict you must trust. The scenarios below lean on
that: almost every one is about the app being honest when it does not know
something, rather than about the arithmetic being right.

The backend is N24; the phone is N25 and its scenarios are the second half of
this section.

### The rule that outranks everything else here

- **Correcting a saved food must not change what the log says you ate.** Log an
  entry from "Chicken thigh" at 180 kcal, correct the food to 210, and the entry
  still reads 180. This is the single most important scenario in the module:
  the failure is invisible — every average and trend an athlete was reading
  changes underneath them, with nothing left to compare against — and the only
  thing that catches it is asserting the old number explicitly.
- **The same holds one level down.** Correcting an ingredient must not rewrite a
  recipe built from it last month.
- **Deleting a saved food leaves its entries intact**, losing only the
  provenance link. `source_food_id` becomes null; the numbers do not move.

### Logging

- **A re-sent entry is the same entry.** The id is client-generated, so pushing
  it twice from an outbox is one row, updated — not two rows and not a failure.
- **Deleting twice is not an error**, and neither is deleting an id that never
  existed. An outbox retries; a second delete recording a permanent failure
  would strand a correctly-gone row on the sync screen forever.
- **Macros are absolute for the quantity logged.** The server never scales by
  `servings` and never converts a unit — send 1.5 × "100 g" with the macros
  already multiplied.
- **kcal is authoritative.** An entry whose macros do not sum to its kcal under
  4/4/9 must be accepted, because real labels do not reconcile. A client that
  rejects or "corrects" it is the bug.
- **The meal slot is stored, not derived.** A dinner logged at 23:00 is still
  dinner when the day is read back — never re-derived from the timestamp.
- **The day is the athlete's local calendar day.** A 22:00 entry logged west of
  Greenwich stays on that day. Worth testing under a non-UTC `TZ`, because in
  UTC the bug is invisible.

### What a day adds up to

- **The day being edited is summed on the client, not the server.** An offline
  client holds entries the server has never seen, so `/nutrition/days` is for
  review windows only. A client that renders today's remaining figure from it
  will show a number that is wrong for exactly as long as the outbox is full.
- **Each day is paired with the target that was live THAT day.** Set 2400 in
  May and 2100 on the 18th; the 17th must report 2400 and the 18th 2100. One
  figure for the whole window misattributes every day before the change.
- **A day nobody logged fibre for reports null fibre, not zero.** Averaging
  unstated as zero drags every fibre figure down.

### Targets

- **The date is the identity.** Setting today's target twice is one row.
- **A window with no targets of its own still reports one.** Set a target in
  May, ask for a week in August, and the May row comes back as the carry-in.
  Without it the client honestly reports "no target" for a week the athlete was
  eating to one — and it only breaks for people who have *not* changed their
  target recently, which is to say the ones doing it right.
- **The basis survives a round trip**, because it *is* the explanation. A target
  whose arithmetic was lost cannot be argued with.
- **The basis is frozen, never recomputed.** Change the athlete's weight or end
  their phase, and a target set last month still explains itself with the
  numbers that produced it.

### Deriving a target

- **It is a proposal and stores nothing.** `GET /targets/suggested` twice
  changes no state; the athlete accepts with a PUT.
- **An incomplete profile is a 200 with a null suggestion**, not a 400, and
  `missing` names the fields. The request was fine; the fix is a form.
- **A profile with only a bodyweight is REFUSED**, even though a number could be
  produced. The generic resting baseline runs 20–30% high; in a food target that
  overfeeds by roughly 400 kcal a day and the cut silently never happens. There
  is no caveat an athlete can act on.
- **A cut proposes less than maintenance and a lean bulk proposes more.** Both
  directions, because a single-direction test passes against a sign that is
  inverted for both — and an inverted sign proposes *more* food to somebody
  already losing too fast while every number on screen still looks plausible.
- **Training is added once.** The activity ladder is NEAT-only and stops at
  1.45; a textbook 1.55 "moderately active" plus the logged-session average
  double-counts every mat class.
- **A missed weigh-in deadline must not prescribe a surplus.** Set a
  `making_weight` phase whose `target_on` has passed while the athlete is still
  over: the target must not go UP. A negative day count inverts the required
  rate, and the sign flips again per phase.
- **A deadline four weeks out and six kilos to go is clamped**, not obeyed. A
  competition date does not change physiology.
- **Nothing proposes less than the athlete's resting rate.**
- **An unknown phase kind holds weight.** A phase kind the server gains before a
  build knows it is a real deployment state, and under-feeding on a vocabulary
  mismatch is the worse failure.
- **Macros round coarsely, so `4P + 4C + 9F` will not equal kcal.** That is
  intended, and a client must not reconcile them.

### Auth and security

- **A UUID belonging to another athlete is 404, never 403.** A 403 confirms the
  row exists to somebody enumerating ids. Needs two accounts — a single-account
  test passes against the bug.
- **And it writes nothing.** After a foreign PUT, the original row's name,
  macros and `user_id` are unchanged. This is the cross-user bug the reviewers
  have already caught twice in this codebase, and a client-generated primary key
  is exactly what re-opens it.
- **Saved foods are scoped.** Another athlete's foods never appear in a list or
  a search.
- **`source` is not settable by a client.** Everything written through the API
  is `user`; letting a client claim `usda` or `off` would make the licence
  separation those values exist for meaningless.
- **Every endpoint 401s without a token.**
- **A range longer than its cap is a 400**, not a slow success — the response
  stack buffers to compute an ETag, so an unbounded window is a memory cost that
  scales with how long somebody has trained.

### Mobile: the Food tab, the day screen and the outbox (N25)

**Happy path**

- **A repeat meal is two taps.** Open `Food`, tap `+ Add` on a slot, tap a
  recent — logged, sheet dismissed, the remaining figure on Today has moved.
  Nothing about that sequence may require a network round trip.
- **The quick-add list is ranked for the slot being logged into**, not by raw
  recency: a breakfast staple tops breakfast and does not appear at dinner.
- **A food logged from the quick-add sheet appears on the day screen
  immediately**, before any push has completed.
- **A new food is one screen** — name, serving label, four numbers — with a
  single `Save and log`. Saving it both stores the food and logs a serving.
- **The Today card and the day screen agree, always.** They share
  `RemainingBlock`; a scenario that shows them disagreeing is a regression in
  that sharing, not in the arithmetic.
- **Starting a phase from `You ▸ Phase` and then opening `Food ▸ Target` shows a
  derivation pointing the right way** — a cut proposes fewer calories than
  maintenance, a lean bulk more.

**Edge cases and errors**

- **Logging works with the network off**, end to end: the entry is written, the
  day screen totals it, the pending count rises, and it pushes when signal
  returns. This is the scenario the whole outbox exists for.
- **No target is a first-class state.** The card and the day screen show eaten
  totals and say `Set a target` — never a zero remaining, which reads as "you
  have nothing left".
- **An unreachable target is NOT reported as no target.** With the network off
  and a target cached, the cached figure is shown; with none cached and no fetch
  ever having succeeded, the screen says it cannot check — never `Set a target`,
  which is an instruction to redo work the athlete may have done on web. These
  are FOUR distinct sentences with not-yet-loaded and nothing-logged, and a
  scenario that accepts any of them for another is not testing the distinction.
- **Stepping to another day never shows the previous day's target.** The failure
  mode is a wrong remaining figure, not a stale one, and it appears specifically
  when the new day's target fetch fails.
- **Over the target is muted, never an error colour.** One day over is not a
  failure state, and rendering it as one is against the no-shame rule.
- **A dinner logged at 23:00 stays dinner.** The slot is assigned from the wall
  clock once, at log time, and stored — never re-derived on read. Worth an
  explicit evening-log scenario: the suite runs under
  `TZ=America/Los_Angeles`, so a UTC-derived date fails here and only here.
- **Editing an entry does not change the food it came from**, and editing a
  saved food does not change any entry already logged from it. Both directions
  need their own scenario; each passes against the other's bug.
- **Changing servings on an entry rescales the macros; typing a macro stops it
  rescaling** for the rest of that edit.
- **Deleting an entry always tombstones while a push may be in flight.** A row
  logged and immediately deleted must not be forgotten locally before its create
  has landed, or the server keeps an entry the phone no longer knows about and
  no tombstone will ever remove it.
- **An edit made during a push survives the REJECTION of the payload that
  preceded it**, not only its success. Both halves need a scenario; each passes
  against the other's bug.
- **An incomplete profile blocks the target with named fields**, and the screen
  routes to the profile form rather than offering a retry. It must never fall
  back to an estimated resting baseline — that runs 20–30% high, which is a cut
  that silently never happens.
- **A bound rail is stated.** When the derivation clamps, the screen says so;
  without that line the last step does not follow from the one above it.
- **Making weight refuses to start without a weight and a date.** Every other
  phase kind accepts both as optional.

**Auth and security**

- **The Food tab is absent when no enabled module has `has_food_log`** — and
  absent by `href: null`, so `/food` still resolves for a deep link or an
  in-flight push.
- **A local read is scoped to the signed-in athlete.** The entry editor opened
  on another athlete's id finds nothing, even though ids are generated on the
  device and are therefore guessable-adjacent.
- **Signing out and signing in as somebody else shows none of the first
  athlete's food**, from the local database, with the network off.

## The BJJ position map (`GET /v1/bjj/positions`, mobile `/bjj/positions`)

### The aggregate

- **Counts fold across every session, not just the most recent.** Two sessions
  each conceding from half guard read as one total, and the `sessions` count
  says it came from two.
- **`drilled` never counts as live evidence.** A position drilled 50 times and
  never taken into a round must rank *below* one with three concessions — this
  is the ordering rule and the difference between a map of your game and a map
  of your gym's curriculum.
- **A tag with no position is skipped**, not shown as an empty bucket.
- **The map is scoped to the caller.** Another athlete's tags on the same
  position must not appear — worth testing with the same position name on both
  accounts, so a leak shows up as a wrong number rather than an extra row.
- The response is capped (60 rows) and the ordering is total, so two identical
  requests hash identically — the ETag on this endpoint is a body hash, so a
  reordering tail would be a permanent cache miss.

### Reading it

- **A successful defence counts as a won exchange.** A position where the
  athlete only ever survived must not read as 0%. The single most consequential
  sign error available here.
- **A missed attempt counts as a lost one.** Two scores and four misses is not a
  2–0 record.
- **Below the threshold a row is shown with no verdict.** `min_live` comes from
  the response, not a client constant, so the two cannot disagree.
- **At exactly the threshold a verdict appears** — off by one here silently
  withholds every verdict for a whole extra round of evidence.
- **Nothing on the screen tells the athlete what to drill.** Concessions are
  equally consistent with a hole in the game and with starting every round there
  on purpose; the copy names where things go and stops.
- **Tied rows keep a stable order** across two loads of unchanged data.
- The split bar is readable in greyscale and under the monochrome accent —
  segment widths carry the ratio, not hue.
- **A deep link does not bypass the module gate.** With BJJ off, `/bjj/positions`
  renders the disabled state rather than the map — the route itself still exists,
  because file-based routing cannot remove it, so "absent" here means the content
  is gated, exactly as `/bjj` is.

## The weekly sum-up (mobile Today)

- **Sessions, days and the load figure match the calendar directly beneath
  them.** Both read the same local list; a card claiming four days above a strip
  lit on five is the contradiction that costs more trust than either number
  earns.
- **No comparison is drawn when the device cannot prove last week.** The local
  list is bounded by count, so an athlete training twice a day may hold only
  nine days — the deltas must be absent and explained, never computed from a
  partial week and shown as a decline.
- **A week with no lifting shows time, not "0 kg".**
- **A week nobody planned is not a week at 0% adherence** — the plan line is
  absent entirely.
- **A session left running contributes no duration.** The week's total must not
  climb while the phone sits in a locker.
- **Two sessions on one day count as one trained day.**
- **A Sunday-evening session stays in its own week** west of Greenwich — the
  bucketing is on the local day, and a UTC-only test passes against exactly this
  bug.
- Warm-up and uncompleted sets are excluded from the tonnage, matching every
  other volume count in the app.
- The verdict line names what happened without scoring or grading the week.
- **A known over-count, worth a test that PINS it rather than one that denies
  it.** Unlike `/bjj/proficiency`, this endpoint sums both technique-tagged and
  untagged tags and cannot dedup them, so one exchange recorded in both the
  wizard's technique step and its live grid appears twice. A test should assert
  the current (doubled) number, so that if someone ever links the two rows at
  write time the test fails and forces the decision to be made deliberately.

## Concurrent SQLite writes on the shared connection (mobile, `lib/db.ts`)

`expo-sqlite` gives the whole app ONE connection, and its `withTransactionAsync`
is an unguarded `BEGIN`/`COMMIT`: two overlapping calls end each other's
transaction, which surfaced as `cannot rollback - no transaction is active`
rendered over the Plan tab and, silently, as a lost reconcile. `withTransaction`
serialises them. These are the properties worth holding.

### Happy path

- Opening Plan while the Library, a session screen or a sync is caching the
  catalog completes both writes. Neither errors, and both caches hold their
  full contents afterwards.
- The Plan tab's reconcile still removes a workout deleted on the server even
  when a catalog write overlaps it — the case that failed silently, with the
  deleted template flashing back on every tab focus.
- Rapid tab-switching between Plan and Library (the manual reproduction) shows
  no database error on either screen.

### Edge cases & errors

- A transaction whose body throws rolls its own writes back and leaves the
  queue able to run whatever was queued behind it. One failed write must not
  kill every later transaction for the life of the process.
- A cache write that fails for ANY reason still leaves the Plan tab showing the
  week's training: the response is already in hand by then, so the screen falls
  back rather than surfacing a database error. The failure is logged, not shown.
- That fallback re-reads the cache rather than rendering the network list, so a
  workout created offline and not yet pushed still appears — the case where
  rendering the list would show "No workouts yet" to someone holding one. It
  falls through to the network list only when the cache read also fails or comes
  back empty (a first launch, where the failed write is what would have filled
  it).
- Switching scope (`My workouts` → `Shared`) while a load is queued behind other
  transactions must not let the stale `mine` result overwrite the shared list
  when it finally resumes.
- On a first launch, with the seed's catalog write ahead in the queue, the Plan
  tab must not flash "No workouts yet" before the list it is about to render
  arrives.
- Nothing calls `db.withTransactionAsync` directly outside `lib/db.ts` — lint
  fails the build on it, since a comment alone did not hold the line before.

## Per-side load (`exercises.load_mode`, `LoggedSet.load_factor`)

`weight_kg` is what is stamped on the implement. For a pair of dumbbells that is
one of the two, so the total doubles. These scenarios are mostly about the
number NOT changing where it should not.

### The arithmetic

- Log 5 reps at 100 kg on **Barbell Bench Press** → tonnage 500.
- Log 5 reps at 30 kg on **Dumbbell Bench Press** → tonnage **300**, not 150.
- Log 10 reps at 40 kg on **One-Arm Dumbbell Row** → tonnage **400**, not 800.
  Per-side, but only one dumbbell is moving; `is_unilateral` is what stops it
  doubling.
- Log 8 reps at 30 kg on **Goblet Squat** → tonnage **240**, not 480. One
  implement, two hands — the number already is the whole load. Kettlebell Swing,
  Pullover, Turkish Get-Up and Halo are the same shape and the ones most likely
  to regress, because equipment alone classifies them wrongly.
- A **warm-up** on a per-side exercise still contributes nothing.

### Everywhere the number appears, it must agree

The same session's tonnage has to read identically in all of these, and they are
computed by five different pieces of code:

- the session summary on the phone
- the week review on Today, and the Today header
- the training calendar
- `GET /v1/sessions/history` totals
- the friends' feed row, and the session share card

A dumbbell session that reads 600 on your own screen and 300 in a friend's feed
is the specific regression this guards.

### The fresh-database trap

- **Create a database, migrate it, seed it, and check `load_mode`.** The
  migration only backfills rows that already exist; a new database gets its
  catalog from the seeder. Query
  `SELECT load_mode FROM exercises WHERE id = 'dumbbell-bench-press'` — it must
  be `per_side`. This is how the bug came back once already, and it is invisible
  on a developer machine whose database predates the migration.
- Run `cmd/seed` twice: the second run must report no changes. If `load_mode` is
  missing from the change-detection tuple, every deploy rewrites all 761 rows.
- Run `cmd/exportcontent` and diff: `load_mode` must survive the round trip. If
  the export drops it, the next content edit silently strips the whole catalog's
  classification.

### Backwards compatibility

- A set logged **offline before sync** has no `load_factor`. Its volume must
  read as `weight x 1`, never as zero — an erased session is far worse than an
  under-reported one.
- An older client that ignores `load_factor` still shows the server's totals
  correctly, because the server does the multiplying for anything it computes.

### Authoring it in the console (T2)

The console can set `load_mode` now. Before, every exercise created there was
born `total` — a dumbbell exercise authored in the console halved its own
tonnage from the start, and nothing could correct it.

- **Create a dumbbell exercise with Load mode = per_side**, then log 10 × 30 kg
  against it. Volume must read 600, not 300. This is the whole task in one
  scenario.
- **Create without touching Load mode** → the row is `total`. The field is
  optional and the default matches the column's.
- **Rename a per_side exercise and save.** It must still be `per_side`
  afterwards. The UPDATE writes the column now, so the only thing keeping a
  rename from reverting it is that the handler merges onto the stored row —
  worth checking directly rather than trusting.
- **Change an existing exercise from `total` to `per_side` and back.** Both
  directions must stick; a misclassified row was previously permanent.
- **POST/PATCH `"load_mode": "per_sied"`** → **400**, naming the bad value and
  the legal set. NOT a silent fall back to `total`, which would be the halving
  bug arriving through a typo.
- **`cmd/exportcontent` must still export a row whose load_mode is absent from
  the in-memory struct** — the export's validate step is deliberately tolerant
  where the API is strict, because an unknown value would seed as `total`
  rather than break a deploy. Two of that command's tests catch this; if a
  future change moves the strict check into `ValidateForWrite`, they go red.
- **Author a per_side exercise, run `cmd/exportcontent`, then `cmd/seed`** →
  `load_mode` survives the whole round trip and the next deploy does not revert
  it.

### Saying so on screen (W3)

The arithmetic above being right is not the same as the athlete being able to
tell. These check the explanation, and the whole point is that the two halves
key on **different flags** — get them from one and a quarter of the catalog is
told the opposite of the truth.

- **The input hint keys on `load_mode`, so it appears on all 142.** Open
  **Dumbbell Bench Press**: the weight field reads `Weight kg per hand`. Open
  **One-Arm Dumbbell Row**: it *also* reads `per hand` — you still type one
  dumbbell there. Open **Barbell Bench Press**: no hint at all.
- **The total keys on `load_factor`, so it appears only on the 108 that
  double.** Log 10 × 30 kg on Dumbbell Bench Press → the row reads
  `10 × 30kg (60kg total)`. Log 10 × 40 kg on One-Arm Dumbbell Row → the row
  reads `10 × 40kg` and **must not** claim a total. That second case is the
  one worth writing first; it is what a single-flag implementation gets wrong.
- **Both are spoken, not just shown.** With VoiceOver on, the weight field
  announces "Weight kg per hand for set 2 of Dumbbell Bench Press". The visible
  note on web sits above the table, where a screen-reader user tabbing into a
  cell never reaches it — so the cell's own label has to carry it.
- **Imperial converts both numbers.** Switch units: `10 × 66.1lb (132.3lb
  total)`. Note 132.3, not 66.1 × 2 = 132.2 — the total is doubled in
  kilograms and converted once. A test asserting 132.2 is asserting a rounding
  bug.
- **A set with no factor says nothing** rather than guessing. Offline rows and
  anything logged before the server sent one: `10 × 30kg`, no annotation.
- **Web shows two per-side lines on the 34 overlapping exercises**, and both
  are true: "Per side — 8 reps here means 8 each side." (reps, keyed on
  `is_unilateral`) and "Weight is per hand — enter the one dumbbell you lift."
  (weight, keyed on `load_mode`). On a Dumbbell Bench Press only the second
  appears, and it adds "Volume counts both".
- **The web sessions LIST agrees with the session detail page.** Open a
  dumbbell session's row in `/dashboard/sessions` and then the session itself:
  the volume figures must match. They did not — the list halved every dumbbell
  session, on the same line that had already missed `completed` once.
- **`GET /v1/exercises` and `GET /v1/exercises/{id}` both carry `load_mode`.**
  It is in the contract's `required` list now. If either drops it the hint
  silently disappears everywhere and no arithmetic test notices, because the
  tonnage rule reads the column in SQL and never touches that response.

## The feed's 3-day window and the poster's avatar

### The window

- **A friend finishes a session now** → it appears in your feed.
- **A friend's session that ended 4 days ago** → not in the feed, and not in
  `total` either. The count and the list must agree; a "+1 more" that loads
  nothing is the specific regression here.
- **Just inside and just outside the boundary** (say 71h and 73h) → one appears,
  one does not. A test that only checks "a week ago is gone" passes for any
  window from a minute to six days.
- **The window is three days.** Worth asserting as a literal somewhere: a
  boundary check written relative to the constant passes for any value of it.
- **Your own week-old session** is still in your history, your calendar and your
  session list. Nothing is deleted — this is a window on one surface.
- **Cross a boundary while the app is open**: a session that was the oldest row
  drops out on the next refresh rather than lingering.

### Saying so

- **Feed with friends but nothing recent** → "Nobody you train with has shared a
  session in the last 3 days", NOT "Nothing here yet" alone, which reads as
  broken or as friends who never train.
- **Feed with no friends at all** → still the add-a-partner message. The two
  empty states are different facts.
- **Reaching the end of a complete feed** → "Showing the last 3 days" once. Not
  shown on an empty feed, where the message above already carries it.
- **"Show older"** appears only while there are more rows *within* the window.

### The avatar

- **Every post leads with the poster's initials on a coloured disc**, not the
  sport icon. The sport keeps a small glyph beside its own label underneath.
- **The same person is the same colour on every post, every launch, every
  device.** This is the whole feature — a feed becomes scannable by colour
  before it is read.
- **A friend renames their display name** → the avatar does not change. It is
  keyed on the handle, which is unique and cannot be set to somebody else's.
- **Change your own accent theme** → your friends' avatar colours do not move.
  Keying them on the accent would make someone else's identity depend on your
  settings.
- **A handle with a separator** (`mat_rat`) shows two initials; one without
  (`matrat`) shows its first two letters; one with digits (`dmytro21`) treats
  the digit run as a boundary.
- **A poster with a display name** shows the name on the first line and
  `@handle` beneath. Without one, the handle is the first line and is not
  repeated.
- **VoiceOver** still reads one stop per post — the card stays hidden from the
  reader, and the label leads with the person.

## Implement count vs unilateral (`exercises.implements`)

The two are independent and are the pair most often confused. A dumbbell walking
lunge is **two implements and one leg**.

- **Log 10 reps at 20 kg on a Dumbbell Walking Lunge** → tonnage **400**, not
  200. Two dumbbells moved.
- **The same on a Kettlebell Walking Lunge** → also 400. The identical movement
  must not depend on which implement it is held with; five such pairs disagreed
  before this.
- **10 reps at 40 kg on a One-Arm Dumbbell Row** → 400, not 800. One implement.
- **8 reps at 20 kg on a Goblet Squat** → 160. `load_mode = total`: the number
  typed is already the whole load.
- **Every lunge, split squat and step-up still shows "8 reps here means 8 each
  side"** — that hint keys on `is_unilateral`, which was being switched off on
  the kettlebell rows purely to buy a doubling, and now is not.
- **Change history is retroactive.** A past session using a corrected exercise
  reports the new tonnage — `load_factor` is derived on read, never stored. The
  old figure was wrong; this is a correction, not a rewrite.

### Authoring it

- **Create an exercise in the console with Implements = 2**, log against it →
  tonnage doubles. Born wrong is the failure this guards (the same shape as the
  `load_mode` bug).
- **Edit any other field on it and save** → the count is unchanged.
- **Correct a wrong count from 2 to 1** → it sticks. Under the old derived rule
  the only way to change the factor was flipping `is_unilateral`, which silently
  changed the reps hint too.
- **PATCH `"implements": 3`** → **400**.

## Finding an exercise (`GET /v1/exercises?q=`)

The three queries below are a real report of "these exercises are missing". All
three exercises existed; the search could not reach them.

- **"ez bar curls"** → `EZ-Bar Curl` first. Word order, a hyphen and a plural.
- **"incline dumbbell bench"** → `Incline Dumbbell Press` first, **above**
  `Incline Bench Dumbbell Row`. The row contains every typed word literally, so
  this is the case that catches ranking against the raw query instead of the
  expanded one — and it fails by ordering, not by returning nothing.
- **"dumbbell overhead press"** → a `Dumbbell Shoulder Press` first.
- **Each of the three returns nothing at all** under the old contiguous `ILIKE`.
  If a change makes any of them empty again, that is the original bug.

### It must not become a way to list everything

- **`%`, `_`, `\` and `!!!`** → **no results**. These tokenize to nothing, and an
  unmatchable query must match nothing rather than falling through to "no
  filter". Returning the whole catalog for one keystroke is the regression this
  shipped once.
- **A draft is never findable**, by any query. The search is ANDed with the
  status filter, not substituted for it.
- **`?q=` combined with `?sport=`** still respects both.

### The console searches the same way

- **`/content/exercises?q=` with any of the three queries above** finds the same
  rows the athlete's app does. An operator answering "I can't find X" who
  searches differently from the athlete gets "works for me".
- The console no longer matches on **id** — it is a slug derived from the name,
  so it carries no word the name does not.

## Grip (`session_sets.grip`)

How the implement was held, per LOGGED SET. Four values — regular, neutral,
reverse, angled — plus NULL for unrecorded, which is **not** the same as
regular.

### The pass-through, which is what actually breaks

- **Log a set with a neutral grip, then edit something else about the session**
  (add a set, change a weight) **and reload.** The grip must still be there.
  `ReplaceSets` deletes and reinserts every row, so this is the scenario that
  catches a client — or the server's own read — dropping the column.
- **Do the same edit from the WEB session page.** Web cannot set a grip, but it
  must not destroy one the phone recorded.
- **Round-trip the server's own output**: read a session, PUT the sets back
  unchanged, read again. Nothing may change. Missing `grip` from `attachSets`
  fails exactly here and nowhere else.
- **A set logged offline by an older build** has no grip key. It must sync
  without error and read as unrecorded — never as `regular`.

### Where the picker appears

- **Dumbbell bench press, lat pulldown, barbell curl** → the grip chips appear.
- **Back squat, walking lunge, a run** → no chips. The question is meaningless.
- **Deadlift, farmer's carry, clean** → **no chips, deliberately.** The real
  answer there is `mixed` or `hook`, which this enum does not have; offering
  these four would collect a false answer. If a picker appears on a deadlift,
  that is the bug.
- **Offline with the catalog uncached** → no chips, rather than chips on
  everything.

### Recording and clearing

- Tap `Neutral` → the set reads neutral, and **the next set added inherits it**.
- Tap `Neutral` again → cleared, back to unrecorded. This is the only way back,
  and without it a mis-tap is permanent.
- A set whose grip was never set shows **nothing** — no "Regular" anywhere, on
  the row, the share card or the web table.
- Add a drop off a neutral-grip set → the drop inherits neutral.
- **Swap the exercise** (dumbbell press → leg press) → the grip is cleared. A
  grip surviving onto a movement with no picker can never be removed.
- **Switch a dual-mode exercise to time** (assisted pull-up → a hang) → the grip
  **survives**. Unlike assisted reps, which go with the reps.

### Errors

- `PUT` a set with `"grip": "banana"` → **400**, naming the set.
- The database refuses it too, for any caller that bypasses the handler.

## Assisted reps and drop sets (`session_sets.assisted_reps`, `set_type='drop'`)

### Spotter reps

- Log 8 reps at 102.5 kg with `assisted_reps: 3` → the set reads 8 reps, and the
  solo figure is 5. **Tonnage counts all 8** — the weight moved either way.
- It counts as **ONE working set**, not two. A spotted set is one approach to
  the bar; if `working_sets` goes up by two, the split has been modelled wrongly.
- **Edit the session and save again.** `ReplaceSets` deletes and reinserts every
  row, so this is where a column missing from the INSERT or the SELECT loses the
  data — silently, since nothing else about the set changes.
- `assisted_reps: 0` and `assisted_reps` absent must stay distinguishable after
  a round trip. Absent means unrecorded and reads as all-solo; 0 means the
  athlete said none.
- Rejected with a message naming the set: more assisted than performed
  (`reps: 5, assisted_reps: 8`), assisted reps with no `reps`, negative values.
  The database CHECK is the backstop; the handler should answer first, because
  "a value is out of range" with no set number is unactionable.

### Drop sets

- 225 × 3 then 185 × 8 is **two rows** — a `working` set and a `drop` set, each
  with its own weight and reps. There is no parent id and none is needed.
- The drop belongs to the **preceding** set of the same exercise. Two drops in a
  row both belong to the same parent.
- A `drop` row following a DIFFERENT exercise is orphaned: it must be skipped,
  never attached. Attaching it would put reps under a lift they were never
  performed on.
- Reorder the sets and save: because the relationship is order, moving a drop
  away from its parent re-parents it. That is the known cost of adjacency —
  verify the client cannot do it by accident.

## Logging assistance and drops on the phone (mobile session screen)

### Assisted reps

- The **Assisted** field appears only on a set that has reps. On a plank or a
  run it must be absent — the API rejects assisted reps without a rep count, so
  a visible field there is a control that can only produce an error.
- Enter 3 on a set of 8 → the hint reads "5 on your own".
- **Clear the field → the value is unrecorded, NOT 0.** Reopen the set: it is
  empty, not zero. This is the distinction the whole feature rests on; a UI that
  writes 0 on clear asserts the set was unaided.
- Type 12 on a set of 8 → **clamps to 8**, no error, no failed save.
- Finish the session offline, then sync: the value survives. Then EDIT the
  session and save again — `replaceSets` replaces every row, so this is where a
  client shape that forgot the field would silently drop it.

### Drop sets

- **+ Drop** appears beside **+ Set** only when the last set has a weight.
- It inserts directly under its parent, carrying the weight forward and leaving
  reps EMPTY — the reps are the one field certainly different at a lower weight.
- Effort and assistance are not carried onto the drop.
- The drop shows **`↳`**, not a set number, and is indented with a rule. Add a
  drop to set 3 and the next ordinary set is still **4**, not 5 — the athlete
  did four sets, not five.
- Two drops in a row both hang off the same parent and both show `↳`.
- With VoiceOver the drop announces as **"drop off set 3"**, never as a set of
  its own.
- **Reorder a drop away from its parent** — it re-parents to whatever it now
  follows. That is the known cost of expressing the relationship as order;
  verify the UI does not make it easy to do by accident.


## Sharing a session's card (mobile — `components/SessionShare.tsx`)

The card an athlete posts. Previously reachable only from the completion modal;
now offered on any finished session, strength or BJJ. `apps/web` has no
equivalent — the capture is native.

### Happy path

- **Finish a strength session, dismiss the celebration, share from the screen
  underneath.** The button is below "Finished — this session is read-only." The
  resulting image must be the SAME card the modal offered: same title, same
  stats, same headline.
- **Open a session finished on a previous day and share it.** This is the
  case the feature exists for and the one nothing covered before.
- **Same, for a BJJ class** (`bjj-session-share`, above Delete). The card
  carries rounds and rolling minutes, never a tonnage tile.
- A session still in progress offers **no** share button — on either screen.
  There is no card to make of a workout that has not ended.

### The two silent-wrongness cases

- **The date on the card is the SESSION'S date, not today's.** Share a class
  from last week and read the date stamp on the exported PNG. `cardFromSummary`
  defaults to `new Date()`, so a regression here reads as "today" and looks
  entirely plausible.
- **A session that set a PR keeps its medal and its "NEW BEST." headline when
  shared later.** Compare the modal's card against the same session shared the
  next day — they must match. Then beat that PR in a later session and share the
  old one again: the medal must now be GONE, because it is no longer a record.
- No streak badge on a re-shared card, by design — check one shared from the
  modal (which may show "N weeks unbroken") against the same session read back.

### The capture itself

- **The exported PNG is 1080 x 1080 — and the reason differs by platform.** On
  **iOS** `captureRef`'s `width` is in POINTS and the renderer multiplies by
  device scale, so passing the pixel figure exported 3240px / 10.5 MB from a 3x
  device; the app divides by the scale first. On **Android** the same option is
  already the final pixel size (`createScaledBitmap`), so nothing is divided.
  Check with `file` on the capture, never the share sheet's thumbnail — it looks
  identical at either size. Two devices are worth the trip because each pins a
  different branch: a **2x iOS** device (SE), and **any Android** phone, where a
  wrongly-shared formula shows up as a ~360px card rather than a huge one.
- **The exported PNG is not blank.** The card is mounted off-screen and a
  `ScrollView` clips its content, so a host that drifts inside one still renders,
  still passes typecheck, and produces an empty image. Open the share sheet and
  look at the preview thumbnail — that is the cheapest check.
- Airplane mode: the card still shares. Calories and the VOLA score are absent
  (they need `/sessions/{id}/card`); duration, volume and PRs are not.
- **Dismissing the share sheet must say nothing.** An error line after a
  deliberate cancel is the bug. A device that cannot share at all, and a capture
  that failed, must both speak up.

### Layout

- **Share and Done line up in the completion modal** — same height, same
  baseline, same top edge. Check with a session that HAS a card (both buttons)
  and one that does not (`sessionID` absent — Done alone must still span the
  card).

### Accessibility

- VoiceOver on the completion modal must not reach the off-screen card. Swipe
  past Done: the next stop is outside the modal, never the wordmark, the date
  and every stat read a second time. Same on both session screens.

## The sync repair screen (mobile — `app/sync.tsx`, `blockedRows`)

The screen an athlete reaches when they are already worried about their
training. Everything here is about it telling the truth.

### A measure the server cannot store

- **Log a set, type `0` into weight, finish the session, sync.** It must sync.
  Before the repair, that one keystroke stranded the whole session permanently:
  the API refuses any measure that is present and not greater than zero, a 400
  is a PERMANENT rejection, and the row was retried identically forever.
- Same for `0` reps, `0` seconds, `0` metres, and for an RPE of `0` or `11`.
- **`0` RIR must survive.** It is a real answer — nothing left in the tank — and
  the server accepts 0–20. A repair that nulls it is deleting data.
- **Typing `0.5` into weight must be possible.** This is the regression guard
  for repairing in the wrong place: null-on-input wipes the field the moment the
  leading `0` is typed.
- **An already-stuck session heals.** Put one on the device (a set with weight
  0), then open the app and sync: it must leave, without the athlete editing
  anything. Rows logged before the fix are the whole point.
- After it syncs, the set reads `—` rather than `0kg`, on the phone and the web.

### The list must not lie

- **Press Try again on a row the server still refuses.** The row must STAY, with
  the server's message on it. It used to vanish — the retry cleared the stored
  error and never wrote the refusal back — and then reappear at the next
  background sync. Sync, and check it did not silently move to "Nothing is
  stuck" in between.
- **Press Try again on a row whose obstacle has cleared.** It must go, and the
  stored message must be cleared too (not merely hidden by the `dirty` filter).
- **Press Try again on a session whose workout has not synced yet.** Nothing is
  sent — the push defers — so the row must keep its message. Resolving without
  having done anything is not success.
- Retry while offline: the row keeps its existing message. A dead spot is not a
  new diagnosis.

### Getting to the problem

- **Every row opens what it is about.** A strength session → `/session/[id]`, a
  BJJ class → `/bjj/session/[id]`, a plan → `/workout/[id]`. Sending a class to
  the strength screen is the old bug that rendered it as "Sets 0 · Reps 0 ·
  Volume —".
- The row still offers Try again alongside, and it reads as the quieter of the
  two.

## Previewing the card before sharing (mobile)

- **Tap Share on a finished session.** The card appears at readable size — big
  enough to read the calorie figure and the VOLA score, which are the reason
  this exists. The share sheet must NOT have opened.
- **Not now** closes it and posts nothing.
- **Share** inside the preview opens the system sheet with the same card.
- All three surfaces behave identically: the completion modal, a finished
  strength session, and a finished BJJ class.
- **A failed capture leaves the preview open**, with the message on it. Dropping
  back to the session screen would hide both the error and the card.
- **Dismissing the system share sheet says nothing** — no error, preview still
  there, so a second attempt costs one tap.
- On a small phone (SE), check the card, the note and both buttons fit without
  the buttons being pushed off-screen.

## Per-exercise load history (`GET /v1/records/{exerciseID}/history`, web records page)

### Happy path

- An exercise trained in three sessions returns three points, **oldest first**, one per session — not one per set and not one per calendar day.
- Two sessions on the same day stay two points. A day-grained rollup would average a morning and an evening session into a number neither of them was.
- The web records page charts it on demand: the card's "Show progress over time" fetches once, and closing/reopening does not refetch.

### Edge cases & errors

- **A session whose sets are all high-rep has `best_1rm_kg: null`** and renders as a **gap in the line**, never a zero and never a bridged segment. An estimate needs about twelve effective reps or fewer.
- Switching the chart's metric to one no session has (typically Est. 1RM) shows a sentence naming the metric, not an empty frame.
- **A drop set adds tonnage but does not add to `sets`.** Both halves fail in opposite directions — counting it inflates the count, excluding its volume deflates the tonnage.
- A pair of dumbbells doubles `tonnage_kg` but **not** `top_weight_kg`: the logged weight is per implement and the doubling belongs to tonnage alone.
- Warm-ups and sets never marked completed contribute nothing — not to sets, reps, tonnage or the estimate.
- **An assisted set is estimated from the reps done UNAIDED**, matching `/records` exactly — a weighted (`weight_reps`) set of 8 with 3 assisted at 102.5kg must read 115.3, never 127.2. A set where every rep was assisted supports no estimate at all. The evidence carries the full count *and* the assisted figure, or the number cannot be reconciled.
- Two sets in one session tying on the estimate must return the SAME evidence on every request — the earlier set by position, not whichever the join emitted first.
- An exercise that carries no external load (plank, run) says so, rather than explaining rep-max divergence to somebody who never lifted a weight.
- The evidence table says "5 sets · 25 reps", never "5 × 25 reps" — `reps` is the session total and "×" reads as a multiplication.
- The heaviest set is not always the best estimate (1×110 vs 5×100). The chart's "Top set" and "Est. 1RM" must be free to point at different sessions.
- A known exercise the athlete has never trained returns `points: []` — **not** a 404, and the array must serialise as `[]` rather than `null`.
- An exercise id not in the catalog is a **404**. "You have never trained this" and "no such exercise" are different answers.
- Bad `from`/`to`/`tz`, or `to` before `from`, are 400s with `invalid_input`.
- More than 400 sessions: the **oldest** are dropped. The recent end of the chart is never silently truncated, and no session is cut in half and reported as a partial day.

### Auth / security

- Another athlete's sessions never appear, even when they trained the same exercise between two of yours. The user comes from the token; the path parameter names the exercise only.
- Unauthenticated requests are 401.
- The route lives under `/records` precisely so the per-user scoping is structural — a test that passes a friend's session id or user id anywhere must not change the result.

## Grip: mixed and hook (N9)

### Happy path

- A hinge (Conventional Deadlift), a carry (Farmer Carry) and an olympic lift (Clean) all show a grip picker, where before they showed none.
- A hinge offers regular / neutral / mixed / hook. A carry and an olympic lift offer regular / neutral / hook. A bench press still offers the original four.
- Choosing `mixed` on a deadlift round-trips: stored, pushed, read back, and shown on the web session view as "Mix".
- Tapping the selected chip still clears it back to unrecorded.

### Edge cases & errors

- **`mixed` is offered on hinges only.** A carry, an olympic lift and any press must not offer it.
- **`neutral` must stay on hinges and olympic lifts** — 20 of 55 hinge rows are kettlebell, dumbbell or hex-bar, and 12 of 25 olympic rows are kettlebell or dumbbell. Neither is a majority (olympic is 13 barbell), so removing either value as a "tidy-up" strands a real half of the bucket.
- A set already holding a grip the movement would not offer (a `hook` recorded on a press, or a value from a newer server) **still shows a chip**, appended after the subset — otherwise it is visible in the summary and impossible to clear.
- An unknown grip from a newer server is **kept** locally, never nulled. The probe for this must be a value outside the *current* vocabulary — using one that has since been added makes the test pass while covering nothing. There are **three** such probes (`grip.test.ts`, `sessions.test.ts`, and `gripPush.test.ts`'s `FUTURE_GRIP`); N9 re-pointed one and review found the other two.
- The database accepts `mixed` and `hook` and rejects anything else, with the dedicated `invalid_grip` code rather than a generic `invalid_input`.
- Squats, lunges, jumps, core, mobility and conditioning still show no picker at all.

### Auth / security

- Unchanged: grip travels on the set, and every set path is already owner-scoped.

### Regression trap

- **The grip CHECK constraint's name must contain the substring `grip`.** `translatePgError` selects the `invalid_grip` wire code by matching it, and that code is what tells a stale client to drop the grip and retry. A migration that renames the constraint migrates cleanly, still refuses bad grips, and silently breaks every old client's self-repair.

## A rename landing mid-push (T7)

### Happy path

- Rename a session while offline, come back online: the new name reaches the server on the next sync.

### Edge cases & errors

- **Rename a session WHILE its push is in flight.** The push carries the old name (correct — it is what was snapshotted), and the row must still owe the name afterwards. The next push must deliver the new one. Asserting only that a flag survived is a proxy; assert the server ends up with the new name.
- After that second push the row must go clean, or the same PATCH is re-sent on every foreground forever.
- A session renamed before its first push is CREATED with the new name — there is no PATCH to race, and none should be sent.
- A session deleted while its push is in flight still owes the delete (T6), and the two guards compose: a rename and a delete racing the same push must both survive.

### Regression trap

- **Nothing may clear `dirty` or `name_dirty` outside the guarded terminal swap.** A declined swap has to leave the row owing everything it owed; clearing part of that debt elsewhere makes "declined" mean "partly sent", and the half that was cleared is lost permanently because the pull's newer-than guard stops reconciliation.

## The competitive record (`/v1/contests`)

### Happy path

- Record an entry with a name, a sport, a date, a division, a placement out of a field and three matches; read it back and get every field, with the matches in the order they were sent.
- Record an entry with a **placement alone and no matches** — an ordinary entry logged from memory, not an edge case. `matches` comes back as `[]`.
- Record an entry with **no date at all**. It is accepted, and it sorts last in the list rather than being refused or floated to the top.
- Two entries for the same tournament on the same day (gi and no-gi) are two independent rows, each with its own division and result.
- List returns newest first, undated last, each entry carrying its own matches and nobody else's.
- Replace an entry with PUT: the fields change and **every match is replaced**, including three-down-to-one and down-to-none.
- Delete an entry; its matches go with it.

### Edge cases & errors

- **`placement` without `entrants`, and `entrants` without `placement`**, are both accepted — the pair is not all-or-nothing.
- `placement` greater than `entrants` is refused ("2nd of 1"), by the API and by the database's own CHECK.
- `placement: 0` and negatives are refused. Null means *not recorded*, never "did not place" — a client must not send a sentinel to express that.
- A `placement` above the INTEGER ceiling is a **400 naming the field, never a 500**. It overflows as SQLSTATE 22003, which carries no constraint name, so it is the one out-of-range value a constraint-name translator cannot see.
- A large but real placement (41,203rd of 60,000 in a road race) is accepted — the ceiling is the column's, not a guess about brackets.
- An unknown `sport` is refused, and so is `nutrition` — a real module, and a nonsense sport.
- An unknown `format`, `result` or `method` is refused; an **empty** `format` or `method` is accepted, because a 10k has no format and an entry logged from memory has no recorded method.
- `technique_id` on a match whose method is not `submission` is refused, not silently dropped.
- `technique_id` naming a technique that does not exist is a **400, not a 500** — and the entry must not be left behind by the failed write.
- A blank `held_on` or `technique_id` (what a cleared form field sends) is treated as absent rather than refused.
- More than 64 matches is refused. Field lengths are capped in **characters, not bytes**: a name of 120 multibyte characters is accepted and 121 is refused.
- An oversized request body is refused as a 400 without being read into memory.

### Auth / security

- Every endpoint requires a signed-in caller.
- Reading, updating or deleting **another account's entry id** answers exactly as a nonexistent id does — a 404 either way, so the API never confirms an id exists.
- A refused cross-account update leaves the owner's row byte-for-byte unchanged; asserting the error alone is a proxy for that, not proof of it.
- One account's list never contains another's entries, and one entry's matches never attach to another entry.

### Regression trap

- **`position` is assigned by the server from array order and must never be accepted from a client.** It is what makes "lost in the final" different from "lost the first match", and the wire format deliberately has no field for it — if one is ever added, the uniqueness of a position stops being unviolatable from outside.
- **The write's read-back must run inside the transaction.** Reading it through the pool takes a connection that cannot see the uncommitted rows, so a successful create returns an empty `matches` array — a silent wrong answer, not an error. A test that only checks the status code passes against it.
- **Nothing self-rated may be added to these payloads.** Everything here is externally verifiable, which is what makes a contest the strongest measured evidence the app holds; an RPE field would quietly demote it. How it felt belongs on the session.

## BJJ accomplishments (`GET /v1/bjj/accomplishments`)

### Happy path

- A new account gets `[]` — the ordinary state of somebody who has not competed or logged a reflection yet, not an error.
- A single gold medal won by submission earns **all five** competition awards at once (entered, won a match, won by submission, podium, gold), each carrying the contest's name, placement and field size.
- Landing a technique live earns `first_scored`; the award points at the session and names the technique.
- Drilling a technique in one session and landing it live in a **later** one earns `first_drilled_scored`.
- The list reads as a career: earliest first, mat awards before competition ones for a typical athlete.
- Correcting or deleting the evidence **retracts** the award — nothing is stored, so a deleted contest removes its five awards on the next read.

### Edge cases & errors

- **A powerlifting meet or a 10k earns nothing.** `contests` is cross-sport; only BJJ entries count here.
- **Fourth place is not a podium**, and an **unrecorded placement is neither a podium nor a miss** — null means "not recorded", never "did not place".
- **Third is a podium but not gold.**
- **"First" means earliest HELD, not earliest entered.** Somebody typing up a decade of history enters entries in any order; the 2019 entry must win `first_competition` even when the 2026 one was recorded first.
- **An undated contest does not steal "first".** A null date sorts last, not as the beginning of time — otherwise whichever entry merely lacked a date would claim the award.
- An undated award is still returned and must still be rendered; it simply carries `achieved_on: null`.
- **A score with no named technique still counts** — "got the sweep" without saying which is evidence the schema deliberately accepts, and refusing it would punish the fast logging path. Both `technique_id` and `technique_name` come back null.
- **Drilling and landing something in the same session is not a graduation.** Strictly-earlier is the award's whole meaning.
- **Drilling one technique does not graduate a different one.**
- A tag hanging off a non-BJJ session is not mat evidence.
- A technique retired from the library leaves the award intact with a null `technique_name` — the record outlives the catalog entry.
- `tz` decides which calendar day a session-derived award falls on: a session at 02:00 UTC on the 15th is the **14th** in `America/Los_Angeles`. An invalid zone, or `Local`, is a 400.
- `tz` is optional and defaults to UTC — the competition half does not need it, since those dates are already calendar dates.

### Auth / security

- Requires a signed-in caller; one account never sees another's awards.
- **There is no write verb, and there must never be one** — not even an admin grant. An accomplishment that can be granted stops being evidence, and makes every other one a claim rather than a fact.

### Regression trap

- **Every kind must have a declared basis.** A default arm would pick one for a kind nobody classified, and the flattering answer is the likely default — a self-reported award rendering as `measured` is the one wrong answer this endpoint must never give.
- **Nothing may rank or score these.** `basis.go`'s first reading rule forbids a measured award being judged by a reported one, and a leaderboard over this list is exactly that. The list is chronological on purpose.
- **`ORDER BY` inside a `UNION` branch must stay parenthesised.** Unparenthesised it applies to the whole union along with the `LIMIT`, returning one row for the entire result rather than one per kind — it parses, it runs, and it is wrong.

## The BJJ finish card's accomplishment badge (mobile)

### Happy path

- Finish a BJJ session in which the athlete landed a technique live for the first time ever: the celebration card shows **First technique landed**.
- Land a technique drilled in an earlier session, for the first time: the card shows **First drilled technique landed live**.
- Earn both at once (first-ever score, of something drilled weeks ago): the badge reads **2 firsts** rather than picking one.
- Finish an ordinary BJJ session that earned nothing: **no badge at all**, which is the common case and the design.

### Edge cases & errors

- **A competition award never appears on a session card.** Winning gold earns `first_gold`, which carries a contest and no session — it must not surface on whichever mat session is logged next.
- An award belonging to a *different* session never appears on this one.
- **Offline, no badge and no claim.** The card opens on local numbers and nothing is asserted — silence is not a claim, a wrong medal is. **The lookup must still SETTLE on failure**, matching the strength card: otherwise a carried streak renders its line and never chimes, forever, because one endpoint failed.
- **A first earned by the session just finished may be missed**, and this is a known limitation rather than a bug to assert against: the sync push is fire-and-forget, so the server can answer "no firsts" before that session's rows land. Nothing refetches. Strength personal records have the identical exposure.
- A kind the installed build does not know (server vocabulary ahead of the app) renders as "A first" rather than an empty badge.
- The card must never show a badge and a personal-record badge together — a session is one sport, so they cannot both exist. If both ever did, the **record** wins: the measured thing outranks the reported one.
- **The badge is announced to a screen reader.** It arrives after the card renders, and on the mat it is the only representation of the first — without a live region a VoiceOver athlete gets the flares and the chime and no words.

### Regression trap

- **An accomplishment must latch the streak chime out.** It takes the personal record's slot in the precedence, so `celebratesStreak` has to be passed "earned a badge of either kind", not the records-only flag. Passing the records flag chimes the streak straight over a BJJ first, and every existing test still passes.
- **`recordsSettled` is no longer true by construction on BJJ.** There is now a real network lookup that can answer late; hard-coding it true lets a fast history chime the streak and latch the first out — the exact race the strength card documents.
- **The phone must not decide what counts as a first.** It filters the server's awards by `session_id`; re-deriving the rule locally is a second opinion that can disagree with the accomplishments list elsewhere in the app.
