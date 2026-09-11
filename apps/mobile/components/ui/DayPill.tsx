import { PeriodSwitcher } from '@/components/ui/PeriodSwitcher';
import { dayPillLabel, longDayLabel } from '@/lib/calendar';

/**
 * "Which day am I looking at" — ONE component, for every tab that asks it.
 *
 * ## Why this exists (N493 part 3, #858 item 5)
 *
 * The athlete reported, from a device, that the day pill on the Food tab was
 * not the same thing as the day pill on Today. It was reported as a look, and
 * it was really a structure: both screens rendered {@link PeriodSwitcher}, and
 * then each screen assembled that component's props on its own.
 *
 * Part 1 of this ticket (#861) fixed the biggest symptom — Food's first line
 * fell through to the raw `YYYY-MM-DD` string on any day but today — by
 * extracting `dayPillLabel` into `lib/calendar.ts` and pointing both screens
 * at it. That shared the label and nothing else, and **the pills still
 * differed**: Today folds the long date (`Thursday, 10 September`) into the
 * pill as a `subLabel` and Food did not, so on today — the day either tab is
 * most often showing — one pill was two lines and the other was one.
 *
 * "Same component" is therefore the whole point of this file, and it is a
 * stronger claim than "same `PeriodSwitcher`". Everything about a *day* pill
 * that is not a per-screen decision is decided HERE:
 *
 * - both lines of text (`dayPillLabel` + `longDayLabel`);
 * - the rule that the long date shows on today and is omitted elsewhere,
 *   where the first line already carries the date (W14/#694's reasoning,
 *   which used to live in a comment on Today's call site alone);
 * - the calendar icon, and the arrows' accessible names.
 *
 * A screen passes what only it can know: which day, and what pressing the
 * label does.
 *
 * ## What is deliberately still a prop, and why
 *
 * `onPress`. The two tabs genuinely disagree about the label's destination
 * and the disagreement is load-bearing rather than drift:
 *
 * - **Food** always opens the month grid — N81/#415 is the ticket, and its
 *   complaint was that a pill which only ever meant "undo my navigation" left
 *   the calendar icon promising something it did not do, and left correcting a
 *   day three months back at up to ninety taps on the arrows.
 * - **Today** has no month grid to open, so on today its label is a readout
 *   and on any other day it steps back to today.
 *
 * Unifying that would mean building a month grid on Today, which is a product
 * change and not this ticket. It is recorded here so the next person reads a
 * decision rather than an oversight.
 */
export function DayPill({
  viewDay,
  isToday,
  onPrev,
  onNext,
  onPress,
  pressLabel,
  testID,
}: {
  /** The day on screen. */
  viewDay: Date;
  /** Whether {@link viewDay} is the device's own today. */
  isToday: boolean;
  onPrev: () => void;
  onNext: () => void;
  /** Omit to make the label a readout rather than a control. */
  onPress?: () => void;
  pressLabel?: string;
  testID?: string;
}) {
  return (
    <PeriodSwitcher
      label={dayPillLabel(viewDay, isToday)}
      // Only on today. On any other day the FIRST line already states the
      // date (`FRI, SEP 4`), so a long form under it is the same fact twice —
      // exactly the duplication `subLabel` was added to remove, one level
      // down. W14/#694 settled this on Today; it is settled here now so Food
      // cannot settle it differently.
      subLabel={isToday ? longDayLabel(viewDay) : undefined}
      onPrev={onPrev}
      onNext={onNext}
      onPress={onPress}
      icon="calendar"
      prevLabel="Previous day"
      nextLabel="Next day"
      pressLabel={pressLabel}
      testID={testID}
    />
  );
}
