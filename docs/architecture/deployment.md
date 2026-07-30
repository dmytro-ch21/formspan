# Environments & deployment

Status as of this doc: the pieces below marked **built** exist in this repo and are checked into git. Everything marked **planned** is the agreed direction (see the Railway proposal this was derived from) but hasn't been created on Railway yet — no live staging/production services exist yet.

## Development — built

Runs directly on a developer's machine, no Railway environment:

```bash
docker compose up -d   # local Postgres on :5432
cd backend && go run ./cmd/migrate up
pnpm run dev:api        # Go API on :8080
pnpm run dev:web        # Next.js on :3000
```

Config comes from real env vars / `.env.local` (see `backend/.env.example` and `apps/web/.env.example`), not baked into images. `apps/web/.env.local` is gitignored and points `NEXT_PUBLIC_API_URL` at `http://localhost:8080`. Local Docker runs via Colima (CLI-only, no Docker Desktop) — see `docker-compose.yml` at the repo root for the Postgres service definition.

## Staging & production — Postgres is real now, application services still not provisioned

Railway project `formspan` exists — still under its pre-rename name; the VOLA rename covered the repo and code, not the external service accounts (`staging` and `production` environments — no permanent Railway environment for local dev, that's the section above). Current service topology:

| Service | Public? | Config |
|---|---:|---|
| `api` | Yes | `railway/api.toml` — config built, **service created on Railway `staging` (api live; web/admin in progress)** |
| `web` | Yes | `railway/web.toml` — config built, **service created on Railway `staging` (api live; web/admin in progress)** |
| `admin-web` | Yes, authenticated | not built — no admin app exists yet |
| `admin-api` | No | not built — no admin-api binary exists yet |
| `worker` | No | not built — no worker binary exists yet |
| `scheduler` | No, cron | not built — no scheduler binary exists yet |
| `postgres` | No | **real**, in the `staging` environment — migrations applied (`profiles` table exists there too, not just locally). Shared for dev/staging testing purposes for now; no separate `production` Postgres yet. |
| `redis` | No | not built — not needed yet |
| `files` | No | not built — no object storage usage yet |

The `staging` environment's Postgres credentials live in `backend/.env.staging.local` (gitignored, never commit). `DATABASE_URL_PUBLIC` works from anywhere (Railway's TCP proxy) — useful for manually running `migrate` against staging from local dev. `DATABASE_URL_INTERNAL` only resolves from inside Railway's network, for when the `api` service itself is deployed there.

Add each service's `railway/*.toml` and wire it into the Railway dashboard only once the corresponding code exists (`admin-api`, `worker`, `scheduler` binaries, the admin Next.js app) — no point configuring a deploy target for a binary that doesn't exist.

### How `api` and `web` deploy (once actually connected to Railway)

Both are services on the same repo, but with different root directories:
- `api` — root directory `backend/`, builds via `backend/Dockerfile` (Docker builder). One image; `go build -o /app/bin/ ./cmd/...` picks up every `cmd/*` binary automatically as more get added (`admin-api`, `worker`, `scheduler`, `migrate`), so the same Dockerfile will serve those services later without changes — only their `railway/*.toml` start command differs. Root directory is scoped to `backend/` (not the repo root) so the build context is just the Go module, not the whole monorepo.
- `web` — root directory repo root (a pnpm workspace member can't build standalone without the root lockfile), builds via Nixpacks (auto-detected Node/Next.js), running `pnpm run build:web` / `pnpm --filter web start`.

### Domains (planned)

Public: `web.yourdomain.com`, `api.yourdomain.com`, `admin.yourdomain.com` (none registered yet — placeholders in `.env.example` files). Everything else (`admin-api`, `worker`, `scheduler`, `postgres`, `redis`) stays on Railway's private internal networking, never public.

### Migrations — tooling built, applied everywhere that currently has a database

`cmd/migrate` (golang-migrate, plain versioned SQL in `backend/migrations/`) runs today against: local docker-compose Postgres, CI's ephemeral Postgres service container, and the real Railway `staging` Postgres. On Railway it runs exactly once per deploy, as the `api` service's pre-deploy command — never independently from `worker`/`admin-api`, to avoid concurrent-migration conflicts.

That command is `/app/bin/predeploy`, a script baked into the image that runs `migrate up` and then `seed`. It is a **single token** deliberately. The previous value, `"/app/bin/migrate up && /app/bin/seed"`, ran migrations and silently never ran the seed: Railway executes `preDeployCommand` as argv without a shell, and discarded everything from `&&` onward. Migrations applied, the healthcheck passed, and staging served an empty exercise catalog behind a green deploy. Only counting rows in the deployed database surfaced it.

The seed is part of pre-deploy rather than a one-off because migration 000004 creates an empty `exercises` table; without it the API serves `{"exercises": []}` forever, which no healthcheck or error can distinguish from working. It is idempotent, so running it on every deploy is the intended usage.

### PR / preview environments (planned, deferred)

Not set up yet. When added, they must use separate database/bucket instances from staging and production — never production data.

## Why this split

Solo-developer constraint: local dev needs zero cloud dependency so iteration stays fast and free; staging/production need to exist to catch integration issues before users hit them, but only for services that actually have code behind them — provisioning a Railway service for `worker` before a worker binary exists would just be an empty box to maintain.
