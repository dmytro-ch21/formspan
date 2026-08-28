# The BJJ curriculum structure

How the belt content is organised, and the rules that keep it organised when
somebody adds to it. This is the spec; `backend/internal/modules/curriculum/curricula.json`
is the instance.

## Two artifacts, one vocabulary

There are two different things an athlete can open, and conflating them is what
made the first version read as a wall of items.

| | **Reference syllabus** | **Roadmap** |
|---|---|---|
| Answers | "What should a blue belt know?" | "What should I work on now?" |
| Coverage | Broad — the belt's whole shape, section by section | Curated — the subset worth chasing |
| Criteria | None. Nothing is completable | Every technique item carries criteria |
| Length | ~40–85 items | 40–93 items |
| Order | Match order: the sequence a round happens in | **Match order too, as of N97** |
| Track | `syllabus` | `belt` |

**Broad, not exhaustive, and that was a decision.** `typical_belt` covers 100%
of the technique catalog, so a genuinely complete per-belt list is derivable —
and it would be the Library's own belt filter reorganised, which the Library
already offers with search and position chips on top. White belt would be 158
items. What a syllabus adds over a filter is sections in the order a round
happens, an objective for each, and a subset short enough to read; that is
curation, so the lists are curated. The cost is real and worth stating: an
exhaustive list can answer "is X a blue belt technique?" negatively, and a
curated one cannot. (Read that as *recommended for* a belt, not gated to
it — `typical_belt` is a starting-point suggestion, never a restriction; see
`Summary.TypicalBelt`'s doc comment in `backend/internal/modules/technique/technique.go`
for the full ruling, F19.)

**They share section names, and since N97 they share the section ORDER too.**
The reference is the atlas; the roadmap is a route through it. An athlete moving
between the two must never meet a section name they have not already seen — that
is the whole reason the taxonomy below is fixed rather than authored per belt.

The roadmap used to run a different order from the syllabus (see *Ordering
rules* below for what changed and why). It now runs the same one, taken from
`docs/design/bjj-belt-curriculum.md`, which the user supplied and ruled
authoritative. Same spine, two depths: the syllabus is *what exists*, the
roadmap is *the worked subset you are measured on*.

**That convergence has a cost, and it is filed rather than solved.** One
ordering now lives in two places with nothing forcing them to agree, which is
how two copies drift. `TestEveryBeltRoadmapMatchesTheSuppliedDocument` pins the
roadmap to the document; nothing yet pins the syllabus to either. **N100
(issue #480)** carries the cheap fix — a content test asserting the two tracks
carry identical phase titles in identical order — and the question of whether
one should be derived from the other.

## The canonical sections

Every phase in every belt — in both artifacts — covers one of these twelve
domains. The same spine at four depths, so the athlete watches it deepen rather
than meeting a new organising idea per belt.

This is a **coverage checklist, not a naming scheme.** Phase titles stay specific
("Half guard is a position, not a failure" beats "Guard: attacking"); what the
table fixes is which domains exist and which belt owns what depth of each.

| # | Domain | White | Blue | Purple | Brown |
|---|---|---|---|---|---|
| 0 | **Orientation** — how this belt works | The split, and what it leaves out | A game gets chosen | An architecture, written down | Refinement, not accumulation |
| 1 | **The map** — how a round goes | The route and the loop | — | — | — |
| | *(0 and 1 are no longer roadmap PHASES — see below)* | | | | |
| 2 | **Standing** | Stance, grips, two takedowns, a sprawl | Chains, not singles | A standing game with an intent | A takedown system, specialised |
| 3 | **Guard: keeping it** | Four points of contact, recover | The retention ladder | Retention against intent | Elite retention, every family |
| 4 | **Guard: attacking** | Closed and half guard, two sweeps | Two guards that answer each other | One guard, all the way down | One primary guard, no leaks |
| 5 | **Passing** | Headquarters, one pass | One pressure, one movement | The reaction map | A passing philosophy |
| 6 | **Pins** | Side control and mount, held | Pins that go somewhere | Dilemmas between them | Pinning that forces reactions |
| 7 | **The back** | Take it, hold it, finish it | (inside submission chains) | The back takes underneath | The back system |
| 8 | **Turtle and the front headlock** | A door, not a home | The front headlock arrives | The front headlock system | Scrambles, owned |
| 9 | **Submissions** | The handful that work | Chains | Systems | Families, finished |
| 10 | **Legs** | (defence only — know when to tap) | Responsibly: position, then the ankle | Entanglements as positions | The full family, where the rules allow |
| 11 | **Escapes and defence** | Escape the bad places | Escape chains | (folded into retention) | Defensive layers |
| 12 | **The standard** | What the record should show | " | " | " |
| | *(12 is no longer a roadmap PHASE — see below)* | | | | |

A belt may skip a domain — white has no leg section beyond knowing when to tap,
and that absence is a statement. It may not invent a thirteenth.

**Domains 0, 1 and 12 are still domains; they are no longer roadmap phases.**
The supplied document has no counterpart for *How this belt works*, *The map* or
*The graduation standard*, and a phase the document does not carry would break
the match. Their content was not discarded — it moved into the curriculum
`description`, which both clients already render above the milestone list:

- **0, Orientation** → the document's per-belt **Goal**, which says the same
  thing in the document's own words.
- **1, The map** → the document's per-belt **fundamental flow** block
  (`standing → takedown or guard pull → guard → sweep or pass → …`). This is the
  same map #272 added the phase for, and the reason that phase existed is worth
  keeping in mind: white belt roadmaps used to open straight into *Mount: get
  out, then hold*, which is correct triage and meaningless to somebody who does
  not yet know a round has a shape. A novice must still meet the map before the
  list. It is now the last paragraph of the description rather than the first
  phase.
- **12, The standard** → the *simple progression* table's line for the belt,
  also in the description.

`TestEveryBeltRoadmapExplainsItselfInItsDescription` is what stops that
description quietly becoming a caption again, because a roadmap with a thin
description renders as a list with no framing and merely looks plain.

## Ordering rules

**The reference syllabus runs in match order** — 2, 3, 4, 5, 6, 7, 8, 9, 10, 11.
Standing, then the ground, then the pins, then the finishes, then what to do when
it goes wrong. That is the order a round happens in and the order a mental model
assembles in.

**The roadmap runs match order too, since N97.** It used to run *map first, then
triage* — orientation, then the map, then the domains in the order they cost an
athlete rounds, which at white belt meant the escapes before the attacks and
standing last, on the reasoning that the athlete already got to the ground
somehow.

That was a defensible pedagogy and it is not the one that shipped. The user
supplied an ordering that follows a match from its beginning and ruled it
authoritative, so both artifacts now run it. The argument for the change is not
only deference: triage order and match order disagreeing meant the two artifacts
for one belt disagreed about the sequence of the same material, which an athlete
would notice and could not explain.

**What was lost with triage order, stated plainly**, because it was a real
property: the roadmap no longer front-loads what hurts most. A white belt being
mounted every round now meets *Escape Bad Positions* as milestone 10 rather than
milestone 3. The mitigation is that milestones expand one at a time and nothing
requires working them in order — but the ordering no longer does the triage for
the athlete, and if that turns out to matter, the fix is a "start here"
affordance on the screen rather than a re-ordering of the content.

**The map is no longer a section at all** — see the note under the domain table.
A round's shape is still learned once, at white belt, but it is read in the
curriculum description rather than worked as a phase.

## Why concepts carry no criteria

A concept is authored text and nothing else: it contributes nothing to progress
and cannot be "finished". That is correct — it is the thing you read before the
list makes sense, not a thing you train. A criterion on one would be a progress
bar on having understood something, which no evidence stream can measure, and
migration 000051's `curriculum_items_kind_shape` refuses it at the database
rather than trusting the convention.

This matters more after N97 than before it, because the concept share is now
what distinguishes the belts from each other. White belt is 12 concepts against
81 techniques; brown belt is 48 against 28. Brown is *mostly* prose, and that is
the content faithfully reflecting what the document says brown belt is: "no
longer about learning every technique — about making fundamental BJJ extremely
difficult to stop". Do not fix that ratio by inventing criteria for strategy.

## Adding to this

- A new phase must fall inside one of the twelve domains, and its title must
  **lead with the position or the domain** — "Side control: frames before
  everything", not "Frames before everything". Scanning the titles is how a
  novice reads the map off the list, and a title that opens with an idea instead
  of a place breaks that.
- A phase description states the **objective** and the **expectation by the end**
  — what the athlete should be able to do, not what the phase contains.
- Concepts carry the ideas; techniques carry the criteria. A rule an athlete
  cannot log against is a concept, always.
- Reordering and rewriting is safe: `cmd/seed` replaces items wholesale and
  progress is recomputed from `bjj_session_tags`, so no athlete's record depends
  on an item's position or existence. See `curriculum/seed.go`.
