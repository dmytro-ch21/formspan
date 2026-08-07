import * as Haptics from 'expo-haptics';
import { useEffect, useState } from 'react';
import { Animated, Easing, Modal, Pressable, StyleSheet, View as RNView } from 'react-native';

import { Medal } from '@/components/ui/Medal';
import { Text, View } from '@/components/Themed';
import { vola } from '@/constants/Colors';
import { useAccent } from '@/lib/AccentProvider';
import {
  badgeFor,
  feltFor,
  statsFor,
  subtitleFor,
  type SessionSummary,
} from '@/lib/celebration';
import { RECORD_LABEL } from '@/lib/records';
import { playSound } from '@/lib/sounds';

/**
 * The card a finished session ends on.
 *
 * Everything it draws comes from one plain `SessionSummary`, and that is a
 * constraint rather than a convenience: this is meant to become a shareable
 * image later, and a component that reaches into the session screen for its
 * numbers can only ever be rendered by the session screen. Sharing is
 * deliberately NOT built here — but nothing here makes it a rewrite either.
 *
 * ## The flares must never be in the way
 *
 * They run on the native driver, last well under a second, and sit behind a
 * `pointerEvents="none"` layer, so Done is tappable from the first frame. The
 * failure this avoids is a celebration that has to be waited out — an athlete
 * who finished their session wants to put the phone down, and an animation
 * standing between them and that is worse than no animation.
 *
 * Nothing here gates the sync either: the session was already finished and
 * pushed by the time this mounts. This is a report, not a step.
 */

/** Enough to read as a burst, few enough to stay cheap on an old phone. */
const FLARE_COUNT = 14;
const FLARE_MS = 850;

function Flares({ color }: { color: string }) {
  const [seeds] = useState(() =>
    // Fixed at mount so a re-render cannot re-roll the pattern mid-flight,
    // which would look like a stutter rather than a burst.
    Array.from({ length: FLARE_COUNT }, (_, i) => {
      const angle = (i / FLARE_COUNT) * Math.PI * 2;
      return {
        // Slight radius variation, so it reads as a burst rather than a clock face.
        dx: Math.cos(angle) * (90 + ((i * 37) % 60)),
        dy: Math.sin(angle) * (70 + ((i * 53) % 50)),
        size: 5 + ((i * 7) % 5),
      };
    }),
  );
  const [t] = useState(() => new Animated.Value(0));

  useEffect(() => {
    Animated.timing(t, {
      toValue: 1,
      duration: FLARE_MS,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: true,
    }).start();
  }, [t]);

  return (
    <RNView style={styles.flareLayer} pointerEvents="none">
      {seeds.map((s, i) => (
        <Animated.View
          key={i}
          style={[
            styles.flare,
            {
              width: s.size,
              height: s.size,
              backgroundColor: color,
              opacity: t.interpolate({ inputRange: [0, 0.7, 1], outputRange: [1, 0.8, 0] }),
              transform: [
                { translateX: t.interpolate({ inputRange: [0, 1], outputRange: [0, s.dx] }) },
                { translateY: t.interpolate({ inputRange: [0, 1], outputRange: [0, s.dy] }) },
                { scale: t.interpolate({ inputRange: [0, 1], outputRange: [1, 0.4] }) },
              ],
            },
          ]}
        />
      ))}
    </RNView>
  );
}

export function SessionCelebration({
  summary,
  formatTonnage,
  onDismiss,
  testID = 'session-celebration',
}: {
  summary: SessionSummary;
  /** Injected so the card never has to know about unit preferences. */
  formatTonnage: (kg: number) => string;
  onDismiss: () => void;
  testID?: string;
}) {
  const accent = useAccent();
  const badge = badgeFor(summary);
  const stats = statsFor(summary, formatTonnage);
  const felt = feltFor(summary);

  useEffect(() => {
    // The haptic is the part that lands even face-down in a bag; the sound
    // covers the phone being on a bench. Both are best-effort.
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
    playSound('sessionComplete');
  }, []);

  return (
    <Modal transparent animationType="fade" onRequestClose={onDismiss} visible>
      <View style={styles.scrim} testID={testID}>
        <View style={styles.card}>
          <RNView style={styles.crest}>
            <Flares color={accent.accent} />
            {badge ? (
              <Medal tier="gold" size={54} />
            ) : (
              <RNView style={[styles.tick, { borderColor: accent.accent }]}>
                <Text style={[styles.tickMark, { color: accent.ink }]}>✓</Text>
              </RNView>
            )}
          </RNView>

          <Text style={styles.title}>{summary.title || 'Session complete'}</Text>
          <Text style={styles.subtitle}>{subtitleFor(summary)}</Text>

          {badge && (
            <RNView style={[styles.badge, { borderColor: accent.accent }]}>
              <Text style={[styles.badgeText, { color: accent.ink }]} testID="celebration-badge">
                {badge.label}
              </Text>
            </RNView>
          )}

          {/* What the session measurably was. */}
          <RNView style={styles.stats}>
            {stats.map((s) => (
              <RNView key={s.label} style={styles.stat}>
                <Text style={styles.statValue}>{s.value}</Text>
                <Text style={styles.statLabel}>{s.label}</Text>
              </RNView>
            ))}
          </RNView>

          {/* Kept visually apart, and captioned, because it is a self-rating
              rather than a measurement — and it is absent entirely when effort
              tracking is off, rather than showing a confident zero. */}
          {felt && (
            <RNView style={styles.felt} testID="celebration-felt">
              <Text style={styles.feltLabel}>How it felt</Text>
              <Text style={styles.feltValue}>
                {felt.label}: {felt.value}
              </Text>
            </RNView>
          )}

          {summary.records.length > 0 && (
            <RNView
              style={styles.records}
              // The records arrive a moment AFTER the card opens, so a screen
              // reader that already read it would never learn a PR landed.
              accessibilityLiveRegion="polite"
              testID="celebration-records"
            >
              {summary.records.map(({ exerciseID, record }, i) => (
                <RNView key={`${exerciseID}-${record.kind}-${i}`} style={styles.recordRow}>
                  <Medal tier="gold" size={18} />
                  <Text style={styles.recordName} numberOfLines={1}>
                    {exerciseID.replace(/-/g, ' ')}
                  </Text>
                  <Text style={styles.recordKind}>{RECORD_LABEL[record.kind]}</Text>
                </RNView>
              ))}
            </RNView>
          )}

          <Pressable
            onPress={onDismiss}
            style={[styles.done, { backgroundColor: accent.accent }]}
            accessibilityRole="button"
            testID="celebration-done"
          >
            <Text style={[styles.doneText, { color: accent.on }]}>Done</Text>
          </Pressable>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  scrim: {
    flex: 1,
    backgroundColor: 'rgba(8,11,18,0.86)',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24,
  },
  card: {
    width: '100%',
    maxWidth: 380,
    borderRadius: 22,
    borderWidth: 1,
    borderColor: vola.line,
    backgroundColor: vola.surface,
    padding: 24,
    alignItems: 'center',
    gap: 10,
  },
  crest: { height: 74, alignItems: 'center', justifyContent: 'center', alignSelf: 'stretch' },
  flareLayer: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    alignItems: 'center',
    justifyContent: 'center',
  },
  flare: { position: 'absolute', borderRadius: 999 },
  tick: {
    width: 56,
    height: 56,
    borderRadius: 999,
    borderWidth: 2,
    alignItems: 'center',
    justifyContent: 'center',
  },
  tickMark: { fontSize: 26, fontWeight: '800' },
  title: { fontSize: 22, fontWeight: '800', textAlign: 'center' },
  subtitle: { fontSize: 13, color: vola.textMuted, textAlign: 'center' },
  badge: {
    borderWidth: 1,
    borderRadius: 999,
    paddingHorizontal: 12,
    paddingVertical: 5,
    marginTop: 2,
  },
  badgeText: { fontSize: 12, fontWeight: '800', textTransform: 'uppercase', letterSpacing: 0.6 },
  stats: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'center',
    gap: 20,
    marginTop: 12,
  },
  stat: { alignItems: 'center', minWidth: 64 },
  statValue: { fontSize: 20, fontWeight: '800', fontVariant: ['tabular-nums'] },
  statLabel: { fontSize: 11, color: vola.textDim, textTransform: 'uppercase', letterSpacing: 0.5 },
  felt: {
    marginTop: 10,
    paddingTop: 10,
    borderTopWidth: 1,
    borderTopColor: vola.lineSoft,
    alignSelf: 'stretch',
    alignItems: 'center',
  },
  feltLabel: {
    fontSize: 10,
    color: vola.textDim,
    textTransform: 'uppercase',
    letterSpacing: 0.6,
  },
  feltValue: { fontSize: 13, color: vola.textMuted, marginTop: 2 },
  records: { alignSelf: 'stretch', gap: 8, marginTop: 12 },
  recordRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  recordName: { flex: 1, fontSize: 13, fontWeight: '600', textTransform: 'capitalize' },
  recordKind: { fontSize: 11, color: vola.textDim },
  done: {
    marginTop: 18,
    alignSelf: 'stretch',
    borderRadius: 14,
    paddingVertical: 15,
    alignItems: 'center',
  },
  doneText: { fontWeight: '800', fontSize: 16 },
});
