---
name: vola-athlete-ux
description: VOLA's product principles for anything an athlete sees — navigation, screen design, copy, charts, logging flows. Use when designing or reviewing a mobile/web screen, writing user-facing copy or notifications, adding a chart or trend, deciding which platform gets a feature, or evaluating whether a change fits the product.
---

These are decided product rules, not taste. Each one names where the decision
lives, because the decision documents are the authority and this skill is the
index. When a rule here seems to conflict with what you're building, the move
is to surface the conflict — not to quietly pick either side.

## The platform test (hard rule, set by the user 2026-08-19)

**Mobile first: "can an athlete with only a phone do this at all?"** If no,
build the phone version — however reduced — before or alongside web. Web is
the complementary surface where some things get *richer* (deep analysis, wide
tables, bulk authoring), never the only place something is *possible*. The
canonical failure this forbids: a target's derivation visible on the phone
with no way to disagree with it, because manual entry existed only on web.
Full statement and history: CLAUDE.md "Which platform gets a feature".

## Navigation: the bar spells the athlete's loop

**Today · Train · Progress · Plan · You** — approved primary navigation
(N176). `apps/mobile/lib/tabs.ts` is the source of truth, and its doc comment
carries the full reasoning, including what the old bar got right. Two rules
travel with it:

- **Nothing hides.** A route may lose its button, never its reachability —
  off-bar routes stay declared with `href: null`. A conditional tab is a
  decision to re-argue, not a convenience: hiding tabs on module state once
  made an athlete report present features as "not there".
- **Don't add a sixth tab to settle a placement argument.** Where nutrition
  lives is N180's question; splitting the difference with an extra slot is
  the specific thing that ticket exists to prevent.

## No shame, structurally (explicit constraint from the original brief)

No guilt framing, no body shaming, no pressure to train through injury, no
dangerous calorie encouragement — in copy, notifications, and *mechanics*:

- **No day streaks.** A missed day must not read as a loss, and a streak that
  a rest day can break rewards logging a fake day to save it
  (`docs/decisions/nutrition-design.md` §5, by name). The shipped substitutes
  are "N of 7 days logged" counts and a WEEK-based streak, chosen precisely
  so rest cannot break it.
- Rest is not failure. A deload or a skipped session is information, not a
  lapse to apologize for.

## Charts on mobile: one question, three seconds

A small read-only chart may live on mobile only when it answers ONE question
whose decision is made away from a computer, and the comparable/exportable
version still lives on web. Value-readable axes, point labels, preset windows
that all END TODAY, a dashed projection — all allowed (a chart you cannot
read a number off answers nothing). **What disqualifies it**: a second
metric, or a date-range picker (choosing a start AND an end is comparison,
and comparison is the web screen's job). Full text with amendments: CLAUDE.md
"Which platform gets a feature" carve-out.

## Logging speed floors

- **Strength**: recorded standing up, one-handed, in the ~20 seconds between
  sets. Anything added to the set-logging path is measured against that.
- **BJJ**: lightweight and optional — a three-tap floor for logging a
  session; reflection is invited, never required.
- **Nutrition**: highest-frequency logging in the app (3–6×/day); whatever
  home it gets must keep one-tap access from wherever the athlete already is.
- **In-workout affordances belong to the phone.** A rest countdown on a
  desktop is decoration; web may start/review/correct sessions but doesn't
  get mid-set chrome.

## Meaning before data

Today is a decision surface, not a report — it answers "what matters now",
not "here is everything we stored". Interpretation ranks above raw numbers —
"interpretation before raw data" is the decided brief for the Progress tab
(N178). Two cards answering one question with different arithmetic is a
known defect shape (W2/W4): replace, don't add.

## Visual personality (so screens don't drift generic)

Confident, focused, athletic, premium without effects; dark-mode-first on
mobile; large one-handed controls, accessible contrast and touch targets.
Avoid crowded dashboards, gradient soup, streak pressure, and generic
AI-dashboard appearance. Tokens and brand: the `vola-design-system` skill.

## Not covered here, and where it lives

- Colors, tokens, icons, typography: `vola-design-system` skill.
- Offline behavior an athlete experiences (dead spots, sign-out blips):
  `vola-offline-sync` skill.
- What no test can reach and needs a device: `docs/testing/device-checks.md`.
