# Formspan — instructions for Claude Code

Formspan is a unified training and nutrition platform for BJJ athletes who also strength train and track nutrition — one athlete profile and calendar connecting BJJ, strength training, and nutrition, with deterministic, explainable cross-sport recommendations.

**Start here for full context:** [docs/decisions/history.md](docs/decisions/history.md) — chronological narrative of what's been built and why. `docs/architecture/*.md` hold the current-state detail this file only summarizes.

## Repo map

- `backend/` — Go modular monolith, stdlib `net/http` (no web framework, deliberately). `cmd/api`, `cmd/migrate`. `internal/modules/*` per domain, `internal/platform/*` for cross-cutting concerns (`auth`, `database`, `apihttp`).
- `apps/web/` — Next.js customer app, Clerk auth. `/dashboard(.*)` is server-side gated by `proxy.ts` (Clerk middleware `auth.protect()`); `app/dashboard/` holds the sidebar shell (`layout.tsx`) + destinations (only `Dashboard` wired so far, matching the mobile shell's single-tab scope). Root `/` is the public entry — redirects signed-in users to `/dashboard`, shows sign-in otherwise. Tailwind CSS v4 for styling.
- `apps/mobile/` — Expo (managed workflow, Expo Go — not a custom dev client yet) + Expo Router (file-based, `app/(tabs)/` for the tab navigator). No auth yet. `EXPO_PUBLIC_*` env var convention (RN equivalent of Next's `NEXT_PUBLIC_*`).
- `apps/admin/` — Next.js admin console, fully separate from `apps/web` (not athlete-facing). Reuses the **same Clerk instance** as `apps/web`; `/users(.*)` is gated two ways — `proxy.ts` requires sign-in, `app/users/layout.tsx` additionally checks the signed-in email against the `ADMIN_EMAILS` allowlist env var (no roles/orgs yet). Only `User Lookup` (`/users`) and `User Detail` (`/users/[id]`) exist so far, matching what's actually been designed. **No backend wiring yet** — `lib/mock-users.ts` is explicit, temporary static data (subscriptions/device-platform/integrations/support-tickets have no real system behind them at all yet); real data is future work, tracked in `docs/decisions/history.md`. Visual design (colors, Barlow/Barlow Condensed fonts, component styles) comes from a shared hi-fi design file — tokens live in `app/globals.css`'s `@theme` block. **Note:** `apps/web`'s current visual style predates this design system and does not yet follow it — reconciling that is a separate, not-yet-started piece of work.
- `tests/functional/` — Playwright functional test suite (user-authored, in progress — evolving, don't assume its current shape without checking).
- `docs/testing/functional-scenarios.md` — recommended functional test scenarios per feature, meant to be translated into `tests/functional/` (or mobile's equivalent). A living doc, not `tests/functional/` itself — safe to update even when the test suite's own shape is uncertain.
- `contracts/public.openapi.yaml` — hand-maintained OpenAPI spec (not generated).
- `railway/*.toml` — per-service Railway config. **Only exists for services with real code behind them** — don't create a config for a service that has no binary/app yet.
- `docs/architecture/` — current-state docs (deployment, API conventions). `docs/decisions/history.md` — the project narrative.

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

Before every push, run the full local check suite (matches CI exactly):

```bash
pnpm run fmt:api && pnpm run vet:api && pnpm run build:api && pnpm run test:api
pnpm run lint:openapi
pnpm run lint:web && pnpm run typecheck:web && pnpm run build:web
docker build -f backend/Dockerfile backend   # if Docker/Colima is available
```

Then: `git push -u origin <branch>`, `gh pr create`, watch CI with `gh run watch <run-id> --exit-status`.

**Never merge a PR without the user's explicit go-ahead, even if CI is green.** This has been the rule for every PR in this project — don't treat a passing CI run as implicit merge permission.

## Keep the history log current (hard rule)

[docs/decisions/history.md](docs/decisions/history.md) is a living document, not a one-time snapshot. Whenever a PR lands (or right before merging one) that represents a material decision or a notable chunk of work — a new module, a new convention, an infrastructure change, a bug found and fixed, a provider/tooling choice — **append a dated entry** to it in the same style as the existing entries: what was decided/built, why, and any open questions or gaps it leaves behind. Do this as part of finishing the work, not as an afterthought someone has to remember to ask for. Skip it only for truly trivial changes (typo fixes, formatting) that don't represent a decision anyone would need to know about later.

## Keep functional test scenarios current (hard rule)

[docs/testing/functional-scenarios.md](docs/testing/functional-scenarios.md) is a living document, same discipline as `docs/decisions/history.md`. Whenever a new module or user-facing feature lands — a new backend endpoint, a new web route/page, a new mobile screen — **add its recommended scenarios** (happy path, edge cases & errors, and auth/security where relevant) as part of finishing that work. Don't write the actual Playwright/test code yourself unless asked — `tests/functional/` is the user's own in-progress suite; this doc is the reference list they (or a future session) translate into real tests. Skip it only for changes with no user-facing or API-surface behavior (refactors, docs, CI tweaks).

## Local dev setup

```bash
docker compose up -d                       # local Postgres on :5432 (Colima-backed Docker, not Docker Desktop)
cd backend && go run ./cmd/migrate up
pnpm run dev:api                            # :8080
pnpm run dev:web                            # :3000
pnpm run dev:mobile                          # Expo — Metro on :8081, press i/a/w for iOS Sim/Android/web
pnpm run dev:admin                          # :3001 (or next available port — runs alongside apps/web)
```

Env vars come from real files, never baked into images: `backend/.env` / `backend/.env.example`, `apps/web/.env.local` / `apps/web/.env.example`, `apps/mobile/.env.local` / `apps/mobile/.env.example`, `apps/admin/.env.local` / `apps/admin/.env.example` — all gitignored except the `.example` templates. `backend/.env.staging.local` holds real Railway `staging` Postgres credentials (gitignored, never commit).

The backend's CORS (`withCORS` in `cmd/api/main.go`) allows multiple comma-separated origins via `WEB_ORIGIN` (not just one) — needed once the Expo web preview (`:8081`) joined `apps/web` (`:3000`) as a second browser-based local client. Only matters for browser clients; native iOS/Android requests aren't subject to CORS at all.

## Known gotchas

- **`secrets.txt`** may show up untracked in the repo root containing what looks like a live API key. Never stage or commit it — flag it to the user instead.
- This Next.js version renamed the `middleware.ts` file convention to `proxy.ts` (same `clerkMiddleware()` export, just a renamed file). Separately: `next dev --hostname 127.0.0.1` breaks when a `proxy.ts`/`clerkMiddleware()` is present — Next's Proxy runtime tries to self-fetch via `localhost` internally and fails (`ECONNRESET`, surfaces as a 500). Use `--port` alone when running concurrent dev instances; never pass `--hostname`.
- pnpm blocks native build scripts (`sharp`, `unrs-resolver`, etc.) by default — they need explicit `allowBuilds: true` entries in `pnpm-workspace.yaml` or installs fail.
- Railway: real project `formspan` exists, with a `staging` environment holding a real Postgres (migrations already applied there). No `production` Postgres yet, and no `api`/`web` services deployed to Railway yet — only Postgres. An **unrelated pre-existing project, `dynamic-trust`** (service `medical-portal-api`), sits in the same Railway account — it is not ours; never touch it.
- **Metro/Expo Go IPv6 vs IPv4 loopback mismatch**: Node resolves the hostname `localhost` to IPv6 first by default, so a plain `expo start` binds Metro only to `::1:8081`. But Expo's `--localhost` flag generates the Expo Go deep link using the literal IPv4 address `127.0.0.1`, so Expo Go can never connect — a total, silent mismatch, not a firewall/network issue. Fixed by prefixing `NODE_OPTIONS=--dns-result-order=ipv4first` on every `apps/mobile/package.json` script (`start`/`android`/`ios`/`web`), forcing Metro to bind IPv4 first. Diagnose with `lsof -i :8081 -P -n` — look for `127.0.0.1:8081` vs `[::1]:8081`.

## Where to look for more

- [docs/decisions/history.md](docs/decisions/history.md) — full chronological narrative
- [docs/architecture/deployment.md](docs/architecture/deployment.md) — environments, Railway topology, migrations
- [docs/architecture/api-conventions.md](docs/architecture/api-conventions.md) — full REST/OpenAPI conventions
- [contracts/public.openapi.yaml](contracts/public.openapi.yaml) — the wire contract
- [docs/testing/functional-scenarios.md](docs/testing/functional-scenarios.md) — recommended functional test scenarios per feature
