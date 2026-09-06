import {
  clampTimeOfDay,
  formatPlanTime,
  MAX_TIME_OF_DAY_MINUTES,
  validTimeOfDayMinutes,
} from '../planTime';

/**
 * Pure arithmetic over minutes-since-midnight — see `planTime.ts`'s own
 * doc comment on why nothing here may touch `Date`/`Intl`.
 *
 * The whole suite runs under TZ=America/Los_Angeles (apps/mobile/package.json's
 * `test` script). These assertions would read identically under any other
 * zone, and that IS the point being tested: a wall-clock value with no zone
 * attached must never move when the ambient timezone changes.
 */
describe('formatPlanTime', () => {
  test('null is null, not a placeholder string', () => {
    expect(formatPlanTime(null)).toBeNull();
  });

  test('midnight is 12:00 AM, not "0:00" or absent', () => {
    // 0 is a legal, real minute — it must not be conflated with "no time".
    expect(formatPlanTime(0)).toBe('12:00 AM');
  });

  test('noon is 12:00 PM', () => {
    expect(formatPlanTime(12 * 60)).toBe('12:00 PM');
  });

  test('7:00 PM — the reference design’s own example', () => {
    expect(formatPlanTime(19 * 60)).toBe('7:00 PM');
  });

  test('7:00 AM', () => {
    expect(formatPlanTime(7 * 60)).toBe('7:00 AM');
  });

  test('the last minute of the day', () => {
    expect(formatPlanTime(MAX_TIME_OF_DAY_MINUTES)).toBe('11:59 PM');
  });

  test('minutes pad to two digits', () => {
    expect(formatPlanTime(9 * 60 + 5)).toBe('9:05 AM');
  });

  test('out of range is null, not a wrapped or clamped value', () => {
    expect(formatPlanTime(-1)).toBeNull();
    expect(formatPlanTime(1440)).toBeNull();
  });
});

describe('validTimeOfDayMinutes', () => {
  test('accepts the full 0..1439 range', () => {
    expect(validTimeOfDayMinutes(0)).toBe(true);
    expect(validTimeOfDayMinutes(1439)).toBe(true);
  });

  test('rejects a value outside the range', () => {
    expect(validTimeOfDayMinutes(-1)).toBe(false);
    expect(validTimeOfDayMinutes(1440)).toBe(false);
  });

  test('rejects a non-integer', () => {
    expect(validTimeOfDayMinutes(90.5)).toBe(false);
  });
});

describe('clampTimeOfDay', () => {
  test('a plain hour/minute pair', () => {
    expect(clampTimeOfDay(19, 0)).toBe(19 * 60);
  });

  test('wraps a negative hour forward, like the stepper’s decrement past midnight', () => {
    expect(clampTimeOfDay(-1, 0)).toBe(23 * 60);
  });

  test('wraps hour 24 back to 0', () => {
    expect(clampTimeOfDay(24, 0)).toBe(0);
  });

  test('wraps a negative minute back into the previous hour’s worth of minutes', () => {
    expect(clampTimeOfDay(5, -5)).toBe(5 * 60 + 55);
  });
});
