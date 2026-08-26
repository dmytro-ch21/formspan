import { useFocusEffect, useRouter } from 'expo-router';
import { useCallback, useRef, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, View as RNView } from 'react-native';

import { ScreenHeader, TAB_BAR_CLEARANCE } from '@/components/ScreenHeader';
import { BjjRankHeader } from '@/components/BjjRankHeader';
import { RoadmapSummary } from '@/components/RoadmapSummary';
import { Text, View } from '@/components/Themed';
import { Icon } from '@/components/ui/Icon';
import { vola } from '@/constants/Colors';
import { useAccent } from '@/lib/AccentProvider';
import { isNotFound } from '@/lib/apiError';
import { PHASE_LABELS, listPhases, type Phase } from '@/lib/body';
import { playSound } from '@/lib/sounds';
import { anyArrived, getPendingCounts } from '@/lib/friends';
import { getProfile, type Profile } from '@/lib/profile';
import { useModules } from '@/lib/ModulesProvider';
import { useAuthToken } from '@/lib/useAuthToken';

/**
 * You — **who am I as an athlete, and how is VOLA configured for me?**
 *
 * ## The two questions, in that order (N181, #586)
 *
 * This screen had become a miscellaneous app menu: six identically-shaped
 * destination rows, a settings value nobody could act on, and the athlete's own
 * name somewhere in the middle of them. N178 (#621) took the analytics off it —
 * `TrainingSummary`, `RecordsCard` and the position map are on Progress now,
 * moved and not copied. What N181 does is the other half: give what is LEFT a
 * shape, so the first screenful answers the first question and everything else
 * is grouped under the second.
 *
 * The order below is the product requirement rather than a layout preference,
 * and it is asserted in `app/__tests__/youScreen.test.tsx` on the
 * `you-section-*` testIDs in document order:
 *
 * 1. **Identity** (unlabelled — it is the masthead). The belt for a ranked
 *    grappler, the athlete's name, then the three facts the app reasons over:
 *    which sports are on, which training phase is live, and date of birth.
 *    `RoadmapSummary` and the Library row close it: what this athlete is
 *    LEARNING is part of who they are, which is the line N178 drew when it
 *    took "is it working" to Progress and left this behind.
 * 2. **People** — everything that involves another person, each row badged
 *    with what is waiting.
 * 3. **App** — how VOLA behaves, which is one row, because `app/settings.tsx`
 *    already holds units, training settings, privacy and account.
 *
 * ## What is NOT here, and why each one is a decision rather than an omission
 *
 * - **Units.** It was an inert row displaying a setting, one tap above a
 *   Settings row whose own detail line names units. Two surfaces for one fact,
 *   and only one of them could change it. Settings › Preferences › Units is the
 *   single home now.
 * - **Sequences.** Moved into the Library screen, which is the app's knowledge
 *   home and already carries the round map, the belt syllabuses and the
 *   position glossary. A list of chains you captured belongs beside those, not
 *   beside your date of birth. It is gated there on the technique MODULE and
 *   not on any server read, so the app's only route to `/sequence` cannot
 *   vanish with a failed fetch — see `app/__tests__/libraryBjjEntries.test.tsx`.
 * - **A Goals & Records section.** The ticket recommends one; Progress already
 *   is one, as of N178. A second set of entry points on You would be two
 *   surfaces competing to answer one question, which is the W2/W4 shape this
 *   codebase keeps paying for.
 * - **History and Integrations sections.** The ticket recommends both and
 *   neither has a destination to point at: there is no athlete-timeline screen,
 *   and no device or data-source integration exists yet. A section header above
 *   a row that goes nowhere is a state that cannot be constructed, dressed as
 *   navigation.
 *
 * ## Every destination is a ROW, never a header control
 *
 * They were three text controls in the top-right until the header's centred
 * wordmark ran out of room for them — see `ScreenHeader`, which now refuses to
 * draw a wordmark it cannot fit, and would have dropped it on this tab
 * permanently had the cluster stayed. Rows are the better home anyway: they
 * carry a line saying what is behind each one, and a count that reads.
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
    The live training phase, and whether the server has ever answered about it.

    TWO pieces of state rather than one, for the same reason `answered` exists
    above: `null` on its own cannot tell "we have not asked yet" from "there is
    no phase running", and those render as different sentences. Collapsing them
    would make a gym dead-spot assert that this athlete is on no phase — the
    absent-value-reads-as-the-discouraging-cause defect this codebase has
    shipped three times.

    Only ever set TRUE by a successful read, and a failure leaves both alone, so
    a refresh that fails keeps the phase already on screen rather than
    retracting it. See `phaseValue` for the three strings this pair produces.
  */
  const [phase, setPhase] = useState<Phase | null>(null);
  const [phaseAnswered, setPhaseAnswered] = useState(false);
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

      // A THIRD independent chain, for the same reason the counts are a second
      // one: the phase read is slow, online-only, and nothing else on this
      // screen waits for it. `alive` rather than an AbortController because
      // `listPhases` takes no signal — the guard is on the WRITE, so a blurred
      // response cannot land on a screen that has since been re-focused.
      let alive = true;
      listPhases(getToken)
        .then((ps) => {
          if (!alive) return;
          setPhase(ps.find((p) => p.ended_on == null) ?? null);
          setPhaseAnswered(true);
        })
        .catch(() => {
          // Silent, and deliberately does NOT clear what is on screen. A phase
          // is a fact about the athlete; failing to re-read it is not evidence
          // that it ended.
        });

      return () => {
        counting.abort();
        alive = false;
      };
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
      {/* Inside the ScrollView, so it scrolls away with the content and
          nothing passes under it — no bottom rule. See `ScreenHeader`. */}
      <ScreenHeader title="You" contentScrollsUnder={false} />

      <View style={styles.body}>
        {error && <Text style={styles.error}>{error}</Text>}

        {/* Nothing has ever loaded, so every field below would be a default
            standing in for an unknown. Say so rather than render them. */}
        {!answered && error ? (
          <Text style={styles.muted} testID="you-unavailable">
            Your profile will appear here once VOLA can reach your account. Nothing you&apos;ve
            logged is affected.
          </Text>
        ) : (
          <>
            {/* The belt leads for a ranked grappler — see BjjRankHeader for
                why it is a masthead rather than a card. It owns the no-rank
                case too, as a single quiet row, so this is the only place the
                standing is fetched. */}
            {bjjEnabled && <BjjRankHeader getToken={getToken} />}

            {/* The identity section's anchor for the order assertion, and the
                athlete's own name is the right thing to anchor it on: it is the
                one element of this section that renders for every account. */}
            <Text style={styles.name} testID="you-section-identity">
              {profile?.display_name || 'Add your name'}
            </Text>
            {!profile?.display_name && (
              <Text style={styles.muted}>Tap Edit profile to tell VOLA who you are.</Text>
            )}

            {/* `TrainingSummary` and `RecordsCard` USED to sit here, and they
                moved to the Progress tab in N178 (#583) — moved, not copied,
                so there is exactly one of each in the app.

                The argument for having them here was that this tab answers
                "am I showing up" and "what have I lifted", and both are still
                good questions. They are just not questions about the ATHLETE,
                which is what this screen is now for; they are questions about
                whether the training is working, which is the whole of the tab
                that did not exist when they landed here.

                Nothing was dropped in the move: the span control, the
                consistency grid, the streak, the week bars and every record
                row render on Progress exactly as they did here. */}

            {/* The three facts about this athlete that the app REASONS OVER —
                which sports are on, which phase is live, when they were born —
                shown as answers rather than as links to answers.

                Each row navigates to where its own fact is changed, which is
                what N61 established for Sports and is the same argument for the
                other two: a value the athlete can see and cannot act on is how
                "the app does not have this" gets mistaken for "this is turned
                off".

                `Units` is NOT here any more. It was an inert row displaying a
                preference, sitting one tap above a Settings row whose detail
                line already names units — two surfaces for one fact, only one
                of which could change it. Settings › Preferences › Units is the
                single home now. */}
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
                hint="Opens your sport toggles"
                testID="you-sports"
              />
              {/* A phase is the thing every calorie target points at, and until
                  this row existed the API could hold one that nothing in the
                  app could create. It was a NavRow whose detail line listed the
                  kinds ("Cutting, bulking, or holding where you are") and never
                  said which one was running — so the one fact it existed to
                  carry was the one thing it did not show. */}
              <NavValueRow
                label="Phase"
                value={phaseValue(phase, phaseAnswered)}
                onPress={() => router.push('/phase')}
                hint="Start, change or end a training phase"
                testID="you-phase"
              />
              {profile?.date_of_birth && <Row label="Born" value={profile.date_of_birth} />}
            </View>
            {/* Directly under the facts it changes, which is the distinction
                the old header pair was making and is easier to see here: Edit
                alters facts about YOU that the app reasons over, Settings
                alters how the app BEHAVES. */}
            <NavRow
              label="Edit profile"
              detail="Your name, sports and date of birth"
              onPress={() => router.push('/profile/edit')}
              testID="you-edit"
            />

            {/* What you are LEARNING, which stayed here when the records left.
                The line N178 drew: records and the consistency grid answer
                "is the training working", which is Progress; a roadmap is
                closer to who this athlete is — the belt masthead above is the
                same fact at a coarser grain. It renders nothing at all for an
                athlete on no roadmap with no focus, so a strength-only account
                never sees an empty BJJ block. */}
            <RoadmapSummary />

            {/* The position map used to be a row here and is on Progress now
                (N178, #583) — "where you score and where you get stuck" is a
                page of numbers you sit with after a hard week, which is that
                tab's question rather than this one's. Moved, not copied.

                `Sequences` used to be a row here too and is in the LIBRARY now
                (N181, #586) — moved, not copied, and asserted from both sides
                the way N178's move is. The chains an athlete captured are
                knowledge, and the Library is where this app keeps knowledge:
                the round map, the belt syllabuses and the position glossary are
                already there. The row below is now the only thing standing
                between this screen and all of it. */}

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
              detail="Techniques, exercises, belt roadmaps and your own chains"
              onPress={() => router.push('/library')}
              testID="you-library"
            />

            {/* Everything that involves another person, in one place.

                Both rows are BADGED, and both badges point at a screen that
                can answer them — the rule the notification counts were built
                on. Shares could not be badged when the counts shipped, because
                the phone had no sharing surface; `app/shared/` closed that.

                Kept as TWO rows rather than folded into Social, which N181
                considered. Social's screen has a friends pane and a feed and no
                sharing pane, so merging would mean either building one or
                summing two counts into a single badge — and a badge that cannot
                say WHICH source is waiting is the thing `anyArrived` compares
                per source specifically to avoid. They are secondary here by
                POSITION, which is what the ticket asked for. */}
            <Text style={styles.sectionLabel} testID="you-section-people">
              People
            </Text>
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

            {/* How VOLA behaves — the screen's second question, and one row,
                because `app/settings.tsx` already carries the whole of it:
                Account (profile, sign out), Preferences (units, rest timer,
                sounds, spoken cues, suggestions, effort) and Privacy. The
                ticket's recommended `Settings` section lists units, training
                settings, notifications, privacy and account; that screen IS
                that section, and re-listing its contents here would be the
                second surface all over again. */}
            <Text style={styles.sectionLabel} testID="you-section-app">
              App
            </Text>
            <NavRow
              label="Settings"
              detail="Units, accent, privacy and how VOLA behaves"
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
 * line, and this belongs in the identity card beside Born. It keeps the row's
 * shape and gains a hit target.
 *
 * N181 made it take its own `hint` and gave it a second caller — Phase — for
 * the same reason. The hint was hard-coded to "Opens your sport toggles" while
 * this had one call site, which is exactly the shape that reads as harmless
 * until the second one arrives and silently tells a screen-reader user that the
 * phase row opens their sport toggles.
 */
function NavValueRow({
  label,
  value,
  onPress,
  hint,
  testID,
}: {
  label: string;
  value: string;
  onPress: () => void;
  /** Spoken after the label and the value, and silenceable. Required rather
   *  than defaulted: a default would be some other row's sentence. */
  hint: string;
  testID: string;
}) {
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
      accessibilityRole="button"
      // `accessibilityValue`, NOT a hint. An accessibilityLabel replaces child
      // text, so the disciplines have to be spoken some other way — and a hint
      // is the wrong slot for them: hints are spoken last, after a pause, and
      // a VoiceOver user can switch them off entirely. What is on and off is
      // the ANSWER this row exists to give, which is precisely what
      // accessibilityValue means. NavRow's hint carries supplementary
      // description, so the analogy does not transfer. Raised in review.
      accessibilityLabel={label}
      accessibilityValue={{ text: value }}
      accessibilityHint={hint}
      testID={testID}
    >
      <Text style={styles.rowLabel}>{label}</Text>
      {/* A chevron and a pressed state, because the fix for a discoverability
          bug produced a control nothing marked as tappable: this row sits
          between Units and Born, which are inert, and looked identical to
          them. Raised in review. */}
      <RNView style={styles.rowValueGroup}>
        <Text style={styles.rowValue}>{value}</Text>
        <Icon name="chevron" size={13} color={vola.textDim} />
      </RNView>
    </Pressable>
  );
}

/**
 * What the Phase row says, from the two pieces of state that carry it.
 *
 * Three outcomes, and every one of them is reachable — which is the question
 * worth asking of any state a screen can render:
 *
 *   - **`'—'`** while the server has not answered. Reached on every cold open,
 *     and reached for as long as an athlete stays in a dead-spot, because a
 *     failed read deliberately does not set `answered`. It withholds rather
 *     than guesses.
 *   - **the phase's label** when one is running. Reached by anyone mid-cut.
 *   - **`'None'`** once the server has answered and there is no live phase.
 *     Reached by every athlete who has never started one, which is most of
 *     them.
 *
 * The distinction between the first and the third is the whole reason
 * `phaseAnswered` exists as separate state: both are "we have no phase to
 * show", and only one of them is a claim about the athlete. Rendering `'None'`
 * from a failed read would tell somebody on week six of a cut that they are on
 * no phase — an absent value shown as its most discouraging cause, which is
 * this codebase's most repeated defect.
 */
export function phaseValue(phase: Phase | null, answered: boolean): string {
  if (!answered) return '—';
  if (!phase) return 'None';
  return PHASE_LABELS[phase.kind].label;
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
  // The pressed state and the chevron group belong to the one row in this
  // card that is a control — see NavValueRow.
  rowPressed: { opacity: 0.6 },
  rowValueGroup: { flexDirection: 'row', alignItems: 'center', gap: 6, flexShrink: 1 },
  rowLabel: { color: vola.textMuted, fontSize: 14 },
  rowValue: { fontWeight: '600', fontSize: 14, flexShrink: 1, textAlign: 'right' },
  muted: { color: vola.textMuted, fontSize: 13 },
  error: { color: vola.danger, fontSize: 14 },
});
