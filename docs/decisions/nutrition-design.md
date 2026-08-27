# Nutrition — the design

Status: **backend landed (N24), clients in progress.** This document is the
forward-looking half. What was built and why it is shaped that way is in
[history.md](history.md)'s 2026-08-18 entry; the wire contract is in
[public.openapi.yaml](../../contracts/public.openapi.yaml). This file is for the
decisions that govern what comes next, so they are argued once rather than in
each PR.

---

## 1. The job statement

Nutrition exists to answer one question, several times a day: **what do I eat
next?**

That yields the same filter [today-view-design.md](today-view-design.md) §1
applies to Today: if a number does not change what the athlete does in the next
few hours, it does not belong on the phone. It belongs in the weekly review,
which is web's job.

Two numbers answer the question — **remaining calories** and **remaining
protein** — and the design doc already called the second one "probably the
single most behavior-changing number on the screen." Everything else is
supporting detail.

## 2. Remaining, never consumed

A consumed figure is a report. A remaining figure is a decision: it is what
changes what you order at dinner. The Today card and the day screen both lead
with remaining, and "eaten" appears once, muted, as context.

Over target reads `240 over` in muted text, **never in `danger`**. One day over
is not an error state, and a state colour spent here is a state colour that
means nothing when something is actually wrong.

## 3. Training does not give calories back

The reference apps credit exercise to the day's budget. VOLA does not, for three
reasons that compound:

1. **It double-counts.** The target is derived from a TDEE that already includes
   a 28-day training average, and the phase's rate band already assumes a
   training week.
2. **It makes the feedback loop unreadable.** `weeklyRate` and `judgeRate` are
   how an athlete learns whether the phase is working. Once the target moves
   daily you can no longer tell a bad week of eating from a moved goalpost.
3. **It is the wrong behavioural nudge.** A hard session becoming permission to
   eat is the mechanism by which cuts fail in the population this app is for.

What ships instead is one row on the day screen — `Trained today · BJJ 62 min ·
≈430 kcal` — **stated, not spent**, with the remaining figures above it
invariant under it. Tapping it explains why it is not added. That is a number
you can argue with; a silently adjusted budget is not.

A test asserts `remaining` is invariant under a logged session, because this is
a one-line change away at any point and no other test would catch it.

## 4. Where each surface lives

The platform rule in [CLAUDE.md](../../CLAUDE.md) applies unchanged: **mobile
logs, web authors and analyses.**

| | Mobile | Web |
|---|---|---|
| Log an item, edit an entry | ✅ | ✅ (correcting a past day is desk work) |
| Save a food from what you just ate | ✅ | ✅ |
| Build a recipe from scratch | ✅ | ✅ |
| Set / explain the target | ✅ | ✅ |
| Correct or remove a PAST target | ✅ | partly — the list is inert; no delete anywhere |
| Intake vs weight vs training load | ✅ (reduced) | ✅ |

**Three of those rows read `✗` or `read-only` until 2026-08-21**, and two
separate tickets corrected them on the **exclusivity**, not on the design.

**The target rows (N72, then N86).** N72 gave the phone manual entry and N86 gave
it the record — history, editing a past row, removing one, and filing a target
for a day already gone. The split this table describes is still the right
description of where each surface is strongest, and web's version may still be
richer. It may not be the only one. Web's own half is now the weaker one — its
history list is inert and neither surface offered deletion before the phone did.

**The analytical row (N84, #418).** "Intake vs weight vs training load" was
`✗ mobile / ✅ web`, the exact shape the mobile-first rule forbids. The phone's
version is genuinely and deliberately smaller — the web page is a THREE-way
join (intake, bodyweight, training load, four stat tiles) and CLAUDE.md's
mobile-chart carve-out reserves exactly that shape for web: a second charted
metric disqualifies a mobile chart. `app/goals/nutritionTrend.tsx` answers the
one question that is decision support rather than analysis — "is my eating
tracking the target I set" — as a single 7-day-mean line against a dashed
target reference, with an adherence readout and the days behind it. Bodyweight
and training load are not on the phone and are not a step toward putting them
there; asking "did the week I ate least happen to be the week I trained
hardest" stays a desk question. See `lib/nutritionTrend.ts`'s own note for the
full carve-out argument.

**The recipe row (N87, #529).** "Build a recipe from scratch" was `✗ mobile /
✅ web`, which the mobile-first rule in `CLAUDE.md` forbids. The phone can now
build and correct one, and the rest of that row's reasoning survives — a
two-pane builder with the catalog always visible is still better with a
keyboard. What changed is that the phone's version is not smaller in the way
that was assumed: `apps/web`'s editor composes an ingredient by typing five
macro numbers by hand, because it predates the food catalog, while the phone's
searches 12,651 foods and weighs a portion. Making web's the richer of the two
is now a web ticket, not a mobile one.

**Editing a recipe does not rewrite meals already logged from it.** They keep the
numbers they were logged with; the edit changes what the next portion logs. Same
rule as `nutrition_entries` and `nutrition_targets` — see the N87 entry in
`history.md` for the two alternatives that were refused.

**Mobile gets no chart.** Each candidate was tested against the N5 carve-out and
each fails on its own terms: 7-day calorie bars fail "the decision is made away
from a desk"; 7-day protein bars fail that *and* inform nothing the remaining
number leaves open; intake-vs-weight fails "one question" outright.
`checkin/trend.tsx` stays the carve-out's only instance.

The in-day progress bar is **not** a chart — no time axis, no history, one
quantity against one target — and that is written on the component so nobody
later cites it as precedent.

## 5. What the reference apps do that we deliberately do not

Reviewed against a full walkthrough of Lose It!'s onboarding and logging:

- **Per-meal calorie allocation** ("536 calories now available for breakfast").
  False precision: it requires knowing a day the app cannot see, it is wrong the
  moment you eat a big lunch, and it manufactures four budgets to fail against
  instead of one honest running total. The *slots* stay — they are how people
  remember food and they make a twenty-row day scannable — but there is one
  remaining figure.
- **Streaks and a "Done Logging" toggle.** A missed day becomes a loss, and a
  streak rewards logging a fake day to save it. Against the no-shame rule, and
  the app should not ask for a declaration about its own use.
- **Six stacked ring-and-bar cards.** The dashboard graveyard Today's design doc
  exists to prevent.
- **A Health grid** (weight / water / body fat / steps / sleep / glucose).
  Weight already lives on the check-in card, and a second field for one number
  is a second source of truth. The other five have nothing behind them, and
  showing fields with no system behind them is the mistake `apps/admin`
  explicitly avoids.
- **A twenty-screen onboarding.** Most of it is already answered better:
  `body_phases` carries the goal, the pace and the deadline; `settings/units`
  owns units. What survives is one web screen with three sections — the computed
  target with every input editable, a protein target stated in **g/kg** so it is
  arguable, and a "does this look right?" confirmation showing when the phase's
  target weight is reached at its own rate. That last one catches an impossible
  goal before six weeks of failing at it.
- **A nutrition-strategy quiz.** A quiz exists to make the user feel they chose.
  VOLA's posture is to state the rule and let them override the number.

**A target is not required to log food.** Logging without one shows eaten totals
and no remaining — a useful state, and one that stops the feature being gated
behind homework.

## 6. Describe it or photograph it (N26)

The highest-leverage piece, and the reason no food database is scheduled.

An athlete types "two eggs, sourdough and butter" — or photographs the plate —
and gets a **draft they correct**. Nothing reaches the log until they confirm.

- **Server-side only.** The key never enters an app bundle, there is one place
  to meter and cache, and the provider can change without an app release.
- **Structured output against a JSON schema**, with a per-item
  `portion_confidence` and a free-text assumption. Portion size from a photo is
  genuinely unreliable; the schema has to let the model say so and the UI has to
  show it. Low confidence pre-focuses the quantity field.
- **Text first.** It covers most logging at a fraction of the cost — no image
  tokens at all — and the photo path is an addition, not the feature.
- **A per-user quota**, because this is the one endpoint in the app where a loop
  costs real money.
- **An explicit disclosure** that a photo leaves the device, in the UI rather
  than only in a privacy page.

### Why this unschedules the food database

The instruction was to validate manual logging before committing to a commercial
food database. That applies with more force here, because **AI estimation is a
substitute for a food database, not a complement.** If describing a meal in a
sentence works well, USDA search and barcode scanning lose most of their value.

So the intended order — USDA (CC0, no obligations) then Open Food Facts (ODbL,
share-alike, must stay separable from data we authored) — is recorded but not
scheduled. `nutrition_foods` carries `source` and `external_id` from day one, so
adopting either later costs no migration.

## 7. The destination: one strategy across three disciplines

Deliberately not built, recorded so the schema does not foreclose it.

Once targets and intake sit alongside sessions and check-ins, the thing no
competitor can do is **training-day / rest-day calorie cycling read off the
actual calendar** — the same weekly total, higher on BJJ and lift days, lower on
rest days. The reference apps pick high days by weekday preference; VOLA knows
when you train.

It is out of phase one for a specific reason rather than scope: it makes the
day's target a function of the plan, so editing Tuesday's plan retroactively
changes the remaining figure for a day already eaten. That needs a decided rule
— freeze at first log, or recompute — and the rule deserves its own PR.

**The one forward-compatibility decision phase one had to get right** is already
in the contract: the target arrives from `/nutrition/days` **per day**, never as
a weekly total the client divides. Get that wrong and cycling becomes a client
rewrite instead of a server change.

The second half is the cross-sport conflict flag: a hard cut during a
competition camp is the case where the three disciplines genuinely have to
disagree with each other, and it is the day this product proves its thesis.

## 8. The weekly adjustment (N27)

Deterministic and explainable — "evidence-based rules before AI." Compare the
observed 7-day trend-weight change against the phase's target rate; propose a
kcal delta.

`kcalPerKG = 7700` overestimates long-run loss because it ignores adaptive
thermogenesis, so a target drifts optimistic over a phase. **That is why this
rule exists rather than being a refinement** — the correction comes from what
actually happened to the athlete's weight, not from a better constant.

The guards are the whole feature: ≥10 of 14 days logged (adherence computed as a
**query**, never a stored counter), ≥4 weigh-ins in each half, ≥14 days on the
current target, a 0.25%/week deadband, and a step capped at min(10%, 250 kcal).
Always a proposal, accepted with a tap, with the arithmetic shown. Never a
silent auto-apply, and no cron — this repo has none and this must not introduce
one.
