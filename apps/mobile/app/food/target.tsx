/**
 * Why you are eating this much.
 *
 * ## Every line, or none of it
 *
 * The screen renders the derivation as an arithmetic ladder — resting rate,
 * daily movement, training, maintenance, the phase adjustment, the result —
 * because a calorie target is an argument, and an argument you cannot inspect
 * is a verdict. The project's standing principle is auditable recommendations,
 * and this is the surface where that gets paid for.
 *
 * That is also why a bound rail is stated out loud. Without the line, the last
 * step visibly does not follow from the one above it, and a reader concludes
 * the app cannot add up rather than that it declined to go further.
 *
 * ## It computes; accepting is a separate act
 *
 * The suggestion is never written on arrival. `Use this target` is the only
 * thing that stores anything, and it freezes this arithmetic onto the row — so
 * asking the same question in March gets March's numbers back rather than a
 * fresh derivation from a body that has since changed.
 *
 * ## When it cannot
 *
 * An incomplete profile returns `suggestion: null` with the fields named. The
 * screen says which, and sends you to the form that fixes them. It does NOT
 * fall back to the estimated resting baseline: `energy`'s own doc puts that
 * 20–30% high, which on a target is roughly 400 kcal a day and a cut that
 * never happens, invisibly, forever.
 */

import { Stack, useRouter } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';

import { ScreenHeader } from '@/components/ScreenHeader';
import { Text } from '@/components/Themed';
import { SectionHeader } from '@/components/ui/Section';
import { vola } from '@/constants/Colors';
import { useAccent } from '@/lib/AccentProvider';
import { useAuthToken } from '@/lib/useAuthToken';
import { profileGap, todayString } from '@/lib/nutrition';
import { saveTarget, suggestedTarget, type Suggested } from '@/lib/nutritionApi';

/**
 * The NEAT-only vocabulary, and the reason it stops at "active".
 *
 * Textbook multipliers run to 1.9 with exercise folded in. Using one of those
 * and then adding logged sessions counts every mat class twice, so the ladder
 * here covers daily movement ONLY and training arrives as its own line.
 */
const ACTIVITIES = [
  { key: 'sedentary', label: 'Desk job', hint: 'Mostly sitting, little walking' },
  { key: 'light', label: 'On your feet', hint: 'Some walking through the day' },
  { key: 'active', label: 'Physical job', hint: 'Moving most of the day' },
] as const;

export default function TargetScreen() {
  const router = useRouter();
  const accent = useAccent();
  const getToken = useAuthToken();

  const [activity, setActivity] = useState<string>('light');
  const [data, setData] = useState<Suggested | null>(null);
  const [failed, setFailed] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveFailed, setSaveFailed] = useState(false);
  const on = todayString();

  useEffect(() => {
    let live = true;
    // Both flags are set from the CALLBACKS, never synchronously here. A reset
    // on the way in is a setState during the effect — the rule the lint ratchet
    // holds — and it also flickers the previous answer away for a frame each
    // time the activity pills move.
    suggestedTarget(getToken, on, activity)
      .then((d) => {
        if (!live) return;
        setData(d);
        setFailed(false);
      })
      .catch(() => {
        if (live) setFailed(true);
      });
    return () => {
      live = false;
    };
  }, [getToken, on, activity]);

  const accept = useCallback(async () => {
    const s = data?.suggestion;
    if (!s || saving) return;
    setSaving(true);
    setSaveFailed(false);
    try {
      await saveTarget(getToken, on, {
        kcal: s.kcal,
        protein_g: s.protein_g,
        carb_g: s.carb_g,
        fat_g: s.fat_g,
        fibre_g: s.fibre_g,
        source: 'derived',
        basis: s.basis,
      });
      router.back();
    } catch {
      // Accepting a target is the one WRITE on this screen, and offline is this
      // app's ordinary weather. Without this the button simply un-dimmed and
      // nothing happened — the athlete would reasonably conclude it had saved.
      setSaveFailed(true);
    } finally {
      setSaving(false);
    }
  }, [data, getToken, on, router, saving]);

  const s = data?.suggestion ?? null;
  // Null once a target is derivable, so the fix-this button cannot render for a
  // screen that has nothing left to fix.
  const gap = profileGap(data?.missing ?? []);
  const b = s?.basis ?? null;

  return (
    <View style={styles.screen}>
      <Stack.Screen options={{ title: 'Your target' }} />
      <ScreenHeader title="Your target" />

      <View style={styles.body}>
        <SectionHeader label="Daily movement" />
        <View style={styles.pills}>
          {ACTIVITIES.map((a) => {
            const isOn = a.key === activity;
            return (
              <Pressable
                key={a.key}
                onPress={() => setActivity(a.key)}
                style={[styles.pill, isOn && { borderColor: accent.accent }]}
                accessibilityRole="button"
                accessibilityState={{ selected: isOn }}
                accessibilityLabel={`${a.label}. ${a.hint}`}
                testID={`target-activity-${a.key}`}
              >
                <Text style={[styles.pillLabel, isOn && { color: accent.ink }]}>{a.label}</Text>
                <Text style={styles.pillHint}>{a.hint}</Text>
              </Pressable>
            );
          })}
        </View>

        {failed && (
          <Text style={styles.note}>
            Could not reach the server. This one number is worked out there, because it needs
            your training history — everything else in Food works offline.
          </Text>
        )}

        {!failed && !data && <Text style={styles.note}>Working it out…</Text>}

        {data && !s && (
          <View style={styles.gap}>
            {/* The explanation renders whenever a target cannot be derived —
                the button only when there is somewhere honest to send you.
                Gating both on `gap` hid the sentence too, so a field this build
                does not recognise would have produced a blank screen instead of
                a named reason. Raised in review. */}
            <Text style={styles.note}>
              A target needs a few things first: {data.missing.map(profileLabel).join(', ')}.
            </Text>
            {gap && (
              <Pressable
                onPress={() =>
                  /*
                    The literals live HERE so Expo Router's generated types check
                    them, and the check-in uses the OBJECT form on purpose.

                    `` `/checkin/${date}` `` is a template literal, which the
                    route guard deliberately skips and CI's `tsc` cannot see
                    either — so that branch of this very fix would have been
                    unguarded against the exact bug it exists to fix. The object
                    form names the route pattern as a literal, which both the
                    guard and the generated types can check. Raised in review.
                  */
                  gap.kind === 'profile'
                    ? router.push('/profile/edit')
                    : router.push({
                        pathname: '/checkin/[date]',
                        params: { date: todayString() },
                      })
                }
                style={[styles.primary, { backgroundColor: accent.accent }]}
                accessibilityRole="button"
                accessibilityLabel={gap.label}
                testID="target-profile"
              >
                <Text style={[styles.primaryText, { color: accent.on }]}>{gap.label}</Text>
              </Pressable>
            )}
          </View>
        )}

        {s && b && (
          <>
            <SectionHeader label="The arithmetic" />
            <Row label="Resting rate" value={`${b.rmr_kcal} kcal`} hint={`${b.weight_kg} kg on ${b.weight_measured_on}`} />
            <Row label="Daily movement" value={`+${b.neat_kcal} kcal`} hint={`×${b.activity_factor} on resting`} />
            <Row
              label="Training"
              value={`+${b.training_kcal_per_day} kcal`}
              hint={`${b.training_sessions} sessions over ${b.training_days_covered} days, spread evenly`}
            />
            <Row label="Maintenance" value={`${b.tdee_kcal} kcal`} strong />
            <Row
              label={phaseLabel(b.phase_kind)}
              value={`${b.energy_delta_kcal >= 0 ? '+' : ''}${b.energy_delta_kcal} kcal`}
              hint={
                b.target_rate_kg_per_week === 0
                  ? 'Weight held where it is'
                  : `${fmt(b.target_rate_kg_per_week)} kg a week`
              }
            />
            {b.clamped && b.clamp_reason ? <Text style={styles.note}>{b.clamp_reason}.</Text> : null}
            <Pressable
              onPress={() => router.push('/phase')}
              accessibilityRole="button"
              accessibilityLabel="Change your phase"
              testID="target-phase"
            >
              <Text style={[styles.link, { color: accent.ink }]}>
                {b.phase_kind === 'maintenance' ? 'Start a cut or a bulk' : 'Change phase'}
              </Text>
            </Pressable>
            <Row label="Your target" value={`${s.kcal} kcal`} strong />

            <SectionHeader label="Macros" />
            <Row label="Protein" value={`${s.protein_g} g`} hint={`${fmt(b.protein_g_per_kg)} g per kg`} />
            <Row label="Fat" value={`${s.fat_g} g`} hint={`${fmt(b.fat_g_per_kg)} g per kg`} />
            <Row label="Carbs" value={`${s.carb_g} g`} hint="Whatever the calories leave" />
            <Row label="Fibre" value={`${s.fibre_g} g`} hint="A floor, not a ceiling" />
            {b.relaxed ? (
              <Text style={styles.note}>
                These calories would not cover the usual protein and fat, so {b.relaxed} gave way
                first.
              </Text>
            ) : null}

            <Pressable
              onPress={() => void accept()}
              style={[styles.primary, { backgroundColor: accent.accent }, saving && styles.off]}
              accessibilityRole="button"
              accessibilityLabel="Use this target"
              testID="target-accept"
            >
              <Text style={[styles.primaryText, { color: accent.on }]}>
                {saving ? 'Saving…' : 'Use this target'}
              </Text>
            </Pressable>
            {saveFailed ? (
              <Text style={styles.problem}>
                Could not save it — this one needs a connection. Nothing has changed; try again
                when you have signal.
              </Text>
            ) : null}
            <Text style={styles.footnote}>
              Nothing is saved until you tap that. The workings above are stored with it, so this
              page still answers the question months from now.
            </Text>
          </>
        )}
      </View>
    </View>
  );
}

function Row({
  label,
  value,
  hint,
  strong,
}: {
  label: string;
  value: string;
  hint?: string;
  strong?: boolean;
}) {
  return (
    <View style={styles.row}>
      <View style={styles.rowMain}>
        <Text style={[styles.rowLabel, strong && styles.rowLabelStrong]}>{label}</Text>
        {hint ? <Text style={styles.rowHint}>{hint}</Text> : null}
      </View>
      <Text style={[styles.rowValue, strong && styles.rowValueStrong]}>{value}</Text>
    </View>
  );
}

/** The phase vocabulary as a sentence about food, not as a database enum. */
function phaseLabel(kind: string): string {
  switch (kind) {
    case 'cut':
      return 'Cutting';
    case 'lean_bulk':
      return 'Lean bulk';
    case 'making_weight':
      return 'Making weight';
    case 'recomposition':
      return 'Recomp';
    default:
      return 'Maintaining';
  }
}

/** Server field names, said the way the profile form says them. */
function profileLabel(field: string): string {
  switch (field) {
    case 'height_cm':
      return 'your height';
    case 'date_of_birth':
      return 'your date of birth';
    case 'sex':
      return 'your sex';
    case 'weight_kg':
      return 'a recent weigh-in';
    default:
      return field;
  }
}

/** One decimal, and no trailing `.0` on a whole number. */
function fmt(n: number): string {
  return String(Math.round(n * 100) / 100);
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: vola.bg },
  body: { paddingHorizontal: 20, paddingBottom: 48, gap: 10 },
  gap: { gap: 12 },
  pills: { gap: 8 },
  pill: {
    borderWidth: 1,
    borderColor: vola.line,
    borderRadius: 12,
    paddingHorizontal: 14,
    paddingVertical: 10,
    gap: 2,
  },
  pillLabel: { fontSize: 14, fontWeight: '600' },
  pillHint: { fontSize: 12, color: vola.textDim },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingVertical: 8,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: vola.lineSoft,
  },
  rowMain: { flex: 1, gap: 2 },
  rowLabel: { fontSize: 14, color: vola.textMuted },
  rowLabelStrong: { color: vola.text, fontWeight: '700' },
  rowHint: { fontSize: 11, color: vola.textDim },
  rowValue: { fontSize: 14, fontVariant: ['tabular-nums'], color: vola.textMuted },
  rowValueStrong: { fontSize: 16, fontWeight: '700', color: vola.text },
  note: { fontSize: 12, color: vola.textMuted, lineHeight: 17 },
  problem: { fontSize: 12, color: vola.danger, lineHeight: 17 },
  link: { fontSize: 13, fontWeight: '700', paddingVertical: 6 },
  footnote: { fontSize: 11, color: vola.textDim, lineHeight: 16 },
  primary: {
    minHeight: 46,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 8,
  },
  primaryText: { fontWeight: '700', fontSize: 15 },
  off: { opacity: 0.5 },
});
