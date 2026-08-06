import { Stack, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { useCallback, useState } from 'react';
import { ActivityIndicator, Alert, Pressable, ScrollView, StyleSheet, View as RNView } from 'react-native';

import { Text, View } from '@/components/Themed';
import { SectionHeader } from '@/components/ui/Section';
import { TechniqueRow, type Criterion } from '@/components/ui/TechniqueRow';
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
          {curriculum.enrolled ? 'Put this down' : 'Start working this'}
        </Text>
      </Pressable>

      {curriculum.enrolled && proposal && (
        <FocusPanel proposal={proposal} busy={busy} onApply={() => confirmFocus(proposal)} />
      )}

      <SectionHeader label={`${items.length} technique${items.length === 1 ? '' : 's'}`} />
      {items.map((item, i) => (
        <TechniqueRow
          key={item.technique_id}
          step={i + 1}
          name={item.name}
          position={item.position}
          category={item.category}
          notes={item.notes}
          criteria={criteriaChips(item, curriculum.enrolled)}
          mastered={item.progress?.mastered ?? false}
          reading={item.criteria === null}
          tone={accent.ink}
          testID={`curriculum-item-${item.technique_id}`}
        />
      ))}
    </ScrollView>
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

/**
 * Turns one item's criteria into the chips the row draws.
 *
 * The mapping lives here rather than in TechniqueRow because it is domain, not
 * presentation: which glyph means "landed" is a fact about BJJ, and the row
 * should stay reusable by anything with thresholds.
 */
function criteriaChips(item: CurriculumItem, enrolled: boolean): Criterion[] {
  const c = item.criteria;
  if (c === null) return [];
  const p = item.progress;
  const out: Criterion[] = [];

  const volume = (
    icon: Criterion['icon'],
    label: string,
    have: number | undefined,
    need: number,
  ) => {
    const got = have ?? 0;
    out.push({
      icon,
      // Browsing shows the bar, working shows the climb. Zero-filling for
      // someone not enrolled would report a shortfall they were never asked
      // to make up.
      value: enrolled ? `${got}/${need}` : String(need),
      met: enrolled && got >= need,
      label: enrolled ? `${label}, ${got} of ${need}` : `${label}, ${need} needed`,
    });
  };

  if (c.target_scored !== null) volume('goal', 'Landed', p?.scored, c.target_scored);
  if (c.target_defended !== null) volume('recovery', 'Stopped theirs', p?.defended, c.target_defended);
  if (c.target_sessions !== null) volume('calendar', 'Sessions', p?.sessions, c.target_sessions);

  if (c.min_hit_rate !== null) {
    const need = Math.round(c.min_hit_rate * 100);
    // `—`, never `0%`. Zero from zero is not a rate, and the API sends null so
    // the client cannot report a failure the athlete has not had.
    const have = p?.hit_rate == null ? null : Math.round(p.hit_rate * 100);
    out.push({
      icon: 'chart',
      value: enrolled ? `${have === null ? '—' : `${have}%`}/${need}%` : `${need}%`,
      met: enrolled && have !== null && have >= need,
      label:
        enrolled && have !== null
          ? `Hit rate, ${have} percent of ${need} needed`
          : `Hit rate, ${need} percent needed`,
    });
  }
  return out;
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
});
