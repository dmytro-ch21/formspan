import { useAuth } from '@clerk/clerk-expo';
import { Stack, useFocusEffect, useRouter, type Href } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { AppState, Pressable, ScrollView, StyleSheet, View as RNView } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { DayNarrationSlot } from '@/components/day/DayNarrationSlot';
import { ScreenHeader } from '@/components/ScreenHeader';
import { Text } from '@/components/Themed';
import { Icon } from '@/components/ui/Icon';
import { SectionHeader } from '@/components/ui/Section';
import { vola } from '@/constants/Colors';
import { PRESS_OPACITY } from '@/constants/Motion';
import { Radius, Spacing, TOUCH_MIN } from '@/constants/Spacing';
import { Typography } from '@/constants/Typography';
import { PHASE_LABELS } from '@/lib/body';
import type { CachedCheckin, CachedPhase } from '@/lib/bodyCache';
import { longDayLabel, shortDate } from '@/lib/calendar';
import { NO_NARRATION } from '@/lib/dayNarration';
import { lastUpdatedLabel, type DayFact, type DayPanel } from '@/lib/dayPanel';
import { labelFor, type Module } from '@/lib/modules';
import { useModules } from '@/lib/ModulesProvider';
import { formatWeight, type UnitSystem } from '@/lib/units';
import { useUnits } from '@/lib/UnitsProvider';
import { fmtAmount } from '@/lib/nutrition';
import { formatPlanTime } from '@/lib/planTime';
import { sessionHref, startSessionHref } from '@/lib/startSession';
import { momentumLogFoodHref, momentumOpenFoodHref } from '@/lib/todayBoard';
import { footLine, valueLine } from '@/lib/trackerModel';
import type { PlannedOffer } from '@/lib/trainBoard';
import { useDayPanel } from '@/lib/useDayPanel';

/**
 * Your day — N541 tranche 1 (#972). One screen that says what today is.
 *
 * ## What it shows, and where each line comes from
 *
 * Everything below is `useDayPanel` → `assembleDay`, which is SQLite and the
 * derivations Today already runs. Each positive line renders as
 * `day-fact-${key}` and carries the rows behind it; each "nothing here" line is
 * an absence, reachable only from a read that answered. See `lib/dayPanel.ts`.
 *
 * ## What it deliberately is not (yet)
 *
 * - **Not AI.** There is no narration in tranche 1, and the title does not say
 *   "AI" because nothing on the screen is generated. `DayNarrationSlot` marks
 *   where tranche 2 attaches and renders nothing.
 * - **Not the landing screen, and not a replacement for Today.** Whether it
 *   replaces Today or sits beside it is the user's call; it is reachable from
 *   Today's header, and the overlap between the two is written down in the
 *   N541 history entry rather than decided here.
 * - **Not a logger.** Rows open the screen that owns them — a planned session
 *   starts where Today starts it, food opens Food on this day — through the
 *   same href builders Today uses. The panel adds no second write path.
 *
 * ## Last-known, not live: the Body block (N568, #1129)
 *
 * The last check-in and the phase goal come from the body read cache, so they
 * are the one part of this screen that is a COPY of a server record rather than
 * the record itself. Every value there carries "Last updated …", including the
 * empty states — see `LastKnown` in `lib/dayPanel.ts`.
 *
 * ## No network
 *
 * Nothing on this screen waits on a request, so it is the same screen in a gym
 * basement. `useTodayBoard` (inside `useDayPanel`) still asks the sync
 * orchestrator for a run on focus, fire-and-forget.
 */
export default function DayScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { userId } = useAuth();
  const { modules } = useModules();

  // The clock the panel describes. Refreshed on focus and on foreground, so a
  // screen left open overnight moves to the new day rather than describing the
  // old one under a stale date — `useDayPanel` re-reads when its day changes.
  const [now, setNow] = useState(() => new Date());
  useFocusEffect(
    useCallback(() => {
      setNow(new Date());
    }, []),
  );
  useEffect(() => {
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'active') setNow(new Date());
    });
    return () => sub.remove();
  }, []);

  const panel = useDayPanel(userId ?? null, modules, now);

  const goBack = useCallback(() => {
    if (router.canGoBack()) router.back();
    else router.replace('/');
  }, [router]);

  const open = useCallback((href: Href) => router.push(href), [router]);

  return (
    <RNView style={styles.screen}>
      <Stack.Screen options={{ title: 'Your day', headerShown: false }} />
      <ScreenHeader
        title="Your day"
        leading={
          <Pressable
            onPress={goBack}
            style={({ pressed }) => [styles.backButton, pressed && styles.pressed]}
            hitSlop={{ top: 8, bottom: 8, left: 8, right: 4 }}
            accessibilityRole="button"
            accessibilityLabel="Back"
            testID="day-back"
          >
            <Icon name="back" size={20} color={vola.text} />
          </Pressable>
        }
      />

      <ScrollView
        contentContainerStyle={[styles.body, { paddingBottom: Math.max(insets.bottom, 16) + 20 }]}
        testID="day-screen"
      >
        <Text style={styles.date} testID="day-date">
          {longDayLabel(now)}
        </Text>

        {/* The narration seam. Renders nothing in tranche 1, and sits ABOVE the
            facts so it can never be the thing a fact lives inside. */}
        <DayNarrationSlot narration={NO_NARRATION} />

        <PlanBlock panel={panel} modules={modules} open={open} />
        <TargetsBlock panel={panel} open={open} />
        <GoalBlock panel={panel} open={open} />
        <BodyBlock panel={panel} now={now} open={open} />
      </ScrollView>
    </RNView>
  );
}

function planTitle(p: PlannedOffer, modules: Module[]): string {
  return p.workoutName ?? labelFor(modules, p.sport);
}

function planMeta(p: PlannedOffer, modules: Module[], when: string): string {
  const parts = [p.workoutName ? labelFor(modules, p.sport) : null, when];
  const time = formatPlanTime(p.timeOfDayMinutes);
  if (time) parts.push(time);
  return parts.filter(Boolean).join(' · ');
}

function PlanBlock({
  panel,
  modules,
  open,
}: {
  panel: DayPanel;
  modules: Module[];
  open: (href: Href) => void;
}) {
  const { plan, logged, next } = panel;
  const loggedFacts = logged.state === 'ready' ? logged.value : [];

  return (
    <RNView style={styles.section}>
      <SectionHeader label="Training" />

      {plan.state === 'unavailable' && <Unavailable what="plan" />}

      {plan.state === 'ready' && plan.value.kind === 'resume' && (
        <SessionOpenRow fact={plan.value.fact} modules={modules} open={open} />
      )}

      {plan.state === 'ready' &&
        plan.value.kind === 'owed' &&
        plan.value.facts.map((f) =>
          f.kind === 'planned' ? (
            <FactRow
              key={f.key}
              fact={f}
              title={planTitle(f.plan, modules)}
              meta={planMeta(f.plan, modules, 'Planned today')}
              actionLabel={`${f.plan.logsAfterwards ? 'Log' : 'Start'} ${planTitle(f.plan, modules)}`}
              onPress={() => open(startSessionHref(f.plan, modules))}
            />
          ) : null,
        )}

      {plan.state === 'ready' && plan.value.kind === 'done' && plan.value.fact.kind === 'plan-done' && (
        <FactRow
          fact={plan.value.fact}
          title="Everything planned today is logged"
          meta={`${plan.value.fact.planned} planned`}
        />
      )}

      {plan.state === 'ready' && plan.value.kind === 'rest' && (
        <Absence text="Nothing planned today." testID="day-absent-plan" />
      )}

      {loggedFacts.map((f) =>
        f.kind === 'logged' ? (
          <FactRow
            key={f.key}
            fact={f}
            title={f.session.name || labelFor(modules, f.session.sport)}
            meta={`${labelFor(modules, f.session.sport)} · ${f.session.ended_at ? 'Logged today' : 'In progress'}`}
            actionLabel={`Open ${f.session.name || labelFor(modules, f.session.sport)}`}
            onPress={() => open(sessionHref(f.session, modules))}
          />
        ) : null,
      )}

      {next.state === 'ready' && next.value?.kind === 'next-planned' && (
        <FactRow
          fact={next.value}
          eyebrow="Next"
          title={planTitle(next.value.plan, modules)}
          meta={planMeta(next.value.plan, modules, shortDate(next.value.plan.day))}
        />
      )}
    </RNView>
  );
}

function SessionOpenRow({
  fact,
  modules,
  open,
}: {
  fact: DayFact;
  modules: Module[];
  open: (href: Href) => void;
}) {
  if (fact.kind !== 'session-open') return null;
  const title = fact.session.name || labelFor(modules, fact.session.sport);
  return (
    <FactRow
      fact={fact}
      title={title}
      // Stale is stated, not hidden: a session open for more than a day is still
      // open, it just stops claiming a clock is running. Same 24-hour rule Today
      // applies, from the same constant.
      meta={fact.stale ? 'Not finished' : 'In progress'}
      actionLabel={`Resume ${title}`}
      onPress={() => open(sessionHref(fact.session, modules))}
    />
  );
}

function TargetsBlock({ panel, open }: { panel: DayPanel; open: (href: Href) => void }) {
  const { trackers, food, day } = panel;
  const trackerFacts = trackers.state === 'ready' ? trackers.value : [];
  // A header only over something: an empty "Targets" heading with nothing
  // under it is a claim that there should be.
  const hasFood = food.state === 'ready' || food.state === 'unavailable';
  if (trackerFacts.length === 0 && trackers.state !== 'unavailable' && !hasFood) return null;

  return (
    <RNView style={styles.section}>
      <SectionHeader label="Targets" />

      {trackers.state === 'unavailable' && <Unavailable what="trackers" />}
      {trackerFacts.map((f) =>
        f.kind === 'tracker' ? (
          <FactRow
            key={f.key}
            fact={f}
            title={f.tracker.name}
            meta={valueLine(f.tracker, f.entries)}
            detail={footLine(f.tracker, f.entries)}
          />
        ) : null,
      )}

      {food.state === 'unavailable' && <Unavailable what="food" />}
      {food.state === 'ready' && food.value?.kind === 'food-eaten' && (
        <FactRow
          fact={food.value}
          title="Food"
          meta={`${fmtAmount(food.value.totals.kcal)} kcal · ${fmtAmount(food.value.totals.protein_g)} g protein`}
          detail={`${food.value.entries} ${food.value.entries === 1 ? 'entry' : 'entries'} today`}
          actionLabel="Open today's food"
          onPress={() => open(momentumOpenFoodHref(day))}
        />
      )}
      {food.state === 'ready' && food.value === null && (
        <Absence
          text="No food logged yet today."
          testID="day-absent-food"
          actionLabel="Log food"
          onPress={() => open(momentumLogFoodHref(day))}
        />
      )}
    </RNView>
  );
}

function GoalBlock({ panel, open }: { panel: DayPanel; open: (href: Href) => void }) {
  const { target } = panel;
  if (target.state === 'off' || target.state === 'unread') return null;

  return (
    <RNView style={styles.section}>
      <SectionHeader label="Goal" />
      {target.state === 'unavailable' && <Unavailable what="target" />}
      {target.state === 'ready' && target.value?.kind === 'nutrition-target' && (
        <FactRow
          fact={target.value}
          title={`${fmtAmount(target.value.target.kcal)} kcal a day`}
          meta={`${fmtAmount(target.value.target.protein_g)} g protein · ${fmtAmount(target.value.target.carb_g)} g carbs · ${fmtAmount(target.value.target.fat_g)} g fat`}
          actionLabel="Open your target"
          onPress={() => open('/goals')}
        />
      )}
      {target.state === 'ready' && target.value === null && (
        <Absence
          text="No nutrition target set."
          testID="day-absent-target"
          actionLabel="Set a target"
          onPress={() => open('/goals')}
        />
      )}
    </RNView>
  );
}

/**
 * The last-known check-in and phase goal (N568).
 *
 * **Every line here says when it was last fetched** — facts through `FactRow`'s
 * detail, absences through their own. The label is not decoration: in airplane
 * mode it is the only thing separating "your weight is 82.4 kg" from "the phone
 * last heard 82.4 kg on Monday".
 */
function BodyBlock({
  panel,
  now,
  open,
}: {
  panel: DayPanel;
  now: Date;
  open: (href: Href) => void;
}) {
  const { units, unitsReady } = useUnits();
  const { checkin, phase } = panel;
  if (checkin.state === 'unread' && phase.state === 'unread') return null;

  // A tappable row's accessibility label REPLACES what its children say, so the
  // "Last updated" line would be silent to VoiceOver — and it is the one line on
  // these rows that stops a cached value being heard as a live one. So the label
  // carries the value and its fetched time before it names the action. Raised in
  // review; the other panel rows keep the file's existing shape.
  const checkinFact = checkin.state === 'ready' ? checkin.value.fact : null;
  const phaseFact = phase.state === 'ready' ? phase.value.fact : null;

  return (
    <RNView style={styles.section}>
      <SectionHeader label="Body" />

      {checkin.state === 'unavailable' && <Unavailable what="checkin" />}
      {checkin.state === 'ready' && checkinFact?.kind === 'last-checkin' && (
        <FactRow
          fact={checkinFact}
          eyebrow="Last check-in"
          title={checkinTitle(checkinFact.checkin, units, unitsReady)}
          meta={`Measured ${shortDate(checkinFact.checkin.measured_on)}`}
          detail={lastUpdatedLabel(checkin.value.fetchedAt, now)}
          detailTestID="day-updated-checkin"
          actionLabel={`Last check-in: ${checkinTitle(checkinFact.checkin, units, unitsReady)}, measured ${shortDate(checkinFact.checkin.measured_on)}. ${lastUpdatedLabel(checkin.value.fetchedAt, now)}. Opens your weight trend.`}
          onPress={() => open('/goals/trend')}
        />
      )}
      {checkin.state === 'ready' && checkin.value.fact === null && (
        <Absence
          text={
            checkin.value.since
              ? `No check-in since ${shortDate(checkin.value.since)}.`
              : 'No check-in found.'
          }
          testID="day-absent-checkin"
          detail={lastUpdatedLabel(checkin.value.fetchedAt, now)}
          detailTestID="day-updated-checkin"
        />
      )}

      {phase.state === 'unavailable' && <Unavailable what="phase" />}
      {phase.state === 'ready' && phaseFact?.kind === 'phase-goal' && (
        <FactRow
          fact={phaseFact}
          eyebrow="Phase goal"
          title={PHASE_LABELS[phaseFact.phase.kind]?.label ?? 'Phase'}
          meta={phaseMeta(phaseFact.phase, units, unitsReady)}
          detail={lastUpdatedLabel(phase.value.fetchedAt, now)}
          detailTestID="day-updated-phase"
          actionLabel={`Phase goal: ${PHASE_LABELS[phaseFact.phase.kind]?.label ?? 'Phase'}, ${phaseMeta(phaseFact.phase, units, unitsReady)}. ${lastUpdatedLabel(phase.value.fetchedAt, now)}. Opens your phase.`}
          onPress={() => open('/phase')}
        />
      )}
      {phase.state === 'ready' && phase.value.fact === null && (
        <Absence
          text="No active phase."
          testID="day-absent-phase"
          detail={lastUpdatedLabel(phase.value.fetchedAt, now)}
          detailTestID="day-updated-phase"
        />
      )}
    </RNView>
  );
}

/**
 * The weight, in the athlete's units — and nothing numeric until the unit
 * preference has been read, the rule `ProgressCard` follows: a pounds athlete
 * must never see kilograms for a frame. The preference is cached, so offline
 * this is ready as soon as SQLite answers.
 */
function checkinTitle(c: CachedCheckin, units: UnitSystem, unitsReady: boolean): string {
  if (c.weight_kg == null) return 'No weight recorded';
  return unitsReady ? formatWeight(c.weight_kg, units) : 'Weight recorded';
}

function phaseMeta(p: CachedPhase, units: UnitSystem, unitsReady: boolean): string {
  const by = p.target_on ? ` by ${shortDate(p.target_on)}` : '';
  if (p.target_weight_kg == null) return `No target weight${by}`;
  return unitsReady ? `Target ${formatWeight(p.target_weight_kg, units)}${by}` : `Target set${by}`;
}

/**
 * One positive claim. **The only component that renders a `day-fact-*` testID**,
 * and it can only be given a `DayFact` — so a line with no rows behind it cannot
 * be drawn through this, which is what the screen test's invariant checks.
 */
function FactRow({
  fact,
  eyebrow,
  title,
  meta,
  detail,
  detailTestID,
  actionLabel,
  onPress,
}: {
  fact: DayFact;
  eyebrow?: string;
  title: string;
  meta: string;
  detail?: string | null;
  detailTestID?: string;
  actionLabel?: string;
  onPress?: () => void;
}) {
  const body = (
    <>
      {eyebrow ? <Text style={styles.eyebrow}>{eyebrow.toUpperCase()}</Text> : null}
      <Text style={styles.title}>{title}</Text>
      <Text style={styles.meta}>{meta}</Text>
      {detail ? (
        <Text style={styles.detail} testID={detailTestID}>
          {detail}
        </Text>
      ) : null}
    </>
  );
  const testID = `day-fact-${fact.key}`;

  if (!onPress) {
    return (
      <RNView style={styles.row} testID={testID} accessible>
        {body}
      </RNView>
    );
  }
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [styles.row, styles.rowPressable, pressed && styles.pressed]}
      accessibilityRole="button"
      accessibilityLabel={actionLabel ?? title}
      testID={testID}
    >
      {body}
      <RNView style={styles.chevron}>
        <Icon name="chevron" size={16} color={vola.textDim} />
      </RNView>
    </Pressable>
  );
}

/** A read that answered with nothing. Not a fact: no row stands behind it. */
function Absence({
  text,
  testID,
  actionLabel,
  onPress,
  detail,
  detailTestID,
}: {
  text: string;
  testID: string;
  actionLabel?: string;
  onPress?: () => void;
  /** N568: an absence from the body cache still says when it was fetched. */
  detail?: string;
  detailTestID?: string;
}) {
  if (!onPress && detail) {
    return (
      <RNView style={styles.absenceBlock} testID={testID} accessible>
        <Text style={styles.absence}>{text}</Text>
        <Text style={styles.detail} testID={detailTestID}>
          {detail}
        </Text>
      </RNView>
    );
  }
  if (!onPress) {
    return (
      <Text style={styles.absence} testID={testID}>
        {text}
      </Text>
    );
  }
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [styles.absenceRow, pressed && styles.pressed]}
      accessibilityRole="button"
      accessibilityLabel={`${text} ${actionLabel ?? ''}`.trim()}
      testID={testID}
    >
      <Text style={styles.absence}>{text}</Text>
      {actionLabel ? <Text style={styles.absenceAction}>{actionLabel}</Text> : null}
    </Pressable>
  );
}

/**
 * A read that could not answer. Neutral on purpose: it names nothing the
 * athlete did or did not do, because nothing is known.
 */
function Unavailable({
  what,
}: {
  what: 'plan' | 'trackers' | 'food' | 'target' | 'checkin' | 'phase';
}) {
  return (
    <Text style={styles.absence} testID={`day-unavailable-${what}`}>
      Not available on this phone yet.
    </Text>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: vola.bg },
  body: { paddingHorizontal: Spacing.gutter, paddingTop: Spacing.sm, gap: Spacing.xl },
  date: { ...Typography.meta, color: vola.textMuted },
  section: { gap: Spacing.sm },
  row: {
    backgroundColor: vola.surface,
    borderRadius: Radius.card,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: vola.line,
    padding: Spacing.cardPadding,
    gap: Spacing.xxs,
  },
  rowPressable: { minHeight: TOUCH_MIN, paddingRight: Spacing.cardPadding + 20 },
  chevron: {
    position: 'absolute',
    right: Spacing.cardPadding,
    top: 0,
    bottom: 0,
    justifyContent: 'center',
  },
  pressed: { opacity: PRESS_OPACITY },
  eyebrow: { ...Typography.eyebrow, color: vola.textDim },
  title: { ...Typography.emphasis, color: vola.text },
  meta: { ...Typography.meta, color: vola.textMuted },
  detail: { ...Typography.caption, color: vola.textDim },
  absence: { ...Typography.body, color: vola.textMuted },
  absenceRow: { minHeight: TOUCH_MIN, justifyContent: 'center', gap: Spacing.xxs },
  absenceBlock: { gap: Spacing.xxs },
  absenceAction: { ...Typography.emphasis, color: vola.text },
  backButton: {
    width: 38,
    height: 38,
    borderRadius: 19,
    backgroundColor: vola.surfaceRaised,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
