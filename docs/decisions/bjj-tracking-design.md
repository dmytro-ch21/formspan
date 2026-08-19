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

## 7. Say it, and it fills the chips (N33)

§3 item 6 already wants voice: *"Free note, ideally voice. Hold-to-dictate on
the walk to the car."* This is that same dictation filling the **structured**
half as well — not just the note the chips cannot hold.

The claim is narrow. An athlete says *"rolled five rounds, hit an armbar from
closed guard in the second, got passed from half guard twice, knee felt off at
the end"* and gets back a **draft reflection they correct** — chips already
ticked, rounds filled, the body note carried across. Nothing is logged until
they confirm.

### Why BJJ suits this better than food does

N26 (`nutrition-design.md` §6) is the precedent, and the same shape works here
for a reason that is stronger, not weaker: **the target vocabulary is closed
and small.** Six categories, five event directions, eleven positions, 542
technique ids. That is a structured-output problem with a fixed answer set,
where portion estimation from a photo is an open-ended numeric guess. The
model is not being asked to know anything — it is being asked to map a
sentence onto an enum this repo already defines.

It also removes a cost rather than relocating it. **N31** made a technique
attributable by adding a row and a tap; dictation attaches the technique for
free, because "hit an armbar from closed guard" already names it. That is the
argument for building this at all: the fast path is three taps and every
structured field beyond that has to be *earned*, so the only honest way to get
richer evidence is to stop charging taps for it.

### The input is TEXT, and that answers Open question 4

**No audio leaves the device, because no audio is sent.** iOS's own keyboard
dictation turns speech into text in the field the athlete is already typing
into; the app sees a string. That means:

- no audio upload, no transcription provider, no second vendor;
- no new native dependency, no microphone permission beyond what the keyboard
  already has;
- **Open question 4 is answered — transcription is on-device, by the system
  keyboard**, and the privacy promise reduces to one sentence: the *text* you
  dictated is sent to draft a reflection, and only when you ask for one.

A dedicated record-and-upload path buys better punctuation and nothing else.
It is not worth a vendor.

### Draft, never logged

The response is a `SessionDetail`-shaped **draft** that lands in the existing
wizard with chips pre-ticked. The athlete edits and saves through
`PUT /v1/bjj/sessions/{id}` exactly as today. Three consequences:

- **The confirmation is what makes it the athlete's claim.** A tag is already
  `reported` basis — the athlete said it and nobody checked. A *dictated* tag
  is one step further removed: the athlete said it and a model parsed it. The
  confirm step is what closes that gap, so it can never be skipped, and there
  is deliberately no "log it for me" button.
- **No new write path.** The endpoint writes nothing. Everything still goes
  through the validation `PutDetail` already enforces.
- **Re-running replaces the draft, never the saved session.**

### The endpoint

`POST /v1/bjj/reflect/draft` — server-side only, so the key never enters an app
bundle, there is one place to meter it, and the provider can change without an
app release. Body is the dictated text plus the session id for context (kind,
gi, what is already tagged). Response is a draft plus a per-field note of what
the model was unsure about.

Nothing about it is BJJ-specific in shape; it is BJJ-specific in vocabulary.

### Resolving techniques: put the catalog in the prompt

The hard part is "armbar from closed guard" → `armbar-closed-guard`. Three
options were considered and the third wins on cost and simplicity:

1. **A Go text ranker.** There is none on the backend — `rankTechniques` lives
   in mobile and `techniqueSearch` in web — so this means porting a third copy
   of a fuzzy matcher, which is the drift shape this repo keeps arguing
   against.
2. **A trigram shortlist, then a second model call to choose.** Two round
   trips for one sentence.
3. **Send the catalog.** 542 entries as `id · name · position` is ~10K tokens.
   With a cache breakpoint on the system block it costs **~0.1× on every call
   after the first**, and the model emits real ids directly.

Option 3, with two hard rules:

- **The emitted id is validated against the catalog in Go.** A model can
  produce a plausible id that does not exist; an unknown id is dropped into an
  `unresolved` list with the phrase that produced it, for the athlete to pick
  from the normal picker. **It is never guessed at and never silently
  dropped.**
- **The catalog is rendered deterministically** — sorted by id, no timestamps,
  no per-user content — because caching is a prefix match and a single moved
  byte re-bills the whole prefix.

Enumerating all 542 ids in the JSON schema would make an invalid id
structurally impossible, and is worth testing — but it roughly doubles the
cached prefix (the model still needs the *names* to map onto), and schema
compile time at that size is unmeasured. Ship the validated-string version
first.

### What the schema can and cannot say

Structured outputs constrain the response to a JSON schema, and the supported
subset matters here: `enum` and `additionalProperties: false` **are**
supported, which covers category, event, position and gi exactly. Numeric and
length constraints (`minimum`, `maxLength`) **are not**.

So the schema cannot express "count is at least 1" or "session RPE is 1–10" —
**the Go validation is the gate, as it already is for a hand-typed
reflection.** That is the property to hold onto: model output is untrusted
input, validated by the same rules a client's payload passes through, not by a
second set written for the model.

### What it must not do

- **Never invent a number the athlete did not say.** No RPE, no round count,
  no gi/no-gi guess. Absent means absent — the schema makes every field
  nullable and the draft leaves it blank rather than filling a plausible value
  the athlete then has to notice and undo.
- **Never create, finish or delete a session.**
- **Never emit a technique on anything but a submission**, matching the rule
  `contest` already enforces for its matches.
- **Never carry the prose through as tags.** The free note stays the free
  note; the chips are what the model extracted.

### Cost and latency

Sized against Claude Opus 5 at $5/$25 per MTok, with a ~11.5K-token cached
prefix (catalog + instructions + schema) and a ~500-token draft:

| | per call |
|---|---|
| First call (cache write, 1.25×) | ~$0.085 |
| Subsequent calls (cache read, 0.1×) | **~$0.019** |
| Of which output | ~$0.013 |

**Output dominates a warm call**, so the lever is a tight schema, not a
shorter catalog. Cache reads are ~0.1× and writes ~1.25× at the 5-minute TTL,
so two calls inside the window already pay for the write; a 1-hour TTL doubles
the write and suits evening bursts where a whole gym finishes within the hour.
Opus 5's cacheable minimum is 512 tokens, so the prefix clears it by a wide
margin.

Cheaper tiers are a real option for a task this constrained — Sonnet 5 is
$3/$15 and Haiku 4.5 $1/$5 — but that is a decision to make against an eval
set of real dictations, not by assumption.

**The eval set exists** (N34): `evals/bjj-dictation/`, with its scoring metric
in the README and a validator wired into `verify` and CI. It is the half of
this work that was never blocked on a provider, and it pins the rules below
before any model sees them. Thirty authored cases so far and **no recorded
ones**, which its own README is blunt about: an authored corpus scores
self-consistency rather than reality, and a tier comparison run against it is
directional at best.

The metric's shape is the part worth carrying here. **Invention rate is ranked
above accuracy**, and the reason is who catches the error: a missing tag is
visible — the athlete is looking at the draft and adds it — while an invented
one is plausible, pre-ticked, and one tap from being confirmed. Optimising F1
would happily trade inventions for recall, which is the wrong trade for a
screen whose whole job is to be confirmed quickly.

Use **thinking on at low or medium effort** — it is an extraction task, not a
reasoning one. Do not disable thinking: on this model that is capped at `high`
effort anyway, and it introduces two failure modes (tool calls emitted as
plain text, `<thinking>` tags leaking into output) for no benefit here.

### Failure modes, all of which degrade to the wizard

- **Offline** — no draft, and the wizard is unchanged and complete on its own.
  This is an accelerator, never a dependency.
- **A refusal** (`stop_reason: "refusal"`) or a truncated response — treat as
  no draft. **Never partially apply an incomplete JSON draft**; a half-parsed
  reflection is worse than none, because the athlete cannot see what is
  missing.
- **A per-user quota**, because this is the first endpoint in the app where a
  loop costs real money.
- **An explicit disclosure in the UI**, not only in a privacy page: this text
  is sent to draft your reflection.

### Open questions this leaves

1. **No provider is wired anywhere in this repo** — no client, no key, no
   dependency, in backend, apps or Railway. That is an account and
   key-management decision before any code.
2. **Does the draft merge with existing tags or replace them?** Replace is
   simpler and matches how the wizard already treats a step. Merge is what
   somebody dictating a second time actually wants.
3. **Is the raw dictation retained?** Useful for debugging and for building
   the eval set; it is also the athlete's own words about their body. Default
   to not storing it, and make the eval set opt-in.
4. **Web too?** The platform rule puts reflection on the phone, and dictation
   is a phone affordance — but the same endpoint would accept typed prose from
   the web session editor at no extra cost.

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
4. ~~**Voice transcription: on-device or server?**~~ **Answered by §7:
   on-device, via the system keyboard.** The app never handles audio — the
   keyboard hands it text — so there is no transcription vendor, no upload,
   and the privacy promise shrinks to one sentence about the text. What
   remains open is whether the *text* is retained for debugging (§7, open
   question 3).
