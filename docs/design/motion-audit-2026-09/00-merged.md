# VOLA — motion & design audit, merged

Three independent Opus audits (`apple-design`, `improve-animations`,
`find-animation-opportunities`), de-duplicated into one ticketable list.
Source documents: `01-apple-design-audit.md` (967 lines),
`02-improve-animations-audit.md` (1,590), `03-animation-opportunities.md` (354).

Date: 2026-09-09. Base: `main` @ `f00c6a82`.

## How the three overlap

The three audits produced **~50 raw findings** that collapse to **16 units of
work**. The overlap is not redundancy — it is triangulation, and where all three
converged independently the finding is materially stronger than any one document
makes it look.

| Merged unit | apple-design | improve-animations | opportunities | Agreement |
|---|---|---|---|---|
| Press feedback | H1, H2, L1 | H2, H4, L1, L2 | #2 | **all 3** |
| Motion tokens | H2 (partial) | M1 → P1 | Part 0.5 | **all 3** |
| Reanimated installed, unused | H4 | Verdict fact 1 | Verdict | **all 3** |
| Reduced motion (web/admin) | M7 | M2 → P4 | — | 2 |
| Reduced motion (mobile) | §14 | M3, M4 → P6 | Recipe note | 2 |
| MacroRings on JS thread | L2, §11 | H3 → P5 | — | 2 |
| Reorder-drag haptics | H3 | M10, M11 | — | 2 |
| Swipe velocity / rubber-band | M1 | M8, M9 → P6 | — | 2 |
| Sub-44pt targets | H5 | L3 | — | 2 |
| Sheets: hand-rolled Modal | M6 | M16 | — | 2 |
| Admin has no feedback | L4 | L5 | — | 2 |
| Web toggle knob never animates | — | H1 → P3 | — | **1, verified** |
| Hand-rolled toggles teleport | — | M7 → P7 | — | 1 |
| Today-tab arrival continuity | — | — | #1 | 1 |
| Rest-timer arrival / 4Hz bar | M2 | — | #3 | 2 |
| Typography adoption | M5, M8 | — | — | 1 |

## Where they disagree — the one real decision

**New native dependencies.** `apple-design` Top-10 recommends installing
`react-native-gesture-handler` (#5) and `react-native-keyboard-controller` (#9).
`find-animation-opportunities` explicitly forbids the first ("Do not migrate
SwipeToDelete to Reanimated + gesture-handler 'for feel'") and declines the
second. `improve-animations` recorded both as *decisions to surface* rather than
planning them, and did not re-litigate `SwipeToDelete.tsx:24-30`'s own documented
refusal.

**Resolution taken here: do not add either yet.** Both are filed as one decision
ticket, not as implementation tickets. Every other unit below needs **zero** new
dependencies — Reanimated 4.5.1 and worklets are already installed and linked.

## Corrections to the briefing the agents were given

- "13 mobile files use core `Animated`" → **8**. The other five were two test
  files and three comment-only mentions. Re-verified independently.
- "This is an under-animated codebase" → too crude. **13 components already
  animate deliberately** and several are exemplary (`HoldToConfirm`,
  `AnimatedSplash`). The deficit is **continuity, not personality**.

## The merged list

Ordered by leverage. `[Pn]` names the ready-to-execute plan in document 02.

### Foundation — unblocks the rest

**1. Motion token scale** `[P1]` — no duration or easing token exists anywhere;
`design-tokens.json` has `brand, icon, spacing, radius, pillRadius` and nothing
temporal. Extend the **existing** `scripts/generate_design_tokens.mjs` (already
has `--check` in `verify`). Five other units depend on this.

**2. Press feedback** `[P2]` — 411 of 493 `Pressable`s have no press state;
73 of 125 pressable-bearing files have none at all. Includes all 24 controls on
`app/session/[id].tsx`, all 8 in `components/Timer.tsx`, all 16 in
`app/food/add.tsx`. Also folds in: six hand-typed pressed-opacity values across
34 definitions (9 distinct), zero `pressRetentionOffset` app-wide, and
`TrackerCard.tsx:504`'s literal `scale(0)` entrance. **0ms in, 120ms out** — it
is a press state, not an animation.

### Verified defects — small, independent

**3. Web toggle knob has never animated** `[P3]` —
`apps/web/.../settings/page.tsx:109` moves the knob with `ml-0 ↔ ml-4` under
`transition`. Tailwind v4.3.3's property list (extracted from installed
`dist/lib.js`) does not contain `margin`. Swap to `translate-x-*`.

**4. `prefers-reduced-motion` floor for web + admin** `[P4a]` — zero occurrences
in either app against 100 `transition` utilities and 11 infinite `animate-pulse`
loops. One `@media` block per `globals.css`.

**5. Reduced motion on mobile** `[P6a]` — `lib/useReducedMotion.ts` is a
well-built hook with **one** caller. 23 `Stack.Screen` pushes, an 850ms
celebration flare and a ~60/min heart pulse all ignore it. Includes
`AnimatedSplash.tsx:173`'s `Easing.in(Easing.quad)` on the app's first
impression — forbidden outright by both rubrics.

**6. Sub-44pt touch targets** — `Pill.tsx:87` (`hitSlop={6}` on a 27pt chip →
~39pt; the shared component behind every filter chip), `WeekStrip.tsx:133/216`,
`TrainingCalendar.tsx:843`, `Timer.tsx:522`. Add `TOUCH_MIN`/`slopFor` to
`constants/Spacing.ts`.

**7. Three hand-rolled toggles → native `<Switch>`** `[P7]` — `settings.tsx:657`
and `:760`, `(tabs)/workouts.tsx:1308`, `profile/edit.tsx:697` teleport a knob via
`alignSelf: 'flex-end'`. The same app already uses RN's `<Switch>` correctly at
`settings/suggestions.tsx:255`. Zero animation code, zero new deps, in-repo
exemplar.

### Mobile feel — no new dependencies

**8. Food reorder drag: haptics + one clock** — shipped 2 commits ago (N553).
Zero haptics at pickup, boundary crossing or drop; and
`EntryRow.tsx:264`'s `scale: isDragging ? 1.02 : 1` is a plain boolean binding,
so the lift pops instantly and snaps back mid-settle while `lift` is still
springing. Two halves of one gesture on two different clocks.

**9. Swipe velocity handoff + rubber-banding** `[P6b]` — `SwipeToDelete.tsx:130`
and `EntryRow.tsx:192` both settle with `bounciness: 0` and never pass the
release velocity, though `g.vx` is in the handler. `:170` hard-clamps both
boundaries. Note the unit conversion: RN springs integrate in **seconds**,
`gestureState.vx` is px/**ms**.

**10. MacroRings onto the UI thread** `[P5]` — 3+ rings animate
`strokeDashoffset` at `useNativeDriver: false` for 620ms (+380ms delay) on the
landing tab while it is also loading data. `CADisableMinimumFrameDurationOnPhone`
**is** set, so the budget is 8ms, not 16. The flagship "Reanimated installed and
unused" fix.

### Continuity — the deficit the third audit identified

**11. Today + Food tab arrival** — ~8 `Source`-gated blocks flip `null`→content
independently, each shoving the rest down. `FadeIn 160ms` + `LinearTransition
200ms` on siblings. Ship the two together or not at all: the fade alone is
cosmetics over the same jump.

**12. Rest-timer arrival and progress bar** — the log teleports exactly 64pt as
`TIMER_BAR_SPACE` is applied; the bar↔card swap has no bridge; and the progress
bar steps at 4Hz via `setState`, re-rendering the session screen ~360× per rest.
The FLIP recipe here needs a device before anyone believes it.

**13. Web entrance layer** `[P4b]` — two trigger-anchored popovers hard-mount
with no `transform-origin` (the property is set nowhere in either app), the app's
only modal snaps its scrim, 11 skeletons hard-swap to real content, and all 100
`transition` utilities are bare (no duration, no easing → Tailwind's ease-in-out
applied uniformly to entrances where `ease-out` belongs).

### Recorded

**14. Native-dependency decision** — gesture-handler and keyboard-controller.
See the disagreement above. Decision ticket, not implementation.

**15. Typography adoption** — an excellent 7-role scale exists in
`constants/Typography.ts` and is imported by **12 of 179 files**; 1,247 raw
`fontSize` sites across 28 distinct values remain, including `12.5` and `9`.
Large; sequence one screen per ticket.

**16. Admin console interaction feedback** — zero motion of any kind in 31
files; `PublishButton`/`RetireButton`/`ReactivateButton` are irreversible actions
with no state feedback. Lowest priority in the repo.

## Do NOT do these (defended, with reasons)

Carried forward so a later enthusiasm pass cannot undo them:

- **Nothing on the set-logging path may grow a duration.** `session/[id].tsx`
  contains no animation at all and that is the feature. Press feedback (#2) is
  exempt only because it is 0ms in.
- **No motion into or out of the thumb zone during a live session.**
- **No motion that rewards frequency** — a pulsing sync chip or streak glow is
  streak pressure relocated to the motion channel, and would pass a copy review.
- **No `entering` on rows inside the 10 `FlatList` screens** — recycling re-fires
  the entrance on scroll-back.
- **Do not rebuild the tab bar**, add a sliding indicator, or animate between
  tabs. `NativeTabs` is correct and already correct.
- **Do not add real blur to `CardGlass`** — costed and declined for a reason.
- **Do not animate numbers the athlete reads to decide** — no tickers.
- **Do not reopen the no-glow ruling** (asked for twice by the user).
- **Nothing currently animated should be deleted.** All three looked; there is no
  decorative motion on a high-frequency element in this repo.

## Not verified

Nothing was run on a device. Every claim about *feel* — the 4Hz timer stair, the
teleporting keyboard footer, the velocity seam on release, the 620ms ring sweep —
is derived from source and measured values. Tickets touching those carry a
`NEEDS HUMAN EVIDENCE` criterion.
