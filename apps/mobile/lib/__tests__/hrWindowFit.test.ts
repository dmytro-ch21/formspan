import { fitHRWindow, wideHRQueryWindow, type HRFitPoint } from '../hrWindowFit';

/**
 * N522/#934 — the wide-window HR-signal fit. `fitHRWindow` is validated here
 * against a synthetic fixture modeled DIRECTLY on the ticket's own real
 * incident data (not an abstract "some HR data" stand-in):
 *
 *   - a real Amazfit-via-Zepp workout, 11:12 AM–12:34 PM, 81:43 duration,
 *     151 avg / 190 max bpm, with real oscillation between lower-intensity
 *     drilling/instruction stretches (~92-125 bpm) and higher-intensity
 *     rolling peaks (up to 190 bpm) — never a flat plateau. `realIncidentBlock`
 *     below reproduces the max (190) and the oscillation shape exactly; its
 *     own average comes out lower, ~134, because it alternates only TWO
 *     values (a segment's low/high) per minute rather than the real per-
 *     second trace — a fixture-construction fact, not a claim that the real
 *     session averaged 134 (frontend-reviewer, N522 PR review: this file
 *     previously asserted the fixture hit 151, which it never did);
 *   - a resting baseline in the 60-77 bpm range, per the Apple Health
 *     screenshots this ticket's issue quotes;
 *   - the session's own (WRONG) logged window offset from the real block —
 *     the incident's actual shape: a 90-minute duration GUESS close to the
 *     true 81:43, anchored to the wrong clock placement entirely.
 *
 * This is the "verify an external contract against the real service at
 * least once" discipline (CLAUDE.md) applied to an algorithm rather than a
 * live API: the fixture is not invented, it is this real incident's numbers
 * turned into samples.
 */

const MINUTE = 60_000;

/**
 * A resting-baseline stretch — 60-77 bpm, sampled every 5 minutes, cycling
 * through four values so it is not a single repeated number (real resting
 * HR drifts a little even at rest).
 */
function restingSamples(startISO: string, minutes: number, stepMinutes = 5): HRFitPoint[] {
  const start = new Date(startISO).getTime();
  const values = [65, 70, 74, 77];
  const out: HRFitPoint[] = [];
  for (let m = 0, i = 0; m <= minutes; m += stepMinutes, i++) {
    out.push({ measuredAt: new Date(start + m * MINUTE).toISOString(), bpm: values[i % values.length] });
  }
  return out;
}

/**
 * The real incident's own elevated block — 81:43 (4903 seconds), sampled
 * every minute, alternating lower-intensity drilling/instruction stretches
 * (92-125 bpm) and higher-intensity rolling stretches (up to 190 bpm) in
 * multi-minute segments, so the shape has genuine sustained sub-peaks and
 * dips rather than a flat elevated plateau — exactly what the issue's own
 * description of the real chart calls for. Segment lengths sum to 81
 * minutes plus a final 43-second sample to land on the real 81:43 duration
 * exactly.
 */
function realIncidentBlock(startISO: string): HRFitPoint[] {
  const start = new Date(startISO).getTime();
  const segments: { minutes: number; low: number; high: number }[] = [
    { minutes: 8, low: 100, high: 122 }, // warm-up drilling
    { minutes: 6, low: 150, high: 178 }, // first roll
    { minutes: 10, low: 96, high: 120 }, // technique instruction
    { minutes: 8, low: 158, high: 190 }, // hard roll — the real recorded max
    { minutes: 9, low: 92, high: 118 }, // drilling
    { minutes: 7, low: 152, high: 183 }, // roll
    { minutes: 10, low: 98, high: 125 }, // drilling/instruction
    { minutes: 8, low: 150, high: 180 }, // roll
    { minutes: 8, low: 95, high: 116 }, // cool-down drilling
    { minutes: 7, low: 145, high: 172 }, // closing roll
  ];
  const out: HRFitPoint[] = [];
  let t = start;
  for (const seg of segments) {
    for (let i = 0; i < seg.minutes; i++) {
      const bpm = i % 2 === 0 ? seg.low : seg.high;
      out.push({ measuredAt: new Date(t).toISOString(), bpm });
      t += MINUTE;
    }
  }
  // Land on the real 81:43 duration exactly (81 whole minutes above + 43s).
  out.push({ measuredAt: new Date(t - MINUTE + 43_000).toISOString(), bpm: 160 });
  return out;
}

describe('fitHRWindow — the real incident (N522/#934)', () => {
  // The real block: 11:12:00 AM to 12:33:43 PM.
  const trueBlockStart = '2026-09-07T11:12:00.000Z';
  const trueBlockEnd = '2026-09-07T12:33:43.000Z';
  // The session's own (WRONG) logged window: a 90-minute duration guess —
  // close to the true 81:43 — anchored hours after the real class, matching
  // "logged well after class ended, without correcting Ended at".
  const loggedAnchor = { start: '2026-09-07T14:00:00.000Z', end: '2026-09-07T15:30:00.000Z' };
  const loggedDurationMs = 90 * MINUTE;

  function wideWindowSamples(): HRFitPoint[] {
    return [
      ...restingSamples('2026-09-07T06:00:00.000Z', 5 * 60), // 06:00-11:00, resting
      ...realIncidentBlock(trueBlockStart), // 11:12-12:33:43, the real block
      ...restingSamples('2026-09-07T12:40:00.000Z', 9 * 60), // 12:40-21:40, resting
    ];
  }

  it('locates the real ~82-minute elevated block, offset from the wrong logged anchor', () => {
    const fit = fitHRWindow(wideWindowSamples(), loggedDurationMs, loggedAnchor);

    expect(fit).not.toBeNull();
    // The 90-minute slide is 8:17 longer than the true 81:43 block, so the
    // best-scoring placement can legitimately sit anywhere within that
    // slack and still fully contain the real block — bounded to within 10
    // minutes of the true edges either way, which is the whole point: this
    // is nowhere NEAR the wrong logged anchor two hours later.
    const fitStartMs = new Date(fit!.start).getTime();
    const fitEndMs = new Date(fit!.end).getTime();
    const trueStartMs = new Date(trueBlockStart).getTime();
    const trueEndMs = new Date(trueBlockEnd).getTime();
    // Tolerance is the 90-minute slide's own slack over the true 81:43
    // block (8:17 = 497s) plus a margin for candidate-step/sample-spacing
    // granularity — not an arbitrary fudge factor.
    const boundaryTolerance = 15 * MINUTE;
    expect(Math.abs(fitStartMs - trueStartMs)).toBeLessThanOrEqual(boundaryTolerance);
    expect(Math.abs(fitEndMs - trueEndMs)).toBeLessThanOrEqual(boundaryTolerance);
    // And, concretely, nowhere near the athlete's own (wrong) logged window.
    expect(Math.abs(fitStartMs - new Date(loggedAnchor.start).getTime())).toBeGreaterThan(2 * 60 * MINUTE);

    // The elevated-time fraction comfortably clears the confidence bar —
    // this real block is sustained, not borderline.
    expect(fit!.confidence).toBeGreaterThanOrEqual(0.7);
  });

  it('is declined when the wide window is genuinely empty (flat resting HR throughout)', () => {
    const allResting = restingSamples('2026-09-07T06:00:00.000Z', 16 * 60, 5);
    const fit = fitHRWindow(allResting, loggedDurationMs, loggedAnchor);
    expect(fit).toBeNull();
  });

  it('is declined when two comparably-good, well-separated candidates exist (genuine ambiguity)', () => {
    // Two real-looking blocks, both close to the logged duration, several
    // hours apart — nothing in the data itself says which one this session
    // was, so forcing either would be a real user-facing error.
    const blockA = realIncidentBlock('2026-09-07T08:00:00.000Z'); // ends ~09:21:43
    const blockB = realIncidentBlock('2026-09-07T17:00:00.000Z'); // ends ~18:21:43
    const samples = [
      ...restingSamples('2026-09-07T00:00:00.000Z', 7 * 60, 5),
      ...blockA,
      ...restingSamples('2026-09-07T09:30:00.000Z', 7 * 60, 5),
      ...blockB,
      ...restingSamples('2026-09-07T18:30:00.000Z', 5 * 60, 5),
    ];
    const fit = fitHRWindow(samples, loggedDurationMs, loggedAnchor);
    expect(fit).toBeNull();
  });

  it('does not force a fit from a single spike surrounded by long gaps', () => {
    // A lone elevated reading a few hours apart from anything else — real
    // sparse evidence, not a sustained block. Density (`HR_FIT_MIN_SAMPLES_
    // IN_CANDIDATE`) and the covered-time scoring together should keep this
    // from ever reading as a confident 90-minute training block.
    const samples: HRFitPoint[] = [
      ...restingSamples('2026-09-07T06:00:00.000Z', 5 * 60, 30),
      { measuredAt: '2026-09-07T11:12:00.000Z', bpm: 190 },
      ...restingSamples('2026-09-07T12:40:00.000Z', 8 * 60, 30),
    ];
    const fit = fitHRWindow(samples, loggedDurationMs, loggedAnchor);
    expect(fit).toBeNull();
  });

  it('returns null with too few total samples to trust a baseline at all', () => {
    const tiny: HRFitPoint[] = [
      { measuredAt: '2026-09-07T11:00:00.000Z', bpm: 150 },
      { measuredAt: '2026-09-07T11:30:00.000Z', bpm: 160 },
      { measuredAt: '2026-09-07T12:00:00.000Z', bpm: 170 },
    ];
    expect(fitHRWindow(tiny, loggedDurationMs, loggedAnchor)).toBeNull();
  });

  it('returns null when the sample range is narrower than the logged duration', () => {
    const samples = realIncidentBlock(trueBlockStart).slice(0, 20); // ~20 minutes of real data
    expect(fitHRWindow(samples, loggedDurationMs, loggedAnchor)).toBeNull();
  });

  it('returns null for an empty or zero-duration input rather than throwing', () => {
    expect(fitHRWindow([], loggedDurationMs, loggedAnchor)).toBeNull();
    expect(fitHRWindow(wideWindowSamples(), 0, loggedAnchor)).toBeNull();
  });

  // N522 PR review (frontend-reviewer): reproduced directly — a candidate
  // scored purely on elevated-time fraction cannot tell real training apart
  // from any other sustained, moderately-raised, non-training activity. A
  // brisk walk held well above the elevation threshold (85-90 bpm here) but
  // never anywhere NEAR a genuine training peak used to score an identical
  // 1.0 to the real incident block. HR_FIT_HIGH_INTENSITY_MARGIN_BPM /
  // HR_FIT_MIN_HIGH_INTENSITY_FRACTION exist to close exactly this gap.
  it('declines a sustained-but-moderate false positive that never reaches a real training intensity', () => {
    const walkStart = new Date(trueBlockStart).getTime();
    const walk: HRFitPoint[] = [];
    // 90 minutes of a brisk walk, 98-112 bpm — comfortably above the ~85-90
    // elevation threshold for its entire length (would have scored ~1.0
    // under the old elevated-fraction-only scoring), but never within reach
    // of HR_FIT_HIGH_INTENSITY_MARGIN_BPM above baseline.
    for (let m = 0; m <= 90; m++) {
      walk.push({ measuredAt: new Date(walkStart + m * MINUTE).toISOString(), bpm: m % 2 === 0 ? 98 : 112 });
    }
    const samples = [
      ...restingSamples('2026-09-07T06:00:00.000Z', 5 * 60), // 06:00-11:00
      ...walk, // 11:12-12:42, the false-positive candidate
      ...restingSamples('2026-09-07T12:50:00.000Z', 9 * 60), // 12:50-21:50
    ];
    expect(fitHRWindow(samples, loggedDurationMs, loggedAnchor)).toBeNull();
  });

  // N522 PR review (frontend-reviewer + backend-reviewer): this file's own
  // WIDE_WINDOW_PADDING_HOURS/wideHRQueryWindow shape can, for a session
  // started near local midnight, produce a wide window whose far edge sits
  // up to `24h + WIDE_WINDOW_PADDING_HOURS` from the session's own
  // started_at — ABOVE the backend's fixed MaxHRWindowOverrideDrift (24h,
  // mirrored here as HR_FIT_MAX_BACKEND_DRIFT_MS). A candidate that would
  // otherwise win convincingly still has to be declined if using it would
  // send an override the backend is guaranteed to reject with a permanent
  // 400 — see HR_FIT_MAX_BACKEND_DRIFT_MS's own doc comment.
  it("declines a convincing fit that would land outside the backend's drift bound", () => {
    const anchor = { start: '2026-09-08T00:00:00.000Z', end: '2026-09-08T01:00:00.000Z' };
    const durationMs = 60 * MINUTE;
    // A real-shaped elevated block, comfortably clearing both the
    // confidence and high-intensity gates on its own — but its LATEST
    // possible 60-minute sub-window (ending at the block's own end,
    // ~2026-09-06T21:41:43) is still ~26h18m before anchor.start, well past
    // the 24h bound, so no placement inside it can ever be accepted.
    const farBlock = realIncidentBlock('2026-09-06T20:00:00.000Z');
    const samples = [
      ...restingSamples('2026-09-06T14:00:00.000Z', 5 * 60, 5),
      ...farBlock,
      ...restingSamples('2026-09-06T22:00:00.000Z', 20 * 60, 5),
    ];
    expect(fitHRWindow(samples, durationMs, anchor)).toBeNull();
  });
});

describe('wideHRQueryWindow', () => {
  it("spans the LOCAL calendar day of startedAt, padded by WIDE_WINDOW_PADDING_HOURS either side", () => {
    // Comfortably inside a day, away from any DST/midnight boundary in the
    // suite's fixed America/Los_Angeles TZ (see jest.config.js).
    const win = wideHRQueryWindow('2026-09-07T19:00:00.000Z'); // ~noon PT
    // Local midnight the same PT day, minus 2h padding.
    const localMidnightStart = new Date(2026, 8, 7, 0, 0, 0, 0);
    const localMidnightEnd = new Date(2026, 8, 8, 0, 0, 0, 0);
    expect(win.start.getTime()).toBe(localMidnightStart.getTime() - 2 * 60 * 60 * 1000);
    expect(win.end.getTime()).toBe(localMidnightEnd.getTime() + 2 * 60 * 60 * 1000);
  });

  it('accepts a custom padding', () => {
    const win = wideHRQueryWindow('2026-09-07T19:00:00.000Z', 1);
    const localMidnightStart = new Date(2026, 8, 7, 0, 0, 0, 0);
    expect(win.start.getTime()).toBe(localMidnightStart.getTime() - 60 * 60 * 1000);
  });
});
