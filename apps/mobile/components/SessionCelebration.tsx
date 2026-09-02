import * as Haptics from 'expo-haptics';
import { useEffect, useRef, useState } from 'react';
import { Animated, Easing, Modal, Pressable, StyleSheet, View as RNView } from 'react-native';
import MapView, { Polyline } from 'react-native-maps';

import { Medal } from '@/components/ui/Medal';
import { Text, View } from '@/components/Themed';
import { vola } from '@/constants/Colors';
import { useAccent } from '@/lib/AccentProvider';
import { celebratesMilestone, type Milestone } from '@/lib/milestones';
import {
  badgeFor,
  celebratesRecord,
  celebratesStreak,
  downsampleRoute,
  feltFor,
  regionForRoute,
  statsFor,
  subtitleFor,
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
  formatWeight,
  formatDistance,
  formatPace,
  onDismiss,
  streak = null,
  milestone = null,
  recordsSettled = false,
  accomplishment = null,
  streakSettled = false,
  sessionID,
  testID = 'session-celebration',
}: {
  summary: SessionSummary;
  /** Injected so the card never has to know about unit preferences. */
  formatTonnage: (kg: number) => string;
  /** Same reason: builds the shareable card's PR badge in the athlete's own
   *  unit system. This modal never captions a record itself — see the
   *  de-slugified `exerciseID.replace` below, which is a separate, known
   *  gap — but the card `useSessionShare` mounts underneath it does. */
  formatWeight: (kg: number) => string;
  /**
   * Running only. Injected for the same reason `formatTonnage` is — a run's
   * distance is unit-system-dependent and this modal must not know which one
   * is active. Optional: `statsFor` falls back to plain metres/per-kilometre
   * when either is omitted, which is a real, safe answer, not a broken one.
   */
  formatDistance?: (metres: number) => string;
  /** Same reason as `formatDistance`. */
  formatPace?: (secPerKm: number) => string;
  onDismiss: () => void;
  /** Weekly streak, once history answers. `carried` means this session did it. */
  streak?: { weeks: number; carried: boolean } | null;
  /**
   * A streak rung this session crossed (N19), or null — which is the answer
   * almost every session. Never a running number: see `lib/milestones.ts` for
   * why a countdown to the next rung is deliberately not offered here.
   */
  milestone?: Milestone | null;
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
   * Whether the HISTORY lookup has finished — the mirror of `recordsSettled`.
   *
   * What makes the milestone's precedence real rather than a coin toss. The two
   * lookups race, and declaration order only decides a tie inside one commit;
   * across two fetches the PR would otherwise latch on arrival and silence a
   * once-a-year event. Defaults false, so a caller that does not pass it gets
   * no PR chime at all rather than a wrongly-ordered one — the safe direction.
   *
   * Both callers pass it. The BJJ screen has nothing to gate today (its summary
   * hard-codes `records: []`, so `celebratesRecord` is structurally false
   * there) and passes it anyway, because the day BJJ grows a record equivalent
   * a missing prop would default false and hold that chime forever, looking
   * exactly like a broken lookup.
   */
  streakSettled?: boolean;
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
  const badge = badgeFor(summary, accomplishment);
  const stats = statsFor(summary, formatTonnage, formatDistance, formatPace);
  const felt = feltFor(summary);
  // `summariseSession` already downsamples before this ever arrives — this
  // second pass is a no-op there (a route at or under the cap returns
  // unchanged) and a defensive floor for any OTHER caller that builds a
  // `SessionSummary` by hand with a full, un-thinned track: rendering a
  // `Polyline` with thousands of raw coordinates is real jank this card
  // should never be able to cause, whichever way its points arrived.
  const routePoints =
    summary.sport === 'running' && summary.routePoints
      ? downsampleRoute(summary.routePoints)
      : undefined;
  // Null whenever there is nothing a map can meaningfully draw — no track,
  // or too short a one — so the thumbnail block below can gate on one value
  // rather than re-deriving "is this route drawable" itself.
  const routeRegion = routePoints ? regionForRoute(routePoints) : null;

  // The capture, the server's decorating numbers and the error copy all live
  // in `useSessionShare` now, because the same three are needed by every
  // screen that reads a finished session back. See that file for why the card
  // it mounts has to sit at the screen root.
  const share = useSessionShare({
    sessionID,
    summary,
    formatTonnage,
    formatWeight,
    // Threaded straight through so the exported card and this modal never
    // disagree about a run's units — see `useSessionShare`'s own doc on why
    // it needs these too.
    formatDistance,
    formatPace,
    streak,
  });

  useEffect(() => {
    // The haptic is the part that lands even face-down in a bag; the sound
    // covers the phone being on a bench. Both are best-effort.
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
    playSound('sessionComplete');
  }, []);

  /*
    The shared latch — ONE celebratory sound per session.

    Hoisted above all three effects rather than living in the PR block, because
    the milestone effect now sits above that block and has to read the same
    flag. Whichever effect fires first latches, so declaration order decides a
    tie WITHIN one commit and reads top to bottom — milestone, record, streak.

    Declaration order alone is not enough, and assuming it was is a defect
    review found here: the three inputs arrive from two independent fetches, so
    across commits the winner is whoever ARRIVES first, not whoever ranks
    highest. Each effect below therefore also waits for the lookup that could
    outrank it — the record waits on `streakSettled`, the streak waits on
    `recordsSettled`, and the milestone, outranked by nothing, waits for
    neither.
  */
  const chimed = useRef(false);

  /*
    Above both of the others, and declared before them so it claims the latch
    first in the same commit — the same ordering argument the PR effect already
    makes against the streak, one rung higher. `success` rather than `streak`:
    hearing the weekly sound for a thing that happens once a year would make
    the rarer event sound like the ordinary one.
  */
  const crossed = celebratesMilestone({ milestone });
  useEffect(() => {
    if (!crossed || chimed.current) return;
    chimed.current = true;
    const t = setTimeout(() => playSound('success'), 1100);
    return () => clearTimeout(t);
  }, [crossed]);

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

    N19 puts ONE rung above it. A streak milestone is rarer still — three of its
    four rungs happen at most once ever — so it takes the latch first and this
    stands down, exactly as this stands above the weekly streak.
  */
  const earnedBadge = hasRecords || accomplishment != null;

  /*
    And gated on `streakSettled`, the reciprocal of the gate the streak chime
    below already has — what makes the milestone's precedence survive contact
    with two independent fetches.

    Without it, "the milestone outranks the badge" held only when both landed in
    one commit. In practice the badge lookup usually answers first — a handful
    of exercise ids, or one accomplishments call — while the history rolls up a
    year of days, so this effect claimed the shared latch on ARRIVAL and the
    milestone arriving a moment later found it taken. The rarer event lost to
    the commoner one, silently: the exact bug `recordsSettled` was introduced to
    fix one rung further down. Found in review.

    Waiting costs nothing visible. The badge ROW still renders the instant its
    lookup lands — the streak fetch is separate precisely so it can — and only
    the sound waits. Offline the history settles in its `finally`, so this is
    delayed, never lost.

    `earnedBadge` is what goes in, NOT `hasRecords`: on the mat the thing that
    outranks a streak is the accomplishment, and the parameter is named for the
    strength case it was written from. Passing the records-only flag here would
    let a BJJ first lose its chime to a milestone that should have deferred to
    nothing, and would chime the streak over it on the way back down.
  */
  const beat = celebratesRecord({
    streakSettled,
    hasRecords: earnedBadge,
    milestone: milestone !== null,
  });
  useEffect(() => {
    if (!beat || chimed.current) return;
    chimed.current = true;
    const t = setTimeout(() => playSound('pr'), 1100);
    return () => clearTimeout(t);
  }, [beat]);

  /*
    The streak chime — last in the ladder, so both of the above win.

    `chimed` is shared with the effect above rather than being its own flag,
    which is what makes that precedence hold: whichever fires first latches,
    and the gate on `recordsSettled` guarantees the PR gets to go first when
    there is one. Without it the two lookups race and a fast history would
    latch the PR out — the wrong way round, since a personal record is the
    larger moment and a streak recurs every week.

    Declared after the PR effect on purpose too: within one commit React runs
    them in order, so if both become true together the PR still claims the
    latch. `celebratesStreak` additionally stands down for a milestone outright
    rather than relying on that ordering, because the milestone is known in the
    same pass as `carried` and an explicit refusal is what a test can pin.
  */
  const carried = celebratesStreak({
    recordsSettled,
    // `earnedBadge`, not `hasRecords`: on the mat the thing that outranks a
    // streak is the accomplishment, and passing the records-only flag here
    // would chime the streak straight over the top of a BJJ first.
    hasRecords: earnedBadge,
    carried: streak?.carried === true,
    milestone: milestone !== null,
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

          {/*
            A static shape, not the live map: `scrollEnabled`/`zoomEnabled`/
            `rotateEnabled`/`pitchEnabled` are all off and the view sits under
            `pointerEvents="none"`, so this reads as a picture of the route
            rather than a screen to navigate on — this is a summary card, not
            the live-tracking screen. Rendered only once a region exists to
            frame it, so a manual entry or an import with no track (both real,
            per `running.RoutePoints`'s own doc) shows no thumbnail at all
            rather than a blank grey rectangle.

            Hidden from the accessibility tree entirely, not merely unlabelled:
            it is decorative — every fact it carries (distance, elevation
            gain) is already stated in words by the stat tiles below, in the
            order a screen reader reads them — so an unlabelled "map" landing
            between the subtitle and the badge would be noise, not a gap.
          */}
          {routeRegion && (
            <RNView
              style={styles.routeThumb}
              testID="celebration-route-thumb"
              accessibilityElementsHidden
              importantForAccessibility="no-hide-descendants"
            >
              <MapView
                style={StyleSheet.absoluteFill}
                initialRegion={routeRegion}
                scrollEnabled={false}
                zoomEnabled={false}
                rotateEnabled={false}
                pitchEnabled={false}
                showsCompass={false}
                showsUserLocation={false}
                toolbarEnabled={false}
                pointerEvents="none"
              >
                <Polyline
                  coordinates={(routePoints ?? []).map((p) => ({
                    latitude: p.lat,
                    longitude: p.lng,
                  }))}
                  strokeColor={accent.accent}
                  strokeWidth={3}
                />
              </MapView>
            </RNView>
          )}

          {badge && (
            /*
              `polite`, for the same reason the streak line and the records list
              below carry it: this arrives AFTER the card has rendered, once the
              network answers, so a screen reader has already moved past it.

              It matters more here than it did for records. A strength athlete
              hears the news anyway from the announced records list underneath;
              on the mat this badge is the ONLY representation of the first, so
              without it a VoiceOver athlete gets flares and a chime and no
              words at all.
            */
            <RNView
              accessibilityLiveRegion="polite"
              style={[styles.badge, { borderColor: accent.accent }]}
            >
              <Text style={[styles.badgeText, { color: accent.ink }]} testID="celebration-badge">
                {badge.label}
              </Text>
            </RNView>
          )}

          {/*
            The milestone, when this session crossed one — which is almost
            never, and that is what makes it worth a block of its own rather
            than another line in the streak sentence. It sits above the streak
            line because it is the larger statement about the same fact; both
            show, because "a year, unbroken" and "52 weeks in a row" are the
            headline and the figure behind it, not a repetition.
          */}
          {milestone && (
            <RNView
              style={[styles.milestone, { borderColor: accent.accent }]}
              // Arrives after the card opens, like the streak line and the
              // records below it, so a screen reader has to be told or the one
              // rare thing on this card is the one thing only seen.
              accessibilityLiveRegion="polite"
              testID="celebration-milestone"
            >
              <Text style={[styles.milestoneLabel, { color: accent.ink }]}>{milestone.label}</Text>
              <Text style={styles.milestoneBlurb}>{milestone.blurb}</Text>
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
  routeThumb: {
    alignSelf: 'stretch',
    height: 120,
    borderRadius: 14,
    overflow: 'hidden',
    marginTop: 6,
    borderWidth: 1,
    borderColor: vola.lineSoft,
  },
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
  /*
    Bordered in the accent like `badge`, but a block rather than a pill: it
    carries two lines, and a pill wide enough for "Twenty-six weeks in a row.
    Six months of showing up." is not a pill. Deliberately NOT filled with the
    accent — the tick above it is, and two solid accent shapes in one column
    would leave nothing as the card's focus.
  */
  milestone: {
    alignSelf: 'stretch',
    borderWidth: 1,
    borderRadius: 12,
    paddingVertical: 12,
    paddingHorizontal: 16,
    gap: 4,
    marginTop: 4,
  },
  milestoneLabel: { fontSize: 15, fontWeight: '800', textAlign: 'center' },
  milestoneBlurb: {
    fontSize: 12,
    color: vola.textMuted,
    textAlign: 'center',
    lineHeight: 17,
  },
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
