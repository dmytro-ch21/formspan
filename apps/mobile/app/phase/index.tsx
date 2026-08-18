/**
 * Start or end a phase.
 *
 * ## Why this screen exists at all
 *
 * `createPhase` and `endPhase` have existed in `lib/body.ts` and in the API
 * since the body module landed, with **zero callers anywhere in `apps/`**. A
 * phase was a thing the backend could hold and no athlete could create. That
 * went unnoticed because nothing depended on it — until a calorie target, which
 * derives its direction and its rate from the live phase and has nothing to
 * derive from when there is none.
 *
 * ## What it asks, and what it refuses to ask
 *
 * Kind, start date, and — only where it means something — a target weight and a
 * date. Nothing else. Goal pace is not asked: the rate comes from the phase's
 * own evidence-based band, and letting somebody type "2 kg a week" would make
 * the app the author of a target it then judges them against.
 *
 * Making weight is the exception that proves it. A division on a date fixes the
 * required rate arithmetically, so the fields are mandatory there and optional
 * everywhere else — and the rate that falls out is still capped at the cut
 * ceiling, because a competition does not change physiology.
 *
 * ## Ending is not deleting
 *
 * `End this phase` stamps `ended_on` and leaves the row. Every target derived
 * during it keeps its frozen basis, which is what makes "why was I eating 2,410
 * in March" answerable after the cut is over.
 */

import { randomUUID } from 'expo-crypto';
import { Stack, useRouter } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { Pressable, StyleSheet, TextInput, View } from 'react-native';

import { KeyboardAwareScrollView } from '@/components/KeyboardAwareScroll';
import { ScreenHeader } from '@/components/ScreenHeader';
import { Text } from '@/components/Themed';
import { SectionHeader } from '@/components/ui/Section';
import { vola } from '@/constants/Colors';
import { useAccent } from '@/lib/AccentProvider';
import { RATE_TARGETS, type PhaseKind } from '@/lib/anthropometry';
import { PHASE_LABELS, createPhase, endPhase, listPhases, type Phase } from '@/lib/body';
import { dayString } from '@/lib/calendar';
import { useAuthToken } from '@/lib/useAuthToken';

const KINDS: PhaseKind[] = ['cut', 'lean_bulk', 'recomposition', 'maintenance', 'making_weight'];

export default function PhaseScreen() {
  const router = useRouter();
  const accent = useAccent();
  const getToken = useAuthToken();

  const [live, setLive] = useState<Phase | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [kind, setKind] = useState<PhaseKind>('cut');
  const [targetWeight, setTargetWeight] = useState('');
  const [targetOn, setTargetOn] = useState('');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState('');

  const today = dayString(new Date());

  const refresh = useCallback(() => {
    let alive = true;
    listPhases(getToken)
      .then((ps) => {
        if (!alive) return;
        setLive(ps.find((p) => p.ended_on == null) ?? null);
        setLoaded(true);
      })
      .catch(() => {
        // Online-only, like the rest of the body module: a phase is started at
        // a desk, once every few months, not in a gym dead-spot.
        if (alive) setProblem('Could not reach the server.');
      });
    return () => {
      alive = false;
    };
  }, [getToken]);

  useEffect(() => refresh(), [refresh]);

  const start = async () => {
    if (busy) return;
    const weight = Number(targetWeight.trim().replace(',', '.'));
    // Making weight is the only kind where these are load-bearing, so it is the
    // only kind that insists on them. Asking everyone for a goal weight is how
    // you get a made-up number that later reads as a commitment.
    if (kind === 'making_weight' && (!(weight > 0) || !/^\d{4}-\d{2}-\d{2}$/.test(targetOn))) {
      setProblem('Making weight needs the weight and the date you have to make it.');
      return;
    }
    setBusy(true);
    setProblem('');
    try {
      await createPhase(getToken, {
        id: randomUUID(),
        kind,
        started_on: today,
        target_on: /^\d{4}-\d{2}-\d{2}$/.test(targetOn) ? targetOn : null,
        target_weight_kg: weight > 0 ? weight : null,
      });
      refresh();
    } catch {
      setProblem('Could not start it. Check your connection and try again.');
    } finally {
      setBusy(false);
    }
  };

  const stop = async () => {
    if (!live || busy) return;
    setBusy(true);
    setProblem('');
    try {
      await endPhase(getToken, live.id, today);
      refresh();
    } catch {
      setProblem('Could not end it. Check your connection and try again.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <View style={styles.screen}>
      <Stack.Screen options={{ title: 'Phase' }} />
      <ScreenHeader title="Phase" />

      <KeyboardAwareScrollView
        contentContainerStyle={styles.body}
        keyboardShouldPersistTaps="handled"
      >
        {!loaded && !problem ? <Text style={styles.note}>Loading…</Text> : null}

        {live ? (
          <>
            <SectionHeader label="Right now" />
            <Text style={styles.big}>{PHASE_LABELS[live.kind].label}</Text>
            <Text style={styles.note}>
              Started {live.started_on}
              {live.target_weight_kg ? ` · aiming for ${live.target_weight_kg} kg` : ''}
              {live.target_on ? ` by ${live.target_on}` : ''}
            </Text>
            <Text style={styles.note}>{rateSentence(live.kind)}</Text>

            <Pressable
              onPress={() => void stop()}
              style={[styles.secondary, busy && styles.off]}
              accessibilityRole="button"
              accessibilityLabel="End this phase"
              testID="phase-end"
            >
              <Text style={styles.secondaryText}>{busy ? 'Working…' : 'End this phase'}</Text>
            </Pressable>
            <Text style={styles.footnote}>
              Ending it keeps the record. Targets you set during it keep the workings they were
              derived from.
            </Text>
          </>
        ) : loaded ? (
          <>
            <SectionHeader label="Start a phase" />
            <Text style={styles.note}>
              What you are doing decides which way your calorie target points, and how far.
            </Text>

            {KINDS.map((k) => {
              const on = k === kind;
              return (
                <Pressable
                  key={k}
                  onPress={() => setKind(k)}
                  style={[styles.pill, on && { borderColor: accent.accent }]}
                  accessibilityRole="button"
                  accessibilityState={{ selected: on }}
                  accessibilityLabel={`${PHASE_LABELS[k].label}. ${PHASE_LABELS[k].hint}`}
                  testID={`phase-kind-${k}`}
                >
                  <Text style={[styles.pillLabel, on && { color: accent.ink }]}>
                    {PHASE_LABELS[k].label}
                  </Text>
                  <Text style={styles.pillHint}>{PHASE_LABELS[k].hint}</Text>
                  {on ? <Text style={styles.pillRate}>{rateSentence(k)}</Text> : null}
                </Pressable>
              );
            })}

            <View style={styles.fields}>
              <View style={styles.field}>
                <Text style={styles.fieldLabel}>
                  Target weight (kg){kind === 'making_weight' ? '' : ' — optional'}
                </Text>
                <TextInput
                  style={styles.input}
                  value={targetWeight}
                  onChangeText={setTargetWeight}
                  keyboardType="decimal-pad"
                  inputMode="decimal"
                  placeholder="—"
                  placeholderTextColor={vola.textDim}
                  accessibilityLabel="Target weight in kilograms"
                  testID="phase-weight"
                />
              </View>
              <View style={styles.field}>
                <Text style={styles.fieldLabel}>
                  By (YYYY-MM-DD){kind === 'making_weight' ? '' : ' — optional'}
                </Text>
                <TextInput
                  style={styles.input}
                  value={targetOn}
                  onChangeText={setTargetOn}
                  autoCapitalize="none"
                  autoCorrect={false}
                  placeholder="—"
                  placeholderTextColor={vola.textDim}
                  accessibilityLabel="Target date"
                  testID="phase-date"
                />
              </View>
            </View>

            <Pressable
              onPress={() => void start()}
              style={[styles.primary, { backgroundColor: accent.accent }, busy && styles.off]}
              accessibilityRole="button"
              accessibilityLabel="Start this phase"
              testID="phase-start"
            >
              <Text style={[styles.primaryText, { color: accent.on }]}>
                {busy ? 'Working…' : 'Start it'}
              </Text>
            </Pressable>
          </>
        ) : null}

        {problem ? <Text style={styles.problem}>{problem}</Text> : null}

        <Pressable
          onPress={() => router.back()}
          style={styles.back}
          accessibilityRole="button"
          accessibilityLabel="Back"
        >
          <Text style={styles.secondaryText}>Back</Text>
        </Pressable>
      </KeyboardAwareScrollView>
    </View>
  );
}

/**
 * The band, in words, from the single source of truth.
 *
 * Read off `RATE_TARGETS` rather than written out, so the copy cannot drift
 * from the arithmetic that judges the athlete against it. Percentages of
 * bodyweight, not kilograms — an 0.5 kg week means different things at 60 kg
 * and at 100 kg, which is the reason the bands are stored this way.
 */
function rateSentence(kind: PhaseKind): string {
  const band = RATE_TARGETS[kind];
  if (band == null) return 'The rate comes from the gap and the date, capped at the cut ceiling.';
  if (band.max <= 0.0025) return 'Weight roughly flat, week to week.';
  const lo = (band.min * 100).toFixed(2).replace(/0+$/, '').replace(/\.$/, '');
  const hi = (band.max * 100).toFixed(2).replace(/0+$/, '').replace(/\.$/, '');
  const dir = kind === 'lean_bulk' ? 'gain' : 'loss';
  return `About ${lo}–${hi}% of bodyweight a week, ${dir}.`;
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: vola.bg },
  body: { paddingHorizontal: 20, paddingBottom: 60, gap: 10 },
  big: { fontSize: 24, fontWeight: '800' },
  note: { fontSize: 13, color: vola.textMuted, lineHeight: 18 },
  footnote: { fontSize: 11, color: vola.textDim, lineHeight: 16 },
  problem: { fontSize: 13, color: vola.danger },
  pill: {
    borderWidth: 1,
    borderColor: vola.line,
    borderRadius: 12,
    paddingHorizontal: 14,
    paddingVertical: 11,
    gap: 2,
  },
  pillLabel: { fontSize: 15, fontWeight: '700' },
  pillHint: { fontSize: 12, color: vola.textDim },
  pillRate: { fontSize: 12, color: vola.textMuted, marginTop: 4 },
  fields: { gap: 12, marginTop: 6 },
  field: { gap: 6 },
  fieldLabel: { fontSize: 12, color: vola.textDim, fontWeight: '600' },
  input: {
    borderWidth: 1,
    borderColor: vola.line,
    borderRadius: 12,
    backgroundColor: vola.surface,
    paddingHorizontal: 14,
    paddingVertical: 12,
    color: vola.text,
    fontSize: 15,
  },
  primary: {
    minHeight: 46,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 8,
  },
  primaryText: { fontWeight: '700', fontSize: 15 },
  off: { opacity: 0.5 },
  secondary: {
    minHeight: 44,
    paddingHorizontal: 18,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: vola.line,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 10,
    alignSelf: 'flex-start',
  },
  secondaryText: { fontSize: 13, color: vola.textMuted, fontWeight: '600' },
  back: { alignSelf: 'flex-start', paddingVertical: 14 },
});
