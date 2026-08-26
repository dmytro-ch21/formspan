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
  tramplable; the one-command audit for this is in CLAUDE.md's local-dev
  section.
- **Mobile suite under load**: failures from CPU oversubscription are
  always a MISSING ELEMENT, never a wrong value — that signature means
  contention, not a bug in whichever file lost the coin toss. Another
  session running a suite → pass `--maxWorkers=3`; at very high ambient
  load, no flag helps — run the one suite you care about or wait.
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
