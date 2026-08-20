import { useRouter } from 'expo-router';
import { useEffect, useState } from 'react';
import { Modal, Pressable, ScrollView, StyleSheet, View as RNView } from 'react-native';

import { Text, View } from '@/components/Themed';
import { Icon } from '@/components/ui/Icon';
import { vola } from '@/constants/Colors';
import { useAccent } from '@/lib/AccentProvider';
import { enabledSports, offSports } from '@/lib/modules';
import type { Module } from '@/lib/modules';
import { cachedWorkouts } from '@/lib/sessionStore';
import type { Workout } from '@/lib/workouts';

/**
 * "What do you want to train?" — one sheet, two callers.
 *
 * Today uses it behind a single **Start something** button; Plan uses it to
 * fill a day. Both need the same list and the same rules about which
 * disciplines can carry a template, so they share the component rather than
 * each growing their own copy — this app has already had three disagreeing
 * copies of the sport list, which is why the registry exists.
 *
 * **This replaced a row of full-width filled buttons on Today.** Every enabled
 * discipline got its own shouted imperative ("Start Strength", then "BJJ"),
 * stacked above the fold, before the screen had said anything about the day.
 * That is a menu wearing the clothes of a primary action: the more disciplines
 * an athlete enables, the louder and less useful the top of their home screen
 * becomes. Behind one press it is a menu again, and Today can lead with what
 * is actually planned.
 *
 * Templates come from the **local cache**, not the network. This sheet opens
 * in a gym, and a picker that needs signal to show you your own workouts is a
 * picker that fails exactly when it is used.
 */

export type Pick = { sport: string; workoutId: string | null; workoutName: string | null };

export function PickSessionSheet({
  visible,
  modules,
  userId,
  title,
  onPick,
  onClose,
}: {
  visible: boolean;
  modules: Module[];
  userId: string | null;
  /** e.g. "Start something" or "Plan Tuesday". */
  title: string;
  onPick: (pick: Pick) => void;
  onClose: () => void;
}) {
  const accent = useAccent();
  const router = useRouter();
  const sports = enabledSports(modules);
  /**
   * Disciplines this athlete could log and has turned off.
   *
   * N61: with BJJ off it was simply absent from this list, and the user
   * reported "bjj logging is not there" from a real phone. This sheet is the
   * ONLY ad-hoc route to it — `/bjj/log` is linked from exactly one other
   * place, a planned session on Today — so an absent row here is the whole
   * feature gone, with nothing saying why.
   *
   * `is_sport` filtered, matching `enabledSports`: nutrition is a module you
   * can turn off and "log a nutrition session" is nonsense, so offering to
   * turn it on from here would be too.
   */
  const offSportList = offSports(modules);
  const [workouts, setWorkouts] = useState<Workout[]>([]);

  // Re-read on each open rather than once on mount: a template created on the
  // Plan tab has to appear here without the app restarting.
  useEffect(() => {
    if (!visible || !userId) return;
    let alive = true;
    cachedWorkouts(userId)
      .then((w) => {
        if (alive) setWorkouts(w);
      })
      .catch(() => {
        // An empty list is the honest fallback — every sport can still be
        // picked bare, which is the row under each heading.
      });
    return () => {
      alive = false;
    };
  }, [visible, userId]);

  return (
    <Modal
      visible={visible}
      animationType="slide"
      presentationStyle="pageSheet"
      onRequestClose={onClose}
    >
      <View style={styles.sheet} lightColor={vola.bg} darkColor={vola.bg}>
        <RNView style={styles.head}>
          <Text style={styles.title}>{title}</Text>
          <Pressable
            onPress={onClose}
            hitSlop={12}
            accessibilityRole="button"
            accessibilityLabel="Close"
            testID="pick-close"
          >
            <Text style={[styles.close, { color: accent.ink }]}>Done</Text>
          </Pressable>
        </RNView>

        <ScrollView contentContainerStyle={styles.body}>
          {sports.length === 0 && (
            <Text style={styles.muted}>
              You haven&apos;t chosen what you train yet. Add a discipline in your profile and it
              shows up here.
            </Text>
          )}

          {sports.map((s) => {
            // A discipline that logs after the fact has no template to pick —
            // the mat sessions this app is built around carry a reflection,
            // not a set list. Its own row is the whole offer.
            const mine = workouts.filter((w) => w.sport === s.key);
            return (
              <RNView key={s.key} style={styles.group}>
                {/* NOT lowercased anywhere: the registry carries the label so
                    "BJJ" stays "BJJ" rather than becoming "Bjj". */}
                <Text style={styles.groupLabel}>{s.label.toUpperCase()}</Text>

                <Pressable
                  style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
                  onPress={() => onPick({ sport: s.key, workoutId: null, workoutName: null })}
                  accessibilityRole="button"
                  accessibilityLabel={`${s.label}, no template`}
                  testID={`pick-${s.key}`}
                >
                  <RNView style={styles.rowMain}>
                    <Text style={styles.rowTitle}>{s.label}</Text>
                    <Text style={styles.rowMeta}>No template — an empty session</Text>
                  </RNView>
                  <Icon name="chevron" size={14} color={vola.textDim} />
                </Pressable>

                {mine.map((w) => (
                  <Pressable
                    key={w.id}
                    style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
                    onPress={() =>
                      onPick({ sport: s.key, workoutId: w.id, workoutName: w.name })
                    }
                    accessibilityRole="button"
                    accessibilityLabel={`${w.name}, ${s.label} template`}
                    testID={`pick-workout-${w.id}`}
                  >
                    <RNView style={styles.rowMain}>
                      <Text style={styles.rowTitle} numberOfLines={1}>
                        {w.name}
                      </Text>
                      <Text style={styles.rowMeta}>
                        {w.items.length === 1 ? '1 exercise' : `${w.items.length} exercises`}
                      </Text>
                    </RNView>
                    <Icon name="chevron" size={14} color={vola.textDim} />
                  </Pressable>
                ))}
              </RNView>
            );
          })}
          {/* What is missing, and why — the other half of N61.
              Only when something IS on: with nothing on, the message above
              already says it, and two prompts saying the same thing is worse
              than one. Listed rather than counted, because "1 discipline is
              off" does not tell you it is the one you were looking for. */}
          {offSportList.length > 0 && sports.length > 0 && (
            <Pressable
              style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
              onPress={() => {
                // Closed BEFORE navigating: a push under a presented modal
                // lands on a screen the athlete cannot see.
                onClose();
                router.push('/profile/edit');
              }}
              accessibilityRole="button"
              accessibilityLabel={`${offSportList.map((m) => m.label).join(' and ')} turned off. Turn on to log`}
              testID="pick-disabled-sports"
            >
              <RNView style={styles.rowMain}>
                <Text style={styles.rowTitle}>
                  {offSportList.map((m) => m.label).join(' · ')} turned off
                </Text>
                <Text style={styles.rowMeta}>Turn on to log these here</Text>
              </RNView>
              <Icon name="chevron" size={14} color={vola.textDim} />
            </Pressable>
          )}
        </ScrollView>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  sheet: { flex: 1 },
  head: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 20,
    paddingTop: 18,
    paddingBottom: 12,
  },
  title: { fontSize: 20, fontWeight: '800' },
  close: { fontWeight: '700', fontSize: 15 },
  body: { paddingHorizontal: 20, paddingBottom: 40, gap: 18 },
  group: { gap: 6 },
  groupLabel: {
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 1.2,
    color: vola.textDim,
    marginBottom: 2,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    backgroundColor: vola.surface,
    borderWidth: 1,
    borderColor: vola.lineSoft,
    borderRadius: 12,
    paddingHorizontal: 14,
    paddingVertical: 12,
  },
  rowPressed: { backgroundColor: vola.surfaceHover },
  rowMain: { flex: 1, gap: 1 },
  rowTitle: { fontSize: 15, fontWeight: '700' },
  rowMeta: { fontSize: 12, color: vola.textDim },
  muted: { color: vola.textMuted, fontSize: 14, lineHeight: 20 },
});
