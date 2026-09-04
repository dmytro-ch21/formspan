import { buildHRSessionReport, HR_REPORT_MIN_SAMPLES } from '../hrSessionReport';
import { vola } from '@/constants/Colors';
import type { SessionMetrics } from '../biometric';

/**
 * N488/#849 — the cross-sport per-session HR report's view-model. These tests
 * are the guard against the three honesty failures the ticket names
 * explicitly: a zeroed report standing in for "no data", TRIMP/zones
 * rendering off evidence too thin to support them, and the effectiveness
 * verdict appearing when it should not.
 */

type Metrics = Pick<
  SessionMetrics,
  'avg_hr_bpm' | 'max_hr_bpm' | 'trimp' | 'time_in_zones' | 'hr_source' | 'sample_count'
>;

function metrics(overrides: Partial<Metrics> = {}): Metrics {
  return {
    avg_hr_bpm: 142,
    max_hr_bpm: 168,
    trimp: 187.3,
    time_in_zones: { '2': 10, '3': 20, '4': 10 },
    hr_source: 'window',
    sample_count: 40,
    ...overrides,
  };
}

describe('buildHRSessionReport — unavailable', () => {
  test('no computed metrics row at all', () => {
    expect(buildHRSessionReport(null, null)).toEqual({ state: 'unavailable' });
  });

  test('hr_source "none" — no wearable, or nothing fell in the window', () => {
    const m = metrics({ hr_source: 'none', avg_hr_bpm: null, max_hr_bpm: null, trimp: null, sample_count: 0 });
    expect(buildHRSessionReport(m, null)).toEqual({ state: 'unavailable' });
  });

  test('hr_source "none" wins even if avg/max were somehow non-null (defence in depth)', () => {
    const m = metrics({ hr_source: 'none', sample_count: 0 });
    expect(buildHRSessionReport(m, null)).toEqual({ state: 'unavailable' });
  });

  test('a non-none source with no HR figures at all still says nothing, never zero', () => {
    const m = metrics({ avg_hr_bpm: null, max_hr_bpm: null });
    expect(buildHRSessionReport(m, null)).toEqual({ state: 'unavailable' });
  });
});

describe('buildHRSessionReport — limited (real evidence, not enough for a breakdown)', () => {
  test('below the sample threshold: avg/max still carried through, trimp/zones/effectiveness absent', () => {
    const m = metrics({ sample_count: HR_REPORT_MIN_SAMPLES - 1 });
    const report = buildHRSessionReport(m, 7);
    expect(report).toEqual({
      state: 'limited',
      reason: 'sparse_samples',
      avgHR: 142,
      maxHR: 168,
      sampleCount: HR_REPORT_MIN_SAMPLES - 1,
    });
  });

  test('the threshold boundary: one below is limited, the threshold itself is not (given a real trimp)', () => {
    const below = buildHRSessionReport(metrics({ sample_count: HR_REPORT_MIN_SAMPLES - 1 }), null);
    const at = buildHRSessionReport(metrics({ sample_count: HR_REPORT_MIN_SAMPLES }), null);
    expect(below.state).toBe('limited');
    expect(at.state).toBe('full');
  });

  test('no HRmax to classify against: trimp null despite real samples and a healthy sample count', () => {
    const m = metrics({ trimp: null, sample_count: 100 });
    const report = buildHRSessionReport(m, 7);
    expect(report).toEqual({
      state: 'limited',
      reason: 'no_hrmax',
      avgHR: 142,
      maxHR: 168,
      sampleCount: 100,
    });
  });

  test('sparse samples is checked before no_hrmax — the more specific, more common reason wins', () => {
    const m = metrics({ trimp: null, sample_count: 2 });
    const report = buildHRSessionReport(m, null);
    expect(report.state).toBe('limited');
    if (report.state !== 'limited') throw new Error('expected limited');
    expect(report.reason).toBe('sparse_samples');
  });
});

describe('buildHRSessionReport — full', () => {
  test('zones sum to a real percentage breakdown, only over ZONE-ATTRIBUTED minutes', () => {
    const m = metrics({ time_in_zones: { '2': 10, '3': 20, '4': 10 } }); // 40 total
    const report = buildHRSessionReport(m, null);
    expect(report.state).toBe('full');
    if (report.state !== 'full') throw new Error('expected full');
    expect(report.totalZoneMinutes).toBe(40);
    expect(report.zones).toHaveLength(5);
    const byZone = Object.fromEntries(report.zones.map((z) => [z.zone, z]));
    expect(byZone[1]).toMatchObject({ minutes: 0, pct: 0 });
    expect(byZone[2]).toMatchObject({ minutes: 10, pct: 25 });
    expect(byZone[3]).toMatchObject({ minutes: 20, pct: 50 });
    expect(byZone[4]).toMatchObject({ minutes: 10, pct: 25 });
    expect(byZone[5]).toMatchObject({ minutes: 0, pct: 0 });
  });

  test('zero minutes attributed to any zone despite a real trimp: every pct is 0, not NaN or divide-by-zero garbage', () => {
    const m = metrics({ time_in_zones: {}, trimp: 0 });
    const report = buildHRSessionReport(m, null);
    expect(report.state).toBe('full');
    if (report.state !== 'full') throw new Error('expected full');
    expect(report.totalZoneMinutes).toBe(0);
    expect(report.zones.every((z) => z.pct === 0)).toBe(true);
  });

  test('avg/max/trimp pass through untouched', () => {
    const report = buildHRSessionReport(metrics({ avg_hr_bpm: 150, max_hr_bpm: 180, trimp: 92.4 }), null);
    expect(report.state).toBe('full');
    if (report.state !== 'full') throw new Error('expected full');
    expect(report.avgHR).toBe(150);
    expect(report.maxHR).toBe(180);
    expect(report.trimp).toBe(92.4);
  });

  test('the effectiveness verdict is wired in, using the real sessionEffectivenessSummary — not reimplemented', () => {
    // A session whose HR time sits entirely in zone 4 (weight 4, so
    // hrImpliedRPE ~= 8, "Very hard") against a self-reported RPE of 2 —
    // a >=2 gap, so this must read as "felt easier than heart rate suggests".
    const m = metrics({ trimp: 4 * 30, time_in_zones: { '4': 30 }, sample_count: 40 });
    const report = buildHRSessionReport(m, 2);
    expect(report.state).toBe('full');
    if (report.state !== 'full') throw new Error('expected full');
    expect(report.effectiveness).not.toBeNull();
    expect(report.effectiveness?.direction).toBe('felt_easier');
  });

  test('no sessionRPE (strength/running today): full HR data still renders, effectiveness is null', () => {
    const report = buildHRSessionReport(metrics(), null);
    expect(report.state).toBe('full');
    if (report.state !== 'full') throw new Error('expected full');
    expect(report.effectiveness).toBeNull();
  });
});

describe('buildHRSessionReport — zone colours reuse existing semantic tokens', () => {
  test('every zone colour is an already-established status token, not a new hex value', () => {
    const report = buildHRSessionReport(metrics(), null);
    expect(report.state).toBe('full');
    if (report.state !== 'full') throw new Error('expected full');
    const byZone = Object.fromEntries(report.zones.map((z) => [z.zone, z.color]));
    expect(byZone[1]).toBe(vola.textDim);
    expect(byZone[2]).toBe(vola.green);
    expect(byZone[3]).toBe(vola.rpeModerate);
    expect(byZone[4]).toBe(vola.warn);
    expect(byZone[5]).toBe(vola.danger);
  });

  test('the ramp is the same one already used for BJJ RPE — zone colours are not a second system', () => {
    // Mirrors `rpeColor()` in `app/bjj/log.tsx`: green -> rpeModerate -> warn
    // -> danger, ascending. Asserted here so the two ramps cannot silently
    // diverge — this test breaks if either file's colour choice changes
    // without the other being reconsidered.
    const report = buildHRSessionReport(metrics(), null);
    if (report.state !== 'full') throw new Error('expected full');
    const order = [2, 3, 4, 5].map((z) => report.zones.find((r) => r.zone === z)?.color);
    expect(order).toEqual([vola.green, vola.rpeModerate, vola.warn, vola.danger]);
  });
});
