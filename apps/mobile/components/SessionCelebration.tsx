import * as Haptics from 'expo-haptics';
import { useEffect, useRef, useState } from 'react';
import { Animated, Easing, Modal, Pressable, StyleSheet, View as RNView } from 'react-native';

import { Medal } from '@/components/ui/Medal';
import { Text, View } from '@/components/Themed';
import { vola } from '@/constants/Colors';
import { useAccent } from '@/lib/AccentProvider';
import {
  badgeFor,
  celebratesStreak,
  feltFor,
  statsFor,
  subtitleFor,
  type Badge,
  type SessionSummary,
} from '@/lib/celebration';
import { RECORD_LABEL } from '@/lib/records';
import { ShareCardHost, ShareSessionButton, useSessionShare } from '@/components/SessionShare';
import { playSound } from '@/lib/sounds';

/**
 * The card a finished session ends on.
 *
 * Everything it draws comes from one plain `SessionSummary`, and that is a
 * constraint rather than a convenience: the same summary feeds the shareable
 * image, and a component that reaches into the session screen for its numbers
 * could only ever be rendered by the session screen.
 *
 * Sharing itself is NOT built here any more — it lives in `SessionShare`, so
 * that a session read back tomorrow can offer the same card this modal does.
 * This is now one of three callers rather than the only one.
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
  streak = null,
  recordsSettled = false,
  accomplishment = null,
  sessionID,
  testID = 'session-celebration',
}: {
  summary: SessionSummary;
  /** Injected so the card never has to know about unit preferences. */
  formatTonnage: (kg: number) => string;
  onDismiss: () => void;
  /** Weekly streak, once history answers. `carried` means this session did it. */
  streak?: { weeks: number; carried: boolean } | null;
  /** Whether the records lookup has finished — see the chime below. */
  recordsSettled?: boolean;
  /**
   * A BJJ first this session earned, once the server answers.
   *
   * Passed in rather than derived here, because deciding it needs a network
   * call and this component takes no dependencies of its own. Strength passes
   * none and BJJ passes no records, so the two never contend for the one badge
   * slot. `recordsSettled` gates this too — it means "the badge lookup has
   * finished", whichever lookup that is for this sport.
   */
  accomplishment?: { label: string } | null;
  /**
   * The session's id, which the shareable card needs.
   *
   * Optional, and Share is hidden without it rather than disabled: an
   * affordance that is present but cannot work is worse than one that is not
   * there. It also keeps this component renderable by anything that has a
   * summary but no id.
   *
   * NO HANDLE. There was a `handle` prop here that no caller ever passed, so
   * the card's foot always fell back to the wordmark anyway — but dropping it
   * rather than threading it is a decision, not tidying. The exported PNG
   * travels off-platform, and stamping `@handle` on it publishes the athlete's
   * VOLA handle wherever the image lands, which they did not choose by tapping
   * Share. The wordmark is the better mark on a poster and the more private
   * one. The feed builds its cards without a handle for a different reason —
   * the attribution is already above them — and both land in the same place.
   */
  sessionID?: string;
  testID?: string;
}) {
  const accent = useAccent();
  const badge: Badge | null =
    badgeFor(summary) ??
    (accomplishment ? { key: 'accomplishment', label: accomplishment.label } : null);
  const stats = statsFor(summary, formatTonnage);
  const felt = feltFor(summary);

  // The capture, the server's decorating numbers and the error copy all live
  // in `useSessionShare` now, because the same three are needed by every
  // screen that reads a finished session back. See that file for why the card
  // it mounts has to sit at the screen root.
  const share = useSessionShare({ sessionID, summary, formatTonnage, streak });

  useEffect(() => {
    // The haptic is the part that lands even face-down in a bag; the sound
    // covers the phone being on a bench. Both are best-effort.
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
    playSound('sessionComplete');
  }, []);

  /*
    The PR chime, if this session set one.

    Separate from the mount effect because the records are not there yet when
    the card opens — they need the network and arrive a moment later, which is
    why the record rows animate in rather than being part of the first paint.
    That lag is usually enough to keep the two sounds apart on its own, but a
    cached or very fast response would fire both in the same frame, so the
    delay makes the ordering a property rather than a race: `sessionComplete`
    runs ~1.9s, and this lands on its tail instead of its attack.

    Offline, `summary.records` is correctly empty and no PR chime plays —
    see `recordsFromSession`. Silence is the honest answer there: the phone
    cannot know it beat anything, and a chime that fired on a guess would be
    celebrating something the records screen might then disagree with.

    Keyed on the boolean, not the array, so a later refetch that returns the
    same records cannot chime twice; the ref covers the case where the count
    itself changes.

    The ref latches BEFORE the timer, which fails quiet rather than loud: if
    `hasRecords` could go true -> false inside the delay, the cleanup cancels
    the chime and the latch keeps it cancelled. That cannot happen today (the
    records are fetched exactly once per celebration), and losing a chime beats
    firing one for a record that turned out not to exist — but anyone adding a
    refetch path here should re-read this rather than assume it still holds.
  */
  const hasRecords = summary.records.length > 0;
  /*
    A BJJ first takes the SAME slot as a personal record, deliberately.

    It is the mat's equivalent — rare, server-judged, and the larger moment of
    the two whenever it coincides with a streak — so it chimes, and it latches
    the streak out. Reusing the `pr` sound rather than adding a ninth: the sound
    means "something rare just happened", which is exactly what this is, and a
    new one would need the synth script, the bundle list and three more edits to
    say the same thing.
  */
  const earnedBadge = hasRecords || accomplishment != null;
  const chimed = useRef(false);
  useEffect(() => {
    if (!earnedBadge || chimed.current) return;
    chimed.current = true;
    const t = setTimeout(() => playSound('pr'), 1100);
    return () => clearTimeout(t);
  }, [earnedBadge]);

  /*
    The streak chime — ONE celebratory sound per session, and the PR wins.

    `chimed` is shared with the effect above rather than being its own flag,
    which is what makes that precedence hold: whichever fires first latches,
    and the gate on `recordsSettled` guarantees the PR gets to go first when
    there is one. Without it the two lookups race and a fast history would
    latch the PR out — the wrong way round, since a personal record is the
    larger moment and a streak recurs every week.

    Declared after the PR effect on purpose too: within one commit React runs
    them in order, so if both become true together the PR still claims the
    latch.
  */
  const carried = celebratesStreak({
    recordsSettled,
    // `earnedBadge`, not `hasRecords`: on the mat the thing that outranks a
    // streak is the accomplishment, and passing the records-only flag here
    // would chime the streak straight over the top of a BJJ first.
    hasRecords: earnedBadge,
    carried: streak?.carried === true,
  });
  useEffect(() => {
    if (!carried || chimed.current) return;
    chimed.current = true;
    const t = setTimeout(() => playSound('streak'), 1100);
    return () => clearTimeout(t);
  }, [carried]);

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

          {/*
            Shown whenever there IS a streak, not only when this session
            carried it — the number is worth seeing on a Thursday too. The
            chime is the narrower event; the line is the state.
          */}
          {streak && streak.weeks > 0 && (
            <Text
              style={styles.streak}
              // Arrives after the card opens, like the records below it — so a
              // screen reader has to be told, or the line is only ever seen.
              accessibilityLiveRegion="polite"
              testID="celebration-streak"
            >
              {streak.weeks} week{streak.weeks === 1 ? '' : 's'} in a row
            </Text>
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

          {share.error && (
            <Text style={styles.shareError} accessibilityLiveRegion="polite">
              {share.error}
            </Text>
          )}

          {/*
            One row, two buttons, and they have to LINE UP.

            They did not: Done carried `marginTop: 18` and its own vertical
            padding while Share carried a `minHeight`, so side by side the two
            sat at different heights and different depths — the margin pushed
            Done down 18pt inside a row that had already positioned it. The
            spacing belongs to the row (which needs it whether or not Share is
            there) and the sizing belongs to both buttons equally, so
            `alignItems: 'stretch'` settles the height rather than two separate
            guesses at it.
          */}
          <RNView style={styles.actions}>
            <ShareSessionButton
              share={share}
              style={styles.share}
              textStyle={styles.shareText}
              testID="celebration-share"
            />
            <Pressable
              onPress={onDismiss}
              style={[styles.done, { backgroundColor: accent.accent }]}
              accessibilityRole="button"
              testID="celebration-done"
            >
              <Text style={[styles.doneText, { color: accent.on }]}>Done</Text>
            </Pressable>
          </RNView>
        </View>

        <ShareCardHost share={share} />
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  // `stretch` on both axes: across, so a lone Done still spans the card; down,
  // so Share and Done end up the same height without either declaring one.
  actions: {
    flexDirection: 'row',
    alignSelf: 'stretch',
    alignItems: 'stretch',
    gap: 10,
    marginTop: 18,
  },
  share: { flex: 1 },
  shareText: { fontSize: 16, fontWeight: '800' },
  shareError: { fontSize: 12, color: vola.textMuted, textAlign: 'center', marginBottom: 8 },
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
  streak: { fontSize: 12.5, color: vola.textDim, marginTop: 10, letterSpacing: 0.2 },
  records: { alignSelf: 'stretch', gap: 8, marginTop: 12 },
  recordRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  recordName: { flex: 1, fontSize: 13, fontWeight: '600', textTransform: 'capitalize' },
  recordKind: { fontSize: 11, color: vola.textDim },
  // No margin and no vertical padding of its own — the row owns the spacing
  // and `alignItems: 'stretch'` owns the height. Both used to live here, which
  // is what put Done 18pt lower than the Share button beside it.
  done: {
    flex: 1,
    minHeight: 50,
    borderRadius: 14,
    alignItems: 'center',
    justifyContent: 'center',
  },
  doneText: { fontWeight: '800', fontSize: 16 },
});
