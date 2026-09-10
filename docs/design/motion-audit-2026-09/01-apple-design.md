# VOLA — Apple interface-design audit

Read-only design audit of `apps/mobile`, `apps/web`, `apps/admin` against the
`apple-design` skill (Apple's *Designing Fluid Interfaces*, *The Details of UI
Typography*, *Principles of Great Design*), with the `animate-expo` skill as the
React Native bar, and VOLA's own `vola-design-system` / `vola-athlete-ux` rules
as the house convention every recommendation extends.

Date: 2026-09-09. Branch: `main` at `f00c6a82`.

---

## Verdict

**The single most consequential thing in this interface is that 411 of 493
`Pressable`s on mobile give no feedback whatsoever when a finger lands on
them — including all 24 on the live-session screen and all 16 on the
food-add screen, the two paths this product is for.** Apple's first principle
("respond on pointer-down, not on release") is not partially met here; on the
highest-traffic surfaces it is simply absent, and the substitute in the live
session is a haptic, which `animate-expo` explicitly forbids as the *only*
feedback because System Haptics is off for many users. Underneath that, the
foundations are genuinely excellent and unusually well-argued: the colour
palette is contrast- and CVD-validated with a script gate, Dynamic Type is
respected everywhere (zero `allowFontScaling={false}`, layout math derived from
`fontScale`), accessibility roles outnumber pressables, the tab bar is the real
platform `NativeTabs`, and the restraint (no glow, no gradient soup, no streak
mechanics) is deliberate and correct. The gap is not taste — it is that the
*interaction layer* was never built to the same standard as the *visual* layer:
`react-native-reanimated@4.5.1` and `react-native-worklets` are installed and
used in **zero** files, while thirteen components hand-roll JS-thread `Animated`
and `PanResponder`, `react-native-gesture-handler` is not a dependency at all,
and there is no duration, easing or pressed-state token anywhere in a repo that
has tokens for everything else. On web the picture is starker and lower-stakes:
199 `hover:` variants, **zero** `active:` variants, zero `prefers-reduced-motion`
across all three apps, and one `tracking-tight` against twenty large-display
headings.

---

## Scorecard

| Dimension (apple-design §) | Rating | One-line justification |
|---|---|---|
| §1 Response — kill latency | **Poor** | 411/493 mobile `Pressable`s have no press state; `app/session/[id].tsx` and `app/food/add.tsx` have zero between them; web has zero `active:` variants. |
| §2 Direct manipulation (1:1) | **Fair** | The two drags that exist (`SwipeToDelete`, `EntryRow`) do track 1:1 and respect the grab offset, but on `PanResponder` over the JS thread. |
| §3 Interruptibility | **Fair** | `SwipeToDelete` and `EntryRow` both capture the current value on grab (correct); nothing else in the app is interruptible because nothing else moves. |
| §4 Behaviour over animation (springs) | **Poor** | Two springs in the whole app, both `bounciness: 0` with no velocity. All other motion is fixed-duration `Animated.timing`. |
| §5 Velocity handoff | **Poor** | `settleTarget()` uses velocity to *decide*, then discards it — the spring gets no `velocity`, so there is a visible seam at every release. |
| §6 Momentum projection | **Absent** | No `project()` anywhere. `SwipeToDelete` uses a fixed `FLICK_VX = 0.3` threshold instead of a projected endpoint. |
| §7 Spatial consistency | **Good** | Sheets enter and leave the same way; `presentation: 'modal'` used correctly for "Add exercise"; nav hierarchy is honest. |
| §8 Hint in direction of gesture | **Poor** | `PeriodSwitcher` changes the week with no directional cue at all — content swaps instantly, so you cannot tell which way you moved. |
| §9 Rubber-banding | **Absent** | `SwipeToDelete.tsx:170` hard-clamps both boundaries; `EntryRow` has no boundary treatment. |
| §10 Gesture design / hit targets | **Fair** | Excellent `hitSlop` discipline in most places, but real sub-44pt targets remain (`WeekStrip.tsx:133`, `Pill.tsx:87`) and zero `pressRetentionOffset` app-wide. |
| §11 Frame-level smoothness | **Fair** | `MacroRings` runs `strokeDashoffset` on the JS thread; the rest-timer bar steps at 4 Hz via `setState`. Neither strobes badly, but neither is smooth. |
| §12 Materials & depth | **Good** | `CardGlass` is a deliberate, well-argued gradient wash rather than a pointless `BlurView`; `NativeTabs` gets real Liquid Glass free. Missing: scroll-edge effects (knowingly declined). |
| §13 Multimodal feedback | **Fair** | Haptics are thoughtfully placed in the timer and set-tick — and completely absent from the reorder drag (pickup, boundary, drop) and from `PeriodSwitcher`'s detents. |
| §14 Reduced motion / a11y | **Fair** | `lib/useReducedMotion.ts` exists and is honoured in exactly 2 of 13 animated components; **zero** `prefers-reduced-motion` in web or admin. |
| §15 Typography | **Fair** | An excellent 7-role scale exists (`constants/Typography.ts`) and is imported by 12 of 179 files; 1,247 raw `fontSize` sites across 28 distinct values remain, including `12.5` and `9`. |
| §16 Foundations (purpose/agency/simplicity/craft) | **Strong** | Best part of this codebase. Every colour, radius and copy decision carries a measured, defensible reason; the no-shame mechanics are structural, not cosmetic. |
| §17 Process | **Strong** | Device-reported bugs drive the work; measurements are recorded next to the code. |

---

## Findings

### HIGH

---

#### H1 — The live-session screen has zero press feedback on 24 controls

**`apps/mobile/app/session/[id].tsx`** — 24 `<Pressable>`, **0** using the
`({ pressed })` style function. The set-done tick, the most-repeated control in a
strength workout (20–30× per session, standing, one-handed, ~20s between sets):

```tsx
// app/session/[id].tsx:3068-3078
<Pressable
  onPress={onToggleDone}
  hitSlop={10}
  style={[styles.tick, set.completed && styles.tickDone]}
  accessibilityRole="checkbox"
  ...
```

```tsx
// app/session/[id].tsx:3706-3715
tick: { width: 34, height: 34, borderRadius: Radius.pill, borderWidth: 1.5, ... },
tickDone: { backgroundColor: vola.lime, borderColor: vola.lime },
```

`style` is a **static array**, not a function — so nothing happens on
touch-down. The only acknowledgement is `Haptics.selectionAsync()` fired inside
`onToggleDone` (line 1211) plus the instant, untransitioned fill flip on
touch-*up*.

**Principle violated:** §1 Response ("Respond on pointer-down, not on release.
Waiting for `click`/touch-up to show feedback feels dead") and §13 Utility /
`animate-expo` §8 ("Never the only feedback. Haptics are off system-wide for
many users, and silent on most Android hardware. The visual has to stand
alone").

`components/Timer.tsx` has the same defect across all 8 of its controls
(`grep -c pressed components/Timer.tsx` → `0`), including the pause button
(`Timer.tsx:421-429`) and the ±15s chips (`Timer.tsx:396-419`) that an athlete
taps mid-rest. `app/food/add.tsx` (16 `Pressable`, 0 pressed) and
`app/checkin/[date].tsx` (4, 0) are the same.

**Fix.** Add a `pressed` style token to `constants/Card.ts` (the file that
already owns "what a surface looks like") and a `PressableScale` primitive
beside `components/ui/Button.tsx`:

```ts
// constants/Card.ts — new export, sibling to Card.base
export const Press = {
  /** The one press transform. 3% and 120ms — animate-expo's ceiling for
   *  something touched tens of times a day. */
  scale: 0.97,
  durationMs: 120,
  /** cubic-bezier(0.23, 1, 0.32, 1) — strong ease-out. */
  easing: 'cubic-bezier(0.23, 1, 0.32, 1)',
  /** For rows that cannot scale (list cells inside a swipe wrapper). */
  surface: vola.surfaceHover,
} as const;
```

Implement with a Reanimated CSS transition (already installed, see H4), not a
shared value — `animate-expo` step 3 is explicit that a two-state press is a
transition, not a worklet:

```tsx
// components/ui/PressableScale.tsx — new
const styles = StyleSheet.create({
  base: {
    transform: [{ scale: 1 }],
    transitionProperty: 'transform',
    transitionDuration: '120ms',
    transitionTimingFunction: 'cubic-bezier(0.23, 1, 0.32, 1)',
  },
  pressed: { transform: [{ scale: 0.97 }] },
});
```

Migrate `components/Timer.tsx`, `app/session/[id].tsx`'s set row and tick, and
`app/food/add.tsx` first — those three are the whole product's daily loop.

---

#### H2 — Six pressed-opacity values are doing the job of one token

The 82 `Pressable`s that *do* have feedback disagree on what feedback means:

```
app/(tabs)/you.tsx:991      pillPressed: { backgroundColor: vola.surfaceHover }
app/library.tsx:390         backButtonPressed: { opacity: 0.6 }
components/ui/Pill.tsx:123  pressed: { opacity: 0.7 }
components/ui/Button.tsx:156 pressed: { opacity: 0.85 }
components/ui/PeriodSwitcher.tsx:220 pressed: { opacity: 0.55 }
app/(tabs)/progress.tsx:611 rowPressed: { opacity: 0.85 }
app/exercise/[id].tsx:328   trendRowPressed: { opacity: 0.85 }
```

Six opacity values (0.55, 0.6, 0.7, 0.8, 0.85) plus a background swap, for one
idea. **Principle violated:** §16.4 Familiarity ("things that look the same
must behave the same") and §16.7 Craft ("every spacing, timing and alignment
value is a deliberate choice you can defend"). This is precisely the drift
`constants/Card.ts` was written to end for card borders — *"a card's border was
a coin flip between `vola.line` (219 sites) and `vola.lineSoft` (50 sites) for
the identical visual object"* — reproduced one layer up in the interaction
model.

**Fix.** `Press` in `constants/Card.ts` (H1) is the token. Delete the seven
literals above and route them through it.

---

#### H3 — The reorder drag has no haptic at any of its three moments

`components/food/EntryRow.tsx` — press-and-hold to reorder a food entry, shipped
two commits ago (N553, #1029). `grep -n "Haptics" components/food/EntryRow.tsx
lib/useEntryDrag.ts components/food/MealCard.tsx` returns **nothing**.

```tsx
// components/food/EntryRow.tsx:283-287 — the pickup
? () => {
    flags.arm();
    drag?.onEnterEdit(entry.meal);
    drag?.onStart(entry.id, entry.meal);
  }
```

```tsx
// components/food/EntryRow.tsx:266 — the only visual for "this row is lifted"
{ transform: [{ translateY: lift }, { scale: isDragging ? 1.02 : 1 }] },
```

```tsx
// components/food/EntryRow.tsx:403
lifted: { zIndex: 10, elevation: 10 },
```

Three separate faults in one interaction:

1. **No haptic on pickup.** `animate-expo` §8: *"Something snaps home, a sheet
   detent catches, a drag commits → `Haptics.impactAsync(ImpactFeedbackStyle.Light)`"*.
   A 300ms long-press with no confirmation means the athlete does not know the
   hold registered until they move, which is exactly the moment it is too late
   to find out it didn't.
2. **No haptic when the row crosses a reorder boundary.** iOS fires
   `selectionAsync()` on every position swap; this is the feedback that tells you
   where the row will land without watching.
3. **`scale: isDragging ? 1.02 : 1` snaps.** It is a raw ternary inside an
   `Animated.View`'s transform array — a hard cut from 1.0 to 1.02 the frame
   `activeId` changes. §4 Behaviour over animation, and §16.7 Craft.

**Principle violated:** §13 Causality ("it must be obvious what caused the
feedback — trigger it on the actual causal event") and §13 Harmony ("the visual,
the sound and the haptic must fire on the same frame").

**Fix.**

```tsx
// EntryRow.tsx — pickup (line ~283)
flags.arm();
Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
drag?.onEnterEdit(entry.meal);
drag?.onStart(entry.id, entry.meal);
```

```tsx
// EntryRow.tsx — replace the raw ternary with a driven value
const grow = useRef(new Animated.Value(0)).current;
useEffect(() => {
  Animated.timing(grow, {
    toValue: isDragging ? 1 : 0,
    duration: 150,
    easing: Easing.bezier(0.23, 1, 0.32, 1),
    useNativeDriver: true,
  }).start();
}, [isDragging, grow]);
const scale = grow.interpolate({ inputRange: [0, 1], outputRange: [1, 1.02] });
```

And in `lib/useEntryDrag.ts`, fire `Haptics.selectionAsync()` from whichever
callback computes a new target index, guarded so it fires once per crossing —
the `useAnimatedReaction`-at-a-threshold shape in `RECIPES.md`, or a plain
`useRef` of the last index if staying on `PanResponder`.

---

#### H4 — Reanimated 4 and Worklets are installed and used in zero files

```json
// apps/mobile/package.json
"react-native-reanimated": "4.5.1",
"react-native-worklets": "0.10.1",
```

`grep -rln "react-native-reanimated" app components` → **one** file,
`app/_layout.tsx:29`, and it is the bare side-effect import
`import 'react-native-reanimated';`. Every animated component in the app uses
core `Animated`:

```
app/(tabs)/index.tsx        components/HoldToConfirm.tsx   components/SwipeToDelete.tsx
components/AnimatedSplash.tsx components/LiveHRIndicator.tsx components/TrackerCard.tsx
components/ScreenHeader.tsx  components/SessionCelebration.tsx components/TrackerList.tsx
components/food/EntryRow.tsx components/today/MacroRings.tsx
```

`react-native-gesture-handler` is **not in `dependencies` at all**, and there is
no `GestureHandlerRootView` anywhere in the tree
(`grep -rn "GestureHandlerRootView" app components lib` → empty).

**Principle violated:** `animate-expo` Hard Rule 2 — *"Reanimated, not core
`Animated`. Core `Animated` can't be driven by a gesture without crossing the
bridge, and `useNativeDriver` refuses anything but transform and opacity anyway"*
— and Never Ship: `PanResponder`. `SwipeToDelete.tsx:24-30` argues the tradeoff
honestly ("the honest cost is not 'a new dependency' but a fresh native build"),
but that argument has since expired: the app has been on a development build
since 2026-08-09, Reanimated 4 is already installed and already forces a native
build, and the New Architecture it requires is already on.

**Consequences that are visible today, not theoretical:**

- `components/today/MacroRings.tsx:156,164` — `duration: 620` with
  `useNativeDriver: false`, because `strokeDashoffset` cannot go native. Four
  rings × 620ms (+380ms delay on overflow) of JS-thread work on the app's most-
  opened screen, competing with the SQLite reads that same screen fires on focus.
- `components/food/EntryRow.tsx:207` — `lift.setValue(g.dy)` per `pointermove`
  on the JS thread, once per row, while `food.tsx` also has to disable the
  scroll view via `setState`.

**Fix.** This is a migration, not a one-line change, and it should be sequenced:

1. `npx expo install react-native-gesture-handler`, wrap `app/_layout.tsx`'s
   root `View` (line 329) in `GestureHandlerRootView`. Nothing changes yet.
2. `components/ui/PressableScale.tsx` (H1) as the first Reanimated CSS-transition
   consumer — no gestures, lowest risk, highest coverage.
3. `components/SwipeToDelete.tsx` → `Gesture.Pan()` with `project()` +
   `rubberband()` (F1, F2 below).
4. `components/food/EntryRow.tsx` → shared value + `useAnimatedStyle`.

Do not migrate `AnimatedSplash` or `HoldToConfirm` — see *What's already right*.

---

#### H5 — Sub-44pt touch targets on the Today screen and on every filter chip

```tsx
// components/today/WeekStrip.tsx:133-142 — no hitSlop, no pressed state
<Pressable
  onPress={onWeekInReview}
  accessibilityRole="button"
  accessibilityLabel="Week in review"
  style={styles.review}
  testID="week-strip-review"
>
  <Text style={styles.reviewLabel}>Week in review</Text>
  <Icon name="chevron" size={13} color={vola.textMuted} />
</Pressable>
```

```tsx
// components/today/WeekStrip.tsx:228-229
review: { flexDirection: 'row', alignItems: 'center', gap: 2 },
reviewLabel: { fontSize: 12, color: vola.textMuted },
```

`review` has no padding and no `hitSlop`, so its height is the 12pt label's line
box — roughly **16pt tall**, on the first screen of the app.

```tsx
// components/ui/Pill.tsx:85-93, 109-123
<Pressable onPress={onPress} hitSlop={6} ... />
base: { paddingVertical: 6, paddingHorizontal: 12, ... },
label: { fontSize: 12, color: vola.textMuted },
```

Pill height = 6 + 6 + ~15 ≈ 27pt; with `hitSlop={6}` the effective target is
**~39pt**, under the floor. `Pill` is the shared component behind every filter
chip, date pill and toggle in the app (N444 consolidated ~15 hand-rolled
variants into it), so this one number is wrong in dozens of places at once.

**Principle violated:** `animate-expo` §7 ("44×44pt minimum touch target. If the
visual is smaller, add `hitSlop` — don't grow the visual") and `vola-athlete-ux`'s
own *"large one-handed controls, accessible contrast and touch targets"*, which
that skill lists as a **design-system property, not a per-screen choice**.

**Fix.** `Pill.tsx:87` → `hitSlop={9}` (27 + 18 = 45pt). `WeekStrip.tsx:228` →
`review: { ..., paddingVertical: 8 }` plus `hitSlop={12}` on the `Pressable`.
Then add the floor as a named constant so it stops being re-derived per site:

```ts
// constants/Spacing.ts — new export beside Spacing/Radius
/** The 44pt floor, expressed as the slop a control of a given height needs. */
export const TOUCH_MIN = 44;
export const slopFor = (visualHeight: number) =>
  Math.max(0, Math.ceil((TOUCH_MIN - visualHeight) / 2));
```

---

### MEDIUM

---

#### M1 — `SwipeToDelete` throws away the velocity it just measured, and hard-stops at both edges

```ts
// components/SwipeToDelete.tsx:126-137
const settle = useCallback(
  (to: number) => {
    rest.current = to;
    setOpen(to !== 0);
    Animated.spring(translate, {
      toValue: to,
      useNativeDriver: true,
      bounciness: 0,
    }).start();
  },
  [translate],
);
```

```ts
// components/SwipeToDelete.tsx:170
translate.setValue(Math.max(-ACTION_WIDTH, Math.min(0, next)));
```

`settleTarget()` (line 85) reads `vx` to decide *which way* the row settles —
correct, and better than most — but `settle()` receives only the target, so the
spring starts from zero velocity. The finger is moving at, say, 800px/s; the row
stops dead and then re-accelerates. That is the seam §5 calls *"the detail that
most separates 'fluid' from 'fine'"*.

Line 170 hard-clamps both boundaries. §9: *"A hard stop reads as 'frozen';
continuous resistance reads as 'responsive, but there's nothing more here'."*

There is also no momentum projection: `FLICK_VX = 0.3` is a fixed threshold
where §6 wants `current + project(v)` compared against the snap points.

**Fix** (as part of the H4 migration to `Gesture.Pan()`):

```ts
.onUpdate((e) => {
  const next = context.get() + e.translationX;
  x.set(next > 0 ? rubberband(next, ACTION_WIDTH)
      : next < -ACTION_WIDTH ? -ACTION_WIDTH + rubberband(next + ACTION_WIDTH, ACTION_WIDTH)
      : next);
})
.onEnd((e) => {
  const projected = x.get() + project(e.velocityX);   // RECIPES.md's project()
  const to = projected < -OPEN_AT ? -ACTION_WIDTH : 0;
  x.set(withSpring(to, { duration: 300, dampingRatio: 1, velocity: e.velocityX }));
  if (to !== 0) scheduleOnRN(Haptics.impactAsync, Haptics.ImpactFeedbackStyle.Light);
})
```

Note the added haptic: the row snapping open to reveal a *destructive* action is
exactly the "a drag commits" moment in `animate-expo`'s table, and it currently
fires nothing.

---

#### M2 — The rest-timer progress bar steps four times a second and re-renders the session screen to do it

```ts
// components/Countdown.tsx:283-287
const id = setInterval(() => {
  const left = remainingAt(timer, Date.now());
  setRemaining(left);
  if (left <= 0 && !firedRef.current) finishRef.current();
}, 250);
```

```tsx
// components/Timer.tsx:481-487
<RNView style={styles.track}>
  <RNView
    style={[
      styles.fill,
      { width: `${Math.max(0, Math.min(1, progress)) * 100}%`, backgroundColor: accent.accent },
    ]}
  />
</RNView>
```

A 90-second rest costs 360 React renders of the session screen and 360 layout
passes on a percentage-width child. The bar advances in 4 visible steps per
second — Timer.tsx:479 describes it as *"drains left to right. Readable from
across a gym"*, which is the intent, but a 4 Hz stair is not a drain.

**Principle violated:** §11 ("Keep the per-frame positional change below the
perception threshold to avoid strobing") and `animate-expo` §4 (the sanctioned
`width` animation is *absolutely positioned and childless*; this one is a flex
child, so its parent re-lays-out).

**Fix.** Keep the 250ms interval for the **digits** — the file's own reasoning
for it is sound and unrelated. Drive the **bar** from a single
`Animated.timing` armed once at `startRest`, running `scaleX` on an absolutely
positioned childless fill with `useNativeDriver: true`, `Easing.linear`, and
duration = remaining ms. Re-arm it on `adjust`/`togglePause` from the value it is
currently at (§3: animate from the presentation value).

```tsx
track: { height: 3, backgroundColor: vola.line, width: '100%', overflow: 'hidden' },
fill:  { position: 'absolute', left: 0, top: 0, bottom: 0, width: '100%',
         transform: [{ scaleX: 1 }], transformOrigin: 'left' },
```

---

#### M3 — The keyboard-aware footer teleports while the keyboard slides

```ts
// components/KeyboardAwareScroll.tsx:677
setInset(lift > 0 ? lift + MARGIN : 0);
```

```ts
// components/KeyboardAwareScroll.tsx:144-146
return os === 'ios'
  ? { show: 'keyboardWillShow', hide: 'keyboardWillHide', changeFrame: 'keyboardWillChangeFrame' }
  : { show: 'keyboardDidShow', hide: 'keyboardDidHide', changeFrame: null };
```

On iOS the `keyboardWillShow` event arrives **before** the keyboard has moved, so
the footer jumps to its final position in one frame and then waits ~250ms in
empty space for the keyboard to arrive under it. On Android `keyboardDidShow`
fires *after*, so the footer lags instead. Both are the exact failure
`RECIPES.md` names: *"the keyboard rides a private system curve, the event
arrives on the JS thread after the keyboard has already started moving, and any
duration you pick will visibly lag or lead it."*

This is on the food-amount sheet (`components/food/AmountSheet.tsx:78`), the BJJ
reflection wizard and sign-in — every screen where a number is typed.

**Fix.** `npx expo install react-native-keyboard-controller`, add
`<KeyboardProvider>` in `app/_layout.tsx` beside the `GestureHandlerRootView`
from H4, and drive the footer from
`useReanimatedKeyboardAnimation().height` — the keyboard's real frame-by-frame
position, on the UI thread. The existing "padding not transform, so the
background reaches the bottom" reasoning at `KeyboardAwareScroll.tsx:611-614` is
correct and survives: translate the footer's *content*, not the footer.

---

#### M4 — `PeriodSwitcher` changes what you are looking at with no direction and no detent

```tsx
// components/ui/PeriodSwitcher.tsx:107-123
<Pressable
  onPress={onPrev}
  hitSlop={16}
  style={({ pressed }) => [styles.step, pressed && styles.pressed]}
  ...
```

`grep -n "Haptics" components/ui/PeriodSwitcher.tsx` → nothing. Pressing ‹ or ›
swaps the entire day's or week's content instantly, with no motion carrying the
old content out in the direction pressed and no `selectionAsync()` marking the
step.

**Principles violated:** §8 ("Humans predict a final state from a trajectory.
Intermediate motion should telegraph where things are going") and `animate-expo`
§8's first row ("A value ticks past a step — picker, slider detent, segmented
control → `Haptics.selectionAsync()`").

**Fix.** Two changes, both small:

1. `Haptics.selectionAsync()` in `onPrev`/`onNext` at the call sites, **on the
   press, not when the content lands** (the tab-indicator recipe's own note).
2. A 180ms directional cross-fade on the content below — content leaves 12pt
   toward the arrow pressed and the new content enters from 12pt on the
   opposite side, at `Easing.bezier(0.23, 1, 0.32, 1)`. This is the "moving on
   screen" case, and 180ms is under the 300ms mobile cap.

Not a swipe gesture on the content. That is worth considering separately (it is
the one-handed answer for a control that sits at the top of the screen), but it
is a product decision about `vola-athlete-ux`'s reachability floor, not a defect
to fix in passing.

---

#### M5 — The type scale exists, is good, and is used by 12 of 179 files

`apps/mobile/constants/Typography.ts` is a genuinely well-derived 7-role scale
— each role bundles `fontSize` + `lineHeight` + `letterSpacing` + `fontWeight`,
which is exactly §15's "build hierarchy from weight + size + leading as a set".

Adoption, measured across `app/` + `components/` excluding tests:

```
files importing constants/Typography:   12 / 179
raw `fontSize:` sites:                  1247
distinct raw fontSize values:           28   (including 12.5 and 9)
`lineHeight:` sites:                    83
```

So ~93% of text in the app renders at React Native's platform-default leading
(≈1.2×), which for 14pt body copy is ~17pt where `Typography.body` correctly
specifies 20. And `fontSize: 9` renders on the Today screen:

```ts
// components/today/WeekStrip.tsx:201
dow: { fontSize: 9, letterSpacing: 0.6, color: vola.textDim, fontWeight: '600' },
```

9pt at `textDim` (#667085 on #10151F), read in gym lighting, is below anything
Apple ships as a legible size.

**Principle violated:** §15 ("Leading tracks size inversely… Tighten headings,
leave body near `0`") and §16.7 Craft.

**Fix.** This is a mechanical migration and should be one ticket per screen, not
one big one — N508 already established the pattern and converted six screens. The
priority order is the five tabs plus `session/[id].tsx`. `WeekStrip.tsx:201`'s
9pt should become `Typography.eyebrow` (11/14/1.2/700) directly.

---

#### M6 — Every sheet in the app is a hand-rolled `<Modal>`; only one route uses a presentation

18 files render `<Modal>`. The entire router declares **one** presentation:

```tsx
// app/_layout.tsx:421-424
<Stack.Screen
  name="session/[id]/add"
  options={{ title: 'Add exercise', presentation: 'modal' }}
/>
```

The pattern everywhere else, e.g. `components/food/AmountSheet.tsx:53-58`:

```tsx
<Modal
  visible={visible}
  animationType="slide"
  presentationStyle="pageSheet"
  onRequestClose={onClose}
>
```

`pageSheet` is a real UIKit sheet and does get drag-to-dismiss free — this is not
broken. But it is **full-height only**: an "Amount" sheet containing one number
field takes the whole screen, which §16.6 Simplicity and §12 ("Dim to focus,
separate to keep flow") both argue against. `presentation: 'formSheet'` with
`sheetAllowedDetents: 'fitToContents'` and `sheetGrabberVisible: true` gives the
half-height sheet the interaction actually is, plus a grabber, plus real detents
with their own haptics — all from the platform.

**Fix.** Convert the short ones first, as routes rather than components:
`components/food/AmountSheet.tsx`, `components/food/EntryMenuSheet.tsx`,
`components/ui/PlanTimeSheet.tsx`, `components/ui/PickSessionSheet.tsx`.
`RECIPES.md`'s three Android caveats apply (three detents max, no grabber, no
nested stack) — all four of these are single-screen content, so none bites.
Leave `components/ui/InfoSheet.tsx` as a `pageSheet`: it is a wall of prose and
genuinely wants the full height.

---

#### M7 — Web has no reduced-motion story at all, and no press feedback at all

```
apps/web/src:   grep -rn "prefers-reduced-motion\|motion-reduce\|motion-safe"  →  0 hits
apps/admin/src: grep -rn "prefers-reduced-motion"                              →  0 hits
apps/mobile:    reduced motion honoured in 2 of 13 animated components
```

Against **90** bare `transition` classes, 6 `transition-colors`, 3
`transition-opacity`, 1 `transition-transform` and 11 `animate-pulse` in
`apps/web`.

Separately:

```
apps/web/src:  hover:  →  199 occurrences
apps/web/src:  active: →  0 occurrences   (the 7 grep hits are React props named `active`)
apps/admin/src: hover: → 2,  active: → 0
```

Every interactive element in the web app is dead on press. On a desktop pointer
the hover state partly covers this; on a touch screen — and this app is reachable
from a phone browser — there is no feedback path at all.

**Principles violated:** §14 (reduced motion is one of three signals a component
must bake in) and §1.

**Fix.** In `apps/web/src/app/globals.css`, inside the existing `@layer base`
block at line 299:

```css
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after {
    animation-duration: 0.01ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: 0.01ms !important;
    scroll-behavior: auto !important;
  }
}
```

And add an `active:` companion wherever a `hover:` exists on a control. The
cheapest version is one shared component class next to `.stat` / `.eyebrow` in
the same file, since those two already establish "a typographic/interaction rule
belongs here, not in a repeated utility string":

```css
/* globals.css — beside .stat and .eyebrow */
.pressable {
  transition: transform 120ms cubic-bezier(0.23, 1, 0.32, 1),
              background-color 120ms cubic-bezier(0.23, 1, 0.32, 1);
}
.pressable:active { transform: scale(0.97); }
```

`apps/admin` should get the same `prefers-reduced-motion` block in
`src/app/globals.css` for consistency, even though it has almost nothing to
disable — it costs four lines and stops the next feature from having to remember.

---

#### M8 — Web large-display type carries no tracking

```
apps/web/src:  text-5xl × 1,  text-4xl × 15,  text-3xl × 4,  text-2xl × 18
               tracking-tight × 1   (app/dashboard/nutrition/layout.tsx:17)
```

```tsx
// apps/web/src/app/dashboard/nutrition/layout.tsx:17 — the only one that gets it right
<h1 className="font-display text-3xl uppercase tracking-tight">Nutrition</h1>
```

Every other 30–48px heading in the app renders at `letter-spacing: 0`.

**Principle violated:** §15 ("Tracking is size-specific — never one value for all
sizes. Large display text wants *negative* tracking (letters read too far apart
as they grow)… A fixed `letter-spacing` is wrong somewhere").

**Fix.** `apps/web/src/app/globals.css` already has the right home for this
alongside `.stat` (which correctly carries `letter-spacing: -0.01em`). Add
size-keyed tracking to `@layer base` so it applies without touching 38 call
sites:

```css
@layer base {
  h1, .text-4xl, .text-5xl { letter-spacing: -0.02em; }
  h2, .text-2xl, .text-3xl { letter-spacing: -0.01em; }
}
```

Mobile already gets this right — `constants/Typography.ts` steps
`-0.1 → -0.2 → -0.3` from `emphasis` to `title` to `display`. This is web
inheriting a decision mobile already made.

---

### LOW

---

#### L1 — No `pressRetentionOffset` anywhere

`grep -rn "pressRetentionOffset" apps/mobile/app apps/mobile/components` → **0**.

§10: *"allow cancel-by-dragging-away and back"*; `animate-expo` §7:
*"`pressRetentionOffset` so a finger drifting a few pixels doesn't cancel a
press the user meant."* On a screen used with sweaty hands between sets, a
2px drift cancelling a set-done tick is a real failure mode.

**Fix.** Bake `pressRetentionOffset={16}` into the `PressableScale` primitive
from H1, so nobody has to remember it per site.

---

#### L2 — `MacroRings` at 620ms + 380ms delay on the app's most-opened screen

```ts
// components/today/MacroRings.tsx:153-171
Animated.timing(base, { toValue: targetBase, duration: 620,
  easing: Easing.out(Easing.cubic), useNativeDriver: false }),
Animated.timing(over,  { toValue: targetOver, duration: 620,
  delay: targetOver > 0 ? 380 : 0, ... }),
```

A one-second sweep, on the Today tab, every cold start and every return to the
tab. `animate-expo` step 1: content the user sees "100+ times/day" gets no
animation; "occasional" gets a standard one, and standard is *"under 300ms"*.
620ms is the delight-tier budget spent on a status readout.

The reduced-motion handling here is exemplary (`MacroRings.tsx:139-151` — it
holds while `reduced === null`, and sets the value rather than showing nothing),
so this is a duration judgement, not a correctness one.

**Fix.** 620 → 400ms, and drop the 380ms overflow delay to 200ms. Combined with
the `useNativeDriver: false` cost noted in H4, this is 1000ms of JS-thread work
becoming 600ms.

---

#### L3 — `AnimatedSplash` fades out on `ease-in`

```ts
// components/AnimatedSplash.tsx:171-176
const anim = Animated.timing(fade, {
  toValue: 0,
  duration: FADE_MS,
  delay: HOLD_MS,
  easing: Easing.in(Easing.quad),
  useNativeDriver: true,
});
```

`animate-expo`'s Never Ship table lists `Easing.in(...)` on a UI element. The
case for it on an *exit* is defensible (nothing is arriving for the user to
watch), and the rest of this component is the best motion in the codebase — so
this is recorded rather than pressed. If it changes, `Easing.bezier(0.23, 1,
0.32, 1)` is the house curve.

---

#### L4 — `apps/admin` has essentially no interaction feedback

31 `.tsx` files, **0** `transition`, **0** `animate-`, **2** `hover:`, **0**
`active:`, **0** `prefers-reduced-motion`. The publish/retire/reactivate buttons
in `src/app/content/` — the console's only write surface, and the ones that
mutate the athlete-facing content catalog — give no acknowledgement of a press.

Weighted LOW deliberately: `apps/admin` is an internal tool with a handful of
users, and the restraint is not wrong in itself. But §16.2 Agency's "forgiveness"
argument applies most sharply to destructive writes, and `RetireButton` /
`PublishButton` are exactly that. One `.pressable` class (M7's) applied to those
three buttons is the whole fix.

---

## What's already right

These should be left alone. Several of them will look like omissions to a later
agent reading only the rubric, so the reasoning is recorded here.

**The tab bar is the real platform tab bar.** `app/(tabs)/_layout.tsx:112-131`
uses `NativeTabs` from `expo-router/unstable-native-tabs` — exactly what
`animate-expo` step 3 prescribes ("the platform's real tab bar, its behaviors
and transitions included"), and it gets iOS 26's Liquid Glass free. The file's
own comment records that the custom underline and pixel-identical cross-platform
appearance were *traded deliberately*, not lost. **Do not add a JS tab
indicator back**, and note that `minimizeBehavior="onScrollDown"` already gives
the scroll-aware chrome §12 asks for.

**Screen transitions are the platform's, unmodified.** `app/_layout.tsx:348-425`
sets no `animation` option on the `Stack` at all, so every push is the native
iOS push with its interactive back gesture intact. `animate-expo`: *"Screen
transition → the platform default — don't override it."* The one deviation is
`presentation: 'modal'` on "Add exercise" (line 423), correctly reasoned:
*"picking an exercise is an interruption of logging, not a place you navigate to
and stay."* The only change worth making here is adding `animation: 'fade'`
under reduced motion.

**`components/HoldToConfirm.tsx` is the best-built interaction in the app.**
`Haptics.impactAsync(Light)` fires on `onPressIn` at line 179 — the causal
moment, same frame as the fill starts; `Easing.linear` at line 182 is correct
for constant progress; `useNativeDriver: true` throughout; a `notificationAsync
(Success)` on completion at line 190; and `usesTapFallback(screenReader)` at
line 196 swaps the whole gesture for an `Alert` when VoiceOver is on. Use this
file as the reference when building anything else.

**The palette is stronger than most shipped design systems.** Every value in
`apps/mobile/constants/Colors.ts` carries a measured contrast ratio and a ΔE
figure under three colour-vision simulations, gated by
`scripts/validate_palette.mjs` in `verify`. The accent/reading split — *"the
accent is identity and interaction; everything that encodes a reading stays
fixed"* (Colors.ts:293-300) — is the correct answer to a user-swappable accent
and it is enforced by an identity check, not a convention. Nothing in this audit
proposes a new colour.

**Dynamic Type is honoured throughout.** Zero `allowFontScaling={false}` in 179
files; one deliberate `maxFontSizeMultiplier={1.4}` on an avatar initial
(`components/Avatar.tsx:91`); and layout math derived from the live scale rather
than hardcoded — `fabClearance(fontScale) = 44 + 20 * fontScale`
(`app/(tabs)/index.tsx:124-126`), with `ScreenHeader` measuring the wordmark's
clearance from real rendered widths. §15's *"Scale layout with the text"* is met
better here than in most native apps.

**Accessibility is not an afterthought.** 563 `accessibilityRole` declarations
against 493 `Pressable`s. `SwipeToDelete.tsx:196-201` hides the delete action
from the accessibility tree when closed *and* explains why `pointerEvents` alone
is insufficient. `EntryRow.tsx:307-310` switches role between `checkbox` and
`button` depending on mode. `InfoSheet.tsx:66` names the section a mark explains
rather than saying "info". This is craft.

**`CardGlass` is the right material call.** `components/ui/CardGlass.tsx:17-29`
declines `expo-blur` because *"behind a card here is this app's own flat,
near-solid `vola.surface` — blurring that costs a native compositing pass to
blur almost nothing."* That is correct, it matches `animate-expo`'s "never
animate `BlurView` intensity" for the same underlying reason, and §12's
translucency guidance does not apply to a surface with nothing behind it. **Do
not "add real blur" to VOLA cards.**

**The plainness of the Progress and Goals screens is correct.**
`app/checkin/trend.tsx`, `components/TrendChart.tsx` and the progress cards
animate nothing and should continue to animate nothing. `TrendChart.tsx:268-279`
exposes the whole chart as one `accessibilityRole="image"` with a spoken summary
— the right call for a read-only figure. Animating a chart the athlete opened
specifically to read a number off delays the number.

**`ScreenHeader`'s refusal of a scroll-edge effect is a costed decision, not an
omission.** `components/ScreenHeader.tsx:188-195`: *"An edge that fades in once
content is beneath it says more. It is not cheap here… `goals.tsx` re-renders
**zero** times while scrolling. A static hairline costs nothing and fixes the
reported bug; take it."* §12 prefers the fade; this codebase priced it and chose
correctly for its own constraints. Leave it.

**The no-glow ruling.** `app/(tabs)/index.tsx:2105-2107` and
`components/ui/Button.tsx:21-29` both record that the user asked twice for no
haze, and that the "modern and transparent" brief was resolved as a
semi-transparent fill rather than a shadow. §16.1 Purpose. Any later agent
reading §12's "deeper shadow than small chips" must not reopen this.

**No streaks, structurally.** `vola-athlete-ux` forbids day streaks in
*mechanics*, and `WeekStrip.tsx:121-132` implements the substitute — "N of 7
days logged", with an explicit guard against showing a confident zero from a
pending read. §16.3 Responsibility. This is the sort of thing an enthusiasm pass
"improves" into a streak counter; it must not.

---

## Top 10, ranked

| # | Fix | Effort | App | Why it is here |
|---|---|---|---|---|
| 1 | **`Press` token + `PressableScale` primitive**, then migrate `components/Timer.tsx`, `app/session/[id].tsx`'s set row/tick, `app/food/add.tsx` (H1, H2, L1) | **M** | mobile | Apple's first principle, absent on the two screens the product exists for. One primitive fixes 40+ controls and closes the six-opacity drift at the same time. |
| 2 | **Three haptics in the food reorder drag** — pickup, boundary crossing, drop — plus a 150ms scale on lift (H3) | **S** | mobile | Ships in a feature merged two commits ago that the user asked for by name. Four lines for the haptics; the scale is ten more. |
| 3 | **`prefers-reduced-motion` block in `apps/web` and `apps/admin` `globals.css`** (M7) | **S** | web, admin | Zero coverage across 100 transitions and 11 infinite `animate-pulse` loops. Eight lines, in a file that already exists. |
| 4 | **Fix the sub-44pt targets**: `Pill.tsx:87` → `hitSlop={9}`, `WeekStrip.tsx:228` → padding + `hitSlop={12}`, add `TOUCH_MIN`/`slopFor` to `constants/Spacing.ts` (H5) | **S** | mobile | `Pill` is the shared chip behind dozens of sites, so one number is wrong everywhere at once. `vola-athlete-ux` calls this a design-system property. |
| 5 | **Install gesture-handler + `GestureHandlerRootView`; migrate `SwipeToDelete` to `Gesture.Pan()`** with `project()`, `rubberband()`, velocity handoff and a commit haptic (H4 steps 1&3, M1) | **M** | mobile | Unblocks every subsequent gesture fix and turns the app's one destructive swipe from "fine" into "fluid". |
| 6 | **`active:` press states across web** — one `.pressable` class in `globals.css`, applied wherever a `hover:` exists (M7) | **M** | web | 199 hover affordances, zero press. On a phone browser the web app currently has no feedback path at all. |
| 7 | **Drive the rest-timer bar from one native-driver animation** instead of a 4 Hz `setState` width (M2) | **S** | mobile | Removes ~360 renders per rest and turns a visible stair into a drain, on the screen the athlete stares at between sets. |
| 8 | **`Haptics.selectionAsync()` + a 180ms directional cross-fade on `PeriodSwitcher`** (M4) | **S** | mobile | Changing the day or week is currently undirected and unmarked — the athlete cannot tell which way they moved. |
| 9 | **`react-native-keyboard-controller` for `KeyboardAwareFooter`** (M3) | **M** | mobile | Fixes a teleporting footer on every numeric-entry screen, including the whole food-logging path. Needs a native rebuild, so batch it with #5. |
| 10 | **Typography migration, five tabs + `session/[id].tsx`**, and size-keyed tracking in web's `globals.css` (M5, M8) | **L** | mobile, web | The scale is already authored and good; this is adoption. 1,247 raw `fontSize` sites and ~93% default leading. Sequence one screen per ticket, as N508 did. |

Deliberately **not** in the top 10: converting the 18 `<Modal>`s to `formSheet`
(M6) — real, but the current `pageSheet` is a native sheet and the win is
proportion, not correctness; and `MacroRings`' 620ms (L2), which is a one-number
change best folded into whichever ticket touches that file next.

---

## Coverage

**Read in full:**

- `~/.claude/skills/apple-design/SKILL.md` (282 lines),
  `~/.claude/skills/animate-expo/SKILL.md` (255),
  `~/.claude/skills/animate-expo/RECIPES.md` (385)
- `.claude/skills/vola-design-system/SKILL.md`, `.claude/skills/vola-athlete-ux/SKILL.md`
- `apps/mobile/`: `constants/Colors.ts` (first 350 lines of ~400),
  `constants/Typography.ts`, `constants/Spacing.ts`, `constants/Card.ts`,
  `components/Themed.tsx`, `components/StyledText.tsx`, `components/ui/Button.tsx`,
  `components/ui/Pill.tsx`, `components/ui/CardGlass.tsx`,
  `components/ui/InfoSheet.tsx`, `components/SwipeToDelete.tsx`,
  `components/food/AmountSheet.tsx`, `app/(tabs)/_layout.tsx`, `app/_layout.tsx`
- `apps/web/src/app/globals.css`, `apps/web/package.json`

**Read in part (targeted sections + full doc comments):**
`components/food/EntryRow.tsx`, `components/Timer.tsx`, `components/Countdown.tsx`,
`components/HoldToConfirm.tsx`, `components/AnimatedSplash.tsx`,
`components/ScreenHeader.tsx`, `components/KeyboardAwareScroll.tsx`,
`components/today/MacroRings.tsx`, `components/today/WeekStrip.tsx`,
`components/ui/ProgressRing.tsx`, `components/ui/PeriodSwitcher.tsx`,
`app/session/[id].tsx` (the set row, tick, haptic call sites and the relevant
styles — not all 3,955 lines), `app/(tabs)/index.tsx` (FAB, clearance math,
Now/Next block).

**Measured by grep/count rather than read** (every number quoted above is from a
command I ran; the commands are reproducible from the paths given): press-state
coverage across all 493 `Pressable`s, `hitSlop` distribution, `fontSize` /
`lineHeight` / `letterSpacing` distribution, Typography/Spacing import counts,
Reanimated/gesture-handler/haptics import maps, `Modal` prop usage, reduced-motion
occurrences, and all `apps/web` / `apps/admin` Tailwind class distributions.

**Not read at all:**

- ~150 of the 179 mobile `.tsx` files, including all of `app/bjj/*`,
  `app/curriculum/*`, `app/trackers/*`, `app/library.tsx` (1,600+ lines),
  `app/(tabs)/workouts.tsx`, `app/(tabs)/progress.tsx`, `app/(tabs)/you.tsx`,
  `app/(tabs)/food.tsx` and `app/food/scan.tsx`. Findings about those screens
  above rest on grep counts and on the shared primitives they compose from, not
  on having read them.
- All 36 `apps/web` page components. Web findings are class-distribution and
  `globals.css` findings only — I have made **no** claim about any individual
  web screen's layout, hierarchy or copy.
- All 31 `apps/admin` components, beyond the class counts in L4.
- `apps/mobile/lib/*` beyond `useReducedMotion.ts`, `tabs.ts` (referenced) and
  the grep sweeps.
- **Anything requiring a device.** I have not seen this app run. Every claim
  about *feel* — the 4 Hz timer stair, the teleporting keyboard footer, the
  velocity seam on swipe release, the 620ms ring sweep, the 9pt day label in gym
  light — is derived from code and from measured values, and each needs a
  release build on a real phone to confirm. `docs/testing/device-checks.md` is
  the right home for that list.
- No test file was read as evidence of behaviour.
