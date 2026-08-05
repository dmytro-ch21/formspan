# Curricula, suggestions and the gameplan — design draft

**Status:** draft for review. Nothing built. No schema proposed for merge yet.

Three things get conflated whenever this is discussed, and they have different
data costs, different failure modes and different homes in the app. This
separates them:

1. **Curricula** — an ordered set of things to learn. Authored by a coach or by
   VOLA; the athlete follows one. Content, not inference.
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

## Where these live

Per the platform rule — mobile owns live logging, web owns authoring and
analysis — this splits cleanly, and the brief's instinct ("in on planning, out
on today") is right:

| surface | what | where |
| --- | --- | --- |
| **Plan (mobile)** | pick a curriculum, see the current suggestion, put a focus on the week | the way *in* |
| **Today (mobile)** | the active suggestion, at most one, alongside Upcoming | the way *out* |
| **Web** | curriculum authoring, the gameplan graph editor, the full funnel and heatmap | desk work |
| **Admin** | authoring predefined/academy curricula, same rules as `/content` | already has the pattern |

`bjj_focus` is already the "what I'm working on now" primitive and should be
what a suggestion writes to when accepted — not a new table. It has
`started_on` specifically so "you've been on this five weeks, consider
rotating" is answerable.

---

## What I'd want settled before any schema lands

1. **Are academy curricula shared entities?** `bjj_session_details.academy` is
   free text today, on the recorded reasoning that academies are not a shared
   entity "until something asks who else trains here". A configurable academy
   curriculum is that thing asking. This is the one decision here that changes
   the data model rather than adding to it.
2. **Does a suggestion persist, or is it recomputed?** Recommend recomputed —
   same argument as `lib/adherence.ts`: a stored suggestion goes stale against
   the evidence it was derived from, and deleting a session should withdraw the
   claim it supported. But a *dismissed* suggestion has to persist, or it comes
   back every launch.
3. **One suggestion at a time, or a list?** Recommend one. Three suggestions is
   a report; one is an instruction, and the whole point is that it changes what
   you do on Wednesday.
4. **What happens when the evidence gate is met but nothing stands out?** This
   needs an answer that is not silence and not a fabricated finding — probably
   "nothing stands out yet, which is its own kind of good news", stated once.

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
- **Nothing here has been validated against real logged data**, because there
  isn't any at volume yet. Every number above is derived from the schema's
  shape, not from behaviour.
