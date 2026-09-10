import type { BiometricSample } from '../biometric';
import { vo2MaxAsOf, vo2MaxAsOfLine } from '../sessionVo2Max';

/**
 * N547/#990 part two. The rules under test are all about NOT overstating: the
 * estimate shown beside a session must be the one that stood on that session's
 * day, and must always name its own date.
 */
// A real `BiometricSample`, not a cast: `source` is the DEVICE
// (`apple_watch`) and `source_platform` is the store it came through
// (`healthkit`). Typing it properly is the point — a cast here would keep
// passing if the shape drifted underneath this module.
const sample = (measuredAt: string, value: number): BiometricSample => ({
  id: `s-${measuredAt}`,
  metric_type: 'vo2_max',
  source: 'apple_watch',
  source_platform: 'healthkit',
  value,
  unit: 'ml/kg/min',
  measured_at: measuredAt,
});

const READINGS = [
  sample('2026-08-20T09:00:00Z', 46.2),
  sample('2026-09-01T09:00:00Z', 47.8),
  sample('2026-09-08T09:00:00Z', 48.6),
];

describe('vo2MaxAsOf', () => {
  it('takes the latest reading on or before the session day', () => {
    expect(vo2MaxAsOf(READINGS, '2026-09-05')).toEqual({ value: 47.8, measuredOn: '2026-09-01' });
  });

  it('includes a reading taken ON the session day', () => {
    expect(vo2MaxAsOf(READINGS, '2026-09-08')).toEqual({ value: 48.6, measuredOn: '2026-09-08' });
  });

  it('never reaches forward for a later reading', () => {
    // THE assertion. A session from before the athlete's first sync has no
    // honest number; borrowing a later one would make an old session's figure
    // silently change every time a new reading arrived.
    expect(vo2MaxAsOf(READINGS, '2026-08-01')).toBeNull();
  });

  it('is absent, not zero, when there are no readings at all', () => {
    // The `hr_source: 'none'` discipline: absent reads as absent.
    expect(vo2MaxAsOf([], '2026-09-05')).toBeNull();
  });

  it('does not depend on the order the server returned', () => {
    const shuffled = [READINGS[2], READINGS[0], READINGS[1]];
    expect(vo2MaxAsOf(shuffled, '2026-09-05')).toEqual({ value: 47.8, measuredOn: '2026-09-01' });
  });

  it('uses the LOCAL day, not the UTC one', () => {
    // THE regression this file exists for after review. The suite runs at
    // TZ=America/Los_Angeles, so `2026-09-06T02:00:00Z` is 7pm on the 5th
    // LOCALLY — an evening sync on the session's own day. Sliced as a UTC
    // date it reads `2026-09-06`, lands after the session, and is silently
    // dropped; the athlete's reading disappears on the day they took it.
    //
    // `lib/useWeightTrend.ts` carries the same warning about the same slice
    // and ends "Banned once in review already." It was in this file too.
    const eveningLocal = [sample('2026-09-06T02:00:00Z', 49.4)];
    expect(vo2MaxAsOf(eveningLocal, '2026-09-05')).toEqual({
      value: 49.4,
      measuredOn: '2026-09-05',
    });
  });

  it('still excludes a reading that is genuinely the next local day', () => {
    // The other side of the same line — the fix must not simply widen the
    // window by a day. 9am UTC on the 6th is 2am local on the 6th: after the
    // session, and correctly dropped.
    const nextDay = [sample('2026-09-06T09:00:00Z', 49.4)];
    expect(vo2MaxAsOf(nextDay, '2026-09-05')).toBeNull();
  });

  it('compares by DAY, so a later instant on the session day still counts', () => {
    const lateInDay = [sample('2026-09-05T23:30:00Z', 49.1)];
    expect(vo2MaxAsOf(lateInDay, '2026-09-05')).toEqual({ value: 49.1, measuredOn: '2026-09-05' });
  });
});

describe('vo2MaxAsOfLine', () => {
  const fmt = (day: string) => day.slice(5); // enough to prove it is used

  it('names the reading’s own date, so it cannot read as this session’s number', () => {
    const line = vo2MaxAsOfLine({ value: 47.8, measuredOn: '2026-09-01' }, fmt);
    expect(line).toBe('VO₂max 47.8 · estimate from 09-01');
  });

  it('still names the date when the reading is from the session’s own day', () => {
    // The tempting shortcut is to drop the date when it matches. That is
    // exactly when the line would start reading as a per-session measurement.
    const line = vo2MaxAsOfLine({ value: 48.6, measuredOn: '2026-09-08' }, fmt);
    expect(line).toContain('estimate from');
  });

  it('says nothing rather than something empty when there is no reading', () => {
    expect(vo2MaxAsOfLine(null, fmt)).toBeNull();
  });

  it('shows one decimal, not the server’s full precision', () => {
    expect(vo2MaxAsOfLine({ value: 47.8399, measuredOn: '2026-09-01' }, fmt)).toContain('47.8');
  });
});
