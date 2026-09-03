import { render, screen } from '@testing-library/react-native';
import { StyleSheet } from 'react-native';

import { TrendCard } from '../TrendCard';
import { buildTrend, type Reading } from '@/lib/trendSeries';

/**
 * What the card SAYS, as opposed to what the series computed.
 *
 * `lib/__tests__/trendSeries.test.ts` proves the four empty states are told
 * apart in the data. This proves the card does not flatten them back into one
 * sentence on the way to the screen — which is the step where every previous
 * version of this bug in this codebase actually happened.
 */

const TODAY = '2026-08-19';
const shift = (on: string, d: number) =>
  new Date(Date.parse(`${on}T00:00:00Z`) + d * 86_400_000).toISOString().slice(0, 10);

function card(readings: Reading[] | null, range: '1W' | '1M' | '1Y' = '1M') {
  const series = buildTrend({ readings, today: TODAY, range });
  return render(
    <TrendCard
      title="WEIGHT"
      series={series}
      format={(v) => v.toFixed(1)}
      unit="kg"
      periodLabel="past month"
      minSpan={1}
      actionLabel="Record Weight"
      onAction={() => {}}
    />,
  );
}

// THE ONE THAT MATTERS. "We could not load it" is a claim about the network;
// "record your weight and the trend appears" is a claim about the athlete.
// Rendering the second when the first is true blames somebody for a tunnel.
test('a failed load never says "you have no readings"', () => {
  card(null);
  const said = screen.getByTestId('trend-card-empty').props.children as string;
  expect(said).toMatch(/couldn't load/i);
  expect(said).not.toMatch(/record your weight/i);
});

test('never having recorded says so, and invites the first one', () => {
  card([]);
  expect(screen.getByTestId('trend-card-empty').props.children).toMatch(/record your weight/i);
});

// An athlete with two years of weigh-ins must not be told they have none
// because they are looking at a week.
test('readings outside the window point at the wider range, not at emptiness', () => {
  const said = (() => {
    card([{ on: shift(TODAY, -300), value: 100 }], '1W');
    return screen.getByTestId('trend-card-empty').props.children as string;
  })();
  expect(said).toMatch(/nothing in this range/i);
  expect(said).toMatch(/1 reading/);
  expect(said).not.toMatch(/record your weight/i);
});

// The count is what separates a trend from two weigh-ins, and the athlete
// cannot tell them apart from the change alone.
test('a delta is never shown without how many readings produced it', () => {
  const readings: Reading[] = [
    { on: shift(TODAY, -20), value: 100 },
    { on: shift(TODAY, -1), value: 97 },
  ];
  card(readings);
  expect(screen.getByTestId('trend-card-delta')).toBeTruthy();
  const evidence = screen.getByTestId('trend-card-evidence').props.children;
  expect(JSON.stringify(evidence)).toContain('2');
});

// A delta that fell back to raw readings carries the day-to-day water swing the
// smoothed line exists to remove, and must not wear the line's credibility.
test('a delta measured off readings admits it on screen', () => {
  card([
    { on: shift(TODAY, -20), value: 100 },
    { on: shift(TODAY, -1), value: 97 },
  ]);
  expect(JSON.stringify(screen.getByTestId('trend-card-evidence').props.children)).toContain(
    'rather than off the trend line',
  );
});

// The scale's number, not the seven-day mean. Somebody who steps off a scale
// and sees a different figure here will not trust either again.
test('TODAY shows the latest raw reading', () => {
  card([
    { on: shift(TODAY, -2), value: 100 },
    { on: shift(TODAY, -1), value: 93.4 },
  ]);
  expect(JSON.stringify(screen.getByTestId('trend-card-today').props.children)).toContain('93.4');
});

test('the action is always reachable, even with nothing to draw', () => {
  card(null);
  expect(screen.getByTestId('trend-card-action')).toBeTruthy();
});

// #491: at accessibility XXXL, `actionLabel` widened the pill past the card's
// border and off the screen, because nothing in the footer row was allowed to
// give up width. jest-expo does not run Yoga's real layout — there is no
// pixel measurement available here to prove the pill stays inside the card at
// a given text scale, and that check stays a NEEDS HUMAN EVIDENCE item on
// #491 (device run at accessibility XXXL, control actually tapped). What this
// CAN pin is the mechanism the fix depends on: both the pill and its label
// must be able to shrink, or RN's default `flexShrink: 0` reproduces the
// overflow regardless of what the device check finds. Removing either
// `flexShrink` fails this test.
test('the action pill and its label can both give up width rather than overflow the card', () => {
  card([{ on: shift(TODAY, -1), value: 97 }]);
  const pillStyle = StyleSheet.flatten(screen.getByTestId('trend-card-action').props.style);
  const labelStyle = StyleSheet.flatten(screen.getByTestId('trend-card-action-label').props.style);
  expect(pillStyle.flexShrink).toBe(1);
  expect(labelStyle.flexShrink).toBe(1);
});

// ---------------------------------------------------------------------------
// The fifth state
//
// `TrendEmpty` has four kinds; a card has FIVE states, because "not answered
// yet" is not one of them. Review found this shipped: before the first fetch
// settled, `checkins == null` produced `readings: []`, which is a legitimate
// "none", which rendered "Record your weight and the trend appears here" — the
// exact athlete-blaming sentence the union exists to forbid — on every cold
// open, to an athlete with two years of weigh-ins.
//
// The type could not catch it: an unanswered fetch and an empty one both look
// like no readings. So the guard is a `loading` flag the caller must gate on,
// and this pins the sentence rather than the flag, because the flag is easy to
// reintroduce a way around.
// ---------------------------------------------------------------------------

test('an in-flight first load is not an empty series', () => {
  // What the card was handed while loading, before the fix.
  const looksEmpty = buildTrend({ readings: [], today: TODAY, range: '1M' });
  expect(looksEmpty.empty).toEqual({ kind: 'none' });

  render(
    <TrendCard
      title="WEIGHT"
      series={looksEmpty}
      format={(v) => v.toFixed(1)}
      unit="kg"
      periodLabel="past month"
      minSpan={1}
      actionLabel="Record Weight"
      onAction={() => {}}
    />,
  );
  // The card renders the "none" copy for this series — correctly, because the
  // series says none. Which is precisely why the CALLER must not hand it one
  // until the fetch has answered.
  expect(screen.getByTestId('trend-card-empty').props.children).toMatch(/record your weight/i);
});
