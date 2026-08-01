# BJJ tracking — the whole-system design

Status: **draft for discussion**, 2026-08-01. This is the thinking pass before
building the BJJ logging increment — the same kind of document as
[system-design.md](system-design.md), which it complements: that file decides
how the sports combine into one product; this one decides what tracking a BJJ
session should *feel like* and what data it must produce for everything
downstream (insights, focused work, the gameplan, curricula). Nothing here is
built yet.

---

## 1. The inversion: BJJ flips the strength UX

In the gym, the phone is a companion *during* the workout — rest timer, set
logging, next-target. On the mat it cannot be: sweaty hands, a mouthguard,
6-minute rounds, gis without pockets. So the design principle is:

**Zero interaction during the session. Everything happens at reflection — and
reflection must happen within ~20 minutes of stepping off the mat.**

Memory of individual rolls decays absurdly fast. By the drive home, "I got
swept a bunch" is all that remains of what was, mat-side, "he kept getting the
underhook in half guard because I was lazy with my frames." The entire value
of the system depends on catching the second version, which makes reflection
*latency* and *speed* the two make-or-break metrics.

### Two layers, reconciling the ≤3-tap budget

[system-design.md §4](system-design.md) sets a hard budget: a BJJ session
logged in ≤3 taps and ≤5 seconds. That budget stands, and the reflection
wizard does not violate it — they are two layers of the same flow:

- **The floor (≤3 taps, always):** type (class/drilling/positional/rolling,
  pre-staged from the schedule), rounds × length, session RPE. This alone is a
  valid session — consistency data survives the lazy day, and the streak never
  breaks on it. This is the log-by-confirmation path system-design already
  mandates.
- **The reflection wizard (60–90 seconds, prompted, skippable):** everything
  in §3 below. A post-class notification (the calendar knows when class ended)
  opens straight into it. Every step past the floor is individually skippable.

A two-minute mandatory wizard would quietly kill the habit and therefore the
whole system. The J4 success criterion — full session including technique tags
in under a minute — is the number to be ruthless about in design review.

## 2. Evidence over self-assessment

Never ask "rate your triangle, 1–5." People are terrible at it, it goes stale,
and it produces a number with no provenance. Instead, accumulate small factual
events — *drilled it today; attempted it twice in rolling; hit it once against
a same-rank partner* — and let proficiency **emerge** from the record.

This is also the retroactive justification for deferring per-technique
proficiency *scoring* out of MVP: a score is a derived view. What cannot be
deferred is the **event stream a score could later be derived from** — that
has to start accumulating from the first logged session.

## 3. What the reflection wizard captures, in order

Ordered by decreasing certainty: easy confirmations first, thinking last.

1. **Context** — pre-filled from the calendar or the start-session tap: type,
   gi/no-gi, duration, academy. One confirm tap.
2. **Volume** — rounds sparred × round length. The BJJ equivalent of tonnage;
   "hard rounds this week" is the number the cross-sport conflict engine (J6)
   reads from this module, via the sRPE × duration load currency
   system-design §5 already defines.
3. **Effort & state** — session RPE, perceived performance, and a body/injury
   flag (feeds the recommendation rules' safety floors).
4. **What was drilled** — picker over the technique library, position-first,
   with recents and the current focus (§5) surfaced on top. The library's
   position organization is what makes this 3 seconds instead of 30.
5. **What happened live** — the highest-value, hardest-to-capture part.
   Structured as chips, **symmetric on success and failure**: submissions hit /
   caught in, sweeps hit / got swept, escapes made / got stuck, passes made /
   got passed — each optionally tagged with position and technique. The
   failure side is the more valuable half: "where do I keep getting stuck" is
   the question every serious grappler is trying to answer and almost nobody
   has data on.
6. **Free note, ideally voice.** Hold-to-dictate on the walk to the car. Chips
   make the data queryable; the note captures what chips can't ("his grip
   broke my posture *before* I could establish the frame"). Voice keeps the
   honest, immediate register that typing kills. Transcription may lag the
   recording feature — capture first, transcribe later is fine.

## 4. The game is a graph — and the graph already exists

The technique library already *is* a graph: positions are the organizing
dimension, and in the seeded library 444 of 450 techniques carry `setup_from`
edges and every one carries counters (see
`backend/internal/modules/technique/technique.go`). A sweep is an edge from a
guard to a top position; a submission is an edge to a terminal node; an escape
is an edge out of a bad position; a pass is an edge from top-of-guard to a
pin.

What this design adds is the **athlete's evidence overlay** on that shared
reference graph. Every reflection chip from §3.5 is evidence attached to an
edge: drilled, attempted-live, hit-live, hit-against-higher-belt. Over months,
the athlete's *actual* game emerges from data instead of being self-declared:

- "Your A-game is closed guard → armbar/triangle threat → scissor sweep."
- "Your side-control escapes fail 70% of the time."
- "You have zero recorded exits from bottom half guard."

That last shape — a node with no reliable edges out — is a **gap**, and gap
detection is deterministic graph analysis, fully consistent with the
no-ML/explainable-rules principle. The deferred gameplan builder then becomes
*curation over an evidence-backed graph*, rather than the aspirational
whiteboard that every paper BJJ journal amounts to.

**The schema consequence, and it applies now:** technique tags on a session
must carry position context and an **outcome direction** (hit vs. received,
success vs. fail) from the first migration. That is nearly free today and
expensive to retrofit — and it is what keeps every deferred feature
(proficiency views, gameplan, curricula) a pure read over data that will
already have months of depth.

## 5. The progression loop: insights → focus → curricula

Three features that are really one loop at three levels of guidance, sharing
one mechanism:

- **Insights (bottom-up).** Position heatmap of where rounds are won and lost;
  the **technique funnel** — taught → drilled → attempted-live → hit-live —
  whose drop-offs are the most actionable numbers in BJJ ("drilled 12 times,
  attempted 0" is a finding, not a statistic); mat hours and hard rounds per
  week; gap detection from §4.
- **Focused work (the middle, highest leverage, cheapest to build).** The
  athlete picks *one* focus — a position or a chain — for 2–4 weeks. The app
  then closes the loop everywhere: the reflection wizard leads with the focus
  ("Deep half: did you get there? attempts? outcomes?"), the weekly review
  charts the focus's attempt/success trend specifically, and when the trend
  plateaus or matures it suggests rotating. This mirrors how good coaches
  structure development, and the build is one profile field, conditional
  wizard prompts, and one chart. It also raises reflection quality for free:
  the athlete walks *into* class knowing what they're collecting data on.
- **Curricula (top-down, deferred, content-heavy).** For the from-scratch
  athlete who can't self-select a focus: belt-level tracks mapped onto the
  library — white-belt fundamentals as "one escape, one sweep, one submission,
  one pass per major position" — where **each curriculum step simply sets the
  current focus**. Curricula are pre-authored focus sequences; same machinery.
  Deferring them is right (they need authoring and instructor credibility),
  but building focus mode first means they drop in later with no new plumbing.

## 6. What this changes about near-term work

1. **The reflection wizard shape is the J4 spec**, not a later enhancement —
   symmetric success/failure chips, per-step skippability, the two-layer
   floor/wizard split, and the post-class notification are how the logging
   screen should be designed the first time.
2. **Make the tag schema graph-ready in the first migration** — position
   context + outcome direction on every technique tag (§4).
3. **Voice capture is a small add with outsized retention value**, and its
   native-module needs land on the same pile as HealthKit and widgets — more
   weight behind system-design's "leave Expo Go before the real logging
   increment" call.

## Open questions

1. **Rounds granularity.** Is a session one aggregate record, or is a
   per-round breakdown (partner belt/weight, outcome per round) ever worth
   the extra taps? Suggested: aggregate for MVP; per-round only if reflection
   data shows users writing round-by-round detail into free notes.
2. **Partner tracking.** Outcome context differs enormously by partner
   (white-belt vs. brown-belt). Track partners as anonymous attributes
   (belt/size) rather than identities? Privacy stance says never names.
3. **Where does reflection prompting live** relative to the sRPE prompt
   system-design §Open-2 already asks about — same notification, or does
   stacking both prompts hurt completion of the floor log?
4. **Voice transcription: on-device or server?** On-device is private and
   offline-friendly but platform-fragmented; server is consistent but makes a
   privacy promise we have to write down.
