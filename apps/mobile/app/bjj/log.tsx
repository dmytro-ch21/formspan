import { useAuth } from '@clerk/clerk-expo';
import { Stack, useRouter } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Pressable,
  ScrollView,
  StyleSheet,
  View as RNView,
} from 'react-native';

import { Text, View } from '@/components/Themed';
import { vola } from '@/constants/Colors';
import { useAccent } from '@/lib/AccentProvider';
import {
  KINDS,
  MAX_RPE,
  describeRPE,
  emptyDetail,
  rollingMinutes,
  type Kind,
  type SessionDetail,
} from '@/lib/bjjSession';
import { fetchFocus, type Focus } from '@/lib/bjjFocus';
import { useModules } from '@/lib/ModulesProvider';
import { PREF_BJJ_LAST_LOG, readPref, writePref } from '@/lib/prefs';
import { saveLocalBjjDetail, startLocalSession } from '@/lib/sessionStore';
import { request as requestSync } from '@/lib/sync';
import { useAuthToken } from '@/lib/useAuthToken';

/**
 * Logging a BJJ session — the floor.
 *
 * **This screen is a complete, valid session on its own.** That is the whole
 * design, not a convenience: `docs/decisions/bjj-tracking-design.md` sets a
 * hard budget of three taps and five seconds, because a two-minute mandatory
 * wizard quietly kills the habit and a habit that dies takes every downstream
 * feature with it. Consistency data has to survive the lazy day.
 *
 * So everything here is pre-filled from the last session of this kind, and
 * the three taps that remain are: pick the kind, pick how hard it was, log
 * it. Every other control is already carrying a sensible answer.
 *
 * **Why this is a form and not a live logger.** The strength flow starts a
 * session and logs into it as you train. On the mat that is impossible —
 * sweaty hands, a mouthguard, six-minute rounds, gis without pockets — so
 * BJJ inverts it: zero interaction during the session, everything recalled
 * straight after. That inversion is why Today's BJJ button comes here
 * instead of to `/session/start`.
 *
 * The reflection wizard (what you drilled, what happened live) lives past
 * the "Add detail" action and is entirely optional.
 *
 * **N185 (#590) restyled this screen — hierarchy, never the floor.** "Log it"
 * is now the only full-weight button; "add detail" dropped to a plain text
 * row so LOOKING optional and BEING optional finally agree (it used to be a
 * second filled button the same size as "Log it", which read as a choice
 * between two comparable actions). A read-only focus reminder was added
 * above the form — no `Pressable`, so it cannot add a tap. **Every control
 * that was here before is still here, unchanged**: same picker, same chips,
 * same RPE bars, same two buttons doing the same two things. The fastest
 * valid log is still whatever it was — see the ticket's own before/after
 * tap count in the PR description before touching this file again.
 */

/** Mat-time presets, in minutes. A class is an hour; the rest are shorter. */
const DURATIONS = [30, 45, 60, 75, 90, 120];

/** Round lengths people actually use. */
const ROUND_MINUTES = [3, 4, 5, 6, 7, 8, 10];

/** What a new log starts as, before last time's answers are read in. */
type Draft = SessionDetail & { durationMinutes: number };

function defaultDraft(kind: Kind): Draft {
  return {
    ...emptyDetail(kind),
    // Sensible enough to log without touching: an hour on the mat, five
    // five-minute rounds. Overwritten by last time's answers the moment
    // they load.
    durationMinutes: 60,
    rounds: kind === 'drilling' ? null : 5,
    round_minutes: kind === 'drilling' ? null : 5,
  };
}

export default function LogBjjScreen() {
  const accent = useAccent();
  const router = useRouter();
  const { userId } = useAuth();
  const { modules, ready: modulesReady } = useModules();
  // Same gate as every other BJJ surface, applied at the screen and not only
  // at the door it was opened from — a stale back-stack entry must not reach
  // a logging form for a discipline that is switched off.
  const bjjEnabled = modulesReady && modules.some((m) => m.key === 'bjj' && m.enabled);

  const [draft, setDraft] = useState<Draft>(() => defaultDraft('class'));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /** The session this screen already created, so a retry reuses it. */
  const createdRef = useRef<string | null>(null);
  /**
   * Set the moment the athlete changes anything.
   *
   * The form renders immediately with built-in defaults and the stored
   * preference arrives later, so without this a kind picked inside that
   * window is silently overwritten by last week's — the one genuinely
   * required choice on the screen, reverted under the athlete's finger.
   */
  const touchedRef = useRef(false);

  /**
   * Last time's answers, as this time's defaults.
   *
   * The single biggest lever on the tap budget: people train the same way
   * most weeks, so the right default for "how long, how many rounds, gi or
   * not" is almost always what they did last time. Stored per kind, because
   * a drilling session and a rolling session have genuinely different
   * shapes and sharing one default would make both wrong.
   */
  useEffect(() => {
    if (!userId) return;
    let cancelled = false;
    readPref(userId, PREF_BJJ_LAST_LOG)
      .then((raw) => {
        if (cancelled || !raw) return;
        try {
          const saved = JSON.parse(raw) as Partial<Draft> & { kind?: Kind };
          // A kind from an older or newer build that this one doesn't know
          // would leave no card selected and produce a reflection the API
          // refuses permanently. Well-formed JSON carrying a wrong value is
          // not covered by the catch below.
          if (saved.kind && !KINDS.some((k) => k.key === saved.kind)) delete saved.kind;
          // Never revert a choice the athlete has already made.
          if (touchedRef.current) delete saved.kind;
          setDraft((d) => ({ ...d, ...saved, tags: [], note: '', body_note: '' }));
        } catch {
          // A corrupt preference is not worth blocking a log over; the
          // built-in defaults are already reasonable.
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [userId]);

  /**
   * Current focus, surfaced as a read-only reminder — never a control.
   *
   * "Surface current training focus where helpful": before class the athlete
   * already knows what they intend to work; naming it here is what makes the
   * intent visible on the ONE screen guaranteed to be open after every
   * session, without adding anything to tap. Nothing here can change the
   * floor's tap count — there is no Pressable in this block, only text — and
   * a failed or slow fetch degrades to showing nothing, same as `LiveStep`'s
   * silent-catch fetch of the same list.
   */
  const getToken = useAuthToken();
  const [focus, setFocus] = useState<Focus[]>([]);
  useEffect(() => {
    const c = new AbortController();
    fetchFocus(getToken, c.signal)
      .then(setFocus)
      .catch(() => {});
    return () => c.abort();
  }, [getToken]);

  const setKind = useCallback((kind: Kind) => {
    touchedRef.current = true;
    setDraft((d) => ({
      ...d,
      kind,
      // Drilling has no rounds by default; switching to it should not leave
      // five rounds of sparring attached to a session that had none.
      rounds: kind === 'drilling' ? null : (d.rounds ?? 5),
      round_minutes: kind === 'drilling' ? null : (d.round_minutes ?? 5),
    }));
  }, []);

  /**
   * Commit the floor, then either leave or continue into the reflection.
   *
   * The session is written locally and pushed by the ordinary outbox, so
   * this works with no signal — which is the common case, because the
   * twenty minutes after class is exactly when someone is in a car park.
   *
   * `ended_at` is set from the duration rather than left open. It matters
   * more than it looks: training history derives every duration from
   * `ended_at - started_at`, so a BJJ session without one contributes
   * literally nothing to mat time, and the history chart — which falls back
   * to time when there is no tonnage — would render a flat zero line for
   * someone who trains four times a week.
   */
  async function commit(then: 'done' | 'detail') {
    if (saving || !userId) return;
    setSaving(true);
    setError(null);
    try {
      // Reuse the session created by a previous attempt rather than making
      // a second one. If the reflection write below fails, the catch clears
      // `saving` and the athlete taps "Log it" again — without this, that
      // retry mints a whole new session and the class appears twice in
      // history, both copies dirty and both pushed.
      let sessionId = createdRef.current;
      if (!sessionId) {
        const startedAt = new Date(Date.now() - draft.durationMinutes * 60_000);
        const session = await startLocalSession(userId, {
          sport: 'bjj',
          name: KINDS.find((k) => k.key === draft.kind)?.label ?? 'BJJ',
          started_at: startedAt.toISOString(),
          ended_at: new Date().toISOString(),
        });
        sessionId = session.id;
        createdRef.current = sessionId;
      }

      const { durationMinutes: _duration, ...detail } = draft;
      await saveLocalBjjDetail(userId, sessionId, detail);

      // Remember this session's shape as next time's default.
      writePref(
        userId,
        PREF_BJJ_LAST_LOG,
        JSON.stringify({
          kind: draft.kind,
          gi: draft.gi,
          rounds: draft.rounds,
          round_minutes: draft.round_minutes,
          academy: draft.academy,
          durationMinutes: draft.durationMinutes,
        }),
      ).catch(() => {});

      requestSync('bjj-session-logged');

      if (then === 'detail') {
        router.replace({ pathname: '/bjj/reflect/[id]', params: { id: sessionId } });
      } else {
        router.back();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setSaving(false);
    }
  }

  if (modulesReady && !bjjEnabled) {
    return (
      <View style={styles.centre} testID="bjj-log-disabled">
        <Stack.Screen options={{ title: 'Log BJJ' }} />
        <Text style={styles.centreTitle}>BJJ tracking is off</Text>
        <Text style={styles.centreMuted}>
          Turn it back on under Sports in your profile to log a session.
        </Text>
      </View>
    );
  }

  const mins = rollingMinutes(draft);

  return (
    <View style={styles.container} testID="bjj-log-screen">
      <Stack.Screen options={{ title: 'Log BJJ' }} />

      <ScrollView contentContainerStyle={styles.scroll} keyboardShouldPersistTaps="handled">
        {error && (
          <Text style={styles.error} accessibilityLiveRegion="polite">
            {error}
          </Text>
        )}

        {/* The dictation route in (N60), above the form rather than buried in
            it. Talking through a session is faster than tapping it out and is
            the reason the backend feature exists; a surface nobody can find is
            what N33 shipped and what this task was filed to fix.

            It is an ALTERNATIVE, not a replacement — the form below stays the
            three-tap floor, works with no signal and spends nothing. */}
        <Pressable
          onPress={() => router.push('/bjj/dictate')}
          style={[styles.dictate, { borderColor: accent.accent }]}
          accessibilityRole="button"
          accessibilityLabel="Say what happened instead of filling this in"
          testID="bjj-dictate-entry"
        >
          <Text style={[styles.dictateLabel, { color: accent.ink }]}>Say what happened</Text>
          <Text style={styles.dictateBlurb}>
            Talk it through with your keyboard’s mic and we’ll fill this in
          </Text>
        </Pressable>

        {/* Read-only — no Pressable here, so this costs nothing on the tap
            floor. A reminder of what the athlete already decided to work on,
            not a suggestion made now: the same "plan vs. reading of the
            evidence" distinction `RoadmapLine` documents. */}
        {focus.length > 0 && (
          <RNView style={styles.focusHint} testID="bjj-log-focus-hint">
            <Text style={styles.focusHintLabel}>Focusing on</Text>
            <Text style={styles.focusHintNames} numberOfLines={2}>
              {focus.map((f) => f.name).join(' · ')}
            </Text>
          </RNView>
        )}

        {/* 1. What it was. The only genuinely required choice. */}
        <Text style={styles.label}>What was it?</Text>
        <RNView style={styles.kindGrid} accessibilityRole="radiogroup">
          {KINDS.map((k) => {
            const active = draft.kind === k.key;
            return (
              <Pressable
                key={k.key}
                onPress={() => setKind(k.key)}
                style={[
                  styles.kindCard,
                  active && [styles.kindCardActive, { borderColor: accent.accent }],
                ]}
                accessibilityRole="radio"
                accessibilityState={{ selected: active }}
                accessibilityLabel={`${k.label}. ${k.blurb}`}
                testID={`bjj-kind-${k.key}`}
              >
                <Text style={[styles.kindLabel, active && styles.kindLabelActive]}>{k.label}</Text>
                <Text style={[styles.kindBlurb, active && styles.kindBlurbActive]}>{k.blurb}</Text>
              </Pressable>
            );
          })}
        </RNView>

        {/* 2. Gi. Three states, because "didn't say" is a real answer and
            guessing one would put a fact in the record nobody stated. */}
        <Text style={styles.label}>Gi or no-gi?</Text>
        <RNView style={styles.chips} accessibilityRole="radiogroup">
          {[
            { key: 'gi', label: 'Gi', value: true as boolean | null },
            { key: 'nogi', label: 'No-gi', value: false as boolean | null },
            { key: 'unsaid', label: 'Not saying', value: null as boolean | null },
          ].map((o) => {
            const active = draft.gi === o.value;
            return (
              <Pressable
                key={o.key}
                onPress={() => setDraft((d) => ({ ...d, gi: o.value }))}
                style={[
                  styles.chip,
                  active && [
                    styles.chipActive,
                    { backgroundColor: accent.accent, borderColor: accent.accent },
                  ],
                ]}
                accessibilityRole="radio"
                accessibilityState={{ selected: active }}
                testID={`bjj-gi-${o.key}`}
              >
                <Text style={[styles.chipText, active && styles.chipTextActive]}>{o.label}</Text>
              </Pressable>
            );
          })}
        </RNView>

        {/* 3. Mat time — what drives ended_at, and therefore everything the
            history screen can say about BJJ. */}
        <Text style={styles.label}>How long on the mat?</Text>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.row}>
          {DURATIONS.map((m) => {
            const active = draft.durationMinutes === m;
            return (
              <Pressable
                key={m}
                onPress={() => setDraft((d) => ({ ...d, durationMinutes: m }))}
                style={[styles.pill, active && styles.pillActive]}
                accessibilityRole="radio"
                accessibilityState={{ selected: active }}
                accessibilityLabel={`${m} minutes`}
                testID={`bjj-duration-${m}`}
              >
                <Text style={[styles.pillText, active && styles.pillTextActive]}>{m}m</Text>
              </Pressable>
            );
          })}
        </ScrollView>

        {/* 4. Rounds — the sparring volume inside that mat time. */}
        <RNView style={styles.labelRow}>
          <Text style={styles.label}>Rounds rolled</Text>
          {mins > 0 && <Text style={styles.derived}>≈ {mins} min rolling</Text>}
        </RNView>
        <RNView style={styles.stepperRow}>
          <Stepper
            value={draft.rounds ?? 0}
            onChange={(n) => setDraft((d) => ({ ...d, rounds: n === 0 ? null : n }))}
            max={20}
            suffix="rounds"
            testID="bjj-rounds"
          />
        </RNView>
        {draft.rounds !== null && (
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={styles.row}
          >
            {ROUND_MINUTES.map((m) => {
              const active = draft.round_minutes === m;
              return (
                <Pressable
                  key={m}
                  onPress={() => setDraft((d) => ({ ...d, round_minutes: m }))}
                  style={[styles.pill, active && styles.pillActive]}
                  accessibilityRole="radio"
                  accessibilityState={{ selected: active }}
                  accessibilityLabel={`${m} minute rounds`}
                  testID={`bjj-roundlen-${m}`}
                >
                  <Text style={[styles.pillText, active && styles.pillTextActive]}>{m} min</Text>
                </Pressable>
              );
            })}
          </ScrollView>
        )}

        {/* 5. The one number that matters most. */}
        <RNView style={styles.labelRow}>
          <Text style={styles.label}>How hard was it?</Text>
          {draft.session_rpe !== null && (
            <Text style={styles.derived}>{describeRPE(draft.session_rpe)}</Text>
          )}
        </RNView>
        <RpeScale
          value={draft.session_rpe}
          onChange={(n) => setDraft((d) => ({ ...d, session_rpe: n }))}
        />

        {/* The one button this screen needs. Everything above it is already a
            complete, valid session — see the file header — so this is styled
            as the single unambiguous primary action, not one of two equally
            weighted buttons. */}
        <Pressable
          onPress={() => commit('done')}
          disabled={saving}
          style={[styles.cta, { backgroundColor: accent.accent }, saving && styles.disabled]}
          accessibilityRole="button"
          testID="bjj-log-save"
        >
          <Text style={[styles.ctaText, { color: accent.on }]}>
            {saving ? 'Logging…' : 'Log it'}
          </Text>
        </Pressable>

        <Text style={styles.footnote}>
          That’s a complete session — three taps, no more required. What you drilled and what
          happened live are entirely optional, below, and never move.
        </Text>

        {/* Deliberately NOT a second filled button. Two same-weight CTAs read
            as a choice between two comparable actions, and "add detail" is
            not comparable to "log it" — it is an optional appendix to a
            session that is already saved by the button above. Reduced to a
            plain text row so looking optional and being optional finally
            agree with each other. */}
        <Pressable
          onPress={() => commit('detail')}
          disabled={saving}
          style={[styles.secondary, saving && styles.disabled]}
          accessibilityRole="button"
          accessibilityHint="Adds what you drilled and what happened in rolling"
          testID="bjj-log-detail"
        >
          <Text style={styles.secondaryText}>Log and add detail (optional) →</Text>
        </Pressable>
      </ScrollView>
    </View>
  );
}

/**
 * The RPE scale.
 *
 * Ten bars rather than a number field or a slider: a slider invites
 * precision the input does not have, and a keyboard for one digit is three
 * interactions. Bars are one tap and read as a scale at a glance.
 *
 * Colour runs green → lime → warn → danger across the range, using tokens
 * the palette already validates rather than a new ramp. It is redundant
 * encoding — the number and the word beside it carry the same meaning — so
 * colour is never the only thing saying "this was hard".
 */
function RpeScale({
  value,
  onChange,
}: {
  value: number | null;
  onChange: (n: number) => void;
}) {
  return (
    <RNView style={styles.rpeRow} accessibilityRole="radiogroup" accessibilityLabel="Session RPE">
      {Array.from({ length: MAX_RPE }, (_, i) => i + 1).map((n) => {
        const filled = value !== null && n <= value;
        return (
          <Pressable
            key={n}
            onPress={() => onChange(n)}
            style={[
              styles.rpeBar,
              filled && { backgroundColor: rpeColour(n), borderColor: rpeColour(n) },
            ]}
            accessibilityRole="radio"
            accessibilityState={{ selected: value === n }}
            accessibilityLabel={`${n} out of ${MAX_RPE}, ${describeRPE(n)}`}
            // Ten bars across a phone are ~31pt wide, under the 44pt
            // minimum, and they have to stay visually thin — they read as a
            // scale, not as ten buttons. So the target grows vertically,
            // where there is room, rather than horizontally, where there
            // isn't: 2pt each side is half the 4pt gap, so neighbouring
            // targets meet exactly at the midpoint instead of overlapping.
            // (At 4pt they would overlap the whole gap, and iOS gives the
            // later sibling the hit — a tap just right of 6 would select 7.)
            // Horizontal precision is backed up by the number and the word
            // above, which name the current value.
            hitSlop={{ top: 12, bottom: 12, left: 2, right: 2 }}
            testID={`bjj-rpe-${n}`}
          >
            <Text style={[styles.rpeNumber, filled && styles.rpeNumberFilled]}>{n}</Text>
          </Pressable>
        );
      })}
    </RNView>
  );
}

/**
 * An ordered four-step effort ramp — a READING, not chrome.
 *
 * The moderate step is `vola.rpeModerate` rather than `vola.lime` since N183:
 * they were the same hex, and reading it off `lime` would have turned an effort
 * scale into the brand accent the day the brand moved. Every swatch renders its
 * own number (`rpeNumber`), so the ramp is ordered rather than pairwise
 * separable.
 */
function rpeColour(n: number): string {
  if (n <= 4) return vola.green;
  if (n <= 6) return vola.rpeModerate;
  if (n <= 8) return vola.warn;
  return vola.danger;
}

/** A -/+ counter. 0 reads as "none", which for rounds means "didn't spar". */
function Stepper({
  value,
  onChange,
  max,
  suffix,
  testID,
}: {
  value: number;
  onChange: (n: number) => void;
  max: number;
  suffix: string;
  testID: string;
}) {
  const accent = useAccent();
  return (
    <RNView style={styles.stepper}>
      <Pressable
        onPress={() => onChange(Math.max(0, value - 1))}
        style={styles.stepperButton}
        accessibilityRole="button"
        accessibilityLabel={`One fewer ${suffix}`}
        testID={`${testID}-minus`}
      >
        <Text style={[styles.stepperSign, { color: accent.ink }]}>−</Text>
      </Pressable>
      <RNView style={styles.stepperValue}>
        <Text style={styles.stepperNumber} testID={`${testID}-value`}>
          {value === 0 ? 'None' : value}
        </Text>
        {value > 0 && <Text style={styles.stepperSuffix}>{suffix}</Text>}
      </RNView>
      <Pressable
        onPress={() => onChange(Math.min(max, value + 1))}
        style={styles.stepperButton}
        accessibilityRole="button"
        accessibilityLabel={`One more ${suffix}`}
        testID={`${testID}-plus`}
      >
        <Text style={[styles.stepperSign, { color: accent.ink }]}>+</Text>
      </Pressable>
    </RNView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  scroll: { padding: 20, gap: 10, paddingBottom: 48 },
  centre: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 32, gap: 8 },
  centreTitle: { fontSize: 18, fontWeight: '700', textAlign: 'center' },
  centreMuted: { color: vola.textMuted, fontSize: 13, textAlign: 'center' },

  label: {
    fontSize: 12,
    color: vola.textDim,
    textTransform: 'uppercase',
    letterSpacing: 1,
    marginTop: 14,
  },
  labelRow: { flexDirection: 'row', alignItems: 'baseline', justifyContent: 'space-between' },
  derived: { color: vola.textMuted, fontSize: 12, fontWeight: '600', marginTop: 14 },

  dictate: {
    borderWidth: 1,
    borderRadius: 14,
    paddingHorizontal: 16,
    paddingVertical: 14,
    gap: 3,
    marginBottom: 4,
  },
  dictateLabel: { fontSize: 16, fontWeight: '800' },
  dictateBlurb: { color: vola.textMuted, fontSize: 13, lineHeight: 19 },

  // Read-only reminder of the active focus list — no interactive styling on
  // purpose, since nothing here is a control.
  focusHint: { gap: 2, marginBottom: 4 },
  focusHintLabel: {
    fontSize: 11,
    color: vola.textDim,
    textTransform: 'uppercase',
    letterSpacing: 1,
    fontWeight: '700',
  },
  focusHintNames: { fontSize: 13, color: vola.textMuted, fontWeight: '600' },
  kindGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  kindCard: {
    // Two per row, accounting for the 8pt gap.
    width: '48%',
    flexGrow: 1,
    borderWidth: 1,
    borderColor: vola.line,
    backgroundColor: vola.surface,
    borderRadius: 14,
    paddingVertical: 14,
    paddingHorizontal: 14,
    gap: 2,
  },
  kindCardActive: { backgroundColor: vola.setDone },
  kindLabel: { fontSize: 16, fontWeight: '700' },
  kindLabelActive: { color: vola.text },
  kindBlurb: { fontSize: 12, color: vola.textDim },
  // textMuted, not textDim: on the lime-tinted card textDim measures 2.51:1.
  kindBlurbActive: { color: vola.textMuted },

  chips: { flexDirection: 'row', gap: 8, flexWrap: 'wrap' },
  chip: {
    borderWidth: 1,
    borderColor: vola.line,
    borderRadius: 999,
    paddingVertical: 10,
    paddingHorizontal: 18,
    minHeight: 44,
    justifyContent: 'center',
  },
  chipActive: {},
  chipText: { fontWeight: '600', color: vola.textMuted },
  chipTextActive: { color: vola.navy },

  row: { gap: 8, paddingRight: 20 },
  pill: {
    borderWidth: 1,
    borderColor: vola.lineSoft,
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 10,
    minHeight: 44,
    justifyContent: 'center',
  },
  pillActive: { borderColor: vola.textMuted, backgroundColor: vola.surfaceRaised },
  pillText: { color: vola.textDim, fontSize: 13, fontWeight: '600' },
  pillTextActive: { color: vola.text },

  stepperRow: { flexDirection: 'row' },
  stepper: {
    flexDirection: 'row',
    alignItems: 'center',
    borderWidth: 1,
    borderColor: vola.line,
    borderRadius: 12,
    backgroundColor: vola.surface,
    overflow: 'hidden',
  },
  stepperButton: {
    width: 52,
    height: 52,
    alignItems: 'center',
    justifyContent: 'center',
  },
  stepperSign: { fontSize: 24, fontWeight: '700' },
  stepperValue: { minWidth: 96, alignItems: 'center', justifyContent: 'center' },
  stepperNumber: { fontSize: 18, fontWeight: '800' },
  stepperSuffix: { fontSize: 11, color: vola.textDim },

  rpeRow: { flexDirection: 'row', gap: 4 },
  rpeBar: {
    flex: 1,
    height: 52,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: vola.line,
    backgroundColor: vola.surface,
    alignItems: 'center',
    justifyContent: 'center',
  },
  rpeNumber: { fontSize: 13, fontWeight: '700', color: vola.textDim },
  rpeNumberFilled: { color: vola.navy },

  // The single primary action on this screen. Bigger and bolder than the
  // "add detail" row below it is now, on purpose — see the render comment
  // above this button.
  cta: {
    borderRadius: 12,
    paddingVertical: 18,
    alignItems: 'center',
    marginTop: 24,
  },
  ctaText: { fontWeight: '800', fontSize: 17 },
  // No background fill, no border, no equal-weight competition with `cta`
  // above — this used to be a second filled button the same size as "Log
  // it", which read as two comparable choices when only one of them is.
  // `minHeight`/`paddingVertical` still clear the 44pt target; the weight
  // comes off the colour and size, not off the tap area.
  secondary: {
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 44,
    paddingVertical: 12,
    marginTop: 4,
  },
  secondaryText: { fontWeight: '600', fontSize: 14, color: vola.textMuted },
  disabled: { opacity: 0.5 },

  footnote: {
    color: vola.textDim,
    fontSize: 12,
    textAlign: 'center',
    marginTop: 10,
    marginBottom: 8,
  },
  error: { color: vola.danger, fontSize: 14 },
});
