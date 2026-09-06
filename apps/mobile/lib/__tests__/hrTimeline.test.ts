import { buildHRTimeline, MAX_TIMELINE_POINTS, type RawHRReading } from '@/lib/hrTimeline';

/**
 * N491/#852 — `buildHRTimeline`'s own arithmetic. This proves the SHAPING is
 * correct (clipping, ordering, elapsed-minute math, downsampling); it says
 * nothing about whether a real BJJ session's HR actually looks like a step
 * change, which is exactly the "no real device data to validate against"
 * gap the ticket's history entry documents. These are software-correctness
 * tests on invented numbers, not a validated finding about real training.
 */

const START = '2026-09-01T18:00:00Z';
const END = '2026-09-01T19:00:00Z'; // a 60-minute window

function reading(minutesAfterStart: number, bpm: number): RawHRReading {
  const t = new Date(START).getTime() + minutesAfterStart * 60000;
  return { measured_at: new Date(t).toISOString(), value: bpm };
}

test('maps real samples to minutes-elapsed-since-start, in order', () => {
  const points = buildHRTimeline([reading(10, 120), reading(0, 90), reading(30, 150)], START, END);
  expect(points.map((p) => Math.round(p.minutesElapsed))).toEqual([0, 10, 30]);
  expect(points.map((p) => p.bpm)).toEqual([90, 120, 150]);
});

test('a sample outside the session window is dropped, not clamped', () => {
  const beforeStart = reading(-5, 200);
  const afterEnd = reading(65, 200);
  const inside = reading(20, 130);
  const points = buildHRTimeline([beforeStart, afterEnd, inside], START, END);
  expect(points).toHaveLength(1);
  expect(points[0].bpm).toBe(130);
});

test('a sample exactly on either boundary is kept — the window is inclusive', () => {
  const points = buildHRTimeline([reading(0, 100), reading(60, 140)], START, END);
  expect(points).toHaveLength(2);
});

test('an unparsable reading is skipped rather than producing NaN', () => {
  const points = buildHRTimeline(
    [{ measured_at: 'not-a-date', value: 100 }, reading(5, 110)],
    START,
    END,
  );
  expect(points).toHaveLength(1);
  expect(points[0].bpm).toBe(110);
});

test('a non-finite value is skipped rather than producing NaN', () => {
  const points = buildHRTimeline(
    [{ measured_at: reading(1, 0).measured_at, value: NaN }, reading(5, 110)],
    START,
    END,
  );
  expect(points).toHaveLength(1);
  expect(points[0].bpm).toBe(110);
});

test('no samples at all yields an empty timeline, not a crash', () => {
  expect(buildHRTimeline([], START, END)).toEqual([]);
});

test('an end time before the start time yields an empty timeline', () => {
  const points = buildHRTimeline([reading(5, 100)], END, START);
  expect(points).toEqual([]);
});

test('a malformed window timestamp yields an empty timeline', () => {
  expect(buildHRTimeline([reading(5, 100)], 'nope', END)).toEqual([]);
  expect(buildHRTimeline([reading(5, 100)], START, 'nope')).toEqual([]);
});

test('at or below the cap, every sample survives untouched', () => {
  const samples = Array.from({ length: MAX_TIMELINE_POINTS }, (_, i) => reading(i * 0.5, 100 + i));
  const points = buildHRTimeline(samples, START, END);
  expect(points).toHaveLength(MAX_TIMELINE_POINTS);
});

test('over the cap, points are averaged down to it rather than dropped by stride', () => {
  // Spaced to stay inside the 60-minute [START, END] window used everywhere
  // else in this file: 360 samples every 1/6 minute spans just under 60m.
  const samples = Array.from({ length: MAX_TIMELINE_POINTS * 3 }, (_, i) => reading(i / 6, 100 + (i % 7)));
  const points = buildHRTimeline(samples, START, END);
  expect(points.length).toBeLessThanOrEqual(MAX_TIMELINE_POINTS);
  // Timeline still spans roughly the same range — averaging, not truncating
  // the tail off.
  expect(points[0].minutesElapsed).toBeCloseTo(0, 0);
  expect(points[points.length - 1].minutesElapsed).toBeGreaterThan(50);
});

test('a real single-minute spike survives averaging as a visible bump, not disappearing', () => {
  // 300 one-second samples across 5 minutes, flat at 90 bpm except one real
  // minute-long spike to 170 — the shape this chart exists to make visible.
  const samples: RawHRReading[] = [];
  for (let sec = 0; sec < 300; sec++) {
    const minutes = sec / 60;
    const spiking = minutes >= 2 && minutes < 3;
    samples.push(reading(minutes, spiking ? 170 : 90));
  }
  const points = buildHRTimeline(samples, START, new Date(new Date(START).getTime() + 5 * 60000).toISOString());
  const peak = Math.max(...points.map((p) => p.bpm));
  expect(peak).toBeGreaterThan(120); // averaged, but the bump still reads as elevated
});
