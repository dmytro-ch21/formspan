import { Stack, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { useCallback, useState } from 'react';
import { ActivityIndicator, Alert, Pressable, ScrollView, StyleSheet, View as RNView } from 'react-native';

import { Text, View } from '@/components/Themed';
import { SectionHeader } from '@/components/ui/Section';
import { TechniqueRow } from '@/components/ui/TechniqueRow';
import { vola } from '@/constants/Colors';
import { useAccent } from '@/lib/AccentProvider';
import { fetchFocus, setFocus, type Focus } from '@/lib/bjjFocus';
import {
  archiveCurriculumEnrollment,
  enrollInCurriculum,
  getCurriculum,
  type Curriculum,
  type CurriculumItem,
} from '@/lib/curriculum';
import { groupByPhase } from '@/lib/curriculumPhases';
import { criteriaChips, hasEvidence } from '@/lib/curriculumRow';
import { proposeFocus, type FocusProposal } from '@/lib/roadmapFocus';
import { useAuthToken } from '@/lib/useAuthToken';

/**
 * One roadmap, and the action that makes the phone self-sufficient.
 *
 * **Why this is here and not only on web.** The design doc's own connective
 * table puts roadmap progress on Plan and the focus chips in the reflection
 * wizard — both this app. Only *building* a curriculum was ever meant to be a
 * desk job. Until this screen existed the loop was broken across devices: the
 * chips were here, the events were here, the criteria read those events, and
 * the one step that chose which techniques to work sat on a laptop.
 *
 * The three things the numbers have to be honest about, same as web:
 *
 *  1. **Counting starts the day you enrol.** Someone who has drilled the arm
 *     drag for two years starts at zero. Correct — a rate over your whole
 *     history mostly measures the months you could not do it — but it reads as
 *     a bug unless the screen says so.
 *  2. **Mastery can be taken back**, because it is derived rather than stored.
 *     The copy says "your record shows", never "you have earned".
 *  3. **Not every item counts.** Items with no criteria are reading, and the
 *     denominator is `countable_items`, which the API sends for that reason.
 */
export default function CurriculumScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const getToken = useAuthToken();
  const accent = useAccent();

  const [curriculum, setCurriculum] = useState<Curriculum | null>(null);
  const [focus, setFocusList] = useState<Focus[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    if (!id) return;
    try {
      // Both, because the focus panel is a comparison — what the roadmap wants
      // against what the athlete already holds. Either alone renders half an
      // answer.
      const [c, f] = await Promise.all([
        getCurriculum(getToken, id),
        fetchFocus(getToken),
      ]);
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
      setBusy(true);
      try {
        await setFocus(getToken, proposal.next);
        await load();
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setBusy(false);
      }
    },
    [getToken, load],
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

  if (error && !curriculum) {
    return (
      <View style={styles.screen}>
        <Stack.Screen options={{ title: 'Roadmap' }} />
        <Text style={styles.error}>{error}</Text>
      </View>
    );
  }
  if (!curriculum) {
    return (
      <View style={styles.screen}>
        <Stack.Screen options={{ title: 'Roadmap' }} />
        <ActivityIndicator style={styles.loading} />
      </View>
    );
  }

  const items = curriculum.items ?? [];
  const isRoadmap = curriculum.countable_items > 0;
  const proposal = focus ? proposeFocus(items, focus) : null;

  return (
    <ScrollView contentContainerStyle={styles.scroll} testID="curriculum-screen">
      <Stack.Screen options={{ title: curriculum.name }} />

      {curriculum.description !== '' && (
        <Text style={styles.description}>{curriculum.description}</Text>
      )}

      {error && <Text style={styles.error}>{error}</Text>}

      {isRoadmap && curriculum.enrolled && (
        <View style={styles.card}>
          <Text style={styles.headline}>
            <Text style={[styles.headlineNumber, { color: accent.ink }]}>
              {curriculum.mastered_items}
            </Text>
            <Text style={styles.headlineRest}> of {curriculum.countable_items} mastered</Text>
          </Text>
          {/* The two sentences this screen exists to say. Both surprising, both
              correct, neither discoverable. */}
          <Text style={styles.note}>
            Counted from what you have logged since {curriculum.started_on} — anything before
            that does not count, because a rate over your whole history mostly measures the
            months you were still learning. Your record decides these, so a long run of misses
            can take one back.
          </Text>
        </View>
      )}

      {isRoadmap && !curriculum.enrolled && (
        <View style={styles.card}>
          <Text style={styles.note}>
            {curriculum.countable_items} of these have completion criteria. Start working this
            to begin counting — the clock runs from the day you take it on.
          </Text>
        </View>
      )}

      <Pressable
        onPress={toggleEnrollment}
        disabled={busy}
        style={({ pressed }) => [
          styles.primary,
          curriculum.enrolled
            ? { borderColor: vola.line, borderWidth: 1 }
            : { backgroundColor: accent.accent },
          pressed && styles.pressed,
          busy && styles.disabled,
        ]}
        accessibilityRole="button"
        testID="curriculum-enrollment"
      >
        <Text style={[styles.primaryText, !curriculum.enrolled && { color: vola.bg }]}>
          {/* Keyed on `countable_items`, not on the track — a track is a
              grouping hint and must never gate anything. "Start working this"
              on a list with nothing completable promises progress that cannot
              arrive. Enrolment itself stays: on a criteria-free list it is a
              bookmark, which is what an athlete's own curriculum has always
              been. */}
          {curriculum.enrolled
            ? 'Put this down'
            : curriculum.countable_items > 0
              ? 'Start working this'
              : 'Keep this handy'}
        </Text>
      </Pressable>

      {curriculum.enrolled && proposal && (
        <FocusPanel proposal={proposal} busy={busy} onApply={() => confirmFocus(proposal)} />
      )}

      <SectionHeader label={`${items.length} item${items.length === 1 ? '' : 's'}`} />
      {renderGroups(curriculum, accent.ink)}
    </ScrollView>
  );
}

/**
 * The items, grouped by phase — the structure the phased syllabuses carry.
 *
 * Step numbers count TECHNIQUES continuously across every group, so "step 9"
 * still means the ninth thing to learn: concepts are ideas beside the path,
 * not stops on it, and numbering them would shift every milestone's number by
 * how much prose came before it. Unphased items lead, labelled only when
 * phases exist — see `groupByPhase` for why they must not sink.
 */
function renderGroups(curriculum: Curriculum, tone: string) {
  const items = curriculum.items ?? [];
  const phases = curriculum.phases ?? [];
  let step = 0;
  return groupByPhase(phases, items).map((group) => (
    <RNView key={group.phase ? `p${group.phase.order}` : 'unphased'} style={styles.group}>
      {group.phase ? (
        <RNView style={styles.phaseHeader}>
          <Text style={styles.phaseTitle}>{group.phase.title}</Text>
          {group.phase.description !== '' && (
            <Text style={styles.note}>{group.phase.description}</Text>
          )}
        </RNView>
      ) : (
        phases.length > 0 && (
          /* Only in a MIXED curriculum: without a label the leading unphased
             items read as a preamble of the first phase rather than as items
             nobody assigned. A flat curriculum keeps no chrome at all. */
          <Text style={styles.unassigned}>Unassigned</Text>
        )
      )}
      {group.items.map((item) =>
        item.kind === 'concept' ? (
          <ConceptCard key={`c${item.order}`} item={item} />
        ) : (
          <TechniqueRow
            key={item.technique_id}
            step={++step}
            name={item.name}
            position={item.position}
            category={item.category}
            notes={item.notes}
            criteria={criteriaChips(item, curriculum.enrolled)}
            mastered={item.progress?.mastered ?? false}
            started={hasEvidence(item.progress)}
            reading={item.criteria === null}
            tone={tone}
            testID={`curriculum-item-${item.technique_id}`}
          />
        ),
      )}
    </RNView>
  ));
}

/**
 * A concept: authored text — an idea the phase is teaching, not a step the
 * record can complete. No criteria chips, no step number, no "reading"
 * treatment: its body IS the content, and dressing it as an unfinished
 * technique would misreport it.
 */
function ConceptCard({ item }: { item: CurriculumItem }) {
  return (
    <View style={styles.concept} testID={`curriculum-concept-${item.order}`}>
      <Text style={styles.conceptTitle}>{item.title}</Text>
      {item.notes !== '' && <Text style={styles.conceptBody}>{item.notes}</Text>}
    </View>
  );
}

/**
 * The bridge, shown before it is taken.
 *
 * Names what would leave, and distinguishes the two reasons: a mastered
 * technique retiring is the machine working, an evicted one is the athlete
 * losing a choice to the five-slot cap.
 */
function FocusPanel({
  proposal,
  busy,
  onApply,
}: {
  proposal: FocusProposal;
  busy: boolean;
  onApply: () => void;
}) {
  const accent = useAccent();
  const evicted = proposal.dropped.filter((d) => d.reason === 'evicted');
  const finished = proposal.dropped.filter((d) => d.reason === 'mastered');

  if (proposal.unchanged) {
    return (
      <View style={styles.card}>
        <Text style={styles.cardTitle}>Focus</Text>
        <Text style={styles.note}>
          {proposal.next.length === 0
            ? 'Nothing left to work on this one.'
            : 'Your focus already matches this roadmap — these show as one-tap chips when you log a session.'}
        </Text>
      </View>
    );
  }

  return (
    <View style={styles.card} testID="curriculum-focus-panel">
      <Text style={styles.cardTitle}>Work these next</Text>
      <Text style={styles.note}>
        Putting them in your focus list makes them one-tap chips in the reflection wizard —
        which is what records the evidence these criteria read.
      </Text>

      {proposal.added.length > 0 && (
        <RNView style={styles.chips}>
          {proposal.added.map((it) => (
            <RNView key={it.technique_id} style={styles.chip}>
              <Text style={styles.chipText}>{it.name}</Text>
            </RNView>
          ))}
        </RNView>
      )}

      {finished.length > 0 && (
        <Text style={styles.note}>
          Retiring {finished.map((d) => d.focus.name).join(', ')} — your record already clears{' '}
          {finished.length === 1 ? 'it' : 'them'}.
        </Text>
      )}

      {evicted.length > 0 && (
        <Text style={[styles.note, styles.warn]}>
          This will drop {evicted.map((d) => d.focus.name).join(', ')} to stay within five.
        </Text>
      )}

      <Pressable
        onPress={onApply}
        disabled={busy}
        style={({ pressed }) => [
          styles.secondary,
          { borderColor: accent.accent },
          pressed && styles.pressed,
          busy && styles.disabled,
        ]}
        accessibilityRole="button"
        testID="curriculum-apply-focus"
      >
        <Text style={[styles.secondaryText, { color: accent.ink }]}>
          {busy ? 'Saving…' : 'Put these in my focus'}
        </Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, padding: 20 },
  scroll: { padding: 20, gap: 12, paddingBottom: 48 },
  loading: { marginTop: 24 },
  error: { color: vola.danger, fontSize: 14 },
  description: { color: vola.textMuted, fontSize: 14, lineHeight: 20 },
  card: {
    backgroundColor: vola.surface,
    borderColor: vola.line,
    borderWidth: 1,
    borderRadius: 14,
    padding: 14,
    gap: 8,
  },
  cardTitle: { color: vola.text, fontSize: 14, fontWeight: '700' },
  headline: { color: vola.text },
  headlineNumber: { fontSize: 26, fontWeight: '800' },
  headlineRest: { color: vola.textMuted, fontSize: 14 },
  note: { color: vola.textMuted, fontSize: 12, lineHeight: 17 },
  warn: { color: vola.warn },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  chip: {
    borderColor: vola.line,
    borderWidth: 1,
    borderRadius: 999,
    paddingHorizontal: 10,
    paddingVertical: 5,
  },
  chipText: { color: vola.text, fontSize: 13, fontWeight: '600' },
  primary: {
    borderRadius: 12,
    paddingVertical: 13,
    alignItems: 'center',
  },
  primaryText: { color: vola.text, fontSize: 15, fontWeight: '700' },
  secondary: {
    borderRadius: 10,
    borderWidth: 1,
    paddingVertical: 10,
    alignItems: 'center',
    marginTop: 2,
  },
  secondaryText: { fontSize: 14, fontWeight: '700' },
  pressed: { opacity: 0.6 },
  disabled: { opacity: 0.5 },
  group: { gap: 12 },
  phaseHeader: { gap: 4, marginTop: 8 },
  phaseTitle: { color: vola.text, fontSize: 16, fontWeight: '800' },
  unassigned: {
    color: vola.textDim,
    fontSize: 12,
    fontWeight: '700',
    marginTop: 8,
    textTransform: 'uppercase',
    letterSpacing: 0.8,
  },
  concept: {
    backgroundColor: vola.surface,
    borderColor: vola.lineSoft,
    borderWidth: 1,
    borderRadius: 14,
    padding: 14,
    gap: 6,
  },
  conceptTitle: { color: vola.text, fontSize: 14, fontWeight: '700' },
  conceptBody: { color: vola.textMuted, fontSize: 13, lineHeight: 19 },
});
