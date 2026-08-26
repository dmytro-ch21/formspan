import { ActivityIndicator, StyleSheet } from 'react-native';

import { Text, View } from '@/components/Themed';
import { vola } from '@/constants/Colors';
import type { Reading } from '@/lib/progress';

/**
 * The four things a Progress section says when it is not showing content.
 *
 * One component rather than four inline ternaries per section, because the
 * whole point of {@link Reading} is that these four are DIFFERENT sentences and
 * a hand-written branch is where two of them quietly become one. Every section
 * on this tab routes its non-`ready` states through here, so the vocabulary is
 * enforced by construction: there is no way to render "nothing logged" from a
 * `checking`, because `checking` does not reach the copy.
 *
 * The copy for each state, and why:
 *
 *  - **`checking`** — a spinner with a spoken label, no words. Any sentence
 *    here is a claim about data that has not arrived.
 *  - **`unavailable`** — "couldn't load", never "you have none". A gym
 *    dead-spot is not an empty training history.
 *  - **`off`** — names the discipline and says it is off, so the athlete can
 *    tell "turned off" from "not built" from "broken". N61 in one line.
 *  - **`empty`** — the only state allowed to invite the athlete to start.
 */
export function ReadingState({
  reading,
  /** What is missing, in the athlete's words: "your training", "your records". */
  subject,
  /** The invitation shown when the answer really is "nothing yet". */
  empty,
  /** Named when the module behind this is off — "BJJ", "Nutrition". */
  offLabel,
  testID,
}: {
  reading: Reading<unknown>;
  subject: string;
  empty: string;
  offLabel?: string;
  testID: string;
}) {
  if (reading.state === 'ready') return null;

  return (
    <View style={styles.card} testID={testID}>
      {reading.state === 'checking' ? (
        <ActivityIndicator accessibilityLabel={`Loading ${subject}`} />
      ) : reading.state === 'unavailable' ? (
        <Text style={styles.muted}>Couldn&apos;t load {subject} just now.</Text>
      ) : reading.state === 'off' ? (
        <Text style={styles.muted}>
          {offLabel ?? 'This'} is turned off. Turn it back on under Sports in your profile and
          this fills in.
        </Text>
      ) : (
        <Text style={styles.muted}>{empty}</Text>
      )}
    </View>
  );
}

/**
 * "Showing the last figures loaded" — the state that is neither fresh nor
 * absent.
 *
 * Separate from {@link ReadingState} because it sits BESIDE content rather than
 * instead of it: there is an answer on screen, it is simply not the newest one.
 * Collapsing the two would mean either hiding real figures behind an error, or
 * presenting stale ones as current — and this app has done the second.
 */
export function StaleNote({ reading, testID }: { reading: Reading<unknown>; testID: string }) {
  const stale = (reading.state === 'ready' || reading.state === 'empty') && reading.stale;
  if (!stale) return null;
  return (
    <Text style={styles.stale} accessibilityLiveRegion="polite" testID={testID}>
      Showing the last figures loaded — couldn&apos;t refresh just now.
    </Text>
  );
}

const styles = StyleSheet.create({
  card: {
    borderWidth: 1,
    borderColor: vola.line,
    borderRadius: 14,
    backgroundColor: vola.surface,
    padding: 14,
    gap: 10,
  },
  muted: { color: vola.textMuted, fontSize: 13, lineHeight: 19 },
  stale: { color: vola.warn, fontSize: 12 },
});
