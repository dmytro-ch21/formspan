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
import { longDayLabel, shortDate } from '@/lib/calendar';
import { NO_NARRATION } from '@/lib/dayNarration';
import type { DayFact, DayPanel } from '@/lib/dayPanel';
import { labelFor, type Module } from '@/lib/modules';
import { useModules } from '@/lib/ModulesProvider';
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
  actionLabel,
  onPress,
}: {
  fact: DayFact;
  eyebrow?: string;
  title: string;
  meta: string;
  detail?: string | null;
  actionLabel?: string;
  onPress?: () => void;
}) {
  const body = (
    <>
      {eyebrow ? <Text style={styles.eyebrow}>{eyebrow.toUpperCase()}</Text> : null}
      <Text style={styles.title}>{title}</Text>
      <Text style={styles.meta}>{meta}</Text>
      {detail ? <Text style={styles.detail}>{detail}</Text> : null}
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
}: {
  text: string;
  testID: string;
  actionLabel?: string;
  onPress?: () => void;
}) {
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
function Unavailable({ what }: { what: 'plan' | 'trackers' | 'food' | 'target' }) {
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
