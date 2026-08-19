# Dictated BJJ reflection — eval set

The corpus for **N33** ([`docs/decisions/bjj-tracking-design.md` §7](../../docs/decisions/bjj-tracking-design.md)):
an athlete says what happened, and a server-side endpoint returns a **draft they
correct**. `cases.json` pairs a dictated sentence with the draft a correct
extraction produces.

This exists **before** the endpoint on purpose. N33 is blocked on a provider
decision; the eval set is not, and it is the artefact that makes "which model
tier" a measurement instead of an opinion. It also outlives whichever model is
current.

---

## Read this before trusting a score

**Every case here is `authored`, not `recorded`.** They were written by
reasoning about how an athlete talks, not by listening to one. That is the
classic eval failure: a corpus written by the same process that writes the
prompt tests **self-consistency, not reality**, and it will happily report a
high score for a model that is confidently wrong about real speech.

Concretely, what authored cases cannot tell you:

- how people actually hedge, repair, and trail off mid-sentence;
- which techniques get named colloquially and which never do;
- how often a real dictation contains nothing structured at all;
- whether the iOS keyboard's own transcription mangles jiu-jitsu vocabulary
  before the endpoint ever sees it — *this one is invisible to the whole set,
  because these cases start from clean text.*

So: the authored set proves the **format** works and pins the **rules**. Treat a
tier comparison run against it as directional at best. The set becomes
trustworthy when `recorded` cases dominate, which is what
`check-dictation-evals.py` prints on every run.

Fifty **recorded** dictations is the target. Thirty authored ones are scaffolding.

---

## Adding a recorded case

1. Dictate into any note app after training, exactly as you would to the phone.
   Do not clean it up — the disfluency is the data.
2. Add a case with `"source": "recorded"`.
3. Fill `expect` by hand with what the draft *should* be, before running any
   model against it. Writing the expectation after seeing model output turns the
   eval into a rubber stamp.
4. Run `pnpm run check:evals`. It will reject an expectation the app could never
   produce — a technique id that does not exist, a category the technique does
   not derive, a detailed position where the tag stores a family.

A case that is genuinely ambiguous to a human is a *good* case: record the
ambiguity in `why` and put the honest answer in `expect`, usually `unresolved`.

---

## Scoring

Three metrics, in strict priority order. The order is the whole design.

### 1. Invention rate — the one that gates a release

> The fraction of cases where the draft fills something the expectation says
> must be absent.

`must_not` lists the fields that must stay empty. A filled `session_rpe` where
the athlete named no effort, a tag where the prose described an *intention*, a
confident `technique_id` where only "armbar" was said — each is an invention.

**This is weighted above everything else because of who catches the error.** A
missing tag is visible: the athlete is looking at the draft and adds it. An
invented one is not — it is plausible, it is pre-ticked, and confirming it is
one tap. An eval that optimises F1 will happily trade inventions for recall,
which is the wrong trade for a screen whose whole job is to be confirmed
quickly. Target is zero, not "low".

Producing a `technique_id` where the expectation lists `unresolved` counts as an
**invention**, not a miss.

### 2. Tag F1

Match on the tuple `(category, event, position, technique_id)`, compared as a
multiset so counts matter. Report precision and recall separately — they fail
for different reasons, and recall is the cheaper failure.

### 3. Scalar exactness

`kind`, `gi`, `rounds`, `round_minutes`, `session_rpe`: exact match, where
`null` means "must be null" and is scored under metric 1, not here.

### Tolerant fields

Some expectations are legitimately a range rather than a value —
`e-hedged-count` ("a couple, maybe three") is correct at 2 or 3. Those are noted
in `why`. A scorer that demands exactness there is measuring its own rigidity.

---

## Which models to run, and what we predict

Write the prediction down before the run, or the result is unfalsifiable — the
same reason `expect` is filled before a model sees the case.

N26 ran a two-provider bake-off on a structurally identical problem (prose →
JSON schema → validated draft) and found something that transfers here:

- Both providers were **12/12 correct** and refused gibberish 3/3, so this is
  not a reliability split.
- The split was the **confidence field**, and the precise shape matters.
  `gpt-5.4-nano` marked "two scrambled eggs" as `medium` — where the quantity is
  *stated in the sentence*, so `high` is simply correct, and both Haiku 4.5 and
  `gpt-5.6-luna` give it. That is **not caution; it is noise.**

**Why noise hurts this eval more than it hurt N26.** There, confidence only
pre-focuses a quantity field — a wrong `medium` costs the athlete one glance.
Here, the equivalent judgement *is* the scored metric: "should this have been
`unresolved`?" is metric 1, weighted above everything else. Noise on that
judgement lands directly on the primary score.

So the prediction, on the record:

> `gpt-5.4-nano` will score materially worse on **invention rate** than a
> better-calibrated model, while plausibly matching or beating it on tag F1 —
> because F1 rewards committing to an answer and invention rate punishes
> committing to the wrong one.

Run it anyway, explicitly, as the **expected-to-lose baseline**. A metric that
only ever sees models that do well on it is not measuring anything. If nano
*doesn't* lose on invention rate, that is a finding about the metric, not about
nano.

**Do not pick a tier from a price table.** N26 measured `gpt-5.6-luna` at 1.87×
nano's cost per call *despite a lower list output price*, because it emitted
2.3× the output tokens on an identical prompt and schema. Dictation's input is
longer prose than a meal description, so the ratio here is unmeasured — treat
every figure as needing its own run.

## The format

```jsonc
{
  "id": "b-compound-three-facts",       // stable; a score attributes to it
  "source": "authored",                  // or "recorded" — see above
  "dictation": "Rolled five rounds, …",  // the input, verbatim
  "why": "The spec's own example. …",    // why this case exists. Required.
  "expect": {
    "kind": null, "gi": null,            // every field explicit: an omitted
    "rounds": 5, "round_minutes": null,  // field and a null field are different
    "session_rpe": null,                 // things to a scorer
    "note": null, "body_note": null,
    "tags": [
      { "category": "submission", "event": "scored",
        "position": "Guard", "technique_id": "armbar-closed-guard", "count": 1 }
    ],
    "unresolved": [                      // optional: phrases correctly left open
      { "phrase": "armbar", "category": "submission", "event": "scored" }
    ]
  },
  "must_not": ["session_rpe", "rounds"]  // fields that must stay empty
}
```

`category` and `position` on a tag carrying a `technique_id` are **derived, not
chosen** — `toCategory()` maps the library's nine categories onto the tag
vocabulary's six, and the tag stores the position *family*. The validator
enforces both, because an expectation that disagrees scores a correct model as
wrong, forever, with nothing else in the repo noticing.

---

## What the validator checks

`pnpm run check:evals` (stdlib-only Python, in `verify` and in CI):

- every `technique_id` exists in the 542-entry catalog;
- every derived `category` and `position` matches what that technique implies;
- categories, events, kinds and positions are in the real vocabularies;
- counts are positive, `session_rpe` is 1–10;
- ids are unique and every case explains itself;
- `POSITIONS` in `bjjSession.ts` still agrees with `positions.json` families —
  CLAUDE.md records that list falling behind twice, and `familyOf()` silently
  returns `''` for a family it does not carry.

It proves each case is **writable**. It cannot tell you the corpus is any good.

## What does not exist yet

- **A scorer.** Nothing runs a model against these; that needs the provider
  decision N33 is blocked on. The metrics above are the specification for it.
- **Any recorded case.**
- **Transcription-error coverage.** Every case starts from clean text, so the
  set is blind to the keyboard mishearing "omoplata".
