# Formspan

Formspan is a unified training and nutrition platform for BJJ athletes who also strength train and track nutrition — one athlete profile and calendar connecting BJJ, strength training, and nutrition, with deterministic, explainable cross-sport recommendations.

- [docs/decisions/history.md](docs/decisions/history.md) — chronological project history: what's been built, why, and what's still open. Start here if you're new to this repo.
- [docs/architecture/deployment.md](docs/architecture/deployment.md) — dev/staging/production environment setup.

This repo is a pnpm + Go monorepo, built incrementally, one verified piece at a time.

## Current state

- `backend/` — Go API (`cmd/api`): `/healthz`, `/me`, `/profile` (CRUD), behind Clerk-verified auth. Real Postgres via `golang-migrate` migrations (`backend/migrations/`), both locally (`docker-compose.yml`) and on a real Railway `staging` Postgres. (A `/v1` route prefix and structured error responses are landing separately — see the history log.)
- `apps/web/` — Next.js customer web app: Clerk sign-in/sign-up, calls the API's health and identity endpoints.
- `tests/functional/` — a Playwright-based functional test suite (in progress).

### Run it locally

```bash
docker compose up -d              # local Postgres on :5432
cd backend && go run ./cmd/migrate up

pnpm run dev:api                  # backend API on :8080
pnpm run dev:web                  # web app on :3000
```

Then open http://localhost:3000.
