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

import { useFocusEffect, useRouter } from 'expo-router';
import { useCallback, useState } from 'react';
import { AccessibilityInfo, Pressable, StyleSheet, View } from 'react-native';

import { KeyboardAwareScrollView } from '@/components/KeyboardAwareScroll';
import { ScreenHeader } from '@/components/ScreenHeader';
import { Text } from '@/components/Themed';
import { SectionHeader } from '@/components/ui/Section';
import { vola } from '@/constants/Colors';
import { useAccent } from '@/lib/AccentProvider';
import { useAuthToken } from '@/lib/useAuthToken';
import { profileGap, todayString } from '@/lib/nutrition';
import {
  saveTarget,
  suggestedTarget,
  type Projection,
  type Suggested,
} from '@/lib/nutritionApi';

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

/** Said once, written once — a receipt that reads differently to a screen
 *  reader than to the screen is two receipts. */
const SAVED_MESSAGE = 'Saved. Food measures the day against this from now on.';

export default function TargetScreen() {
  const router = useRouter();
  const accent = useAccent();
  const getToken = useAuthToken();

  const [activity, setActivity] = useState<string>('light');
  const [data, setData] = useState<Suggested | null>(null);
  const [failed, setFailed] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveFailed, setSaveFailed] = useState(false);
  // Saved-in-place, because this screen is a TAB now rather than something
  // pushed from Food. It used to `router.back()` on success, which was the
  // whole confirmation: the screen you were on returning IS the receipt. A tab
  // has nowhere to go back to — calling it would drop the athlete onto
  // whichever screen they happened to visit before, or nowhere at all — so the
  // acknowledgement has to be said out loud here instead. A write with no
  // visible outcome is the failure mode the offline branch below already
  // exists to prevent; this is the same rule applied to success.
  const [saved, setSaved] = useState(false);
  // The day this screen is about, RE-READ ON EVERY FOCUS rather than computed
  // once at mount — see the focus effect below for why that distinction only
  // started to matter when this became a tab.
  const [on, setOn] = useState(todayString);

  /**
   * Refetch whenever the tab is focused, and re-read the date while doing it.
   *
   * **A pushed screen got this for free and a tab does not**, which is the one
   * lifecycle assumption that survived the move from `food/target.tsx` intact
   * and wrong. Pushed, this screen remounted on every open: the effect ran, the
   * ladder was current, and `todayString()` was evaluated afresh. A tab mounts
   * once, lazily, and then stays mounted for the life of the process — so
   * without this it would show the weight, training load and phase it read the
   * first time it was ever opened, for as long as the app stays alive.
   *
   * The date is the half that turns staleness into a WRONG WRITE rather than a
   * stale read. `on` is what `accept` saves against, so an app left open past
   * midnight would file tomorrow's target under yesterday, silently, and ask
   * the server for a suggestion about a day that has gone.
   *
   * Found in review of the move, not by a test — nothing in the suite mounts a
   * tab twice, and both symptoms need a second visit to appear.
   */
  const load = useCallback(() => {
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
        // The receipt belongs to the numbers that were saved, and these are
        // different numbers. Moving an activity pill, or coming back to the tab
        // on a new day, produces a fresh and UNSAVED suggestion — leaving
        // "Saved" under it would attach a confirmation to something that was
        // never stored, which is worse than showing nothing at all.
        setSaved(false);
      })
      .catch(() => {
        if (live) setFailed(true);
      });
    return () => {
      live = false;
    };
  }, [getToken, on, activity]);

  /**
   * FOCUS is the only trigger, and it is deliberately the only one.
   *
   * A pushed screen got this for free — `food/target.tsx` remounted on every
   * open, so the effect ran, the ladder was current, and the day it saves
   * against was evaluated afresh. A tab mounts once, lazily, and then stays
   * mounted for the life of the process: without this it would show the weight,
   * training load and phase it read the first time it was ever opened.
   *
   * The date is the half that turns a stale read into a WRONG WRITE. `on` is
   * what `accept` files the target under, so an app left open past midnight
   * would save tomorrow's target against yesterday.
   *
   * `useFocusEffect` re-runs when its callback's identity changes while the
   * screen is focused, and `load` changes with the activity — so moving a pill
   * refetches through this same path rather than through a second effect. That
   * matters: an earlier version had both, and the two fired together on mount,
   * asking three times for one opening and letting a late answer wipe the
   * "Saved" receipt a moment after it appeared.
   */
  useFocusEffect(
    useCallback(() => {
      setOn(todayString());
      return load();
    }, [load]),
  );

  const accept = useCallback(async () => {
    const s = data?.suggestion;
    if (!s || saving) return;
    setSaving(true);
    setSaveFailed(false);
    setSaved(false);
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
      setSaved(true);
      // SPOKEN, not just rendered. `router.back()` used to be the confirmation
      // and navigation announces itself; a Text appearing mid-page while focus
      // stays on the button does not, so a VoiceOver user tapped "Use this
      // target" and heard nothing at all. iOS has no live regions, which is why
      // this is an imperative announcement — the same call sign-in and sign-up
      // already make for their errors. Raised in review.
      AccessibilityInfo.announceForAccessibility(SAVED_MESSAGE);
    } catch {
      // Accepting a target is the one WRITE on this screen, and offline is this
      // app's ordinary weather. Without this the button simply un-dimmed and
      // nothing happened — the athlete would reasonably conclude it had saved.
      setSaveFailed(true);
    } finally {
      setSaving(false);
    }
  }, [data, getToken, on, saving]);

  const s = data?.suggestion ?? null;
  // Null once a target is derivable, so the fix-this button cannot render for a
  // screen that has nothing left to fix.
  const gap = profileGap(data?.missing ?? []);
  const b = s?.basis ?? null;

  return (
    <View style={styles.screen}>
      <ScreenHeader title="Your target" />

      <KeyboardAwareScrollView
        contentContainerStyle={styles.body}
        keyboardShouldPersistTaps="handled"
      >
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

            <Feasibility p={b.projection} />

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
            {saved ? (
              <Text
                style={styles.saved}
                testID="target-saved"
                // Android's half of the same problem; iOS ignores it and takes
                // the imperative announcement above.
                accessibilityLiveRegion="polite"
              >
                {SAVED_MESSAGE}
              </Text>
            ) : null}
            <Text style={styles.footnote}>
              Nothing is saved until you tap that. The workings above are stored with it, so this
              page still answers the question months from now.
            </Text>
          </>
        )}
      </KeyboardAwareScrollView>
    </View>
  );
}

/**
 * "Does this look right?" — §5's third section, and the one that existed
 * nowhere until N69.
 *
 * A phase carries a goal weight, a deadline and a rate, and nothing compared
 * them. So an athlete could set "lose eight kilos by Christmas", be handed a
 * perfectly safe rate that arrives in April, and find out in April.
 *
 * **Renders nothing when there is nothing to say.** `projection` is null with
 * no goal weight or no live phase, and an all-clear in that case would be a
 * claim we never checked — the same absence-is-not-an-answer rule the rest of
 * this module runs on. Silence is the honest output.
 *
 * The arithmetic is the server's, so this screen and web cannot disagree about
 * whether a plan works.
 */
function Feasibility({ p }: { p: Projection | null }) {
  if (!p) return null;

  if (p.already) {
    return (
      <Text style={styles.note} testID="target-feasibility">
        You are already at {p.target_weight_kg} kg. This phase has done its job.
      </Text>
    );
  }
  if (p.unreachable) {
    return (
      <Text style={styles.problem} testID="target-feasibility">
        This plan never reaches {p.target_weight_kg} kg — {p.unreachable_reason}. Change the
        goal weight or the phase.
      </Text>
    );
  }

  const late = p.meets_deadline === false;
  return (
    <Text style={late ? styles.problem : styles.note} testID="target-feasibility">
      {p.kg_to_go} kg to go. At this rate you reach {p.target_weight_kg} kg around{' '}
      {p.reached_on}
      {p.meets_deadline === null
        ? '.'
        : late
          ? `, which is ${p.days_late} days after your ${p.deadline_on} deadline — about ${p.shortfall_kg} kg short on the day.`
          : `, ahead of your ${p.deadline_on} deadline.`}
    </Text>
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
  saved: { fontSize: 12, color: vola.textDim, lineHeight: 17 },
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
