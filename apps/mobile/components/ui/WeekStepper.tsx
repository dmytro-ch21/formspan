import { StyleSheet, View as RNView } from 'react-native';

import { Text } from '@/components/Themed';
import { Icon } from '@/components/ui/Icon';
import { vola } from '@/constants/Colors';
import { Radius, Spacing } from '@/constants/Spacing';
import { Typography } from '@/constants/Typography';

/**
 * A week's day-by-day schedule, read at a glance — N510.
 *
 * The reference is Hevy's Dashboard week stepper: a row of numbered day
 * markers connected by dashes, a filled circle for the day you're on, and a
 * moon glyph in place of a number for a scheduled rest day.
 *
 * ## Genuinely new, not a duplicate of `WeekPlanner`
 *
 * `WeekPlanner.tsx` used to render a week strip inline (its old `styles.strip`
 * block, removed by this ticket), and this ticket exists partly to answer
 * whether that strip should just be exported. It should not be, because the
 * two solve different problems:
 * `WeekPlanner`'s strip is a *calendar* view — seven real dates, a weekday
 * abbreviation over each, and a single "has a plan or not" bit, collapsible
 * to reveal full authoring rows underneath. This component is a *schedule*
 * view — day 1 through day 7 of a training week, with FOUR states rather
 * than two (done/current/upcoming/rest), no dates, no collapse, and nothing
 * to author. `WeekPlanner` is now the first caller of this component (see
 * its own comment on `weekStepperDayState` for why), replacing its old strip
 * with a state-aware one rather than the two drifting apart — but the two
 * remain separate components because "which week is this" (WeekPlanner) and
 * "what does this week look like at a glance" (this) are different questions
 * with different shapes, and forcing one component to answer both would mean
 * a `days: Date[]` prop growing an unrelated `mode: 'calendar' | 'glance'`
 * branch instead.
 *
 * ## Tokens, not literals (N508)
 *
 * Spacing, radius and type all come from `constants/Spacing.ts` /
 * `Typography.ts`, per N508 — no new pixel literals invented for this
 * component. Colour is the one deliberate exception: `vola.lime` is used
 * directly rather than `useAccent()`, matching `WeekStrip.tsx` and
 * `WeekPlanner.tsx`'s own strip before it — an accent is identity and
 * interaction, and a mark that encodes a READING (done vs upcoming vs rest)
 * must stay legible regardless of which accent colour an athlete picked, or
 * the same fact would render differently depending on a setting that has
 * nothing to do with it.
 */

export type WeekStepperDayState = 'done' | 'current' | 'upcoming' | 'rest';

export type WeekStepperDay = {
  /** Stable identity for the row `key` — a date string, or a program-day id. */
  key: string;
  /** The number drawn in the circle for every state except `rest`. */
  number: number;
  state: WeekStepperDayState;
  /**
   * What VoiceOver says for this day, before the state is appended —
   * "Monday, 4 August", or "Day 3" for a dateless program week. The state
   * itself ("today", "done", "rest", "still to come") is appended by this
   * component so every caller speaks it identically.
   */
  label: string;
};

export type WeekStepperProps = {
  days: WeekStepperDay[];
  /**
   * "W1"-style eyebrow above the row, matching the reference. Optional and
   * omitted by `WeekPlanner` — its own `PeriodSwitcher` immediately above
   * already names the week ("THIS WEEK", or a date range), and repeating
   * that here would be the same fact stated twice `WeekPlanner`'s own
   * `weekLabel` comment already argues against.
   */
  weekLabel?: string;
  testID?: string;
};

/**
 * What VoiceOver appends to a day's own {@link WeekStepperDay.label}.
 *
 * A separate function from the visual `state`, even though today it is a
 * pure lookup, because the spoken word for `done` is deliberately not
 * "completed" — see `weekStepperDayState`'s own comment on why this
 * component never claims a session happened, only that the day's slot has
 * passed. Keeping this a named function (rather than inlining the strings at
 * the call site) is what makes that choice reviewable in one place.
 */
function spokenState(state: WeekStepperDayState): string {
  switch (state) {
    case 'current':
      return 'today';
    case 'done':
      return 'past';
    case 'rest':
      return 'rest day';
    case 'upcoming':
      return 'still to come';
  }
}

/**
 * The day this schedule is a plan or a rest day, from data any caller
 * already has: whether the day is today, whether it has already happened,
 * and whether anything is planned for it.
 *
 * **`current` wins over everything else, including `rest`.** The reference
 * fills the day-you're-on circle with its number even when that day is a
 * rest day — "which day you're on" and "which days are rest" are both real
 * facts, but the reference draws only one marker per day, and it draws the
 * number. A rest day that is also today still reads as a rest day from the
 * screen around this component (`WeekPlanner`'s own row already says
 * "Rest"); this strip's job is the seven-day shape, not the only place the
 * fact can be read.
 *
 * **`done` means "this day's slot has passed", not "you trained".** VOLA's
 * plan model deliberately carries no completion flag — `lib/plan.ts`'s own
 * doc comment: *"A plan is an intention, never a session... Nothing in this
 * module writes a completion status, and there is no column for one."*
 * Answering "did you actually train" needs a join against logged sessions
 * (`lib/adherence.ts`'s `matchPlans`), which is a second, heavier read this
 * glance strip does not carry — the same restraint `WeekPlanner`'s per-day
 * rows already show (a past planned day is drawn identically to a future
 * one, dimmed, never marked complete). So `done` here answers "was a
 * training day scheduled here, and has it gone by" — an honest, cheaper
 * question that does not claim to know what happened in the gym.
 */
export function weekStepperDayState(input: {
  isToday: boolean;
  isPast: boolean;
  hasPlan: boolean;
}): WeekStepperDayState {
  if (input.isToday) return 'current';
  if (!input.hasPlan) return 'rest';
  return input.isPast ? 'done' : 'upcoming';
}

export function WeekStepper({ days, weekLabel, testID }: WeekStepperProps) {
  return (
    <RNView style={styles.wrap} testID={testID}>
      {weekLabel !== undefined && <Text style={styles.weekLabel}>{weekLabel}</Text>}
      <RNView style={styles.row}>
        {days.map((day, i) => (
          <RNView key={day.key} style={styles.step}>
            <DayMark day={day} />
            {i < days.length - 1 && <RNView style={styles.connector} />}
          </RNView>
        ))}
      </RNView>
    </RNView>
  );
}

function DayMark({ day }: { day: WeekStepperDay }) {
  const { state } = day;
  return (
    <RNView
      style={[
        styles.mark,
        state === 'current' && styles.markCurrent,
        state === 'done' && styles.markDone,
        state === 'rest' && styles.markRest,
      ]}
      accessible
      accessibilityLabel={`${day.label}, ${spokenState(state)}`}
      testID={`week-stepper-day-${day.key}`}
    >
      {state === 'rest' ? (
        // `current` always wins over `rest` in `weekStepperDayState` (see its
        // own comment), so this branch never renders for today's mark — the
        // colour is fixed rather than branching on a case that cannot occur.
        <Icon name="sleep" size={13} color={vola.textDim} />
      ) : (
        <Text
          style={[
            styles.number,
            state === 'current' && styles.numberCurrent,
            state === 'upcoming' && styles.numberUpcoming,
          ]}
        >
          {day.number}
        </Text>
      )}
    </RNView>
  );
}

const MARK_SIZE = 28;

const styles = StyleSheet.create({
  wrap: { gap: Spacing.sm },
  weekLabel: {
    ...Typography.eyebrow,
    textTransform: 'uppercase',
    color: vola.textDim,
  },
  row: { flexDirection: 'row', alignItems: 'center' },
  step: { flexDirection: 'row', alignItems: 'center', flex: 1, justifyContent: 'center' },
  connector: {
    flex: 1,
    borderTopWidth: 1,
    borderStyle: 'dashed',
    borderColor: vola.line,
    marginHorizontal: Spacing.xs,
  },
  mark: {
    width: MARK_SIZE,
    height: MARK_SIZE,
    borderRadius: Radius.pill,
    borderWidth: 1.5,
    borderColor: vola.line,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: vola.surface,
  },
  // The day you're on — filled, regardless of whether it is also a rest day.
  // See `weekStepperDayState`'s own comment on why `current` wins.
  markCurrent: { backgroundColor: vola.lime, borderColor: vola.lime },
  // A day whose slot has passed. Filled softer than `current` so the two are
  // never confused — the ONLY thing that means "you are here" is the solid
  // lime of `markCurrent`.
  markDone: { backgroundColor: vola.surfaceHover, borderColor: vola.lineSoft },
  markRest: { borderStyle: 'dashed', borderColor: vola.lineSoft },
  number: { ...Typography.emphasis, color: vola.text, fontVariant: ['tabular-nums'] },
  numberCurrent: { color: vola.bg },
  numberUpcoming: { color: vola.textDim },
});
