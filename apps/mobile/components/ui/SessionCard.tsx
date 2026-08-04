import { Pressable, StyleSheet, View as RNView } from 'react-native';

import { Text } from '@/components/Themed';
import { vola } from '@/constants/Colors';
import { Icon, type IconName } from '@/components/ui/Icon';
import { sportColor, sportIcon, sportTint } from '@/components/ui/sport';

/**
 * A logged session, as a card rather than a line of text.
 *
 * Replaces a row that put the whole session — sport, set count, duration —
 * into one dot-separated string. That string is fine to read and impossible
 * to *scan*: every row is the same shape, so finding "the long one" or "the
 * one I didn't finish" means reading all of them.
 *
 * So the facts get separate slots. The name leads, the date sits hard right
 * where the eye can run down a column of them, and the measures become chips
 * with an icon apiece — a duration and a set count no longer look identical
 * at a glance.
 *
 * **The left rule is the discipline, and the tick is the state.** The rule used
 * to carry completion — green for finished, amber for open — and that swapped
 * for a reason worth recording, because it trades one scan for another. The
 * old arrangement made "which one did I abandon" findable by running down the
 * left edge. The new one makes "which of these was BJJ" findable instead, and
 * that is the question a mixed list actually raises: completion is already
 * answered at the right-hand end of every row, by a mark that is present or
 * absent rather than a colour that has to be interpreted.
 *
 * The tick is drawn only when the session is finished, and an unfinished one
 * gets the word rather than a dimmed tick — a greyed-out tick reads as "done,
 * dimly", and the distinction between a session you finished and one you
 * abandoned mid-workout is the one thing this list must not blur.
 *
 * The tick stays green on every theme. It is a reading, not chrome.
 */

export type Metric = { icon: IconName; value: string };

export function SessionCard({
  name,
  sport,
  sportKey,
  when,
  metrics,
  complete,
  onPress,
  accessibilityLabel,
  testID,
}: {
  name: string;
  /** The discipline's own label, from the module registry — so "BJJ" stays "BJJ". */
  sport: string;
  /** The raw key, for colour and glyph. Unknown values fall back to neutral. */
  sportKey?: string;
  /** Short and already formatted, e.g. "Mon 28". */
  when: string;
  metrics: Metric[];
  complete: boolean;
  onPress: () => void;
  accessibilityLabel: string;
  testID?: string;
}) {
  const tone = (sportKey && sportColor(sportKey)) || vola.textMuted;
  const glyph = sportKey ? sportIcon(sportKey) : undefined;

  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [styles.card, pressed && styles.pressed]}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      testID={testID}
    >
      <RNView style={[styles.rule, { backgroundColor: tone }]} />

      {glyph && (
        <RNView style={[styles.badge, { backgroundColor: sportTint(tone) }]}>
          <Icon name={glyph} size={18} color={tone} />
        </RNView>
      )}

      <RNView style={styles.body}>
        <RNView style={styles.head}>
          <RNView style={styles.headText}>
            <Text style={[styles.sport, { color: tone }]}>{sport.toUpperCase()}</Text>
            <Text style={styles.name} numberOfLines={1}>
              {name}
            </Text>
          </RNView>
          <Text style={styles.when}>{when}</Text>
        </RNView>

        <RNView style={styles.meta}>
          {metrics.map((m) => (
            <RNView key={m.icon + m.value} style={styles.chip}>
              <Icon name={m.icon} size={13} />
              <Text style={styles.chipText}>{m.value}</Text>
            </RNView>
          ))}

          {/* Pushed to the far end of the same row the measures sit on, so the
              state marker lands in a consistent column down the list. */}
          <RNView style={styles.state}>
            {complete ? (
              <RNView style={styles.tick}>
                <Icon name="check" size={11} color={vola.bg} />
              </RNView>
            ) : (
              <Text style={styles.open}>Unfinished</Text>
            )}
          </RNView>
        </RNView>
      </RNView>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  card: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: vola.surface,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: vola.lineSoft,
    overflow: 'hidden',
  },
  pressed: { backgroundColor: vola.surfaceHover },
  rule: { width: 3, alignSelf: 'stretch' },
  badge: {
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: 'center',
    justifyContent: 'center',
    marginLeft: 12,
  },

  body: { flex: 1, paddingHorizontal: 13, paddingVertical: 11, gap: 9 },
  head: { flexDirection: 'row', alignItems: 'flex-start', gap: 10 },
  headText: { flex: 1, gap: 1 },
  // Colour is set inline, from the discipline.
  sport: { fontSize: 10, fontWeight: '700', letterSpacing: 1 },
  name: { fontSize: 16, fontWeight: '700' },
  when: {
    fontSize: 12,
    color: vola.textMuted,
    fontVariant: ['tabular-nums'],
    marginTop: 1,
  },

  meta: { flexDirection: 'row', alignItems: 'center', gap: 14 },
  chip: { flexDirection: 'row', alignItems: 'center', gap: 5 },
  chipText: {
    fontSize: 13,
    color: vola.textMuted,
    fontWeight: '600',
    fontVariant: ['tabular-nums'],
  },
  state: { flex: 1, alignItems: 'flex-end' },
  tick: {
    width: 19,
    height: 19,
    borderRadius: 10,
    backgroundColor: vola.green,
    alignItems: 'center',
    justifyContent: 'center',
  },
  open: { fontSize: 11, fontWeight: '700', color: vola.warn, letterSpacing: 0.3 },
});
