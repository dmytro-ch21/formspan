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
| Criteria | None. Nothing is completable | Most items carry criteria |
| Length | ~40–85 items | ~25–35 items |
| Order | Match order: the sequence a round happens in | Map first, then triage: the map, then what hurts most |
| Track | `syllabus` | `belt` |

**Broad, not exhaustive, and that was a decision.** `typical_belt` covers 100%
of the technique catalog, so a genuinely complete per-belt list is derivable —
and it would be the Library's own belt filter reorganised, which the Library
already offers with search and position chips on top. White belt would be 158
items. What a syllabus adds over a filter is sections in the order a round
happens, an objective for each, and a subset short enough to read; that is
curation, so the lists are curated. The cost is real and worth stating: an
exhaustive list can answer "is X a blue belt technique?" negatively, and a
curated one cannot.

**They share section names.** The reference is the atlas; the roadmap is a route
through it. An athlete moving between the two must never meet a section name they
have not already seen — that is the whole reason the taxonomy below is fixed
rather than authored per belt.

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

A belt may skip a domain — white has no leg section beyond knowing when to tap,
and that absence is a statement. It may not invent a thirteenth.

## Ordering rules

**The reference syllabus runs in match order** — 2, 3, 4, 5, 6, 7, 8, 9, 10, 11.
Standing, then the ground, then the pins, then the finishes, then what to do when
it goes wrong. That is the order a round happens in and the order a mental model
assembles in.

**The roadmap runs map first, then triage.** Orientation, then the map, then the
domains in the order they cost an athlete rounds — which at white belt means the
escapes before the attacks, and standing last, because the athlete already got
to the ground somehow. Triage order is deliberately *not* match order: it is what
an athlete already training three times a week should fix next, and it is the
reason the roadmap is short.

**The map section exists once, at white belt.** A round's shape is learned once.
Later belts open with orientation and go straight to work.

## Why the map section carries no techniques

It is four concepts and no milestones, so it contributes nothing to progress and
cannot be "finished". That is correct: it is the thing you read before the list
makes sense, not a thing you train. A criterion here would be a progress bar on
having understood something, which no evidence stream can measure — the same rule
that keeps every other concept item uncompletable.

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
