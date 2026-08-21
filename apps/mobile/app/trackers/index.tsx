import { useAuth } from '@clerk/clerk-expo';
import { Stack, useFocusEffect, useRouter } from 'expo-router';
import { useCallback, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, View as RNView, View } from 'react-native';

import { Text } from '@/components/Themed';
import { Icon } from '@/components/ui/Icon';
import { trackerFill, vola } from '@/constants/Colors';
import { useAccent } from '@/lib/AccentProvider';
import { request as requestSync } from '@/lib/sync';
import { localTrackers, reorderTrackers, MAX_LIVE_TRACKERS } from '@/lib/trackers';
import { unitNoun, pluralise, targetCount, type Tracker } from '@/lib/trackerModel';

/**
 * Every tracker the athlete is running, in the order Today shows them.
 *
 * ## Why this screen exists at all
 *
 * Today draws the first three and collapses the rest, so WHICH three is a
 * decision the athlete has to be able to make. That is the whole reason
 * reorder is in N78 rather than filed as a nicety: a cap plus a collapse
 * without a reorder is the app choosing which of your trackers matter.
 *
 * ## Up and down buttons, not drag-and-drop
 *
 * Drag is the obvious build and it is the wrong one here, for two reasons that
 * both bite this app specifically:
 *
 * - **VoiceOver cannot perform a drag.** A reorderable list behind a gesture no
 *   screen reader can produce is a list a blind athlete cannot reorder, on the
 *   screen that decides what appears on their Today.
 * - It needs a gesture-handler list and a long-press that fights the scroll,
 *   for at most eight rows.
 *
 * Two buttons per row are boring, reachable one-handed, and announce themselves.
 * `accessibilityLabel` says the destination — "Move Creatine up, to position 2"
 * — because "up" alone tells somebody who cannot see the list nothing about
 * what happened.
 */
export default function TrackersScreen() {
  const router = useRouter();
  const accent = useAccent();
  const { userId } = useAuth();
  const [trackers, setTrackers] = useState<Tracker[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!userId) return;
    const view = await localTrackers(userId);
    setTrackers(view.state === 'ready' ? view.trackers : []);
  }, [userId]);

  useFocusEffect(
    useCallback(() => {
      let live = true;
      void load().catch(() => {
        if (live) setTrackers([]);
      });
      return () => {
        live = false;
      };
    }, [load]),
  );

  async function move(index: number, by: -1 | 1) {
    if (!userId || !trackers) return;
    const to = index + by;
    if (to < 0 || to >= trackers.length) return;
    // Reordered in the local array first and rendered from that, so the row
    // moves under the thumb rather than after a round trip to SQLite.
    const next = [...trackers];
    [next[index], next[to]] = [next[to], next[index]];
    setTrackers(next);
    try {
      await reorderTrackers(
        userId,
        next.map((t) => t.id),
      );
      requestSync('trackers reordered');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'That order could not be saved.');
      // Re-read rather than trusting the optimistic array: if the write failed
      // the screen must show what is actually stored, not what was attempted.
      await load().catch(() => {});
    }
  }

  return (
    <View style={styles.screen}>
      <Stack.Screen options={{ title: 'Trackers' }} />
      <ScrollView contentContainerStyle={styles.container}>
        {trackers === null ? (
          <Text style={styles.note} testID="trackers-manage-loading">
            Loading…
          </Text>
        ) : trackers.length === 0 ? (
          <Text style={styles.note} testID="trackers-manage-empty">
            Nothing is being tracked yet.
          </Text>
        ) : (
          <>
            <Text style={styles.caption}>
              Today shows the first three. Move the ones you want there to the top.
            </Text>
            {trackers.map((t, i) => (
              <RNView key={t.id} style={styles.row}>
                <Pressable
                  style={styles.rowBody}
                  onPress={() => router.push(`/trackers/${t.id}`)}
                  accessibilityRole="button"
                  accessibilityLabel={`${t.name}, position ${i + 1} of ${trackers.length}. Edit it.`}
                  testID={`tracker-manage-${t.id}`}
                >
                  <RNView style={[styles.dot, { backgroundColor: trackerFill(t.color_key) }]} />
                  <RNView style={styles.rowText}>
                    <Text style={styles.rowName}>
                      {t.icon ? `${t.icon}  ` : ''}
                      {t.name}
                    </Text>
                    <Text style={styles.rowMeta}>{describe(t)}</Text>
                  </RNView>
                </Pressable>
                <Pressable
                  onPress={() => void move(i, -1)}
                  disabled={i === 0}
                  hitSlop={10}
                  style={[styles.arrow, i === 0 && styles.arrowOff]}
                  accessibilityRole="button"
                  accessibilityState={{ disabled: i === 0 }}
                  accessibilityLabel={`Move ${t.name} up, to position ${i}`}
                  testID={`tracker-up-${t.id}`}
                >
                  <Text style={styles.arrowText}>↑</Text>
                </Pressable>
                <Pressable
                  onPress={() => void move(i, 1)}
                  disabled={i === trackers.length - 1}
                  hitSlop={10}
                  style={[styles.arrow, i === trackers.length - 1 && styles.arrowOff]}
                  accessibilityRole="button"
                  accessibilityState={{ disabled: i === trackers.length - 1 }}
                  accessibilityLabel={`Move ${t.name} down, to position ${i + 2}`}
                  testID={`tracker-down-${t.id}`}
                >
                  <Text style={styles.arrowText}>↓</Text>
                </Pressable>
              </RNView>
            ))}
          </>
        )}

        {error ? (
          <Text style={styles.error} testID="trackers-manage-error">
            {error}
          </Text>
        ) : null}

        <Pressable
          onPress={() => router.push('/trackers/new')}
          style={[styles.add, { borderColor: accent.accent }]}
          accessibilityRole="button"
          accessibilityLabel="Track something new"
          testID="tracker-add"
        >
          <Icon name="plus" size={16} color={accent.accent} />
          <Text style={[styles.addText, { color: accent.accent }]}>Track something new</Text>
        </Pressable>
        {trackers && trackers.length >= MAX_LIVE_TRACKERS ? (
          <Text style={styles.hint} testID="trackers-manage-full">
            {`You are tracking ${MAX_LIVE_TRACKERS} things, which is the most at once. ` +
              `Stop one to make room — everything it recorded is kept.`}
          </Text>
        ) : null}

        <Pressable
          onPress={() => router.push('/trackers/archived')}
          style={styles.secondary}
          accessibilityRole="button"
          accessibilityLabel="Trackers you have stopped"
          testID="tracker-archived-link"
        >
          <Text style={styles.secondaryText}>Stopped trackers</Text>
        </Pressable>
      </ScrollView>
    </View>
  );
}

/** "8 cups a day", "5 g once a day", "no target". States it and stops. */
function describe(t: Tracker): string {
  const target = targetCount(t);
  const noun = unitNoun(t);
  if (target == null) return noun ? `${pluralise(noun, 2)}, no target` : 'No target';
  if (target === 1) return noun ? `one ${noun} a day` : 'once a day';
  return `${target} ${pluralise(noun, target) || 'a day'}${noun ? ' a day' : ''}`;
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: vola.bg },
  container: { padding: 20, gap: 10, paddingBottom: 60 },
  caption: { fontSize: 12, color: vola.textDim, marginBottom: 4 },
  note: { fontSize: 14, color: vola.textMuted },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    borderWidth: 1,
    borderColor: vola.line,
    borderRadius: 12,
    backgroundColor: vola.surface,
    paddingLeft: 14,
    paddingRight: 6,
  },
  rowBody: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 14 },
  rowText: { flex: 1, gap: 2 },
  dot: { width: 8, height: 8, borderRadius: 4 },
  rowName: { fontSize: 15, fontWeight: '700', color: vola.text },
  rowMeta: { fontSize: 12, color: vola.textMuted },
  // 44 × 44, because these are the only route to a reorder and they sit beside
  // each other under one thumb.
  arrow: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  arrowOff: { opacity: 0.25 },
  arrowText: { fontSize: 18, fontWeight: '800', color: vola.text },
  add: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    borderWidth: 1.5,
    borderRadius: 12,
    paddingVertical: 14,
    marginTop: 10,
  },
  addText: { fontSize: 15, fontWeight: '800' },
  hint: { fontSize: 12, color: vola.textDim, textAlign: 'center' },
  error: { fontSize: 13, color: vola.danger, fontWeight: '600' },
  secondary: { paddingVertical: 14, alignItems: 'center' },
  secondaryText: { fontSize: 14, fontWeight: '700', color: vola.textMuted },
});
