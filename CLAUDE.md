# VOLA — instructions for Claude Code

VOLA is a unified training and nutrition platform for BJJ athletes who also strength train and track nutrition — one athlete profile and calendar connecting BJJ, strength training, and nutrition, with deterministic, explainable cross-sport recommendations.

**Start here for full context:** [docs/decisions/history.md](docs/decisions/history.md) — chronological narrative of what's been built and why. `docs/architecture/*.md` hold the current-state detail this file only summarizes.

## Repo map

- `backend/` — Go modular monolith, stdlib `net/http` (no web framework, deliberately). `cmd/api`, `cmd/migrate`, `cmd/seed`. `internal/modules/*` per domain, `internal/platform/*` for cross-cutting concerns (`auth`, `database`, `apihttp`, `llm`). Deep-dive on the `llm` platform package's provider/sentinel design: `docs/architecture/apps.md`.
- `apps/web/` — Next.js customer app, Clerk auth (prebuilt `<SignInButton mode="modal">`), Tailwind v4. Full Clerk/styling/routing detail: `docs/architecture/apps.md`.
- `apps/mobile/` — Expo + Expo Router, development build (`expo-dev-client`) since 2026-08-09, Clerk auth hand-built on the headless hooks, offline-first activity logging. Full architecture (auth flows, `AUTH_ROUTES`, offline sync): `docs/architecture/apps.md`.
- `apps/admin/` — Next.js admin console, same Clerk instance as `apps/web`, `/content` is the only write surface. Full ownership-model and write-path detail: `docs/architecture/apps.md`.
- `apps/mobile/lib/__tests__/` — jest (`jest-expo` preset), pure-logic + real-SQLite fixture tests, deliberately not component tests. Full test-execution mechanics (jest worker-count tuning for CI vs. local, the lint ratchet, fixture conventions): the `vola-testing` skill.
- `tests/functional/` — Playwright functional test suite (user-authored, in progress — evolving, don't assume its current shape without checking).
- `docs/testing/functional-scenarios.md` — recommended functional test scenarios per feature, meant to be translated into `tests/functional/` (or mobile's equivalent). A living doc, not `tests/functional/` itself — safe to update even when the test suite's own shape is uncertain.
- `contracts/public.openapi.yaml` — hand-maintained OpenAPI spec (not generated).
- `railway/*.toml` — per-service Railway config. **Only exists for services with real code behind them** — don't create a config for a service that has no binary/app yet.
- `docs/architecture/` — current-state docs (deployment, API conventions, per-app architecture in `apps.md`). `docs/decisions/history.md` — the project narrative.
- `assets/brand/` — the VOLA brand kit, and the **source of truth** for brand identity: logos, app-icon and splash masters, 25 UI icons, and `design-tokens.json`. All SVG — the rasters in `apps/mobile/assets/images/` are *generated* from these, so edit the SVG and regenerate, never the PNG. UI icons use `currentColor`, so recolour via CSS/props rather than by forking the file.

## Which platform gets a feature (hard rule)

**MOBILE FIRST. Everything must be manageable on the phone. Web is the
complementary surface where some of it gets richer.**

**Set by the user 2026-08-19, and it REPLACES the rule this section used to
open with** — "an in-progress session is a phone thing, the web app is for
planning and analysis". Their words: *"we have to have the mindset of mobile
first, we target people using only phones and have a complimentary web app that
is a bit more advanced. but everything should be managable on the phone."*

The old rule read as a **split**: some jobs belonged to the phone and others to
the desk. That is now wrong in one direction and still right in the other:

- **Wrong**: nothing may be phone-*impossible*. An athlete who never opens the
  web app must be able to run the whole product. If a job can only be done at a
  desk, that is a gap, not a design.
- **Still right**: the phone gets the version that answers the question in the
  moment, and web may carry a richer one. Deeper analysis, wide tables, side-by-
  side comparison and bulk authoring can be *better* on web — they may not be
  *only* on web.

The test changed accordingly. It used to be "which of the two is this?" It is
now: **"can an athlete with only a phone do this at all?"** If no, build the
phone version — however reduced — before or alongside the web one.

**What produced it**: `nutrition-design.md` §5 put target-setting on "one web
screen". So a user looking at a 2,700 kcal target on their phone had the
derivation in front of them and **no way to disagree with it**, because manual
entry existed only on web. That is the failure this rule now forbids: the
reasoning was reachable and the action was not.

**Consequence for §5 and anything like it**: a doc that assigns a capability to
web *exclusively* is superseded on the exclusivity, not on the design. §5's
three sections are still the right three sections; "one web screen" is now "one
screen on each, and the phone's may be smaller".

- `scripts/generate_sounds.py` — the **sonic** identity, same relationship to the app that `assets/brand/` has: the sounds are synthesised, not sampled, and the script is the source of truth. It renders a 17-sound family (F# pentatonic, four struck voices — `glass`/`bell`/`marimba`/`pad`) but the app bundles only the ones listed in `BUNDLE` (eight so far), under the filenames `apps/mobile/lib/sounds.ts` already `require`s. The rest go to a gitignored `assets/audio/` for auditioning; adding one to the app is three lines (`BUNDLE`, `SOUND_NAMES`, and the matching `require` in that file's `SOURCES` — `SoundName` derives from the array and `SOURCES` is keyed on it, so extending one without the other fails typecheck). **This is the one script that is not stdlib-only** — it needs numpy and ffmpeg, which is what buys the convolution room and per-partial voicing. Nothing in CI or `verify` imports it, so that is not a pipeline dependency — `check:python` only `ast.parse`s. **`--check` needs numpy and ffmpeg too**: it re-renders every sound and byte-compares rather than hashing against a manifest, and it reports drift without ever failing. Levels are intentionally unequal (−19 dBFS for a tap, −4 for rest-over); do not "fix" that by normalising them together.
- **Mobile** owns live logging: recording sets mid-workout, the rest timer, swapping an exercise because the rack is taken. These are done standing up, one-handed, with 20 seconds between sets.
- **Web** owns authoring and review: building templates (two-pane, catalog always visible), reading history back, and the analytical surface. It can also start, review and correct a session — those are desk activities — but it does **not** get in-workout affordances. A rest countdown on a desktop you are not standing next to is decoration.

~~This was re-litigated per feature for a while; it isn't open.~~ **Superseded by the mobile-first rule above.** The two bullets remain a good description of where each surface is *strongest* — a rest countdown on a desktop is still decoration, and a two-pane template builder is still better with a keyboard. They are no longer a licence to make something phone-impossible. When adding to the session flow, say in the history entry how it is reachable on a phone.

**One carve-out, added 2026-08-17 for N5, and it is narrow on purpose.** A
*trend you read in three seconds to decide something* is not analysis, it is
decision support — and the decision it supports is usually made away from a
desk. "Am I losing weight fast enough" is answered in a supermarket, not in a
spreadsheet. So a small read-only chart may live on mobile when **all** of these
hold:

- it answers ONE question, with no metric picker;
- the decision it informs is made while away from a computer;
- the comparable, exportable, correlate-it-with-training-load version still
  lives on web, and this is not a step toward moving that.

`apps/mobile/app/checkin/trend.tsx` is the first and currently only instance.
The test is the three bullets, not "is it a chart" — the moment one grows a
second metric or a **date-range picker** it has become the web screen and
belongs there.

**AMENDED 2026-08-19, by the user, and the reason matters more than the
change.** The first bullet used to forbid **axes to read values off, tooltips
and zoom** as well. Those three are struck. The rule was written to keep
*analysis* off the phone and it did something else: `trend.tsx` is 105 lines
with no axis labels, no value labels and no point labels at all, and the user's
verdict on it was "pretty much useless". A chart you cannot read a number off
does not answer one question in three seconds — it answers none, and the
athlete goes to a desk anyway, which is the outcome the carve-out existed to
prevent.

So a mobile trend chart **may** now carry: value-readable axes, a label on the
first and latest points, a dashed projection to a dashed goal line, a delta
against a stated period, and a list of the entries behind it. **What still
disqualifies it is unchanged and is the whole rule**: a second metric, or a
date-range picker — a control that lets the athlete choose a start AND an end,
which is comparison, and comparison is still the web screen's job. Preset
windows that all END TODAY (`1W 1M 3M 6M 1Y All`) were always allowed and still
are; that paragraph below was already explicit and is unchanged.

The other two bullets — the decision is made away from a computer, and the
comparable exportable version still lives on web — are untouched and still
both have to hold.

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
- **Adding a column to `exercise`'s `updateWithin` has silently blanked data three times.** `load_mode` (migration 000052), `implements` (000057) and `note` (000061) each added the column to the SET clause, which made `Restore` overwrite an authored value with an empty one — and `writeWithRevision` then recorded the wipe as a legitimate revision, so the damage looked like history rather than a bug. **All three were caught in review; none was caught by the suite**, and the guard documenting the mechanism was sitting right there each time. Nothing structural prevents a fourth: if you add a column to that function, write the restore-path test before the migration.
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
   when you write it — and claim one STRICTLY ABOVE the highest there. Never
   fill a gap below it.**

   **A migration numbered below the database's current version is SILENTLY
   SKIPPED, and `migrate up` prints `done` and exits 0.** golang-migrate tracks
   one integer and applies only what is strictly above it; the filenames look
   like a list, the tool sees a number. Measured 2026-08-19 on a database
   migrated from `main`: version 66, add a `000065`, run `up` → `"migrate: up:
   done"`, exit 0, **version still 66, the new columns absent**. No error, no
   warning, no dirty flag — the one output a deploy checks says it ran.

   **CI cannot catch this.** The `Backend (Go)` job migrates a throwaway
   database that starts at zero and applies everything in order, so a gap is
   invisible there and stays green forever. Staging and every developer machine
   that has pulled `main` are already past the number, so the columns simply
   never exist on any of them. The symptom surfaces much later and somewhere
   else — every call failing on `column "…" does not exist` — which reads as a
   code bug and is a numbering one.

   **A gap in the sequence is not free space.** It is a number only a database
   that has not yet reached it can ever apply. `main` currently has a permanent
   harmless hole at `000065` for exactly this reason; leave it there. This rule
   exists because the coordinating session told somebody to fill it, which is
   the natural thing to suggest when a list has a hole in it.
 Two branches picking `000043` is not something
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

**Two sessions can run it at once, as of N45 (#333)** — it used to pin port
8099 and the second concurrent `verify` died. It now binds port 0 and reads the
assignment back, so the kernel picks; `EXPO_TYPEGEN_PORT` pins one anyway for a
run you need to find in `lsof`, and a pinned port is never retried. Worth
knowing if you ever see it fail: the symptom was never the `EADDRINUSE` it
looks like — Expo notices the busy port and asks `Use port 8100 instead?`, then
dies because `CI=1` makes it non-interactive, so grepping the logs for
`EADDRINUSE` finds nothing. Measured both ways: two concurrent runs of the old
script still reproduce it, two of the new one both pass on adjacent
kernel-assigned ports.

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

### CI can run ZERO checks, and that looks exactly like passing (hard rule)

**Count the check runs. Never read the absence of failures.**

```bash
pnpm run ci:checks          # the current branch's PR; --pr <n> or --sha <sha> also work
```

It must report 6 and exit 0 — 6 being however many jobs the workflows declare
today, which the script derives rather than assumes: it cross-checks the derived
set against `EXPECTED_CHECK_RUNS` in `scripts/check-ci-checks.py` and **fails
loudly if the two disagree**, so adding a CI job means changing that constant in
the same commit rather than discovering later that the bar quietly moved. (This
number has already drifted once — see the 2026-08-20 probe-PR #401 correction
below — so read it from `EXPECTED_CHECK_RUNS` itself if you ever suspect this
sentence is behind the code again, rather than trusting the numeral here.)
A count of **0** satisfies "no failures"
trivially: `gh pr view` shows nothing red because there is nothing at all,
`statusCheckRollup` is an empty list, and `mergeStateStatus` does not
distinguish the two either. This is the absence-reads-as-answer failure landing
in the one place that decides whether code ships, so it gets its own command
rather than a habit.

**The cause is known, as of 2026-08-20 (N65, #368).** A `pull_request` workflow
does not run on your branch — it runs on `refs/pull/N/merge`, the commit GitHub
builds by merging your head into the base. **If the PR conflicts with its base,
that merge commit cannot be built, so no NEW workflow run is created**, with no
failure, no annotation and nothing anywhere saying so. Your branch is not broken
and CI is not down; the pull request is simply unmergeable and GitHub declines
silently.

**"No NEW run", not "no runs" — and the difference is a trap of its own.**
Existing check runs are never withdrawn, so a PR can show a **full set of green
checks while conflicting**. Measured on #395: six runs started `14:40:33Z`, the
merge that created its conflict landed `14:40:52Z` — nineteen seconds. Those
checks are real and they passed, but they describe a merge commit that **no
longer exists**; GitHub will refuse the merge, and rebasing re-runs all of them.
Every GitHub surface calls that state ready to merge. `ci:checks` exits **5**
on it (`GREEN, BUT STALE`), which is the only thing that will tell you.

So **if a PR shows zero checks, this is the first thing to do, not the last**:

```bash
git fetch origin && git rebase origin/main && git push --force-with-lease
```

It costs nothing when CI is healthy and it is the fix when it is not. Note the
trap in the shape of it: a long-lived branch is *fine* until `main` happens to
touch a line it also touches, and then it goes quiet — so the branches this
bites are the ones that have been open longest and had the most pushed to them.
`docs/decisions/history.md`, `docs/testing/functional-scenarios.md` and
`package.json`'s `verify` line are the files every task edits, which is why this
recurs. (`docs/TASKS.md` was a fourth until 2026-08-20 archived it — and it was
the one that wedged the branch in #368, so moving the open list to Issues
removes one source of this, not the mechanism.)

Measured, both directions, on one throwaway PR with the same one-line diff and
only the base changed: conflicting head → **0** check runs, `mergeable:
CONFLICTING`, `mergeStateStatus: DIRTY`; rebased head → **5** runs within two
minutes, `mergeable: MERGEABLE`. Draft status is not involved — a clean draft
PR gets its five.

`pnpm run ci:checks` reads the PR's **`headRefOid`**, not the newest run on the
branch, because `gh run list --branch` will hand you a green run for a commit
two pushes ago. It also prints `CONFIRMED CAUSE` when `mergeable` is
`CONFLICTING`. `check:ci-detector` in `verify` (and in CI) is its offline
self-test, not a check of any PR.

Exit codes are distinct on purpose: **1** nothing ran, a declared check is
missing, or one was **skipped**; **2** something failed; **3** still running;
**4** could not ask GitHub; **5** green but the PR is CONFLICTING, so the green
is about a merge commit that no longer exists. A *skipped* check is counted as
not-checked rather than passed — five jobs behind a job-level `if:` are five
check runs with the right names and a green tick, which is the same absence
wearing better camouflage.

One deliberate tolerance: `mergeable` is `UNKNOWN` for a few seconds after every
push, and `ci:checks` prints a note and still exits 0 there rather than crying
wolf on healthy PRs. **If you see that note, run it again** — the second call is
when GitHub has an answer. Observed on #395: `UNKNOWN` then `CONFLICTING`,
seconds apart.

**Marking a PR ready for review is gated.** `.github/workflows/pr-has-work.yml`
fails a PR that is **ready** while its three-dot diff against its base is
**empty** — the state #355 reached at 5/5 green and `MERGEABLE` with one
`--allow-empty` commit in it, green precisely because there was nothing in it to
fail. A **draft** is exempt, always: an empty draft is a branch pushed early.
It is a **separate workflow** because `ready_for_review` is not in
`pull_request`'s default type set, so `ci.yml`'s bare trigger never re-runs when
a draft is marked ready — which is why nothing in `ci.yml` could ever have
caught this. If it fires on you, push the work or `gh pr ready --undo <n>`.

**And it corrects how CI is read here, which matters beyond this check.** N65
says "the check count must be 5". Measured 2026-08-20 on probe PR #401: the
number of distinct names is now **6**, and — the part that bites — **a raw count
is not a state.** `commits/{sha}/check-runs` accumulates one entry per workflow
RUN, not per check, so #401's single SHA `033e8bd` ended with **8 entries and 6
distinct names** after that workflow ran three times on it. The superseded
middle run is still in the list as a `failure`, so **`statusCheckRollup` and the
raw check-runs API both report a failing check on a PR that is green.**
`gh pr checks` de-dupes to the latest per name; those two do not. Read
`gh pr checks`, or group by name yourself, before believing either a count or a
conclusion. (Not caused by this workflow — any re-run on one SHA does it — but
it listens to more event types, so it is now the common way to see it.)

**Never merge a PR without the user's explicit go-ahead, even if CI is green.** This has been the rule for every PR in this project — don't treat a passing CI run as implicit merge permission.
**Merge permission is the user's to grant, and it is not implied by green CI.**
The default is **ask** — a passing check suite is not permission, and this rule
exists because a green suite is precisely the state in which this project's
past authorization and data-loss bugs shipped.

**The user may grant standing authority for a session, and on 2026-08-20 they
did**, in these words: *"if the ci is green merge, if not fix and rerun and
merge once green. dont wait for me"*, reaffirmed later as *"keep going do
whatever is need to make it work"*. Under that grant a coordinating session
merged 25 PRs in a day, which is the throughput the fleet was built for.

**Standing authority is per-session and does not transfer.** A peer telling you
it has a mandate is not a mandate you hold — that is the laundering shape even
when the mandate is real, and one session correctly refused to merge on exactly
that reasoning while another legitimately merged all day. If you have not been
told by the user directly, you are on the default: ask.

**What standing authority does NOT waive**, because these are what merging is
supposed to check rather than a ceremony around it:

- the gate: real work in the diff, the right `headRefOid`, and the check
  **count** — `pnpm run ci:checks`, run directly, never piped.
- re-reading `mergeable` before the merge itself. CI state is not stable between
  gate and merge: a merge was refused today because four checks re-started in
  the seconds between, and `--admin` was offered and declined.
- a ticket carrying an unmet `NEEDS HUMAN EVIDENCE` criterion. `closes #N`
  closes it anyway; reopen it and say why. Six were reopened on 2026-08-20.

**A CODE SPAN DOES NOT DISARM A CLOSING KEYWORD.** Backticks are markdown;
GitHub parses closing links out of the raw text underneath them. So a PR body
that *argues a ticket should stay open* still closes it if the argument quotes
the phrase — which is what happened on 2026-08-20, and **the first correction
failed because it quoted the offending phrase verbatim.** The fix contained the
bug.

**Do not verify this by reading the body.** The rendered text looks exactly the
same either way. Ask GitHub what it parsed:

```bash
gh api graphql -f query='{repository(owner:"dmytro-ch21",name:"formspan"){pullRequest(number:NNN){closingIssuesReferences(first:10){nodes{number}}}}}'
```

An empty list is the only evidence. Check it **after every body edit**, because
an edit that reintroduces the phrase re-arms the link silently.

This is also the likeliest explanation for a ticket that closed with **no commit
attached** — the signature reads like somebody clicking, and a keyword in a PR
body produces exactly the same trace.

## The open list (hard rule)

**The open list is GitHub Issues, on the `VOLA` board:**
<https://github.com/users/dmytro-ch21/projects/2> (also linked from the repo's
Projects tab). Every known gap, fix and queued feature is one issue. **Read the
board before starting work, and claim your issue before you write anything.**

`docs/TASKS.md` is an **archive**. It is the record of everything considered up
to 2026-08-20 and the place the `T` traps still live (below). **Do not add a line
to it and do not tick one** — a tick there now means nothing, because nothing
reads it.

Each issue keeps its **stable id** in the title — `N74 — one shared image-upload
helper` — and the id is the same one `TASKS.md` used, so "closes N42" in a commit
message from a year ago still resolves. The prefix is the section:

| Prefix | Means |
|---|---|
| **W** | Wrong on screen right now — contradicts itself or overstates what the athlete did |
| **T** | A trap: compiles, passes its tests, and is wrong |
| **F** | Worth fixing |
| **N** | New work |
| **L** | Recorded, low |
| **H** | Housekeeping |

Labels carry the same thing (`section: N`, `priority: high`, `area: mobile`) so
the list is readable from `gh issue list` without the `project` scope. The board
adds `Status`, `Priority` and `Section` columns on top.

**Ids are never reused.** Allocate the next one by scanning **all** issues, open
and closed, **and open PR titles** — a claim PR can hold an id whose issue does
not exist yet:

```bash
gh issue list --state all  --limit 500 --json title -q '.[].title'
gh pr list    --state open --limit 100 --json title -q '.[].title'
```

Take the highest number for that prefix and add one. **Never fill a gap below
it** — a gap records an id that was allocated and abandoned, not free space.

**Detail belongs in `docs/decisions/history.md`.** An issue is an index entry
with acceptance criteria, not a narrative.

**The `T` section of `docs/TASKS.md` is still live and still load-bearing.** Those
are traps — changes that compile, pass their tests, and are wrong. They are not
tickets: nobody claims one, nobody closes one, and they are read *before* you
touch the area they describe. They stayed in the repo deliberately, because their
value is that a `grep` in your working tree finds them. If your work touches one,
read it first — every entry there was found by review after the check suite went
green.

### Merged is not done: the evidence latch (hard rule)

**`closes #N` fires on merge, and for a ticket carrying a `NEEDS HUMAN EVIDENCE`
criterion that is the wrong answer** — the code has landed and the evidence has
not. That is not an edge case. It is the normal end state for device-reported
work, which is most of what the athlete actually notices.

On 2026-08-20 six tickets closed that way and were reopened by hand (#414, #365,
#406, #434, #444, #388), and **five more closed the same day and were not** —
#388, #402, #409, #433, #446 — because nobody was watching those merges. A closed
ticket is the one state nobody re-reads, so its outstanding criteria go with it.

**You do not have to do anything differently.** Keep writing `closes #N`. GitHub
still closes the issue, and `.github/workflows/evidence-latch.yml` reopens it
within seconds, labels it `evidence-outstanding` and comments the outstanding
checks. The label **is** the state — *merged, awaiting evidence* — and the board
view filtered on it is the list of what is owed.

**To finish one, say what you saw**, in a comment on the issue:

```
/evidence ran it on the 15 Pro, both belts, expanded and collapsed — labels stay
above the keyboard
```

That ticks the evidence criteria, drops the label and closes the ticket. Ticking
the boxes by hand works too. The observation has to read like a sentence — at
least three words — because `/evidence xxxxxxxx` is the tick-box again.

**If a ticket is not going to happen, close it as `not planned`.** That is left
alone. Closing it as *completed* with evidence outstanding is what reopens it.

**The observation is required, and a bare `/done` is refused on purpose.** Do not
add one later as a convenience: a ticket asserting that evidence exists without
saying what was seen is exactly the tick-box this replaced.

Two things about how it decides, because both are easy to get wrong:

- **The marker has to be a LABEL, not a noun.** It counts when it opens the
  checkbox (the common form) or when a `:`/dash follows it mid-line. It does not
  count when the phrase is the *subject* of a sentence — "a ticket whose
  `NEEDS HUMAN EVIDENCE` criteria are outstanding" is a mention. Both errors are
  real and both were measured: a naive substring rule reopens every ticket that
  merely discusses this feature (#456 is one), and a purely positional rule
  misses #410's genuine device check, which is the original bug with the sign
  flipped. `--self-test` holds live lines of each kind.
- **Only someone with write access can release the latch.** This repo is public,
  and the workflow lends its `issues: write` token to whatever a comment says —
  so without that check a stranger's `/evidence` would tick the maintainer's
  criteria, rewrite the issue body and close the ticket. Unauthorised attempts
  are ignored silently rather than answered, so the bot cannot be used as a
  comment amplifier.
- **The silent majority stays silent.** An issue closing with no unticked
  evidence criterion is not touched, not labelled and not commented on. Closing
  as `not planned` is likewise left alone — that is a decision, not a slip.

The board's `Status` field does carry an `Awaiting evidence` option (and a
`Blocked` one) — but CI never writes either. Writing a Projects v2 field from
CI still needs a long-lived PAT, and that credential is still the board
owner's call to make, so the reasoning that kept this out of automation holds.
`Status → Awaiting evidence` is a manual value, set by hand the same way
`Status → Done` is (see the `vola-ticket-sdlc` skill's pipeline checklist,
step 12) — typically right after the evidence latch reopens a ticket. The
`evidence-outstanding` label remains the thing CI itself actually writes;
the Status option is a hand-set convenience layered on top of it, not a
substitute for it.

**The zero-credential version of that state is still a saved board view
filtered on `label:evidence-outstanding`** — ten seconds in the Projects UI,
no secret, and it makes "merged, awaiting evidence" readable at a glance even
for a ticket whose `Status` hasn't been updated by hand yet. Not done here
because it is a UI action on somebody else's board, not a change to this repo.

**Never post a comment containing `/evidence` at the start of a line unless you
mean it.** The latch reads column zero only, and stamps its own comments with a
sentinel it refuses on the way back in — both guards exist because the latch
once attested to its own instructions and re-closed three tickets it had just
reopened. Quote the gesture indented or inline, as this file does.

### At most three at once (hard rule)

**Three agents in parallel. Three tickets `In Progress`. Set by the user on
2026-08-25, in these words:** *"we need at most 3 agents working on parallel
with 3 tickets at most in parallel. I dont want this flood of tickets 12 in
progress doesnt make any sense."*

Recorded machine-readably in `.vola-agent/policy.json` as
`max_parallel_agents` and `max_tickets_in_progress`, so the number lives in one
place and this section does not go stale quoting it.

**What produced it.** On 2026-08-20 roughly thirty PRs merged in a day across a
dozen concurrent sessions, and the cost was not throughput — it was that
**nothing could be followed**. Four days later the board carried **17 assigned
issues behind 5 worktrees**: a dozen claims with nothing behind them, which is
precisely the failure the claiming convention above was rewritten to prevent,
returning at scale the moment the fleet grew.

**A ticket `In Progress` is a promise that somebody is on it right now.** Twelve
of those is not twelve times the work; it is a board that lies, twelve times.

**The consequences, so this is not merely a number:**

- **Do not dispatch a fourth.** Queue it. A queued ticket stays `Todo` and
  unassigned, which is true, rather than `In Progress`, which would not be.
- **Interlocking work is a sequence, not a fan-out.** A twelve-ticket
  workstream where each assumes the last is three tickets, then three more —
  and the second three are dispatched when the first three land, not when the
  first three are *nearly* done.
- **This binds the coordinator hardest.** The pressure to start one more comes
  from wanting the board to look busy, and a busy board that nobody is reading
  is worth less than a short one that is true.

### Claiming (hard rule)

The board is ordered by what an athlete would notice, so every session that opens
it independently picks the same top line. Two full rounds of work were lost that
way in a single afternoon — W2, then W4 — both times with the checks genuinely
run.

**A claim is one server-side write, and it is visible the moment you make it:**

```bash
gh issue list --state open --json number,title,assignees \
  -q '.[] | select(.assignees|length==0) | "\(.number) \(.title)"'   # what is free

gh issue edit <n> --add-assignee @me                                 # claim it
gh project item-edit ...                                             # Status -> In Progress
```

Assigned, or `Status` past `Todo`, means taken. Unassigned and `Todo` means free.

**`In Progress` means DISPATCHED — a session is actually on it. Nothing else.**
Set it at the moment work starts, together with the assignee, and never earlier.

Two different facts live on the board and collapsing them breaks it:

- **Board position is PRIORITY** — what we believe is most valuable next.
- **`Status` is WHAT IS HAPPENING** — who is on it, right now.

Prioritising a ticket is not claiming it. Marking something `In Progress` because
it is important next tells every other session to skip a ticket nobody is
working, which is **a claim with nothing behind it** — the exact failure the move
off `docs/TASKS.md` was meant to end. It happened within an hour of the move, to
the session that did the move, on two tickets, because a user asked for them to
be prioritised and prioritising felt like claiming.

To raise something's priority, move it up the board and leave `Status` alone. If
you cannot staff a ticket you have claimed, **un-claim it** — `Todo`, unassigned,
position untouched — rather than leaving the board asserting something untrue.

Then open your PR with **`closes #<issue>`** in the body, so merging closes the
issue. **The board's `Status` does NOT follow — set it to `Done` by hand after
the merge.** This line used to promise the move happened "without anyone
remembering to"; measured on N187 and N188 (2026-08-26), both issues closed
while the board still said `In Progress`, and the review that caught the
discrepancy queried the board live: the built-in "Item closed" workflow on
Projects board 2 is **disabled** (`enabled: false`). Until someone deliberately
enables it, a closed issue at `In Progress` is the normal post-merge state, not
somebody's mistake — the by-hand mutation is `updateProjectV2ItemFieldValue`
(the `vola-ticket-sdlc` skill carries the recipe).

**And note `docs/TASKS.md` is an ARCHIVE**, not the list — do not tick a line
there to record any of this. The full account is in *The open list* above; it is
restated here because this is the section somebody jumps straight to, and three
sessions in one afternoon learned it from a colleague rather than from the repo.

**Why this replaced the empty-commit-plus-draft-PR convention.** That convention
existed for one reason: *a check cannot see work that has not been pushed*, so a
claim had to be pushed to exist. It worked, and it cost an empty commit, a
branch and a draft PR before any thinking had happened — and **it still lost W2
and W4**, because the window between deciding and pushing stayed invisible.
Assigning an issue closes that window: there is nothing local about it, so there
is no unpushed state to be blind to.

Three things it also fixes, all of which bit:

- **A claim is no longer a `[claim] …` PR title that has to be edited later.**
  `gh pr edit` fails outright in this repo on a deprecated Projects-classic
  GraphQL query and silently changes nothing, so a title still reading
  `[claim] …` after an apparent success was that, not a typo. Use `gh api -X
  PATCH repos/dmytro-ch21/formspan/pulls/<n>` if you must retitle a PR;
  `gh pr ready` and `gh pr create` are unaffected.
- **A new id is visible immediately.** `gh pr list` shows titles, not diffs, so a
  new id filed inside an open PR's `TASKS.md` used to be invisible to every other
  session until that PR merged — two sessions allocated **N19** the same
  afternoon that way. An issue exists the moment it is created.
- **A tick can no longer lag its fix.** Migrating the list on 2026-08-20 found
  **three** tasks marked open whose work had already merged — N68 (fixed in #353,
  ticked a day later in #362), N73 and N70. Each was a separate file edit that a
  feature PR had not made. `closes #<issue>` is not a separate edit.

**What it does not fix.** Nothing enforces any of this. Claim *early* — an issue
can be assigned before there is anything to show, which is the whole point.

**And treat silence as ambiguous.** An unassigned issue is not proof nobody is
working on it, only that nobody has said so; an empty query result is not an
empty world. That is the same rule as *Verify that a check can fail* below, and
it applies to the board exactly as it applies to CI — see **absence is not
evidence** there.


## Keep the history log current (hard rule)

[docs/decisions/history.md](docs/decisions/history.md) is a living document, not a one-time snapshot. Whenever a PR lands (or right before merging one) that represents a material decision or a notable chunk of work — a new module, a new convention, an infrastructure change, a bug found and fixed, a provider/tooling choice — **append a dated entry** to it in the same style as the existing entries: what was decided/built, why, and any open questions or gaps it leaves behind. Do this as part of finishing the work, not as an afterthought someone has to remember to ask for.

**Append immediately BEFORE the trailing `## Open items / known gaps as of this
entry` heading — never after it.** The file ends with that heading and its
bullet list, and branches have anchored on both sides of it: insert before and
the heading keeps its list, insert after and the heading is stranded on the
newest entry while its list drifts below, reading as though those gaps belong
to whatever landed under it. Two branches doing different things merge into
exactly that, and it has been repaired **four** times. One side, always: before.

**And the reason it keeps recurring is that FINDING the heading is the hard
part, which this rule never said.** The file contains **five** occurrences of
that string and **only the last is a heading** — the other four are prose,
inside entries describing this very repair. So each repair adds another decoy,
and the trap gets measurably worse every time somebody falls into it.

An insert anchored on *a* match, or on the *first* match, therefore lands in the
middle of the file with near-certainty. Measured 2026-08-21 on `origin/main`:
matches at lines 16330, 16625, 17040, 37450 and 37937, of which 37937 is the
heading. A branch that anchored on 16330 cut an eight-year-old sentence in half,
left a spurious column-0 `## Open items` heading parsing as real at line ~16453,
and put a 2026-08-21 entry twenty-one thousand lines above the 2026-08-20 ones.
Nothing failed; `verify` was green and all six CI checks passed, because no check
reads this file's structure.

So: **anchor on the LAST occurrence.** `s.rindex(heading)` in Python, `grep -n
... | tail -1` in shell — never `index`, never a bare regex `search`, never the
first hit of an editor's find. And **verify by counting, not by reading the
diff**, which looks correct either way:

```bash
grep -c '^## Open items / known gaps as of this entry' docs/decisions/history.md   # must be 1
```

**That count is now a check rather than a habit** — `pnpm run check:doc-merge`,
in `verify` and in CI. It asserts exactly one line *is* the heading and that it
is the **last** `## ` heading in the file, which is the invariant this section
has described for four repairs and nothing ever read. Verified by reproducing
the historical defect, which it reports at line 16331 against the 16330
measured above. It also refuses an **unterminated** code fence, because that
blanks the rest of the file to a fence-aware reader and a stranded entry below
one was invisible.

**When you quote this heading inside a code fence, indent it.** The check skips
fenced blocks, so an example costs it nothing — but the `grep` above does not
know what a fence is, and a column-0 heading inside one moves its answer from 1
to 2. That is the recipe reporting a defect that is not there, which is how a
habit gets abandoned. The check enforces the agreement, so a fenced example at
column 0 fails it and tells you to indent. This branch tripped it while writing
the entry describing the trap.

Skip the entry only for truly trivial changes (typo fixes, formatting) that don't represent a decision anyone would need to know about later.

### Appending no longer conflicts with every other open PR (N63)

**This file used to guarantee a conflict between any two open PRs.** 17 of 20
commits on 20 Aug touched it, 9 of 10 on 26 Aug — so a PR open across one merge
cycle conflicted with all the rest, and a conflicting PR gets **zero check
runs**, which reads exactly like nothing failing.

`.gitattributes` now routes `docs/decisions/history.md` and
`docs/testing/functional-scenarios.md` through `scripts/append-only-merge.py`.
It resolves **one** case — both sides inserted at the same anchor and neither
changed or deleted anything, so git's diff3 base region is empty and
concatenation is the only loss-free answer — and leaves every other conflict
with markers, exactly as before. It never looks for a heading: the anchor is
git's own, which is why the `## Open items` convention survives it structurally
rather than by recognition.

**What you have to do: nothing, except `pnpm install` once.** The driver
definition lives in `.git/config`, which is not versioned, and `postinstall`
writes it. If it was never installed, git falls back to the built-in merge —
you get today's conflict, never a wrong resolution. One install covers every
worktree.

**Do not swap it for `merge=union`.** That is the obvious answer for an
append-only file and it silently keeps both sides of an edit to the same line,
and silently reverts a deletion the other side reworded. Both cases run against
git's real union driver in `--self-test`.

`package.json`'s `verify` chain is the other file every task edits. It is one
line, so it is not append-shaped and this does nothing for it —
`check-verify-chain.py` is still what notices a dropped link.

## Keep functional test scenarios current (hard rule)

[docs/testing/functional-scenarios.md](docs/testing/functional-scenarios.md) is a living document, same discipline as `docs/decisions/history.md`. Whenever a new module or user-facing feature lands — a new backend endpoint, a new web route/page, a new mobile screen — **add its recommended scenarios** (happy path, edge cases & errors, and auth/security where relevant) as part of finishing that work. Don't write the actual Playwright/test code yourself unless asked — `tests/functional/` is the user's own in-progress suite; this doc is the reference list they (or a future session) translate into real tests. Skip it only for changes with no user-facing or API-surface behavior (refactors, docs, CI tweaks).

## Review before every PR (hard rule)

**Run `/pre-merge` before opening or updating any PR.** It is one gate that
runs the CI-equivalent check suite, the **acceptance-criteria check**, and the
review subagents in `.claude/agents/`:

- **`ac-verifier`** — the branch against the acceptance criteria of the issue
  it closes. **Every criterion must be `MET`, or carry a stated reason, before
  the PR goes ready-for-review** — that is exactly what moving the issue to
  `In Review` on the board asserts. It returns four verdicts, and
  `NEEDS HUMAN EVIDENCE` is the one that matters: a criterion saying *seen on a
  device*, *verified against the live provider*, or *mutation-check the suite
  and confirm it goes red* **cannot be upgraded to met by code that looks
  right** — reading the code is the thing those criteria exist because it
  fails. Produce what evidence you can yourself, then **hand the remainder to
  the user as a numbered checklist and wait** — they run these deliberately, to
  catch bugs early, and the issue does not move to `In Review` until they
  report back.

- **`backend-reviewer`** — for `backend/**` or `contracts/**`. Security
  (authorization gaps/IDOR, information disclosure, secrets/PII in logs),
  correctness, performance (N+1s, missing indexes, unbounded lists), and
  adherence to the module pattern above.
- **`frontend-reviewer`** — for `apps/**`. Security (server/client boundary
  leaks, client-only authorization), correctness (Server vs Client
  Components, `useEffect` deps, error states), performance, accessibility,
  and design-token/convention adherence.

All three are **read-only diagnostics** — they report, they don't fix. Resolve
or explicitly justify every `[blocking]` finding *before* opening the PR;
`[suggestion]` items are judgment calls.

**If launching any of the three returns `Agent type '<name>' not found`, that
is a stale session registry (#410), not a skipped gate.** Stop and report it
loudly rather than continuing as if that gate had passed, and use the
`general-purpose`-agent workaround instead of restarting — see the
`/pre-merge` skill's "A gate that fails to launch is not a gate that passed"
section for the exact procedure.

**"Read-only" means they will not FIX anything. It does not mean they never
write to your working tree — and the difference cost a pushed commit on 2026-08-20
(N91, #432).** A criterion like *mutation-check the suite and confirm it goes
red* can only be answered by mutating the code and running it, so a reviewer
edits a file and restores it. That is correct behaviour. What it makes unsafe is
**`git add -A` while a reviewer is running**: `ac-verifier` had removed the
`try`/`catch` under test and had not yet restored it when a `commit --amend`
swept the tree, so the branch was force-pushed carrying **the mutation instead
of the fix** — the crash the PR existed to prevent, shipped by the machinery
built to prevent it. Nothing failed loudly: the amend succeeded, the rebase
carried it forward, and the push was clean.

Two rules follow, and the second is the general one:

- **Do not stage or commit while a review subagent is working in your worktree.**
  Launch them, wait for every one to report, *then* touch git. If you must
  commit first, commit before you launch.
- **A restore is confirmed by re-running the thing that fails — never by
  grepping the file.** A `grep -c "try {"` returned the right answer here, at a
  moment when the file really was fine, and the file changed afterwards. That is
  the apparatus trap from *Verify that a check can fail* pointed at your own
  undo: the check was real, it was just answering about the past.

What did work, and is the reason this is a story rather than a defect on `main`:
the branch's own regression test went red on it in `verify`, in CI, and in both
reviews independently.

**Hand the acceptance criteria to the reviewers too, not just to
`ac-verifier`.** They already ask for design intent, and the criteria are that
intent already written down — it is the cheapest handover available.

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

## Scratchpad files are shared, not per-session (hard rule)

**The scratchpad handed to a session or agent reads as private and is not.**
It is shared with whatever else is concurrently running under the same parent
session or the same fleet worker. Two agents writing to the same bare path —
`scratchpad/body.md`, `scratchpad/pr.md` — silently clobber each other, and
the failure is invisible in both directions: the writer overwrites with no
warning, and the reader gets a file that looks exactly like its own draft and
is somebody else's work. **This already happened**: two concurrent agents each
staged a PR body at the same path, the second write clobbered the first, and
the first agent then `PATCH`ed its own PR with what was now the other ticket's
body — for about a minute one PR carried another's description. A PR body is
the one artefact nobody re-reads after posting, so the swap survived until a
human noticed the mismatch by hand.

**Do not fix this by being careful with filenames.** The incident above
happened to a session that was being careful — a generic name (`body.md`,
`pr.md`, `history.md`, `scenarios.md`) is the natural thing to reach for under
task pressure, and "remember to pick a unique one" is a rule every session
re-derives and re-forgets independently.

Instead, run **`python3 scripts/scratchpad_path.py <purpose> --root
$SCRATCHPAD_ROOT`** (substituting the actual scratchpad root you were given)
before staging anything you would be upset to lose to a collision — a PR body
draft, a `history.md`/`functional-scenarios.md` insert staged before editing
the real file, anything more than a few seconds' work to redo. It prints a
path namespaced by the current git branch, creating that subdirectory if
needed, and does not touch the file itself. Because this repo's own worktree
convention already gives every concurrent unit of work its own branch (see
"Git / PR workflow" above), this reuses a uniqueness guarantee the repo
already enforces for an unrelated reason, rather than asking anyone to invent
and remember a second one. Run `python3 scripts/scratchpad_path.py --self-test`
to see the collision this prevents demonstrated directly — two branches, the
same filename, no clobber.

This does not, and cannot, change where the harness itself decides to put a
session's scratchpad — that assignment happens outside this repo entirely.
What it fixes is the one piece this repo controls: the filename a session
picks once it is there.

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

**Backend Postgres tests run with `-p 1` and take a per-database advisory
lock** — the full mechanism (why both, the three ways `-p 1` alone still lets
concurrent worktrees trample each other, the fixture-ownership convention,
and the `vola_test` migration-conflict recipes) moved to the `vola-testing`
skill, since it only matters when you are actually writing or debugging a
backend test — load it then rather than paying for it on every agent spawn.

Env vars come from real files, never baked into images: `backend/.env` / `backend/.env.example`, `apps/web/.env.local` / `apps/web/.env.example`, `apps/mobile/.env.local` / `apps/mobile/.env.example`, `apps/admin/.env.local` / `apps/admin/.env.example` — all gitignored except the `.example` templates. `backend/.env.staging.local` holds real Railway `staging` Postgres credentials (gitignored, never commit).

The backend's CORS (`withCORS` in `cmd/api/main.go`) allows multiple comma-separated origins via `WEB_ORIGIN` (not just one) — needed once the Expo web preview (`:8081`) joined `apps/web` (`:3000`) as a second browser-based local client. Only matters for browser clients; native iOS/Android requests aren't subject to CORS at all.

## Verify that a check can fail (hard rule)

**Check that your apparatus can fail — that a mutation applied, that a filter
matched, that a run happened — before believing what it proves.**

This is one line because it has to be followable at the moment of temptation.
Everything below is why it earns a section rather than a bullet: on 2026-08-19
eleven separate instances of it were found in one afternoon, by six sessions, in
six different parts of the stack. None was a mistake in reasoning. Every one was
a piece of apparatus returning a confident result while measuring nothing.

- A `perl` mutation whose escaping never matched, so the "pass" measured nothing.
- A mutation that produced a **compile** error rather than a test failure —
  also a non-zero exit, also proving nothing about the test.
- A `-run` filter that silently matched no tests, because `Identification` does
  not contain `Identify`. Three tests believed run had not run.
- A downed Colima making every test fail in milliseconds, which is
  indistinguishable from a mutation being caught. **A red suite is only evidence
  once the baseline is green in the same session.**
- A `set -- $pair` in zsh, which does not word-split, so an ancestry check
  compared a two-SHA string against an empty one and "failed" every time.
- A test emptied by a legitimate change to the code it covers: tightening a
  filter left only two of five candidates, so the cap under test could never
  fire. Still green, no mistake anywhere.
- Nine guards mutation-tested, and the tenth **did not exist** — every test
  vector written was valid, and a guard is only exercised by the input it is
  meant to reject. Testing the guards you wrote says nothing about the one you
  did not.
- Two check-digit guards validating arithmetic the code had just performed
  itself, so they were true by construction.
- CI silently skipping pushes, so an absent run read exactly like a passing one.
  **Diagnosed 2026-08-20 (N65) — the cause is a merge conflict with the base,
  and the detector is `pnpm run ci:checks`. See "CI can run ZERO checks" in
  the Git/PR workflow section; this bullet is the symptom, that is the
  mechanism.**
- A build failing with `PluginError` and **exiting 0** while printing it.

**A stub built from an assumption cannot falsify it.** The sharpest instance:
every test of an external provider stubbed it with `httptest` returning 200,
because that is what the author believed the provider did. The suite was green,
thorough and mutation-tested, and confirming the wrong thing — and review could
not break the tie either, because the code and its tests agreed perfectly with
each other. Only a live call could. **Verify an external contract against the
real service at least once**, and record the measurement next to the code that
depends on it.

Three corollaries worth stating separately, because each was arrived at the hard
way:

- **Absence is not evidence.** No checks is not passing; no output is not
  silence; a grep that finds nothing has found nothing, not proven nothing is
  there. (`gh run list --branch` will hand you a green run for a stale commit —
  compare `headSha` against the PR's `headRefOid`.) **The sharpest instance is
  CI itself: count the check runs, never the failures — `pnpm run ci:checks`.**
- **A guard whose outcome is redundant still needs a test**, on its *message*
  if not its effect — otherwise a surviving mutation reads as dead code, and
  "the tests still pass without it" is a very persuasive argument for deleting
  something load-bearing.
- **A watcher pinned to a SHA must check the SHA still exists**, and this is the
  MIRROR of everything above: not a check that could not fail, but **a check
  that could not succeed, because its subject had ceased to exist.** Measured
  2026-08-20 on #400: a background poller was armed on `e3d148d` to wait for its
  check runs; the branch was then rebased and force-pushed, leaving that commit
  on no branch at all. The poller kept asking about it for fifteen minutes,
  found zero checks — correctly, there were none and never would be — and
  **exited 1 with "N65 reproduced"**.

  **A false red is worse than a false green here, for two reasons.** It is
  *self-corroborating*: it names a real bug that was really happening an hour
  earlier, so it reads as confirmation rather than as an error. And the timing
  is the trap — had it landed *before* the rebase finished it would have read as
  fresh evidence of a problem already fixed, sending you back to re-diagnose
  something solved. The same discipline as `gh run list --branch` above
  (`git branch --contains <sha>` returning nothing means your subject is gone),
  applied to anything that watches, polls or retries against an identifier that
  a rebase, a force-push or a cleanup can invalidate underneath it.

### And verify that it can PASS (hard rule)

**The same instrument, pointed the other way: before shipping a gate, check that
its exit gesture is one somebody actually performs.** A gate that never opens
gets ripped out within a week — and it takes the problem it solved out with it,
because the removal looks like unblocking rather than regression.

This is not symmetry for its own sake. It was measured on N456 (#456), whose
first design released a latch when somebody ticked the ticket's evidence
checkbox. That is the obvious gesture, it reads as free, and it would have
deadlocked every device ticket in the repo — because:

**0 of 415 acceptance-criteria checkboxes in this repository's entire issue
history have ever been ticked.** Not the evidence ones. *Any* of them.

Nothing about the code would have been wrong. The self-test would have passed,
the mutation testing would have been clean, and the mechanism would have been
unsatisfiable in production by a convention nobody had written down, because
nobody had noticed it. The exit became an attestation comment instead, which is
a gesture people already make.

So when a check, gate or latch has a *release* condition, ask the same question
you ask of its trigger: has this ever happened here? `git log`, the issue
corpus and the PR history all answer it, and the answer is occasionally zero.

## Known gotchas

**Everything about apps/mobile native builds — declared-but-not-installed
native deps, `app.json` permission traps, Release-build verification,
Simulator/device quirks, legacy Expo Go failure modes — moved to the
`vola-mobile-build` skill.** Load it before touching a native build issue in
`apps/mobile`; it was the majority of this section's bulk and none of it
matters to a backend/web/admin task, so it no longer costs every agent on
every spawn. The entries below are the ones general enough to stay here.

- **`secrets.txt`** may show up untracked in the repo root containing what looks like a live API key. Never stage or commit it — flag it to the user instead.
- This Next.js version renamed the `middleware.ts` file convention to `proxy.ts` (same `clerkMiddleware()` export, just a renamed file). Separately: `next dev --hostname 127.0.0.1` breaks when a `proxy.ts`/`clerkMiddleware()` is present — Next's Proxy runtime tries to self-fetch via `localhost` internally and fails (`ECONNRESET`, surfaces as a 500). Use `--port` alone when running concurrent dev instances; never pass `--hostname`.
- pnpm blocks native build scripts (`sharp`, `unrs-resolver`, etc.) by default — they need explicit `allowBuilds: true` entries in `pnpm-workspace.yaml` or installs fail.
- Railway: the real project is **still named `formspan`** — the VOLA rename covered the repo and code, not the external service accounts (Railway, Clerk). Don't "correct" it in docs until it's actually renamed in the Railway dashboard. It has a `staging` environment holding a real Postgres (migrations already applied there). No `production` Postgres yet. The `api` service is deployed to `staging` and live; `web`/`admin` are in progress. Note that Nixpacks-built services (`web`, `admin`) need `NIXPACKS_INSTALL_CMD` set to bypass corepack — see `railway/web.toml`. An **unrelated pre-existing project, `dynamic-trust`** (service `medical-portal-api`), sits in the same Railway account — it is not ours; never touch it.
- **This host's Colima config shares only `$HOME` into its Docker VM, and a bind mount outside that comes back SILENTLY EMPTY rather than erroring** (N188/#604, `engine/internal/worker/sandbox.go`). Measured directly: `docker run -v /var/folders/.../some-temp-dir:/workspace alpine ls /workspace` — a real host directory with a real file in it — shows an empty `/workspace` inside the container, no warning anywhere. `/var/folders/...` is macOS's system temp directory, which is exactly what `mktemp -d` and Go's `t.TempDir()`/`os.MkdirTemp("", ...)` resolve to when given an empty base — so any code that bind-mounts a path built that way (rather than one under `$HOME`) silently sandboxes against nothing. The symptom downstream is a confusing "no such file" from whatever command runs inside the container, which reads as a bug in that command and is nothing of the sort. `engine`'s sandbox now guards this itself (`verifyMount` checks for a known-present file, e.g. `.git`, before running anything else, and fails with a clear message naming the cause) — but this is a property of THIS HOST's Colima config (`mounts: []` in `~/.colima/default/colima.yaml`, with the comment "Colima default behaviour: $HOME is mounted as writable"), not of Docker generally: Docker Desktop and native Linux Docker typically share any host path. If Docker ever moves off Colima here, or Colima's config changes, re-measure before assuming this constraint still holds.

## Where to look for more

- [docs/decisions/history.md](docs/decisions/history.md) — full chronological narrative
- [docs/architecture/apps.md](docs/architecture/apps.md) — per-app architecture detail (Clerk auth flows, ownership models, the `llm` platform package) that the repo map above only summarizes
- [docs/architecture/deployment.md](docs/architecture/deployment.md) — environments, Railway topology, migrations
- [docs/architecture/api-conventions.md](docs/architecture/api-conventions.md) — full REST/OpenAPI conventions
- [contracts/public.openapi.yaml](contracts/public.openapi.yaml) — the wire contract
- [docs/testing/functional-scenarios.md](docs/testing/functional-scenarios.md) — recommended functional test scenarios per feature
- [docs/testing/device-checks.md](docs/testing/device-checks.md) — the ranked script for what **no test can reach**: camera, microphone, keyboard, speaker, permission prompts, safe areas, a gym with no signal. Measured, not guessed — 44 of 93 mobile screens/components execute zero statements under the suite, and 0 of 40 web/admin pages have a test that renders them.
- **The open list — GitHub Issues on the [`VOLA` board](https://github.com/users/dmytro-ch21/projects/2)**: every known gap, fix and queued feature
- [docs/TASKS.md](docs/TASKS.md) — the archive of that list up to 2026-08-20, and the live home of the `T` traps
