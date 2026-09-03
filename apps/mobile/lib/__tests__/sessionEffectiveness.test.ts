import {
  CALIBRATION_DELTA_THRESHOLD,
  MIN_ZONE_MINUTES_FOR_CALIBRATION,
  sessionEffectivenessSummary,
  type SessionEffectivenessSummary,
} from '../sessionEffectiveness';
import type { SessionMetrics } from '../biometricApi';

/**
 * The calibration this module exists for, and the two guards that keep it
 * honest: it never speaks without real HR evidence (evidence-gating), and
 * the same inputs always produce the same verdict (determinism) — the two
 * properties N481/#826 names explicitly. Neither is true "by construction";
 * both are asserted directly below rather than assumed from reading the
 * implementation, per this repo's "verify that a check can fail" discipline.
 */

type Metrics = Pick<SessionMetrics, 'trimp' | 'time_in_zones' | 'hr_source'>;

function metrics(overrides: Partial<Metrics> = {}): Metrics {
  return {
    trimp: null,
    time_in_zones: {},
    hr_source: 'none',
    ...overrides,
  };
}

/** A metrics row with `totalMinutes` spent entirely in one `zone` (1-5). */
function singleZone(zone: number, totalMinutes: number, hrSource: Metrics['hr_source'] = 'window'): Metrics {
  return metrics({
    trimp: totalMinutes * zone,
    time_in_zones: { [String(zone)]: totalMinutes },
    hr_source: hrSource,
  });
}

describe('sessionEffectivenessSummary — evidence gating', () => {
  test('no HR data (hr_source none) never produces a summary, even with a real RPE and TRIMP', () => {
    const m = metrics({ trimp: 40, time_in_zones: { '4': 20 }, hr_source: 'none' });
    expect(sessionEffectivenessSummary(m, 7)).toBeNull();
  });

  test('trimp not yet computed (null) never produces a summary', () => {
    const m = metrics({ trimp: null, time_in_zones: { '3': 30 }, hr_source: 'window' });
    expect(sessionEffectivenessSummary(m, 6)).toBeNull();
  });

  test('no session RPE reported never produces a summary', () => {
    const m = singleZone(3, 30);
    expect(sessionEffectivenessSummary(m, null)).toBeNull();
  });

  test.each([0, 11, -1])('an RPE outside 1-10 (%i) never produces a summary', (rpe) => {
    const m = singleZone(3, 30);
    expect(sessionEffectivenessSummary(m, rpe)).toBeNull();
  });

  test('HR evidence thinner than the minimum zone-minutes floor produces no summary', () => {
    const m = singleZone(4, MIN_ZONE_MINUTES_FOR_CALIBRATION - 1);
    expect(sessionEffectivenessSummary(m, 8)).toBeNull();
  });

  test('HR evidence exactly at the minimum zone-minutes floor is enough to produce a summary', () => {
    const m = singleZone(4, MIN_ZONE_MINUTES_FOR_CALIBRATION);
    expect(sessionEffectivenessSummary(m, 8)).not.toBeNull();
  });

  test('workout-anchored HR evidence (hr_source "workout") is just as eligible as a window read', () => {
    const m = singleZone(3, 30, 'workout');
    expect(sessionEffectivenessSummary(m, 6)).not.toBeNull();
  });
});

describe('sessionEffectivenessSummary — determinism', () => {
  test('the same inputs produce the identical verdict on repeated calls', () => {
    const m = metrics({
      trimp: 5 * 1 + 15 * 3 + 5 * 5,
      time_in_zones: { '1': 5, '3': 15, '5': 5 },
      hr_source: 'window',
    });
    const first = sessionEffectivenessSummary(m, 9);
    const second = sessionEffectivenessSummary(m, 9);
    const third = sessionEffectivenessSummary(m, 9);
    expect(second).toEqual(first);
    expect(third).toEqual(first);
  });

  test('object identity is irrelevant — two structurally-equal-but-distinct inputs still agree', () => {
    const a = singleZone(2, 20);
    const b: Metrics = { trimp: 40, time_in_zones: { '2': 20 }, hr_source: 'window' };
    expect(sessionEffectivenessSummary(a, 4)).toEqual(sessionEffectivenessSummary(b, 4));
  });
});

describe('sessionEffectivenessSummary — calibration direction', () => {
  // 30 minutes entirely in zone 3 -> avg zone weight 3.0 -> HR-implied RPE
  // round(3.0 * 2) = 6. Table below sweeps the reported RPE across, at and
  // around that value to exercise all three branches from one fixed HR
  // picture, so the only thing varying between rows is the number under
  // test.
  const m = singleZone(3, 30);
  const hrImplied = 6;

  test.each([
    { rpe: 1, direction: 'felt_easier' as const },
    { rpe: 3, direction: 'felt_easier' as const },
    { rpe: hrImplied - CALIBRATION_DELTA_THRESHOLD, direction: 'felt_easier' as const }, // 4: boundary, inclusive
    { rpe: hrImplied - CALIBRATION_DELTA_THRESHOLD + 1, direction: 'aligned' as const }, // 5: just inside the noise band
    { rpe: hrImplied, direction: 'aligned' as const }, // 6: exact match
    { rpe: hrImplied + CALIBRATION_DELTA_THRESHOLD - 1, direction: 'aligned' as const }, // 7: just inside the noise band
    { rpe: hrImplied + CALIBRATION_DELTA_THRESHOLD, direction: 'felt_harder' as const }, // 8: boundary, inclusive
    { rpe: 10, direction: 'felt_harder' as const },
  ])('RPE $rpe against HR-implied $hrImplied classifies as $direction', ({ rpe, direction }) => {
    const summary = sessionEffectivenessSummary(m, rpe) as SessionEffectivenessSummary;
    expect(summary).not.toBeNull();
    expect(summary.direction).toBe(direction);
    expect(summary.hrImpliedRPE).toBe(hrImplied);
    expect(summary.reportedRPE).toBe(rpe);
  });

  test('the threshold is symmetric: a delta of exactly the threshold in either direction is never "aligned"', () => {
    const above = sessionEffectivenessSummary(m, hrImplied + CALIBRATION_DELTA_THRESHOLD);
    const below = sessionEffectivenessSummary(m, hrImplied - CALIBRATION_DELTA_THRESHOLD);
    expect(above?.direction).not.toBe('aligned');
    expect(below?.direction).not.toBe('aligned');
  });
});

describe('sessionEffectivenessSummary — dominant zone and weighted average', () => {
  test('picks the zone with the most minutes, not the highest-numbered zone present', () => {
    const m = metrics({
      trimp: 25 * 1 + 5 * 5, // 25 min zone1 + 5 min zone5
      time_in_zones: { '1': 25, '5': 5 },
      hr_source: 'window',
    });
    // avg zone weight = (25*1 + 5*5) / 30 = 50/30 ≈ 1.667 -> hrImplied round(3.33) = 3
    const summary = sessionEffectivenessSummary(m, 3)!;
    expect(summary.dominantZone).toBe(1);
    expect(summary.hrImpliedRPE).toBe(3);
  });

  test('a tie between two zones resolves to the lower zone number, deterministically', () => {
    const m = metrics({
      trimp: 15 * 2 + 15 * 4,
      time_in_zones: { '2': 15, '4': 15 },
      hr_source: 'window',
    });
    const summary = sessionEffectivenessSummary(m, 6)!;
    expect(summary.dominantZone).toBe(2);
  });

  test('a zone map with only some of the five keys present is read correctly (missing keys are zero minutes)', () => {
    const m = metrics({
      trimp: 40 * 4,
      time_in_zones: { '4': 40 },
      hr_source: 'window',
    });
    const summary = sessionEffectivenessSummary(m, 8)!;
    expect(summary.dominantZone).toBe(4);
    expect(summary.hrImpliedRPE).toBe(8);
  });
});

describe('sessionEffectivenessSummary — copy', () => {
  test('headline and detail text for each direction, pinned to literals', () => {
    const m = singleZone(3, 30); // hrImplied = 6

    const harder = sessionEffectivenessSummary(m, 9)!;
    expect(harder.headline).toBe('This felt harder than your heart rate suggests');
    expect(harder.detail).toBe(
      'You rated this session very hard (RPE 9/10), but your heart rate spent most of it in zone 3 — sessions like that usually read closer to moderate (RPE 6/10).',
    );

    const easier = sessionEffectivenessSummary(m, 2)!;
    expect(easier.headline).toBe('This felt easier than your heart rate suggests');
    expect(easier.detail).toBe(
      'You rated this session very easy (RPE 2/10), but your heart rate spent most of it in zone 3 — sessions like that usually read closer to moderate (RPE 6/10).',
    );

    const aligned = sessionEffectivenessSummary(m, 6)!;
    expect(aligned.headline).toBe('Your effort rating matches your heart rate');
    expect(aligned.detail).toBe(
      'You rated this session RPE 6/10, and your heart rate spent most of it in zone 3 — right where a moderate session usually sits.',
    );
  });
});
