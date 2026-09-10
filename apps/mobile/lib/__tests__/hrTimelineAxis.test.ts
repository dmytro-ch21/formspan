import type { HRTimelinePoint } from '@/lib/hrTimeline';
import {
  BPM_TICK_STEPS,
  DEFAULT_PLOT_WIDTH,
  END_TICK_MIN_GAP_FRACTION,
  MAX_BPM_TICKS,
  MAX_TIME_TICKS,
  MIN_BPM_SPAN,
  PEAK_LABEL_END_FRACTION,
  PEAK_LABEL_START_FRACTION,
  TICK_CHAR_WIDTH,
  TICK_MIN_GAP,
  PEAK_LABEL_CHAR_WIDTH,
  chooseBpmAxis,
  chooseTimeTicks,
  clampLabelX,
  findTimelinePeak,
  formatElapsed,
  peakLabel,
  peakLabelAnchor,
  timelineAccessibilityLabel,
  timelineCaption,
  zoneRuns,
} from '@/lib/hrTimelineAxis';

/**
 * N545/#988 — the session HR chart's arithmetic, apart from its rendering.
 *
 * Every fixture below is a LITERAL, never derived from the constant it is
 * checking. W19/#985's own history entry records why: its first coverage
 * tests derived their fixtures from the thresholds under test, so all three
 * constants survived mutation in both directions at a green 166/166. A test
 * that computes its expectation from the value it is pinning cannot fail
 * when that value moves.
 */

function point(minutesElapsed: number, bpm: number): HRTimelinePoint {
  return { minutesElapsed, bpm };
}

describe('formatElapsed', () => {
  test('under an hour reads in whole minutes', () => {
    expect(formatElapsed(0)).toBe('0m');
    expect(formatElapsed(21)).toBe('21m');
    expect(formatElapsed(59.4)).toBe('59m');
  });

  test('an exact hour drops the minutes rather than reading "1h 0m"', () => {
    expect(formatElapsed(60)).toBe('1h');
    expect(formatElapsed(120)).toBe('2h');
  });

  test('past the hour carries both parts', () => {
    expect(formatElapsed(87.72)).toBe('1h 28m');
    expect(formatElapsed(65)).toBe('1h 5m');
  });

  test('a negative or nonsense duration floors at zero rather than reading "-3m"', () => {
    expect(formatElapsed(-3)).toBe('0m');
  });
});

describe('chooseTimeTicks — a 20-minute session', () => {
  const ticks = chooseTimeTicks(20);

  test('carries five readable ticks at five-minute spacing', () => {
    expect(ticks.map((t) => t.label)).toEqual(['0m', '5m', '10m', '15m', '20m']);
  });

  test('starts at zero and ends at the session’s real end', () => {
    expect(ticks[0].minutesElapsed).toBe(0);
    expect(ticks[ticks.length - 1].minutesElapsed).toBe(20);
  });
});

describe('chooseTimeTicks — a two-hour session', () => {
  const ticks = chooseTimeTicks(120);

  test('stays at five ticks by widening the spacing to half an hour', () => {
    expect(ticks.map((t) => t.label)).toEqual(['0m', '30m', '1h', '1h 30m', '2h']);
  });
});

describe('chooseTimeTicks — the end is always labelled', () => {
  test('a session ending between multiples still names its own end', () => {
    // 87.72 minutes — Zepp's own 01:27:43 comparison class. Twenty-minute
    // spacing gets four multiples (0/20/40/60); 80 is 7.72 from the end,
    // inside half an interval, so it goes and the real end stays.
    const ticks = chooseTimeTicks(87.72);
    expect(ticks.map((t) => t.label)).toEqual(['0m', '20m', '40m', '1h', '1h 28m']);
    expect(ticks[ticks.length - 1].minutesElapsed).toBeCloseTo(87.72, 5);
  });

  test('a multiple landing almost on the end is dropped, not drawn on top of it', () => {
    // 62 minutes at a 15-minute spacing: 60 is 2 minutes from the end, well
    // inside half an interval, so 60 goes and 1h 2m stays.
    const ticks = chooseTimeTicks(62);
    expect(ticks.map((t) => t.label)).toEqual(['0m', '15m', '30m', '45m', '1h 2m']);
  });

  test('a multiple comfortably clear of the end is kept', () => {
    // 75 minutes at a 20-minute spacing: the end is 15 minutes past 60,
    // comfortably outside half an interval, so 1h survives beside it.
    const ticks = chooseTimeTicks(75);
    expect(ticks.map((t) => t.label)).toEqual(['0m', '20m', '40m', '1h', '1h 15m']);
  });
});

describe('chooseTimeTicks — the two constraints, each on its own', () => {
  test('never exceeds the tick cap, at any duration', () => {
    for (const minutes of [1, 5, 12, 20, 33, 45, 62, 75, 90, 120, 155, 240, 480]) {
      expect(chooseTimeTicks(minutes).length).toBeLessThanOrEqual(MAX_TIME_TICKS);
    }
  });

  test('the COUNT cap is what stops a short session ticking every minute', () => {
    // Ten one-minute labels genuinely FIT the plot's width — this is the
    // case the width check alone would wave through, and it is unreadable.
    const perMinute = ['0m', '1m', '2m', '3m', '4m', '5m', '6m', '7m', '8m', '9m'];
    const width = perMinute.reduce((sum, l) => sum + l.length * TICK_CHAR_WIDTH + TICK_MIN_GAP, 0);
    expect(width).toBeLessThanOrEqual(DEFAULT_PLOT_WIDTH);
    expect(chooseTimeTicks(9).map((t) => t.label)).toEqual(['0m', '5m', '9m']);
  });

  test('the WIDTH check is what stops five wide labels crowding a narrow plot', () => {
    // Same two-hour session, on a plot half as wide: five labels no longer
    // fit, so the axis goes sparser rather than overlapping.
    const wide = chooseTimeTicks(120, DEFAULT_PLOT_WIDTH);
    const narrow = chooseTimeTicks(120, 90);
    expect(wide).toHaveLength(5);
    expect(narrow.length).toBeLessThan(wide.length);
    expect(narrow[narrow.length - 1].label).toBe('2h');
  });

  test('an impossible plot still names both ends of the session', () => {
    const ticks = chooseTimeTicks(120, 1);
    expect(ticks.map((t) => t.label)).toEqual(['0m', '2h']);
  });

  test('a zero-length or nonsense duration yields a single origin tick, not a crash', () => {
    expect(chooseTimeTicks(0).map((t) => t.label)).toEqual(['0m']);
    expect(chooseTimeTicks(Number.NaN).map((t) => t.label)).toEqual(['0m']);
  });
});

describe('chooseBpmAxis', () => {
  test('rounds out to values an athlete can read a number off', () => {
    // The ticket's own comparison: a class running 104 avg to 185 max.
    const axis = chooseBpmAxis([104, 130, 185, 150]);
    expect(axis.min).toBe(100);
    expect(axis.max).toBe(200);
    expect(axis.ticks).toEqual([100, 125, 150, 175, 200]);
  });

  test('a typical BJJ range gets a twenty-beat ladder', () => {
    const axis = chooseBpmAxis([120, 145, 170]);
    expect(axis.ticks).toEqual([120, 140, 160, 180]);
  });

  test('the domain always contains every value it was given', () => {
    const values = [98, 143, 187];
    const axis = chooseBpmAxis(values);
    for (const v of values) {
      expect(axis.min).toBeLessThanOrEqual(v);
      expect(axis.max).toBeGreaterThanOrEqual(v);
    }
  });

  test('never more ticks than the ladder cap', () => {
    for (const hi of [95, 130, 166, 187, 205, 220]) {
      expect(chooseBpmAxis([60, hi]).ticks.length).toBeLessThanOrEqual(MAX_BPM_TICKS);
    }
  });

  test('a flat line is given a span rather than dividing by zero', () => {
    const axis = chooseBpmAxis([150, 150]);
    expect(axis.max - axis.min).toBeGreaterThanOrEqual(MIN_BPM_SPAN);
    expect(axis.ticks).toEqual([145, 150, 155]);
  });

  test('a nearly flat line is widened too — 150 to 152 is not an axis', () => {
    const axis = chooseBpmAxis([150, 152]);
    expect(axis.max - axis.min).toBeGreaterThanOrEqual(MIN_BPM_SPAN);
  });

  test('the first and last ticks ARE the domain, so the top gridline is labelled', () => {
    const axis = chooseBpmAxis([104, 185]);
    expect(axis.ticks[0]).toBe(axis.min);
    expect(axis.ticks[axis.ticks.length - 1]).toBe(axis.max);
  });

  test('every tick is a multiple of one of the declared steps', () => {
    const axis = chooseBpmAxis([104, 185]);
    const step = axis.ticks[1] - axis.ticks[0];
    expect(BPM_TICK_STEPS).toContain(step as (typeof BPM_TICK_STEPS)[number]);
  });

  test('no finite values at all yields a drawable axis rather than NaN', () => {
    const axis = chooseBpmAxis([Number.NaN]);
    expect(Number.isFinite(axis.min)).toBe(true);
    expect(axis.max).toBeGreaterThan(axis.min);
  });
});

describe('findTimelinePeak', () => {
  test('finds the highest reading and when it happened', () => {
    const peak = findTimelinePeak([point(0, 110), point(12, 148), point(47, 185), point(60, 132)]);
    expect(peak).toEqual({ minutesElapsed: 47, bpm: 185, index: 2 });
  });

  test('the EARLIEST of two equal maxima wins — "when did it first get that hard"', () => {
    const peak = findTimelinePeak([point(0, 100), point(10, 180), point(40, 180)]);
    expect(peak?.minutesElapsed).toBe(10);
    expect(peak?.index).toBe(1);
  });

  test('a peak in the first minute is still a peak', () => {
    const peak = findTimelinePeak([point(0.4, 178), point(30, 120)]);
    expect(peak?.index).toBe(0);
  });

  test('a non-finite reading is skipped rather than becoming the peak', () => {
    const peak = findTimelinePeak([point(0, 120), point(5, Number.NaN), point(9, 140)]);
    expect(peak?.bpm).toBe(140);
  });

  test('no points at all is null, not a crash', () => {
    expect(findTimelinePeak([])).toBeNull();
  });
});

describe('peakLabel', () => {
  test('carries the beats AND the time, which is the whole ticket', () => {
    expect(peakLabel({ minutesElapsed: 47, bpm: 185, index: 2 })).toBe('185 bpm at 47m');
  });

  test('a peak past the hour reads in hours', () => {
    expect(peakLabel({ minutesElapsed: 74.6, bpm: 171.4, index: 9 })).toBe('171 bpm at 1h 15m');
  });
});

describe('peakLabelAnchor', () => {
  test('a peak near the left edge hangs right, so its label stays on the card', () => {
    expect(peakLabelAnchor(0)).toBe('start');
    expect(peakLabelAnchor(0.05)).toBe('start');
  });

  test('a peak near the right edge hangs left', () => {
    expect(peakLabelAnchor(1)).toBe('end');
    expect(peakLabelAnchor(0.93)).toBe('end');
  });

  test('a peak in the body of the chart is centred on its marker', () => {
    expect(peakLabelAnchor(0.5)).toBe('middle');
    expect(peakLabelAnchor(0.25)).toBe('middle');
    expect(peakLabelAnchor(0.75)).toBe('middle');
  });

  test('the thresholds themselves are inclusive of the middle', () => {
    // Written as literals against the declared fractions: exactly ON a
    // threshold is the middle, only strictly past it flips.
    expect(PEAK_LABEL_START_FRACTION).toBe(0.2);
    expect(PEAK_LABEL_END_FRACTION).toBe(0.8);
    expect(peakLabelAnchor(0.2)).toBe('middle');
    expect(peakLabelAnchor(0.8)).toBe('middle');
    expect(peakLabelAnchor(0.19)).toBe('start');
    expect(peakLabelAnchor(0.81)).toBe('end');
  });

  test('a nonsense fraction is centred rather than throwing', () => {
    expect(peakLabelAnchor(Number.NaN)).toBe('middle');
  });
});

describe('clampLabelX', () => {
  // 300-wide canvas with a 2-unit margin, matching HRTimelineChart's own.
  const MIN = 2;
  const MAX = 298;
  const LONG = '220 bpm at 2h 10m'; // 17 characters

  test('a label with room to spare is left exactly where the anchor put it', () => {
    expect(clampLabelX(150, 'middle', LONG, MIN, MAX)).toBe(150);
  });

  test('a middle-anchored label near the right edge is pulled back inside', () => {
    // 17 chars at 6.2 = 105.4 wide; centred on 290 it would end at 342.7.
    const x = clampLabelX(290, 'middle', LONG, MIN, MAX);
    expect(x).toBeLessThan(290);
    expect(x + 105.4 / 2).toBeCloseTo(MAX, 6);
  });

  test('a middle-anchored label near the left edge is pushed back inside', () => {
    const x = clampLabelX(10, 'middle', LONG, MIN, MAX);
    expect(x).toBeGreaterThan(10);
    expect(x - 105.4 / 2).toBeCloseTo(MIN, 6);
  });

  test('an end-anchored label whose text runs off the left is pushed right', () => {
    const x = clampLabelX(40, 'end', LONG, MIN, MAX);
    expect(x - 105.4).toBeCloseTo(MIN, 6);
  });

  test('a start-anchored label whose text runs off the right is pulled left', () => {
    const x = clampLabelX(260, 'start', LONG, MIN, MAX);
    expect(x + 105.4).toBeCloseTo(MAX, 6);
  });

  test('a label wider than the whole canvas is pinned to the LEFT edge, not the right', () => {
    // Text is read from its start: overflowing the right is still partly
    // useful, overflowing the left is not.
    const enormous = 'x'.repeat(80);
    const x = clampLabelX(150, 'start', enormous, MIN, MAX);
    expect(x).toBeCloseTo(MIN, 6);
  });

  test('the character-width estimate is the value this behaviour was measured against', () => {
    expect(PEAK_LABEL_CHAR_WIDTH).toBe(6.2);
  });
});

describe('zoneRuns', () => {
  // HRmax 200, so the floors land on round numbers: z1 100, z2 120, z3 140,
  // z4 160, z5 180 — written out rather than derived from ZONE_FLOORS.
  const HR_MAX = 200;

  test('splits the line where the zone changes', () => {
    const runs = zoneRuns([point(0, 125), point(5, 130), point(10, 165), point(15, 185)], HR_MAX);
    expect(runs.map((r) => r.zone)).toEqual([2, 4]);
  });

  test('adjacent runs share their boundary point, so the line has no gap', () => {
    const runs = zoneRuns([point(0, 125), point(5, 130), point(10, 165), point(15, 185)], HR_MAX);
    expect(runs[0].points[runs[0].points.length - 1]).toEqual(runs[1].points[0]);
  });

  test('every drawn segment survives the split — no point is lost', () => {
    const points = [point(0, 125), point(5, 130), point(10, 165), point(15, 185), point(20, 110)];
    const runs = zoneRuns(points, HR_MAX);
    const segments = runs.reduce((sum, r) => sum + r.points.length - 1, 0);
    expect(segments).toBe(points.length - 1);
  });

  test('a segment takes the zone of the reading it STARTS from — the backend’s own attribution', () => {
    // 130 is zone 2, 165 is zone 4. The segment between them is zone 2,
    // matching trimp.go's ZoneBreakdown, which attributes the minutes
    // between two samples to the first one's zone.
    const runs = zoneRuns([point(0, 130), point(5, 165)], HR_MAX);
    expect(runs).toHaveLength(1);
    expect(runs[0].zone).toBe(2);
  });

  test('a flat session in one zone is one run', () => {
    const runs = zoneRuns([point(0, 145), point(5, 148), point(10, 152)], HR_MAX);
    expect(runs).toHaveLength(1);
    expect(runs[0].zone).toBe(3);
  });

  test('no HRmax means no zone claimed — one run at zone 0, not a fabricated zone 1', () => {
    const runs = zoneRuns([point(0, 125), point(5, 185)], null);
    expect(runs).toHaveLength(1);
    expect(runs[0].zone).toBe(0);
  });

  test('below zone 1 is zone 0, which is not a zone', () => {
    const runs = zoneRuns([point(0, 80), point(5, 85)], HR_MAX);
    expect(runs[0].zone).toBe(0);
  });

  test('fewer than two points draws nothing', () => {
    expect(zoneRuns([point(0, 150)], HR_MAX)).toEqual([]);
    expect(zoneRuns([], HR_MAX)).toEqual([]);
  });
});

describe('timelineCaption', () => {
  test('the ordinary session says so plainly — 0m IS the start', () => {
    expect(timelineCaption(false, '6:00 PM')).toBe('Heart rate across the session');
  });

  test('a window that differs names the clock time 0m actually is', () => {
    expect(timelineCaption(true, '6:12 PM')).toBe(
      'Heart rate across the recording — 0m is 6:12 PM, when the readings start',
    );
  });

  test('a differing window with no clock time to name falls back rather than saying "0m is null"', () => {
    expect(timelineCaption(true, null)).toBe('Heart rate across the session');
  });
});

describe('timelineAccessibilityLabel', () => {
  test('carries the peak and its time, which is all a VoiceOver user gets', () => {
    const label = timelineAccessibilityLabel(
      { min: 100, max: 200, ticks: [100, 150, 200] },
      87.72,
      { minutesElapsed: 47, bpm: 185, index: 4 },
    );
    expect(label).toBe(
      'Heart rate across the session, 100 to 200 beats per minute over 1h 28m. Peaked at 185 bpm at 47m',
    );
  });

  test('no peak still describes the range rather than trailing off', () => {
    const label = timelineAccessibilityLabel({ min: 100, max: 150, ticks: [100, 125, 150] }, 20, null);
    expect(label).toBe('Heart rate across the session, 100 to 150 beats per minute over 20m');
  });
});

describe('the constants this file pins', () => {
  test('the declared values are the ones the behaviour above was measured against', () => {
    expect(MAX_TIME_TICKS).toBe(5);
    expect(MAX_BPM_TICKS).toBe(5);
    expect(MIN_BPM_SPAN).toBe(10);
    expect(END_TICK_MIN_GAP_FRACTION).toBe(0.5);
    expect(BPM_TICK_STEPS).toEqual([5, 10, 20, 25, 50]);
  });
});
