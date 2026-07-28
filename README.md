# Formspan

Formspan is a unified training and nutrition platform for BJJ athletes who also strength train and track nutrition — one athlete profile and calendar connecting BJJ, strength training, and nutrition, with deterministic, explainable cross-sport recommendations. See [docs/architecture/deployment.md](docs/architecture/deployment.md) for how dev/staging/production are set up; more architecture docs land here as they're built.

This repo is a pnpm + Go monorepo. It's being built incrementally, starting from a minimal "hello world" and adding one piece at a time.

## Current state: Increment 1 — hello world

- `backend/` — Go API (`cmd/api`), currently just a `GET /healthz` endpoint
- `apps/web/` — Next.js customer web app, currently just a page that fetches `/healthz` from the API and displays it

### Run it

```bash
# terminal 1 — backend API on :8080
pnpm run dev:api

# terminal 2 — web app on :3000
pnpm run dev:web
```

Then open http://localhost:3000 — it should show the API's health response.
