import { render, screen } from '@testing-library/react-native';

import { TrendChart } from '../TrendChart';
import { buildTrend, projectToGoal, type Reading } from '@/lib/trendSeries';

/**
 * What the DRAWING has to get right.
 *
 * `lib/__tests__/trendSeries.test.ts` covers the arithmetic thoroughly and in
 * isolation — and every one of those assertions still passes if the chart never
 * mounts a single path, because a pure function does not care whether anybody
 * drew its output. This file covers the wiring and the three claims a viewer
 * reads off the picture rather than off a number: that a hole stays a hole,
 * that the two dashed marks appear only when they are true, and that the
 * callouts show what the scale said.
 */

const TODAY = '2026-08-19';

function shift(on: string, days: number): string {
  return new Date(Date.parse(`${on}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
}

function meanSmoother(readings: Reading[]) {
  return (on: string) => {
    const from = shift(on, -6);
    const w = readings.filter((r) => r.on >= from && r.on <= on);
    return w.length ? w.reduce((s, r) => s + r.value, 0) / w.length : null;
  };
}

function daily(days: number, from: number, delta: number): Reading[] {
  const out: Reading[] = [];
  for (let i = days - 1; i >= 0; i--) out.push({ on: shift(TODAY, -i), value: from + delta * (days - 1 - i) });
  return out;
}

const paths = () => screen.UNSAFE_root.findAllByType('RNSVGPath' as never);

function chart(props: Partial<React.ComponentProps<typeof TrendChart>> = {}) {
  const readings = props.series ? [] : daily(60, 100, -0.05);
  return render(
    <TrendChart
      series={props.series ?? buildTrend({ readings, today: TODAY, range: '3M', smooth: meanSmoother(readings) })}
      format={(v) => v.toFixed(1)}
      minSpan={1}
      accessibilityLabel="Weight trend"
      {...props}
    />,
  );
}

// The one thing a viewer reads off the picture and cannot read off a number.
// A single path across the hole would be the app inventing a fortnight of
// weigh-ins, and it would look completely normal.
test('a gap is drawn as separate paths, never one line across it', () => {
  const readings: Reading[] = [
    { on: shift(TODAY, -60), value: 100 },
    { on: shift(TODAY, -59), value: 100 },
    { on: shift(TODAY, -58), value: 100 },
    { on: shift(TODAY, -3), value: 96 },
    { on: shift(TODAY, -2), value: 96 },
    { on: shift(TODAY, -1), value: 96 },
  ];
  const series = buildTrend({ readings, today: TODAY, range: '3M', smooth: meanSmoother(readings) });
  chart({ series });
  // More than one line path means the run was broken rather than bridged.
  expect(series.segments.length).toBeGreaterThan(1);
  expect(paths().length).toBeGreaterThanOrEqual(series.segments.filter((s) => s.length > 1).length);
});

describe('the two dashed marks appear only when they are true', () => {
  test('no goal set means no goal line', () => {
    chart({ goal: null });
    expect(screen.queryByTestId('trend-goal-line')).toBeNull();
  });

  test('a goal draws the line', () => {
    chart({ goal: 90 });
    expect(screen.getByTestId('trend-goal-line')).toBeTruthy();
  });

  // The absence that must not read as an all-clear: a refused projection draws
  // nothing, and the SENTENCE beside the chart is what says why. A dashed line
  // drawn anyway would be a claim nobody made.
  test('a refused projection draws no dashed line', () => {
    const readings = daily(60, 100, +0.05); // gaining, goal is below
    const series = buildTrend({ readings, today: TODAY, range: '3M', smooth: meanSmoother(readings) });
    const p = projectToGoal(series, 90);
    expect(p.kind).toBe('none');
    chart({ series, goal: 90, projection: p });
    expect(screen.queryByTestId('trend-projection')).toBeNull();
  });

  test('a real projection draws one', () => {
    const readings = daily(60, 100, -0.05);
    const series = buildTrend({ readings, today: TODAY, range: '3M', smooth: meanSmoother(readings) });
    chart({ series, goal: 90, projection: projectToGoal(series, 90) });
    expect(screen.getByTestId('trend-projection')).toBeTruthy();
  });
});

// The callouts read the RAW reading, never the smoothed line. An athlete who
// steps off a scale and sees a different number on the card than the scale gave
// them will not trust either. The two differ by 1-2 kg on any given day, which
// is the same size as the change being reported.
test('the callouts show the measurements, not the trend line', () => {
  const readings: Reading[] = [
    ...daily(30, 100, 0).slice(0, 29),
    { on: TODAY, value: 93.4 }, // a sharp last reading the mean would not follow
  ];
  const series = buildTrend({ readings, today: TODAY, range: '1M', smooth: meanSmoother(readings) });
  chart({ series });

  // Queried off the serialised tree rather than with `getByText`: react-native-
  // svg renders an `RNSVGText` host node, which RNTL's text matcher does not
  // traverse. Measured — the string is present and `queryByText` returns null
  // for it, so a getByText assertion here fails on a correct component and
  // would have been "fixed" by weakening the check.
  const tree = JSON.stringify(screen.toJSON());
  const smoothed = meanSmoother(readings)(TODAY)!;
  expect(Math.abs(smoothed - 93.4)).toBeGreaterThan(0.5); // the two really do differ
  expect(tree).toContain('93.4');
  expect(tree).not.toContain(smoothed.toFixed(1));
});

test('an empty series still renders without throwing', () => {
  const series = buildTrend({ readings: [], today: TODAY, range: '1M' });
  chart({ series });
  expect(screen.queryByTestId('trend-goal-line')).toBeNull();
});
