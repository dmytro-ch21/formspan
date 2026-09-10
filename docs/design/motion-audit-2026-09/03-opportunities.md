# VOLA — animation opportunities

Read-only sweep. Nothing here was implemented; no source file was edited.
Executed under `find-animation-opportunities`, with recipes written against
`animate-expo` / `RECIPES.md`, judged against `apple-design`, named with
`animation-vocabulary`, and constrained by `vola-athlete-ux` and
`vola-design-system`.

---

## Part 0 — Verdict first

**This interface is not dead, and the usual finding for a fitness app — "nothing
moves, add motion everywhere" — is wrong here.** Thirteen components already
animate, and they animate *thoughtfully*: `AnimatedSplash` staggers a wordmark
reveal and honours Reduce Motion; `today/MacroRings.tsx` sweeps the calorie ring
over 620ms and holds the sweep back when the OS asks; `LiveHRIndicator` beats
once per real reading rather than looping; `TrackerCard` springs a glyph fill;
`HoldToConfirm` is a proper hold-to-confirm; `SessionCelebration` owns the
delight budget at the end of a session; `SwipeToDelete` and `food/EntryRow`
carry real drag physics. `lib/useReducedMotion.ts` exists, is shared, and its
doc comment argues the `null` third state correctly. `(tabs)/_layout.tsx` uses
`NativeTabs`, which is the right answer and already the answer.

So the deficit is not personality. **It is continuity.** Everywhere this app
*computes* something — a local-first read landing, a countdown starting, an
advisory card firing, a row being deleted, a sync chip deciding it has something
to say — the result is applied to the tree between two frames, and the athlete's
eye has to re-find the screen. That costs the user in one specific, repeated
way: **content they are reaching for moves under their thumb with no
explanation**, in a product whose own hard rule is that it is used standing up,
one-handed, in ~20 seconds between sets.

Where that actually costs the user, ranked: opening the app (the Today tab
assembles itself in ~8 independent flips), and starting a rest timer (the entire
workout log jumps down exactly 64pt, and a bar materialises in the space).

Highest-leverage single item: **#1**. Second: **#2**, which is not an animation
at all — it is the missing instant press state on the most-tapped control in the
product.

---

## Part 0.5 — The one scale, stated once

No motion tokens exist. `assets/brand/design-tokens.json` holds
`brand, icon, spacing, radius, pillRadius` and nothing else. Every recipe below
draws from the same short scale, and it should live in one place rather than
being sprinkled:

| Name | Value | For |
| --- | --- | --- |
| `press` | 120ms | press-out release only; press-*in* is 0ms |
| `micro` | 160ms | a chip appearing, a row exiting |
| `state` | 200ms | a layout closing a gap, a crossfade |
| `arrive` | 240ms | a block landing from a read |
| `sheet` | 300ms | spring, `dampingRatio: 0.8` |
| `ease.out` | `Easing.bezier(0.23, 1, 0.32, 1)` | entering / exiting |
| `ease.inOut` | `Easing.bezier(0.77, 0, 0.175, 1)` | on-screen movement |

**Where it goes, following the convention already in the repo rather than a new
one:** add a `motion` block to `assets/brand/design-tokens.json`, extend
`scripts/generate_design_tokens.mjs` (which already emits
`apps/mobile/constants/designTokens.generated.ts` and is `verify`-gated for
staleness), and name the values in a new `apps/mobile/constants/Motion.ts`
sitting beside `Spacing.ts` — exactly the shape `Spacing.ts` already has, with
raw numbers generated and names/doc-comments hand-written. `vola-design-system`'s
first rule ("facts about the brand live in exactly one file each") makes this the
only correct home.

**This does not retro-fit the existing animations.** `MacroRings`' 620ms,
`LiveHRIndicator`'s 90/220 and `AnimatedSplash`'s own constants are deliberate
and outside the UI budget on purpose (a ring sweep and a launch sequence are not
UI transitions). Leave them.

**Feasibility, measured, because two of these constrain the recipes:**

- `react-native-reanimated@4.5.1` and `react-native-worklets@0.10.1` are
  installed. Reanimated is currently imported for side effects only, in
  `apps/mobile/app/_layout.tsx:29`. Every recipe below is therefore **zero new
  dependencies**.
- `react-native-gesture-handler` is **NOT** a dependency, and there is **no
  `GestureHandlerRootView`** anywhere in `app/`. That is why every drag in the
  app is `PanResponder`. **No recipe below requires a gesture**, deliberately.
- `CADisableMinimumFrameDurationOnPhone` is present in `ios/*/Info.plist`, so
  the frame budget on ProMotion is 8ms.
- Expo SDK 57 / RN 0.86.3 → New Architecture, which Reanimated 4 requires.

---

## Part 1 — Opportunities

| # | Location | Today | Purpose | Frequency | Suggested motion |
| --- | --- | --- | --- | --- | --- |
| 1 | `apps/mobile/app/(tabs)/index.tsx:1103`, `:1155`, `:1168`, `:1206`, `:1341`, `:1551`; `apps/mobile/app/(tabs)/food.tsx:867` | ~8 blocks each render `null` until their `Source` is `ready`, then appear; each arrival shoves everything below it down | Preventing a jarring change | Every app open (~3–8/day) | `entering={FadeIn.duration(160)}` on each block + `layout={LinearTransition.duration(200).easing(EASE_OUT)}` on its siblings. No stagger, no scale, no translate. Reduced motion: keep the fade, drop `layout` |
| 2 | `apps/mobile/app/session/[id].tsx:3071` (the tick), `:3049` (the timer glyph) | `style={[styles.tick, …]}` — a static array. Zero press feedback on the two most-tapped controls in the product; the only acknowledgment is a haptic | Feedback | 20–40×/session | `style={({ pressed }) => [styles.tick, set.completed && styles.tickDone, pressed && styles.tickPressed]}`. Background/opacity only, **applied instantly on press-in (0ms)**, released over `press` (120ms). Explicitly *not* an animation on the way in |
| 3 | `apps/mobile/app/session/[id].tsx:2688` + `:1653`; `apps/mobile/components/Timer.tsx:101` | Countdown starts → `TimerSurface` materialises and `TIMER_BAR_SPACE` (64pt) is added to the scroll padding on the same frame. The log teleports 64pt. Minimise/expand swaps `TimerBar`↔`TimerCard` with no bridge | Preventing a jarring change + spatial consistency | ~20×/session while training | (a) `entering={SlideInUp.duration(180).easing(EASE_OUT)}` / `exiting={SlideOutUp.duration(140)}` on the `styles.layer` view. (b) FLIP the padding: apply `paddingTop` instantly as today, and on the same frame set the content's `translateY` to `-64` and `withTiming(0, { duration: 180, easing: EASE_OUT })` — transform-only, no per-frame Yoga. (c) bar↔card: crossfade `opacity` 0→1 over `state` (200ms) with `scale` 0.97→1 on the incoming one |
| 4 | `apps/mobile/app/session/[id].tsx:1738` | The warm-up fatigue card appears the instant a warm-up set is ticked. It sits *above* the exercise list, so the whole log drops by its height under a finger that is mid-flow; the `×` at `:1785` snaps it all back | Preventing a jarring change | Occasional | `entering={FadeInUp.duration(220).easing(EASE_OUT)}`, `exiting={FadeOutUp.duration(160).easing(EASE_OUT)}` on the card, plus `layout={LinearTransition.duration(220).easing(EASE_OUT)}` on the exercise-list container so the displacement is a slide. Reduced motion: `FadeIn`/`FadeOut`, drop the translate and the `layout` |
| 5 | `apps/mobile/components/food/MealCard.tsx:394`–`430` | Swipe commits → the row unmounts and every row below teleports up. The swipe itself is animated (`SwipeToDelete.tsx:130`); the consequence is not | Spatial consistency | Occasional | Wrap each row's `RNView key={e.id}` in `Animated.View` with `exiting={FadeOutRight.duration(160).easing(EASE_OUT)}` — it leaves the way the finger sent it — and `layout={LinearTransition.duration(200).easing(EASE_OUT)}`. **Caveat, load-bearing:** the equivalent list at `app/session/[id].tsx:2130` is keyed by *index* (`key={i}`) with an explicit comment that a set has no stable id. React reuses those instances, so `exiting` will not fire there. Sets get `layout` only, until they get stable keys |
| 6 | `apps/mobile/components/SyncChip.tsx:58`, rendered at `apps/mobile/components/ScreenHeader.tsx:425` | `if (!chip) return null` — the chip pops into and out of the header on every screen. Its own doc says *"The chip appearing IS the signal"*. It can also push the wordmark out, because `ScreenHeader:431` measures this cluster to decide `wordmarkFits` — two teleports from one event | State indication | Occasional (silent by design when synced) | `entering={FadeIn.duration(200)}`, `exiting={FadeOut.duration(150)}` on the chip; `layout={LinearTransition.duration(200).easing(EASE_OUT)}` on `styles.rightCluster` so the wordmark's exit is a slide, not a pop. **Never a pulse or a loop** — see *What not to animate* #8 |
| 7 | `apps/mobile/app/food/describe.tsx:755`; `apps/mobile/app/food/scan.tsx:554` | A bare `ActivityIndicator` for a multi-second LLM round-trip, then the drafted result replaces it between two frames | Preventing a jarring change | Occasional | `entering={FadeInDown.duration(240).easing(EASE_OUT)}` on the result block. If the result is discrete rows, a `40ms` stagger capped at the first 5 (per-index `useMemo`, per `RECIPES.md`). This is the one place `RECIPES.md` explicitly blesses an entrance: "content the user asked for and is waiting on". **Lowest leverage of the seven — cut this first if you cut one** |

### Notes that belong to the recipes, not the table

**Reduced motion ships with each, not after.** `lib/useReducedMotion.ts` already
exists and already handles the `null`-until-answered state correctly. Every
`entering`/`exiting`/`layout` builder above takes
`.reduceMotion(ReduceMotion.System)`, which is cheaper and less error-prone than
branching on the hook — use it, and reserve the hook for the cases where the
*content* differs rather than the motion.

**Builders live at module scope.** `RECIPES.md` is explicit: an inline chain in
JSX rebuilds the builder every render. Every one of these is a module-level
const except #7's per-index delay, which needs a `useMemo` in the row.

**#2 is the entry I would ship first if only one shipped.** It is the cheapest,
it needs no library, and it fixes a real defect rather than adding polish:
`animate-expo` §8 is unambiguous that a haptic must **never be the only
feedback** — haptics are off system-wide for many users and silent on most
Android hardware. Today, an athlete with System Haptics off gets *nothing* on
press-in from the control they touch 20–40 times per session. The completed-state
flip at `:3071` happens on press-*out*, which is the wrong half of the gesture
(`apple-design` §1: "Respond on pointer-down, not on release").

**#1's honest shape.** Fading a block in still displaces the blocks below it —
the fade alone would be cosmetics over the same jump. `layout` on the siblings is
the part that does the work; the fade is what stops the arriving block from being
the thing that snaps. Ship them together or don't ship it.

**#3(b) needs a device before anyone believes it.** Translating a scroll view's
content while its `contentContainerStyle` padding changes interacts with scroll
offset, and that cannot be judged from source. It is the one recipe here I would
prototype before committing to.

---

## Part 2 — Rejected candidates

Every one of these was a real candidate with a real anchor. Each is named with
the gate question that killed it.

- **`app/(tabs)/_layout.tsx:112` — sliding or crossfading between the five
  tabs.** *Rejected: 100+/day core navigation. Never animate.* Already correct —
  `NativeTabs` hands the bar to `UITabBarController` / Material 3, and the file's
  own comment records that a hand-drawn animated bar was deliberately removed to
  get there. Do not reintroduce it.

- **`components/Timer.tsx:117` — smoothing the countdown ring's 250ms steps into
  a 60fps sweep.** *Rejected: gate 4, functional data the athlete is reading.*
  `Countdown.tsx:283` repaints at 250ms on purpose. The ring is read from three
  metres away across a gym; a continuously driven arc buys no legibility, is an
  SVG re-render per frame (`MacroRings.tsx:160` already documents the
  `useNativeDriver: false` cost of exactly this), and it would run for the length
  of a workout.

- **`components/ui/PeriodSwitcher.tsx` — a direction-aware slide when the day or
  week steps.** *Rejected: gate 4, and the product decision is already made
  against it.* The component's own doc, lines 32–39, records it: *"'You have
  navigated away' is carried by the label, and deliberately by nothing else"* —
  and gives the reason (the first cut added a second channel measuring 1.38:1, a
  state indicator nobody could see). A slide is that second channel again, for a
  fact already carried in 15.41:1 text that survives greyscale and reads free to
  VoiceOver.

- **`components/ui/CollapsibleSection.tsx:86` and `components/food/MealCard.tsx:362`
  — animating the accordion's height.** *Rejected: gate 3/4, and it fights a
  decision the code states.* `CollapsibleSection`'s comment: children are
  *unmounted* rather than hidden, because `display: 'none'` "would keep every
  child mounted and measured, so a folded ladder would still cost its layout —
  which is the thing being folded away." A height animation requires them mounted
  and measured for the duration of the fold, on a screen the file measures at
  1,662–2,179pt (7,759–9,492pt at accessibility sizes). The fix would reintroduce
  the cost the feature exists to remove.

- **`app/session/[id].tsx:3077` — drawing the checkmark in when a set completes.**
  *Rejected: 20–40×/session, gate 1.* Even at 160ms that is six-plus seconds a
  session spent watching a tick draw itself, on the one interaction whose latency
  budget is explicitly ~20 seconds between sets. The tick's *press state* (#2) is
  the thing that is missing; its *result* should keep arriving instantly.

- **`app/session/[id].tsx:1048` (`addSet`) — an entrance on a newly added set
  row.** *Rejected: gate 1, tens/day, and gate 4.* A row appearing directly under
  the button that made it is already spatially obvious, and the athlete's next
  action is to type into it. Anything that moves a text field the finger is
  travelling toward is a regression, not polish.

- **`components/food/MealCard.tsx:396` — rows parting to make room during
  drag-to-reorder.** *Rejected on frequency, narrowly.* This is a genuine
  physical gap: `styles.dropGap` (`:536`) is a 2pt accent line that teleports
  between slots, so nothing actually shifts to receive the row. It is the most
  "unphysical" moment left in the app. But reordering food entries is rare, the
  feature landed three commits ago (N553), and the correct fix touches a live
  `PanResponder` drag. Revisit if the drag gets used; not worth the risk today.

- **Skeletons / shimmers on any mobile local-first read.** *Rejected: gate 3, and
  it would add latency to look busy.* The reads behind Today and Food are SQLite
  (`useTodayBoard.ts`, `foodLog.ts`). A shimmer that plays for 40ms is a flash; a
  shimmer tuned to be *visible* is time deliberately added. Web's `animate-pulse`
  skeletons (`apps/web/src/app/dashboard/running/[id]/page.tsx:81` and 10 others)
  are correct **because those are network reads** — the same technique, opposite
  verdict, decided by what is behind it.

- **`apps/web` — adding a motion library.** *Rejected: it does not earn its
  bytes.* Web already has Tailwind `transition` on its hover affordances and
  `animate-pulse` on its network waits, which is the right amount for a desk
  surface. Mobile-first is a hard rule here; every byte and every hour spent on
  web motion is one not spent on #1–#3. If any web motion is ever wanted, it is
  CSS-only: `@starting-style` for entrances, and a global
  `@media (prefers-reduced-motion: reduce)` block — which, note, **`apps/web` and
  `apps/admin` currently have zero of**. That is a real gap, but an accessibility
  one, not an opportunity for more motion.

- **`apps/admin` — anything.** *Rejected: gate 1/4.* An internal console with one
  write surface (`/content`) earns close to no motion, and it has none today
  (0 `transition-`/`animate-` sites). Correct as-is.

---

## Part 3 — What NOT to animate in this codebase

The rejected list above is per-candidate. This section is the standing rule, and
it is deliberately opinionated because this product's constraints are unusually
sharp: **standing up, one hand, ~20 seconds, sometimes no signal.**

1. **Nothing on the set-logging path may grow a duration.** `toggleDone`
   (`app/session/[id].tsx:1139`) currently runs a state commit, a suggestion
   refresh, a pure fatigue check and a haptic, and puts *nothing* between the tap
   and the next tap. That property is the feature. A tick that animates, a row
   that settles, a confirmation that plays — each is a few hundred milliseconds ×
   40 sets × every session, spent on a screen whose own comments repeatedly cite
   the 20-second budget. Press *feedback* (#2) is exempt precisely because it is
   0ms in.

2. **Never animate anything into or out of the space under the thumb during a
   live session.** The bottom of `session/[id].tsx` is where "+ Set", the ticks
   and the swipe rows live — `Timer.tsx`'s file comment records that the timer
   was moved *off* the bottom for exactly this reason. Motion there moves a
   target mid-reach, which is worse than a jump: a jump is over before the finger
   lands, a 300ms slide is not.

3. **No motion that rewards frequency.** `vola-athlete-ux` forbids streak
   pressure *structurally, in mechanics as well as copy*. A pulsing sync chip, a
   throb on a streak counter, confetti on logging a meal, a glow that intensifies
   with a run of logged days — all of these are streak pressure relocated to the
   motion channel, and they would pass a copy review. `SessionCelebration.tsx`
   already owns the entire delight budget, at the end of a session, once. Do not
   open a second account.

4. **Do not migrate `SwipeToDelete.tsx` or `food/EntryRow.tsx` to Reanimated +
   gesture-handler "for feel".** Both use `PanResponder`, which `animate-expo`
   lists first under *Never Ship* — and that is a correct criticism of an
   *existing* implementation, which is `improve-animations`' job, not this
   sweep's. Costed here because someone will propose it: `react-native-gesture-handler`
   is not installed, there is no `GestureHandlerRootView`, and adding it is a
   native rebuild in a repo whose `vola-mobile-build` skill exists because native
   rebuilds here fail in silent ways. Both files carry documented edge cases
   (responder termination, index-keyed rows outliving their data, mid-drag
   memoisation) that a rewrite would have to re-derive.

5. **Never animate `BlurView` intensity or Android `elevation`,** and be
   especially careful given `(tabs)/_layout.tsx` now renders iOS 26 Liquid Glass
   chrome. Crossfade a static layer.

6. **Do not put `entering` on a row inside a `FlatList`.** Ten screens use
   `FlatList`/`KeyboardAwareFlatList` (`app/(tabs)/workouts.tsx:299`,
   `app/library.tsx`, `app/social/index.tsx`, `app/workout/[id].tsx` and six
   others). Rows are recycled, so an entrance re-fires every time one scrolls
   back into view and the list appears to flicker while scrolling. `#1` and `#5`
   are both safe only because those lists are plain `.map` renders inside a
   `ScrollView` — verified per site, not assumed.

7. **Do not animate the keyboard.** `KeyboardAwareScroll.tsx` resolves to the
   platform's native inset and `session/[id].tsx:1655` documents why it is left
   unstated rather than pinned. `react-native-keyboard-controller` is the right
   tool if UI ever genuinely has to track the keyboard frame-by-frame — it is not
   a reason to add one now.

8. **A chip, banner or badge that reports offline/sync state must appear and
   leave quietly and then stay still.** `SyncChip.tsx`'s own reasoning is that
   silence is the design and the appearance is the signal. A looping or pulsing
   sync indicator turns "your training is safe" into ambient anxiety, in a
   product with an explicit no-shame constraint, and it would run for the whole
   time an athlete is in a basement gym with no signal — which is exactly when it
   must be reassuring rather than urgent.

9. **Do not animate numbers the athlete is reading to make a decision.** No
   number tickers on `today/MacroRings`' figures, the session stat strip
   (`session/[id].tsx:1665`+), remaining calories, or a trend chart's point
   labels. `vola-athlete-ux`'s mobile-chart carve-out is "one question, three
   seconds" — a rolling digit is time added to a three-second budget. (The
   ring's own 620ms sweep is the exception and is already shipped; it conveys
   proportion, not a value.)

10. **Do not animate the FAB** (`app/(tabs)/index.tsx:1614`). No idle, no pulse,
    no attention-seeking. Its comment records that it was demoted precisely
    because the escape hatch was as loud as the plan.

---

## Part 4 — Coverage

**Read in full:** `apps/mobile/app/_layout.tsx`, `app/(tabs)/_layout.tsx`,
`app/session/[id].tsx` (targeted regions: 1028–1250, 1371–1440, 1640–1790,
2120–2190, 2640–2730, 2858–3100, 3820–3855), `app/(tabs)/index.tsx` (1035–1215,
1540–1620, 2030–2065), `app/(tabs)/food.tsx` (855–905), `lib/useReducedMotion.ts`,
`lib/useTodayBoard.ts` (header), `components/Timer.tsx` (1–140),
`components/SwipeToDelete.tsx` (100–180), `components/SyncChip.tsx`,
`components/ScreenHeader.tsx` (405–440), `components/food/MealCard.tsx` (1–110,
390–430), `components/food/EntryRow.tsx` (165–200),
`components/ui/CollapsibleSection.tsx`, `components/ui/PeriodSwitcher.tsx`
(1–60), `apps/mobile/constants/designTokens.generated.ts`, `app.config.js`,
`package.json`, `ios/*/Info.plist`.

**Swept by grep across the whole of `apps/mobile/app` (77 `.tsx`), `components`
(147 `.tsx`) and `lib`:** every `Animated`/`react-native-reanimated`/
`expo-haptics` import site; all 493 `<Pressable>` and 0 `<TouchableOpacity>`; all
82 `({ pressed })` styling sites and every `pressed: {` definition; every
`<Modal>` and its `animationType` (all 22 already set); every
`FlatList`/`FlashList` site; `transitionProperty`/`animationName` (zero);
`AccessibilityInfo.announceForAccessibility` and any toast/snackbar pattern
(none — the app navigates back on success, deliberately).

**`apps/web`:** dependency list, all 36 `page.tsx` paths, every `transition` /
`animate-` / `@keyframes` / `prefers-reduced-motion` site, and `globals.css`'s
theming block. **No web page was read in full**, and no web proposal is made
beyond the accessibility note above.

**`apps/admin`:** dependency and grep only. Zero motion sites; judged correct.

**Not swept:** `backend/`, `contracts/`, `tests/functional/`,
`docs/testing/device-checks.md`.

**What I did not do, and it matters:**

- **I never ran the app.** Not on a device, not in the Simulator, not one frame.
  Everything above is read from source. Per `animate-expo`, feel is only judged
  on a release build on the slowest supported device; nothing here has been.
- Two claims in particular are inferences that a device would confirm or kill:
  (a) whether Today's ~8 `Source` flips land far enough apart in wall-clock time
  to read as separate arrivals, or all inside one frame on a warm SQLite cache —
  if the latter, **#1's value drops sharply and should be re-ranked**; and
  (b) whether #3(b)'s FLIP interacts badly with scroll offset.
- **I did not audit the quality of the 13 existing `Animated` implementations.**
  That is `improve-animations`, not this skill. One structural observation is
  carried forward anyway because it constrains every recipe here: gesture-handler
  is absent, so every drag in this app is `PanResponder`, and Reanimated 4 is
  present but currently unused for anything.

---

**Handoff.** Any row in Part 1 becomes a self-contained implementation plan via
`improve-animations plan <row>`. Start with #2 (cheapest, fixes a real feedback
defect), then #1 (highest leverage, but confirm the timing assumption on a device
first), then #3.
