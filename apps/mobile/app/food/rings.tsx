import { useAuth } from '@clerk/clerk-expo';
import { Stack, router } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, View as RNView } from 'react-native';

import { Text, View } from '@/components/Themed';
import { Icon } from '@/components/ui/Icon';
import { vola } from '@/constants/Colors';
import {
  ringColor,
  DEFAULT_RINGS,
  MIN_RINGS,
  RING_KEYS,
  RING_LABELS,
  parseRings,
  serialiseRings,
  type RingKey,
} from '@/lib/macroRings';
import { PREF_MACRO_RINGS, readPref, writePref } from '@/lib/prefs';

/**
 * `Macros target ⚙` — what Today's rings track.
 *
 * The fourth amendment asked for the rings to be **configurable**, and named
 * this affordance as the hook. It is a screen rather than a sheet because it
 * also has to be the door to the target NUMBERS, which live on Goals — an
 * athlete who opens "Macros target" wanting to change 205g of protein must not
 * hit a dead end that only offers to hide the ring.
 *
 * ## The floor is one ring, and it is enforced here
 *
 * Turning everything off would leave the card a bare circle with a number in
 * it. `parseRings` refuses an empty stored set on read; this refuses to *write*
 * one, by making the last remaining toggle inert rather than by showing an
 * error after the fact. Disabled-with-a-reason beats a rejection.
 */
export default function MacroRingsScreen() {
  const { userId } = useAuth();
  const [stored, setStored] = useState<readonly RingKey[] | null>(null);

  /**
   * DERIVED, not stored, for the signed-out case.
   *
   * Setting state inside the effect for that branch is a cascading render and
   * `react-hooks/set-state-in-effect` is right to flag it — there is nothing
   * asynchronous about "no account, so the defaults apply", so it belongs in
   * render where it is a plain expression.
   */
  const rings = userId ? stored : DEFAULT_RINGS;

  useEffect(() => {
    if (!userId) return;
    let alive = true;
    readPref(userId, PREF_MACRO_RINGS)
      .then((raw) => {
        if (alive) setStored(parseRings(raw));
      })
      // A preference that cannot be read is a preference nobody set — the same
      // fallback `AccentProvider` makes, rather than an error state on a screen
      // whose whole job is a handful of toggles.
      .catch(() => {
        if (alive) setStored(DEFAULT_RINGS);
      });
    return () => {
      alive = false;
    };
  }, [userId]);

  const toggle = useCallback(
    (key: RingKey) => {
      setStored((current) => {
        if (!current) return current;
        const on = current.includes(key);
        if (on && current.length <= MIN_RINGS) return current;
        const next = on ? current.filter((k) => k !== key) : [...current, key];
        const ordered = RING_KEYS.filter((k) => next.includes(k));
        // Optimistic: the toggle moves now and the write follows, because the
        // whole point of the setting is seeing it change.
        if (userId) void writePref(userId, PREF_MACRO_RINGS, serialiseRings(ordered));
        return ordered;
      });
    },
    [userId],
  );

  return (
    <View style={styles.screen}>
      <Stack.Screen options={{ title: 'Macros target' }} />
      <ScrollView contentContainerStyle={styles.body}>
        <Text style={styles.intro}>
          Choose what Today&apos;s rings track. This changes what is drawn, not your targets.
        </Text>

        <View style={styles.group}>
          {rings == null ? (
            <Text style={styles.absent}>Checking…</Text>
          ) : (
            RING_KEYS.map((key) => {
              const on = rings.includes(key);
              const last = on && rings.length <= MIN_RINGS;
              return (
                <Pressable
                  key={key}
                  onPress={() => toggle(key)}
                  disabled={last}
                  accessibilityRole="switch"
                  accessibilityState={{ checked: on, disabled: last }}
                  accessibilityLabel={`${RING_LABELS[key]} ring${
                    last ? ', the last one on and cannot be turned off' : ''
                  }`}
                  style={({ pressed }) => [styles.row, pressed && !last && styles.rowPressed]}
                  testID={`ring-toggle-${key}`}
                >
                  <RNView
                    style={[
                      styles.swatch,
                      { backgroundColor: ringColor(key) ?? vola.textDim },
                      !on && styles.swatchOff,
                    ]}
                  />
                  <RNView style={styles.rowText}>
                    <Text style={styles.rowLabel}>{RING_LABELS[key]}</Text>
                    {last ? (
                      <Text style={styles.rowNote}>Keep at least one ring</Text>
                    ) : null}
                  </RNView>
                  <RNView style={[styles.check, on && styles.checkOn]}>
                    {on ? <Icon name="check" size={12} color={vola.bg} /> : null}
                  </RNView>
                </Pressable>
              );
            })
          )}
        </View>

        <Pressable
          onPress={() => router.push('/(tabs)/goals')}
          accessibilityRole="button"
          style={({ pressed }) => [styles.link, pressed && styles.rowPressed]}
          testID="ring-open-targets"
        >
          <RNView style={styles.rowText}>
            <Text style={styles.rowLabel}>Set the numbers</Text>
            <Text style={styles.rowNote}>Calories and macro targets live on Goals</Text>
          </RNView>
          <Icon name="chevron" size={16} color={vola.textDim} />
        </Pressable>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  body: { padding: 20, gap: 16 },
  intro: { fontSize: 13, color: vola.textMuted, lineHeight: 19 },
  group: {
    borderWidth: 1,
    borderColor: vola.line,
    borderRadius: 14,
    overflow: 'hidden',
    backgroundColor: vola.surface,
  },
  absent: { fontSize: 13, color: vola.textDim, padding: 14 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingHorizontal: 14,
    paddingVertical: 14,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: vola.line,
  },
  rowPressed: { backgroundColor: vola.surfaceHover },
  swatch: { width: 12, height: 12, borderRadius: 6 },
  swatchOff: { opacity: 0.3 },
  rowText: { flex: 1, gap: 2 },
  rowLabel: { fontSize: 15, color: vola.text },
  rowNote: { fontSize: 11, color: vola.textDim },
  check: {
    width: 22,
    height: 22,
    borderRadius: 11,
    borderWidth: 1,
    borderColor: vola.line,
    alignItems: 'center',
    justifyContent: 'center',
  },
  checkOn: { backgroundColor: vola.lime, borderColor: vola.lime },
  link: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    backgroundColor: vola.surface,
    borderWidth: 1,
    borderColor: vola.line,
    borderRadius: 14,
    paddingHorizontal: 14,
    paddingVertical: 14,
  },
});
