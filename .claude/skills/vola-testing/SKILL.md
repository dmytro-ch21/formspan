---
name: vola-testing
description: What testing is mandatory for each kind of VOLA change, and the verification discipline that makes a green suite mean something. Use when writing or reviewing tests, deciding test strategy for a change, adding a test package, or evaluating whether existing coverage actually covers a guard.
---

Two principles carry everything else here, both earned the hard way:

- **Every assertion should fail when the code it covers is deleted.** The
  mobile suite was started because two harness tests passed for the wrong
  reason; eleven instances of apparatus-that-couldn't-fail were found in one
  afternoon. Full catalog: CLAUDE.md "Verify that a check can fail".
- **A green suite is only evidence once you've seen it fail.** Baseline
  green in the same session, then mutate, then red **as a test failure**
  (a compile error is a non-zero exit that proves nothing), then restore,
  then green again by RE-RUNNING — never by grepping the file to confirm
  the restore.

## Mandatory coverage by change type

| Change | Required |
|---|---|
| Backend module (internal/modules/*) | `postgres_test.go` gated on `TEST_DATABASE_URL` + a `main_test.go` taking the `testdb` advisory lock + own every library row the tests read (seed it yourself; `workout` is the package to copy) |
| Column added to `exercise`'s `updateWithin` | Restore-path test written BEFORE the migration — this exact change has silently blanked authored data three times |
| New API endpoint | Entry in `contracts/public.openapi.yaml` (`pnpm run lint:openapi`) + handler tests; error responses through `apihttp`, never hand-rolled |
| Mobile business logic | Pure-logic jest test in `apps/mobile/lib/__tests__/` — deliberately not component tests; what breaks here is concurrency and state reconciliation, not rendering |
| Anything about SQL behavior (mobile) | Fixture test against real SQLite via `support/sqlite.ts` (runs the app's own `migrate()`) — NEVER a regex over the query string, and never an array mock that can silently supply the behavior under test |
| Engine (engine/internal/*) | Postgres tests isolate via random per-test schemas (no shared advisory lock needed — see the runstate test helper's comment); Docker-gated tests skip cleanly when unavailable and pair every escape/negative test with a positive control so it can't pass vacuously |
| External provider integration | Verify the real contract against the live service at least once and record the measurement next to the code — a stub built from an assumption cannot falsify it |
| Device-only behavior (camera, keyboard, safe areas, dead spots) | No test can reach it: a `NEEDS HUMAN EVIDENCE` criterion on the ticket + `docs/testing/device-checks.md` |

## Suite-level tripwires and traps

- **Count the SKIP count, not the test count.** The backend suite has
  exactly one intentional skip (`TestLiveComplete`, real-money live call).
  A second skip appearing is the thing to investigate — a skipped test
  still prints `ok` for its package, and one skipped silently for months
  once.
- **Backend tests run `-p 1` and take a per-database advisory lock** —
  both, they solve different halves of the shared-`vola_test` problem.
  A new package that reads `TEST_DATABASE_URL` without `testdb.Main` is
  tramplable; the one-command audit for this is below, in "Backend test
  isolation and the shared `vola_test` database".
- **Mobile suite under load**: failures from CPU oversubscription are
  always a MISSING ELEMENT, never a wrong value — that signature means
  contention, not a bug in whichever file lost the coin toss. Another
  session running a suite → pass `--maxWorkers=3`; at very high ambient
  load, no flag helps — run the one suite you care about or wait. Full
  measured detail (CI's worker count, the local/CI split, why "reliably"
  was the wrong word) below, in "Mobile test-execution mechanics."
- **A green local `verify` is not evidence the DB-backed tests ran.**
  `verify` includes `test:engine`, but without `TEST_DATABASE_URL` exported
  its Postgres-gated tests SKIP silently (measured: 22 skips, all green);
  `test:api` isn't in `verify` at all, deliberately. Run them with the env
  var set, or read CI's Backend (Go) job, which sets it at job level.
- Ordering dependencies between test fixtures (lexical ID order, cleanup
  cascade order) are load-bearing and invisible at call sites — where a
  test depends on an order, ASSERT the order, so a rename fails loudly.

## Not covered here, and where it lives

- The full measured history behind each rule: CLAUDE.md's testing sections
  and `docs/decisions/history.md`.
- What reviewers check beyond tests: the `/pre-merge` skill.
- Recommended per-feature functional scenarios:
  `docs/testing/functional-scenarios.md` (living doc — update it when a
  user-facing feature lands).

## Backend test isolation and the shared `vola_test` database — the full mechanism

**Backend tests run with `-p 1`** (`test:api` and CI both), for **isolation**.
`go test ./...` runs packages in PARALLEL against ONE shared database, and
several tests assert global counts — `SELECT count(*) FROM techniques` and
friends. The moment a second package's fixtures seed library rows, those counts
include them: measured 3 failures in 6 concurrent runs. Scoping each assertion
was tried and abandoned — there are seven in one file alone, and every future
one would have to remember. If you add a test that seeds shared reference data,
`-p 1` is what is keeping it from breaking somebody else's package.

**`-p 1` only orders the packages inside ONE `go test` invocation, and this repo
routinely runs several at once.** A dozen worktrees share `vola_test`, so two
agents running the backend suite is the ordinary state here — and across two
invocations `-p 1` guarantees nothing at all. Measured 2026-08-20, four
concurrent suites on one database, `-count=1` throughout: nine packages failed,
`workout` 20 of 22 runs. Three distinct mechanisms, all of them the same shape —
somebody else's binary writing rows yours is reading:

- **Fixture deletion.** Every package seeds shared rows with fixed ids and
  deletes them on the way out. The neighbour's cleanup lands mid-test and you get
  `unknown exercise "wk_fx_bench_press"` for a row you seeded yourself
  milliseconds ago. This is #426, which fixed `session` and named twelve more.
- **Unscoped counts.** `technique`'s `seeded N but listed M`, `activity`'s and
  `workout`'s list-ceiling assertions — the same global-count problem `-p 1`
  exists for, arriving from another invocation where `-p 1` cannot see it.
- **Fixed-id collisions.** Two binaries INSERTing the same id: `already exists`,
  `duplicate key value violates "workouts_pkey"`, and a genuine `deadlock
  detected` in `bjj`.

**So every Postgres-backed test package now takes one database-scoped advisory
lock in `TestMain`** — `internal/platform/testdb`, one line per package (#454).
One binary at a time owns the database; the lock dies with the connection, so a
crashed run cannot wedge the next one, and the key is hashed against
`current_database()` so a per-branch `vola_test_<branch>` and CI's throwaway
database never queue at all. Same four-lane measurement after: **0 failures in
24 runs**, for **+17% wall clock** (387s → 453s for the 24 runs; per-run median
57s → 72s, and the spread *narrows*, 39–105s → 63–93s). That is the price and it
is worth naming: serialising is not free, it is cheaper than nine packages of
spurious red. **`-p 1` stays** — it is the right thing inside one invocation and
CI runs exactly one.

The rule for a new package: **if it reads `TEST_DATABASE_URL`, it gets a
`main_test.go`**. Both halves are asserted in place, so neither can be quietly
dropped — `TestTheFixtureLockIsHeldForThisBinary` goes red without the TestMain
(verified by mutation: remove the `Lock` call and all 24 go red).

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

> **`workout` was also the worst offender in #454 — 20 failures in 22 concurrent
> runs — and that is not a contradiction, it is the point.** Owning your rows is
> about the rows you **read**: it makes a package independent of what any *other*
> package seeded, which is exactly the ordering crutch the section above retired,
> and `workout` does it better than anyone. It says nothing about the rows you
> **write** while a second copy of your own binary is reading them. Doing the
> fixture discipline well makes a package seed more, own more and clean up more
> — so the better a package follows this list, the more damage its cleanup does
> to a neighbour. The two rules are orthogonal and you need both: own your rows,
> **and** take the lock. Copy this list; add the `main_test.go`.

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
fails in the ordinary `go test -p 1 -timeout 3m ./...` run with
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

**The backend suite has exactly ONE skip, and it is intentional.** Measured
2026-08-19 by three sessions independently: **34 test packages, 1 skip, 0
failures** on a migrated, never-seeded database. The skip is `TestLiveComplete`
in `internal/platform/llm/live_smoke_test.go`, gated on `LLM_LIVE=1` because it
spends real money on a live API call; it skips in CI too, and it **fails rather
than skips** when `LLM_LIVE=1` is set without a key — measured, not assumed:
`FAIL`, exit 1, and it fatals before a client is ever built, so checking that
claim costs nothing. That is what stops it being the silent-skip pattern this
section is about.

**Count the skip, not the tests.** The first two measurements recorded "~1092
tests"; the third counted **922 top-level tests, 1116 including subtests** — the
gap between those two is only how subtests are counted, and the drift from 1092
is #329 adding `health/handler_test.go`. A test total is a magnitude check that
every PR moves, so it cannot be a tripwire; the skip count is. Count with
`go test -p 1 -timeout 3m -json ./...` rather than grepping `-v` output, since
the grep is exactly the apparatus that silently counts something else. **Measured
again 2026-08-20 after #454: 39 packages, 37 of them with tests, 1155 top-level
tests, and still exactly one skip — `TestLiveComplete`.** #454 itself added 26
(one lock assertion per Postgres package, plus three on the lock), so a count
taken before it will not match one taken after; the skip count is the tripwire,
and it did not move.

The rule that keeps the lock coverage complete is one command, and it is worth
running if you add a test package: every package that reads `TEST_DATABASE_URL`
must also take the lock.

```bash
cd backend
comm -23 <(grep -rl --include='*_test.go' TEST_DATABASE_URL internal/ | xargs -n1 dirname | sort -u) \
         <(grep -rl --include='*_test.go' 'testdb.Main'        internal/ | xargs -n1 dirname | sort -u)
```

`internal/platform/testdb` is the one legitimate name that appears there — it is
the apparatus, holds no fixtures, and its own tests need the lock free. Anything
else is a package a second test binary can trample. **Note the `--include`:
without it the second grep also matches `testdb.go`'s own doc comment, which
names the call, and the check then reports every package as covered.**

**This paragraph used to say "zero skips: 28 packages, 583 tests"** and told you
any skip meant a regression. That was true when written and stopped being true
when the `llm` package arrived — so the next session to run with `-v` would have
seen a legitimate skip and gone hunting for a regression that did not exist. If
you see a **second** skip appear, that is the thing to investigate — check with
`-v`, because the package will still print `ok`.

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
confusing debugging session.

**The rule is not about `vola_test`. It is about any database you did not
create** — and on a deployed one it costs an environment rather than an
afternoon, which is what happened to staging on 2026-08-20 (story in
`docs/decisions/history.md`). `cmd/migrate` now refuses that case rather than
relying on you to remember it:

- `up` will not touch a **non-local** database unless the migration files are
  byte-identical to `origin/main`. The deploy image carries its own attestation,
  so a real deploy needs nothing from you — and there is deliberately no
  environment variable that turns any of this off.
- On **every** target, including your own scratch database, it refuses when the
  recorded version is above the highest migration here, or when one of your
  migrations is numbered at or below the recorded version and would therefore be
  silently skipped.
- `down` against a non-local database is refused outright.
- `migrate status` is read-only and always allowed. It prints the target, the
  recorded version and what is pending — reach for it before anything else.

The sharpest edge is `backend/.env.staging.local`: real staging credentials,
gitignored, one retyped variable away from being your `DATABASE_URL`.

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

**A THIRD case produces the same confusion and neither recipe above fixes it:
your own per-branch database is ahead of a migration it never applied.** Create
`vola_test_<branch>` and migrate it to `000062`, then rebase and pick up
somebody else's `000061` — golang-migrate does nothing, because the recorded
version is already higher. The symptom is not a migration error at all: it is
**20 tests failing with `column "note" of relation "exercises" does not exist`**,
which reads as the other branch being broken and is nothing of the sort. Check
with the `schema_migrations` query above; the fix is to **drop and recreate the
database**, never to touch migrations. Measured 2026-08-19 on N42's branch.


**If you are the branch with the unmerged migration, use your own database.**
`createdb -U vola vola_test_<branch>` and point `TEST_DATABASE_URL` at it. That
is the whole fix, it costs one command, and it is the only thing that keeps a
shared database usable while several branches carry schema changes at once.

**To undo one migration, do NOT run `go run ./cmd/migrate down`.** That command
takes no step argument: it calls golang-migrate's `m.Down()`, which unwinds
**every** migration and leaves you with an empty schema. (It is refused
outright against a non-local database now, but a local one it will still
happily empty.) There is no per-step
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

## Mobile test-execution mechanics — jest worker tuning and the fixture pattern

- `apps/mobile/lib/__tests__/` — jest (`jest-expo` preset). `support/sqlite.ts` gives tests a **real** database: `expo-sqlite` can't run here (jest-expo stubs the native module), so it is a thin async shim over Node's built-in `node:sqlite` — same engine, no new dependency — and `migratedFixture()` runs the app's own `migrate()`, so the schema under test is the schema that ships. **Anything about SQL behaviour belongs in a fixture test, never a regex over the query string**: a text assertion proves a clause is present, not that SQLite honours it, and an array mock can silently *supply* the behaviour under test. Both mistakes shipped here before the fixture existed. The rest is pure-logic coverage: the set transforms, the Clerk token broker, the sync orchestrator. Deliberately not component tests — what breaks in this app is concurrency and state reconciliation, not rendering. **Every assertion here should fail when the code it covers is deleted**; the suite was started because two throwaway harness tests passed for the wrong reason (a 300s token that never reached the offline path, and a backoff ladder already at 300s so a 5s wait proved nothing). Run `pnpm run test:mobile`; when adding a test, mutate the guard it covers and check it goes red. **`apps/mobile` is also linted now** (`pnpm run lint:mobile`, `eslint-config-expo`), which it was not for a long time — and that gap shipped a crash: a `useMemo` below an early return made every BJJ session opened from Today a black screen, and `react-hooks/rules-of-hooks` is the only thing that catches it, since hook order is a runtime property the typechecker cannot see. That rule is an **error**; the 55 findings the first run surfaced on never-linted screens (24 `react-hooks/refs`, 15 `set-state-in-effect`) are **warnings**, held by `--max-warnings` — **now 53**, lowered twice as findings were cleared. **The number in this file goes stale within hours**: it moved 54 → 53 on 2026-08-20 while five agents were mid-flight, and I relayed an unmerged branch's 53 to them while `main` still said 54, so both numbers were wrong in somebody's hands at the same time. **Read it from `apps/mobile/package.json`, never from here** — this sentence records that the ratchet exists, not what it currently is. That ratchet is the enforcement — this app's own PR added two warnings unnoticed before it existed, which is how a soft limit rots. Clearing findings means lowering the number; adding one fails the gate. **The suite runs under `TZ=America/Los_Angeles`** (set on the `test` script, at process launch) — a date bug that renders as the previous day west of Greenwich is invisible in UTC, so a UTC suite passes against the exact thing it covers. Note `process.env.TZ = ...` inside a test **does not work**: jest hands the sandbox a copied `process`, the runtime is never notified, and the zone silently stays UTC. That shipped once and passed. **The suite is CPU-bound, and jest sizes its worker pool from a number that overstates the machine.** It takes `os.availableParallelism() - 1` (falling back to `os.cpus().length`; the two agree on both machines here), which counts *threads*, so on any SMT machine it books more workers than there are cores to run them. Under-scheduled renders make a `waitFor` expire before the thing it is waiting for is drawn — so the failure is always **a missing element, never a wrong value**. That signature is how you recognise it. **Do not read it as a list of fragile files.** Which suite loses is arbitrary — whichever one is mid-`waitFor` when the machine is most oversubscribed. This file used to name `sharedScreen.test.tsx` and its "drops the accepted row locally" test, and that was actively misleading: `dictateScreen` and `bjjSessionScreen` have since failed the same way, and anyone hitting a red `dictateScreen` grepped this file, found only `sharedScreen`, and concluded they had found a new bug. The mechanism is the invariant; the filename is a coin toss. **Which timeout that is was wrong here until F13**: five component suites set `asyncUtilTimeout: 10_000`, but jest's own `testTimeout` was unset and defaulting to 5000ms, so jest killed the test first and the configured ten seconds was unreachable — measured, a `waitFor` at 10s died at 5003ms. `jest.config.js` sets `testTimeout: 15_000` now, so the budget those files ask for is the budget they get. **Two machines, two settings, and they are complements rather than rivals.** The CLI overrides the config, so they never collide:

- **CI** — `jest.config.js` sets `maxWorkers: 2`, guarded on `process.env.CI`. Measured from a real run (#409), not from a spec sheet: `ubuntu-latest` reports `nproc` 4 and `os.cpus().length` 4, so jest picks **3** — but `lscpu` on that same runner reports **2 cores per socket, 2 threads per core**. The four are hyperthreads on two physical cores, and the gap between those two numbers is the whole bug. Full suite (119 files) at the default: **6 failures / 35 runs**, 311–330% CPU against a 400% ceiling. At `maxWorkers: 2`: **0 failures / 30 runs**, 240–251% CPU, and **no wall-time cost** (24–32s either way). **`workerIdleMemoryLimit` was the rival hypothesis and it was run, not argued away**: `'512MB'` with workers left at the default still failed **3 of 10**, identical signature — which is what peak RSS of 785–910 MB against 15,989 MB of RAM already predicted. Memory was never the scarce resource. Pooling the two 3-worker arms against the 2-worker arm, Fisher's exact one-sided: **p = 0.007**. The `Runner capacity` step in the Mobile job prints all three numbers on every run, so the next person to touch this reads the machine instead of inferring it.
- **Locally** — the config leaves jest's default alone, because a 10-core Mac has no SMT and 9 workers really is right for a solo run (6.5s). **If another session is running a suite, pass `--maxWorkers=3`**: three instances at the default fight over 27 workers for 10 cores, wall time goes 6.5s → 33.7s, and a suite times out. Measured over 74 runs, **and it is not ambient load**: one instance under deliberate CPU saturation at load 89 never failed (0/12), while three instances at load 69 failed 8%. It is the worker count specifically. Capping each to 3 is 0/18 **and nearly twice as fast** (15.9s) — the same finding CI reached independently: the oversubscription was costing throughput, not buying it. **But a per-instance cap has a ceiling, and you will meet it.** Observed 2026-08-20 across several sessions: `--maxWorkers=3` appeared to rescue the suite at ambient load 26–40 and not at 156–171. **Re-measured 2026-08-25, and the word "reliably" was wrong** — a capped run at load 31–39 failed *worse* (3 suites, 15 tests) than an uncapped run at load 13.4 (1 suite, 9 tests), and the same suite went fully green twice as load fell. **Wall time is the tell: 655s under load against 56s clean, an 11× swing.** So the variable that tracks is AMBIENT LOAD, not the flag. The cap is worth passing and it is not a fix; a green run at load 13 says nothing about load 36, and a red one at load 36 says nothing about the branch. That is not evidence against the CPU story — a cap controls **your** contribution to oversubscription, not the machine's total, so at load 160 the cores are gone no matter what one instance asks for. When the machine is that busy, the honest options are to wait or to run the one suite you care about, not to hunt for a flag.

**This used to read "Deliberately not set in `jest.config.js`: CI runs one instance, where 9 workers is right."** That number was measured on the 10-core Mac and asserted about a machine the job has never run on — every CI job is `ubuntu-latest`, where jest got 3 workers on 2 physical cores and flaked for it. If CI ever moves to a different runner, **re-measure**; do not scale the number by a published vCPU count, because that inference is the defect itself.
