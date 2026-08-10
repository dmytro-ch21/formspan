import * as Haptics from 'expo-haptics';
import { useCallback, useEffect, useRef, useState } from 'react';
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
  type SessionSummary,
} from '@/lib/celebration';
import { RECORD_LABEL } from '@/lib/records';
import { cardFromSummary } from '@/lib/sessionCard';
import { getSessionCard, type SessionCardNumbers } from '@/lib/sessionCardApi';
import { useAuthToken } from '@/lib/useAuthToken';
import { shareCard } from '@/lib/shareCard';
import { SessionCard } from '@/components/SessionCard';
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
  streak = null,
  recordsSettled = false,
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
  const getToken = useAuthToken();
  const badge = badgeFor(summary);
  const stats = statsFor(summary, formatTonnage);
  const felt = feltFor(summary);

  const cardRef = useRef<RNView>(null);
  const [sharing, setSharing] = useState(false);
  const [shareError, setShareError] = useState<string | null>(null);

  // The server's numbers, once they arrive. The card is COMPLETE without them
  // — duration, volume and PRs all come from the local store — so this never
  // blocks the celebration and a gym dead-spot costs the calorie figure rather
  // than the moment.
  const [numbers, setNumbers] = useState<SessionCardNumbers | null>(null);
  useEffect(() => {
    if (!sessionID) return;
    const c = new AbortController();
    getSessionCard(getToken, sessionID, c.signal)
      .then((n) => {
        if (!c.signal.aborted) setNumbers(n);
      })
      .catch(() => {
        // Silent by design. See above: these decorate, they do not carry.
      });
    return () => c.abort();
  }, [sessionID, getToken]);

  const card = sessionID
    ? cardFromSummary({ id: sessionID, summary, stats, streak, numbers })
    : null;

  const onShare = useCallback(async () => {
    if (sharing) return;
    setSharing(true);
    setShareError(null);
    const result = await shareCard(cardRef);
    // A dismissed share sheet is an ordinary outcome and stays quiet; a device
    // that cannot share at all, or an image that was never produced, both get a
    // message. `capture` used to be folded in with the dismissal, so a genuine
    // failure rendered as Share → "Preparing…" → Share and said nothing.
    if (!result.ok && result.reason !== 'failed') setShareError(result.message);
    setSharing(false);
  }, [sharing]);

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
  const chimed = useRef(false);
  useEffect(() => {
    if (!hasRecords || chimed.current) return;
    chimed.current = true;
    const t = setTimeout(() => playSound('pr'), 1100);
    return () => clearTimeout(t);
  }, [hasRecords]);

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
    hasRecords,
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

          {shareError && (
            <Text style={styles.shareError} accessibilityLiveRegion="polite">
              {shareError}
            </Text>
          )}

          <RNView style={styles.actions}>
            {card && (
              <Pressable
                onPress={onShare}
                disabled={sharing}
                style={styles.share}
                accessibilityRole="button"
                accessibilityLabel="Share this session"
                testID="celebration-share"
              >
                <Text style={styles.shareText}>{sharing ? 'Preparing…' : 'Share'}</Text>
              </Pressable>
            )}
            <Pressable
              onPress={onDismiss}
              style={[styles.done, { backgroundColor: accent.accent }, card && styles.doneShrunk]}
              accessibilityRole="button"
              testID="celebration-done"
            >
              <Text style={[styles.doneText, { color: accent.on }]}>Done</Text>
            </Pressable>
          </RNView>
        </View>

        {/*
          The card the export captures, mounted OFF TO THE SIDE rather than
          hidden.

          `captureRef` reads the native view tree, so the card has to be
          genuinely laid out — `display: none` captures nothing and `opacity: 0`
          captures blank on some iOS versions, both of which fail silently and
          hand the athlete an empty image. Positioning it outside the visible
          bounds keeps it real while keeping it out of the way, and
          `pointerEvents="none"` stops it eating taps meant for Done.

          HIDDEN FROM SCREEN READERS TOO, and that is not the same thing as
          hidden from the eye. VoiceOver traverses off-screen elements, so
          without the two props below a VoiceOver user swiping past Done walked
          straight into an invisible duplicate card and heard the wordmark, the
          date, the headline, every stat and — once the fetch lands — the
          calorie figure and the score. The feed's posts hide their card the
          same way, for the same reason.
        */}
        {card && (
          <RNView
            style={styles.offscreen}
            pointerEvents="none"
            accessibilityElementsHidden
            importantForAccessibility="no-hide-descendants"
          >
            <SessionCard ref={cardRef} data={card} width={360} />
          </RNView>
        )}
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  actions: { flexDirection: 'row', gap: 10, alignItems: 'center' },
  share: {
    flex: 1,
    minHeight: 48,
    borderRadius: 14,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: vola.line,
    alignItems: 'center',
    justifyContent: 'center',
  },
  shareText: { fontSize: 15, fontWeight: '700', color: vola.text },
  doneShrunk: { flex: 1 },
  shareError: { fontSize: 12, color: vola.textMuted, textAlign: 'center', marginBottom: 8 },
  // Far enough left that no phone shows it, still laid out so it can be
  // captured. See the comment at the mount site.
  offscreen: { position: 'absolute', left: -10000, top: 0 },
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
  done: {
    marginTop: 18,
    alignSelf: 'stretch',
    borderRadius: 14,
    paddingVertical: 15,
    alignItems: 'center',
  },
  doneText: { fontWeight: '800', fontSize: 16 },
});
