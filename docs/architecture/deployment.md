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

**`cmd/migrate` refuses to migrate a database it cannot vouch for** (added after the 2026-08-20 incident, issue #465). An unmerged branch's `000069`–`000071` were applied to the staging Postgres by hand; staging's recorded version went to 71 while `main` topped out at 70, and every subsequent `api` deploy died in this pre-deploy phase with `no migration found for version 71`. The API stayed up on its last container, so it failed as a *stale* environment rather than a down one, and nothing went red on a dashboard for forty minutes. CI could never have caught it: the `Backend (Go)` job migrates a throwaway database that starts at zero, so a collision against a real environment is invisible there and stays green forever.

The guard: `up` against a **non-local** database requires the migration files to be byte-identical to `origin/main`, and `down` against one is refused outright. **The Railway path needs nothing set.** `backend/Dockerfile` links the binary with `-X …/migrateguard.BuildChannel=deploy`, so the image attests to its own provenance and never looks for a git repository it does not have — if you ever replace that build line, keep the `-ldflags`, or every deploy will refuse to migrate. There is deliberately no environment variable that disables the guard: anything readable from a shell would be exported in a shell profile within a fortnight. `migrate status` is read-only and always allowed, and is the right thing to point at staging when you need to know its version. Detail in `backend/internal/platform/migrateguard`.

The seed is part of pre-deploy rather than a one-off because migration 000004 creates an empty `exercises` table; without it the API serves `{"exercises": []}` forever, which no healthcheck or error can distinguish from working. It is idempotent, so running it on every deploy is the intended usage.

### Exercise media — R2, and why replacing a picture is not enough

Assets live in a Cloudflare R2 bucket. Only the **storage key** is in Postgres (`exercise_media.storage_key`); the API assembles the public URL at read time from `MEDIA_BASE_URL`, so moving bucket or CDN is an env-var change rather than a data migration.

**Replacing the bytes at a key does not, on its own, reach anyone.** Storage keys are stable by design — an exercise's thumbnail is `.../thumbnail.webp` for as long as the exercise exists — so a re-upload leaves the URL byte-identical and every cache in the path keeps serving the old picture. Three layers, in the order they bite:

1. **`expo-image`'s disk cache on the phone.** Keyed by URL, and it **never revalidates**. A device that loaded the old image keeps it until the app is deleted. There is no in-app cache-clear. This is the one that makes the problem permanent rather than temporary.
2. **Cloudflare's edge.** Serves what it has for as long as it considers it fresh.
3. **No `Cache-Control` on the objects.** R2 returns only `ETag` and `Last-Modified`, so caches fall back to *heuristic* freshness — commonly ~10% of the age since `Last-Modified`, which lengthens as the file gets older and is unpredictable by design.

So the API versions the URL: `?v=<exercise_media.updated_at as unix seconds>`. New bytes become a new resource, which is the one lever all three layers honour. The bucket ignores the parameter and returns the object — verified against the live bucket, same `ETag`, HTTP 200.

**Clients must treat `url` as opaque.** Reconstructing it from `storage_key` throws the version away and reinstates the whole problem.

#### How to actually replace an image

**Preferred: change the storage key.** Put a content hash in the filename — `thumbnail.a3f9c1.webp`. The seed's upsert only writes when `(storage_key, content_type, width, height)` differ, so a new key bumps `updated_at`, touches the parent exercise's `updated_at` (which is what lets a delta-syncing client learn an image changed at all), and produces a new URL. No manual step, and it makes the stale-cache failure structurally impossible.

Storage keys are validated at seed time against `^[a-z0-9/._-]+$`. `?` and `#` are rejected rather than escaped because both break the assembled URL silently — a `?` truncates the path, and a `#` makes everything after it a fragment the server never receives, which turns cache-busting off for that one asset with nothing reporting it.

**If you must keep the filename**, uploading to R2 touches nothing in Postgres, and re-running `cmd/seed` will *not* help — its `IS DISTINCT FROM` guard sees identical values and suppresses the update. Bump both rows by hand:

```sql
UPDATE exercise_media SET updated_at = now()
WHERE storage_key = 'exercises/barbell-back-squat/thumbnail.webp';

-- The parent too. `upsertMedia` deliberately touches it whenever media
-- changes, because a client delta-syncing on `exercises.updated_at` would
-- otherwise never learn an image was swapped — the exercise row itself didn't
-- change. Bumping only the media row reintroduces exactly that blind spot.
UPDATE exercises SET updated_at = now()
WHERE id = 'barbell-back-squat';
```

(No client delta-syncs yet — mobile refetches the whole catalog — so today only the first statement is load-bearing. The second is what stops this runbook silently defeating the delta sync the moment one exists.)

To verify what R2 actually holds, bypassing every cache:

```bash
curl -sI "$MEDIA_BASE_URL/exercises/.../thumbnail.webp?bust=$(date +%s)" | grep -iE 'etag|last-modified'
```

#### Two things to fix before real users

- **`MEDIA_BASE_URL` currently points at an `r2.dev` URL.** That is Cloudflare's *development* endpoint: rate-limited, and — the part that matters — it has **no zone, so there is no cache-purge API for it**. Once the edge holds an object you wait it out. A custom domain on the bucket restores purge and `Cache-Control` control. Cloudflare documents r2.dev as development-only.
- **Set `Cache-Control` at upload time.** With versioned URLs the right value is `public, max-age=31536000, immutable` — cache forever is correct precisely because a given URL can never mean different bytes.

The per-sport placeholders in `defaultMedia` have no database row, so their version comes from the hand-maintained `defaultMediaRevision` constant. **Bump it when you replace a `_defaults/` asset**, or those are the one set of images that can never change.

### Which environment the console writes to

Content authored in the admin console is live immediately, so the operator has
to be able to see which database they are editing. Two variables, set together:

| Variable | What it does |
| --- | --- |
| `NEXT_PUBLIC_API_URL` | **The actual switch** — which backend the console talks to. |
| `NEXT_PUBLIC_CONTENT_ENV` | **The label** — `local`, `staging` or `production`, shown as a badge in the masthead on every screen. |

**Currently staging**, because there is no production Postgres yet. Moving to
production is changing both, in whatever sets them for that deployment.

They are two variables rather than one derived from the other on purpose: a
badge that guessed the environment from the API hostname would be a rule that
holds until someone adds a domain, and being wrong is exactly what it exists to
prevent. The cost is that they can disagree — set them together, and note that
nothing yet asserts they match.

Unset behaves deliberately: against a `localhost` API it shows "Local" quietly,
and against a remote one it shows **"Unlabelled environment"** in red rather
than inventing a reassuring default.

### Content snapshots — the backup for console-authored content

Content written in the admin console is live immediately and lives **only in
that environment's database**. `//go:embed` seeds a fresh environment from
`techniques.json` / `exercises.json`, so a console-authored row is in neither
until it is exported. `.github/workflows/content-snapshot.yml` does that on a
schedule (04:00 UTC daily, plus `workflow_dispatch`) and opens a single
force-updated pull request.

**It is a backup, not a publish.** Athletes see a console edit the moment it
saves. The snapshot decides two other things: whether a *fresh* environment
would have the content, and whether it survives losing the database.

**Setup — one manual step, and until it is done the job skips.** Add a
repository secret named `CONTENT_DATABASE_URL` pointing at the environment where
content is authored (production once it exists; `staging` in the meantime).
Without it the workflow reports "not configured" and exits green, deliberately:
a red cron job every morning is how a backup job gets ignored.

Two things worth knowing before relying on it:

- **CI does not run on the PR it opens.** A pull request created with the
  default `GITHUB_TOKEN` does not trigger other workflows — GitHub blocks that
  to stop workflows recursing. The job therefore validates its own output
  (`TestSeedData_IsValid` over the written files) and refuses to open the PR if
  the export cannot seed. A PAT would restore normal CI, at the cost of a
  credential to manage.
- **The loss window is the schedule.** Up to a day of console authoring is
  unbacked at any moment. Fine for one author; the cron line is the first thing
  to change if that stops being true.

### PR / preview environments (planned, deferred)

Not set up yet. When added, they must use separate database/bucket instances from staging and production — never production data.

## Why this split

Solo-developer constraint: local dev needs zero cloud dependency so iteration stays fast and free; staging/production need to exist to catch integration issues before users hit them, but only for services that actually have code behind them — provisioning a Railway service for `worker` before a worker binary exists would just be an empty box to maintain.
