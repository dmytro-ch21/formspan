# The phone-impossible audit

**Taken 2026-08-20, for N72 (#372).** A route-by-route sweep of every athlete-
facing capability in `apps/web` and `apps/mobile`, answering one question each:

> **Can an athlete who only has a phone do this at all?**

Not "is web better at it". Web being better is fine and expected — that is what
the mobile-first rule in `CLAUDE.md` calls the complementary surface. **Web
being the only way is now a defect.**

This is a snapshot of a moving tree. Re-derive it rather than trusting it once
anything below is built; the method is the durable part.

## Method

1. Enumerate every route under `apps/web/src/app/**` and `apps/mobile/app/**`.
2. For each, record what it *does* — and specifically whether it **writes**. A
   mobile screen that only displays something is not parity for a web screen
   that edits it.
3. Cross-reference, and read the design docs as well as the code: a doc that
   assigns a capability to web *exclusively* is superseded on the exclusivity.
4. Verdict per capability: parity / reduced-on-mobile / **phone-impossible** /
   not-built-anywhere.

Counts at the time of the sweep: **26 web routes, 46 mobile routes.**

## Verdicts

### Phone-impossible — web is the only way

| # | Capability | Web | Evidence it is absent on mobile | Status |
|---|---|---|---|---|
| 1 | Type your own calorie/macro target | `nutrition/targets` | `(tabs)/goals.tsx` had **zero `TextInput`** | **fixed by N72** |
| 2 | See and accept the weekly adjustment (N27) | `targets/AdjustmentCard.tsx` | `lib/nutritionApi.ts` had no `fetchAdjustment` | **fixed by N72** |
| 3 | Target history; a backdated effective date; delete a target | targets page | mobile `saveTarget` only, always for today | **fixed by N86 ([#530](https://github.com/dmytro-ch21/formspan/pull/530))** — and the row was wrong about deletion: `apps/web` has carried `deleteTarget` in its wire layer since the endpoint landed and calls it from **nowhere**, so deletion was available on neither surface. The phone is the first to offer it. |
| 4 | Author a multi-ingredient recipe | `nutrition/recipes/new`, `/[id]` | mobile `FoodInput` has no `items[]`; single foods only | **closed by N87 ([#529](https://github.com/dmytro-ch21/formspan/pull/529))** |
| 5 | Manage saved foods — list, edit, delete | `nutrition/recipes` | mobile `deleteFood` is documented as having *"No production caller yet"* | **closed by N79 ([#679](https://github.com/dmytro-ch21/formspan/pull/679))** — `app/food/saved/index.tsx`, a browsable list (search included) with each row routing to whichever existing editor its `kind` needs (`food/saved/[id]`, `food/recipe/[id]`, N87's split) and a `HoldToConfirm` delete. `deleteFood` finally has a caller: `lib/foodLog.ts`'s `removeFood` tombstones locally and `push()` sends it — which needed its own fix, since the foods push query filtered `deleted_at IS NULL` the same as every ordinary read of that table, so a tombstone was invisible to the one query meant to send it. |
| 6 | The nutrition analytical surface — intake vs bodyweight vs training load, 7-day mean, adherence % | `/dashboard/nutrition` | none | **closed by N84 ([#674](https://github.com/dmytro-ch21/formspan/pull/674))** — `app/goals/nutritionTrend.tsx`, a reduced ONE-metric form (7-day mean kcal against today's live target); the three-way join stays web-only, which the carve-out requires rather than merely permits. |
| 7 | Author a weekly training theme | `/dashboard/calendar` (`setTheme`) | `lib/themes.ts`: *"read-only on the phone… no write path here on purpose"* | **closed by N82 ([#677](https://github.com/dmytro-ch21/formspan/pull/677))** |
| 8 | Create / edit / delete your own curriculum or roadmap | `curricula/new`, `[id]/edit` | mobile `lib/curriculum.ts` exports only `getCurriculum`, `enroll`, `archive` | **closed by N83 ([#676](https://github.com/dmytro-ch21/formspan/pull/676))** |
| 9 | View, edit, copy or delete a sequence | `sequences/*` | mobile can only *capture* one inside `bjj/reflect/[id]` — **no list or detail screen exists** | **read-back by N80 ([#449](https://github.com/dmytro-ch21/formspan/pull/449)); edit/copy/delete still open** |
| 10 | The technique funnel as a browsable surface | `/dashboard/proficiency` | mobile `fetchProficiency` feeds the Today card only | **closed by N84 ([#674](https://github.com/dmytro-ch21/formspan/pull/674))** — `app/bjj/proficiency.tsx`, a straight port of web's `bucketOf` bucketing reshaped into a scrollable list rather than a wide table. Not a chart, so the mobile-chart carve-out was never in play for this row. |
| 11 | Per-exercise load over time | `records` + `LoadHistoryChart` | mobile has no `fetchLoadHistory` | **closed by N84 ([#674](https://github.com/dmytro-ch21/formspan/pull/674))** — `app/records/[exerciseId]/trend.tsx`, one fixed metric ("Top set"), the same range-chip shape `app/goals/trend.tsx` uses. First real consumer of N56's shared trend layer beyond weight. |
| 12 | Session search by name, period/sport filters, a paged list | `/dashboard/sessions` | mobile's month sheet has neither | **closed by N85 ([#671](https://github.com/dmytro-ch21/formspan/pull/671))** — `apps/mobile/app/session/history.tsx` hits the same `GET /v1/sessions` filter web does (name search, sport chips, `SPANS`/`spanRange` period presets, a "Show older" page button); reduced UI, not a reduced query. |

**#9 was the sharpest**, and it was worse than a missing screen:
`shared/index.tsx` told an athlete who accepts a shared sequence *"your copy is
in the Library"* — a destination that does not exist on the phone. The app
captured data it could never show back, and said otherwise.

**N80 ([#449](https://github.com/dmytro-ch21/formspan/pull/449)) closed the reading half.** `app/sequence/index.tsx` and
`app/sequence/[id].tsx` list and render chains on the phone, accepting a shared
sequence now navigates to the copy instead of describing where it went, and the
You tab carries an entry point so a chain is findable a week later rather than
only in the moment of accepting. **The row stays partly open on purpose**:
editing, reordering, copying a reference chain and deleting are still web-only,
which is *reduced-on-mobile* rather than phone-impossible — the athlete can now
read every chain they own on the device that captured it. Whoever closes the
rest should file it as its own id rather than reopening this one.

**#11 was legitimately web-only until yesterday.** N6 assigned it there; N57's
amendment to the mobile-chart carve-out (2026-08-19) re-opened the door. It is
now permitted on mobile and simply unbuilt, which is a different thing from
forbidden.

### Parity — checked, and genuinely fine

Recorded rather than omitted, because **the absence of a row is indistinguishable
from not having looked.** "We checked and it is fine" is the finding a reader of
this table needs most.

| Capability | Web | Mobile | Verdict |
|---|---|---|---|
| Template / plan authoring | `/dashboard/workouts`, `workouts/[id]` | `(tabs)/workouts.tsx`, `workout/[id].tsx` | **parity** |

Confirmed by comparing the write surfaces on both sides rather than by inferring
it from the presence of a screen: `lib/workouts.ts` on mobile exports
`createWorkout`, `replaceItems`, `renameWorkout` and `deleteWorkout`, and
`workout/[id].tsx` uses all of them — `+ Add exercise`, `Remove`, a `move(index,
±1)` reorder and per-item target editing. Web's `workouts/[id]/page.tsx` calls
the same four functions.

Web is **better** at it — a two-pane builder with the catalog always visible, and
a keyboard — and that is exactly the case the mobile-first rule permits. A
phone-only athlete can build, reorder, rename and delete a plan.

### Reduced on mobile — allowed, but one is worth watching

| Capability | Note |
|---|---|
| ~~Correct a past day's food~~ | **Closed by N81 ([#678](https://github.com/dmytro-ch21/formspan/pull/678))**. Was: web has a six-week list **and a date jump**; mobile has a **±1-day stepper only**. "Fix a day three months ago" is ~90 taps. This was nominally reduced and practically impossible. Now: the day switcher's label opens a month-grid jump (same shape as `WeekPlanner`'s own month sheet on Plan), so a day months back is a couple of taps — the ±1-day arrows are unchanged and stay the "check yesterday" gesture. |
| ~~Browse session history~~ | **Closed by N85 ([#671](https://github.com/dmytro-ch21/formspan/pull/671))**, and moved to row 12 above. Was: mobile read local SQLite only, and the server pull was `limit: 20` (`sessionStore.ts`), so on a fresh install older sessions were unreachable on the phone at all. Now: `/session/history` queries the server directly, and the sync's fresh-install case pages through the same server in bounded requests so the local cache itself stops being permanently stuck at 20 too. |
| Set the BJJ focus list | Mobile accepts a proposal; it cannot hand-pick from the funnel. |
| Round map, training totals, records for a given exercise | Genuine reduced forms, working as intended. |

### Not built anywhere

- **The competitive record** (`/v1/contests` — tournaments, divisions,
  placements, matches). Backend and scenarios exist; **zero clients**, on any
  surface.
- **A check-in analytical surface** (history table, comparison, export).
- **Nutrition export.**

### Only admin can do it

Not parity gaps — content governance — but they are the only route by which
catalog data gets fixed, and an athlete hits all three in the gym:

- Add or correct a **technique** an athlete has learned but the 542-item library
  does not have.
- Add or correct an **exercise** — a machine at their gym that is not
  catalogued. `session/[id]/identify` can *identify* a machine and cannot add a
  missing one.
- Attach **media or a note** to an exercise. No upload path anywhere.

### Docs that assign a capability to web exclusively

Each is superseded on the exclusivity, not on the design.

| Doc | Assignment |
|---|---|
| `nutrition-design.md` §4 | "Build a recipe from scratch — ✗ mobile / ✅ web" — **corrected on the exclusivity by N87 ([#529](https://github.com/dmytro-ch21/formspan/pull/529))**: both surfaces build one now, and the phone's is the one with catalog search behind it |
| `nutrition-design.md` §4 | "Set / explain the target — **read-only** mobile" — N72 closed the read-only half for TODAY's target; **N86 ([#530](https://github.com/dmytro-ch21/formspan/pull/530)) closed the rest**: history, correcting or removing a past target, and filing one for a day already gone. The row is corrected in that doc. |
| `nutrition-design.md` §4 | "Intake vs weight vs training load — ✗ / ✅" |
| `nutrition-design.md` §5 | "one web screen with three sections" — `CLAUDE.md` already rules this "one screen on each"; N69 delivered the feasibility section on both, the other two are still web-only |
| `functional-scenarios.md` | "Building and refining [sequences] stay on web"; "No browse or detail screen on mobile" — **corrected on the exclusivity by N80 ([#449](https://github.com/dmytro-ch21/formspan/pull/449))**: reading is now on both, building is still web-only, and that is allowed |
| `functional-scenarios.md` | Themes "Authored on web, read on the phone… **no way to author one on the phone**, deliberately" — **corrected on the exclusivity by N82 ([#677](https://github.com/dmytro-ch21/formspan/pull/677))**: `WeekPlanner` (Plan tab) now authors a theme for the shown week, title only, matching web's own field; web keeps the richer whole-month view |
| `functional-scenarios.md` | "Session list paging, search and filters (`GET /v1/sessions`, `apps/web` History)" — **corrected on the exclusivity by N85 ([#671](https://github.com/dmytro-ch21/formspan/pull/671))**: mobile now has a reduced but real search/browse screen (`apps/mobile/app/session/history.tsx`) hitting the same backend filter; the backend scenarios were already platform-agnostic and are unchanged |
| `curriculum-and-gameplan-design.md` | "roadmap *building* and the full funnel on web" — **corrected on the exclusivity by N83 ([#676](https://github.com/dmytro-ch21/formspan/pull/676))**: web's two-pane builder stays the richer way to build one, the phone now has a reduced (single reorderable list, up/down rather than drag-and-drop) but complete authoring flow |
| `system-design.md` | *"nothing a user needs weekly may be desktop-only"* — this one is not an assignment but a rule, and #1–#6 violate it. Nutrition is daily. |

### The inverse — mobile-only capabilities

Recorded for completeness; these are **not defects** under the rule, which is
one-directional. Web cannot: log a body check-in, start or end a phase, edit the
profile, log/dictate/reflect on a BJJ session, estimate food by description or
photo, scan a barcode, identify a machine, read the friends' feed, see the
position heatmap, run a rest timer, repair blocked sync rows, or set suggestion
preferences. The rest timer is explicitly blessed as mobile-only. Several of the
others — profile editing, check-ins, phases — are simply web gaps somebody may
want to close on their own merits.

## Where each finding is tracked

**All of it is filed.** The rows above are evidence; these issues are the work.
A row in this table is exactly as invisible to the board as a `TASKS.md`-only id
was, which is the whole reason the open list moved to GitHub Issues — so if you
add a finding here, file it too, and put the id in this table.

| Issue | Covers | Audit row |
|---|---|---|
| [#411](https://github.com/dmytro-ch21/formspan/issues/411) | Target history, backdating and deletion | 3 |
| [#412](https://github.com/dmytro-ch21/formspan/issues/412) | Recipe authoring | 4 |
| [#413](https://github.com/dmytro-ch21/formspan/issues/413) | Saved-food management | 5 |
| [#414](https://github.com/dmytro-ch21/formspan/issues/414) | Shared-sequence read-back | 9 |
| [#415](https://github.com/dmytro-ch21/formspan/issues/415) | Past-day food jump | *reduced-to-impossible* — **closed by N81 ([#678](https://github.com/dmytro-ch21/formspan/pull/678))** |
| [#416](https://github.com/dmytro-ch21/formspan/issues/416) | Theme authoring | 7 — **closed by N82 ([#677](https://github.com/dmytro-ch21/formspan/pull/677))** |
| [#417](https://github.com/dmytro-ch21/formspan/issues/417) | Curriculum authoring | 8 — **closed by N83 ([#676](https://github.com/dmytro-ch21/formspan/pull/676))** |
| [#418](https://github.com/dmytro-ch21/formspan/issues/418) | The three analytical surfaces | 6, 10, 11 |
| [#419](https://github.com/dmytro-ch21/formspan/issues/419) | Session search and the 20-row cap | 12 |

Rows 1 and 2 were closed by N72 (#372) itself.

Two things about that ordering worth keeping, because they are judgements rather
than bookkeeping:

- **#414 was filed above the analytical gaps**, out of severity order, because
  it was the only finding where the app **said something untrue** rather than
  merely omitting a surface: `shared/index.tsx` told an athlete who accepts a
  shared sequence that "your copy is in the Library", and no sequence screen
  existed on the phone at all. An omission is a gap; a false statement is a
  defect. That ordering was right for a second reason that only showed up in the
  fixing: the false sentence was the *cheap* half, and a ticket that can be
  half-closed truthfully in an afternoon is worth putting first. Closed by N80
  ([#449](https://github.com/dmytro-ch21/formspan/pull/449)) — see the note under the table for what it deliberately left.
- **Rows 6, 10 and 11 are one issue**, not three. They share a shape — a
  read-only analytical surface that exists on web and nowhere else — and a
  solution, so splitting them would be three tickets that each half-build the
  same thing. Note row 11 (per-exercise load over time) was legitimately
  web-only until N57's amendment on 2026-08-19 re-opened the mobile-chart
  carve-out; it is now permitted and simply unbuilt, which is a different state
  from forbidden.
