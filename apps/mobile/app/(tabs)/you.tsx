import { useFocusEffect, useRouter } from 'expo-router';
import { useCallback, useRef, useState } from 'react';
import { Pressable, ScrollView, StyleSheet } from 'react-native';

import { ScreenHeader, TAB_BAR_CLEARANCE } from '@/components/ScreenHeader';
import { BjjRankHeader } from '@/components/BjjRankHeader';
import { RecordsCard } from '@/components/RecordsCard';
import { RoadmapSummary } from '@/components/RoadmapSummary';
import { TrainingSummary } from '@/components/TrainingSummary';
import { Text, View } from '@/components/Themed';
import { vola } from '@/constants/Colors';
import { useAccent } from '@/lib/AccentProvider';
import { isNotFound } from '@/lib/apiError';
import { playSound } from '@/lib/sounds';
import { anyArrived, getPendingCounts } from '@/lib/friends';
import { getProfile, type Profile } from '@/lib/profile';
import { UNIT_SYSTEMS } from '@/lib/units';
import { useModules } from '@/lib/ModulesProvider';
import { useAuthToken } from '@/lib/useAuthToken';

/**
 * You — the athlete, and the way in to everything about them.
 *
 * The destinations are ROWS, not controls in the header.
 *
 * They were three text controls in the top-right until the header's centred
 * wordmark ran out of room for them — see `ScreenHeader`, which now refuses to
 * draw a wordmark it cannot fit, and would have dropped it on this tab
 * permanently had the cluster stayed. Rows are the better home anyway: they
 * carry a line saying what is behind each one, and a count that reads.
 *
 * The distinction the old pair was making survives, and is easier to see now
 * that both sit under the facts they act on: Edit alters *facts about you*
 * that the app reasons over (which sports you do, your date of birth), while
 * Settings alters *how the app behaves*. They are grouped under Profile for
 * that reason, and People is its own section above — everything involving
 * another person, each row badged with what is waiting.
 */
/** The server caps counts here — see friend.maxBadgeCount. At the cap the value
 *  means "this many or more", so the badge stops claiming to be exact. */
const BADGE_CAP = 100;

export default function YouScreen() {
  // No `useAccent` here any more — the accent is only used by the rows, and
  // `NavRow` reads it itself.
  const getToken = useAuthToken();
  const router = useRouter();

  const [profile, setProfile] = useState<Profile | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Whether the server has ever answered on this screen. Without it the
  // initial `profile === null` is indistinguishable from a confirmed "no
  // profile yet", so a *first* load that fails renders the whole new-user
  // empty state — "Add your name", "None chosen yet", "kilograms · metres" —
  // which is the same claim this screen was fixed to stop making, merely
  // contradicted by a banner instead of withheld.
  const [answered, setAnswered] = useState(false);
  // What is waiting on this athlete to answer, per source.
  //
  // Starts at 0 and is only ever REPLACED by a successful read — never reset
  // on failure. The distinction matters more than it looks: 0 renders no
  // badge, which is an assertion that nothing is waiting, and a gym dead-spot
  // must not make that claim. Keeping the last known number is the honest
  // degradation, and the screens themselves are where a real error surfaces
  // as copy.
  //
  // BOTH sources now. Shares were left unbadged when the counts shipped, for
  // the right reason at the time — the phone had no sharing surface, so it
  // would have been a number you could not open. `app/shared/` closed that,
  // and the rule it was protecting ("badge only what can be answered here")
  // is now satisfied rather than waived.
  const [waiting, setWaiting] = useState({ friend_requests: 0, shares: 0 });
  /*
    The last counts we actually saw, so a rise can be told from a first look.

    A ref, not state: it must not cause a render (the badge already renders
    from `waiting`), and it has to survive the focus/blur cycle that refetches.
    Null until something has been counted once — see `announcesArrival` for why
    an opening count is deliberately silent.

    Holds the whole shape rather than a total, because `anyArrived` compares
    per source; a total cannot tell a swap from no change.

    Process-lifetime, so a cold launch is always silent even if things were
    waiting before. That is correct: "arrived" is a claim about while you were
    looking, and after a relaunch the app has no basis for it.
  */
  const lastWaiting = useRef<{ friend_requests: number; shares: number } | null>(null);

  // On focus, so returning from Edit shows what was just saved.
  useFocusEffect(
    useCallback(() => {
      getProfile(getToken)
        .then((p) => {
          setProfile(p);
          setError(null);
          setAnswered(true);
        })
        .catch((err) => {
          // A missing profile isn't an error — it's someone who hasn't
          // filled one in yet, and the empty state below says so.
          if (isNotFound(err)) {
            setProfile(null);
            setError(null);
            setAnswered(true);
            return;
          }
          // Everything else: keep what's already on screen. This used to
          // `setProfile(null)` for any failure, so an established athlete
          // coming back from Edit while offline was shown a blank new-user
          // profile, asserted as fact — and silently, because `error` was only
          // ever assigned null, which made the banner below dead code.
          setError("Couldn't reach your profile just now.");
        });

      // A SEPARATE chain, not chained onto the profile fetch: the two are
      // independent, and sequencing them would make a slow profile delay the
      // badge for no reason. Failure is silent and leaves `waiting` alone.
      //
      // Aborted on blur, so a rapid blur/focus cannot land an older count on
      // top of a newer one — `getPendingCounts` has always taken the signal;
      // it just was not being handed one.
      const counting = new AbortController();
      getPendingCounts(getToken, counting.signal)
        .then((counts) => {
          if (counting.signal.aborted) return;
          // `?? 0` per key rather than trusting the shape: a key ABSENT means
          // this build's server has no such source, which renders as no badge
          // — the same as zero, and correctly so for a client newer than its
          // server.
          const next = {
            friend_requests: counts.friend_requests ?? 0,
            shares: counts.shares ?? 0,
          };
          // Read BEFORE the assignment, or it is compared against itself.
          const seen = lastWaiting.current;
          lastWaiting.current = next;
          setWaiting(next);
          /*
            The badge is updated FIRST, and the cue cannot reach back and stop
            it. This had the chime above `setWaiting`, and the YOU screen's own
            tests caught what that costs: anything throwing between the abort
            check and the badge update is swallowed by the `.catch` below and
            the badge silently never renders — the decoration breaking the
            thing it decorates, which `lib/sounds.ts` forbids in as many words
            for exactly this reason. A count you can see is the feature; the
            noise is a nicety.
          */
          try {
            if (anyArrived(seen, next)) playSound('notification');
          } catch {
            // A cue is never worth a badge.
          }
        })
        .catch(() => {});
      return () => counting.abort();
    }, [getToken]),
  );

  // From the provider, not a fetch of its own. Two reasons: this screen had
  // the per-call-site pattern the provider exists to replace, and being
  // mount-only it went stale after exactly the flow this row is for — edit
  // your sports, come back, and see the list you just changed.
  //
  // The labels come with it, so "BJJ" stays "BJJ" rather than becoming "Bjj".
  const { modules, ready: modulesReady } = useModules();
  // null means "we don't know yet", which is NOT the same as "none chosen".
  const enabledLabels = modulesReady ? modules.filter((m) => m.enabled).map((m) => m.label) : null;
  // A belt is meaningless to someone who doesn't train BJJ — gated the same
  // way Records and Library are gated on the web dashboard, on the module
  // rather than on data existing, so turning BJJ off hides the card even for
  // an account with a recorded history.
  const bjjEnabled = modulesReady && modules.some((m) => m.key === 'bjj' && m.enabled);

  return (
    <ScrollView contentContainerStyle={styles.scroll} testID="you-screen">
      {/*
        NO `action`, and that is the fix rather than a simplification.

        Three text controls here came to ~173pt, and `ScreenHeader` draws an
        88pt wordmark centred across the same row — so on a 375pt device the
        word "Friends" sat on the wordmark's tail, and the notification badge
        (`Friends (3)`) made it wider still, asynchronously, after paint.
        `ScreenHeader` now refuses to draw the wordmark it cannot fit, so the
        collision is impossible either way; leaving the cluster there would
        simply have cost the wordmark on this tab permanently.

        The rows below are also the better home for a count: a number beside a
        labelled row reads, where a parenthetical crammed into a 14pt header
        label is something you squint at.
      */}
      <ScreenHeader title="You" />

      <View style={styles.body}>
        {error && <Text style={styles.error}>{error}</Text>}

        {/* Nothing has ever loaded, so every field below would be a default
            standing in for an unknown. Say so rather than render them. */}
        {!answered && error ? (
          <Text style={styles.muted} testID="you-unavailable">
            Your profile, training summary and records will appear here once VOLA can reach your
            account. Nothing you&apos;ve logged is affected.
          </Text>
        ) : (
          <>
            {/* The belt leads for a ranked grappler — see BjjRankHeader for
                why it is a masthead rather than a card. It owns the no-rank
                case too, as a single quiet row, so this is the only place the
                standing is fetched. */}
            {bjjEnabled && <BjjRankHeader getToken={getToken} />}

            <Text style={styles.name}>{profile?.display_name || 'Add your name'}</Text>
            {!profile?.display_name && (
              <Text style={styles.muted}>Tap Edit to tell VOLA who you are.</Text>
            )}

            {/* History, phone-sized. The web app owns the analytical surface —
                this answers the one question a desk can't while you're standing
                in a gym: am I showing up. */}
            <TrainingSummary getToken={getToken} units={profile?.unit_system ?? 'metric'} />

            {/* Records sit between the training summary and the profile facts:
                they're the payoff for the logging above, and the thing people
                actually open this tab to look at. */}
            <RecordsCard getToken={getToken} units={profile?.unit_system ?? 'metric'} />

            {/* After Records, before Profile. Records is what you have lifted;
                this is what you are learning — both are payoffs for logging,
                and both belong above the account facts. It renders nothing at
                all for an athlete on no roadmap with no focus, so a
                strength-only account never sees an empty BJJ block. */}
            <RoadmapSummary />

            {/* Where the rounds actually go.

                Gated on the module rather than on data, the same way the belt
                above is: a strength-only account should not be offered a BJJ
                screen that would only ever be empty for them.

                A link and not a card, unlike Records and the roadmap. Those two
                are payoffs read at a glance; this one is a page of numbers you
                sit with after a hard week, and inlining it here would put a
                three-section readout in the middle of the account tab. */}
            {bjjEnabled && (
              <NavRow
                label="Position map"
                detail="Where you score, and where you get stuck"
                onPress={() => router.push('/bjj/positions')}
                testID="you-bjj-positions"
              />
            )}

            {/* The catalog, which used to be a tab of its own.

                Moved here on the user's own call — "library is what we dont
                need a dedicated view and we can simply move to my profile and
                be able to open from there library to explore". The tab bar is
                for what you check; a catalog is what you explore, and it was
                spending the app's most valuable fixed slot on something read
                occasionally and deliberately.

                DELIBERATELY NOT GATED, unlike the tab it replaces. That tab
                hid itself whenever no enabled discipline had a catalog, and
                N61 is the bill for exactly that habit: the user went looking
                for the belt roadmaps on a real phone, reported them missing,
                and they exist and work — an athlete cannot tell *not enabled*
                from *not built* from *broken*. A row that is always here and
                explains itself when empty is the honest version, and it costs
                nothing now that it is not competing for a tab slot.

                See the Library screen's own empty state for the other half:
                naming the reason is what makes the absence readable. */}
            <NavRow
              label="Library"
              detail="Techniques, exercises and the belt roadmaps"
              onPress={() => router.push('/library')}
              testID="you-library"
            />

            {/* Everything that involves another person, in one place.

                Both rows are BADGED, and both badges point at a screen that
                can answer them — the rule the notification counts were built
                on. Shares could not be badged when the counts shipped, because
                the phone had no sharing surface; `app/shared/` closed that. */}
            <Text style={styles.sectionLabel}>People</Text>
            {/* Social took the entry point over, exactly as planned — this
                row changed its label, its detail line and its href, and
                nothing else moved. Friend management still exists at
                `/friends`; the Social screen carries a pane through to it. */}
            <NavRow
              label="Social"
              detail="What your training partners have been doing"
              badge={waiting.friend_requests}
              onPress={() => router.push('/social')}
              testID="you-social"
            />
            {/* The RECEIVE half of sharing, and the reason the Share button on
                a plan is a whole feature rather than half of one: the social
                graph lives on this phone, so being sent a plan you could only
                answer on a laptop was the gap. */}
            <NavRow
              label="Sharing"
              detail="What partners sent you, and what you sent them"
              badge={waiting.shares}
              onPress={() => router.push('/shared')}
              testID="you-shared"
            />

            <Text style={styles.sectionLabel}>Profile</Text>
            <View style={styles.card}>
              <NavValueRow
                label="Sports"
                value={
                  enabledLabels === null
                    ? '—'
                    : enabledLabels.length
                      ? enabledLabels.join(' · ')
                      : 'None chosen yet'
                }
                onPress={() => router.push('/profile/edit')}
                testID="you-sports"
              />
              <Row
                label="Units"
                value={
                  UNIT_SYSTEMS.find((u) => u.key === profile?.unit_system)?.detail ??
                  'kilograms · metres'
                }
              />
              {profile?.date_of_birth && <Row label="Born" value={profile.date_of_birth} />}
            </View>
            {/* Directly under the facts they change, which is the distinction
                the old header pair was making and is easier to see here: Edit
                alters facts about YOU that the app reasons over, Settings
                alters how the app BEHAVES. */}
            <NavRow
              label="Edit profile"
              detail="Your name, sports and date of birth"
              onPress={() => router.push('/profile/edit')}
              testID="you-edit"
            />
            {/* A phase is the thing every calorie target points at, and until
                this row existed the API could hold one that nothing in the app
                could create. Beside Edit profile because it is the same kind of
                fact: something true about you that the app reasons over. */}
            <NavRow
              label="Phase"
              detail="Cutting, bulking, or holding where you are"
              onPress={() => router.push('/phase')}
              testID="you-phase"
            />
            <NavRow
              label="Settings"
              detail="Units, accent, and how VOLA behaves"
              onPress={() => router.push('/settings')}
              testID="you-settings"
            />
          </>
        )}
      </View>
    </ScrollView>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.row}>
      <Text style={styles.rowLabel}>{label}</Text>
      <Text style={styles.rowValue}>{value}</Text>
    </View>
  );
}

/**
 * A Row that is also a destination.
 *
 * Exists for exactly one row — Sports — and the reason is N61. Every
 * module-gated surface in this app disappears silently when its discipline is
 * off: the belt roadmaps, the Plan tab's curricula strip, BJJ in the session
 * picker, and the Food and Goals TABS. The destination screens explain
 * themselves properly ("BJJ tracking is off, turn it back on under Sports")
 * — but nothing links to them while they are off, so the athlete never reaches
 * the screen that would say so. The user went looking for the belt roadmaps on
 * a real phone and reported them missing; they exist and work.
 *
 * This row already showed the answer — "Strength · Nutrition" — and was inert,
 * so it named the cause of every one of those absences while offering no way
 * to act on it. Making it navigate is the cheapest thing that turns "the app
 * does not have this" into "this is turned off", because it is the one place
 * that already tells you which disciplines are on.
 *
 * Deliberately NOT a `NavRow`: those are section destinations with a detail
 * line, and this belongs in the Profile card beside Units and Born. It keeps
 * the row's shape and gains a hit target.
 */
function NavValueRow({
  label,
  value,
  onPress,
  testID,
}: {
  label: string;
  value: string;
  onPress: () => void;
  testID: string;
}) {
  return (
    <Pressable
      onPress={onPress}
      style={styles.row}
      accessibilityRole="button"
      // The value spoken as a HINT rather than folded into the label, matching
      // NavRow: an accessibilityLabel REPLACES child text, so without this the
      // enabled disciplines would simply never be spoken.
      accessibilityLabel={label}
      accessibilityHint={value}
      testID={testID}
    >
      <Text style={styles.rowLabel}>{label}</Text>
      <Text style={styles.rowValue}>{value}</Text>
    </Pressable>
  );
}

/**
 * What a count renders as, or null for no badge at all.
 *
 * `0` deliberately renders NOTHING rather than a zero: a badge is believed,
 * and "0" would be an assertion that nothing is waiting — which is a claim
 * this screen must not make from a failed read. The cap is the server's
 * (`friend.maxBadgeCount`), so at the cap the number means "this many or
 * more" and the badge stops pretending to be exact.
 */
export function badgeText(n: number): string | null {
  if (n <= 0) return null;
  return n >= BADGE_CAP ? '99+' : String(n);
}

/**
 * The spoken version, which cannot be the visual one.
 *
 * "3" beside a label is obvious to look at and meaningless to hear, and
 * "99+" is not a phrase. A screen reader gets the sentence.
 */
export function rowLabelFor(label: string, n: number): string {
  const badge = badgeText(n);
  if (badge === null) return label;
  return `${label}, ${n >= BADGE_CAP ? 'over 99' : n} waiting`;
}

/** One destination: a label, a line saying what is behind it, and a count. */
function NavRow({
  label,
  detail,
  badge = 0,
  onPress,
  testID,
}: {
  label: string;
  detail: string;
  badge?: number;
  onPress: () => void;
  testID: string;
}) {
  const accent = useAccent();
  const count = badgeText(badge);
  return (
    <Pressable
      onPress={onPress}
      style={styles.navRow}
      accessibilityRole="button"
      accessibilityLabel={rowLabelFor(label, badge)}
      // The detail line as a HINT, not folded into the label. An
      // `accessibilityLabel` REPLACES the concatenation of child text, so
      // without this the second line is simply never spoken — sighted users
      // gained it and screen-reader users lost the one the old Sharing row
      // had. A hint is the right slot: spoken after the name, and silenceable.
      accessibilityHint={detail}
      testID={testID}
    >
      <View style={styles.navBody}>
        <Text style={styles.navLabel}>{label}</Text>
        <Text style={styles.muted}>{detail}</Text>
      </View>
      {count !== null && (
        <View
          style={[styles.badge, { backgroundColor: accent.accent }]}
          // The row's own label already says "3 waiting"; announcing the pill
          // too would read the number twice.
          accessibilityElementsHidden
          importantForAccessibility="no-hide-descendants"
          testID={`${testID}-badge`}
        >
          <Text style={[styles.badgeText, { color: accent.on }]}>{count}</Text>
        </View>
      )}
      <Text style={[styles.navChevron, { color: accent.ink }]}>›</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  scroll: { gap: 12, paddingBottom: TAB_BAR_CLEARANCE },
  body: { paddingHorizontal: 20, gap: 10 },
  navRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    borderWidth: 1,
    borderColor: vola.line,
    borderRadius: 14,
    backgroundColor: vola.surface,
    paddingVertical: 14,
    paddingHorizontal: 16,
    marginTop: 4,
  },
  navBody: { flex: 1, gap: 2 },
  // A filled pill rather than an outline: this is a count that wants to be
  // seen from across the screen, and the accent is the athlete's own.
  badge: {
    minWidth: 22,
    paddingHorizontal: 7,
    paddingVertical: 2,
    borderRadius: 999,
    alignItems: 'center',
    justifyContent: 'center',
  },
  badgeText: { fontSize: 12, fontWeight: '800', fontVariant: ['tabular-nums'] },
  navLabel: { fontSize: 15, fontWeight: '700' },
  navChevron: { fontSize: 22, fontWeight: '700' },
  name: { fontSize: 26, fontWeight: '800', marginTop: 4 },
  sectionLabel: {
    fontSize: 12,
    color: vola.textDim,
    textTransform: 'uppercase',
    letterSpacing: 1,
    marginTop: 14,
  },
  card: {
    borderWidth: 1,
    borderColor: vola.line,
    borderRadius: 14,
    backgroundColor: vola.surface,
    paddingHorizontal: 16,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
    paddingVertical: 14,
  },
  rowLabel: { color: vola.textMuted, fontSize: 14 },
  rowValue: { fontWeight: '600', fontSize: 14, flexShrink: 1, textAlign: 'right' },
  muted: { color: vola.textMuted, fontSize: 13 },
  error: { color: vola.danger, fontSize: 14 },
});
