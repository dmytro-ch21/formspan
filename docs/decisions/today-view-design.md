# The Today screen — a decision surface, not a report

Status: **draft for discussion**, 2026-08-01. This concretizes
[system-design.md §2](system-design.md)'s rule that "the Today screen shows
the state, not a menu of modules" into an actual layout and behavior spec.
The MVP feature list already names Today's ingredients — plan, recovery
status, quick log, one key recommendation, daily message — so this document
is about what makes that screen *earn* a daily open instead of becoming a
dashboard graveyard. Nothing here is built yet.

---

## 1. The job statement, and the filter rule

Today exists to answer **"what should I do in the next 12 hours?" in under
five seconds, with the next action one tap away.**

That yields a hard filter for every element on the screen: **if a number
doesn't change what the athlete does today, it doesn't belong on Today** — it
belongs in the weekly review. Reports look backward; Today looks at the gap
between now and bedtime. Most fitness-app home screens fail exactly here: a
grid of stats you admire and don't act on.

The three dials from system-design §2 (Readiness / Load / Fuel) are the state
this screen renders — the sections below are those dials plus the two things
a dial can't be: the plan and the log entry point.

## 2. Layout, in priority order

1. **Today's plan, with state.** The calendar's sessions for today —
   "Strength AM ✓ done · BJJ 7pm upcoming" — each one tap from starting or
   logging. Empty state is an inviting prompt to plan or quick-log, never a
   guilt-trip zero (the no-shame rule).
2. **Readiness, always paired with its consequence.** The green/yellow/red
   band (or score, with a wearable — see system-design §7's honest-confidence
   rule), but *never* the status alone: status plus what it means for today's
   plan. "Yellow — poor sleep, and tonight's sparring is marked hard.
   Consider fewer hard rounds." A traffic light with no consequence attached
   is decoration; a traffic light that reads your calendar is coaching.
3. **The one recommendation — singular by design.** The rules engine may have
   five things to say; Today shows the highest-priority one, with the why
   (rule id, inputs, plain-language explanation) one tap away, per the
   auditability principle. The cross-sport conflict flag (J6) surfaces here
   on the days it fires — and those are the days the product proves its
   thesis.
4. **Remaining calories and protein.** Not "consumed" — **remaining**.
   Remaining is the number that changes what you order at dinner;
   protein-left-today is probably the single most behavior-changing number on
   the screen. Updates live as meals are logged: the J2 criterion ("the
   screen reflects it immediately") is the reward loop, not a nicety.
5. **Quick log.** One-tap entries for meal / weight / session, and the
   landing target for the post-class notification that opens the BJJ
   reflection wizard ([bjj-tracking-design.md](bjj-tracking-design.md)).
6. **Focus card** (post-MVP, once focus mode exists): the current BJJ focus
   as a walk-in prompt — "Deep half this month: look for entries tonight" —
   and the strength equivalent when one is due ("bench 3×8 @ 80 kg — hit it
   at RPE ≤8 and next session progresses").

## 3. The lead card follows the clock

A static layout means the third open of the day shows nothing new, and the
habit dies. The differentiating behavior is a **presentation rule, not new
data**: the same screen leads with a different card by time of day —

- **Morning:** readiness + today's plan + the recommendation. *What kind of
  day is this?*
- **Pre-session** (the calendar knows class is at 19:00): the focus prompt
  and any conflict or readiness warning. *Walk in knowing what you're working
  on.*
- **Post-session:** "Log your session" front and center — the reflection
  wizard trigger, the make-or-break habit.
- **Evening:** protein/calories remaining + a one-line preview of tomorrow.
  *"Heavy squats AM — tonight's recovery matters."*

This is what makes the app feel like it's paying attention rather than
displaying.

## 4. Why this screen is the moat

Every element above exists somewhere else — MyFitnessPal has macros, WHOOP
has readiness, every strength app has a plan. What no one else has is the
**joins**: one screen holding *hard sparring tonight* + *heavy squats
yesterday* + *yellow recovery* + *45 g protein still to go*, with an
explainable rule connecting them into one suggestion. Today is where the
cross-sport differentiator stops being architecture and becomes something the
athlete sees every day. The conflict flag firing on a Tuesday morning —
"move tonight's hard rounds or lighten this afternoon's leg day, and here's
why" — is the moment a user decides this app knows something the others
don't.

## 5. Deltas against the frozen MVP list

The MVP ingredient list already covers §2 items 1–5. What this document adds:

- **Time-of-day dynamism** (§3) — cheap, MVP-compatible presentation rule.
- **Consequence-paired readiness** (§2.2) — a copy/logic rule, not a feature.
- **Tomorrow preview in the evening state** — one line, one query.
- **Focus card** — post-MVP, arrives with focus mode.

## Open questions

1. **How is "pre/post-session" detected without a started session?** Calendar
   time-windows are enough for scheduled sessions; unscheduled open mats only
   resolve at log time. Suggested: calendar windows only, no inference.
2. **Does the daily message survive the filter rule?** A motivational line
   changes nothing about the day. Suggested: fold it into the recommendation's
   plain-language voice rather than keeping a separate slot.
3. **Widget/watch surfaces** — the morning state (readiness + plan) is
   exactly a home-screen widget; same Expo-Go-exit dependency as everything
   else in that pile.
