import { Stack, useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Pressable,
  ScrollView,
  StyleSheet,
  View as RNView,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { BeltMark } from '@/components/BeltMark';
import { Text, View } from '@/components/Themed';
import { Icon } from '@/components/ui/Icon';
import { ProgressRing } from '@/components/ui/ProgressRing';
import { activeBeltAccent, vola } from '@/constants/Colors';
import { useAccent } from '@/lib/AccentProvider';
import { fetchFocus, setFocus, type Focus } from '@/lib/bjjFocus';
import {
  archiveCurriculumEnrollment,
  deleteCurriculum,
  enrollInCurriculum,
  getCurriculum,
  markItemRead,
  unmarkItemRead,
  type Curriculum,
} from '@/lib/curriculum';
import { proposeFocus, proposeOneFocus, type FocusProposal } from '@/lib/roadmapFocus';
import { buildRoadmap, percent, type Lesson, type Milestone } from '@/lib/roadmapView';
import { subscribeSync, syncState } from '@/lib/sync';
import { useAuthToken } from '@/lib/useAuthToken';

/**
 * One belt's roadmap: a numbered timeline of milestones, each opening onto its
 * lessons, each lesson opening onto how it is measured.
 *
 * ## Why it is a hierarchy of collapsed things
 *
 * The user's own framing: *"each bigger thing on tap expands, that's how we see
 * first high level next more in details."* Belt → milestone → lesson, one open
 * at a time at each level, everything closed on arrival.
 *
 * That is a design decision and a **performance** one, and they are the same
 * answer. White belt is 93 lessons across 11 milestones — double the largest
 * list this screen was ever drawn for, and N30 already flagged it as a plain
 * `ScrollView` at 85. Closed, the screen mounts eleven cards, a header and two
 * summary cards regardless of belt; the 93 exist only when an athlete has asked
 * for them, one milestone at a time. So the container stays a `ScrollView`
 * — the worst realistic case is one open milestone, not eleven.
 *
 * **A lesson expands IN PLACE and never navigates away.** In a 93-item roadmap
 * leaving the screen loses your position, and the point of expanding is that
 * the context stays on screen around it.
 *
 * ## What the lesson level says, and what it must never offer
 *
 * It says **how it is measured** — "landed live 12", "classes drilled in 10" —
 * and where the athlete stands against that. It does not offer a checkbox, and
 * cannot: completion is derived from logged evidence, and migration 000034 is
 * explicit that there is deliberately no way to mark a technique mastered by
 * hand. A concept carries no criteria by design, so it reads as *understand
 * this* rather than as an unfinished measurable.
 *
 * The three things the numbers have to be honest about, unchanged from the
 * screen this replaces:
 *
 *  1. **Counting starts the day you enrol.** Someone who has drilled the arm
 *     drag for two years starts at zero. Correct — a rate over your whole
 *     history mostly measures the months you could not do it — but it reads as
 *     a bug unless the screen says so.
 *  2. **Mastery can be taken back**, because it is derived rather than stored.
 *     The copy says "your record shows", never "you have earned".
 *  3. **Not every item counts.** A milestone with nothing completable in it
 *     shows no progress at all rather than 0%.
 */

/** The gutter the numbered circles and their connecting rule live in. */
const RAIL_W = 46;
const CIRCLE = 34;
/** The current milestone's circle is larger, as in the reference. */
const CIRCLE_NOW = 40;

/**
 * What the reference's small controls are short of 44pt, made up in `hitSlop`.
 *
 * The circular back and overflow buttons are 38pt because that is the size the
 * design draws them; the lesson rows are a line of text at ~25pt because that
 * is what a bulleted list is. Neither may grow without leaving the design, and
 * both are below the 44pt minimum — and the lesson row is the screen's PRIMARY
 * interaction, tapped far more than anything else here. `hitSlop` is the way
 * out: it enlarges the touch target without moving a pixel.
 */
const CIRCLE_SLOP = { top: 6, bottom: 6, left: 6, right: 6 } as const;

/** Where a lesson dot's centre sits from the top of its row — `dot.marginTop`
 *  plus half the dot. The inner rule's first and last segments stop there. */
const DOT_CENTRE = 11;
const LESSON_SLOP = { top: 10, bottom: 10, left: 8, right: 8 } as const;

export default function CurriculumScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const getToken = useAuthToken();
  const accent = useAccent();
  const router = useRouter();
  const insets = useSafeAreaInsets();

  const [curriculum, setCurriculum] = useState<Curriculum | null>(null);
  const [focus, setFocusList] = useState<Focus[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Everything closed on open: the screen's first job is to show the SHAPE of
  // the belt — eleven milestones and where you are — not its contents.
  const [openMilestone, setOpenMilestone] = useState<number | null>(null);
  const [openLesson, setOpenLesson] = useState<string | null>(null);
  const [headerOpen, setHeaderOpen] = useState(false);

  const load = useCallback(async () => {
    if (!id) return;
    try {
      // Both, because the lesson-level action is a comparison — what this
      // roadmap wants against what the athlete already holds. Either alone
      // renders half an answer.
      const [c, f] = await Promise.all([getCurriculum(getToken, id), fetchFocus(getToken)]);
      setCurriculum(c);
      setFocusList(f);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [getToken, id]);

  // On focus, not on mount. Enrolling from the Plan tab and coming straight
  // here has to show the change — and a screen pushed over the tabs is exactly
  // the arrangement that made the settings read stale once already.
  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load]),
  );

  /**
   * And again whenever a sync lands — N122.
   *
   * Focus alone is not enough, and the gap is not a corner case: it is the
   * ordinary path. A reflection is saved to SQLite, `requestSync` is
   * fire-and-forget, and the wizard navigates back immediately — so this
   * screen's focus refetch races the outbox push and reliably loses. The
   * athlete then sits looking at pre-session numbers with no further trigger
   * to correct them, which is precisely "I logged it and none of it counted".
   *
   * `lastSyncAt` is the moment the server's answer can have changed. Guarded
   * against the value already seen, so a cold mount does not fire a second
   * identical read on top of the focus one.
   *
   * A SUBSCRIPTION rather than `useSyncState()` plus an effect on the value,
   * and that is not a style preference: the latter is a synchronous setState
   * in an effect body, which `react-hooks/set-state-in-effect` flags and the
   * `--max-warnings` ratchet then refuses. The rule's own guidance names this
   * shape as the correct one — subscribe to an external system, set state from
   * its callback — and it is the better fit anyway, since a sync landing is an
   * event and not a render.
   */
  useEffect(() => {
    let seen = syncState().lastSyncAt;
    return subscribeSync((s) => {
      // SIGN-OUT IS NOT A SYNC. `setSyncIdentity(null, null)` emits
      // `lastSyncAt: null`, which a subscriber holding a number reads as a
      // change — so this would fire `load()` with no identity and flash an
      // error at an athlete who has just signed out, in the window before the
      // layout unmounts the screen. Re-arm and say nothing. This project has
      // had the signed-out-athlete-told-to-sign-in bug once already, across
      // nine modules, when Clerk returned null offline.
      if (s.lastSyncAt === null) {
        seen = null;
        return;
      }
      if (s.lastSyncAt === seen) return;
      seen = s.lastSyncAt;
      void load();
    });
  }, [load]);

  const view = useMemo(() => (curriculum ? buildRoadmap(curriculum) : null), [curriculum]);

  /**
   * What is already in the focus list.
   *
   * A `Set` built once rather than a `.some()` per lesson: an open milestone
   * draws up to thirteen of these and the focus list is capped at five, so the
   * cost is trivial either way — but the lesson row needs the ANSWER, not the
   * list, which is the same argument `criteriaChips` makes about keeping
   * display decisions out of the component.
   */
  const inFocus = useMemo(
    () => new Set((focus ?? []).map((f) => f.technique_id)),
    [focus],
  );

  const toggleEnrollment = useCallback(async () => {
    if (!curriculum) return;
    setBusy(true);
    try {
      if (curriculum.enrolled) await archiveCurriculumEnrollment(getToken, curriculum.id);
      else await enrollInCurriculum(getToken, curriculum.id);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, [curriculum, getToken, load]);

  const applyFocus = useCallback(
    async (proposal: FocusProposal) => {
      if (!curriculum) return;
      setBusy(true);
      try {
        // `fromRoadmap`, never `next` — the difference is the athlete's own
        // entries, which this roadmap carries along but does not own.
        // Attributing those to it would delete them when it is deactivated.
        await setFocus(getToken, proposal.next, {
          curriculum_id: curriculum.id,
          technique_ids: proposal.fromRoadmap,
        });
        await load();
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setBusy(false);
      }
    },
    [curriculum, getToken, load],
  );

  const confirmFocus = useCallback(
    (proposal: FocusProposal) => {
      const evicted = proposal.dropped.filter((d) => d.reason === 'evicted');
      if (evicted.length === 0) {
        void applyFocus(proposal);
        return;
      }
      // The only destructive case, and it gets a confirm rather than a toast
      // after the fact. `PUT /v1/bjj/focus` replaces wholesale, so these
      // techniques are gone — and which five you carry is the athlete's call.
      Alert.alert(
        'Replace part of your focus?',
        `This drops ${evicted.map((d) => d.focus.name).join(', ')} to stay within five. ` +
          'You can add them back from the focus list.',
        [
          { text: 'Cancel', style: 'cancel' },
          { text: 'Replace', style: 'destructive', onPress: () => void applyFocus(proposal) },
        ],
      );
    },
    [applyFocus],
  );

  /**
   * "Work on this" from an expanded lesson — one technique, nothing behind it.
   *
   * The `unchanged` guard stays as a backstop, but the button is no longer
   * RENDERED for a technique already in focus (see `inFocus` below), which is
   * the real fix: a control that returns silently is indistinguishable from a
   * control that is broken, and the athlete's reasonable reading of "nothing
   * happened" is that the app dropped their tap. The row says "Already in
   * your focus" instead — which is also the more useful answer, since it
   * tells them the chip is waiting for them in the reflection wizard.
   *
   * **`inFocus` is plain list membership, not claim awareness** — so this
   * control never reaches N100/N100.1's claim-only case (a technique already
   * in focus but not yet claimed by THIS roadmap, whether that gap is real or
   * unclaimable): whenever the technique is already in focus, the button is
   * hidden regardless. Registering (or not being able to register) a claim
   * for an already-focused technique is what `openMenu`'s whole-roadmap
   * "Update your focus for this roadmap" option is for, not this one.
   */
  const workOnLesson = useCallback(
    (techniqueID: string) => {
      if (!curriculum || !focus) return;
      const proposal = proposeOneFocus(curriculum.items ?? [], focus, curriculum.id, techniqueID);
      if (proposal.unchanged) return;
      confirmFocus(proposal);
    },
    [confirmFocus, curriculum, focus],
  );

  /**
   * N123. The athlete's OWN claim to have read and understood a concept —
   * never a technique, and never through this control: the backend refuses a
   * technique item at the database level, and this button is rendered only
   * inside the `l.measures === null` branch, which is concepts alone.
   *
   * Deliberately its own handler rather than sharing `workOnLesson`'s or
   * `toggleEnrollment`'s shape, even though all three follow the same
   * optimistic-reload pattern — "log evidence toward mastery" and "attest you
   * read this" are different actions, and the ticket's own acceptance
   * criterion is that they must not share a control. A shared function name
   * would be a shared control with extra steps.
   */
  const toggleItemRead = useCallback(
    async (itemID: number, currentlyRead: boolean) => {
      if (!curriculum) return;
      setBusy(true);
      try {
        if (currentlyRead) await unmarkItemRead(getToken, curriculum.id, itemID);
        else await markItemRead(getToken, curriculum.id, itemID);
        await load();
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setBusy(false);
      }
    },
    [curriculum, getToken, load],
  );

  /**
   * Permanent, and gated on `curriculum.editable` the same way the two menu
   * entries below are — resolved server-side, never inferred. Confirmed
   * through a second `Alert`, matching the eviction confirm above rather than
   * a `HoldToConfirm`: the overflow already interrupts the athlete once, and
   * a second alert costs nothing new there, where `HoldToConfirm` earns its
   * keep on a screen where the delete control sits inline (the edit screen,
   * N83's `curriculum/edit/[id].tsx`).
   */
  const deleteNow = useCallback(async () => {
    if (!curriculum) return;
    setBusy(true);
    try {
      await deleteCurriculum(getToken, curriculum.id);
      router.replace('/curriculum');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  }, [curriculum, getToken, router]);

  /**
   * The overflow, and everything that is not reading lives in it.
   *
   * Enrolment and the bulk focus write are both about the whole roadmap rather
   * than about any milestone, and the reference gives them no place on the
   * timeline. An `Alert` rather than a sheet because this app has no sheet
   * primitive and the destructive case already goes through one.
   *
   * **Edit and Delete (N83) are gated on `curriculum.editable`**, exactly the
   * same field `apps/web`'s detail page gates its own Edit link and Delete
   * button on — a belt syllabus and another athlete's shared curriculum both
   * read `editable: false`, and offering either action there would promise a
   * write the server refuses.
   */
  const openMenu = useCallback(() => {
    if (!curriculum) return;
    const proposal = focus ? proposeFocus(curriculum.items ?? [], focus, curriculum.id) : null;
    const options: { text: string; style?: 'cancel' | 'destructive'; onPress?: () => void }[] = [];

    // `!proposal.unchanged` ALONE, not `&& proposal.added.length > 0` — the
    // second half used to hide this option for exactly the case N100 exists
    // to fix. A second roadmap whose techniques are ALREADY all in focus adds
    // nothing new (`added` is empty), but applying still WRITES: it registers
    // this roadmap's own claim in `bjj_focus_sources`, without which a later
    // deactivation of whichever roadmap DOES hold the claim takes the
    // technique out of focus while this one is still working it.
    if (proposal && !proposal.unchanged) {
      options.push({
        text:
          proposal.added.length > 0
            ? `Work these next (${proposal.added.length})`
            : 'Update your focus for this roadmap',
        onPress: () => confirmFocus(proposal),
      });
    }
    options.push({
      // Keyed on `countable_items`, not on the track — a track is a grouping
      // hint and must never gate anything. "Start working this" on a list with
      // nothing completable promises progress that cannot arrive.
      text: curriculum.enrolled
        ? 'Put this down'
        : curriculum.countable_items > 0
          ? 'Start working this'
          : 'Keep this handy',
      style: curriculum.enrolled ? 'destructive' : undefined,
      onPress: () => void toggleEnrollment(),
    });
    if (curriculum.editable) {
      options.push({
        text: 'Edit',
        onPress: () => router.push(`/curriculum/edit/${curriculum.id}`),
      });
      options.push({
        text: 'Delete curriculum',
        style: 'destructive',
        onPress: () =>
          Alert.alert(
            'Delete this curriculum?',
            `"${curriculum.name}" will be removed. This can't be undone.`,
            [
              { text: 'Cancel', style: 'cancel' },
              { text: 'Delete', style: 'destructive', onPress: () => void deleteNow() },
            ],
          ),
      });
    }
    options.push({ text: 'Cancel', style: 'cancel' });

    Alert.alert(
      curriculum.name,
      curriculum.enrolled && curriculum.started_on !== null
        ? `Counted from what you have logged since ${curriculum.started_on}. Your record decides these, so a long run of misses can take one back.`
        : 'Nothing here can be ticked off by hand — milestones complete from what you log.',
      options,
    );
  }, [confirmFocus, curriculum, deleteNow, focus, router, toggleEnrollment]);

  const goBack = useCallback(() => {
    if (router.canGoBack()) router.back();
    else router.replace('/');
  }, [router]);

  if (error && !curriculum) {
    return (
      <View style={[styles.fallback, { paddingTop: insets.top + 12 }]}>
        <Stack.Screen options={{ headerShown: false }} />
        <BackButton onPress={goBack} />
        <Text style={styles.error}>{error}</Text>
      </View>
    );
  }
  if (!curriculum || !view) {
    return (
      <View style={[styles.fallback, { paddingTop: insets.top + 12 }]}>
        <Stack.Screen options={{ headerShown: false }} />
        <BackButton onPress={goBack} />
        <ActivityIndicator style={styles.loading} />
      </View>
    );
  }

  // The belt's own colour carries the whole screen — the rule, the counts, the
  // dots, both rings. An athlete's own list belongs to no belt and falls back
  // to their chosen accent.
  const tone = view.beltKey ? activeBeltAccent[view.beltKey] : accent.accent;
  const ringPercent =
    curriculum.enrolled && view.progress !== null ? percent(view.progress) : null;
  // The first milestone that is not finished and has something to finish.
  const current = view.milestones.find((m) => m.progress !== null && !m.complete)?.index ?? null;

  return (
    <View style={styles.screen}>
      <Stack.Screen options={{ headerShown: false }} />
      <ScrollView
        contentContainerStyle={[
          styles.scroll,
          { paddingTop: insets.top + 8, paddingBottom: insets.bottom + 40 },
        ]}
        testID="curriculum-screen"
      >
        <RNView style={styles.topRow}>
          <BackButton onPress={goBack} />
          <Pressable
            onPress={openMenu}
            disabled={busy}
            accessibilityRole="button"
            accessibilityLabel="Roadmap options"
            testID="roadmap-menu"
            hitSlop={CIRCLE_SLOP}
            style={({ pressed }) => [styles.circleButton, pressed && styles.pressed]}
          >
            <Text style={styles.menuGlyph}>•••</Text>
          </Pressable>
        </RNView>

        {/* The belt name is the most distinctive type on the screen: uppercase,
            wide-tracked, centred, and NOT a navigation title. */}
        <Text style={styles.beltName} numberOfLines={2} testID="roadmap-title">
          {view.title}
        </Text>
        {view.beltKey && (
          <RNView style={styles.markRow}>
            <BeltMark belt={view.beltKey} width={64} />
          </RNView>
        )}

        {/* The belt level's own disclosure: the thesis is the one line, and the
            author's full rationale is behind it rather than pushing the
            milestones off the first screen.

            **The description is rendered OUTSIDE the pressable, and the
            pressable carries no `accessibilityLabel`.** Both halves matter and
            both were wrong first time. A label REPLACES an element's children
            for a screen reader, so labelling this button silenced the thesis
            itself; and anything nested inside an accessible element is not
            reachable as its own node, so the description — which is where all
            three of the belt's orphaned framing phases went in #445 — was
            announced by nothing at all. A belt's entire framing, invisible.
            Without the label the button speaks its own text, which is the
            thesis, and the hint says what tapping does. */}
        <RNView style={styles.thesisWrap}>
          <Pressable
            onPress={() => setHeaderOpen((v) => !v)}
            accessibilityRole="button"
            accessibilityState={{ expanded: headerOpen }}
            accessibilityHint={
              headerOpen ? 'Hides what this belt is for' : 'Shows what this belt is for'
            }
            testID="roadmap-thesis"
            style={({ pressed }) => [pressed && styles.pressed]}
          >
            <Text style={styles.thesis}>{view.thesis}</Text>
          </Pressable>
          {headerOpen && (
            <Text style={styles.description} testID="roadmap-description">
              {view.description}
            </Text>
          )}
        </RNView>

        {error && <Text style={styles.error}>{error}</Text>}

        {/* Progress card. Both belts get one — the reference only drew it on
            blue, and two belts behaving differently is a worse outcome than
            matching one image exactly. It is also where "0 of 11 milestones
            completed" lives, which is the sentence the screen exists to say. */}
        <RNView style={styles.card} testID="roadmap-progress-card">
          <RNView style={[styles.tile, { borderColor: tone }]}>
            <Icon name="trophy" size={22} color={tone} />
          </RNView>
          <RNView style={styles.cardBody}>
            <Text style={styles.cardTitle}>{titleCase(view.title)} path</Text>
            <Text style={styles.cardNote}>
              {view.completedMilestones} of {view.countableMilestones} milestone
              {view.countableMilestones === 1 ? '' : 's'} completed
            </Text>
            <Bar fraction={curriculum.enrolled ? (view.progress ?? 0) : 0} tone={tone} />
            {/* A SEPARATE FIGURE, never blended into the milestone bar above —
                the ticket's own recommendation. Read state is the athlete's
                own attestation, not derived evidence, so it must never dilute
                or inflate what the ring and bar report. Hidden entirely when
                nothing here is a concept, matching how the bar itself is
                absent for a milestone with nothing completable. */}
            {curriculum.concept_items > 0 && (
              <Text style={styles.conceptsReadNote} testID="roadmap-concepts-read">
                {curriculum.read_concepts} of {curriculum.concept_items} concept
                {curriculum.concept_items === 1 ? '' : 's'} read
              </Text>
            )}
          </RNView>
          <ProgressRing
            percent={ringPercent}
            color={tone}
            label={
              ringPercent === null
                ? 'Not started — nothing is being counted yet'
                : `${ringPercent} percent of milestones completed`
            }
            testID="roadmap-progress-ring"
          />
        </RNView>

        {!curriculum.enrolled && (
          <Pressable
            onPress={() => void toggleEnrollment()}
            disabled={busy}
            style={({ pressed }) => [
              styles.primary,
              { backgroundColor: tone },
              pressed && styles.pressed,
              busy && styles.disabled,
            ]}
            accessibilityRole="button"
            testID="curriculum-enrollment"
          >
            <Text style={[styles.primaryText, { color: vola.bg }]}>
              {curriculum.countable_items > 0 ? 'Start working this' : 'Keep this handy'}
            </Text>
          </Pressable>
        )}

        <RNView style={styles.timeline}>
          {view.milestones.map((m, i) => (
            <MilestoneCard
              key={m.index}
              milestone={m}
              tone={tone}
              enrolled={curriculum.enrolled}
              isCurrent={m.index === current}
              isFirst={i === 0}
              isLast={i === view.milestones.length - 1}
              open={openMilestone === m.index}
              openLesson={openMilestone === m.index ? openLesson : null}
              busy={busy}
              onToggle={() => {
                setOpenLesson(null);
                setOpenMilestone((v) => (v === m.index ? null : m.index));
              }}
              onToggleLesson={(key) => setOpenLesson((v) => (v === key ? null : key))}
              onWork={workOnLesson}
              onToggleRead={toggleItemRead}
              inFocus={inFocus}
            />
          ))}
        </RNView>

        {/* Completion card — what the athlete will have, in the author's own
            words, and the same figure the progress ring carries. */}
        <RNView style={styles.card} testID="roadmap-completion-card">
          <RNView style={[styles.tile, { borderColor: tone }]}>
            <Icon name="goal" size={22} color={tone} />
          </RNView>
          <RNView style={styles.cardBody}>
            <Text style={styles.cardTitle}>{titleCase(view.title)} complete</Text>
            <Text style={styles.cardNote}>{view.goal}</Text>
          </RNView>
          <ProgressRing
            percent={ringPercent}
            size={44}
            color={tone}
            label={
              ringPercent === null
                ? 'Not started — nothing is being counted yet'
                : `${ringPercent} percent complete`
            }
            testID="roadmap-completion-ring"
          />
        </RNView>
      </ScrollView>
    </View>
  );
}

function BackButton({ onPress }: { onPress: () => void }) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel="Back"
      testID="roadmap-back"
      hitSlop={CIRCLE_SLOP}
      style={({ pressed }) => [styles.circleButton, pressed && styles.pressed]}
    >
      <Icon name="back" size={20} color={vola.text} />
    </Pressable>
  );
}

/**
 * One milestone: a circled number on the belt-coloured rule, and a card.
 *
 * The rule is drawn per row and butted against its neighbours rather than as
 * one element behind the list, so it stays continuous without anything having
 * to measure the rows. The first row's segment starts at its circle's centre
 * and the last row's ends at its own, which is what stops the line running off
 * into the cards above and below.
 */
function MilestoneCard({
  milestone: m,
  tone,
  enrolled,
  isCurrent,
  isFirst,
  isLast,
  open,
  openLesson,
  busy,
  onToggle,
  onToggleLesson,
  onWork,
  onToggleRead,
  inFocus,
}: {
  milestone: Milestone;
  tone: string;
  enrolled: boolean;
  isCurrent: boolean;
  isFirst: boolean;
  isLast: boolean;
  open: boolean;
  openLesson: string | null;
  busy: boolean;
  onToggle: () => void;
  onToggleLesson: (key: string) => void;
  onWork: (techniqueID: string) => void;
  onToggleRead: (itemID: number, currentlyRead: boolean) => void;
  inFocus: ReadonlySet<string>;
}) {
  const size = isCurrent ? CIRCLE_NOW : CIRCLE;
  const half = Math.round(size / 2);

  return (
    <RNView style={styles.row} testID={`roadmap-row-${m.index}`}>
      <RNView style={styles.gutter}>
        {!(isFirst && isLast) && (
          <RNView
            /* Each case supplies its OWN vertical extent, and `styles.rail`
               deliberately carries none. With `top`/`bottom` in the base style
               the last segment's `height` merged on top of an inherited
               `bottom: 0` — and Yoga resolves top+bottom by stretching and
               ignoring the height, so the final segment ran past its circle and
               down into the completion card. A style that is overridden in one
               branch and inherited in another is the whole hazard; there is
               nothing to inherit now. */
            style={[
              styles.rail,
              { backgroundColor: tone },
              isFirst
                ? { top: half, bottom: 0 }
                : isLast
                  ? { top: 0, height: half }
                  : { top: 0, bottom: 0 },
            ]}
            testID={`roadmap-rail-${m.index}`}
          />
        )}
        <RNView
          style={[
            styles.circle,
            {
              width: size,
              height: size,
              borderRadius: half,
              borderColor: m.complete || isCurrent ? tone : vola.line,
              borderWidth: isCurrent ? 2 : 1.5,
            },
            m.complete && { backgroundColor: tone },
          ]}
        >
          {m.complete ? (
            <Icon name="check" size={16} color={vola.bg} />
          ) : (
            <Text style={[styles.circleText, isCurrent && { color: vola.text }]}>{m.index}</Text>
          )}
        </RNView>
      </RNView>

      <RNView style={styles.cardCol}>
        <Pressable
          onPress={onToggle}
          accessibilityRole="button"
          accessibilityState={{ expanded: open }}
          /* The mastered suffix is gated on `enrolled` for the same reason the
             visible counter is: nothing is being counted until the athlete
             takes the roadmap on, so "0 of 2 mastered" reports a shortfall
             against a clock that has not started. Leaving it ungated leaks
             exactly the claim the rest of the screen refuses, through the one
             layer nobody looks at. */
          accessibilityLabel={`Milestone ${m.index}, ${m.title}, ${m.lessons.length} lesson${
            m.lessons.length === 1 ? '' : 's'
          }${
            enrolled && m.progress !== null
              ? `, ${m.mastered} of ${m.countable} mastered`
              : ''
          }`}
          testID={`roadmap-milestone-${m.index}`}
          style={({ pressed }) => [styles.milestone, open && styles.milestoneOpen, pressed && styles.pressed]}
        >
          <RNView style={styles.milestoneHead}>
            <RNView style={styles.milestoneTitleCol}>
              <Text style={styles.milestoneTitle}>{m.title}</Text>
              <Text style={[styles.lessonCount, { color: tone }]}>
                {m.lessons.length} lesson{m.lessons.length === 1 ? '' : 's'}
              </Text>
            </RNView>
            {/* One glyph, turned over — the kit has no chevron-up, and a
                different drawing for "open" reads as a different control. */}
            <RNView style={open ? styles.chevronUp : undefined}>
              <Icon name="chevron-down" size={18} color={vola.textMuted} />
            </RNView>
          </RNView>

          {/* Progress at this level's own granularity, so a closed milestone
              still answers "have I done this". Absent entirely when nothing
              here can be completed — a milestone of concepts at 0% reads as
              failure, and it is not one. */}
          {enrolled && m.progress !== null && (
            <RNView style={styles.milestoneProgress}>
              <Bar fraction={m.progress} tone={tone} />
              <Text style={styles.milestoneCount}>
                {m.mastered}/{m.countable}
              </Text>
            </RNView>
          )}
        </Pressable>

        {open && (
          <RNView style={styles.lessons} testID={`roadmap-lessons-${m.index}`}>
            {m.description !== '' && <Text style={styles.milestoneNote}>{m.description}</Text>}
            {m.lessons.map((l, i) => (
              <LessonRow
                key={l.key}
                lesson={l}
                tone={tone}
                enrolled={enrolled}
                isFirst={i === 0}
                isLast={i === m.lessons.length - 1}
                open={openLesson === l.key}
                busy={busy}
                onToggle={() => onToggleLesson(l.key)}
                onWork={onWork}
                onToggleRead={onToggleRead}
                inFocus={l.techniqueID !== null && inFocus.has(l.techniqueID)}
              />
            ))}
          </RNView>
        )}
      </RNView>
    </RNView>
  );
}

/**
 * One lesson: a dot on an inner rule, and its detail underneath when open.
 *
 * **The detail says how it is MEASURED and offers no checkbox**, because there
 * is nothing a tap could set: completion is read back off logged evidence.
 * What the athlete can do from here is start it — put it in the focus list, so
 * it becomes a one-tap chip in the reflection wizard, which is what records the
 * evidence these thresholds read.
 */
function LessonRow({
  lesson: l,
  tone,
  enrolled,
  isFirst,
  isLast,
  open,
  busy,
  onToggle,
  onWork,
  onToggleRead,
  inFocus,
}: {
  lesson: Lesson;
  tone: string;
  enrolled: boolean;
  isFirst: boolean;
  isLast: boolean;
  open: boolean;
  busy: boolean;
  onToggle: () => void;
  onWork: (techniqueID: string) => void;
  onToggleRead: (itemID: number, currentlyRead: boolean) => void;
  /** Already in the focus list, so there is nothing left for the button to do. */
  inFocus: boolean;
}) {
  const techniqueID = l.techniqueID;
  const state = l.mastered
    ? 'Your record clears this'
    : l.started
      ? 'Under way — your record has evidence for this'
      : enrolled
        ? 'Nothing logged against this yet'
        : 'Start working this roadmap to begin counting';

  return (
    <RNView style={styles.lessonWrap}>
      <RNView style={styles.lessonGutter}>
        {!(isFirst && isLast) && (
          <RNView
            /* Same three cases, same reason as the outer rule. */
            style={[
              styles.innerRail,
              { backgroundColor: tone },
              isFirst
                ? { top: DOT_CENTRE, bottom: 0 }
                : isLast
                  ? { top: 0, height: DOT_CENTRE }
                  : { top: 0, bottom: 0 },
            ]}
            testID={`roadmap-inner-rail-${l.key}`}
          />
        )}
        <RNView
          style={[
            styles.dot,
            { borderColor: tone },
            (l.mastered || l.measures === null) && { backgroundColor: tone },
          ]}
        />
      </RNView>

      <RNView style={styles.lessonCol}>
        <Pressable
          onPress={onToggle}
          accessibilityRole="button"
          accessibilityState={{ expanded: open }}
          accessibilityLabel={`${l.name}. ${l.measures === null ? 'Something to understand' : state}`}
          testID={`roadmap-lesson-${l.key}`}
          hitSlop={LESSON_SLOP}
          style={({ pressed }) => [styles.lessonHead, pressed && styles.pressed]}
        >
          <Text style={[styles.lessonName, l.mastered && { color: tone }]}>{l.name}</Text>
        </Pressable>

        {open && (
          <RNView style={styles.lessonDetail} testID={`roadmap-lesson-detail-${l.key}`}>
            {l.notes !== '' && <Text style={styles.lessonNotes}>{l.notes}</Text>}

            {l.measures === null ? (
              /* A concept carries no criteria by design, and dressing one as an
                 unfinished measurable would misreport it. */
              <>
                <Text style={styles.understand}>
                  Understand this. There is nothing to count — it is an idea the
                  milestone is teaching, not a step your record completes.
                </Text>
                {/* N123. A checkbox affordance, not a "Work on this"-style CTA —
                    the two are genuinely different actions ("log evidence"
                    versus "attest you read this") and per the ticket's own
                    acceptance criterion must not share a control. Reversible:
                    tapping again withdraws the claim, and the label changes to
                    say so rather than relying on the same tap reading two ways. */}
                <Pressable
                  onPress={() => onToggleRead(l.itemID, l.read)}
                  disabled={busy}
                  accessibilityRole="checkbox"
                  accessibilityState={{ checked: l.read, disabled: busy }}
                  accessibilityLabel={
                    l.read ? 'Read and understood' : 'Mark as read and understood'
                  }
                  accessibilityHint={
                    l.read
                      ? 'Marks this idea as not yet read'
                      : 'Marks this idea as read and understood — your own note, not evidence of mastery'
                  }
                  testID={`roadmap-read-toggle-${l.key}`}
                  style={({ pressed }) => [
                    styles.readToggle,
                    pressed && styles.pressed,
                    busy && styles.disabled,
                  ]}
                >
                  <RNView
                    style={[
                      styles.readBox,
                      { borderColor: tone },
                      l.read && { backgroundColor: tone },
                    ]}
                  >
                    {l.read && <Icon name="check" size={11} color={vola.bg} />}
                  </RNView>
                  <Text style={[styles.readToggleText, l.read && { color: tone }]}>
                    {l.read ? 'Read and understood' : 'Mark as read and understood'}
                  </Text>
                </Pressable>
              </>
            ) : (
              <>
                <Text style={styles.measureHead}>HOW THIS IS MEASURED</Text>
                {l.measures.map((mu) => (
                  <RNView key={mu.label} style={styles.measureRow}>
                    <Text style={[styles.measureLabel, mu.met && { color: tone }]}>{mu.label}</Text>
                    <Text style={[styles.measureValue, mu.met && { color: tone }]}>
                      {mu.have === null ? mu.need : `${mu.have} / ${mu.need}`}
                    </Text>
                  </RNView>
                ))}
                <Text style={styles.lessonState}>{state}</Text>
                {/* N122. The state line above can honestly say "your record
                    has evidence for this" while every number beside it reads
                    zero — that is what drilling a live-measured technique
                    looks like, and it was reported as the counts simply not
                    registering. Says what the evidence WAS and what would move
                    these numbers, rather than offering a checkbox the data
                    model refuses. */}
                {l.evidenceNote !== null && (
                  <Text style={styles.evidenceNote} testID={`roadmap-evidence-${l.key}`}>
                    {l.evidenceNote}
                  </Text>
                )}
              </>
            )}

            {techniqueID !== null && l.measures !== null && !l.mastered && inFocus && (
              <Text style={styles.alreadyFocused} testID={`roadmap-in-focus-${l.key}`}>
                Already in your focus — it shows as a one-tap chip when you log a session.
              </Text>
            )}

            {techniqueID !== null && l.measures !== null && !l.mastered && !inFocus && (
              <Pressable
                onPress={() => onWork(techniqueID)}
                disabled={busy}
                accessibilityRole="button"
                testID={`roadmap-work-${l.key}`}
                style={({ pressed }) => [
                  styles.secondary,
                  { borderColor: tone },
                  pressed && styles.pressed,
                  busy && styles.disabled,
                ]}
              >
                <Text style={[styles.secondaryText, { color: tone }]}>Work on this</Text>
              </Pressable>
            )}
          </RNView>
        )}
      </RNView>
    </RNView>
  );
}

/** The thin full-width rule under a card's text. Never labelled — the number
 *  beside or above it always says the same thing in words. */
function Bar({ fraction, tone }: { fraction: number; tone: string }) {
  const pct = Math.max(0, Math.min(1, fraction)) * 100;
  return (
    <RNView style={styles.barTrack}>
      {pct > 0 && (
        <RNView style={[styles.barFill, { width: `${pct}%`, backgroundColor: tone }]} />
      )}
    </RNView>
  );
}

/** "WHITE BELT" → "White belt". The cards read as sentences, not as mastheads. */
function titleCase(s: string): string {
  const lower = s.toLowerCase();
  return lower.charAt(0).toUpperCase() + lower.slice(1);
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  fallback: { flex: 1, paddingHorizontal: 20, gap: 12 },
  scroll: { paddingHorizontal: 20, gap: 12 },
  loading: { marginTop: 24 },
  error: { color: vola.danger, fontSize: 14 },

  topRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  circleButton: {
    width: 38,
    height: 38,
    borderRadius: 19,
    backgroundColor: vola.surfaceRaised,
    alignItems: 'center',
    justifyContent: 'center',
  },
  menuGlyph: { color: vola.text, fontSize: 13, fontWeight: '800', letterSpacing: 0.5 },

  beltName: {
    textAlign: 'center',
    color: vola.text,
    fontSize: 19,
    fontWeight: '700',
    // The signature of the whole screen. Wide enough that "WHITE BELT" reads
    // as a masthead rather than as a navigation title.
    letterSpacing: 4.5,
    marginTop: 4,
  },
  markRow: { alignItems: 'center', marginTop: -2 },
  thesisWrap: { gap: 8 },
  thesis: {
    textAlign: 'center',
    color: vola.textMuted,
    fontSize: 14,
    lineHeight: 20,
  },
  description: { color: vola.textMuted, fontSize: 13, lineHeight: 19 },

  card: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    backgroundColor: vola.surface,
    borderRadius: 16,
    padding: 14,
    marginTop: 4,
  },
  tile: {
    width: 46,
    height: 46,
    borderRadius: 12,
    borderWidth: 1,
    backgroundColor: vola.surfaceRaised,
    alignItems: 'center',
    justifyContent: 'center',
  },
  cardBody: { flex: 1, gap: 5 },
  cardTitle: { color: vola.text, fontSize: 16, fontWeight: '700' },
  cardNote: { color: vola.textMuted, fontSize: 12, lineHeight: 17 },
  // A separate line from cardNote/the bar above it — see the call site's
  // comment for why this must never blend into the milestone figure.
  conceptsReadNote: { color: vola.textDim, fontSize: 11, lineHeight: 16, marginTop: 1 },

  barTrack: {
    height: 3,
    borderRadius: 2,
    backgroundColor: vola.line,
    overflow: 'hidden',
    marginTop: 2,
  },
  barFill: { height: 3, borderRadius: 2 },

  primary: { borderRadius: 12, paddingVertical: 13, alignItems: 'center' },
  primaryText: { fontSize: 15, fontWeight: '700' },
  secondary: {
    borderRadius: 10,
    borderWidth: 1,
    paddingVertical: 9,
    alignItems: 'center',
    marginTop: 4,
  },
  secondaryText: { fontSize: 13, fontWeight: '700' },
  pressed: { opacity: 0.6 },
  disabled: { opacity: 0.5 },

  timeline: { marginTop: 4 },
  /* **The row carries NO vertical spacing, and that is what makes the rule
     continuous.** The gutter is a stretched *child*, so its height is the row's
     CONTENT box — padding on the row is space the gutter never occupies, and an
     absolutely-positioned `bottom: 0` rail cannot reach into it. Ten pixels of
     row padding turned one belt-coloured line into eleven dashes, which is the
     single defining feature of the reference design. The spacing lives on
     `cardCol` instead, inside the box the gutter stretches to match — exactly
     the arrangement `lessonWrap`/`lessonCol` already uses one level down, which
     is why the inner rule never had this bug. If you ever need to space these
     rows apart, put it on `cardCol`. */
  row: { flexDirection: 'row' },
  gutter: { width: RAIL_W, alignItems: 'center' },
  // No `top`/`bottom` here on purpose — see the call site.
  rail: {
    position: 'absolute',
    width: 2,
    left: RAIL_W / 2 - 1,
  },
  circle: {
    alignItems: 'center',
    justifyContent: 'center',
    // Opaque, so the rule passes BEHIND the circle rather than through it.
    backgroundColor: vola.bg,
  },
  circleText: {
    color: vola.textMuted,
    fontSize: 15,
    fontWeight: '700',
    fontVariant: ['tabular-nums'],
  },

  // The timeline's row spacing. On this column and not on `row` — see above.
  cardCol: { flex: 1, paddingBottom: 10 },
  milestone: {
    backgroundColor: vola.surface,
    borderRadius: 14,
    paddingHorizontal: 14,
    paddingVertical: 12,
    gap: 8,
  },
  // Square off the bottom when open, so the header and its lessons read as one
  // card rather than as a card with a list floating under it.
  milestoneOpen: { borderBottomLeftRadius: 0, borderBottomRightRadius: 0, paddingBottom: 10 },
  milestoneHead: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  milestoneTitleCol: { flex: 1, gap: 2 },
  milestoneTitle: { color: vola.text, fontSize: 17, fontWeight: '700' },
  lessonCount: { fontSize: 13, fontWeight: '600' },
  milestoneProgress: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  milestoneCount: {
    color: vola.textDim,
    fontSize: 11,
    fontWeight: '700',
    fontVariant: ['tabular-nums'],
  },
  milestoneNote: { color: vola.textMuted, fontSize: 12, lineHeight: 17, marginBottom: 2 },

  lessons: {
    backgroundColor: vola.surface,
    borderBottomLeftRadius: 14,
    borderBottomRightRadius: 14,
    paddingHorizontal: 14,
    paddingBottom: 12,
    // The hairline the reference draws under the milestone's own header.
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: vola.line,
    paddingTop: 10,
  },
  lessonWrap: { flexDirection: 'row' },
  lessonGutter: { width: 22, alignItems: 'center' },
  innerRail: { position: 'absolute', width: 1, left: 10.5, opacity: 0.45 },
  dot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    borderWidth: 1,
    marginTop: 7,
    backgroundColor: vola.surface,
  },
  lessonCol: { flex: 1, paddingBottom: 4 },
  lessonHead: { paddingVertical: 3 },
  lessonName: { color: vola.text, fontSize: 14, lineHeight: 19 },
  lessonDetail: { gap: 6, paddingTop: 4, paddingBottom: 8 },
  lessonNotes: { color: vola.textMuted, fontSize: 12, lineHeight: 17 },
  understand: { color: vola.textMuted, fontSize: 12, lineHeight: 17, fontStyle: 'italic' },
  // The read toggle (N123) — a checkbox affordance, deliberately NOT styled
  // like `secondary`/`secondaryText` below: "log evidence" and "attest you
  // read this" must not look like the same control, per the ticket's own
  // acceptance criterion that the two share no control.
  readToggle: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginTop: 6,
    paddingVertical: 2,
  },
  readBox: {
    width: 18,
    height: 18,
    borderRadius: 5,
    borderWidth: 1.5,
    alignItems: 'center',
    justifyContent: 'center',
  },
  readToggleText: { color: vola.textMuted, fontSize: 13, fontWeight: '600' },
  measureHead: {
    color: vola.textDim,
    fontSize: 9,
    fontWeight: '800',
    letterSpacing: 1,
    marginTop: 2,
  },
  measureRow: { flexDirection: 'row', justifyContent: 'space-between', gap: 12 },
  measureLabel: { color: vola.textMuted, fontSize: 12, flex: 1 },
  measureValue: {
    color: vola.text,
    fontSize: 12,
    fontWeight: '700',
    fontVariant: ['tabular-nums'],
  },
  lessonState: { color: vola.textDim, fontSize: 11, lineHeight: 16, marginTop: 2 },
  alreadyFocused: { color: vola.textDim, fontSize: 11, lineHeight: 16, marginTop: 4 },
  evidenceNote: { color: vola.textDim, fontSize: 11, lineHeight: 16, marginTop: 4 },
  chevronUp: { transform: [{ rotate: '180deg' }] },
});
