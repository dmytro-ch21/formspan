import { renderHook, waitFor } from '@testing-library/react-native';

import { emptyCopy } from '@/components/TrendCard';
import { MIN_TREND_READINGS, shiftDate, TREND_DAYS } from '@/lib/anthropometry';
import type { Checkin } from '@/lib/body';
import { dayString } from '@/lib/calendar';
import { useWeightTrend } from '@/lib/useWeightTrend';

/**
 * F26/#710 — the weight chart said "5 of 1 readings needed for a trend line."
 *
 * Found on L1's device sweep (#380) with a realistic weigh-in cadence, one every
 * five days: no chart, and a message claiming the athlete needed ONE reading
 * while holding five. The 1 was `buildTrend`'s default for `minReadings`, which
 * `useWeightTrend` never set. The real rule is `trendWeight`'s,
 * MIN_TREND_READINGS inside ONE TREND_DAYS window — a density, which a weigh-in
 * every five days never meets and no flat count can describe.
 *
 * These run the REAL hook, with only the network mocked, because the defect was
 * in the hook's wiring: every other test of this hook mocks it away, and a test
 * of `buildTrend` alone passes whether or not the hook passes the threshold.
 */
const mockListCheckins = jest.fn();
const mockListPhases = jest.fn();
jest.mock('@/lib/body', () => ({
  listCheckins: (...a: unknown[]) => mockListCheckins(...a),
  listPhases: (...a: unknown[]) => mockListPhases(...a),
}));

const TODAY = dayString(new Date());

/** A weigh-in `daysAgo` days before today. */
const weighIn = (daysAgo: number, kg = 80): Checkin =>
  ({ measured_on: shiftDate(TODAY, -daysAgo), weight_kg: kg }) as unknown as Checkin;

async function trendFor(checkins: Checkin[]) {
  mockListCheckins.mockResolvedValue(checkins);
  mockListPhases.mockResolvedValue([]);
  const rendered = await renderHook(() => useWeightTrend(async () => 'token', '1M', 30, null));
  await waitFor(() => expect(rendered.result.current.loading).toBe(false));
  return rendered.result.current;
}

beforeEach(() => {
  mockListCheckins.mockReset();
  mockListPhases.mockReset();
});

describe('weight readings every five days', () => {
  it('reports too few, naming the density rather than a count already cleared', async () => {
    const { series } = await trendFor([20, 15, 10, 5, 0].map((d) => weighIn(d)));
    expect(series.segments).toHaveLength(0);
    expect(series.empty).toEqual({
      kind: 'too-few',
      have: 5,
      need: MIN_TREND_READINGS,
      withinDays: TREND_DAYS,
    });
    expect(emptyCopy(series.empty!, 'weight')).toBe(
      'A trend line needs 3 readings within any 7 days, and yours are further apart. Log a few closer together to start one.',
    );
  });

  it('draws the line once three fall inside one week, with nothing else changed', async () => {
    // The ticket's own control: the same five, plus two more beside today.
    const { series } = await trendFor([20, 15, 10, 5, 2, 1, 0].map((d) => weighIn(d)));
    expect(series.empty).toBeNull();
    expect(series.segments.length).toBeGreaterThan(0);
  });
});

describe('too few readings, close together', () => {
  it('says how many of the three it has, and the window they must share', async () => {
    const { series } = await trendFor([1, 0].map((d) => weighIn(d)));
    expect(series.empty).toEqual({ kind: 'too-few', have: 2, need: 3, withinDays: 7 });
    // Not "further apart": these two are a day apart. The count is the problem.
    expect(emptyCopy(series.empty!, 'weight')).toBe(
      '2 of 3 readings so far — a trend line needs 3 within any 7 days.',
    );
  });
});

describe('a threshold with no window', () => {
  it('keeps the plain count, for a smoother that counts in total', () => {
    expect(emptyCopy({ kind: 'too-few', have: 1, need: 2 }, 'readings')).toBe(
      '1 of 2 readings needed for a trend line.',
    );
  });
});
