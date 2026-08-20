import { render, screen } from '@testing-library/react-native';

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
