/**
 * The day's calorie target, at the head of the Food tab.
 *
 * ## Why it is here rather than on a screen of its own
 *
 * N180, decided by the user on 2026-08-26 alongside returning Food to the tab
 * bar: the target belongs **next to the thing it constrains**. It was three
 * taps away on `(tabs)/goals`, which is the same failure the mobile-first rule
 * in `CLAUDE.md` was written for, one size down — `nutrition-design.md` §5 put
 * target-setting on "one web screen", so an athlete could read the reasoning
 * for 2,700 kcal on their phone and had no way to act on it. Making the action
 * reachable and then burying it is that bug with a shorter fuse.
 *
 * So: Food tab, then this row. **Two taps to adjust a target**, and the number
 * is legible without either of them.
 *
 * ## It does not compute anything, and that is the point
 *
 * The target is the ONE number this phone cannot work out for itself — it needs
 * training history the device does not hold. `lib/manualTarget.ts` owns parsing
 * a typed one and `lib/targetHistory.ts` owns the record of them; the fetch,
 * the cache and the day-keying all live in `app/(tabs)/food.tsx`, which already
 * held them for `RemainingBlock`. This component receives the finished
 * {@link TargetView} and renders it. A second derivation here would be a second
 * answer to a question with one right answer.
 *
 * ## All four states are rendered, and all four are reachable
 *
 * `TargetView` is a four-state union rather than `Target | null` because the
 * fourth state is the one that matters. Each is reached by a real path in the
 * screen above:
 *
 *  - `checking` — the initial state, and again on every day step, because
 *    `food.tsx` keys the view to its day.
 *  - `unknown` — no cached target and no successful ask, which is a basement.
 *    **Never phrased as "set one".** Telling an athlete who set a target on web
 *    to go and set it again is the app being wrong rather than uninformed.
 *  - `none` — the server answered and no target covers this day.
 *  - `set` — a number, from the server or the cache.
 *
 * That reachability is not decoration on a docstring: #583 shipped an `empty`
 * prop no code path could produce, and its test had been vacuously green ever
 * since. A state rendered here that the screen cannot construct would be the
 * same thing again.
 *
 * ## Always pressable, in every state
 *
 * Including `checking` and `unknown`. The destination is the same either way —
 * the derivation, the history and the typed-entry form — and a row that goes
 * inert while a fetch is in flight is a row that swallows the tap an athlete
 * has already started making. What changes per state is the LABEL, so nothing
 * is promised that is not known.
 */

import { Pressable, StyleSheet, View } from 'react-native';

import { Text } from '@/components/Themed';
import { Icon } from '@/components/ui/Icon';
import { vola } from '@/constants/Colors';
import { useAccent } from '@/lib/AccentProvider';
import { fmtAmount, type TargetView } from '@/lib/nutrition';

/**
 * What the row shows, per state.
 *
 * `note` is a VISIBLE second line, not an accessibility hint, and that
 * distinction was a review finding worth keeping. The reassurance "logging
 * still works" used to live in `RemainingBlock`'s caption where everyone could
 * read it; suppressing that caption on Food (see `showTarget`) would have left
 * it hint-only — announced to VoiceOver and invisible to everybody else, which
 * is a copy regression wearing an accessibility costume.
 */
function describe(view: TargetView): { value: string; note: string | null; muted: boolean } {
  switch (view.state) {
    case 'set':
      return { value: `${fmtAmount(view.target.kcal)} kcal`, note: null, muted: false };
    case 'none':
      return { value: 'Not set', note: null, muted: true };
    case 'unknown':
      // NOT "not set". This device could not ask; that is a statement about the
      // connection, never about whether the athlete has done the work.
      return { value: 'Cannot check from here', note: 'Logging still works', muted: true };
    case 'checking':
      return { value: 'Checking…', note: null, muted: true };
  }
}

/**
 * What pressing the row does — the SAME in every state, because it is.
 *
 * An `accessibilityHint` is supposed to describe the result of activating a
 * control. The first version varied it per state and used it to carry app
 * status ("Logging still works"), which left a VoiceOver user in the `unknown`
 * state with no indication the row still opened anything — it does, always, by
 * deliberate design.
 */
const HINT = 'Opens your target, how it was worked out, and past targets';

export function TargetRow({
  view,
  onPress,
  testID,
}: {
  /** Everything the screen knows about the day's target. See {@link TargetView}. */
  view: TargetView;
  /** Opens the derivation and the history — `(tabs)/goals`. */
  onPress: () => void;
  testID?: string;
}) {
  const accent = useAccent();
  const { value, note, muted } = describe(view);

  return (
    <Pressable
      onPress={onPress}
      style={styles.row}
      accessibilityRole="button"
      // The label carries the number, so the row answers the question without
      // the athlete having to open anything — the same job the visible value
      // does. The hint carries what the tap will do.
      accessibilityLabel={note ? `Daily target, ${value}. ${note}` : `Daily target, ${value}`}
      accessibilityHint={HINT}
      testID={testID}
    >
      <View style={styles.text}>
        <Text style={styles.label}>Daily target</Text>
        <Text
          style={[styles.value, { color: muted ? vola.textDim : vola.text }]}
          testID={testID ? `${testID}-value` : undefined}
        >
          {value}
        </Text>
        {note && (
          <Text style={styles.note} testID={testID ? `${testID}-note` : undefined}>
            {note}
          </Text>
        )}
      </View>
      {/* Decoration. `Icon` hides itself from assistive technology already —
          it sets `accessible={false}` internally — so the row announces its own
          label and hint and nothing trails them. */}
      <Icon name="chevron" size={14} color={accent.ink} />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
    paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: vola.lineSoft,
  },
  text: { flex: 1 },
  label: {
    fontSize: 11,
    fontWeight: '600',
    textTransform: 'uppercase',
    letterSpacing: 1.1,
    color: vola.textMuted,
  },
  // Tabular figures so the number does not jitter as the target changes, the
  // same treatment `RemainingBlock` gives its two headline figures.
  value: { fontSize: 22, fontWeight: '800', fontVariant: ['tabular-nums'], marginTop: 2 },
  note: { fontSize: 12, color: vola.textMuted, marginTop: 2 },
});
