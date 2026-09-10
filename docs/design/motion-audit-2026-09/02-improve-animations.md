# VOLA — Motion Audit

- **Commit**: `f00c6a82`
- **Date**: 2026-09-09
- **Scope**: `apps/mobile`, `apps/web`, `apps/admin`
- **Method**: `improve-animations` (SKILL.md → AUDIT.md → PLAN-TEMPLATE.md), judged against
  `review-animations/STANDARDS.md` and `animate-expo/SKILL.md` + `RECIPES.md`
- **Posture**: read-only. No source file was modified. Every finding was re-verified at its
  `file:line` by me after the fan-out subagents reported.

---

## Verdict

**VOLA has motion craft but no motion system.** The handful of animations that exist are, with
two exceptions, better than average — `HoldToConfirm` and `AnimatedSplash` are genuinely
well-built, and the restraint on the set-logging path is exactly right. But that craft lives in
8 files out of 224 on mobile, it is invisible to the other 216, and there is nothing that
encodes it — no duration scale, no easing curve, no shared press primitive. So each new screen
re-derives motion from scratch, and 73 of 125 pressable-bearing files derived "nothing."

Three facts define the state of it:

**1. The engine is installed and switched off.** `react-native-reanimated@4.5.1` and
`react-native-worklets@0.10.1` are both in `apps/mobile/package.json` and both installed. The
entire app's use of them is one bare side-effect import:

```js
// apps/mobile/app/_layout.tsx:30
import 'react-native-reanimated';
```

Zero `useSharedValue`, zero `useAnimatedStyle`, zero worklets, zero layout animations, zero CSS
transitions. Every animation in the app runs on React Native's core `Animated` — the JS-thread
driver — and `CADisableMinimumFrameDurationOnPhone` **is** set in the generated
`apps/mobile/ios/VOLA/Info.plist:5`, so on the 16 Pro Max this project targets the frame budget
is **8ms, not 16**. That halves the headroom for every JS-thread animation in the list below.
The New Architecture requirement Reanimated 4 carries is already met (RN 0.86 / Expo SDK 57).

**2. On web, the one piece of motion somebody deliberately designed has never run.** The
discipline toggle in `apps/web/src/app/dashboard/settings/page.tsx:109` moves its knob with
`ml-0 ↔ ml-4` under a `transition` class. I extracted Tailwind v4.3.3's actual property list
from the installed `dist/lib.js`: it is 22 named properties and **`margin` is not one of them**.
The knob teleports, and has always teleported. Everything else on web is 100 bare `transition`
utilities across 32 files, none of which names a duration or an easing — so the whole app runs
on `150ms cubic-bezier(0.4, 0, 0.2, 1)`, an ease-**in**-out applied uniformly to entrances where
`ease-out` belongs.

**3. Accessibility is a well-built hook with one caller.** `apps/mobile/lib/useReducedMotion.ts`
is excellent — it handles the `null` "OS hasn't answered" state, it subscribes to changes, it
resolves the initial-read-vs-event race. It is imported by exactly **one** component
(`MacroRings`). The splash implements the same logic inline. Screen transitions, the session
celebration, the live heart-rate pulse, 18 `Modal` sheets and all 23 `Stack.Screen` pushes ignore
Reduce Motion entirely. On web and admin the string `prefers-reduced-motion` does not appear at
all (`grep` → exit 1, both apps, `.tsx` + `.css` + `.ts`).

**What is already right, and should not be touched.** The set-logging path
(`apps/mobile/app/session/[id].tsx`) contains no animation whatsoever and uses haptics as its
feedback channel — that is the correct call and the "Do not animate" section below defends it.
The tab bar is `NativeTabs`, so tab switches never slide. Sheets use `Modal
presentationStyle="pageSheet"`, which is the real iOS sheet. There are zero `TouchableOpacity`,
zero `LayoutAnimation`, zero `requestAnimationFrame` motion loops, and zero `transition-all` in
the entire repo. All 13 haptic call sites obey the one-per-action / never-the-only-feedback
rules. `HoldToConfirm` is a textbook implementation of asymmetric timing and belongs in the plans
below as the exemplar other work should imitate.

**Correction to the brief.** The recon supplied to me said 13 mobile files use core `Animated`.
Verified count is **8**: `TrackerCard`, `HoldToConfirm`, `AnimatedSplash`, `SwipeToDelete`,
`SessionCelebration`, `food/EntryRow`, `LiveHRIndicator`, `today/MacroRings`. The other five hits
were two test files and three files (`ScreenHeader`, `TrackerList`, `app/(tabs)/index.tsx`) that
only mention `Animated` in comments. So the animated surface is even smaller than reported.

---

## Findings

Ordered by leverage (impact ÷ effort). `P#` in the last column names the plan that fixes it;
`—` means it is recorded but not planned.

### HIGH

| # | Category | Location | Finding | Fix summary | Plan |
|---|---|---|---|---|---|
| H1 | 5 Performance | `apps/web/src/app/dashboard/settings/page.tsx:109-111` | The toggle knob is moved with `ml-0 ↔ ml-4` under a bare `transition`. `margin` is not in Tailwind v4's transition property list (verified against installed `dist/lib.js`), so **it has never animated** — and it is a layout property besides. | `translate-x-0 ↔ translate-x-4` (`translate` *is* in the list), `duration-150 ease-out`. | **P3** |
| H2 | 1 Purpose / 7 Cohesion | `apps/mobile/components/ui/Button.tsx:156` + 493 `<Pressable>` sites | `pressed: { opacity: 0.85 }` — an instantaneous opacity step, the app's only press feedback, and **73 of 125 pressable-bearing files have none at all**. There is no hover on a phone; press is the entire feedback channel for an athlete with wet hands. | `scale: 0.97` over 120ms via a Reanimated CSS transition on the shared `Button`; then the same pattern outward. | **P2** |
| H3 | 5 Performance | `apps/mobile/components/today/MacroRings.tsx:153-173` | Three-plus rings, each with N ramp arcs, animate `strokeDashoffset` at `useNativeDriver: false` for 620ms (+380ms delay) **on the Today tab** — the app's landing screen, while it is also loading data. Every frame is interpolated on the JS thread at an 8ms budget. | Move to Reanimated `useAnimatedProps` on `react-native-svg` (Reanimated 4.5.1 devDepends on svg 15.15.4 — the exact version installed). | **P5** |
| H4 | 3 Physicality | `apps/mobile/components/TrackerCard.tsx:504-509` | The tracker glyph fill binds `scaleY` directly to a value that starts at 0 — a literal `scale(0)` entrance, on a control the file's own comment says "can be tapped four times in a second". It also uses a bouncy `friction: 7` spring on that tap. | Interpolate to `[0.9, 1]` for scale, keep `opacity` `[0, 1]`; replace the spring with a 140ms `Easing.bezier(0.23, 1, 0.32, 1)` timing. | **P2** |
| H5 | 4 Interruptibility / 5 Perf | `apps/mobile/components/KeyboardAwareScroll.tsx:677-686` | `Keyboard.addListener` → `measureInWindow` → `setInset` → `paddingBottom`. Driven by a JS event that arrives *after* the keyboard has begun moving, applied to a **layout** property, with **no transition at all** — the footer snaps to its end position in one frame while the keyboard slides for ~250ms behind it. **42 files import this**, including the weight/reps entry on the logging path. | `react-native-keyboard-controller`'s `useReanimatedKeyboardAnimation`. **This is a new native dependency** — see "Decisions to surface" below. | — |
| H6 | 8 Missed opp. | `apps/mobile/components/TrainingCalendar.tsx:378-380` | `{expanded && (<RNView style={styles.dayList}>` — seven day rows appear at once and everything below jumps by their combined height, with nothing explaining the change. | Reanimated `entering`/`exiting` on the container (opacity only; do **not** animate height). | — |

### MEDIUM

| # | Category | Location | Finding | Fix summary | Plan |
|---|---|---|---|---|---|
| M1 | 7 Cohesion / 2 Easing | repo-wide | **No motion tokens exist anywhere.** `assets/brand/design-tokens.json` has `brand, icon, spacing, radius, pillRadius` and nothing temporal. A design system rigorous enough to argue ΔE under deuteranopia in a CSS comment has no opinion at all about how anything moves. | Add a `motion` key to the brand kit and extend the **existing** `scripts/generate_design_tokens.mjs` (which already has a `--check` wired into `verify`). | **P1** |
| M2 | 6 Accessibility | `apps/web/**`, `apps/admin/**` | `grep -rn "prefers-reduced-motion\|motion-reduce\|motion-safe" apps/web apps/admin` → **exit 1**. Zero handling in either app, including both `globals.css` files. | One `@media (prefers-reduced-motion: reduce)` block per app's `globals.css`. | **P4** |
| M3 | 6 Accessibility | `apps/mobile/app/_layout.tsx:349-357`; `components/SessionCelebration.tsx:71-76`; `components/LiveHRIndicator.tsx:48-52` | `useReducedMotion` has **one** consumer app-wide. 23 `<Stack.Screen>` pushes, an 850ms full-screen celebration flare, and a heart icon that pulses ~60×/minute for the length of a workout all ignore Reduce Motion. `grep -rn "animation:" apps/mobile/app` → 0. | Branch `screenOptions.animation` to `'fade'`; gate the flare and the pulse on the hook. | **P6** |
| M4 | 2 Easing | `apps/mobile/components/AnimatedSplash.tsx:173` | `easing: Easing.in(Easing.quad)` on the splash **fade-out** — the app's first impression. `ease-in` starts slow, holding the splash at full opacity precisely while the user is waiting for the app. AUDIT.md §2 and animate-expo's "Never Ship" table both forbid `Easing.in(...)` on UI outright. | `Easing.bezier(0.23, 1, 0.32, 1)`. One line. | **P6** |
| M5 | 3 Physicality | `apps/web/src/components/ShareToFriend.tsx:180-182`; `apps/web/src/app/dashboard/sessions/page.tsx:677` | Two trigger-anchored popovers (`absolute right-0`, `role="dialog"` / `aria-haspopup`) hard-mount under `{open && (` with no transform, no transition and no `transform-origin`. `grep -rn "origin-" apps/web/src apps/admin/src` → exit 1: the property is set nowhere in either app. | `transform-origin: top right`, `scale(0.96) → 1` + opacity, 180ms `--ease-out`. | **P4** |
| M6 | 8 Missed opp. | `apps/web/src/app/dashboard/workouts/page.tsx:320` | The app's only true modal — 40 lines of comment about pointerdown semantics and keyboard viewports — appears with a `bg-black/70` scrim that snaps in with **no motion at all**. AUDIT.md §1 puts modals in "occasional → standard animation". | Backdrop opacity fade + `scale(0.96) → 1` on the dialog, 200ms. `transform-origin: center` is correct here and is **not** a finding. | **P4** |
| M7 | 8 Missed opp. / 7 Cohesion | `apps/mobile/app/settings.tsx:657` + `:760`, `app/(tabs)/workouts.tsx:1308`, `app/profile/edit.tsx:697` | Three hand-rolled toggles teleport their knob via `knobOn: { alignSelf: 'flex-end' }` — a layout property changed with no transition. Meanwhile **the same app already uses RN's native `<Switch>`**, correctly themed, at `app/settings/suggestions.tsx:255-263`. Two different toggles, one app. | Replace the three with `<Switch>`, copying the exemplar's `trackColor`/`thumbColor`. Zero animation code, zero new deps. | **P7** |
| M8 | 4 Interruptibility | `apps/mobile/components/SwipeToDelete.tsx:130-134`; `components/food/EntryRow.tsx:192` | Both drag surfaces settle with `Animated.spring(..., { bounciness: 0 })` and **never pass the release velocity**, though `g.vx`/`g.vy` are right there in the handler. RECIPES.md calls velocity handoff "the single detail that most separates *fluid* from *fine*" — without it there is a visible seam the instant the finger lifts. | Add `velocity: g.vx * 1000` (RN's spring integrates in **seconds** — verified at `react-native/Libraries/Animated/animations/SpringAnimation.js:281` — while `gestureState.vx` is px/**ms**). | **P6** |
| M9 | 4 Interruptibility | `apps/mobile/components/SwipeToDelete.tsx:170` | `translate.setValue(Math.max(-ACTION_WIDTH, Math.min(0, next)))` — a hard clamp at both boundaries. animate-expo's "Never Ship": *hard stop at a boundary → rubber-band resistance*. Real things slow before stopping. | `rubberband()` worklet from RECIPES.md on the over-drag side. | **P6** |
| M10 | 8 Missed opp. | `apps/mobile/components/food/MealCard.tsx:247`, `lib/useEntryDrag.ts` | Press-and-hold-to-reorder (shipped 2 commits ago, N553/#1029) fires **no haptic** on arm or drop. `grep -c 'Haptic'` on both files → 0. The long-press lift is the canonical iOS haptic moment; a row that lifts with no impact reads as lag, not as a lift. | `Haptics.impactAsync(Light)` on arm and on commit, fired in `onPanResponderGrant`/`onPanResponderRelease`, never in `onMove`. | **P6** |
| M11 | 4 Interruptibility | `apps/mobile/components/food/EntryRow.tsx:264` | `transform: [{ translateY: lift }, { scale: isDragging ? 1.02 : 1 }]` — the translate is animated, the scale is a **plain style bound to a boolean**, so the lift pops instantly at drag start and snaps back mid-settle while `lift` is still springing home. Two halves of one gesture on two different clocks. | Drive the scale from the same `Animated.Value`, or a Reanimated CSS transition on `transform`. | **P6** |
| M12 | 5 Performance | `apps/mobile/lib/useEntryDrag.ts:198-204` | `move()` — called from `onPanResponderMove` — calls `setTarget` and `setSlot`. React bails out when the value is unchanged, so this is not literally per-frame; it is one **full re-render of the food day view per slot-boundary crossing**, during a gesture, on the JS thread, competing with `lift.setValue()`. There is no `React.memo` anywhere in `components/food/` (`grep` → 0). | Move the slot decision into a `useAnimatedReaction` threshold, per RECIPES.md's "firing something once at a threshold". Needs a gesture recognizer that runs on the UI thread first — see "Decisions to surface". | — |
| M13 | 2 Easing | 100 sites / 32 files, `apps/web/src` | Every `transition` utility in the app is bare — **zero `duration-*`, zero `ease-*` classes anywhere** (`grep` → exit 1 for both). All of it resolves to Tailwind's `150ms cubic-bezier(0.4, 0, 0.2, 1)`, an ease-in-out. Defensible for the colour hovers; wrong for the `opacity-0 → group-hover:opacity-100` entrances at `dashboard/calendar/page.tsx:889` and `dashboard/workouts/[id]/page.tsx:730`, where §2 requires `ease-out`. | Introduce the tokens (P1), then apply `ease-out` to entrance-shaped transitions only. | **P4** |
| M14 | 6 Accessibility | `apps/web/src/app/dashboard/sessions/TrainingCalendar.tsx:232` | `transition-transform hover:scale-125` on a 12px heatmap cell rendered ~365× per view. This is the **only** transform-on-hover in either web app, and it is both the largest transform present (25%) and ungated — touch fires a false hover on tap. | Gate in `@media (hover: hover) and (pointer: fine)`; reduce to `scale-110`. | **P4** |
| M15 | 8 Missed opp. | `apps/mobile/components/ui/CollapsibleSection.tsx:81`; `components/TrainingCalendar.tsx:373`; `components/WeekPlanner.tsx:475` | Three disclosure chevrons. `TrainingCalendar` and `WeekPlanner` flip a `rotate` transform **instantly**; `CollapsibleSection` swaps one glyph for a different one (`chevron-down` vs `chevron`) — a teleport rather than a rotation. | 150ms Reanimated CSS transition on `transform` for the two that already rotate; make `CollapsibleSection` rotate one glyph instead of swapping two. Cheapest fix in the audit. | — |
| M16 | 8 Missed opp. | `apps/mobile/components/food/EntryMenuSheet.tsx:90`; `app/library.tsx:1312`, `:1452` | Three sheets draw a grabber pill — the platform's universal "drag me down" affordance — inside a plain RN `<Modal>` with no `PanResponder` and no gesture. A false affordance. | Either remove the pill, or adopt `presentation: 'formSheet'` + `sheetGrabberVisible: true`. | — |

### LOW

| # | Category | Location | Finding | Fix summary |
|---|---|---|---|---|
| L1 | 7 Cohesion | 34 definitions, 9 distinct values | Press opacity is hand-typed as `0.3, 0.4, 0.45, 0.5, 0.55, 0.6, 0.7, 0.8, 0.85`. AUDIT.md §7's "five hand-typed cubic-beziers that almost match" defect, in a different property. Verified independently of the subagent: same 9 values, same 34 count. |
| L2 | 3 Physicality | repo-wide mobile | `pressRetentionOffset` appears **zero** times in 493 pressables. animate-expo §7 calls for it so a drifting thumb doesn't cancel an intended press — which is the *defining* condition of this product's stated use (one-handed, standing, mid-workout). |
| L3 | 3 Physicality | `apps/mobile/components/TrainingCalendar.tsx:843` (34×34), `components/Timer.tsx:522` (34×34), `components/today/WeekStrip.tsx:216` (16×16) | Sub-44pt targets with no `hitSlop`. 58 of 125 pressable-bearing files set no `hitSlop` at all. Not motion, but it is the same §7 press contract. |
| L4 | 1 Purpose | `apps/mobile/components/LiveHRIndicator.tsx:45-52` | A `1.0 → 1.28 → 1.0` pulse fires on every BLE sample (~1 Hz, for the length of a workout). The purpose is sound (state indication) and it is native-driven, so I am **not** recommending removal — but 28% is a large amplitude for the app's most persistent motion, and consecutive `Animated.sequence` starts on one value can fight if samples arrive faster than 310ms. Reduce to ~1.15 and cancel the prior sequence. Also: it pulses at a fixed rate while displaying the real BPM. |
| L5 | 7 Cohesion | `apps/admin/**` | Zero motion of any kind in 31 files (`grep -rl "transition\|animate-" apps/admin/src --include="*.tsx"` → 0 files). The `/content` write surface's `PublishButton`/`RetireButton`/`ReactivateButton` are irreversible actions with no state feedback. Lowest priority in the repo, recorded for completeness. |
| L6 | 8 Missed opp. | `apps/web/src/app/dashboard/sessions/page.tsx:874-879` and 4 other sites | 11 `animate-pulse` skeletons hard-swap to real content. The one moment the page animates is the *wait*, and the payoff teleports. Skeleton geometry is already exact (`h-[86px]`), so a 150ms opacity fade on arrival closes it cleanly. |
| L7 | 8 Missed opp. | `apps/mobile/components/Countdown.tsx` | The rest timer — the single thing an athlete looks at most between sets — has **no visual progress indicator at all**, only digits. A glanceable bar would answer "how much left" without reading. Note the correct build: one `Animated.timing` on `scaleX` over the whole rest duration with `useNativeDriver: true`, exactly as `HoldToConfirm` already does it — **not** a per-tick JS animation. |
| L8 | 8 Missed opp. | `apps/web/src/app/dashboard/NavLink.tsx:41-44` | The lime active rule unmounts from one rail item and remounts on another — the one genuinely spatially-connected element in the web app, and it teleports. Deliberately LOW: the nav is hit constantly, so any motion here must be ≤150ms, transform-only, and must never delay the route change. |

### Explicitly clean — checked, and not a finding

Recorded because each is the reflex a reviewer reaches for, and each is wrong here:

- **`transition: all` / `transition-all`** — `grep -rn "transition-all" apps/web/src apps/admin/src` → **exit 1**. Tailwind's bare `transition` is a curated 22-property list, not `all`. There is no §5 `transition: all` defect in this repo.
- **`ease-in` on web** — zero `ease-*` classes of any kind exist (`grep` → exit 1). The `ease-in` problem on web is *implicit*, via Tailwind's default curve (M13), not written anywhere.
- **`scale(0)` on web** — `grep -rn "scale-0\b\|scale(0)"` → exit 1. (Mobile has one: H4.)
- **Framer Motion shorthands / rAF loops / CSS-var-driven child transforms** — no motion library is installed on web; `grep` for `requestAnimationFrame` motion on mobile → 0.
- **`LayoutAnimation`, `setNativeProps`, `TouchableOpacity`, `android_ripple`** — zero occurrences, repo-wide. The `Pressable`-everywhere and no-ripple choices are both correct for a custom-designed app.
- **Tab switches** — `apps/mobile/app/(tabs)/_layout.tsx:2` uses `NativeTabs`. Tabs are peers and do not slide. Correct, do not change.
- **Haptics** — all 13 call sites obey the three absolute rules (one per action, same frame as the visual, never the only feedback). `app/session/[id].tsx:1200-1211` explicitly reasons through the two-buzzes-for-one-event collision. This is the strongest part of the codebase; leave it alone.
- **`transform-origin: center` on the web modal** — AUDIT.md §3 exempts modals. Not reported.
- **`Easing.linear` in `HoldToConfirm.tsx:183`** — correct. §2: constant motion (progress) → `linear`.
- **Reduced motion in `HoldToConfirm`** — deliberately absent and correct. The fill is the only signal of hold progress; Reduce Motion means *fewer and gentler*, not removing comprehension.

---

## Do NOT animate this

The frequency table exists to produce zero lines of code sometimes. These are the places where
motion would become latency, and where a future ticket adding "polish" would be a regression.

1. **The set-logging path — `apps/mobile/app/session/[id].tsx`.** Verified: no `Animated`, no
   Reanimated, no `Easing`, no `duration`. Rep increment, set tick and the Done button are all
   instant, with `Haptics.selectionAsync()` as the feedback (`:1088`, `:1211`, `:1508`). This is
   the 100+/day tier and this is exactly the right answer. **The only motion permitted here is
   H2's ≤150ms press scale**, which the same table explicitly allows as "near-imperceptible."
   Nothing else. No entrance on a new set row, no transition on the rep stepper, no celebration
   on a completed set.

2. **The tab bar.** `NativeTabs` gives the platform's real bar. Do not rebuild it, do not add a
   sliding indicator, do not animate between tabs — they are peers, and sliding implies a
   hierarchy that is not there.

3. **The rest-timer countdown digits — `apps/mobile/components/Countdown.tsx:283`.** The 250ms
   `setInterval` drives a number, not an animation, and that is correct. Do **not** add a
   per-tick transition to the digits; do not animate the number rolling. (L7's progress bar is a
   separate, single, predetermined animation — not a per-tick one.)

4. **The keyboard.** H5's defect is that the footer is driven from JS; the fix is to make it
   *track* the keyboard's real position, not to give the current jump a duration. Adding a
   `withTiming` to `KeyboardAwareScroll` would be strictly worse than the snap it replaces —
   any duration you pick will visibly lag or lead a private system curve.

5. **`ClassPlanTimer.tsx:173`'s 250ms interval.** It re-renders four times a second on the
   between-sets screen. Fine as long as nothing animated is ever attached to it. If motion is
   ever added there, this becomes HIGH.

6. **Nothing currently animated should be deleted.** I looked for it — that is usually the
   strongest finding available — and there is no decorative motion on a high-frequency element
   in this repo. The nearest candidates are `LiveHRIndicator`'s pulse (L4: reduce the amplitude,
   don't remove it — it is legitimate state indication) and the web heatmap's `hover:scale-125`
   (M14: reduce and gate, don't remove — it is the only hover affordance on a 12px target).
   VOLA's problem is under-motion, not over-motion.

---

## Decisions to surface (not planned)

Two findings have fixes that need a new **native** dependency, which in this repo means a native
rebuild and a pass through `scripts/check-native-deps.py` — documented machinery built after
`expo-camera` shipped in the JS bundle and not in the binary, killing Release builds with no
dialog. These are decisions to raise, not lines to commit:

- **H5 (keyboard-following UI)** needs `react-native-keyboard-controller` and a
  `KeyboardProvider` at the root. It is the correct fix and affects 42 files including the
  logging path. It is also the largest single motion improvement available on mobile.
- **M12 / the two `PanResponder` surfaces** need `react-native-gesture-handler` to move the
  recognizer onto the UI thread. Note that `SwipeToDelete.tsx:24-30`'s doc comment already
  weighed and declined this, and its reasoning is accurate — the cost is a fresh native build,
  not "a new dependency." I am **not** re-litigating it. P6 below deliberately takes only the
  parts that need no new dependency at all (velocity handoff, rubber-banding, haptics, reduced
  motion), which are most of the felt improvement.

Reanimated itself needs **no** new native dependency — it is already installed and linked, which
is why P2 and P5 are safe.

---

# Implementation plans

Seven plans. Each is self-contained and executable with no access to the reasoning above.
Recommended order and dependencies are in the README table at the end.

---

## P1 — Give the repo a motion token scale

- **Status**: TODO
- **Commit**: `f00c6a82`
- **Severity**: MEDIUM (but a hard prerequisite for P2, P3, P4, P5, P6)
- **Category**: 7 — Cohesion & tokens
- **Estimated scope**: 4 files, ~80 lines

### Problem

No duration or easing value in this repo is named. `assets/brand/design-tokens.json` contains
exactly five top-level keys and none is temporal:

```json
["brand", "icon", "spacing", "radius", "pillRadius"]
```

On web, every one of 100 `transition` utilities across 32 files is bare — `grep -rn "duration-[0-9]" apps/web/src`
and `grep -rn "ease-in\|ease-out\|ease-linear" apps/web/src` both exit 1. On mobile, each
animation hand-types its own number: `620` in `MacroRings.tsx:156`, `140` in
`HoldToConfirm.tsx:155`, `90`/`220` in `LiveHRIndicator.tsx:49-50`, `850` in
`SessionCelebration.tsx:52`.

`CLAUDE.md`'s design-system rule is that facts about the brand live in exactly one file each and
code references them. Motion is such a fact and currently has no file.

### Target

Add a `motion` key to the brand kit, and extend the **existing** generator so both platforms read
from it. Exact values, taken from `AUDIT.md` §2 — do not approximate any of these:

```json
// assets/brand/design-tokens.json — add this key, leave the other five untouched
"motion": {
  "duration": { "press": 120, "control": 180, "surface": 240, "sheet": 320 },
  "easing": {
    "out":    [0.23, 1, 0.32, 1],
    "inOut":  [0.77, 0, 0.175, 1],
    "sheet":  [0.32, 0.72, 0, 1]
  }
}
```

Duration names map to `AUDIT.md` §2's budget table: `press` = button press feedback (100–160ms),
`control` = tooltips/toggles/small state changes (125–200ms), `surface` = dropdowns/popovers
(150–250ms), `sheet` = modals/drawers (200–500ms). **There is no duration above 320ms in this
scale, deliberately** — UI animations stay under 300ms and `sheet` is the one sanctioned
exception.

Generated mobile output, appended to `apps/mobile/constants/designTokens.generated.ts`:

```ts
export const DURATION = {"press":120,"control":180,"surface":240,"sheet":320} as const;
export const EASING_BEZIER = {"out":[0.23,1,0.32,1],"inOut":[0.77,0,0.175,1],"sheet":[0.32,0.72,0,1]} as const;
```

A new hand-written `apps/mobile/constants/Motion.ts` names them (this is where doc comments go —
the generated file is raw numbers only, exactly as its own banner says):

```ts
import { Easing } from 'react-native';
import { DURATION, EASING_BEZIER } from '@/constants/designTokens.generated';

/** Durations in ms. `press` is the ceiling for anything touched many times a day. */
export const MS = DURATION;

/**
 * The three curves. `Easing.bezier` because React Native's built-in `Easing.out`/
 * `Easing.quad` family is as weak as CSS's — these are the strong forms.
 *
 * There is deliberately no `in` curve: `ease-in` starts slow, delaying the exact
 * moment the user is watching, and is never correct on UI.
 */
export const EASE = {
  out: Easing.bezier(...EASING_BEZIER.out),
  inOut: Easing.bezier(...EASING_BEZIER.inOut),
  sheet: Easing.bezier(...EASING_BEZIER.sheet),
} as const;

/** The one press-feedback scale. Subtle on purpose — 0.95–0.98 is the band. */
export const PRESS_SCALE = 0.97;
```

Generated web output, a new file `apps/web/src/app/motion.generated.css`:

```css
/* GENERATED by scripts/generate_design_tokens.mjs — do not edit. */
:root {
  --duration-press: 120ms;
  --duration-control: 180ms;
  --duration-surface: 240ms;
  --duration-sheet: 320ms;
  --ease-out: cubic-bezier(0.23, 1, 0.32, 1);
  --ease-in-out: cubic-bezier(0.77, 0, 0.175, 1);
  --ease-sheet: cubic-bezier(0.32, 0.72, 0, 1);
}
```

### Repo conventions to follow

- **The generator already exists and already has a `--check` in `verify`.** Read
  `scripts/generate_design_tokens.mjs` in full before editing — its doc comment (lines 2–35)
  explains why a generated `.ts` file exists rather than importing the JSON directly (Metro's
  watch roots do not reach `assets/brand/`). That reasoning applies unchanged to the new keys.
- `package.json`'s `check:design-tokens` script runs `node scripts/generate_design_tokens.mjs --check`
  and is already in the `verify` chain — **you do not need to add a new check**, and you must not
  remove any existing link from that chain (`check:verify-chain` will fail you).
- The generated file's banner says "Raw numbers only — `constants/Spacing.ts` and
  `constants/Typography.ts` are where these get names and doc comments." `constants/Motion.ts` is
  the third file of that kind. Read `apps/mobile/constants/Spacing.ts` and imitate its shape.
- Web CSS custom properties live in `apps/web/src/app/globals.css` under `:root` (see `--c-bg` at
  line 35). The generated file must be `@import`ed at the very top of `globals.css`, before any
  other rule.

### Steps

1. Add the `motion` key above to `assets/brand/design-tokens.json`. Do not reorder or modify
   `brand`, `icon`, `spacing`, `radius`, or `pillRadius`.
2. In `scripts/generate_design_tokens.mjs`, add `'motion'` to the required-key loop at line 46.
3. In the same file, append to the `body` template literal (after the `PILL_RADIUS` line):
   ```js
   export const DURATION = ${JSON.stringify(tokens.motion.duration)} as const;
   export const EASING_BEZIER = ${JSON.stringify(tokens.motion.easing)} as const;
   ```
4. In the same file, add a **second** output. Define `const OUT_CSS = join(root, 'apps/web/src/app/motion.generated.css');`
   next to the existing `OUT`, build the CSS string shown in Target above from
   `tokens.motion`, and make **both** the `--check` branch and the write branch handle both
   files — `--check` must compare both and exit 1 if either is stale, naming which one.
5. Create `apps/mobile/constants/Motion.ts` with the exact contents shown in Target.
6. Add `@import "./motion.generated.css";` as the **first line** of
   `apps/web/src/app/globals.css`.
7. Run `node scripts/generate_design_tokens.mjs` to write both generated files. Commit them —
   they are checked in (`apps/mobile/constants/designTokens.generated.ts` already is).

### Boundaries

- Do **NOT** change any existing value in `design-tokens.json`.
- Do **NOT** apply the tokens to any component in this plan. This plan only creates them; P2–P6
  consume them. A diff that also edits a component is out of scope.
- Do **NOT** add a new script to `package.json`'s `verify` chain — `check:design-tokens` already
  covers this. Removing or reordering a link there will fail `check:verify-chain`.
- Do **NOT** hand-edit either generated file. If it is wrong, fix the generator and re-run.
- Do NOT add any new dependency.
- If `scripts/generate_design_tokens.mjs` does not match the structure described (drift since
  `f00c6a82`), STOP and report rather than improvising.

### Verification

- **Mechanical**:
  - `node scripts/generate_design_tokens.mjs --check` → prints up-to-date, exit 0.
  - **Then mutation-check it, because a check that cannot fail proves nothing**: change
    `"press": 120` to `"press": 121` in `design-tokens.json`, re-run `--check`, and confirm it
    exits **1** and names the stale file. Revert.
  - `pnpm run typecheck:mobile` → passes (confirms `Motion.ts` compiles and `Easing.bezier(...EASING_BEZIER.out)`
    spreads correctly against a `readonly` tuple; if TS complains about the spread arity, the
    `as const` on `EASING_BEZIER` is what makes it a fixed-length tuple — do not fix it by
    widening the type).
  - `pnpm run build:web` → passes (confirms the `@import` resolves).
- **Feel check**: none — this plan renders nothing.
- **Done when**: both generated files exist, `--check` passes, `--check` has been *observed to
  fail* on a deliberate mutation, and no component file appears in the diff.

---

## P2 — Give every pressable real press feedback

- **Status**: TODO
- **Commit**: `f00c6a82`
- **Severity**: HIGH
- **Category**: 1 — Purpose & frequency / 3 — Physicality
- **Depends on**: P1
- **Estimated scope**: 3 files, ~60 lines

### Problem

There is no hover on a phone. Press is the entire feedback channel, and this app is used
one-handed, standing, with sweaty hands, between sets. Today:

```js
// apps/mobile/components/ui/Button.tsx:156 — current
  pressed: { opacity: 0.85 },
```

That is an instantaneous opacity step, and it is the *best* case. Measured at `f00c6a82`:

```
$ grep -rl "<Pressable" app components --include="*.tsx" | grep -v __tests__ | wc -l   # 125
$ grep -rn "<Pressable" app components --include="*.tsx" | grep -v __tests__ | wc -l   # 493
$ pressRetentionOffset                                                                  # 0 occurrences
```

**73 of those 125 files have no `pressed` branch at all** — including `app/sign-in.tsx:233`
(the app's first tap), `app/food/scan.tsx:492`, and `components/food/AmountSheet.tsx:79`.

Separately, the tracker glyph — a control the file's own comment says "can be tapped four times
in a second" — animates from `scale(0)`:

```jsx
// apps/mobile/components/TrackerCard.tsx:504-509 — current
  style={[styles.glyphFill, {
    backgroundColor: fill, margin: inset,
    borderRadius: Math.max(1, size / 3 - inset),
    opacity: t,
    transform: [{ scaleY: t }],   // t starts at 0 → scaleY(0)
  }]}
```

```js
// apps/mobile/components/TrackerCard.tsx:470-474 — current
    Animated.spring(t, {
      toValue: filled ? 1 : 0,
      useNativeDriver: true,
      friction: 7,
      tension: 90,
    }).start();
```

`friction: 7` is a bouncy spring. Overshoot on a logging tap repeated four times a second is
motion becoming latency. And nothing in the real world appears from nothing.

### Target

**A. `components/ui/Button.tsx`** — a 120ms scale transition on press, using Reanimated's CSS
transitions (Reanimated 4.5.1 is already installed; `transitionProperty` support verified at
`node_modules/react-native-reanimated/lib/typescript/css/types/transition.d.ts:43`):

```jsx
// target — imports
import Animated from 'react-native-reanimated';
import { MS, PRESS_SCALE } from '@/constants/Motion';
```

```jsx
// target — the Pressable's children get wrapped
<Pressable
  onPress={onPress}
  disabled={disabled}
  style={({ pressed }) => [
    styles.base,
    fullWidth && styles.fullWidth,
    floating && styles.floating,
    fillStyle,
    disabled && styles.disabled,
    pressed && !disabled && styles.pressed,
  ]}
  /* ...every existing accessibility prop unchanged... */
  hitSlop={{ top: 4, bottom: 4, left: 4, right: 4 }}
  pressRetentionOffset={16}
  testID={testID}
>
```

```js
// target — styles
  disabled: { opacity: 0.4 },
  pressed: {
    opacity: 0.85,
    transform: [{ scale: PRESS_SCALE }],
  },
  base: {
    /* ...all existing base properties unchanged... */
    transform: [{ scale: 1 }],
    transitionProperty: ['transform', 'opacity'],
    transitionDuration: `${MS.press}ms`,
    transitionTimingFunction: 'cubic-bezier(0.23, 1, 0.32, 1)',
  },
```

For the transition to run, the root element must be a Reanimated view. `Pressable`'s `style`
callback applies to its own host view, so **change the root from `Pressable` to
`Animated.createAnimatedComponent(Pressable)`**, assigned to a module-scope constant:

```jsx
const AnimatedPressable = Animated.createAnimatedComponent(Pressable);
```

and use `<AnimatedPressable ...>` in place of `<Pressable ...>`. Everything else about the
component — props, accessibility, colours, `fillStyle` logic — is unchanged.

**B. `components/TrackerCard.tsx`** — kill the `scale(0)` and the bounce:

```jsx
// target — line 470-474
    Animated.timing(t, {
      toValue: filled ? 1 : 0,
      duration: MS.press,                     // 120
      easing: EASE.out,                       // Easing.bezier(0.23, 1, 0.32, 1)
      useNativeDriver: true,
    }).start();
```

```jsx
// target — line 504-509
  const glyphScale = t.interpolate({ inputRange: [0, 1], outputRange: [0.9, 1] });
  // ...
  style={[styles.glyphFill, {
    backgroundColor: fill, margin: inset,
    borderRadius: Math.max(1, size / 3 - inset),
    opacity: t,
    transform: [{ scaleY: glyphScale }],
  }]}
```

with `import { MS, EASE } from '@/constants/Motion';` added.

**C. Consolidate the press opacities.** 34 hand-typed definitions across 9 values
(`0.3, 0.4, 0.45, 0.5, 0.55, 0.6, 0.7, 0.8, 0.85`). Add one constant to
`apps/mobile/constants/Motion.ts`:

```ts
/** The one press opacity. Nine hand-typed values used to live in 34 places. */
export const PRESS_OPACITY = 0.7;
```

and replace **only** values in the range `0.6–0.85` with `PRESS_OPACITY`. Leave `0.3`, `0.4`,
`0.45`, `0.5` and `0.55` alone — those are low enough that they are probably expressing
"disabled" or "de-emphasised", not press, and changing them is a visual decision this plan is
not authorised to make. Report which ones you left and why.

### Repo conventions to follow

- **The exemplar for a native-driven animation in this repo is
  `apps/mobile/components/HoldToConfirm.tsx:153-158`** — read it. It uses `useNativeDriver: true`,
  animates a transform rather than a layout property, and states in a comment *why*. Match that
  standard of commenting: this repo's components carry their reasoning inline, and a bare value
  change with no comment will not match the surrounding code.
- Animated values are created with the lazy-`useState` idiom, **not** `useRef(...).current` —
  `TrackerCard.tsx:468`'s own comment explains that `react-hooks/refs` flags reading `.current`
  during render and the repo holds lint warnings on a ratchet (`check:lint-ratchet` in `verify`).
  Do not introduce a new `useRef(new Animated.Value(...)).current`.
- Colours come from `@/constants/Colors` and `useAccent()`. Do not introduce a hex.

### Steps

1. Apply P1 first, or this will not compile (`@/constants/Motion` will not exist).
2. Add `PRESS_OPACITY` to `apps/mobile/constants/Motion.ts`.
3. Edit `apps/mobile/components/ui/Button.tsx` per Target A. One file, no behaviour change beyond
   the transition and `pressRetentionOffset`.
4. Edit `apps/mobile/components/TrackerCard.tsx` per Target B.
5. Sweep the press opacities per Target C. Use
   `grep -rnE -A4 "(pressed|Pressed)\s*(\?\?|&&|:)" apps/mobile/app apps/mobile/components --include="*.tsx"`
   to find them.
6. Run `pnpm run test:mobile`. `apps/mobile/components/ui/__tests__/` contains Button tests —
   if any asserts on the exact `opacity: 0.85` style object, update the assertion, do not
   weaken it.

### Boundaries

- Do **NOT** add press feedback to the 73 files that lack it in this plan. That is a large,
  screen-by-screen migration and belongs in its own sequence — `Button.tsx`'s own doc comment
  (lines 55–61) already establishes that a fifteen-file migration is a follow-up, not this PR.
  Fix the primitive; the migration is a separate ticket.
- Do **NOT** touch `apps/mobile/app/session/[id].tsx`. The set-logging path is deliberately
  motion-free and stays that way; the only thing it may ever gain is this same ≤150ms press
  scale, via `Button`, if and when it adopts `Button`.
- Do **NOT** change any duration to something not in `MS`.
- Do **NOT** add a new dependency. Reanimated and worklets are already installed.
- Do NOT change markup or accessibility props.

### Verification

- **Mechanical**: `pnpm run lint:mobile && pnpm run test:mobile && pnpm run typecheck:mobile`.
  `check:lint-ratchet` must not report a new warning.
- **Feel check** — on a **release** build on a real device (`pnpm --dir apps/mobile run ios:device`),
  not the simulator and not a dev build:
  - Press and hold any `Button`. It should shrink perceptibly but subtly and **stay** shrunk while
    held, then spring back on release. If it feels like the button is "wobbling," the duration is
    wrong — it must be 120ms, not a spring.
  - Press, then slide your thumb ~15px off the button without lifting. The press must **not**
    cancel (that is `pressRetentionOffset`). Slide 40px off — it should cancel.
  - Tap a tracker glyph rapidly, ~4 times a second. The fill must not overshoot or bounce, and
    must never appear from a zero-height line — watch for a horizontal sliver at the start.
  - Record a slow-motion video (iPhone camera, 240fps) of one glyph tap and step through it. The
    fill's first visible frame should already be at ~90% height, not 0.
- **Done when**: `Button` scales on press on device, `pressRetentionOffset` is set, the glyph
  starts at `scale(0.9)` with no bounce, and the press-opacity count is down from 9 distinct
  values to at most 5 (the four low outliers plus `PRESS_OPACITY`).

---

## P3 — Fix the web toggle knob that has never animated

- **Status**: TODO
- **Commit**: `f00c6a82`
- **Severity**: HIGH
- **Category**: 5 — Performance
- **Depends on**: P1 (for the token; can be done with literals if P1 has not landed)
- **Estimated scope**: 1 file, 2 lines

### Problem

`apps/web/src/app/dashboard/settings/page.tsx:108-112` — the discipline toggle:

```jsx
                  <span
                    className={`block h-5 w-5 rounded-pill transition ${
                      on ? "ml-4 bg-lime" : "ml-0 bg-text-dim"
                    }`}
                  />
```

The author wrote `transition` intending the knob to slide. It does not. Tailwind v4's bare
`transition` utility expands to a **curated list of 22 properties**, extracted verbatim from the
installed `node_modules/tailwindcss/dist/lib.js`:

```
color, background-color, border-color, outline-color, text-decoration-color, fill, stroke,
--tw-gradient-from, --tw-gradient-via, --tw-gradient-to, opacity, box-shadow, transform,
translate, scale, rotate, filter, -webkit-backdrop-filter, backdrop-filter, display,
content-visibility, overlay, pointer-events
```

**`margin` and `margin-left` are absent.** So the `bg-lime ↔ bg-text-dim` colour change animates
and the knob teleports — the one piece of deliberately-designed motion in `apps/web`, and it has
never run. `margin` is also a layout property, which `AUDIT.md` §5 forbids animating even if it
had worked.

Note `translate` **is** in the list, which is what makes the fix a two-token swap.

### Target

```jsx
/* target — apps/web/src/app/dashboard/settings/page.tsx:108-112 */
                  <span
                    className={`block h-5 w-5 rounded-pill transition-[translate,background-color] duration-[--duration-control] ease-[--ease-out] ${
                      on ? "translate-x-4 bg-lime" : "translate-x-0 bg-text-dim"
                    }`}
                  />
```

If P1 has not landed, use literals instead of the custom properties — the exact values, not
approximations:

```
duration-[180ms] ease-[cubic-bezier(0.23,1,0.32,1)]
```

`ease-out` per `AUDIT.md` §2 (the knob is entering its new position, and ease-out feels
responsive); 180ms per the §2 "toggle, small state change" budget.

Confirm the geometry survives: the track is `h-6 w-10` with `padding` from the parent
(`page.tsx:101-107`) and the knob is `h-5 w-5`. `ml-4` is `1rem` = 16px, so `translate-x-4` is
the same 16px displacement. The visual end state is identical; only the mechanism changes.

### Repo conventions to follow

- `apps/web/src/app/globals.css` defines all custom properties under `:root` (`--c-bg` at line
  35). Tailwind v4 arbitrary values reference them with the `[--name]` bracket syntax.
- `apps/web`'s visual style predates the design system (see the `vola-design-system` skill's
  "Known asymmetry" note) — do **not** take this as licence to restyle anything. Colours
  (`bg-lime`, `bg-text-dim`) are unchanged.

### Steps

1. Replace the knob's `className` per Target. Two class swaps (`ml-*` → `translate-x-*`) plus the
   transition specification.
2. Nothing else in the file changes.

### Boundaries

- Do **NOT** touch the outer track `<span>` at `page.tsx:101-107` — its `transition` on
  `border-color`/`background-color` is correct and already works.
- Do **NOT** convert this to a native `<input type="checkbox">` or restructure the markup. The
  surrounding `<button>` carries the accessibility contract.
- Do **NOT** apply the same fix elsewhere in this plan — search first and report what you find,
  but keep the diff to this one control so the fix is reviewable.
- Do NOT add a dependency.

### Verification

- **Mechanical**: `pnpm run lint:web && pnpm run typecheck:web && pnpm run build:web`.
- **Feel check** — this is the finding I could not confirm visually, so confirming it is the
  point of this plan:
  1. **Before you change anything**, run `pnpm run dev:web`, go to `/dashboard/settings`, and
     toggle a discipline. Confirm the knob **jumps** with no slide. If it already slides, STOP —
     the Tailwind analysis is wrong for this version and the plan needs revisiting.
  2. Apply the change. Toggle again — the knob should now glide across the track in 180ms.
  3. Open DevTools → Animations panel, set playback speed to 10%, and toggle. Confirm the knob's
     motion and the track's colour change start together and finish together (they share the
     duration but are on different elements, so drift is visible at 10%).
  4. In DevTools → Rendering → "Emulate CSS prefers-reduced-motion: reduce", toggle again. Today
     nothing changes (there is no handling — that is P4). The knob should still slide; P4 is what
     makes it stop moving while keeping the colour change.
- **Done when**: the knob visibly slides, `margin` no longer appears in the knob's classes, and
  step 1's "before" observation was actually made and recorded.

---

## P4 — Give apps/web an entrance layer and a reduced-motion floor

- **Status**: TODO
- **Commit**: `f00c6a82`
- **Severity**: MEDIUM
- **Category**: 3 — Physicality & origin / 6 — Accessibility / 8 — Missed opportunities
- **Depends on**: P1
- **Estimated scope**: 5 files, ~70 lines

### Problem

Every conditionally-mounted surface in `apps/web` hard-mounts. Three concrete cases:

```jsx
/* apps/web/src/components/ShareToFriend.tsx:178-182 — current */
      {open && !disabled && (
        <div
          ref={panel}
          role="dialog"
          aria-label="Share with a friend"
          className="absolute right-0 z-10 mt-2 w-72 rounded-card border border-line bg-surface p-3 shadow-lg"
        >
```

```jsx
/* apps/web/src/app/dashboard/sessions/page.tsx:676-677 — current */
      {open && (
        <div className="absolute right-0 z-20 mt-2 w-72 overflow-hidden rounded-card border border-line bg-surface shadow-lg">
```

```jsx
/* apps/web/src/app/dashboard/workouts/page.tsx:320 — current */
    <div
      className="fixed inset-0 z-50 overflow-y-auto bg-black/70"
```

The first two are **trigger-anchored popovers** — they belong to the button above them and should
appear to come from it. `grep -rn "origin-" apps/web/src apps/admin/src` exits 1: no
`transform-origin` is set anywhere in either app. The third is the app's only modal; a
full-screen 70%-black scrim snaps over the page with no motion at all.

Separately:

```
$ grep -rn "prefers-reduced-motion\|motion-reduce\|motion-safe" apps/web apps/admin \
    --include="*.tsx" --include="*.css" --include="*.ts"
$ echo $?
1
```

Zero handling in either app. And the app's one transform-on-hover is ungated:

```jsx
/* apps/web/src/app/dashboard/sessions/TrainingCalendar.tsx:232 — current */
      className={`h-3 w-3 rounded-[3px] transition-transform hover:scale-125 focus-visible:outline ...
```

`hover:scale-125` is a 25% growth on a 12px cell rendered ~365 times per view, and touch fires a
false hover on tap.

### Target

**A. Popover entrance.** Both popovers are `right-0`-anchored, so they scale from their top-right
corner. Add to `apps/web/src/app/globals.css`, after the `@import` P1 added:

```css
/* An anchored surface arriving from its trigger. `data-state` is set by the
   component; there is no headless UI library here to provide one. */
@keyframes popover-in {
  from { opacity: 0; transform: scale(0.96); }
  to   { opacity: 1; transform: scale(1); }
}
.popover-in {
  animation: popover-in var(--duration-surface) var(--ease-out);
  transform-origin: top right;
}
```

Then add `popover-in` to both popovers' `className`. Nothing else about either changes — no
markup, no refs, no focus handling.

Never `scale(0)`: `0.96` is inside the sanctioned `0.9–0.97` band.

**B. Modal entrance.** `apps/web/src/app/dashboard/workouts/page.tsx:320` and the dialog inside it:

```css
@keyframes scrim-in  { from { opacity: 0; } to { opacity: 1; } }
@keyframes dialog-in { from { opacity: 0; transform: scale(0.96); } to { opacity: 1; transform: scale(1); } }
.scrim-in  { animation: scrim-in  var(--duration-sheet) var(--ease-out); }
.dialog-in { animation: dialog-in var(--duration-sheet) var(--ease-out); }
```

Add `scrim-in` to the `fixed inset-0 … bg-black/70` element and `dialog-in` to the dialog panel
inside it. **`transform-origin` stays `center` here and that is correct** — a modal appears
centred in the viewport and is explicitly exempt from the origin rule. Do not set an origin on it.

**C. `ease-out` on entrance-shaped transitions.** Two sites reveal content on hover and currently
use Tailwind's default ease-in-out:

- `apps/web/src/app/dashboard/calendar/page.tsx:889`
- `apps/web/src/app/dashboard/workouts/[id]/page.tsx:730`

Add `ease-[--ease-out] duration-[--duration-control]` to each. **Do not** sweep the other ~98
bare `transition` utilities — the colour hovers are correctly served by the default curve
(`AUDIT.md` §2: "Hover / color change → `ease`"), and a 100-site diff is unreviewable.

**D. Heatmap hover.** `TrainingCalendar.tsx:232`: change `hover:scale-125` to
`hover:scale-110`, and gate it. Tailwind v4 has no built-in hover-capability variant, so add to
`globals.css`:

```css
@custom-variant fine-hover (@media (hover: hover) and (pointer: fine));
```

and write the class as `fine-hover:hover:scale-110`.

**E. The reduced-motion floor.** Append to `apps/web/src/app/globals.css` and add the identical
block to `apps/admin/src/app/globals.css`:

```css
/* Reduce Motion is a request not to be MOVED, not a request to see nothing.
   Colour and opacity transitions explain a state change and are kept; every
   position, scale and rotation change is dropped. */
@media (prefers-reduced-motion: reduce) {
  .popover-in, .dialog-in { animation: scrim-in var(--duration-control) var(--ease-out); }
  .fine-hover\:hover\:scale-110:hover { transform: none; }
  *, *::before, *::after {
    transition-property: opacity, color, background-color, border-color, fill, stroke;
  }
}
```

Note the last rule narrows the transition property list rather than setting `transition: none` —
that keeps the colour feedback that aids comprehension and drops only movement, which is the rule.

### Repo conventions to follow

- All custom properties live under `:root` in `apps/web/src/app/globals.css` (line 33 onward).
  Keyframes and utility classes go in the same file, below the `:root` block.
- `apps/web`'s style predates the design system. Take no other styling liberties.
- `apps/admin/src/app/globals.css` uses an `@theme` block (Barlow / Barlow Condensed). Only the
  reduced-motion block from **E** goes there; admin has zero motion otherwise
  (`grep -rl "transition\|animate-" apps/admin/src --include="*.tsx"` → 0 files) and this plan
  does not add any.

### Steps

1. Apply P1 first (the `--duration-*` / `--ease-*` properties must exist).
2. Add the keyframes, utility classes and `@custom-variant` from A, B, D to
   `apps/web/src/app/globals.css`.
3. Add `popover-in` to `ShareToFriend.tsx:182` and `sessions/page.tsx:677`.
4. Add `scrim-in` / `dialog-in` in `workouts/page.tsx` — read lines 316–360 first to identify the
   dialog panel element; the scrim is line 320.
5. Apply C to the two named lines only.
6. Apply D to `TrainingCalendar.tsx:232`.
7. Add block E to both `globals.css` files.

### Boundaries

- Do **NOT** sweep the other ~98 bare `transition` utilities. Two named sites only.
- Do **NOT** add exit animations. An unmount cannot be animated without a state machine, and
  adding one is a component-architecture change, not a motion change.
- Do **NOT** set `transform-origin` on the modal — modals are exempt and centre is correct.
- Do **NOT** add motion to `apps/admin` beyond the reduced-motion block.
- Do **NOT** touch the ~40 lines of `pointerdown`/keyboard-viewport commentary around
  `workouts/page.tsx:320`. That reasoning is load-bearing and unrelated.
- Do NOT add a dependency.

### Verification

- **Mechanical**: `pnpm run lint:web && pnpm run typecheck:web && pnpm run build:web && pnpm run lint:admin && pnpm run typecheck:admin && pnpm run build:admin`.
- **Feel check**, `pnpm run dev:web`:
  - Open the share popover. It must appear to grow from its **top-right corner**, where the
    trigger is — not from its centre. DevTools → Animations → 10% playback makes the origin
    obvious; if it inflates symmetrically, `transform-origin` did not apply.
  - Open the "New session" dropdown — same check.
  - Open "New workout". The scrim should fade while the dialog scales up from centre. At 10%
    playback, confirm they start together; a scrim that lands before the dialog reads as two
    events.
  - Hover a heatmap cell — it should grow slightly, not lurch. Then open the page on a touch
    device or in DevTools device emulation and **tap** a cell: it must not grow at all.
  - DevTools → Rendering → "Emulate `prefers-reduced-motion: reduce`". Reopen all three
    surfaces: they should fade in with **no scaling and no movement**, and the toggle from P3
    should change colour without sliding. Colour transitions must still be visible — if
    everything becomes instant, block E is too aggressive.
- **Done when**: both popovers scale from their trigger corner, the modal has an entrance,
  reduced motion drops movement while keeping colour, and the heatmap does not grow on tap.

---

## P5 — Move the macro rings off the JS thread

- **Status**: TODO
- **Commit**: `f00c6a82`
- **Severity**: HIGH
- **Category**: 5 — Performance
- **Depends on**: P1
- **Estimated scope**: 1 file, ~50 lines changed

### Problem

`apps/mobile/components/today/MacroRings.tsx` renders the Today tab's macro rings. Each `Ring`
animates `strokeDashoffset`, which cannot be native-driven by core `Animated`:

```jsx
// apps/mobile/components/today/MacroRings.tsx:153-173 — current
    const anim = Animated.parallel([
      Animated.timing(base, {
        toValue: targetBase,
        duration: 620,
        easing: Easing.out(Easing.cubic),
        // strokeDashoffset is not a transform or an opacity, so it cannot go
        // to the native thread. Stated rather than left as a silent `false`.
        useNativeDriver: false,
      }),
      Animated.timing(over, {
        toValue: targetOver,
        duration: 620,
        delay: targetOver > 0 ? 380 : 0,
        easing: Easing.out(Easing.cubic),
        useNativeDriver: false,
      }),
    ]);
```

The comment is honest and correct *for core `Animated`*. But the file additionally renders a
whole ramp of arcs, each with its own JS-side interpolation:

```jsx
// apps/mobile/components/today/MacroRings.tsx:276-285 — current
          {ramp.map((shade, i) => {
            const reach = ((ramp.length - i) / ramp.length) * targetOver;
            return (
              <AnimatedCircle
                strokeDashoffset={over.interpolate({ ... })}
```

So on the app's landing tab, while it is also loading the day's data, one macro ring plus N ramp
arcs per macro are all interpolated on the JS thread for 620ms — and `CADisableMinimumFrameDurationOnPhone`
is set in `apps/mobile/ios/VOLA/Info.plist:5`, so the frame budget on a ProMotion device is
**8ms**. This is the single clearest case of the "Reanimated is installed and unused" cost.

### Target

Drive the same two values with Reanimated shared values and `useAnimatedProps`, which runs the
interpolation on the UI runtime. **No visual change** — same 620ms, same curve, same 380ms
second-lap delay, same reduced-motion behaviour.

```jsx
// target — imports
import Animated, {
  useSharedValue, useAnimatedProps, withTiming, withDelay, interpolate, Easing,
} from 'react-native-reanimated';
import { Circle } from 'react-native-svg';
import { EASE } from '@/constants/Motion';

const AnimatedCircle = Animated.createAnimatedComponent(Circle);
```

```jsx
// target — the effect, replacing lines 139-174
  const base = useSharedValue(0);
  const over = useSharedValue(0);

  useEffect(() => {
    // Hold while the OS has not answered. Animating here would sweep the ring
    // for somebody who asked not to be moved, every cold start, because the
    // first frame always precedes the answer.
    if (reduced === null) return;

    if (reduced) {
      // Reduce Motion is a request not to be MOVED, not a request to see
      // nothing — the ring still shows its value, it just arrives there.
      base.set(targetBase);
      over.set(targetOver);
      return;
    }

    base.set(withTiming(targetBase, { duration: 620, easing: EASE.out }));
    over.set(
      withDelay(
        targetOver > 0 ? 380 : 0,
        withTiming(targetOver, { duration: 620, easing: EASE.out }),
      ),
    );
  }, [reduced, targetBase, targetOver, base, over]);
```

```jsx
// target — the base arc's animated props
  const baseProps = useAnimatedProps(() => ({
    strokeDashoffset: interpolate(base.get(), [0, 1], [circumference, 0]),
  }));

  // <AnimatedCircle {...common} animatedProps={baseProps} ... />
```

```jsx
// target — each ramp arc. The `reach` clamp is preserved exactly.
function RampArc({ over, reach, circumference, shade, overCap, common }) {
  const props = useAnimatedProps(() => ({
    strokeDashoffset:
      reach >= 1
        ? interpolate(over.get(), [0, 1], [circumference, 0])
        : interpolate(
            over.get(),
            [0, reach, 1],
            [circumference, circumference * (1 - reach), circumference * (1 - reach)],
          ),
  }));
  return <AnimatedCircle {...common} strokeLinecap={overCap} stroke={shade} strokeDasharray={circumference} animatedProps={props} />;
}
```

A separate component is required because `useAnimatedProps` is a hook and cannot be called inside
`ramp.map()`.

Note `EASE.out` is `Easing.bezier(0.23, 1, 0.32, 1)`, a slightly stronger curve than the current
`Easing.out(Easing.cubic)`. That is the intended upgrade — `AUDIT.md` §2 says the built-ins are
too weak. If the sweep reads as too abrupt on device, report it rather than reverting to a
built-in.

### Repo conventions to follow

- **The pairing is tested upstream at these exact versions**: `react-native-reanimated@4.5.1`'s
  own `package.json:137` declares `"react-native-svg": "15.15.4"`, which is precisely the version
  installed here. This is not a speculative integration.
- Reanimated shared values are read and written with `.get()` / `.set()`, never `.value` — the
  form the React Compiler can see through.
- **Never read or write a shared value during render.** Only in worklets, handlers and effects.
- `apps/mobile/lib/useReducedMotion.ts` returns `boolean | null` and the `null` state is
  load-bearing: it means "the OS has not answered yet, hold." The current code gets this right;
  preserve it exactly, comments included.
- This repo's components carry their reasoning inline. Keep every existing comment in the file —
  particularly the W24/#1022 and N554/#1025 blocks explaining the ramp — and update only the
  sentences that become untrue (e.g. the `useNativeDriver: false` comment, which should be
  replaced with a note that this now runs on the UI runtime).

### Steps

1. Apply P1 first.
2. Replace the two `Animated.Value`s with `useSharedValue`.
3. Replace the `Animated.parallel` effect per Target, preserving the `reduced === null` hold and
   the `reduced` branch verbatim.
4. Replace the base arc's `strokeDashoffset={dashOffset}` with `animatedProps={baseProps}`; delete
   the now-unused `useMemo`/`interpolate` at lines 175–184.
5. Extract `RampArc` and use it inside `ramp.map()`.
6. Swap the `Animated` import from `react-native` to `react-native-reanimated`; delete the
   `Easing` import from `react-native` if nothing else in the file uses it.
7. Run `pnpm run test:mobile`. `apps/mobile/components/__tests__/macroRingCaps.test.tsx` exercises
   this component and reads `useReducedMotion` asynchronously (see its comment at line 36) — if it
   fails, the reduced-motion branch was not preserved faithfully.

### Boundaries

- Do **NOT** change any duration, delay, colour, cap, radius, stroke width or the ramp's arc
  count. This is a threading change with **zero intended visual difference** except the easing
  curve noted above.
- Do **NOT** change the `sweepFor` / `ramp` maths.
- Do **NOT** touch any other file. `app/(tabs)/index.tsx:1207-1213` carries a W15/#703 comment
  about this component's `Animated.Value` lifetime and keying — read it, but do not edit it, and
  if the change appears to invalidate it, STOP and report.
- Do NOT add a dependency.

### Verification

- **Mechanical**: `pnpm run lint:mobile && pnpm run test:mobile && pnpm run typecheck:mobile`.
- **Feel check** — a **release** build on a real device:
  - Cold-start the app and land on Today. The rings must sweep exactly as before: base lap first,
    the overtake lap starting ~380ms later, both finishing at 620ms.
  - **The point of the change**: cold-start onto Today while the app is fetching. Previously the
    sweep competed with data loading on the JS thread. Record slow-motion video before and after
    and compare for dropped frames. If you cannot get a before, at minimum confirm the sweep does
    not visibly hitch.
  - Log a food entry and return to Today. The rings must animate from their **current** value to
    the new one, not restart from zero.
  - Settings → Accessibility → Motion → Reduce Motion **on**. Force-quit and relaunch. The rings
    must appear already at their value with **no sweep**, and must still be visible — an empty or
    absent ring means the reduced branch is wrong.
  - Toggle Reduce Motion **off** while the app is backgrounded, return: the next value change
    should sweep again (the hook subscribes to changes).
- **Done when**: `useNativeDriver: false` no longer appears in the file, the rings look
  identical, and both Reduce Motion states behave as described on device.

---

## P6 — Gesture handoff, physicality and reduced motion on the animated surfaces

- **Status**: TODO
- **Commit**: `f00c6a82`
- **Severity**: MEDIUM
- **Category**: 4 — Interruptibility / 6 — Accessibility / 2 — Easing
- **Depends on**: P1
- **Estimated scope**: 5 files, ~70 lines

### Problem

Five defects across the existing animated surfaces, all fixable with **no new dependency**.

**1. No velocity handoff on either drag.** Both settle springs discard the release velocity that
is sitting right there in the handler:

```js
// apps/mobile/components/SwipeToDelete.tsx:130-134 — current
      Animated.spring(translate, {
        toValue: to,
        useNativeDriver: true,
        bounciness: 0,
      }).start();
```

```js
// apps/mobile/components/food/EntryRow.tsx:192 — current
    Animated.spring(lift, { toValue: 0, useNativeDriver: true, bounciness: 0 }).start();
```

Without it there is a visible seam the instant the finger lifts — the row stops dead and then a
fresh animation starts from zero speed.

**2. Hard boundary clamp.**

```js
// apps/mobile/components/SwipeToDelete.tsx:170 — current
          translate.setValue(Math.max(-ACTION_WIDTH, Math.min(0, next)));
```

An invisible wall. Real things resist progressively before stopping.

**3. The drag lift pops.**

```jsx
// apps/mobile/components/food/EntryRow.tsx:264 — current
        { transform: [{ translateY: lift }, { scale: isDragging ? 1.02 : 1 }] },
```

`translateY` is animated; `scale` is a plain style bound to a boolean, so it snaps in at drag
start and snaps out mid-settle while `lift` is still springing home.

**4. No haptic on the reorder lift.** `grep -c 'Haptic'` on both `lib/useEntryDrag.ts` and
`components/food/MealCard.tsx` returns **0**. Press-and-hold-to-reorder (N553/#1029) arms and
commits silently. A row that lifts under the finger with no impact reads as lag.

**5. `ease-in` on the splash exit, and no reduced motion on the celebration.**

```js
// apps/mobile/components/AnimatedSplash.tsx:169-175 — current
    const anim = Animated.timing(fade, {
      toValue: 0,
      duration: FADE_MS,
      delay: HOLD_MS,
      easing: Easing.in(Easing.quad),
      useNativeDriver: true,
    });
```

`Easing.in` starts slow, holding the splash opaque exactly while the user is waiting for the app —
the app's first impression, and the one easing rule that is never negotiable. Meanwhile
`components/SessionCelebration.tsx:71-76` plays an 850ms full-screen flare with no reduced-motion
check, and `apps/mobile/app/_layout.tsx:349` sets no `animation` on `<Stack>` at all
(`grep -rn "animation:" apps/mobile/app` → 0), so 23 screen pushes slide unconditionally.

### Target

**1. Velocity.** React Native's spring integrates in **seconds** — verified at
`node_modules/react-native/Libraries/Animated/animations/SpringAnimation.js:281`
(`const deltaTime = (now - this._lastTime) / 1000;`) — while `PanResponder`'s `gestureState.vx`
is in pixels per **millisecond**. The conversion is `× 1000`:

```js
// target — SwipeToDelete.tsx, settle() takes the velocity
  const settle = useCallback(
    (to: number, vx = 0) => {
      rest.current = to;
      setOpen(to !== 0);
      Animated.spring(translate, {
        toValue: to,
        useNativeDriver: true,
        bounciness: 0,
        velocity: vx * 1000,   // gestureState.vx is px/ms; RN's spring wants px/s
      }).start();
    },
    [translate],
  );
```

and at the call site:

```js
// target — SwipeToDelete.tsx:172-173
        onPanResponderRelease: (_e, g) =>
          settle(settleTarget({ rest: rest.current, dx: g.dx, vx: g.vx }), g.vx),
```

Leave `onPanResponderTerminate` and the `useEffect` callers passing no velocity — a termination
and a programmatic close have none.

Same change in `EntryRow.tsx`: `settle` takes `vy = 0` and passes `velocity: vy * 1000`; the
release handler passes `g.vy`.

**2. Rubber-band.** Add above the component in `SwipeToDelete.tsx`:

```js
/**
 * The further past the edge, the less the row follows. A real thing resists
 * before it stops; an invisible wall reads as the gesture breaking.
 */
function rubberband(overshoot: number, dimension: number, constant = 0.55): number {
  return (overshoot * dimension * constant) / (dimension + constant * Math.abs(overshoot));
}
```

```js
// target — SwipeToDelete.tsx:165-171
        onPanResponderMove: (_e, g) => {
          const next = rest.current + g.dx;
          if (next > 0) {
            // Dragging right past closed: nothing is revealed on that side, so
            // it resists rather than stopping dead.
            translate.setValue(rubberband(next, ACTION_WIDTH));
          } else if (next < -ACTION_WIDTH) {
            const past = next + ACTION_WIDTH;
            translate.setValue(-ACTION_WIDTH + rubberband(past, ACTION_WIDTH));
          } else {
            translate.setValue(next);
          }
        },
```

`shouldClaim` and `settleTarget` are exported and unit-tested — **do not change either**. The
rubber-band affects only the visual position during a drag; `settleTarget` still receives the raw
`g.dx`, so the settle decision is unchanged and its tests keep passing.

**3. Animated lift scale.** In `EntryRow.tsx`, derive the scale from a second animated value
driven by `isDragging`, so both halves share a clock:

```jsx
// target — EntryRow.tsx, near line 174
  const [liftScale] = useState(() => new Animated.Value(1));
  useEffect(() => {
    Animated.timing(liftScale, {
      toValue: isDragging ? 1.02 : 1,
      duration: MS.press,          // 120
      easing: EASE.out,
      useNativeDriver: true,
    }).start();
  }, [isDragging, liftScale]);
```

```jsx
// target — EntryRow.tsx:264
        { transform: [{ translateY: lift }, { scale: liftScale }] },
```

Keep `translateY` **first** in the array — transform order matters, and reversing it would scale
the translation too.

**4. Haptics.** In `EntryRow.tsx`, add `import * as Haptics from 'expo-haptics';` and fire in the
**grant** and **release** handlers only:

```js
// target — inside handleResponder's onPanResponderGrant, after onStart?.(...)
          Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
```

```js
// target — inside both responders' onPanResponderRelease, before settle()
          Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
```

**Never in `onPanResponderMove`** — that fires 60–120 times a second. **Never in
`onPanResponderTerminate`** — a cancelled drag is not a commit. `.catch(() => {})` matches every
existing haptic call site in this repo (`HoldToConfirm.tsx:179`, `session/[id].tsx:1211`).

**5. Easing and reduced motion.**

```js
// target — AnimatedSplash.tsx:173
      easing: EASE.out,   // was Easing.in(Easing.quad) — ease-in is never correct on UI
```

```jsx
// target — SessionCelebration.tsx, in the flare component near line 68
  const reduced = useReducedMotion();
  useEffect(() => {
    if (reduced === null) return;          // hold: the OS has not answered yet
    if (reduced) { t.setValue(1); return; }  // show the end state, do not sweep to it
    Animated.timing(t, { toValue: 1, duration: FLARE_MS, easing: EASE.out, useNativeDriver: true }).start();
  }, [reduced, t]);
```

with `import { useReducedMotion } from '@/lib/useReducedMotion';`.

```jsx
// target — apps/mobile/app/_layout.tsx, inside RootStack
function RootStack() {
  const accent = useAccent();
  const reduced = useReducedMotion();
  return (
    <ThemeProvider ...>
      <Stack
        screenOptions={{
          // Reduce Motion replaces the platform slide with a fade — fewer and
          // gentler, not none. `?? false` because a `null` (OS not yet answered)
          // must not suppress the default transition on the very first push.
          animation: reduced ?? false ? 'fade' : 'default',
          headerStyle: { backgroundColor: vola.bg },
          /* ...every other existing option unchanged... */
        }}
      >
```

`animationMatchesGesture` is **not** needed: `'fade'` and `'default'` are both platform
animations, and the rule only applies when overriding with a directional custom animation.

### Repo conventions to follow

- **`apps/mobile/components/HoldToConfirm.tsx` is the exemplar.** Read lines 27–47 and 148–159:
  it explains *why* the commit is a timer rather than an animation callback, why `scaleX` and not
  `width`, and why the cancel snaps in 140ms while the hold takes 900ms (asymmetric timing —
  deliberate phases are slow, the system's response is fast). Match that standard.
- Every haptic in this repo is `.catch(() => {})`'d.
- `apps/mobile/lib/useReducedMotion.ts`'s `null` state means "hold, do not guess." Every new
  caller must handle three states, not two.
- Animated values use the lazy-`useState` idiom, not `useRef(...).current` (`check:lint-ratchet`
  is in `verify`).

### Steps

1. Apply P1 first.
2. `SwipeToDelete.tsx`: add `rubberband`, thread velocity through `settle`. (Items 1, 2.)
3. `food/EntryRow.tsx`: thread velocity, add `liftScale`, add the two haptics. (Items 1, 3, 4.)
4. `AnimatedSplash.tsx`: one-line easing swap. (Item 5.)
5. `SessionCelebration.tsx`: add the reduced-motion branch. (Item 5.)
6. `app/_layout.tsx`: add `animation` to `screenOptions`. (Item 5.)
7. Run `pnpm run test:mobile`. `SwipeToDelete`'s exported `shouldClaim`/`settleTarget` have their
   own tests — they must pass **unchanged**. If you had to modify a test to make it pass, you
   changed behaviour you were told not to; STOP and report.

### Boundaries

- Do **NOT** replace `PanResponder` with `react-native-gesture-handler`. That needs a new native
  dependency and a fresh native build, and `SwipeToDelete.tsx:24-30` already weighed and declined
  it with accurate reasoning. This plan deliberately takes only what needs no new dependency.
- Do **NOT** change `shouldClaim`, `settleTarget`, `CLAIM_DX`, `OPEN_AT`, `FLICK_VX` or
  `ACTION_WIDTH`. The gesture's *decisions* are correct and tested; only its *rendering* changes.
- Do **NOT** add a haptic to `onPanResponderMove` or `onPanResponderTerminate`.
- Do **NOT** add reduced-motion handling to `HoldToConfirm` — its fill is the only signal of hold
  progress and removing it would answer a different request.
- Do **NOT** touch `app/session/[id].tsx`.
- Do NOT add a dependency.

### Verification

- **Mechanical**: `pnpm run lint:mobile && pnpm run test:mobile && pnpm run typecheck:mobile`.
- **Feel check** — a **release** build on a real device. Every item here is a gesture or a haptic
  and none can be judged from code:
  - **Flick** a set row left, fast and short. It should carry through and settle open with no
    stall at the moment your finger lifts. Then drag it slowly and release — same destination,
    different speed. Before the change there was a visible stop-and-restart; confirm it is gone.
  - Drag a row **right** past closed, and **left** past the Delete button. It must slow
    progressively rather than hitting a wall, and snap back cleanly on release.
  - Interrupt a settle: swipe open, then grab the row again mid-animation. It must continue from
    where your finger caught it, not jump.
  - Long-press a food entry to reorder. You should feel a **single** light tap at the moment it
    lifts, and one when you drop it. Drag it around for five seconds — you must feel **nothing**
    in between. A buzz per frame is the failure this is most likely to introduce.
  - Watch the lift: the row should grow into its 1.02 scale over ~120ms and shrink back on the
    same clock as it slides home — not pop in and snap out.
  - Cold-start the app and watch the splash leave. The fade should begin immediately and
    decelerate into the app, not linger and then rush.
  - Turn Reduce Motion **on**. Push into Settings and back — screens should cross-fade, not
    slide. Finish a session — the celebration should appear without the flare sweeping.
  - Turn Reduce Motion **off** and confirm both revert.
- **Done when**: `Easing.in` appears nowhere in `apps/mobile`
  (`grep -rn "Easing\.in(" apps/mobile/app apps/mobile/components` → exit 1), both drags carry
  velocity, the reorder has exactly two haptics per gesture, and all four Reduce Motion
  observations above were actually made on a device.

---

## P7 — Replace the three hand-rolled toggles with the native Switch this app already uses

- **Status**: TODO
- **Commit**: `f00c6a82`
- **Severity**: MEDIUM
- **Category**: 8 — Missed opportunities / 7 — Cohesion
- **Depends on**: nothing
- **Estimated scope**: 3 files, ~40 lines removed

### Problem

Three toggles teleport their knob across the track by changing a **layout** property:

```jsx
// apps/mobile/app/settings.tsx:656-658 — current
      <View style={[styles.switch, value && [styles.switchOn, { backgroundColor: accent.accent }]]}>
        <View style={[styles.knob, value && styles.knobOn]} />
      </View>
```

```js
// apps/mobile/app/settings.tsx:759-760 — current
  knob: { width: 24, height: 24, borderRadius: 999, backgroundColor: vola.surface },
  knobOn: { alignSelf: 'flex-end', backgroundColor: vola.navy },
```

Duplicated verbatim at `apps/mobile/app/(tabs)/workouts.tsx:1308` and
`apps/mobile/app/profile/edit.tsx:697`.

**The fix is not to animate them.** `animate-expo` §1 puts "toggles in settings" in the 100+/day
tier — *No animation. Platform default or nothing.* The defect is that this app got the
no-animation half right and the platform-default half wrong: **it already uses React Native's
native `<Switch>` elsewhere, correctly themed**, which animates for free with correct platform
physics and correct accessibility:

```jsx
// apps/mobile/app/settings/suggestions.tsx:255-264 — the in-repo exemplar
      <Switch
        value={value}
        onValueChange={onChange}
        disabled={disabled}
        trackColor={{ true: accent.accent, false: vola.line }}
        // The knob stays light on both, so the track carries the state. A knob
        // that changed colour too would be two signals for one fact and neither
        // readable in greyscale.
        thumbColor={vola.text}
        accessibilityLabel={label}
```

So there are two different toggles in one app, and the worse one is on the main Settings screen.

### Target

Replace each hand-rolled toggle's `<View style={styles.switch}><View style={styles.knob}/></View>`
with:

```jsx
      <Switch
        value={value}
        onValueChange={onChange}
        trackColor={{ true: accent.accent, false: vola.line }}
        thumbColor={vola.text}
        accessibilityLabel={label}
      />
```

adding `Switch` to the existing `react-native` import in each file, and **deleting** the now-dead
`switch`, `switchOn`, `knob` and `knobOn` style entries.

Each of the three currently sits inside a `<Pressable>` whose `onPress` toggles the value. `Switch`
handles its own press, so the wrapping `Pressable` must either become a plain `View` or keep its
`onPress` **and** the `Switch` must receive `onValueChange` — do not leave both live on the same
row, or one tap on the switch will toggle twice. Read each call site and pick:

- If the whole row is meant to be tappable (the common Settings pattern), keep the `Pressable`,
  give the `Switch` `pointerEvents="none"` on a wrapping `View`, and let the row's `onPress` drive
  it. State which you chose per file.
- Otherwise convert the `Pressable` to a `View` and let the `Switch` own the interaction.

Preserve every existing `accessibilityRole`, `accessibilityLabel`, `accessibilityState` and
`testID` exactly — `<Switch>` reports `role="switch"` natively, so an outer
`accessibilityRole="button"` on a retained `Pressable` would double-announce. If you keep the
`Pressable`, its role becomes `"switch"` and its `accessibilityState` must carry
`{ checked: value }`.

### Repo conventions to follow

- `apps/mobile/app/settings/suggestions.tsx:255-264` is the exemplar. Copy its prop set and its
  comment's reasoning (track carries the state, thumb stays light, readable in greyscale).
- Accent comes from `useAccent()`; greys from `@/constants/Colors`'s `vola`. **No hex literals** —
  `check:palette` is in `verify`.
- Dark-mode-first: check the result in dark mode before light.

### Steps

1. `apps/mobile/app/settings.tsx` — replace the toggle at line 656-658, delete styles at
   `:756-760`.
2. `apps/mobile/app/(tabs)/workouts.tsx:1308` — same.
3. `apps/mobile/app/profile/edit.tsx:697` — same.
4. Run `pnpm run test:mobile`. Any test that queries the old knob `testID` or asserts on
   `alignSelf` must be updated to query the `Switch` — update the query, do not delete the test.

### Boundaries

- Do **NOT** animate the hand-rolled toggle as an alternative. Replace it.
- Do **NOT** touch `apps/mobile/app/settings/suggestions.tsx` or
  `apps/mobile/components/curriculum/CurriculumEditor.tsx` — they are already correct and are the
  reference.
- Do **NOT** change any toggle's label, hint, ordering or default value. This is a control swap,
  not a Settings redesign.
- Do **NOT** introduce a colour not already in `vola` or `useAccent()`.
- Do NOT add a dependency.

### Verification

- **Mechanical**: `pnpm run lint:mobile && pnpm run test:mobile && pnpm run typecheck:mobile`.
  `check:palette` must pass (it will fail on a hex literal).
- **Feel check** — device or simulator:
  - Toggle each of the three. The knob must **glide**, matching the two switches at
    `settings/suggestions.tsx` and `CurriculumEditor.tsx` exactly. Put them side by side if you
    can — the whole point is that they now behave identically.
  - Tap the row's **label** (not the switch). It must toggle exactly once. Tap the switch itself.
    Also exactly once. A double-toggle means both handlers are live.
  - Turn VoiceOver on. Each row must announce as a **switch** with an on/off state, **once** —
    not as "button, switch" or with the state read twice.
  - Check dark mode first, then light. The track's off state (`vola.line`) must be visible against
    the row background in both.
- **Done when**: `alignSelf: 'flex-end'` appears in no toggle style in `apps/mobile`
  (`grep -rn "knobOn" apps/mobile/app` → exit 1), all five switches in the app look and behave
  alike, and VoiceOver announces each once.

---

# Plan index

| # | Title | Severity | Depends on | Est. | Status |
|---|---|---|---|---|---|
| P1 | Give the repo a motion token scale | MEDIUM (prereq) | — | 4 files | TODO |
| P2 | Give every pressable real press feedback | HIGH | P1 | 3 files | TODO |
| P3 | Fix the web toggle knob that has never animated | HIGH | P1 (soft) | 1 file | TODO |
| P4 | Give apps/web an entrance layer and a reduced-motion floor | MEDIUM | P1 | 5 files | TODO |
| P5 | Move the macro rings off the JS thread | HIGH | P1 | 1 file | TODO |
| P6 | Gesture handoff, physicality and reduced motion | MEDIUM | P1 | 5 files | TODO |
| P7 | Replace the hand-rolled toggles with the native Switch | MEDIUM | — | 3 files | TODO |

**Recommended order**: **P1 first — five of the seven depend on it.** Then P3 and P7 in parallel
(both are small, independent, and each fixes something that is visibly broken today). Then P2 —
the highest-leverage single change, and the one most worth a careful device pass. Then P5, then
P4, then P6.

**P3 and P7 are the cheapest real wins**: each is a handful of lines, each fixes a control that
teleports today, and neither needs P1 strictly (P3 can inline the literal values). If only one
thing gets done, do P2 — it is the app's entire feedback channel on a device with no hover.

---

# Coverage statement

**What I read myself, in full or in the relevant part** (every finding above was verified by me
at its `file:line` after the subagents reported; nothing is reported on a subagent's word alone):

- All 8 mobile files that use core `Animated`: `SwipeToDelete.tsx`, `HoldToConfirm.tsx`,
  `TrackerCard.tsx`, `LiveHRIndicator.tsx`, `AnimatedSplash.tsx` (greps + key lines),
  `SessionCelebration.tsx` (greps + key lines), `today/MacroRings.tsx`, `food/EntryRow.tsx`.
- `apps/mobile/lib/useReducedMotion.ts`, `lib/useEntryDrag.ts` (state-write sites),
  `app/_layout.tsx`, `app/(tabs)/_layout.tsx`, `components/ui/Button.tsx`,
  `components/ui/CollapsibleSection.tsx`, `components/Countdown.tsx`,
  `components/KeyboardAwareScroll.tsx` (the keyboard path), `app/settings.tsx` (toggle),
  `app/settings/suggestions.tsx` (the Switch exemplar), `components/TrainingCalendar.tsx`
  (expander + chevron).
- `apps/mobile/package.json`, `app.config.js`, the generated `ios/VOLA/Info.plist`.
- `apps/web/src/app/dashboard/settings/page.tsx`, `src/components/ShareToFriend.tsx`,
  `src/app/dashboard/sessions/page.tsx`, `.../sessions/TrainingCalendar.tsx`,
  `.../workouts/page.tsx`, `src/app/globals.css` (`:root` block).
- `scripts/generate_design_tokens.mjs` in full; `scripts/check-native-deps.py` (head);
  `assets/brand/design-tokens.json` key list; `package.json`'s `verify` chain.
- `react-native/Libraries/Animated/animations/SpringAnimation.js` (velocity units),
  `tailwindcss/dist/lib.js` (the transition property list),
  `react-native-reanimated/lib/typescript/css/types/transition.d.ts` (CSS transition support),
  `react-native-reanimated/package.json` (the svg version pairing).

**What was covered by fan-out subagents and spot-verified by me, not read line by line**: the
breadth of the other ~210 mobile files and ~60 web/admin files. I re-ran and independently
confirmed every count I cite (`<Pressable>` 493 / 125 files / 73 without feedback; 34 press-opacity
definitions across 9 values; 0 `pressRetentionOffset`; 0 `TouchableOpacity`; 0 `LayoutAnimation`;
0 `transition-all`; 0 `ease-*`/`duration-*` classes on web; 0 `prefers-reduced-motion` on
web/admin; 1 `useReducedMotion` consumer). Individual claims about files I did not open — for
example the specific `hitSlop` gaps in L3, or `EntryMenuSheet`'s grabber — carry that provenance
and should be re-checked before acting.

**What I did NOT cover, and what nobody can cover from source:**

- **Feel.** Not one animation in this repo was observed running. Everything above is read from
  code. Whether the keyboard footer's jump, the macro sweep's frame drops, or the press-opacity
  snap actually *feel* wrong is a release-build, real-device judgment — `animate-expo`'s hard rule
  5, and by this repo's own convention a `NEEDS HUMAN EVIDENCE` criterion that reading code cannot
  upgrade. **H1 in particular** (the web toggle knob) is a strong inference from the installed
  Tailwind source and P3's verification deliberately opens with "observe the bug before fixing
  it."
- **No dev server was started, no build was run, no frame was measured, no DevTools panel opened.**
- **`apps/admin`** was swept but not read closely; it has no motion, so there was little to read.
- **Clerk's injected UI.** `apps/web/src/app/clerkAppearance.ts` contains no motion properties, so
  nothing in this repo's code shapes it — but Clerk ships its own unlayered stylesheet with its
  own animations that are invisible from here.
- **`tests/functional/`** and `docs/testing/` — not read. No claim is made about test coverage of
  any of this.
- **Android.** Every device-facing claim assumes iOS. Android's `elevation`, ripple and
  form-sheet detent limits are called out in `animate-expo` but were not evaluated here, and the
  repo's own notes say Android has never been run.
- **Prompt-injection check**: none found. This codebase is unusually comment-heavy — multi-page
  rationale blocks on colour contrast, gesture arbitration and merge semantics — but no file
  contained text attempting to steer this audit. All file content was treated as inert data.
