import { useFocusEffect, useRouter } from 'expo-router';
import { useCallback, useRef, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, View as RNView } from 'react-native';

import { ScreenHeader, TAB_BAR_CLEARANCE } from '@/components/ScreenHeader';
import { Avatar } from '@/components/Avatar';
import { BjjRankHeader } from '@/components/BjjRankHeader';
import { RoadmapSummary } from '@/components/RoadmapSummary';
import { Text, View } from '@/components/Themed';
import { CardGlass } from '@/components/ui/CardGlass';
import { Icon, type IconName } from '@/components/ui/Icon';
import { Card } from '@/constants/Card';
import { vola } from '@/constants/Colors';
import { Radius, Spacing } from '@/constants/Spacing';
import { Typography } from '@/constants/Typography';
import { useAccent } from '@/lib/AccentProvider';
import { isNotFound } from '@/lib/apiError';
import { PHASE_LABELS, listPhases, type Phase } from '@/lib/body';
import { isHealthKitSupported } from '@/lib/healthkit';
import { playSound } from '@/lib/sounds';
import { anyArrived, getPendingCounts, listFriends } from '@/lib/friends';
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
 * 1. **Identity** (unlabelled — it is the masthead). The athlete's name leads,
 *    then the belt for a ranked grappler, then the three facts the app
 *    reasons over: which sports are on, which training phase is live, and
 *    date of birth. (Shipped belt-first; moved above the belt after the N181
 *    device pass caught it — see the identity block below.)
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
 * ## N509 (2026-09-05): a header, and a pill/card grid over the same rows
 *
 * The reference (Hevy's Profile tab) asked for three things this screen did
 * not have: a photo, a friends count next to it, and its destinations grouped
 * into a dense icon-labelled grid rather than a full-bleed vertical list. None
 * of that reopens N178 or N181 above — this is a LAYOUT pass over the same
 * sections and the same destinations, not a new set of them:
 *
 * - **The masthead grows an `Avatar` and a friends entry point.** `Avatar`
 *   already existed (N12/N205) and needed no new upload plumbing — it reads
 *   `profile.avatar_url`, exactly as `app/profile/edit.tsx` does. The friends
 *   count is a FOURTH independent fetch chain, following the same silent-
 *   degradation rule as the phase chain below it: a dead spot must not tell an
 *   athlete their friend list emptied, so a failed read leaves the last known
 *   count on screen. It links to `/friends` — the actual list, not `/social`
 *   (the Social row below still points there) — because "friends count" on a
 *   masthead is a request to see WHO, and Social's pane is a feed of what they
 *   did.
 * - **`Born` moved out of its own row and into a caption under the name.** It
 *   was already the one inert fact in that card (see the note below, kept for
 *   the history); with Sports and Phase now pills in their own right, a card
 *   holding one inert field and nothing else was furniture.
 * - **Every destination that was a `NavRow` still IS a `NavRow`** — same
 *   props, same testID, same `accessibilityLabel`/`accessibilityHint`/badge
 *   contract — with one addition, an `icon`, and a grid container around
 *   groups of them instead of a vertical `gap`. `NavValueRow` (Sports, Phase)
 *   is the same trade: the value that used to sit at the end of a row is now
 *   the pill's own caption line, still visible, still the answer rather than
 *   a link to one. Every property a test in `youScreen.test.tsx` pins about
 *   these rows — a hint that must not borrow another row's words, a badge
 *   that must not zero on a failed read, a press that must land on the right
 *   route — is a property of the DATA these rows carry, not of whether they
 *   are drawn 335pt wide or 157pt wide. That is why the redesign could keep
 *   every one of those tests passing unchanged.
 * - **No stats moved back onto this screen.** The reference's grid holds
 *   Statistics/Exercises/Measures/Calendar — this screen's honest equivalent
 *   is Sports, Phase, Library, Edit profile and VO2max (where supported): the
 *   destinations and facts already living here, not a second copy of what
 *   N178 put on Progress. Re-reading "A Goals & Records section" above: that
 *   refusal stands. A pill grid is a LAYOUT, and a layout is not an exemption
 *   from the W2/W4 rule against two surfaces answering one question.
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
    The friend count behind the header's entry point into `/friends` (N509).

    Same two-piece shape as `phase`/`phaseAnswered` above, and for the same
    reason: `null` alone cannot tell "we have not asked yet" from "you have
    zero friends", and a dead spot must not tell an athlete their friend list
    emptied. Only ever set by a successful read; a failure leaves both alone.
  */
  const [friendCount, setFriendCount] = useState<number | null>(null);
  const [friendCountAnswered, setFriendCountAnswered] = useState(false);
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

      // A FOURTH independent chain — the friend count behind the header's
      // entry point into `/friends` (N509). Independent for the same reason
      // the phase chain is: this fetch is slow, online-only, and nothing else
      // on this screen should wait on it.
      let friendsAlive = true;
      listFriends(getToken)
        .then((list) => {
          if (!friendsAlive) return;
          setFriendCount(list.length);
          setFriendCountAnswered(true);
        })
        .catch(() => {
          // Silent, and deliberately does not reset the count — see the
          // phase chain's comment just above for why a dead spot must not
          // assert a fact about the athlete.
        });

      return () => {
        counting.abort();
        alive = false;
        friendsAlive = false;
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
            {/* The masthead (N509): a photo, the name, and a friends entry
                point — the header the reference asked for. The name still
                leads (N181 device pass, #586) and still anchors the order
                assertion below; the avatar and the friends pill are new
                siblings around it, not a replacement for it. */}
            <RNView style={styles.header}>
              <Avatar
                url={profile?.avatar_url}
                // Same fallback chain `app/profile/edit.tsx` uses for its own
                // avatar: the handle the monogram is keyed on, or an empty
                // string (which `monogramFor` reads as "no handle yet" rather
                // than crashing) for an account that has not claimed one.
                handle={profile?.username ?? ''}
                size={64}
              />
              <RNView style={styles.headerText}>
                {/* This is also the identity section's anchor for the order
                    assertion below, and the athlete's own name is the right
                    thing to anchor it on: it is the one element of this
                    section that renders for every account. */}
                <Text style={styles.name} testID="you-section-identity">
                  {profile?.display_name || 'Add your name'}
                </Text>
                {!profile?.display_name && (
                  <Text style={styles.muted}>Tap Edit profile to tell VOLA who you are.</Text>
                )}
                {/* The handle, and the date of birth that used to be its own
                    inert row in the card below — see this file's N509 doc
                    section for why it moved here rather than staying a row
                    with nothing else in its card. Both are captions, never
                    controls: a date of birth explains nothing that is
                    missing elsewhere in the app, and the handle is changed
                    from Edit profile, not from here. */}
                {profile?.username && (
                  <Text style={styles.handle}>@{profile.username}</Text>
                )}
                {profile?.date_of_birth && (
                  <Text style={styles.handle}>Born {profile.date_of_birth}</Text>
                )}
              </RNView>
            </RNView>

            {/* The friends count — the reference's "Followers" figure, read
                against this app's own social graph. Links straight to
                `/friends` (the list itself), not `/social` (the Social row
                below, which is a feed of what partners have been doing): a
                count beside a face is a request to see WHO, not what they
                did. */}
            <Pressable
              onPress={() => router.push('/friends')}
              style={({ pressed }) => [styles.friendsChip, pressed && styles.pillPressed]}
              accessibilityRole="button"
              accessibilityLabel="Friends"
              accessibilityValue={{ text: friendCountLabel(friendCount, friendCountAnswered) }}
              accessibilityHint="Opens your friends list"
              testID="you-friends"
            >
              <Icon name="profile" size={14} color={vola.textMuted} />
              <Text style={styles.friendsChipText}>
                {friendCountLabel(friendCount, friendCountAnswered)}
              </Text>
              <Icon name="chevron" size={11} color={vola.textDim} />
            </Pressable>

            {/* The belt follows the name for a ranked grappler — see
                BjjRankHeader for why it is a masthead rather than a card. It
                owns the no-rank case too, as a single quiet row, so this is
                the only place the standing is fetched. */}
            {bjjEnabled && <BjjRankHeader getToken={getToken} />}

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

            {/* The pill/card grid (N509) — the reference's "Dashboard": every
                destination this identity section already carried, grouped
                two-per-row instead of stacked full-width. Every pill below
                keeps the EXACT accessibility contract its row-shaped
                predecessor had (see this file's N509 doc section) — only the
                container and an `icon` are new.

                Sports and Phase are the same two facts the old card held —
                "which sports are on, which phase is live" — still shown as
                ANSWERS (the pill's own caption line), not just as links to
                answers; that argument (N61 for Sports, N181 for Phase) is
                unchanged by the layout. Born no longer sits beside them; it
                reads as a caption under the name in the masthead above, since
                a card holding one inert field and nothing else was furniture
                once its two siblings became pills.

                `Units` is still NOT here. Settings › Preferences › Units
                remains the single home for it. */}
            <RNView style={styles.grid}>
              <NavValueRow
                icon="workout"
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
                icon="calendar"
                label="Phase"
                value={phaseValue(phase, phaseAnswered)}
                onPress={() => router.push('/phase')}
                hint="Start, change or end a training phase"
                testID="you-phase"
              />
              {/* Directly beside the facts it changes, which is the
                  distinction the old header pair was making and is easier to
                  see here: Edit alters facts about YOU that the app reasons
                  over, Settings alters how the app BEHAVES. */}
              <NavRow
                icon="pencil"
                label="Edit profile"
                detail="Your name, sports and date of birth"
                onPress={() => router.push('/profile/edit')}
                testID="you-edit"
              />

              {/* Your VO2max trend (N477/#822) — a device-read cardio-fitness
                  estimate, per design doc §3: "read, never computed... show it
                  as a trend on the athlete's profile; do not attach it to a
                  session." That is why it lives in the IDENTITY block rather
                  than on Progress: it is a fact ABOUT the athlete rather than
                  a verdict on whether training is working, which is the line
                  N178 already drew for the roadmap below.

                  GATED on `isHealthKitSupported()`, unlike Library below —
                  unlike a catalog that always exists, there is genuinely
                  nothing to show on a build with no HealthKit module linked in
                  (Android today; any iOS build predating this ticket), and a
                  pill that always opens to "not available on this device" would
                  be the same "cannot tell not-enabled from not-built" trap N61
                  found for a DIFFERENT reason. Reading from Health itself is a
                  further gate the trend screen states in words rather than
                  hiding the pill over, matching `you-sports`'/`you-phase`'s own
                  "explain yourself, don't disappear" rule. */}
              {isHealthKitSupported() && (
                <NavRow
                  icon="heart"
                  label="VO2max"
                  detail="Your cardio fitness trend, read from Apple Health"
                  onPress={() => router.push('/vo2max/trend')}
                  testID="you-vo2max"
                />
              )}

              {/* The position map used to be a row here and is on Progress now
                  (N178, #583) — "where you score and where you get stuck" is a
                  page of numbers you sit with after a hard week, which is that
                  tab's question rather than this one's. Moved, not copied.

                  `Sequences` used to be a row here too and is in the LIBRARY now
                  (N181, #586) — moved, not copied, and asserted from both sides
                  the way N178's move is. The chains an athlete captured are
                  knowledge, and the Library is where this app keeps knowledge:
                  the round map, the belt syllabuses and the position glossary are
                  already there. The pill below is now the only thing standing
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
                  from *not built* from *broken*. A pill that is always here and
                  explains itself when empty is the honest version, and it costs
                  nothing now that it is not competing for a tab slot.

                  See the Library screen's own empty state for the other half:
                  naming the reason is what makes the absence readable. */}
              <NavRow
                icon="route"
                label="Library"
                detail="Techniques, exercises, belt roadmaps and your own chains"
                onPress={() => router.push('/library')}
                testID="you-library"
              />
            </RNView>

            {/* What you are LEARNING, which stayed here when the records left.
                The line N178 drew: records and the consistency grid answer
                "is the training working", which is Progress; a roadmap is
                closer to who this athlete is — the belt masthead above is the
                same fact at a coarser grain. It renders nothing at all for an
                athlete on no roadmap with no focus, so a strength-only account
                never sees an empty BJJ block. */}
            <RoadmapSummary />

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
                POSITION, which is what the ticket asked for. Pill-grid layout
                (N509) changes nothing about that: same two testIDs, same
                badges, same press targets — a `styles.grid` container with two
                children instead of a vertical `gap` with two children. */}
            <Text style={styles.sectionLabel} testID="you-section-people">
              People
            </Text>
            <RNView style={styles.grid}>
              {/* Social took the entry point over, exactly as planned — this
                  row changed its label, its detail line and its href, and
                  nothing else moved. Friend management still exists at
                  `/friends`; the Social screen carries a pane through to it. */}
              <NavRow
                icon="profile"
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
                icon="notification"
                label="Sharing"
                detail="What partners sent you, and what you sent them"
                badge={waiting.shares}
                onPress={() => router.push('/shared')}
                testID="you-shared"
              />
            </RNView>

            {/* How VOLA behaves — the screen's second question, and one row,
                because `app/settings.tsx` already carries the whole of it:
                Account (profile, sign out), Preferences (units, rest timer,
                sounds, spoken cues, suggestions, effort) and Privacy. The
                ticket's recommended `Settings` section lists units, training
                settings, notifications, privacy and account; that screen IS
                that section, and re-listing its contents here would be the
                second surface all over again. A grid of one still gets the
                same pill styling as every other destination on this screen —
                consistency, not decoration for its own sake. */}
            <Text style={styles.sectionLabel} testID="you-section-app">
              App
            </Text>
            <RNView style={styles.grid}>
              <NavRow
                icon="settings"
                label="Settings"
                detail="Units, accent, privacy and how VOLA behaves"
                onPress={() => router.push('/settings')}
                testID="you-settings"
              />
            </RNView>
          </>
        )}
      </View>
    </ScrollView>
  );
}

/**
 * A pill that is also a destination — Hevy's "Dashboard" cell, applied to a
 * fact this app already reasoned over. The visual is new (N509); the contract
 * is not.
 *
 * Exists for exactly two callers — Sports and Phase — and the argument for
 * each is N61 and N181 respectively. Every module-gated surface in this app
 * disappears silently when its discipline is off: the belt roadmaps, the Plan
 * tab's curricula strip, BJJ in the session picker, and the Food and Goals
 * TABS. The destination screens explain themselves properly ("BJJ tracking is
 * off, turn it back on under What you train" — N471/#471 corrected this row's
 * own quoted copy, which had drifted to naming a "Sports" section that never
 * existed). This pill's OWN label and hint still say "Sports" over a value
 * that lists every enabled module, nutrition included — the same category
 * error, not fixed here: W17/#737. — but nothing links to them while they are
 * off, so the athlete never reaches the screen that would say so.
 *
 * This pill already shows the answer — "Strength · Nutrition" — as its
 * caption line, so it names the cause of every one of those absences while
 * still offering a way to act on it. That is the whole point of it being a
 * pressable rather than plain text.
 *
 * Deliberately NOT a `NavRow`: a `NavRow`'s label is the only thing it says
 * about itself, spoken through `rowLabelFor`'s badge phrasing; this carries a
 * VALUE as `accessibilityValue`, a different slot, for the reason below.
 *
 * N181 made it take its own `hint` and gave it a second caller — Phase — for
 * the same reason. The hint was hard-coded to "Opens your sport toggles" while
 * this had one call site, which is exactly the shape that reads as harmless
 * until the second one arrives and silently tells a screen-reader user that the
 * phase row opens their sport toggles.
 */
function NavValueRow({
  icon,
  label,
  value,
  onPress,
  hint,
  testID,
}: {
  icon: IconName;
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
      style={({ pressed }) => [styles.pill, pressed && styles.pillPressed]}
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
      <CardGlass />
      <RNView style={styles.pillHead}>
        <RNView style={styles.pillIcon}>
          <Icon name={icon} size={16} color={vola.text} />
        </RNView>
        {/* A chevron, because the fix for a discoverability bug produced a
            control nothing marked as tappable: this pill used to sit in a
            card between Units and Born, which were inert, and looked
            identical to them. Raised in review. */}
        <Icon name="chevron" size={12} color={vola.textDim} />
      </RNView>
      <Text style={styles.pillLabel}>{label}</Text>
      <Text style={styles.pillValue} numberOfLines={1}>
        {value}
      </Text>
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
 * What the header's friends pill says, from the two pieces of state that
 * carry it — same shape as {@link phaseValue} and for the same reason:
 *
 *   - **`'—'`** while the server has not answered, or has answered and failed.
 *     `answered` is only ever set true by a SUCCESSFUL read, so a dead spot
 *     stays at `'—'` rather than falling back to a guess.
 *   - **`'No friends yet'`** once the server has answered with zero. This is
 *     not the same state as the one above — a `0` withheld from a failed read
 *     would tell somebody who has never added a friend that VOLA cannot say,
 *     and a `0` asserted from a failed read would tell somebody with real
 *     friends that their list emptied. Only a confirmed zero may say so.
 *   - **`'N Friends'`** (`'1 Friend'` singular) once the server has answered
 *     with a positive count.
 */
export function friendCountLabel(count: number | null, answered: boolean): string {
  if (!answered || count === null) return '—';
  if (count === 0) return 'No friends yet';
  return `${count} ${count === 1 ? 'Friend' : 'Friends'}`;
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

/**
 * One destination in the pill/card grid: an icon, a label, and a count —
 * Hevy's "Dashboard" cell (N509). Every property below is unchanged from the
 * full-width row this replaced: same testID, same `accessibilityLabel`
 * (`rowLabelFor`'s badge phrasing), same `accessibilityHint` (the detail
 * line, spoken but no longer also drawn — the reference's own pills carry no
 * visible caption either, and the hint already exists for exactly this),
 * same badge child with the same `${testID}-badge` testID and the same
 * "hidden from assistive tech because the label already said it" reasoning.
 * The layout is the only thing this ticket changed.
 */
function NavRow({
  icon,
  label,
  detail,
  badge = 0,
  onPress,
  testID,
}: {
  icon: IconName;
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
      style={({ pressed }) => [styles.pill, pressed && styles.pillPressed]}
      accessibilityRole="button"
      accessibilityLabel={rowLabelFor(label, badge)}
      // The detail line as a HINT, not folded into the label and no longer
      // drawn as a visible caption either — see the doc comment above for
      // why. An `accessibilityLabel` REPLACES the concatenation of child
      // text, so without this the description is simply never spoken.
      accessibilityHint={detail}
      testID={testID}
    >
      <CardGlass />
      <RNView style={styles.pillHead}>
        <RNView style={styles.pillIcon}>
          <Icon name={icon} size={16} color={vola.text} />
        </RNView>
        {count !== null && (
          <RNView
            style={[styles.pillBadge, { backgroundColor: accent.accent }]}
            // The pill's own label already says "3 waiting"; announcing the
            // badge too would read the number twice.
            accessibilityElementsHidden
            importantForAccessibility="no-hide-descendants"
            testID={`${testID}-badge`}
          >
            <Text style={[styles.pillBadgeText, { color: accent.on }]}>{count}</Text>
          </RNView>
        )}
      </RNView>
      <Text style={styles.pillLabel}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  scroll: { gap: 12, paddingBottom: TAB_BAR_CLEARANCE },
  body: { paddingHorizontal: Spacing.gutter, gap: Spacing.smPlus },

  // The masthead (N509): avatar left, name/handle/DOB stacked beside it.
  header: { flexDirection: 'row', alignItems: 'center', gap: Spacing.md, marginTop: Spacing.xs },
  headerText: { flex: 1, gap: Spacing.xxs },
  name: { fontSize: 26, fontWeight: '800' },
  handle: { color: vola.textMuted, fontSize: 13 },

  // The friends entry point — a small pill rather than a full pill-grid cell,
  // since it is one fact beside the masthead rather than a member of the
  // Dashboard grid below it.
  friendsChip: {
    alignSelf: 'flex-start',
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.xs,
    borderWidth: 1,
    borderColor: vola.line,
    borderRadius: Radius.pill,
    backgroundColor: vola.surface,
    paddingVertical: Spacing.xsPlus,
    paddingHorizontal: Spacing.md,
  },
  friendsChipText: { fontWeight: '700', fontSize: 13 },

  sectionLabel: {
    fontSize: 12,
    color: vola.textDim,
    textTransform: 'uppercase',
    letterSpacing: 1,
    marginTop: 14,
  },

  // The pill/card grid (N509) — Hevy's "Dashboard": two cells per row, each
  // sized to wrap rather than pinned to an exact fraction, so a lone cell (the
  // App section's single Settings pill) stretches to the full gutter width
  // instead of sitting stranded at half of it.
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: Spacing.md },
  pill: {
    ...Card.base,
    overflow: 'hidden',
    flexBasis: '46%',
    flexGrow: 1,
    padding: Spacing.cardPadding,
    gap: Spacing.xs,
  },
  pillPressed: { backgroundColor: vola.surfaceHover },
  pillHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  pillIcon: {
    width: 32,
    height: 32,
    borderRadius: Radius.md,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(255,255,255,0.06)',
  },
  pillLabel: { ...Typography.emphasis, color: vola.text },
  // The value/caption line — only `NavValueRow` (Sports, Phase) uses this;
  // `NavRow`'s pills carry no visible caption, matching the reference, and
  // speak their description through `accessibilityHint` instead.
  pillValue: { ...Typography.caption, color: vola.textMuted },
  // A filled badge rather than an outline: this is a count that wants to be
  // seen from across the screen, and the accent is the athlete's own.
  pillBadge: {
    minWidth: 20,
    paddingHorizontal: 6,
    paddingVertical: 1,
    borderRadius: Radius.pill,
    alignItems: 'center',
    justifyContent: 'center',
  },
  pillBadgeText: { fontSize: 11, fontWeight: '800', fontVariant: ['tabular-nums'] },

  muted: { color: vola.textMuted, fontSize: 13 },
  error: { color: vola.danger, fontSize: 14 },
});
