# Curricula, suggestions and the gameplan — design draft

**Status:** the draft below is preserved as written, before anything was built.
Tier 0 and Tier 1 have since shipped, and the reconciliation immediately below
records where the built thing diverged from the plan and which of the open
questions the implementation answered. **Read that first** — the body still
speaks in the future tense throughout, and taken alone it now misdescribes the
app.

## What shipped, and where it diverged (2026-08-05)

Landed in #133 (the `defended` event), #134 (Tier 0 and Tier 1) and #135
(dismissal, and a settings screen to control it).

- **The Tier 1 gate is six drilled classes, not the ~9 the analysis argues
  for.** The table below is still right — six is defensible only if an athlete
  would otherwise try a drilled technique live about 40% of the time, and 9 is
  the safer number at 30%. Six was chosen deliberately anyway: the cost of a
  wrong funnel-gap suggestion is one ignored card, the cost of never firing is
  a feature nobody sees, and the copy was softened to claim only what the record
  supports ("never logged live", not "you never try it"). If the suggestion
  proves noisy in real use, this number is the first dial to turn.
- **`MIN_DRILLED` counts separate classes, not tagged events.** The wizard
  writes `drilled` once per session per technique, so the two coincide today —
  but the constant means classes, and a future multi-tag-per-session path must
  not silently turn six classes into six taps.
- **Tier 1 gained a precondition the draft did not anticipate:** `countersInUse`.
  The draft's `attempted + scored === 0` test is unfalsifiable for an athlete who
  has never opened the focus grid, because only that grid writes those counters —
  so "never tried it live" would have been claimed about every technique of
  every athlete who logs the fast path. The gap now requires evidence that the
  counters are in use at all before reading a zero as meaningful.
- **Tier 2 and Tier 3 are not built.** Nothing here about position hot spots or
  the gameplan editor has been implemented; those sections remain a proposal.

### Questions the implementation answered

Numbered against the open-questions list at the foot of this document.

1. **Persist or recompute?** Recomputed, as recommended — and the *dismissal*
   persists, in `bjj_dismissed_suggestions`, device-local.
2. **One suggestion or a list?** One.
3. **Gate met, nothing stands out?** Say so, warmly: *keep logging and keep
   working on yourself — you're doing great.* Decided 2026-08-05. The
   alternatives were both worse in the ways the question anticipated — silence
   reads as the feature being broken, and manufacturing a finding to fill the
   space is the fabricated-zero mistake the Tier 1 `countersInUse` precondition
   exists to prevent. Note what this message is actually claiming: **not** that
   the athlete is training well, which the app cannot see, but that there is
   nothing in the record worth flagging, which it can. The copy has to stay on
   the right side of that line or it becomes the first thing here that
   flatters rather than reports.
4. **Does the live grid grow a third column?** No — the conditional option. The
   `defended` counter appears in `FUNNEL_OUTCOMES` for techniques already in
   focus, so the 5 × 2 category grid is untouched and only the handful of
   techniques a roadmap cares about pay for it.
5. **Can an athlete mark a technique complete by hand?** **No.** Decided
   2026-08-05, against this document's own recommendation. Mastery is
   **earned from the record or it is not claimed** — there is no hand-marking
   path, and `000034_create_curricula` has no column that could store one.

   The doc argued yes on the grounds that a coach saying "you've got that" beats
   ten tags and that a roadmap which cannot accept it gets worked around. That
   is a real cost and it is being paid deliberately, because the thing being
   protected is worth more: a roadmap whose completions can be self-declared
   cannot tell an athlete anything they did not already believe. The number has
   to be able to disappoint them or it means nothing.

   The consequence is that the bar has to be honest, which is what forced the
   criteria below to be re-derived from scratch.

### What "mastered" now requires, and why it is not easy

The earlier draft modelled ten live scores — about twelve focus-sessions, or a
month at three sessions a week. A month is not what anybody means by mastering a
technique, and with no hand-marking to soften it the threshold is now the only
thing standing between the word and its meaning.

Four criteria, all per technique, all nullable so a curriculum can also just be
a reading list:

| criterion | default | what it rules out |
| --- | --- | --- |
| `target_scored` | 25 | one good week |
| `target_defended` | 8 | knowing the attack and nothing about the defence |
| `target_sessions` | 12 | one big open mat against a tired partner |
| `min_hit_rate` | 0.35 | throwing it constantly and counting the hits |

At the modelled rate (~0.83 scores per focus-session with four techniques in
focus) 25 lands in roughly 30 focus-sessions — about ten weeks. A
twelve-technique syllabus worked four at a time therefore runs seven or eight
months, which is the right order of magnitude for a belt. The defensive eight is
a third of the offensive target on purpose, because defensive evidence arrives
about 3.2× more slowly; the two halves complete at about the same moment.

**`min_hit_rate` is what earns the word.** This document argued at length that
the honest term was "complete", not "mastered", because a volume threshold says
nothing about the denominator: 25-from-30 and 25-from-400 both satisfy it, and
only the first is skill. That objection is exact and it is answered by including
the denominator rather than by weakening the word. It is computable here — and
only here — because `attempted` and `scored` are kept **disjoint** (000025
defines `attempted` as "tried it live, it didn't land", not as total tries), so
`scored / (attempted + scored)` is a real hit rate rather than an estimate.

Verified against Postgres rather than asserted: with 26 scores over 13 sessions
and 9 defences, at a 0.394 hit rate, the item reads mastered; holding every
volume number identical and inflating the failed attempts to ~266 drops the rate
to 0.098 and it does not. The volume alone never decides it.

All five questions are now answered. `000034_create_curricula` is the first
thing built on them.

Three things get conflated whenever this is discussed, and they have different
data costs, different failure modes and different homes in the app. This
separates them:

1. **Curricula** — an ordered set of things to learn. Either picked from a
   VOLA-authored set of belt-level fundamentals, or built by the athlete.
   Content, not inference.
2. **Suggestions** — "work on half-guard retention", derived from what you
   logged. Inference over evidence, and the part with a wrong-answer risk.
3. **The gameplan** — *your* sequences: from here I go there, and if they do
   this I go there instead. A graph the athlete builds, not a list.

They are related but they are not one feature, and building them as one is the
main way this goes wrong.

---

## The question that decides everything: how much evidence is enough?

The brief asked for suggestions after "4–8 consecutive logs". **Session count is
the wrong unit**, and using it will produce confident nonsense for some athletes
and nothing at all for others.

### What a session actually produces

`bjj_session_tags` is the evidence stream (migration `000025`). The reflection
wizard's live step is a **5 × 2 grid** — five categories (submission, sweep,
pass, escape, takedown) × two outcomes (`scored`, `conceded`) — tagged against
one of **nine position families**, plus a drilled step that names techniques.

So a session yields somewhere between 0 and ~20 events depending entirely on how
much of the grid gets filled:

| how thoroughly the grid is filled | concede events per session |
| --- | --- |
| light — 3 cells touched | ~2 |
| typical — 5 cells | ~4 |
| thorough — 8 cells | ~8 |

A session is not a unit of evidence. **A tagged event is.**

### How many events a position claim needs

The claim "you concede most from X" is a claim that one of nine families is
carrying more than its share. Under a null of concessions spread evenly across
nine families, with a Bonferroni correction for testing all nine:

| concede events | the top family must hold | is that plausible? |
| --- | --- | --- |
| 12 | 6 (50%) | only for a very lopsided athlete |
| 18 | 7 (39%) | yes |
| 24 | 8 (33%) | yes |
| 30 | 9 (30%) | yes, comfortably |
| 40 | 11 (28%) | yes |

**18 usable concede events is the floor** where a real hot spot can clear noise
without the athlete having to be a caricature. 24–30 is where it gets
comfortable.

### So: is 8 sessions enough?

**It depends on a variable nobody is currently measuring.** Converting the table
above into sessions:

| | light logger | typical | thorough |
| --- | --- | --- | --- |
| 18 events (floor) | ~9 sessions | ~4 | ~2 |
| 24 events | ~12 | ~6 | ~3 |
| 30 events (comfortable) | ~15 | ~8 | ~4 |

And the real constraint sits underneath all of it: **`position` defaults to `''`,
and the schema explicitly calls untagged "a normal fast-path outcome, not an
error."** A concede row with no position cannot appear in a position claim at
all. So:

| share of concede rows carrying a position | typical sessions to reach 18 usable events |
| --- | --- |
| 100% | ~4 |
| 60% | ~8 |
| 30% | ~15 |

**The answer:** 8 sessions is roughly right *for a typical logger who tags a
position on most rows*, and badly wrong otherwise. Gate on **≥18 position-tagged
concede events**, not on a session count. Session count is a proxy for evidence
that is wrong by a factor of four across the plausible range, and the app can
measure the real thing directly.

### The rate claim is a different, much more expensive question

"Your concede rate in half guard is worse than your baseline" is a proportion
test, not a share-of-total test. At 80% power, α=0.05, to flag a position where
you concede 50% against a 25% baseline needs **~55 exchanges in that one
position**. Detecting a subtler 25%→45% needs **~85**.

That is months of detailed logging *per position*. **Do not build the rate
claim.** The share-of-total claim answers the athlete's actual question ("where
am I losing rounds") at a fifth of the cost.

### The cheap claim, and why it should ship first

A funnel gap — *"you drilled the arm drag 9 times and never tried it live"* — is
not a rate comparison at all. It is an absence, and absences are cheap:

| if you'd normally try a drilled technique live… | …then N drills with 0 attempts is p<0.05 |
| --- | --- |
| 40% of the time | 6 drills |
| 30% | 9 drills |
| 20% | 14 drills |

**A funnel gap is defensible at ~9 events against a single technique**, and it
needs no position tagging whatsoever. It is also the more actionable
suggestion — "try the thing you've been drilling" is a concrete instruction,
where "work on half guard" is a topic.

---

## Proposed shape: three tiers, gated on evidence

Each tier states its own evidence gate. Nothing fires until its gate is met, and
the gate is checked against events, never sessions.

### Tier 0 — before there is any evidence (0 sessions)

The brief asks for this explicitly and it is the most important tier, because it
is the only one that *creates* the evidence the rest depend on.

When an athlete logs their first BJJ sessions with the fast path and skips the
reflection wizard, Today should say — once, not every session — that the detail
is what unlocks the rest. Something like:

> Logging what happened in rolling is what lets VOLA suggest what to work on.
> Two minutes after class.

**It must not be a nag.** The recorded UX direction rules out shame, and this is
exactly the surface where a well-meaning prompt becomes one. Show it after the
2nd un-reflected session, and stop after the 4th regardless of outcome.

### Tier 1 — funnel gaps (gate: ≥6 drilled events on one technique, 0 attempted)

*"You've drilled the arm drag 9 times and haven't tried it live. Next session,
try it once from standing — even if it fails."*

- Reads `bjj_session_tags` on `(user_id, technique_id, event)` — an index that
  already exists, added for exactly this.
- Needs no position tagging.
- Deterministic and explainable: the suggestion can show its own evidence
  ("9 drilled, 0 attempted, since 3 March"), which the core principles require.
- Realistically fires at **3–5 detailed sessions**.

This is the tier to build first. It is cheap, it is honest, and it is the one
that proves the loop works before anything harder is attempted.

### Tier 2 — position hot spots (gate: ≥18 position-tagged concede events)

*"A third of what you concede happens in half guard — more than anywhere else.
Here are three half-guard retention entries from the library."*

- Reads `(user_id, position, event)` — also already indexed.
- Shows its evidence: the count, the share, the window.
- The suggestion links into the technique library filtered to that position,
  which already supports the filter (`usesPosition`, the belt/position facets).

**Explicitly out of scope:** the rate claim (~55+ exchanges per position). If
the share claim proves useful, revisit; do not start there.

### Tier 3 — the gameplan (not inference; authoring)

This is where the brief's "sequences to work on" lives, and it is **not a
suggestion engine**. It is an editor.

`techniques` already carries `function` and a derived `to_position`, which makes
the catalog a directed graph: a technique is an edge from one position to
another. A gameplan is a **path the athlete chooses through that graph** — from
closed guard, my sweep is X, and if they posture up I go to Y.

- The graph exists. The authoring surface does not.
- Suggesting *sequences* automatically ("try this chain") requires knowing which
  edges the athlete can already hit, which is Tier 1 + Tier 2 data at
  much higher resolution than either needs. **Defer.**
- What is worth building early: let the athlete *assemble* a chain and put it on
  a session as an intention, so that next session's tags attach to it. That
  makes the gameplan a source of evidence rather than a consumer of it.

---

---

## Roadmaps: mastery criteria, and the two things that decide whether this works

A roadmap is a curriculum with **completion criteria per technique**, worked over
months. The athlete picks "White belt basics", trains deliberately, logs, and
techniques tick over to mastered as the evidence arrives. User-built roadmaps get
the same machinery — which is the right call, because it means one engine and no
second-class citizens.

Two findings decide whether the shape works. The first is cheap to fix and the
second is a design constraint that has to be respected rather than solved.

### Finding 1: there is no way to record a defensive success today

The requirement — *"need to not get caught in guard pull N times"* — needs an
event the vocabulary does not have. `bjj_session_tags.event` is:

    drilled | attempted | scored | conceded

`scored` is "I landed it". `conceded` is "it was done to me". **Neither is "I
stopped them doing it."** The offensive half of every criterion is already
recordable; the defensive half is not.

Two ways out, and only one is good:

- **Infer it from absence** — "you weren't caught in it across 10 sessions".
  Weak: you may simply never have faced it, and the claim gets stronger the less
  you roll, which is backwards. Rejected.
- **Add `defended` to the vocabulary.** The column is `TEXT NOT NULL` with **no
  CHECK constraint**, and the migration is explicit that this is deliberate so
  the vocabulary can grow by "an enum edit rather than a migration". Adding a
  fifth event is a Go validation change plus a column in the wizard's live grid.

**Take the second.** It is what the schema was shaped for, and a defensive
criterion built on absence would be the fabricated-zero mistake in a new costume.

Note this makes the live grid 5 × 3 rather than 5 × 2 (*you / them / stopped
them*). That is a real cost on the fastest screen in the app and should be
weighed — possibly the third column only appears for techniques on an active
roadmap, where the criterion actually needs it.

### Finding 2: the defensive criterion is what stalls the roadmap

You choose when to attempt a guard pull. You do **not** choose when someone
attempts one on you. So defensive events arrive several times more slowly, and a
symmetric criterion makes defence the gate on everything.

Modelled at 3 sessions/week with 4 techniques in focus (`bjj_focus`'s own stated
scope is "three-to-five things you are developing"):

| criterion | offence clears in | defence clears in | defence is |
| --- | --- | --- | --- |
| 10 off / 10 def | 12 focus-sessions | 40 | **3.2× the wait** |
| 10 off / 5 def | 12 | 20 | 1.6× |
| **10 off / 3 def** | **12** | **12** | **1.0× — balanced** |

**Defensive targets should be roughly a third of offensive ones.** Not because
defence matters less, but because the rate of opportunity differs by about that
much. *(The 1:3 RATIO is what survived into `000034`; the absolute numbers did
not. Ten and three clear in about twelve focus-sessions, which is a month — too
cheap for the word "mastered" once hand-marking was ruled out. The shipped
defaults are 25 and 8, same ratio, about ten weeks. See the top of this
document.)* A criterion that reads "land it 10 times, defend it 3 times" completes both
halves at the same time; "10 and 10" is a roadmap that is 76% offence-complete
and stuck.

### How long a course actually takes

Same model, whole-course:

| course size | eager | typical | realistic beginner |
| --- | --- | --- | --- |
| 20 techniques | ~14 weeks | ~33 weeks | ~1.1 years |
| 30 techniques | ~21 weeks | ~1.0 year | ~1.6 years |
| 40 techniques | ~28 weeks | ~1.3 years | ~2.1 years |

**A belt course is a year, not a month.** That is correct — it should be, a belt
takes years — but it dictates the UX absolutely:

- **Completion cannot be the reward.** Nobody sustains a year of effort for a
  terminal badge. The unit of progress the athlete feels has to be the
  *technique*, ticking over every week or two, with the course as the backdrop.
- **A progress bar at 4% for the first month is discouraging.** Show techniques
  mastered as a count and the current few as a foreground, not a percentage of a
  distant whole.
- **Keep the course size honest.** 20 techniques is a year for a real beginner.
  A 40-technique "white belt course" is a two-year commitment mislabelled.

### The criteria are volume, not skill, and the copy must not overclaim

"Landed it 10 times" proves you can do it repeatedly. It does **not** prove a
success *rate*, because it says nothing about attempts — 10 from 12 and 10 from
90 both satisfy it. That is a fine definition of competence for a fundamentals
course, and it is cheap to log and trivial to explain, which matters more here
than statistical purity.

But the word for it is **"complete"**, not **"mastered"**. The evidence supports
"you have done this ten times"; it does not support a claim about how good you
are. The rate claim needs the attempt denominator, which is exactly the ~55
exchanges the Tier 2 analysis priced — far beyond a per-technique criterion.

*(This objection stands, and `000034` answers it rather than ignoring it: the
criteria now INCLUDE the denominator, via `min_hit_rate` =
`scored / (attempted + scored)`. Note the paragraph above conflates two
different denominators. The ~55 figure prices a POSITION-level claim tested
against a population baseline — "your concede rate in half guard is worse than
your baseline" — which is still not built and still should not be. A
per-technique hit rate compared against a fixed threshold is a much weaker claim
and needs only the athlete's own attempts, which this schema already records
disjointly. That is why the word "mastered" is defensible in `000034` and was
not defensible here.)*

---

## How it connects to the existing screens

The brief asks for this to be seamless. Most of the connective tissue already
exists, which is the strongest argument for this shape:

| screen | what it does | what it reuses |
| --- | --- | --- |
| **Plan** | pick or build a roadmap; see technique progress | the My / Shared tab strip built for workouts |
| **Today** | one suggestion, sourced from the active roadmap | the Upcoming block |
| **Reflect wizard** | roadmap techniques prefill as focus chips | `bjj_focus` accelerator rows already render there |
| **Library** | a technique shows its criteria and your counts | `/v1/bjj/proficiency` already aggregates the funnel per technique |
| **You** | techniques complete, current focus | the existing stats surface |

**`bjj_focus` is the bridge, and it already works.** A roadmap's current
techniques become focus rows; focus rows already appear in the reflection wizard
as one-tap chips; those chips write technique-tagged events; those events feed
the criteria. The loop closes through machinery that shipped months ago — the
roadmap chooses *what* goes into focus instead of the athlete choosing by hand.

`/v1/bjj/proficiency` is already routed and already aggregates
drilled/attempted/scored/conceded per technique with a session count. **Criteria
are a read over that endpoint's output**, not a new aggregation. It only needs
`defended` added to its CASE arms.

Per the platform rule — mobile owns live logging, web owns authoring and
analysis — the split is the brief's own instinct: **in on Plan, out on Today**,
with roadmap *building* and the full funnel on web, and admin authoring the
belt-level sets under `/content`'s existing rules.

The one genuinely new piece of state is *which roadmap am I on and when did each
technique complete* — small, and completion should be **stored** rather than
recomputed, unlike suggestions. A technique you completed in March stays
completed when you stop training it in June; that is the opposite of adherence,
where recomputation is what keeps it honest.

*(**OVERRULED** — see the top of this document. Completion is DERIVED like
everything else, and `000034` has no column that could store it. Recording the
reversal here because this paragraph reads as the plan of record and would
otherwise be quoted back as one.*

*The consequence it names is real and is accepted: mastery is a statement about
the record NOW, not a trophy, so a long enough bad run can take it back. Two
things make that livable rather than cruel. The measurement window means only
evidence since enrolling counts, so nothing can be un-mastered by history the
athlete has already moved past. And reaching 25 scores at a 0.35 rate takes
enough volume that one bad month cannot undo it — the arithmetic has to go
badly wrong for months. What it does mean is that the copy must say "your record
shows" rather than "you have earned", because the second promises permanence the
data model does not offer.)*

---

## Curricula: no new sharing model needed

**Academies are out of scope.** The earlier draft asked whether academy curricula
would force `bjj_session_details.academy` to become a shared entity. That
question is closed — it stays free text, on the reasoning the schema already
recorded ("not a shared entity until something asks who else trains here").
Nothing here asks.

There are exactly two sources of a curriculum:

- **VOLA-authored fundamentals** — "White belt basics", "Blue belt basics", and
  so on. Seeded, like the technique catalog.
- **The athlete's own** — built in the app, private by default.

**That is the `workouts` model, unchanged.** `000006_create_workouts` already
solved this: nullable `owner_user_id` where NULL means a VOLA-authored official
template, plus `visibility`, plus a CHECK that an ownerless row must be public.
Its own comment says this "covers both sharing cases … without an ACL table,
which would be premature". A curriculum is structurally a workout template whose
items are techniques rather than exercises, so it should copy that shape
verbatim rather than invent a second sharing story.

The consequences fall out for free:

- The Plan tab's **My / Shared** tab strip already exists for workouts and
  applies here without redesign.
- Seeding follows the existing content path (`cmd/seed`, `cmd/exportcontent`,
  the seed JSON; the `.additions.json` half of this was retired in 2026-08) —
  including the trap that console-authored
  content must be exported into *both* files or it is lost.
- Admin authoring of the predefined sets reuses `/content`'s rules: only
  `source=admin` rows are editable, ownership is membership of that list rather
  than a field read off the row.

**Belt-level curricula should be offered, not imposed.** The app already knows
the athlete's rank — `bjj_promotions` exists and `Standing` is derived
server-side — so "Blue belt basics" can be surfaced first without asking a
question the app can already answer. It must stay a suggestion: an athlete who
wants to work white-belt fundamentals at purple is not making a mistake, and the
recorded UX direction rules out the app implying otherwise.

**A curriculum is not a suggestion source.** Following one tells the app what you
intend to learn; the suggestion tiers below tell you what your logs say about how
it is going. Keeping them separate is what stops a curriculum from silently
becoming a prescription — and it means an athlete following no curriculum still
gets suggestions, which is most athletes at the start.

## What I'd want settled before any schema lands

> **All five are settled as of 2026-08-05** — see "Questions the implementation
> answered" at the top, which records the decision and the reasoning for each.
> The list below is preserved as the original framing, because the *arguments*
> for each recommendation are still the reason the answers are what they are.

1. **Does a suggestion persist, or is it recomputed?** Recommend recomputed —
   same argument as `lib/adherence.ts`: a stored suggestion goes stale against
   the evidence it was derived from, and deleting a session should withdraw the
   claim it supported. But a *dismissed* suggestion has to persist, or it comes
   back every launch.
2. **One suggestion at a time, or a list?** Recommend one. Three suggestions is
   a report; one is an instruction, and the whole point is that it changes what
   you do on Wednesday.
3. **What happens when the evidence gate is met but nothing stands out?** This
   needs an answer that is not silence and not a fabricated finding — probably
   "nothing stands out yet, which is its own kind of good news", stated once.
4. **Does the live grid grow a third column, or does `defended` appear only for
   roadmap techniques?** The grid is the fastest screen in the app and 5 × 2 is
   part of why. Growing it to 5 × 3 for everyone taxes every session to serve
   the athletes on a roadmap; showing it conditionally is more code and a
   surface that changes shape. I lean conditional, but it is a real trade.
5. **Can an athlete mark a technique complete by hand?** A coach saying "you've
   got that" is better evidence than ten tags, and a roadmap that cannot accept
   it will be worked around or abandoned. I lean yes, recorded as a distinct
   source so the two are never confused. *(Answered NO — see the top of this
   document. This recommendation was overruled deliberately, and the reasoning
   for overruling it is recorded there.)*

## Known gaps in this design

- **The position-tagging rate is unmeasured.** Every session-count estimate here
  rests on an assumed 30–100% tagging rate. The cheapest thing that would
  sharpen this whole document is instrumenting what share of live-grid rows
  carry a position — that is a query over existing data, not a feature.
- **`bjj_session_tags.count` means the numbers are not independent events.** "Got
  swept 3 times" is one row with `count = 3`. The binomial maths above treats
  those as 3 observations, which is roughly right for rolling but overstates
  confidence if an athlete logs one big number after an open mat. A cap
  (treat `count > 3` as 3 for inference) is the crude fix; worth a decision.
- **No baseline for what "normal" looks like.** Every athlete concedes most in
  guard early on. Without a population baseline, "you concede most in X" may
  just be describing white belts. Tier 2 may need a belt-adjusted expectation
  before it says anything useful — and there is no population data yet.
- **The offence:defence 1:3 ratio is modelled, not measured.** It rests on an
  assumed opportunity rate for defending a given technique, which nobody has
  data on. It is far better than a symmetric default, and it should be revisited
  the moment there are real logs — the criteria are content, so correcting them
  later is a seed edit rather than a migration.
- **Nothing here has been validated against real logged data**, because there
  isn't any at volume yet. Every number above is derived from the schema's
  shape, not from behaviour.
