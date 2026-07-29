# Formspan

Formspan is a unified training and nutrition platform for BJJ athletes who also strength train and track nutrition — one athlete profile and calendar connecting BJJ, strength training, and nutrition, with deterministic, explainable cross-sport recommendations.

- [docs/decisions/history.md](docs/decisions/history.md) — chronological project history: what's been built, why, and what's still open. Start here if you're new to this repo.
- [docs/testing/functional-scenarios.md](docs/testing/functional-scenarios.md) — recommended functional test scenarios per feature.
- [docs/architecture/deployment.md](docs/architecture/deployment.md) — dev/staging/production environment setup.
- [docs/architecture/api-conventions.md](docs/architecture/api-conventions.md) — REST/OpenAPI conventions.
- [contracts/public.openapi.yaml](contracts/public.openapi.yaml) — the wire contract.

This repo is a pnpm + Go monorepo, built incrementally, one verified piece at a time.

## Current state

- `backend/` — Go API (`cmd/api`), stdlib `net/http`. `/v1/healthz` (public), `/v1/me`, `/v1/profile` (CRUD), `/v1/flags` (read-only, server-controlled feature flags), `/v1/activities` (create/list — the unified activity envelope, idempotent create for offline sync), `/v1/admin/users` + `/v1/admin/users/{userID}/activities` (admin-only, gated by a Clerk-user-ID allowlist). Structured JSON logging with request-ID/W3C-trace-context correlation on every request. Real Postgres via `golang-migrate` migrations (`backend/migrations/`), both locally (`docker-compose.yml`) and on a real Railway `staging` Postgres.
- `apps/web/` — Next.js customer app: Clerk sign-in, `/dashboard` (sidebar shell, one destination so far) showing a live API health check and the caller's synced activities.
- `apps/mobile/` — Expo/React Native app (Expo Router, Expo Go). No auth yet — that's next up. One `Today` tab showing a live API health check.
- `apps/admin/` — Next.js admin console, fully separate from `apps/web` (not athlete-facing). `User Lookup`/`User Detail` screens exist but still run on mock data — wiring them to the real `/v1/admin/*` endpoints above is in progress.
- `tests/functional/` — a Playwright-based functional test suite (user-authored, in progress).

### Run it locally

```bash
docker compose up -d              # local Postgres on :5432
cd backend && go run ./cmd/migrate up

pnpm run dev:api                  # backend API on :8080
pnpm run dev:web                  # web app on :3000
pnpm run dev:mobile               # Expo — Metro on :8081, press i/a/w for iOS Sim/Android/web
pnpm --filter admin dev --port 3001   # admin console on :3001 (needs its own port — apps/web also defaults to :3000)
```

Then open http://localhost:3000 (web) or http://localhost:3001 (admin). Each app needs its own `.env.local` (copy from `.env.example`) — the admin console additionally needs `ADMIN_EMAILS` set to your Clerk sign-in email before `/users` will let you in.
