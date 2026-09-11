# Repository and board identity

Which repository and which project board this codebase acts on, where each of
those names lives, and why every remaining literal copy of them is allowed to
stay. Written for N174 (#551), 2026-09-11.

## The rule

**Anything that ACTS on the repository or its board reads the name; it never
writes it down.** Links, narrative and fixture data may name them — those are
records and pointers, not configuration.

| You need | Get it from |
|---|---|
| The repository, in a `gh` command | Nothing — `gh` infers it from the checkout's git remote. Do not pass `--repo`. |
| `owner`/`repo` inside a `gh api` call | `gh`'s `{owner}` and `{repo}` placeholders. They are filled in endpoint paths **and** in `-F` field values — measured 2026-09-11 against #1109, not assumed. |
| The repository, in a script that may run outside a checkout | `GH_REPO`, then `GITHUB_REPOSITORY`, then `gh repo view` — and **refuse** if none answers. `scripts/evidence-latch.py`'s `resolve_repo` is the reference. |
| The board's owner and number | `.vola-agent/policy.json` → `board`. `engine/cmd/devengine` reads it; `--owner` / `--project` override it. |
| The project, Status field and option ids a Status write needs | The same `board` block. The recipe that reads them is step 12 of the `vola-ticket-sdlc` skill. |

`scripts/check-agent-policy.py` validates the block: the owner is a login, the
number is an integer, the URL is the board those two name, the ids carry the
right node prefixes, all six statuses have distinct ids, and the block records
the date its ids were last read from the live API. Each guard is
mutation-tested by the script's own self-test.

**When the board moves** — the org migration (N145) will move it — re-read the
ids from the API, update the block and its `verified_against_live_api` date,
and nothing else should need editing. If something else does, it belongs in
the table below or it is a bug.

## Every literal that stays, and why

Measured on the N174 branch, 2026-09-11: every tracked line matching the owner
login or `formspan` (any case), each assigned to exactly one row below. The
script that counted refused to write this table if any line fitted no row —
and did refuse once, on the Dockerfile line the first draft's module row
missed. This file names them in order to list them and is not counted.

| Where | Lines | Why it stays |
|---|---|---|
| Go module paths — `go.mod` and every import in `backend/` and `engine/`, plus the `-ldflags -X` path in `backend/Dockerfile` | 304 | A module path is the Go package's own name, not a lookup of the repository. Changing it rewrites every import in both modules, and belongs with the org migration (N145). |
| `.vola-agent/policy.json` — `board` | 2 | The one place identity is configured, by design. |
| `CLAUDE.md` — two board links and the Railway note in Known gotchas | 3 | Links for a person to click, and the live Railway name (see below). |
| `docs/TASKS.md` — the board link | 1 | A link for a person to click. |
| `docs/decisions/history.md`, `docs/decisions/phone-impossible-audit.md`, `docs/testing/device-checks.md` | 20, 29, 5 | Narrative and permalinks. A record is not rewritten, and GitHub redirects a transferred repository. |
| `scripts/evidence-latch.py` self-test, `engine/internal/devengine/github_test.go` | 8, 4 | Fixture data — a login inside recorded payloads and expected comments. |
| `backend/internal/modules/food/barcode.go` | 1 | The default `User-Agent` sent to Open Food Facts, which asks clients for a real contact and rate-limits anonymous traffic. A contact address given to a third party, used only when config supplies none; GitHub's redirect follows a move. Update it at N145. |
| `backend/internal/modules/profile/profile.go` | 2 | Reserved usernames: the product's former name, which nobody may claim. A real constant. |
| `docs/architecture/deployment.md` — Railway project `formspan` | 1 | The live external name. Rename it in Railway first, then here. |
| `apps/web/src/app/clerkAppearance.ts`, `docs/architecture/apps.md` — Clerk application "Formspan dev" | 5, 1 | The live external name; the file documents why its title override exists. |
| `apps/mobile/lib/db.ts` | 1 | A comment about the pre-rename local database file. |

## What this does not do

- **Nothing enforces the table.** A new literal passes every check. If it
  drifts, the next step is a `git grep` check using this table as its
  allowlist — not built here.
- **The engine does not derive the repository from a webhook installation
  payload.** It has no webhook path yet; that belongs to the gateway, #570
  (N146), where it was proposed as a criterion.
- **`devengine`'s `run` calling `Board.Resolve` is not unit-tested** — `run`
  needs a token and the network. The resolution rules and the empty flag
  defaults are.
