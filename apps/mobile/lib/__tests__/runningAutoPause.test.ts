import {
  AUTO_PAUSE_HOLD_MS,
  AUTO_PAUSE_SPEED_THRESHOLD_MPS,
  deriveSpeedMps,
  initialAutoPauseState,
  nextAutoPauseState,
  type AutoPauseState,
} from '../runningAutoPause';

/**
 * N467/#777 — the auto-pause hysteresis, and the speed derivation that feeds
 * it, tested as pure functions against a fixture sequence of readings. No
 * SQLite, no location APIs, no React — see the file's own doc comment for why
 * this shape was chosen.
 */

const START = Date.parse('2026-01-01T08:00:00Z');

/** Runs a sequence of `{ atMs (offset from START), speedMps }` readings
 *  through the state machine in order, returning every non-null action along
 *  with the state it landed in. */
function run(
  readings: { atMs: number; speedMps: number | null }[],
): { atMs: number; action: 'pause' | 'resume' }[] {
  let state: AutoPauseState = initialAutoPauseState;
  const actions: { atMs: number; action: 'pause' | 'resume' }[] = [];
  for (const r of readings) {
    const result = nextAutoPauseState(state, r.speedMps, START + r.atMs);
    state = result.state;
    if (result.action) actions.push({ atMs: r.atMs, action: result.action });
  }
  return actions;
}

describe('nextAutoPauseState', () => {
  it('does nothing while speed stays above the threshold', () => {
    const actions = run([
      { atMs: 0, speedMps: 3.0 },
      { atMs: 3000, speedMps: 2.8 },
      { atMs: 6000, speedMps: 3.1 },
    ]);
    expect(actions).toEqual([]);
  });

  it('pauses once speed has been below threshold for the full hold time', () => {
    // Below threshold from t=0; readings every 3s (the live screen's own
    // sample interval). AUTO_PAUSE_HOLD_MS is exactly 12000ms, so the sample
    // AT t=12000 is the first where `now - belowSinceMs >= holdMs`.
    const actions = run([
      { atMs: 0, speedMps: 0.1 },
      { atMs: 3000, speedMps: 0.05 },
      { atMs: 6000, speedMps: 0.0 },
      { atMs: 9000, speedMps: 0.1 },
      { atMs: 12000, speedMps: 0.05 },
      { atMs: 15000, speedMps: 0.0 },
    ]);
    expect(actions).toEqual([{ atMs: 12000, action: 'pause' }]);
  });

  it('does NOT pause for an 8-second crosswalk stop — the ticket\'s own example', () => {
    // Stopped for 8s, then moving again — well under AUTO_PAUSE_HOLD_MS.
    const actions = run([
      { atMs: 0, speedMps: 2.5 },
      { atMs: 2000, speedMps: 0.1 }, // stops
      { atMs: 5000, speedMps: 0.0 },
      { atMs: 8000, speedMps: 0.0 },
      { atMs: 10000, speedMps: 2.6 }, // moving again — 8s stop, never paused
      { atMs: 13000, speedMps: 2.7 },
    ]);
    expect(actions).toEqual([]);
  });

  it('DOES pause for a 2-minute stop — the ticket\'s other example', () => {
    const readings = [{ atMs: 0, speedMps: 3.0 }];
    for (let t = 1000; t <= 120000; t += 3000) {
      readings.push({ atMs: t, speedMps: 0.0 });
    }
    const actions = run(readings);
    expect(actions.length).toBe(1);
    expect(actions[0].action).toBe('pause');
    // Fired once the hold elapsed, nowhere near waiting out the full 2 minutes.
    expect(actions[0].atMs).toBeLessThan(20000);
  });

  it('resumes immediately (no hold) once speed crosses back above threshold while auto-paused', () => {
    let state: AutoPauseState = initialAutoPauseState;
    // Drive it into the paused state first.
    for (let t = 0; t <= AUTO_PAUSE_HOLD_MS; t += 3000) {
      state = nextAutoPauseState(state, 0.0, START + t).state;
    }
    expect(state.autoPaused).toBe(true);

    const result = nextAutoPauseState(state, 2.0, START + AUTO_PAUSE_HOLD_MS + 3000);
    expect(result.action).toBe('resume');
    expect(result.state.autoPaused).toBe(false);
    expect(result.state.belowSinceMs).toBeNull();
  });

  it('never fires resume when not currently auto-paused', () => {
    const actions = run([
      { atMs: 0, speedMps: 0.1 },
      { atMs: 3000, speedMps: 2.0 }, // crosses back up before the hold elapses
    ]);
    expect(actions).toEqual([]);
  });

  it('a speed exactly AT the threshold counts as moving, not stopped', () => {
    const readings = [];
    for (let t = 0; t <= AUTO_PAUSE_HOLD_MS + 3000; t += 3000) {
      readings.push({ atMs: t, speedMps: AUTO_PAUSE_SPEED_THRESHOLD_MPS });
    }
    expect(run(readings)).toEqual([]);
  });

  it('a null (unknown) reading neither starts nor clears the below-threshold clock', () => {
    // Below threshold, one unreadable fix in the middle, still below after —
    // the clock must not have been reset by the unknown reading, so the
    // pause still fires at the same total elapsed time as if it had never
    // been unreadable.
    const withUnknown = run([
      { atMs: 0, speedMps: 0.1 },
      { atMs: 3000, speedMps: 0.05 },
      { atMs: 6000, speedMps: null }, // unreadable fix
      { atMs: 9000, speedMps: 0.05 },
      { atMs: 12000, speedMps: 0.05 },
      { atMs: 15000, speedMps: 0.05 },
    ]);
    expect(withUnknown).toEqual([{ atMs: 12000, action: 'pause' }]);
  });

  it('a run of unknown readings never itself triggers a pause while genuinely moving', () => {
    // Regression guard for a specific bug shape: JS coerces `null < threshold`
    // to `0 < threshold` (true), so a naive implementation that skipped the
    // "speedMps == null" early return would silently treat every unreadable
    // fix as "stopped" and could accumulate a hold purely from a run of bad
    // fixes, even though every KNOWN reading around them says moving.
    const readings: { atMs: number; speedMps: number | null }[] = [{ atMs: 0, speedMps: 3.0 }];
    for (let t = 1000; t <= AUTO_PAUSE_HOLD_MS + 5000; t += 1000) {
      readings.push({ atMs: t, speedMps: null });
    }
    readings.push({ atMs: AUTO_PAUSE_HOLD_MS + 6000, speedMps: 3.0 });
    expect(run(readings)).toEqual([]);
  });

  it('an unknown reading does not let a genuinely stopped runner dodge auto-pause', () => {
    // If null readings reset the clock, a stream of alternating null/low
    // fixes would never accumulate a hold and this test would see zero
    // actions. It must still pause.
    const readings: { atMs: number; speedMps: number | null }[] = [];
    for (let t = 0; t <= 15000; t += 3000) {
      readings.push({ atMs: t, speedMps: t === 6000 ? null : 0.0 });
    }
    const actions = run(readings);
    expect(actions.length).toBe(1);
    expect(actions[0].action).toBe('pause');
  });

  it('respects custom threshold/hold overrides', () => {
    let state: AutoPauseState = initialAutoPauseState;
    let action = null as null | 'pause' | 'resume';
    for (let t = 0; t <= 5000; t += 1000) {
      const result = nextAutoPauseState(state, 0.5, START + t, { thresholdMps: 1.0, holdMs: 4000 });
      state = result.state;
      if (result.action) action = result.action;
    }
    expect(action).toBe('pause');
  });
});

describe('deriveSpeedMps', () => {
  const p1 = { lat: 37.0, lng: -122.4, recorded_at: new Date(START).toISOString() };
  const p2 = { lat: 37.0009, lng: -122.4, recorded_at: new Date(START + 3000).toISOString() };

  it('prefers a valid native speed reading', () => {
    expect(deriveSpeedMps(2.5, p1, p2)).toBe(2.5);
  });

  it('treats a negative native reading (the iOS/Android "unknown" sentinel) as unusable', () => {
    // Falls back to distance/time between the two fixture points instead.
    const speed = deriveSpeedMps(-1, p1, p2);
    expect(speed).not.toBeNull();
    expect(speed).toBeGreaterThan(0);
  });

  it('treats null/undefined native speed as unusable and falls back', () => {
    expect(deriveSpeedMps(null, p1, p2)).not.toBeNull();
    expect(deriveSpeedMps(undefined, p1, p2)).not.toBeNull();
  });

  it('returns null when there is no previous fix to fall back on', () => {
    expect(deriveSpeedMps(null, null, p2)).toBeNull();
  });

  it('returns null for a non-positive time delta rather than dividing by zero', () => {
    const samePoint = { ...p1 };
    expect(deriveSpeedMps(null, p1, samePoint)).toBeNull();
    const earlier = { ...p2, recorded_at: new Date(START - 1000).toISOString() };
    expect(deriveSpeedMps(null, p1, earlier)).toBeNull();
  });

  it('the fallback matches distance/time exactly for a known segment', () => {
    // p1 -> p2 is ~0.0009 degrees of latitude over 3 seconds.
    const speed = deriveSpeedMps(null, p1, p2);
    // haversineMeters(p1, p2) / 3 — recomputed independently via the public
    // export rather than re-deriving the haversine formula here.
    const { haversineMeters } = jest.requireActual('../running');
    const expected = haversineMeters(p1, p2) / 3;
    expect(speed).toBeCloseTo(expected, 6);
  });
});
