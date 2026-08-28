import { useEffect, useState } from 'react';
import {
  AccessibilityInfo,
  Animated,
  Pressable,
  StyleSheet,
  View as RNView,
  type PressableProps,
} from 'react-native';

import { Text, View } from '@/components/Themed';
import { Icon } from '@/components/ui/Icon';
import { trackerFill, vola } from '@/constants/Colors';
import {
  addLabel,
  amountLine,
  cutoffLine,
  footLine,
  glyphHint,
  glyphLabel,
  glyphSlots,
  glyphState,
  loggedCount,
  progress,
  resolveRenderStyle,
  valueLine,
  type GlyphState,
  type Tracker,
  type TrackerEntry,
} from '@/lib/trackerModel';
import type { UnitSystem } from '@/lib/units';

/**
 * ONE card for every daily tracker.
 *
 * **There is no WaterCard and there will not be a CoffeeCard.** N77's
 * acceptance criterion is that a reviewer can see one row component and one
 * model; N78's is that a created tracker is indistinguishable from water. Both
 * hold because this component knows nothing about what it is drawing beyond the
 * record it is handed — the fill comes from `color_key`, the copy from
 * `trackerModel`, the shape from `resolveRenderStyle`.
 *
 * A pure render, like `NutritionCard` and `CheckinCard`: the screen owns the
 * fetching and passes props. And no self-margin — `styles.body` on Today and
 * Food space their children with `gap`, and a component that insets itself is
 * only correct on the screen it was written against.
 *
 * ## Three shapes, chosen from the record
 *
 * - **glyphs** — a row of cups. Up to twelve, which is roughly where a row
 *   stops being countable and becomes a block you have to tally.
 * - **bar** — past that, with the number stated, because the number is what is
 *   being read at that point.
 * - **dose** — one large glyph when the target is a single tap. The creatine
 *   case, and N78 says it is the most common one.
 *
 * ## What the copy never does
 *
 * There is no praise and no scolding anywhere in here. Crossing a target
 * changes the arithmetic on the foot line and the shape of the glyphs past it,
 * and changes nothing else: no colour shift, no exclamation mark, no word about
 * whether that was a good idea.
 *
 * **N77 added two things here and nothing else** — the foot line now carries
 * `last at 16:40`, and a glyph logged past the target draws a smaller fill. Both
 * are unconditional, driven by the record rather than by which preset it is; a
 * branch on `tracker.preset` anywhere in this file would be the CoffeeCard the
 * first paragraph promises not to grow.
 *
 * **N432 added a generic add-time CHOICE, and it holds the same promise.**
 * `addChoices` is a small, fixed list of named options a caller may offer
 * instead of a plain increment — the coffee tracker's drink-type picker is
 * the first use, but this component takes only labels and keys, never the
 * word "coffee" or "caffeine". `TrackerList` (which DOES know what a coffee
 * tracker is) decides who gets one; see `coffeeCaffeine.ts`.
 */
export function TrackerCard({
  tracker,
  entries,
  units,
  unitsReady,
  now = null,
  onAdd,
  onRemove,
  onEdit,
  addChoices,
  onAddChoice,
  testID,
}: {
  tracker: Tracker;
  entries: TrackerEntry[];
  units: UnitSystem;
  /** Never print a unit-bearing number before the preference has been read. */
  unitsReady: boolean;
  /**
   * The live clock, for a card showing REAL today — `null` for a browsed past
   * day. See `cutoffLine`'s own doc for why the split matters: a countdown or
   * a bare "past your cutoff" is a claim about the CURRENT moment, and neither
   * is true of a day that already ended.
   */
  now?: Date | null;
  onAdd: () => void;
  /** Remove one logged tap, named by its entry id rather than its position. */
  onRemove: (entryID: string) => void;
  onEdit: () => void;
  /**
   * A small set of named options offered at the moment of adding, instead of
   * a plain increment tap — N432. Absent or empty is the ordinary behaviour:
   * `onAdd` fires immediately, from the `+` button and from an empty glyph
   * alike. Present and non-empty replaces BOTH of those with a compact chip
   * row — a SELECTION at tap time, still one-handed, never a full-screen
   * form for a single tap.
   */
  addChoices?: { key: string; label: string; accessibilityLabel?: string }[];
  /** Fires with the picked choice's key. Required whenever `addChoices` is non-empty. */
  onAddChoice?: (key: string) => void;
  testID?: string;
}) {
  const count = loggedCount(entries);
  const style = resolveRenderStyle(tracker, count);
  const fill = trackerFill(tracker.color_key);
  const foot = footLine(tracker, entries);
  const cutoff = cutoffLine(tracker, entries, now);
  const amount = unitsReady ? amountLine(tracker, entries, units) : null;
  const hasChoices = (addChoices?.length ?? 0) > 0;
  // Closed again by a second press of `+`, or by picking a chip — there is no
  // separate "cancel" affordance, and there does not need to be one: `+` is
  // already the control that opened it.
  const [picking, setPicking] = useState(false);
  const handleAdd = hasChoices
    ? () =>
        setPicking((p) => {
          const next = !p;
          // frontend-reviewer, N432 review: opening the chip row moved no
          // focus and announced nothing — a VoiceOver user double-tapped,
          // heard silence, and had to discover the row by swiping. `+`'s own
          // label already changes to say a picker is coming; this states the
          // row's actual arrival, the same way this app announces elsewhere
          // (`goals.tsx`'s `saveManual`/`acceptAdjustment`).
          if (next) AccessibilityInfo.announceForAccessibility('Choose a drink type');
          return next;
        })
    : onAdd;
  const handleChoice = (key: string) => {
    setPicking(false);
    onAddChoice?.(key);
  };
  const addAccessibilityLabel = !hasChoices
    ? addLabel(tracker)
    : picking
      ? `Hide ${tracker.name} choices`
      : `${addLabel(tracker)} — choose a type`;

  return (
    <View style={styles.card} testID={testID ?? `tracker-card-${tracker.id}`}>
      <RNView style={styles.head}>
        {/* The athlete's ICON, which N76 stored and never drew.
            `importantForAccessibility="no"` because it is decoration: the name
            is right beside it as text, and VoiceOver announcing "water droplet,
            Water" reads as a stutter. An emoji with no textual twin would need
            a label; this one is a duplicate of the next element.
            The coloured dot stays as the fallback — the colour is how a card is
            picked out of a stack of them, so it cannot depend on an icon the
            athlete may not have chosen. */}
        {tracker.icon ? (
          <Text
            style={styles.icon}
            importantForAccessibility="no"
            accessibilityElementsHidden
            testID={`tracker-icon-${tracker.id}`}
          >
            {tracker.icon}
          </Text>
        ) : (
          <RNView style={[styles.dot, { backgroundColor: fill }]} />
        )}
        {/* Uppercased by STYLE, never by `.toUpperCase()`. VoiceOver spells out
            short all-caps strings letter by letter, so a transformed name reads
            as "W-A-T-E-R"; `textTransform` leaves the accessible string intact
            and changes only the glyphs drawn. */}
        <Text style={[styles.eyebrow, { color: fill }]} numberOfLines={1}>
          {tracker.name}
        </Text>
        <Pressable
          onPress={onEdit}
          // 16pt icon + 14 all round = 44pt, the iOS minimum. It was 12, which
          // is 40 — near enough to look fine and not near enough to be right.
          hitSlop={14}
          accessibilityRole="button"
          // The overflow control is the ONLY route to the target on a phone, so
          // its label says what it opens rather than "more". "Everything should
          // be manageable on the phone" is a hard rule, and an unlabelled dot
          // menu is how a setting becomes web-only in practice.
          accessibilityLabel={`${tracker.name} settings`}
          testID={`tracker-menu-${tracker.id}`}
        >
          <Icon name="settings" size={16} color={vola.textMuted} />
        </Pressable>
      </RNView>

      <Text style={styles.value} testID={`tracker-value-${tracker.id}`}>
        {valueLine(tracker, entries)}
        {amount ? <Text style={styles.amount}>{`  ·  ${amount}`}</Text> : null}
      </Text>

      {/* No `accessibilityLabel` here, deliberately, and it used to have one.
          A plain View without `accessible` is not an accessibility element on
          iOS, so the label was never spoken — and adding `accessible` would
          make the row ONE element and swallow every glyph inside it, which is
          strictly worse than the per-glyph labels this design is built on. The
          name and the value are already their own elements above. */}
      <RNView style={styles.row} testID={`tracker-row-${tracker.id}`}>
        <Pressable
          onPress={handleAdd}
          // 30pt drawn + 7 all round = 44pt. This is the PRIMARY affordance on
          // the card — the one an athlete hits several times a day — so it is
          // the one that must not be a near miss.
          hitSlop={7}
          style={[styles.add, { borderColor: fill }]}
          accessibilityRole="button"
          accessibilityLabel={addAccessibilityLabel}
          testID={`tracker-add-${tracker.id}`}
        >
          <Icon name="plus" size={16} color={fill} />
        </Pressable>

        {style === 'bar' ? (
          <Bar tracker={tracker} entries={entries} fill={fill} />
        ) : (
          <Glyphs
            tracker={tracker}
            entries={entries}
            fill={fill}
            single={style === 'dose'}
            onAdd={handleAdd}
            onRemove={onRemove}
          />
        )}
      </RNView>

      {/* N432: the drink-type (or other add-time) choice, shown only while
          picking. A compact chip row rather than a sheet or a full-screen
          form — the one-handed, standing-up discipline this app states
          elsewhere for logging. */}
      {hasChoices && picking ? (
        // frontend-reviewer, N432 review: `radiogroup` on a container of
        // plain `button`s was mismatched semantics — a real radiogroup's
        // children carry `radio`, and picking a chip doesn't leave a
        // selection to reflect (the row closes). `none` — just a container —
        // is honest about what this actually is.
        <RNView
          style={styles.choices}
          accessibilityRole="none"
          testID={`tracker-choices-${tracker.id}`}
        >
          {addChoices?.map((c) => (
            <Pressable
              key={c.key}
              onPress={() => handleChoice(c.key)}
              style={styles.choice}
              // Clears the 44pt touch-target bar this file states elsewhere
              // (the `+`, the glyphs) without inflating the chip's own drawn
              // size — frontend-reviewer, N432 review.
              hitSlop={4}
              accessibilityRole="button"
              accessibilityLabel={c.accessibilityLabel ?? c.label}
              testID={`tracker-choice-${tracker.id}-${c.key}`}
            >
              <Text style={styles.choiceText}>{c.label}</Text>
            </Pressable>
          ))}
        </RNView>
      ) : null}

      {foot == null ? null : (
        <Text style={styles.foot} testID={`tracker-foot-${tracker.id}`}>
          {/* States the arithmetic and when the last one was, and stops. No
              "keep going", no "you did it". The copy is assembled in
              `trackerModel` rather than here so the test that enumerates every
              string this feature can produce and checks none of them carries a
              verdict can actually see it. */}
          {foot}
        </Text>
      )}

      {cutoff == null ? null : (
        <Text style={styles.foot} testID={`tracker-cutoff-${tracker.id}`}>
          {/* N431. Same style as the foot line above and the same rule: a
              stated fact, never a verdict — "cutoff in 1h 20m" and
              "last at 15:40 — past your 16:00 cutoff" read the same register
              as `Over target` on MomentumCard, not a warning colour. */}
          {cutoff}
        </Text>
      )}
    </View>
  );
}

/**
 * The drawn glyph, and the slop that turns it into a touch target.
 *
 * **Measured, not chosen, and the first version was wrong.** It was 22pt with
 * `hitSlop={4}` — a 30pt target, on the one control whose entire purpose is
 * correcting a one-handed mis-tap. The affordance for fixing a fat-finger error
 * was itself fat-finger-hostile, and iOS asks for 44.
 *
 * The horizontal axis cannot reach 44 and that is arithmetic rather than a
 * choice. On a 375pt phone: 375 − 40 (Today's body padding) − 28 (the card's)
 * − 30 (the `+`) − 10 (the row gap) leaves **267pt** for the glyphs. Eight
 * 44pt-wide targets need 394pt. They would wrap to two rows, and eight cups
 * split across two rows is exactly the uncountable block the twelve-glyph cap
 * exists to prevent — so the row idiom and a 44pt width are incompatible, and
 * the row idiom is the feature.
 *
 * So: **34 × 44pt**. Vertical slop is free, so it takes the full 44. Horizontal
 * slop is capped at half the gap — beyond that, adjacent targets OVERLAP, and
 * overlapping targets on identical adjacent glyphs make mis-taps worse rather
 * than better, which would defeat the point. The gap is 8 so the slop can be 4,
 * and 26 + 8 = 34pt wide; eight cups then need 26×8 + 8×7 = 264pt of the 267
 * available, which is why the glyph is 26 and not 28.
 *
 * 34 × 44 clears WCAG 2.5.8 (Minimum, AA) at 24 × 24 with room, and falls short
 * of Apple's 44 × 44 guideline on one axis. Stated rather than hidden. The two
 * controls that CAN be 44 both ways — the `+` and the settings button — are.
 */
const GLYPH = 26;
const GLYPH_GAP = 8;
const GLYPH_SLOP = { top: 9, bottom: 9, left: GLYPH_GAP / 2, right: GLYPH_GAP / 2 };

/**
 * The glyph row.
 *
 * Each glyph is its own button with its own label, which is the accessibility
 * half of the design: eight identically-labelled shapes are unusable with
 * VoiceOver even though every one of them is technically labelled, because
 * somebody swiping through cannot tell where they are.
 */
function Glyphs({
  tracker,
  entries,
  fill,
  single,
  onAdd,
  onRemove,
}: {
  tracker: Tracker;
  entries: TrackerEntry[];
  fill: string;
  single: boolean;
  onAdd: () => void;
  onRemove: (entryID: string) => void;
}) {
  const count = entries.length;
  const slots = single ? 1 : glyphSlots(tracker, count);
  const size = single ? 44 : GLYPH;
  return (
    <RNView style={styles.glyphs}>
      {Array.from({ length: slots }, (_, i) => {
        const state = glyphState(tracker, i, count);
        return (
          <Glyph
            key={i}
            state={state}
            fill={fill}
            size={size}
            label={glyphLabel(tracker, i, slots, state, single)}
            hint={glyphHint(state, single)}
            testID={`tracker-glyph-${tracker.id}-${i}`}
            hitSlop={single ? 4 : GLYPH_SLOP}
            // A filled glyph removes ITS OWN tap; an empty one adds.
            //
            // The entry ID rather than the index, and that is a correctness fix
            // rather than a tidy-up: resolving an index against a freshly-read
            // day at tap time means two quick taps on one glyph can each resolve
            // against a different snapshot and remove two cups. The id names the
            // row the athlete actually pointed at, so the second tap is a no-op.
            //
            // Empty glyphs ADD rather than being disabled. A disabled glyph made
            // the empty hint unreachable — it was suppressed exactly when it
            // applied — and left a VoiceOver user with no add affordance where
            // they already were, forcing a swipe back to the `+`.
            //
            // An OVER-target glyph removes like any other. "Cups past the limit
            // log normally" is an acceptance criterion, and a cup you cannot
            // untap is not logged normally.
            onPress={state === 'empty' ? onAdd : () => onRemove(entries[i].id)}
          />
        );
      })}
    </RNView>
  );
}

/**
 * How far the fill is inset from the border.
 *
 * `FILL_INSET` is the ordinary one — a hairline, so a filled glyph reads as
 * solid. `OVER_INSET` is what draws a cup logged PAST the target: the same
 * colour, at the same opacity, in a smaller square, leaving a ring of surface
 * inside the border.
 *
 * **Shape rather than colour, and deliberately not a warning hue.** N77's
 * criterion is that past-the-limit cups are "visually distinct without being
 * coloured as an error" — `vola.danger` here would be the shame-based
 * messaging this project does not do, wearing a colour instead of a word. It is
 * also not opacity alone, which is one weak channel and the first thing to
 * disappear on a bright screen or under a colour-blind simulation; a size
 * difference survives both, and survives the monochrome palette too.
 *
 * **Not a dashed border**, which was the other candidate — but not for the
 * reason first written here, and the correction is worth keeping. The claim was
 * that React Native falls back to a solid border when `borderStyle` meets
 * `borderRadius` on iOS. That was a real defect historically and **review found
 * it is not true of the version this app ships**: in RN 0.86.2's Fabric renderer
 * `useCoreAnimationBorderRendering` requires a solid border, so a dashed one
 * takes the image path — and `RCTGetDashedOrDottedBorderImage` handles corner
 * radii. So the fallback would not have happened, and the sentence was a
 * remembered bug asserted as a measurement.
 *
 * The decision stands on the argument that survives: a dash pattern inside a
 * 26pt rounded glyph with a 1.5pt border is mush at that scale, and the row can
 * hold twelve of them. A size difference is legible where a dash pattern is
 * texture.
 *
 * It cannot be confused with an EMPTY glyph, and that is arithmetic rather than
 * hope: the row draws `max(target, count)` slots, so the moment one glyph is
 * over the target every slot is filled and there is no empty one on screen to
 * confuse it with. See `glyphState`.
 */
const FILL_INSET = 1.5;
const OVER_INSET = 5;

/**
 * One glyph, filling on a spring.
 *
 * The animation is driven from `state` rather than fired on press, so a glyph
 * that fills because the day was re-read from SQLite — or because another
 * device logged it — animates identically to one the athlete just tapped.
 * `useNativeDriver` because opacity and scale are both compositor properties;
 * this row can be tapped four times in a second and must not go through JS.
 */
function Glyph({
  state,
  fill,
  size,
  label,
  hint,
  onPress,
  testID,
  hitSlop,
}: {
  state: GlyphState;
  fill: string;
  size: number;
  label: string;
  hint: string;
  onPress: () => void;
  testID: string;
  hitSlop: PressableProps['hitSlop'];
}) {
  const filled = state !== 'empty';
  const inset = state === 'over' ? OVER_INSET : FILL_INSET;
  // `useState` with a lazy initialiser rather than `useRef`, and the difference
  // is not cosmetic: reading `.current` during render is what `react-hooks/refs`
  // flags, and this app holds its lint warnings on a ratchet precisely so a new
  // one has to be argued for. The value is created once and never replaced,
  // which is all the animation needs.
  const [t] = useState(() => new Animated.Value(filled ? 1 : 0));
  useEffect(() => {
    Animated.spring(t, {
      toValue: filled ? 1 : 0,
      useNativeDriver: true,
      friction: 7,
      tension: 90,
    }).start();
  }, [filled, t]);

  return (
    <Pressable
      onPress={onPress}
      hitSlop={hitSlop}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityHint={hint}
      // **The LABEL is what carries the state, not this.** With
      // `accessibilityRole="button"` iOS ignores `checked` — so "filled"/"empty"
      // in the label is load-bearing and this is a hint to Android and to any
      // future audit, not a second channel on iOS. Said plainly because the
      // comment here used to claim belt and braces, and it is braces.
      //
      // `role="checkbox"` would make iOS announce the state natively, and then
      // double-announce it against the label. The genuinely better shape for a
      // row of N identical steps is one `adjustable` element with increment and
      // decrement actions — one swipe stop per card instead of up to thirteen —
      // and that is worth doing when N78 makes these rows numerous.
      accessibilityState={{ checked: filled }}
      testID={testID}
    >
      <RNView
        style={[
          styles.glyph,
          { width: size, height: size, borderRadius: size / 3, borderColor: fill },
        ]}
      >
        <Animated.View
          // `margin` and `borderRadius` are not animated: an over-target glyph
          // is a different thing rather than a state the same glyph passes
          // through, and animating the inset would read as the fill shrinking
          // away — which is the "you overdid it" flinch this card must not do.
          style={[
            styles.glyphFill,
            {
              backgroundColor: fill,
              margin: inset,
              borderRadius: Math.max(1, size / 3 - inset),
              opacity: t,
              transform: [{ scaleY: t }],
            },
          ]}
          testID={`${testID}-fill`}
        />
      </RNView>
    </Pressable>
  );
}

/**
 * The bar, for a tracker whose row would not be countable.
 *
 * Deliberately not tappable per-unit: at this scale there is nothing to point
 * at. The `+` adds and the card's own screen removes, which is the honest
 * affordance rather than thirty invisible hit targets.
 */
function Bar({
  tracker,
  entries,
  fill,
}: {
  tracker: Tracker;
  entries: TrackerEntry[];
  fill: string;
}) {
  const p = progress(tracker, entries);
  return (
    <RNView style={styles.barTrack} testID={`tracker-bar-${tracker.id}`}>
      <RNView
        style={[styles.barFill, { backgroundColor: fill, width: `${Math.round(p * 100)}%` }]}
      />
    </RNView>
  );
}

const styles = StyleSheet.create({
  card: {
    borderWidth: 1,
    borderColor: vola.line,
    borderRadius: 14,
    backgroundColor: vola.surface,
    paddingHorizontal: 14,
    paddingVertical: 12,
    gap: 10,
  },
  head: { flexDirection: 'row', alignItems: 'center', gap: 7 },
  dot: { width: 7, height: 7, borderRadius: 4 },
  // No explicit lineHeight: an emoji's own metrics vary by platform, and a
  // fixed one clips the tall ones (🥤, 💊) on Android.
  icon: { fontSize: 14 },
  eyebrow: {
    fontSize: 11,
    fontWeight: '800',
    letterSpacing: 1.4,
    flex: 1,
    textTransform: 'uppercase',
  },
  value: { fontSize: 15, fontWeight: '700', color: vola.text },
  amount: { fontSize: 13, fontWeight: '600', color: vola.textMuted },
  row: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  add: {
    width: 30,
    height: 30,
    borderRadius: 10,
    borderWidth: 1.5,
    alignItems: 'center',
    justifyContent: 'center',
  },
  // Wraps rather than scrolls. `GLYPH_GAP` is load-bearing, not spacing: the
  // horizontal touch slop is half of it, so narrowing this narrows the target.
  // Eight 26pt glyphs at this gap need 264pt of the 267 available on a 375pt
  // phone — see the note on GLYPH. Past twelve the card is a bar, so this never
  // becomes the uncountable block N78 forbids.
  glyphs: {
    flex: 1,
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: GLYPH_GAP,
    alignItems: 'center',
  },
  glyph: {
    borderWidth: 1.5,
    alignItems: 'stretch',
    justifyContent: 'flex-end',
    overflow: 'hidden',
  },
  // No `margin` here: it is per-glyph, because an over-target one insets
  // further. See FILL_INSET / OVER_INSET.
  glyphFill: { flex: 1 },
  barTrack: {
    flex: 1,
    height: 10,
    borderRadius: 5,
    backgroundColor: vola.gridRest,
    overflow: 'hidden',
  },
  barFill: { height: '100%', borderRadius: 5 },
  foot: { fontSize: 12, color: vola.textMuted, fontWeight: '600' },
  // Same chip look `TrackerForm.tsx`'s unit/colour pickers already use —
  // reused as tokens, not as shared code, since that Chips component is
  // private to its own form and this row's selection semantics differ
  // (fires once and collapses, rather than staying toggled on).
  choices: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  choice: {
    borderWidth: 1,
    borderColor: vola.line,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    backgroundColor: vola.surfaceRaised,
  },
  choiceText: { fontSize: 12, fontWeight: '700', color: vola.textMuted },
});
