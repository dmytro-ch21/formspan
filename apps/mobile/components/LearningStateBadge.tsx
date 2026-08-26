import { StyleSheet } from 'react-native';

import { Text } from '@/components/Themed';
import { vola } from '@/constants/Colors';
import { LEARNING_STATE_LABEL, type LearningState } from '@/lib/learningState';

/**
 * The small reading beside a technique's name: Seen, Drilled, Used live,
 * Reliable — see `lib/learningState.ts` for how it is derived.
 *
 * **The label carries the meaning; the colour is redundant encoding, never
 * the only signal.** Same rule this file's neighbours already hold to — the
 * RPE bars in `app/bjj/log.tsx` print their own number precisely so colour is
 * never load-bearing alone, and `LibraryTile` prints a three-letter code
 * beside every hue for the same reason. A learning state read purely off a
 * dot would fail the identical way a bare colour has failed before in this
 * app.
 *
 * Colours are fixed semantic tokens, **not** `useAccent()`. `Colors.ts` is
 * explicit that the accent is identity and interaction — a user preference —
 * while anything that encodes a READING (the RPE ramp, the progression
 * phases) stays off it, because a technique's own evidence must not silently
 * relabel itself the day someone changes their accent colour.
 */
const COLOUR: Record<LearningState, string> = {
  // The floor: known, nothing recorded yet. Deliberately achromatic, the same
  // reasoning `tileHold` documents for a position tile — there is no direction
  // to signal about a technique nobody has touched.
  seen: vola.textDim,
  // Practised, not yet taken live — an informational fact, same use `info`
  // already carries in `LibraryTile`'s DEFEND intent.
  drilled: vola.info,
  // Tried live, short of the reliable bar — a claim still proving itself, the
  // same register `warn` already carries for "uncertain"/"in progress" text
  // elsewhere in this app (`food/describe.tsx`'s `uncertain`, the session
  // screen's `pendingText`).
  live: vola.warn,
  // Landed live enough times to be a pattern rather than a fluke — the same
  // "confirmed good" register `green` already carries (`forgot-password.tsx`'s
  // `subtitleGood`, the progression ramp's `add_reps`).
  reliable: vola.green,
};

export function LearningStateBadge({
  state,
  testID,
}: {
  state: LearningState;
  testID?: string;
}) {
  const colour = COLOUR[state];
  return (
    <Text
      style={[styles.badge, { color: colour, borderColor: colour }]}
      accessibilityLabel={`Learning state: ${LEARNING_STATE_LABEL[state]}`}
      testID={testID}
    >
      {LEARNING_STATE_LABEL[state]}
    </Text>
  );
}

const styles = StyleSheet.create({
  badge: {
    alignSelf: 'flex-start',
    fontSize: 10,
    fontWeight: '700',
    letterSpacing: 0.4,
    textTransform: 'uppercase',
    borderWidth: 1,
    borderRadius: 999,
    paddingHorizontal: 8,
    paddingVertical: 2,
    overflow: 'hidden',
  },
});
