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
- Signed-out visit to `/` shows the "Formspan" landing with a sign-in button (no sidebar).
- After signing in, landing on `/dashboard` shows the sidebar (wordmark, nav, account menu) plus a live healthz check and the authenticated `/me` result.
- Signed-in visit to `/` redirects straight to `/dashboard` (no dead-end landing page for authenticated users).

**Edge cases & errors**
- Signed-out visit directly to `/dashboard` (e.g. a bookmarked/shared link) redirects to Clerk's hosted sign-in, then lands back on `/dashboard` after completing sign-in (`redirect_url` round-trip).
- Backend unreachable while on `/dashboard` → the page shows "Failed to reach API: ..." rather than an unhandled exception or blank screen.
- Sign-out from `/dashboard` returns the user to a fully signed-out state — reloading `/dashboard` afterward redirects to sign-in again, it doesn't serve stale authenticated content from cache.

---

## Mobile app shell (`apps/mobile`)

**Happy path**
- App launches in Expo Go to the "Today" tab, showing the "Formspan" heading.
- Today screen fetches `${EXPO_PUBLIC_API_URL}/v1/healthz` and renders "API says: api is ok" once it resolves.

**Edge cases & errors**
- Backend unreachable → screen shows "Failed to reach API: ..." instead of hanging on "Loading API status…" forever or crashing.
- Verified on both the Simulator (loopback) and, once relevant, a physical device on the same LAN (`EXPO_PUBLIC_API_URL` pointed at the dev machine's LAN IP rather than `localhost`).

---

## Admin app shell (`apps/admin`)

Domain: fully separate from `apps/web`, not athlete-facing. Reuses the same Clerk instance; gated by both middleware (must be signed in) and an `ADMIN_USER_IDS` allowlist check matching the backend's own. **Runs on real backend data** (`/v1/admin/users`, `/v1/admin/users/{userID}/activities`) — no mock data anywhere in this app.

**Happy path**
- Signed in as an allowlisted admin, `/users` (User Lookup) lists every user with a profile: user ID, display name, activity count, last-activity timestamp — all from Postgres.
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
- `apps/admin` doesn't call the backend at all yet (mock data only — see the admin shell entry above), so there's nothing to wire there.
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

## Activity module + real backend admin authorization (`/v1/activities`, `/v1/admin/*`)

Domain: the unified "activity envelope" (one table, `kind` + flexible `details` JSONB, not per-sport tables) — Phase 1 of the first end-to-end vertical slice (log on mobile → sync → display on web → find + trace in admin). Also the first real backend-side admin authorization: `RequireAdmin` (Clerk user ID allowlist via `ADMIN_USER_IDS`), closing a gap flagged when the admin console shipped mock-only.

**Happy path**
- `POST /v1/activities` with a valid bearer token and `{id, kind, occurred_at, notes?, details?}` creates the activity, stamped server-side with the caller's `user_id` and the current request's own `request_id`/`trace_id` — `200` with the full row.
- `GET /v1/activities` returns the caller's own activities, newest `occurred_at` first.
- `GET /v1/admin/users` with an `ADMIN_USER_IDS`-listed token returns every user with a `profiles` row (LEFT JOIN `activities`) — `user_id`, `display_name`, `activity_count`, `last_activity_at` — including users with zero activities yet.
- `GET /v1/admin/users/{userID}/activities` with an admin token returns that specific user's activities, each with its `request_id`/`trace_id` — the "trace the request" mechanism: grep the backend's own log output for that ID to see the full request that created it.

**Edge cases & errors**
- **Idempotent create**: `POST`ing the same `id` twice (a real offline-sync retry scenario) returns the *original* row both times — same `request_id`, same `created_at` — never a duplicate, never an error. Verified directly: two live `curl` calls with the same `id` returned byte-identical `request_id`/`created_at`.
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
