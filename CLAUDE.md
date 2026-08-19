# VOLA — instructions for Claude Code

VOLA is a unified training and nutrition platform for BJJ athletes who also strength train and track nutrition — one athlete profile and calendar connecting BJJ, strength training, and nutrition, with deterministic, explainable cross-sport recommendations.

**Start here for full context:** [docs/decisions/history.md](docs/decisions/history.md) — chronological narrative of what's been built and why. `docs/architecture/*.md` hold the current-state detail this file only summarizes.

## Repo map

- `backend/` — Go modular monolith, stdlib `net/http` (no web framework, deliberately). `cmd/api`, `cmd/migrate`, `cmd/seed`. `internal/modules/*` per domain, `internal/platform/*` for cross-cutting concerns (`auth`, `database`, `apihttp`, `llm`). **`llm` is the transport half of talking to a language model** — provider selection, the two SDK calls, structured-output plumbing, and one pair of sentinels (`ErrRefused`/`ErrUnavailable`) both backends map onto. It deliberately holds no prompt, schema, parse or validation: those stay with the feature, and so do model DEFAULTS, because N26 and N33 want different defaults on the same provider. It was extracted from `nutrition` once there was a second consumer and before that consumer wrote any provider code — see N36.
- `apps/web/` — Next.js customer app, Clerk auth. **Web (and admin) use Clerk's _prebuilt_ `<SignInButton mode="modal">`; only `apps/mobile` hand-builds auth on the headless hooks.** That split is deliberate — mobile needed the flows designed (offline-tolerant errors, a resumable sign-up), web does not — so **don't port mobile's auth screens here.** VOLA styling comes from `src/app/clerkAppearance.ts`, whose `appearance.variables` are `var(--c-*)` references and never hex, so the modal follows the light/dark toggle with no theme detection; a literal colour there silently gives dark-mode users a white modal. Its `localization` block also overrides Clerk's titles, because the **Clerk dashboard application is still named "Formspan dev"** and composes titles from it — Clerk's server-side emails still say Formspan until that's renamed. `/dashboard(.*)` is server-side gated by `proxy.ts` (Clerk middleware `auth.protect()`); `app/dashboard/` holds the sidebar shell (`layout.tsx`) + destinations (only `Dashboard` wired so far, matching the mobile shell's single-tab scope). Root `/` is the public entry — redirects signed-in users to `/dashboard`, shows sign-in otherwise. Tailwind CSS v4 for styling.
- `apps/mobile/` — Expo + Expo Router (file-based, `app/(tabs)/` for the tab navigator). **Runs on a development build (`expo-dev-client`), not Expo Go, since 2026-08-09** — CNG/prebuild, so `ios/` and `android/` are generated and gitignored and the app config is the source of truth. `pnpm run dev:mobile` starts Metro for the dev client; `pnpm --dir apps/mobile run ios` builds and launches it. **The first run after pulling a new native dependency has to be `run:ios`, not `start`** — Metro cannot deliver a native module, so a new dep in JS against an old binary fails at runtime module load, not at build. This unblocks everything Expo Go could not host: HealthKit, widgets, Live Activities, App Intents, and OAuth's `vola://` callback. **Clerk auth** (same instance as web/admin) via `@clerk/clerk-expo`, session token cached in the OS keychain (`lib/tokenCache.ts` → `expo-secure-store`, not AsyncStorage). `app/_layout.tsx` routes signed-out users to `app/sign-in.tsx`, which handles email+password plus a second factor (TOTP / SMS / **email code** / backup code — this Clerk instance uses email codes). `app/sign-up.tsx` is the account-creation path (email+password → emailed code → `setActive`) and `app/forgot-password.tsx` the reset path (emailed code → new password → `setActive`); all three link to each other and hand the typed address across as an `email` route param. **The layout's signed-out guard is keyed on the `AUTH_ROUTES` array, not on one route** — keyed on one route it replaces every other path with `/sign-in`, which silently makes any second auth screen unreachable. **Every new auth screen must be added to `AUTH_ROUTES` or it renders for one frame and vanishes.** Shared auth plumbing lives in `lib/clerkErrors.ts` (routes a Clerk error to the field its `meta.paramName` names; a failure with no `errors` array is form-level, never blamed on an input) and `lib/secondFactor.ts` (picks and prepares the 2FA factor — sign-in and password reset both land there). Note `forgot-password` sets the new password *before* reporting `needs_second_factor`, so on a 2FA account the password is already live while the user is not yet signed in; the copy has to say so. No OAuth yet. **Offline-first activity logging**: `lib/db.ts` (expo-sqlite) writes locally first with a `synced` outbox flag; `lib/activities.ts` pushes pending rows to `POST /v1/activities`. The activity ID is generated *client-side*, which is what makes sync retries idempotent — see the backend's `ON CONFLICT DO NOTHING`. `EXPO_PUBLIC_*` env var convention (RN equivalent of Next's `NEXT_PUBLIC_*`).
- `apps/admin/` — Next.js admin console, fully separate from `apps/web` (not athlete-facing). Reuses the **same Clerk instance** as `apps/web`; `/users(.*)` is gated two ways — `proxy.ts` requires sign-in, `app/users/layout.tsx` additionally checks the signed-in Clerk user ID against the `ADMIN_USER_IDS` allowlist env var (**same var name and value the backend uses** — one admin-identity convention across the stack; the backend's own `RequireAdmin` is the real security boundary, this gate is defence in depth for the UI). `User Lookup` (`/users`), `User Detail` (`/users/[id]`), `Health` (`/health`) and `Content` (`/content`) exist so far, matching what's actually been designed. **`/content` is the only screen that writes** — creating and editing techniques without a deploy. It **lists** what the console authored and **searches** the whole catalog (`?q=`), because every row is editable since the spreadsheet was retired; the default is the authored set only because 542 full rows is ~570 KB of prose to render a list. **A PATCH takes ownership**: it sets `source='admin'`, which the seeder's `WHERE source = 'seed'` then skips — drop that from the SET clause and the next deploy silently reverts every console edit. **Ownership on the authored list is membership, never a `source` field read off a technique**: `GET /v1/techniques/{id}` does not select `source` and the contract does not promise it there, so reading it marks everything deploy-owned including the row you just wrote. (`/v1/admin/techniques` does return it, which is what the search results' Owner column shows.) Writes go through **server actions**, which call `assertAdmin` themselves — a server action is a POST endpoint the router exposes independently of the page it was declared beside, so neither `proxy.ts` nor the layout protects it. The allowlist lives in `lib/admin.ts` and all three share it. **Runs on real backend data** — `lib/api.ts` server-fetches `/v1/admin/users`, `/v1/admin/users/{userID}/activities` and `/v1/admin/techniques`; there is no mock data anywhere in this app. Fields the design mocked up but that have no real system behind them yet (subscriptions, device/platform, integration sync, support tickets) are simply **not shown** rather than faked. Visual design (colors, Barlow/Barlow Condensed fonts, component styles) comes from a shared hi-fi design file — tokens live in `app/globals.css`'s `@theme` block. **Note:** `apps/web`'s current visual style predates this design system and does not yet follow it — reconciling that is a separate, not-yet-started piece of work. **`/content/exercises` is the second write surface**, and now on fully equal terms — search, drafts and revisions all mirror the technique screens: media is never authored (it lives in `exercise_media` with no upload path, and leaving it out of the request is what stops an edit clearing assets a deploy attached), and the export carries both catalogs into their seed files.
- `apps/mobile/lib/__tests__/` — jest (`jest-expo` preset). `support/sqlite.ts` gives tests a **real** database: `expo-sqlite` can't run here (jest-expo stubs the native module), so it is a thin async shim over Node's built-in `node:sqlite` — same engine, no new dependency — and `migratedFixture()` runs the app's own `migrate()`, so the schema under test is the schema that ships. **Anything about SQL behaviour belongs in a fixture test, never a regex over the query string**: a text assertion proves a clause is present, not that SQLite honours it, and an array mock can silently *supply* the behaviour under test. Both mistakes shipped here before the fixture existed. The rest is pure-logic coverage: the set transforms, the Clerk token broker, the sync orchestrator. Deliberately not component tests — what breaks in this app is concurrency and state reconciliation, not rendering. **Every assertion here should fail when the code it covers is deleted**; the suite was started because two throwaway harness tests passed for the wrong reason (a 300s token that never reached the offline path, and a backoff ladder already at 300s so a 5s wait proved nothing). Run `pnpm run test:mobile`; when adding a test, mutate the guard it covers and check it goes red. **`apps/mobile` is also linted now** (`pnpm run lint:mobile`, `eslint-config-expo`), which it was not for a long time — and that gap shipped a crash: a `useMemo` below an early return made every BJJ session opened from Today a black screen, and `react-hooks/rules-of-hooks` is the only thing that catches it, since hook order is a runtime property the typechecker cannot see. That rule is an **error**; the 55 findings the first run surfaced on never-linted screens (24 `react-hooks/refs`, 15 `set-state-in-effect`) are **warnings**, held by `--max-warnings` — **now 54**, lowered once a finding was cleared. That ratchet is the enforcement — this app's own PR added two warnings unnoticed before it existed, which is how a soft limit rots. Clearing findings means lowering the number; adding one fails the gate. **The suite runs under `TZ=America/Los_Angeles`** (set on the `test` script, at process launch) — a date bug that renders as the previous day west of Greenwich is invisible in UTC, so a UTC suite passes against the exact thing it covers. Note `process.env.TZ = ...` inside a test **does not work**: jest hands the sandbox a copied `process`, the runtime is never notified, and the zone silently stays UTC. That shipped once and passed. **If another session is running a suite, pass `--maxWorkers=3`.** No `maxWorkers` is configured, so every jest instance claims `cores - 1` (9 here) and three concurrent instances fight over 27 workers for 10 cores: suite wall time goes 6.5s → 33.7s and `sharedScreen.test.tsx` runs out of time. **Which timeout that is was wrong here until F13**: five component suites set `asyncUtilTimeout: 10_000`, but jest's own `testTimeout` was unset and defaulting to 5000ms, so jest killed the test first and the configured ten seconds was unreachable — measured, a `waitFor` at 10s died at 5003ms. `jest.config.js` sets `testTimeout: 15_000` now, so the budget those files ask for is the budget they get, failing "drops the accepted row locally". Measured over 74 runs — **and it is not a load problem**: one instance under deliberate CPU saturation at load 89 never failed (0/12), while three instances at load 69 failed 8%. Capping to 3 workers each is 0/18 **and nearly twice as fast** (15.9s), because the oversubscription was costing throughput, not buying it. Deliberately not set in `jest.config.js`: CI runs one instance, where 9 workers is right, and this is purely an artefact of several sessions sharing one machine.
- `tests/functional/` — Playwright functional test suite (user-authored, in progress — evolving, don't assume its current shape without checking).
- `docs/testing/functional-scenarios.md` — recommended functional test scenarios per feature, meant to be translated into `tests/functional/` (or mobile's equivalent). A living doc, not `tests/functional/` itself — safe to update even when the test suite's own shape is uncertain.
- `contracts/public.openapi.yaml` — hand-maintained OpenAPI spec (not generated).
- `railway/*.toml` — per-service Railway config. **Only exists for services with real code behind them** — don't create a config for a service that has no binary/app yet.
- `docs/architecture/` — current-state docs (deployment, API conventions). `docs/decisions/history.md` — the project narrative.
- `assets/brand/` — the VOLA brand kit, and the **source of truth** for brand identity: logos, app-icon and splash masters, 25 UI icons, and `design-tokens.json`. All SVG — the rasters in `apps/mobile/assets/images/` are *generated* from these, so edit the SVG and regenerate, never the PNG. UI icons use `currentColor`, so recolour via CSS/props rather than by forking the file.

## Which platform gets a feature (hard rule)

**An in-progress session is a phone thing. The web app is for planning and analysis.**

- `scripts/generate_sounds.py` — the **sonic** identity, same relationship to the app that `assets/brand/` has: the sounds are synthesised, not sampled, and the script is the source of truth. It renders a 17-sound family (F# pentatonic, four struck voices — `glass`/`bell`/`marimba`/`pad`) but the app bundles only the ones listed in `BUNDLE` (eight so far), under the filenames `apps/mobile/lib/sounds.ts` already `require`s. The rest go to a gitignored `assets/audio/` for auditioning; adding one to the app is three lines (`BUNDLE`, `SOUND_NAMES`, and the matching `require` in that file's `SOURCES` — `SoundName` derives from the array and `SOURCES` is keyed on it, so extending one without the other fails typecheck). **This is the one script that is not stdlib-only** — it needs numpy and ffmpeg, which is what buys the convolution room and per-partial voicing. Nothing in CI or `verify` imports it, so that is not a pipeline dependency — `check:python` only `ast.parse`s. **`--check` needs numpy and ffmpeg too**: it re-renders every sound and byte-compares rather than hashing against a manifest, and it reports drift without ever failing. Levels are intentionally unequal (−19 dBFS for a tap, −4 for rest-over); do not "fix" that by normalising them together.
- **Mobile** owns live logging: recording sets mid-workout, the rest timer, swapping an exercise because the rack is taken. These are done standing up, one-handed, with 20 seconds between sets.
- **Web** owns authoring and review: building templates (two-pane, catalog always visible), reading history back, and the analytical surface. It can also start, review and correct a session — those are desk activities — but it does **not** get in-workout affordances. A rest countdown on a desktop you are not standing next to is decoration.

This was re-litigated per feature for a while; it isn't open. When adding something to the session flow, decide which of the two it is before building it, and say so in the history entry.

**One carve-out, added 2026-08-17 for N5, and it is narrow on purpose.** A
*trend you read in three seconds to decide something* is not analysis, it is
decision support — and the decision it supports is usually made away from a
desk. "Am I losing weight fast enough" is answered in a supermarket, not in a
spreadsheet. So a small read-only chart may live on mobile when **all** of these
hold:

- it answers ONE question, with no metric picker, no axes to read values off, no
  tooltips and no zoom;
- the decision it informs is made while away from a computer;
- the comparable, exportable, correlate-it-with-training-load version still
  lives on web, and this is not a step toward moving that.

`apps/mobile/app/checkin/trend.tsx` is the first and currently only instance.
The test is the three bullets, not "is it a chart" — the moment one grows a
second metric or a **date-range picker** it has become the web screen and
belongs there.

**A fixed zoom toggle is not a date-range picker**, and the distinction has to
be stated or the first instance fails the rule that blesses it: week / month /
year are three preset windows that all END TODAY, which is one question asked at
three depths. A picker is one that lets the athlete choose a start and an end —
that is comparison, and comparison is the web screen's job.

Logging and authoring are unaffected; this changes nothing about where a session
is run from.

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

Every change goes on a feature branch — **never commit directly to `main`.**

**One agent, one branch, one worktree, and a clean tree at both ends. Always —
not only when the primary checkout looks busy.** This used to say "if the
primary working directory has uncommitted changes that aren't yours to touch,
use a worktree instead", and a conditional rule is one every session gets to
talk itself out of. Measured on 2026-08-08: **nine trees, four of them dirty,
carrying 39 uncommitted files between them** — including the primary checkout,
sitting on somebody's feature branch with 18 uncommitted files in it. Nobody
decided that; it is what "share the tree when it seems fine" adds up to.

So, every time:

1. **`git fetch origin` first, and branch from `origin/main`** — never from
   whatever HEAD happens to be. A branch cut from another session's
   half-finished work inherits it, and you will not notice until the diff is
   full of changes you cannot explain.
2. **Work in your own `git worktree`** under `.claude/worktrees/<short-name>`,
   never in the primary checkout. The primary is shared: other sessions read
   it, and it is the tree device builds are normally run from, because it is
   the one that has `apps/mobile/.env.local` (a worktree needs that copied in
   first — see the `EXPO_PUBLIC_*` trap below). Leaving it dirty or parked on
   a feature branch therefore breaks somebody else's work, not yours.
3. **Start clean and finish clean.** `git status --short` should be empty
   before you begin and after you are done. Commit your work or discard it;
   do not park it in a shared tree for later.
4. **Touch only what your task is about.** Shared config — `.claude/*`,
   `docker-compose.yml`, another app's files — is not yours to edit in
   passing. If you genuinely must (a temporary preview entry, say), restore it
   and *verify* the restore rather than assuming it.
5. **Claim your migration number against `origin/main` at REBASE time, not
   when you write it.** Two branches picking `000043` is not something
   golang-migrate resolves — it refuses to start at all, breaking CI, local
   dev and every deploy. And the collision is **invisible in
   `git diff origin/main...HEAD`**, because a three-dot diff uses the merge
   base, which predates the other branch. It only exists in the merged tree.
   This has already happened once.
6. **Clean up after the merge**: `git worktree remove <path>`,
   `git worktree prune`, `git branch -D <branch>`. Stale worktrees pin stale
   branches, hide dirty state, and make `git worktree list` useless as a
   picture of what is actually in flight.

Before every push, run the full local check suite — **one command**:

```bash
pnpm run verify
```

It chains every check with `&&`, which is the point. Running them as separate
lines has twice let a **failing typecheck scroll past and the commit happen
anyway** — once on the test-runner PR, once on PR4a — because a newline is not
a dependency. If you run individual checks while iterating, still run `verify`
before pushing.

Deliberately not included — each is slow or needs setup, and CI covers them:

```bash
pnpm run test:api                            # needs TEST_DATABASE_URL
pnpm run build:web && pnpm run build:admin   # slow; CI runs both
docker build -f backend/Dockerfile backend   # if Docker/Colima is available
```

**`typecheck:mobile` starts a Metro dev server first, and that is not a
mistake.** `pnpm run routes:mobile` (`scripts/generate_route_types.mjs`) boots
Expo, waits for `.expo/types/router.d.ts`, and stops it — 3–6s (3.5s local, 5.5s measured on a CI runner). Expo
Router's typed routes are what make `router.push('/nope')` a type error, and
they are GENERATED by the dev server into a gitignored directory: without this
step a clean checkout type-checks route literals against a loose `Href` and
passes everything, which is how a button pointing at a route that never existed
shipped (N32). There is no `expo typegen` in SDK 57 and `expo export` does not
write them — both measured. If the step fails, `typecheck:mobile` fails; a
generator that quietly produced nothing would restore the silence it exists to
end.

**If you add a check to CI, add it to `verify` too.** It already missed
`typecheck:admin` once — an admin type error passed locally and failed in CI,
which is the same "failing typecheck scrolled past" it exists to prevent, just
relocated to a third app. And note `fmt:api` has to *test* gofmt's output:
`gofmt -l` prints offenders and still exits 0, so as the chain's first link it
could never fail.

**`scripts/*.py` is parsed now** (`check:python`, plus a `Scripts (Python)` CI
job) — it was not for a long time, and *nothing* in the repo read a `.py` file:
no CI step, no `verify` link, no ruff/pyproject config anywhere. The content
pipeline is Python and the importer is run rarely, at exactly the moment being
wrong is expensive. This is only a **syntax** floor, and the distinction
matters: `scan-library.py`'s corpus double-count survived for months and a
parse check would not have caught it, because that was behaviour, not syntax.
Anything about what a script *does* needs a check that runs the script.
Stdlib-only on purpose, so `verify` needs no Python toolchain and the CI job
needs no `setup-python`.

Then: `git push -u origin <branch>`, `gh pr create`, watch CI with `gh run watch <run-id> --exit-status`.

**Never merge a PR without the user's explicit go-ahead, even if CI is green.** This has been the rule for every PR in this project — don't treat a passing CI run as implicit merge permission.

## The open list (hard rule)

[docs/TASKS.md](docs/TASKS.md) is the shared task list — every known gap, fix and
queued feature, one line each with a stable id. **Read it before starting work**
and **tick your line when you finish**, in the same PR.

Three rules make it survive several agents at once:

- **One line per task, marked in place.** `- [ ]` becomes `- [x]` with a PR
  number appended; the line is never deleted, because a finished task is the
  record that it was considered. One line also means a concurrent edit conflicts
  over one line rather than a paragraph.
- **Ids are never reused**, so "closes W2" in a commit message still means
  something a year later.
- **Claim a task before you work it**, below.

### Claiming (hard rule)

This list is ordered by what an athlete would notice, so every session that
opens it independently picks the same top line. Two full rounds of work were
lost that way in a single afternoon — W2, then W4 — both times with the checks
genuinely run, because **a check cannot see work that has not been pushed.**

So, before writing anything:

```bash
gh pr list --state open        # includes drafts; a draft IS a claim
```

and if the task is free, claim it before you start:

```bash
git commit --allow-empty -m "Claim <ID> — <task>"
git push -u origin <branch>
gh pr create --draft --title "[claim] <ID> — <task>" --body "Claiming <ID>."
```

Then do the work on that branch and mark the PR ready when it is reviewable:

```bash
gh pr ready <n>
gh api -X PATCH repos/dmytro-ch21/formspan/pulls/<n> -f title="..." -F body=@body.md
```

The claim PR becomes the real one; nothing is thrown away. **Use `gh api`, not
`gh pr edit`** — the latter fails outright in this repo on a deprecated
Projects-classic GraphQL query (`repository.pullRequest.projectCards`) and
silently changes nothing, so a title still reading `[claim] …` after an apparent
success is that, not a typo. `gh pr ready` and `gh pr create` are unaffected.

**Why a draft PR rather than a field in this file.** TASKS.md is itself the
contended resource — a claim written here is one more edit to the file two
sessions are already fighting over, and it still needs a push to be visible, so
it costs the same and conflicts more. `gh pr list` is the one channel every
session can already see without pulling anything.

**What it does not fix.** The window between deciding and claiming is still
invisible, so claim *early* — the empty commit exists precisely so you can claim
before there is anything to show. And nothing enforces any of this; it is a
convention, and it works only if the check half is done too.

**And an id is only claimed if it is in a PR TITLE.** `gh pr list` shows titles,
not diffs — so a new id you file inside an open PR's `TASKS.md` is invisible to
every other session until that PR merges. Two sessions allocated **N19** the same
afternoon that way, both correctly: one had it in a draft PR's title, the other
had written the line into a branch nobody could see. The one in the title wins,
because that is the channel the convention is built on. If you file forward-looking
ids for follow-up work, either claim them immediately with their own draft PR, or
expect to renumber.

It does work when it is. This convention was written after a session picked up
**H1**, ran `gh pr list` first, found #216 already open with the work complete
but a week stale, and rebased and landed that instead of writing a second copy
of it.

Detail belongs in `docs/decisions/history.md`. TASKS.md is an index, and it stops
being useful the moment it becomes prose.

**The `T` section is load-bearing.** Those are traps: changes that compile, pass
their tests, and are wrong. If your work touches one, read it first — every entry
there was found by review after the check suite went green.

## Keep the history log current (hard rule)

[docs/decisions/history.md](docs/decisions/history.md) is a living document, not a one-time snapshot. Whenever a PR lands (or right before merging one) that represents a material decision or a notable chunk of work — a new module, a new convention, an infrastructure change, a bug found and fixed, a provider/tooling choice — **append a dated entry** to it in the same style as the existing entries: what was decided/built, why, and any open questions or gaps it leaves behind. Do this as part of finishing the work, not as an afterthought someone has to remember to ask for.

**Append immediately BEFORE the trailing `## Open items / known gaps as of this
entry` heading — never after it.** The file ends with that heading and its
bullet list, and branches have anchored on both sides of it: insert before and
the heading keeps its list, insert after and the heading is stranded on the
newest entry while its list drifts below, reading as though those gaps belong
to whatever landed under it. Two branches doing different things merge into
exactly that, and it has been repaired three times. One side, always: before. Skip it only for truly trivial changes (typo fixes, formatting) that don't represent a decision anyone would need to know about later.

## Keep functional test scenarios current (hard rule)

[docs/testing/functional-scenarios.md](docs/testing/functional-scenarios.md) is a living document, same discipline as `docs/decisions/history.md`. Whenever a new module or user-facing feature lands — a new backend endpoint, a new web route/page, a new mobile screen — **add its recommended scenarios** (happy path, edge cases & errors, and auth/security where relevant) as part of finishing that work. Don't write the actual Playwright/test code yourself unless asked — `tests/functional/` is the user's own in-progress suite; this doc is the reference list they (or a future session) translate into real tests. Skip it only for changes with no user-facing or API-surface behavior (refactors, docs, CI tweaks).

## Review before every PR (hard rule)

**Run `/pre-merge` before opening or updating any PR.** It is one gate that
runs both the CI-equivalent check suite *and* the review subagents in
`.claude/agents/`:

- **`backend-reviewer`** — for `backend/**` or `contracts/**`. Security
  (authorization gaps/IDOR, information disclosure, secrets/PII in logs),
  correctness, performance (N+1s, missing indexes, unbounded lists), and
  adherence to the module pattern above.
- **`frontend-reviewer`** — for `apps/**`. Security (server/client boundary
  leaks, client-only authorization), correctness (Server vs Client
  Components, `useEffect` deps, error states), performance, accessibility,
  and design-token/convention adherence.

Both are **read-only diagnostics** — they report, they don't fix. Resolve or
explicitly justify every `[blocking]` finding *before* opening the PR;
`[suggestion]` items are judgment calls.

**Why one command and not two rules:** it used to be two, and the check
suite got run while the reviewers got skipped — repeatedly, over several
PRs — because running the checks feels like having verified the change. It
isn't. The checks prove it compiles. The reviewers are what caught the
cross-user ID-enumeration bug (twice, in two modules) and the `completed`
flag that was written but never read back, which zeroed every session's
volume and would have erased real data through the mobile sync cycle. All
of those had a green check suite.

Give the reviewers the design intent along with the diff — they find far
more when they know which properties are load-bearing.

## Keep the README current (hard rule)

[README.md](README.md) is the first thing anyone (human or AI) sees — it drifted stale once already (still described a two-app, four-endpoint repo well after `apps/mobile`/`apps/admin` and several backend modules existed) because, unlike the two rules above, nothing required it to be updated. Whenever a new app, a new top-level backend route, or a new "how do I run this locally" step lands, **update README.md's "Current state" and "Run it locally" sections** as part of finishing that work. It should always be accurate enough that "how do I start X" never needs to be answered from outside it.

## Local dev setup

```bash
docker compose up -d                       # local Postgres on :5432 (Colima-backed Docker, not Docker Desktop)
cd backend && go run ./cmd/migrate up
cd backend && go run ./cmd/seed             # reference content (exercise catalog) — idempotent, safe to re-run
cd backend && go run ./cmd/exportcontent    # carry console-authored content into the seed files (techniques.json, exercises.json), then review the diff and commit
pnpm run dev:api                            # :8080
pnpm run dev:web                            # :3000
pnpm run dev:mobile                          # Metro on :8081 for the development build — first run (and any new native dep) needs `pnpm --dir apps/mobile run ios` to build/install it
pnpm run dev:admin                          # :3001 (or next available port — runs alongside apps/web)
```

**Backend tests run with `-p 1`** (`test:api` and CI both), for **isolation**.
`go test ./...` runs packages in PARALLEL against ONE shared database, and
several tests assert global counts — `SELECT count(*) FROM techniques` and
friends. The moment a second package's fixtures seed library rows, those counts
include them: measured 3 failures in 6 concurrent runs. Scoping each assertion
was tried and abandoned — there are seven in one file alone, and every future
one would have to remember. If you add a test that seeds shared reference data,
`-p 1` is what is keeping it from breaking somebody else's package.

**It used to be doing a second, undocumented job — ordering — and that one is
retired as of 2026-08-16.** It is recorded here because the shape recurs, and
because the fix is a rule you can break by accident.

`session`, `workout` and `profile` had fixtures referencing real catalog ids
(`bench-press`, `back-squat`) that they never seeded. They passed only because
`internal/modules/exercise`'s tests call `Seed()` — the whole 762-row catalog,
and unlike the per-test fixtures elsewhere in the suite those rows are never
cleaned up — while `exercise` sorts fifth, with `-p 1` forcing the packages to
run in that order. CI leaned on it hardest: the `Backend (Go)` job migrates a
throwaway Postgres and never runs `cmd/seed`, so CI is the unseeded case on
*every* run and those packages were green purely because a package earlier in
the alphabet left rows behind. Renaming `exercise` to sort later — or giving
that `Seed()` test the `t.Cleanup` its neighbours all have — would have turned
37 tests red in three modules nobody touched.

All three are converted. **Measured 2026-08-16, every module package now passes
alone against its own pristine migrated database** (a template database per
package — sharing one hides the effect, since `exercise` seeds for everything
after it). If you are checking this claim, that is the method; a single shared
database will tell you everything is fine when it is not.

The rule that keeps it that way is **own the library rows you depend on**.
`exercise/content_postgres_test.go`, `bjj/proficiency_postgres_test.go`,
`feed/postgres_test.go`, `share/postgres_test.go`, `session/postgres_test.go`,
`workout/postgres_test.go` and `profile/postgres_test.go` all seed their own
catalog rows for exactly this reason. **`workout` is the one to copy**, because
it learned from `session`'s mistake:

- **Namespaced ids that KEEP the original name as the suffix** — `wk_fx_bench_press`,
  not `wk_fx_bench`. Some tests depend on the ids' relative LEXICAL ORDER (a
  test proving a caller's order survives can only fail if that order is one a
  sort would change), and that dependency is invisible at the call site.
  `session`'s rename inverted such a pair and silently disarmed two tests —
  review caught it, the suite did not.
  **A prefix alone is not enough, and this is easy to get wrong:** the ordering
  is preserved only if the suffix is otherwise *verbatim*. Respelling separators
  is not order-preserving in general, because `-` (0x2D) < `0` (0x30) < `_`
  (0x5F) — so `bench-press` < `bench0press` but `bench_press` > `bench0press`,
  and the catalog really does contain digit-leading ids (`45-degree-leg-press`,
  `90-90-hip-switch`). `workout`'s ids swap `-` for `_` and were checked pair by
  pair; do not assume that generalizes.
- **Where a test depends on the order, assert it** — `requireUnsorted`, so a
  future rename fails loudly instead of going quiet. This is the guarantee that
  actually holds; the naming convention above only makes it less likely to fire.
- **Every column any test reads set explicitly**, never defaulted, and the
  `ON CONFLICT DO UPDATE` reconciling all of them so an interrupted run's
  leftover row is repaired rather than trusted.
- **FK-ordered cleanup wired into `newTestRepo`**, so under LIFO it runs after
  each test's own cleanups.

A package testing a **seeder** is the exception: `workout/seed_postgres_test.go`
exercises the real deploy path, whose 17 plans carry 84 items referencing 45
distinct catalog ids by design, so invented ids would test something else. It
seeds exactly the rows those plans name from `exercise.SeedData()`, using
`ON CONFLICT DO NOTHING RETURNING id` and removing **only what it actually
inserted** — on an already-seeded database it inserts nothing and deletes
nothing, so it can never take a real catalog row out from under another package.

**The rule is enforced now, structurally rather than by a checker.**
`exercise`'s three seeding tests call `removeCatalogAfterTest`, so the 762 rows
are gone by the time any later package runs. There is no populated catalog left
to borrow from, so a fixture that references `bench-press` without seeding it
fails in the ordinary `go test -p 1 ./...` run with
`unknown exercise "bench-press"` — immediately, in CI, on the PR that
introduces it.

Demonstrated both ways rather than assumed: reintroduce a borrowed id in
`session` and the suite goes red on that test; remove the cleanup and the *same*
regression passes, 28 packages green. That difference is the whole guarantee.

Three consequences worth knowing. **If you add a fourth test in `exercise` that
calls `Seed`, it needs `removeCatalogAfterTest` too**, or the crutch comes back
for everything alphabetically after it. **The cleanup deletes the seeded workout
plans first** — `cmd/seed` writes 17 of them and their items reference the
catalog through a NO ACTION foreign key, so without that step the exercise
delete aborts on any database `cmd/seed` has touched, leaving the suite red and
the catalog intact. That delete is scoped to `source = 'seed'`, and an athlete's
workout is out of reach by constraint rather than convention — migration
000043's `workouts_owned_rows_are_never_seeded` makes owned-and-seeded a state
the database refuses. And **both cleanups verify their catalog deletes** and
fail the test if rows survive, because one that quietly errors would restore the
crutch and disarm all of this without anything going red.

`workout/seed_postgres_test.go` is the other place that can put catalog rows
back — it inserts up to 45 real ids for the deploy-path tests — so its cleanup
gets the same fail-and-verify treatment rather than a log line.

**The technique library has the same treatment** (`removeLibraryAfterTest`), and
finding every place that seeds it took a second pass worth recording. Grepping
for `Seed(ctx` found two tests; the library is *also* loaded wholesale by
`repo.UpsertAll(ctx, SeedData())`, a different idiom in three more. Five sites,
not two — and the miss was invisible except by measuring: the suite passed with
542 rows still sitting in the database afterwards. **Check the row count after a
run, not the call sites**, if you ever extend this.

That cleanup **removes the seeded curricula first**, and the reason inverts the
exercise case. There the delete aborted on a NO ACTION foreign key — loud, and
what made the first version obvious. Every foreign key into `techniques` is
CASCADE or SET NULL, so a bare delete *succeeds* and takes the syllabuses' items
with it: measured at 136 curriculum items becoming 38, five named curricula left
gutted, suite green. Removing the seeded curricula explicitly turns that into an
intended cascade instead of an unnoticed one. **A CASCADE is more dangerous here
than a RESTRICT** — the constraint that blocks you is the one that tells you.

Not covered: `cmd/seed` also writes 11 `positions`, deliberately left, since
nothing borrows position ids the way packages borrowed catalog and library ids.

**The related failure this used to sit beside is now fixed** (#216), and the
shape is worth keeping because it is the worse one. `curriculum`'s
`TestEverySeededTechniqueExistsInTheLibrary` needed the *technique* library, and
`curriculum` sorts before `technique`, which is what seeds it — so ordering never
saved it. It **skipped on every CI run** while the package printed `ok`, for
months. Being green and being run are different things, and only `-v` tells them
apart.

It no longer touches a database at all: it reads the embedded catalog through
`technique.SeedData()`, so it cannot skip, and both sides `t.Fatal` rather than
pass vacuously on an empty file. That is also the *stronger* check — a live
`techniques` table additionally holds whatever the console authored
(`source='admin'`), any of which would satisfy an id no fresh deploy has.

**The whole backend suite now has zero skips**: 28 packages, 583 tests, 0 skips,
0 failures on a migrated, never-seeded database. If you see a skip appear there,
something has regressed to the pattern above — check with `-v`, because the
package will still print `ok`.

If a package does start failing on unknown exercise ids, the first question is
whether the catalog is there at all:

```bash
docker compose exec -T postgres psql -U vola -d vola_test -tc 'SELECT count(*) FROM exercises;'
```

`0` means it was never seeded into that database — the normal state of a
per-branch database created by the recipe below, since that recipe migrates and
stops. That should no longer break any package, so a failure there means
somebody has reintroduced a borrowed id, and **the fix is to own the row, not to
seed the catalog.** Running `cmd/seed` by hand will make your local run pass and
will not help in CI: `exercise` deletes the catalog again on every run there, so
the borrowed id fails regardless of what you seeded beforehand.

(Substitute your own database name if you are not on the shared `vola_test` —
and note that `vola_test` has usually been seeded by some earlier full run,
which is why this class of trap hides until you make a fresh one.)

The backend integration tests need `TEST_DATABASE_URL` and **skip silently without it** — for a long stretch that meant a green local `go test ./...` proved nothing and they only genuinely ran in CI. Point it at a separate database from `DATABASE_URL`:

```bash
docker compose exec postgres createdb -U vola vola_test
cd backend && DATABASE_URL='postgres://vola:vola_dev_only@localhost:5432/vola_test?sslmode=disable' go run ./cmd/migrate up
```

**`vola_test` is shared by every worktree, so an unmerged migration in one
blocks all the others.** A branch that adds `000046_*.sql` and runs `migrate
up` leaves the shared database at version 46 while `main` tops out at 45 —
after which *every other branch* fails with `no migration found for version
46`, including branches that have never touched the backend. It reads like a
broken checkout and is nothing of the sort. This has happened; it cost a
confusing debugging session and it will happen again, because nothing prevents
it.

**Two different problems produce this error and they look identical**, so
diagnose before acting. Both say `no migration found for version NN`, and the
number alone does not tell you which:

```bash
docker compose exec -T postgres psql -U vola -d vola_test -tc 'SELECT version FROM schema_migrations;'
ls backend/migrations/ | grep -o '^[0-9]*' | sort -u | tail -1   # highest in THIS worktree
```

If the database is ahead of your worktree, the discriminator is whether that
version exists on `main`:

- **It exists on `main`** (`git show origin/main:backend/migrations/ | grep NN`)
  — *your branch is stale*, not the database. A worktree on a branch that
  predates the migration reports `no migration found for version 45` while the
  database is perfectly healthy. Rebase or pull; touch nothing else. This is the
  common case and the one most likely to be misread as the hazard below.
- **It exists nowhere in git** — somebody's unmerged migration reached the
  shared database. Find it with `find . -name "0000NN*" -not -path
  "*/node_modules/*"`; it will be uncommitted in a worktree, which is why
  `git log --all` does not know about it. That branch should move to its own
  database (below), and the shared one can be rolled back with the recipe at
  the end of this section.

Reaching for the rollback recipe when the real answer was "pull" is how you
turn a stale checkout into a damaged shared database.

**If you are the branch with the unmerged migration, use your own database.**
`createdb -U vola vola_test_<branch>` and point `TEST_DATABASE_URL` at it. That
is the whole fix, it costs one command, and it is the only thing that keeps a
shared database usable while several branches carry schema changes at once.

**To undo one migration, do NOT run `go run ./cmd/migrate down`.** That command
takes no step argument: it calls golang-migrate's `m.Down()`, which unwinds
**every** migration and leaves you with an empty schema. There is no per-step
form in the CLI, and "down" is exactly what somebody wanting to step back one
will type. Roll a single migration back by hand instead, in one transaction,
using that migration's own `.down.sql` rather than a guess:

```bash
{ echo 'BEGIN;'; cat backend/migrations/0000NN_name.down.sql; echo 'UPDATE schema_migrations SET version = MM, dirty = false;'; echo 'COMMIT;'; } | docker compose exec -T postgres psql -U vola -d vola_test -v ON_ERROR_STOP=1
```

Run from the repo root, with `MM` = `NN - 1`. Piping rather than a heredoc on
purpose: an unquoted heredoc would expand `$$` in any migration that defines a
function body, and `psql`'s own `\i` reads a path on the *container's*
filesystem, not yours.

Env vars come from real files, never baked into images: `backend/.env` / `backend/.env.example`, `apps/web/.env.local` / `apps/web/.env.example`, `apps/mobile/.env.local` / `apps/mobile/.env.example`, `apps/admin/.env.local` / `apps/admin/.env.example` — all gitignored except the `.example` templates. `backend/.env.staging.local` holds real Railway `staging` Postgres credentials (gitignored, never commit).

The backend's CORS (`withCORS` in `cmd/api/main.go`) allows multiple comma-separated origins via `WEB_ORIGIN` (not just one) — needed once the Expo web preview (`:8081`) joined `apps/web` (`:3000`) as a second browser-based local client. Only matters for browser clients; native iOS/Android requests aren't subject to CORS at all.

## Known gotchas

- **`secrets.txt`** may show up untracked in the repo root containing what looks like a live API key. Never stage or commit it — flag it to the user instead.
- This Next.js version renamed the `middleware.ts` file convention to `proxy.ts` (same `clerkMiddleware()` export, just a renamed file). Separately: `next dev --hostname 127.0.0.1` breaks when a `proxy.ts`/`clerkMiddleware()` is present — Next's Proxy runtime tries to self-fetch via `localhost` internally and fails (`ECONNRESET`, surfaces as a 500). Use `--port` alone when running concurrent dev instances; never pass `--hostname`.
- pnpm blocks native build scripts (`sharp`, `unrs-resolver`, etc.) by default — they need explicit `allowBuilds: true` entries in `pnpm-workspace.yaml` or installs fail.
- Railway: the real project is **still named `formspan`** — the VOLA rename covered the repo and code, not the external service accounts (Railway, Clerk). Don't "correct" it in docs until it's actually renamed in the Railway dashboard. It has a `staging` environment holding a real Postgres (migrations already applied there). No `production` Postgres yet. The `api` service is deployed to `staging` and live; `web`/`admin` are in progress. Note that Nixpacks-built services (`web`, `admin`) need `NIXPACKS_INSTALL_CMD` set to bypass corepack — see `railway/web.toml`. An **unrelated pre-existing project, `dynamic-trust`** (service `medical-portal-api`), sits in the same Railway account — it is not ours; never touch it.
- **You cannot verify a mobile screen through Expo web.** `pnpm run dev:mobile --web` fails to bundle *any* route: `expo-sqlite`'s web build imports `./wa-sqlite/wa-sqlite.wasm`, which isn't present in the pnpm store, and Expo Router's `require.context` pulls every route into one bundle — so `app/(tabs)/library.tsx` → `lib/sessionStore.ts` → `lib/db.ts` breaks the build for an unrelated screen like `sign-up`. Not fixable by touching the screen you're working on. Verify on the Simulator or a real device instead, and don't spend time diagnosing the bundle error as if it were caused by your change. The working route: boot a simulator (`xcrun simctl boot <udid>`), then `pnpm --dir apps/mobile run ios` to build and install the development build. Note the web bundler still runs and still fails in the logs; ignore it, the iOS bundle is separate.

  **Deep links changed with the dev client** (all three verified 2026-08-09 against the built `Info.plist` and on-device). The app registers **three** schemes — `vola`, `com.vola.fitness` and `exp+vola` — and they are not interchangeable:

  ```bash
  # Point the dev client at a Metro instance (replaces the old exp:// pinning)
  xcrun simctl openurl <udid> "exp+vola://expo-development-client/?url=http%3A%2F%2F127.0.0.1%3A8081"
  # Jump to one route — the app's OWN scheme, no /--/ infix any more
  xcrun simctl openurl <udid> "vola://sign-up"
  ```

  iOS shows an **"Open in VOLA?" confirmation** for these, which a scripted run has to tap through — it is not a hang. `expo run:ios` hands the dev client the machine's **LAN address** rather than `127.0.0.1`; harmless on a Simulator, and the loopback form above is what to use when pinning by hand.
- **`expo run:ios --device` has two traps that both look like your code is broken.** (1) **CocoaPods crashes with `Unicode Normalization not appropriate for ASCII-8BIT (Encoding::CompatibilityError)` when `LANG` is unset** — it is a Ruby locale bug in `pod install`, nothing to do with the project. Prefix the command with `LANG=en_US.UTF-8 LC_ALL=en_US.UTF-8`. (2) **`xcrun devicectl list devices` and `xcrun xctrace list devices` disagree about the same phone in two different ways.** They report different *identifiers* — Expo matches the *xctrace* one, so passing the `devicectl` UUID gives `CommandError: No device UDID or name matching "..."` even though the device is plainly connected; get the UDID from `xcrun xctrace list devices` (the `00008110-...` form). They also disagree about *reachability*, and **neither tool's listing is a readiness check**: `xctrace` files a perfectly usable wired phone under `== Devices Offline ==` (a build against it succeeds anyway, so do not treat that section as a blocker), while `devicectl list devices` shows an **unplugged** phone as `available (paired)` because it counts the Wi-Fi pairing. The signal that actually means "ready to build" is `xcrun devicectl device info details --device <UUID>` reporting **`tunnelState: connected`**. Get this wrong and `expo run:ios` does not error — it hangs silently, no output, no `xcodebuild` process, indefinitely.

  **A CABLE IS NOT REQUIRED, and this entry used to say it was.** It listed `transportType: wired` and `ioreg -p IOUSB -w0 | grep -i iphone` alongside `tunnelState` as things that must all hold. Measured otherwise on 2026-08-08: with the phone on Wi-Fi only — `transportType: localNetwork`, `tunnelState: connected`, and `ioreg` finding **nothing** on the USB bus — `expo run:ios --device 00008110-… --configuration Release` built, signed, installed (`✔ Complete 100%`) and produced a working Release build. So `transportType` is informational; do not refuse to build on it, and do not spend time hunting for a cable that is not the problem.

  What is unchanged is the half above it: the **identifier** has to be the `xctrace` one. That is the likelier original cause of the silent hang this entry was written from — a `devicectl` UUID over any transport gives `CommandError: No device UDID or name matching "..."`, and an unreachable device gives the hang — so keep checking `tunnelState` before a long build, and keep taking the UDID from `xctrace`. Note wireless install is slower than wired and the transfer happens after `Build Succeeded`, so a long pause at `Installing …` is the network, not a stall.
- **Never build the mobile app from a `git worktree`.** `EXPO_PUBLIC_*` vars are inlined into the JS bundle **at build time**, and `apps/mobile/.env.local` is gitignored — so a worktree never has one, and the build succeeds, installs, and launches into "EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY is not set, copy .env.example". Nothing in the build output warns, because a missing `EXPO_PUBLIC_*` is not an error to Metro; it is an empty string. This bites *specifically* in the worktree flow this file mandates for code changes, which is why it looks like a regression in the app rather than a build-environment problem. Either build from the primary checkout, or `cp apps/mobile/.env.local <worktree>/apps/mobile/.env.local` first (it stays gitignored in both, so it cannot be committed). And note a rebuild reuses a cached bundle — delete `main.jsbundle` from the DerivedData product, or the second build ships the same keyless bundle as the first.
- **A Debug device build has no JS in it.** `expo run:ios --device` defaults to Debug, which fetches the bundle from Metro at launch — so the app dies on open the moment your Mac stops serving it, which looks exactly like a crash in the app. Check with `ls <product>/VOLA.app/main.jsbundle`: absent means Debug. Pass `--configuration Release` for anything the user will actually carry around. Release-signed-with-a-development-certificate still expires in ~7 days.
- **You cannot verify a Release build by grepping the bundle for strings, and trying it produces confident WRONG answers.** A Release `main.jsbundle` is **Hermes bytecode**, not JavaScript — `file` says `Hermes JavaScript bytecode, version 98`, magic `c6 1f bc 03`. Two things follow, and both bit hard enough to report features as missing that were present:

  1. **Any string containing a non-ASCII character is stored UTF-16LE**, so an ASCII `grep` misses the *entire* string — including its ASCII parts. This codebase's copy is full of em dashes, so this is the common case, not the exotic one: `grep -a "sharing lands here next"` fails on a string that is right there.
  2. **Strings built at runtime never exist as literals.** `` `${label}, ${n >= CAP ? 'over 99' : n} waiting` `` is stored as `'over 99'` and `' waiting'` separately; the rendered phrase is in no bundle, ever. Same for anything the *server* sends (a 429 message is not in the app).

  So **absence from a grep is not evidence.** If you must search, check both encodings and pick literals that are literals:

  ```python
  b = open("VOLA.app/main.jsbundle", "rb").read()
  present = lambda s: s.encode("utf-8") in b or s.encode("utf-16-le") in b
  ```

  What actually verifies a device build, in order of worth: `file` on the bundle (Release vs Debug — see the entry above); its **mtime and size**, after deleting the cached `main.jsbundle` from the DerivedData product first, since a rebuild reuses it; and the `EXPO_PUBLIC_*` values, which *are* reliably greppable because a Clerk key and an API URL are pure ASCII — and which are the thing most worth checking, being what a worktree build silently omits.

- **Three Expo Go traps are GONE as of 2026-08-09, and the reason is worth keeping.** All three were the same root cause — *a binary we did not own, whose native side could drift from our JS*. A development build removes the whole class, because the binary is built from this repo's dependencies. Recorded here so nobody re-diagnoses a symptom that can no longer occur, and so the cost of ever going back is legible:
  1. `Cannot find native module 'ExpoAsset'` at runtime module load — the installed Expo Go's native binary predating the project's SDK.
  2. Expo Go silently upgrading *itself* mid-launch and segfaulting with `EXC_BAD_ACCESS` in `worklets::JSIWorkletsModuleProxy` — a JSI ABI mismatch, no red box, no JS error.
  3. Expo Go hosting one project at a time and reconnecting to the last one, so a stray reload pulled the app onto a *different* project and screenshots showed a build that was not under test.

  What survives from (3), in weaker form: a dev client's launcher can still be pointed at another Metro. It is now a deliberate act rather than something a stray `r` does, but **still confirm which build a screenshot came from** before trusting it.

  **The replacement failure mode is the mirror image, and it is quieter.** Expo Go's binary was too new for our JS; a dev client's binary goes *stale* — add a native dependency, run `start` instead of `run:ios`, and the JS references a module the installed binary does not contain. Same symptom as (1), opposite cause, and the fix is always a rebuild.
- **`expo install --check` drift is COSMETIC under Expo Go and FATAL under a dev client — this is the single biggest consequence of the move.** Under Expo Go the native side came from Expo Go's binary, so mismatched JS package versions never had to link against anything and the warning could be ignored for months. Compiling our own binary turns it into a launch-time `dyld` abort, before any JS evaluates:

  ```
  EXC_CRASH (SIGABRT) · DYLD · Symbol missing
  Symbol not found: _$s15ExpoModulesCore10BaseModuleC11willDestroyyyFTj
   Referenced from: .../VOLA.app/Frameworks/ExpoImageManipulator.framework
   Expected in:     .../VOLA.app/Frameworks/ExpoModulesCore.framework
  ```

  Measured 2026-08-09, twice, from both ends — see the two `2026-08-09` entries in [history.md](docs/decisions/history.md). `expo-image-manipulator@57.0.8` calls an API added in `expo-modules-core` 57.0.8, but `expo@57.0.8` resolved core at **57.0.7** in the lockfile, so the packaged `ExpoModulesCore` did not export the symbol. `expo` needed to be at ~57.0.11. **Confirm with `nm`, don't guess**, because the crash names two frameworks and neither is the one at fault:

  ```bash
  APP=$(ls -d ~/Library/Developer/Xcode/DerivedData/VOLA-*/Build/Products/Debug-iphonesimulator/VOLA.app | head -1)
  nm -gU "$APP/Frameworks/ExpoModulesCore.framework/ExpoModulesCore" | grep willDestroy   # exporter
  nm -u  "$APP/Frameworks/ExpoImageManipulator.framework/ExpoImageManipulator" | grep willDestroy   # importer
  ```

  **`prebuild --clean` and wiping DerivedData do NOT fix it, and trying them first wastes a 10-minute build each.** The tell that it is a version problem and not a stale-artifact problem: the rebuilt frameworks come back with **identical UUIDs** in the new crash report. The fix is `npx expo install --fix`. That still "moves `react-native` too, so it is a deliberate change, not a reflex" — but under a dev client it is no longer optional, it is the price of the app launching at all.
- ~~**OAuth cannot work under Expo Go.**~~ **Unblocked 2026-08-09.** Expo Go registered `exp://` and could not hand a `vola://` callback to a project it was merely hosting; a development build registers `vola://` from `app.json` itself, so Clerk's `startSSOFlow` has a scheme to come back to. **Not yet verified** — no OAuth code has been exercised against the dev client. The blocker is removed, not the feature confirmed.
- **Clerk returns `null` offline — it does not throw, and it does not sign you out.** Verified in the installed clerk-js: `_baseFetch` logs "Network request failed while offline, returning null" and returns null unless the experimental `rethrowOfflineNetworkErrors` option is on (it is off by default). Separately, `_updateClient(e){if(!e)return;…}` means a null response leaves the cached client intact, so **`isSignedIn` stays true offline** and the `AUTH_ROUTES` guard in `app/_layout.tsx` correctly does not redirect. The consequence that bit us: nine modules read that null as `throw new Error('Not signed in.')`, so a gym dead-spot made every screen simultaneously tell a signed-in athlete to sign in. **All Clerk token access now goes through `lib/session.ts`** — the only module allowed to call Clerk — which caches against the token's own `exp`, collapses concurrent refreshes, keeps serving a still-valid token when Clerk is unreachable, and throws `OfflineError` rather than ever claiming signed-out. Do not reintroduce a direct `getToken()` call; `useAuthToken()` returns a `TokenGetter` typed `Promise<string>` precisely so the null reading cannot come back. Clerk's default session token lives ~60s; set `EXPO_PUBLIC_CLERK_JWT_TEMPLATE` to a Clerk JWT template to lengthen that (no backend change — the API checks signature/issuer/exp/`sub` only).
- **Metro IPv6 vs IPv4 loopback mismatch**: Node resolves the hostname `localhost` to IPv6 first by default, so a plain `expo start` binds Metro only to `::1:8081`, while the client is handed the literal IPv4 address `127.0.0.1` — a total, silent mismatch, not a firewall/network issue. Fixed by prefixing `NODE_OPTIONS=--dns-result-order=ipv4first` on every `apps/mobile/package.json` script (`start`/`android`/`ios`/`ios:device`/`web`), forcing Metro to bind IPv4 first. (Originally diagnosed against Expo Go and `--localhost`; the binding half is a Node/Metro property and outlived both.) Diagnose with `lsof -i :8081 -P -n` — look for `127.0.0.1:8081` vs `[::1]:8081`. **The fix lives on the scripts, so running `npx expo start` directly reintroduces the bug** — which is the tempting thing to do when you need a second Metro on another port. Carry the prefix yourself, or the app shows "Could not connect to the server" and nothing explains why.
- **A Simulator that has latched its hardware keyboard cannot be unlatched from the command line, and it looks exactly like your screen ignoring taps.** The field focuses — caret, AutoFill bar — and no soft keyboard ever appears, so nothing can be typed and every keyboard-avoidance behaviour is unverifiable. `ConnectHardwareKeyboard` is **false at both the global and the per-device key** in `~/Library/Preferences/com.apple.iphonesimulator.plist` while this is happening, and quitting/relaunching Simulator.app does not clear it; only **I/O ▸ Keyboard ▸ Connect Hardware Keyboard** (⌘⇧K, on the focused device window) does. Sending that shortcut via `osascript` needs Accessibility permission the terminal usually lacks. **Diagnose in one step: `xcrun simctl launch <udid> com.apple.mobilesafari` and tap the address bar.** No keyboard there means it is device-wide, not your app — stop reading your own code. A freshly booted device usually comes up unlatched, so `simctl shutdown` + `boot` is worth one try before asking a human to flip the menu.
- **Do not use an automation tool's "type text" action against the Simulator.** It attaches a hardware keyboard as a side effect (see above), and its keystrokes reach the **dev-menu shortcuts** — `r` reloads the app, `d` opens the dev menu. (A development build has these too; leaving Expo Go did not retire this one.) Typing an innocent word into a search field is enough: `guard` contains both. The observable is a screen that navigates somewhere you never asked for, or an app that silently reloads onto a *different* project, and it reads as a routing bug. Type by tapping on-screen keys instead.

## Where to look for more

- [docs/decisions/history.md](docs/decisions/history.md) — full chronological narrative
- [docs/architecture/deployment.md](docs/architecture/deployment.md) — environments, Railway topology, migrations
- [docs/architecture/api-conventions.md](docs/architecture/api-conventions.md) — full REST/OpenAPI conventions
- [contracts/public.openapi.yaml](contracts/public.openapi.yaml) — the wire contract
- [docs/testing/functional-scenarios.md](docs/testing/functional-scenarios.md) — recommended functional test scenarios per feature
- [docs/TASKS.md](docs/TASKS.md) — the open list: every known gap, fix and queued feature
