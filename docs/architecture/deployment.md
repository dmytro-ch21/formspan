# Environments & deployment

Status as of this doc: the pieces below marked **built** exist in this repo and are checked into git. Everything marked **planned** is the agreed direction (see the Railway proposal this was derived from) but hasn't been created on Railway yet — no live staging/production services exist yet.

## Development — built

Runs directly on a developer's machine, no containers, no Railway environment:

```bash
pnpm run dev:api   # Go API on :8080
pnpm run dev:web   # Next.js on :3000
```

Config comes from real env vars / `.env.local` (see `backend/.env.example` and `apps/web/.env.example`), not a container. `apps/web/.env.local` is gitignored and points `NEXT_PUBLIC_API_URL` at `http://localhost:8080`.

## Staging & production — planned, not yet provisioned

One Railway project with `staging` and `production` environments (no permanent Railway environment for local dev — that's the section above). Planned service topology:

| Service | Public? | Config |
|---|---:|---|
| `api` | Yes | `railway/api.toml` — built |
| `web` | Yes | `railway/web.toml` — built |
| `admin-web` | Yes, authenticated | not built — no admin app exists yet |
| `admin-api` | No | not built — no admin-api binary exists yet |
| `worker` | No | not built — no worker binary exists yet |
| `scheduler` | No, cron | not built — no scheduler binary exists yet |
| `postgres` | No | not built — no database yet |
| `redis` | No | not built — not needed yet |
| `files` | No | not built — no object storage usage yet |

Add each service's `railway/*.toml` and wire it into the Railway dashboard only once the corresponding code exists (`admin-api`, `worker`, `scheduler` binaries, the admin Next.js app) — no point configuring a deploy target for a binary that doesn't exist.

### How `api` and `web` deploy (once actually connected to Railway)

Both are services on the same repo, but with different root directories:
- `api` — root directory `backend/`, builds via `backend/Dockerfile` (Docker builder). One image; `go build -o /app/bin/ ./cmd/...` picks up every `cmd/*` binary automatically as more get added (`admin-api`, `worker`, `scheduler`, `migrate`), so the same Dockerfile will serve those services later without changes — only their `railway/*.toml` start command differs. Root directory is scoped to `backend/` (not the repo root) so the build context is just the Go module, not the whole monorepo.
- `web` — root directory repo root (a pnpm workspace member can't build standalone without the root lockfile), builds via Nixpacks (auto-detected Node/Next.js), running `pnpm run build:web` / `pnpm --filter web start`.

### Domains (planned)

Public: `web.yourdomain.com`, `api.yourdomain.com`, `admin.yourdomain.com` (none registered yet — placeholders in `.env.example` files). Everything else (`admin-api`, `worker`, `scheduler`, `postgres`, `redis`) stays on Railway's private internal networking, never public.

### Migrations (planned, not applicable yet)

No database exists yet, so no migration binary or run-once rule applies today. Once Postgres is added: migrations run exactly once, as the `api` service's pre-deploy command (`/app/bin/migrate up`) — never independently from `worker`/`admin-api`, to avoid concurrent-migration conflicts. This becomes real when the Postgres increment lands.

### PR / preview environments (planned, deferred)

Not set up yet. When added, they must use separate database/bucket instances from staging and production — never production data.

## Why this split

Solo-developer constraint: local dev needs zero cloud dependency so iteration stays fast and free; staging/production need to exist to catch integration issues before users hit them, but only for services that actually have code behind them — provisioning a Railway service for `worker` before a worker binary exists would just be an empty box to maintain.
