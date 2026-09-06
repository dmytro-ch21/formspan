import { localVolume, type LoggedSet } from '../sessions';
import {
  WARMUP_FATIGUE_PROMPT,
  detectWarmupFatigue,
  reclassifyWarmupAsWork,
  type WarmupSetEvidence,
  type WorkingTarget,
} from '../warmup';

/**
 * Mirrors `backend/internal/modules/session/warmup_test.go`'s
 * `DetectWarmupFatigue` coverage — the same scenario numbers, including
 * #753's own OHP report, so a drift between the Go and TS implementations
 * shows up as one side's suite failing rather than as silence. See
 * `lib/warmup.ts`'s own header comment for why the fatigue-detection logic
 * is deliberately duplicated (never the ramp generation itself).
 */

const set = (over: Partial<LoggedSet> = {}): LoggedSet => ({
  exercise_id: 'overhead-press',
  position: 0,
  set_type: 'working',
  reps: null,
  weight_kg: null,
  seconds: null,
  distance_m: null,
  rir: null,
  rpe: null,
  notes: '',
  completed: false,
  performed_at: null,
  ...over,
});

describe('detectWarmupFatigue', () => {
  const evidence = (over: Partial<WarmupSetEvidence>): WarmupSetEvidence => ({
    weightKg: 40,
    reps: 5,
    rir: 8,
    rpe: null,
    ...over,
  });
  const target: WorkingTarget = { weightKg: 100, reps: 8 };

  test('an ordinary light warm-up raises nothing', () => {
    expect(detectWarmupFatigue(evidence({ weightKg: 50, reps: 5, rir: 8 }), target)).toEqual([]);
  });

  test('trigger 1a: RPE >= 7 fires high_effort', () => {
    expect(
      detectWarmupFatigue(evidence({ weightKg: 40, reps: 5, rir: null, rpe: 7 }), target),
    ).toEqual(['high_effort']);
  });

  // Mutation-check: the guard is exercised by an input just below its own
  // threshold, not only by inputs that trip it — see this repo's own
  // "nine guards mutation tested, the tenth did not exist" lesson.
  test('RPE just below the threshold (6) does not fire high_effort', () => {
    const reasons = detectWarmupFatigue(
      evidence({ weightKg: 40, reps: 5, rir: null, rpe: 6 }),
      target,
    );
    expect(reasons).not.toContain('high_effort');
  });

  test('trigger 1b: low RIR fires high_effort', () => {
    expect(
      detectWarmupFatigue(evidence({ weightKg: 40, reps: 5, rir: 1, rpe: null }), target),
    ).toEqual(['high_effort']);
  });

  test('trigger 2: near-working-load with as many or more reps than target', () => {
    // 85kg is 85% of the 100kg target — near-working-load — for 10 reps
    // against an 8-rep target, left with reserve so high_effort stays quiet.
    expect(
      detectWarmupFatigue(evidence({ weightKg: 85, reps: 10, rir: 6, rpe: null }), target),
    ).toEqual(['near_working_load_high_reps']);
  });

  test('the same near-working load for FEWER reps than target does not fire', () => {
    const reasons = detectWarmupFatigue(
      evidence({ weightKg: 85, reps: 2, rir: 6, rpe: null }),
      target,
    );
    expect(reasons).toEqual([]);
  });

  test('trigger 3: moderate load at roughly double the working reps', () => {
    // 60kg is 60% of 100kg — moderate — for 16 reps against an 8-rep target.
    expect(
      detectWarmupFatigue(evidence({ weightKg: 60, reps: 16, rir: 6, rpe: null }), target),
    ).toEqual(['moderate_load_double_reps']);
  });

  test('moderate load at only 1.5x the working reps does not fire', () => {
    const reasons = detectWarmupFatigue(
      evidence({ weightKg: 60, reps: 12, rir: 6, rpe: null }),
      target,
    );
    expect(reasons).toEqual([]);
  });

  test('an unknown target (0/0) never runs the percent-based triggers, but effort still can', () => {
    const reasons = detectWarmupFatigue(
      evidence({ weightKg: 85, reps: 20, rir: null, rpe: 8 }),
      { weightKg: 0, reps: 0 },
    );
    expect(reasons).toEqual(['high_effort']);
  });

  test('multiple triggers can fire together', () => {
    const reasons = detectWarmupFatigue(
      evidence({ weightKg: 90, reps: 12, rir: null, rpe: 8 }),
      target,
    );
    expect(reasons.sort()).toEqual(['high_effort', 'near_working_load_high_reps'].sort());
  });

  // #753's own OHP scenario, verbatim: "flag 95x12@7 as potentially
  // fatiguing preparation" against a held 115kg/prescribed-reps target.
  test("#753's OHP scenario: 95x12@RPE7 against a 115kg target is flagged", () => {
    const reasons = detectWarmupFatigue(
      { weightKg: 95, reps: 12, rir: null, rpe: 7 },
      { weightKg: 115, reps: 8 },
    );
    expect(reasons).toContain('high_effort');
    expect(reasons).toContain('near_working_load_high_reps');
  });

  test('the prompt is the one fixed question regardless of how many triggers fire', () => {
    expect(WARMUP_FATIGUE_PROMPT).toBe('This warm-up may be training work. Count it as work?');
  });
});

describe('reclassifyWarmupAsWork', () => {
  test('changes only the targeted index, and only its set_type', () => {
    const sets: LoggedSet[] = [
      set({ set_type: 'warmup', reps: 12, weight_kg: 95, completed: true }),
      set({ set_type: 'working', reps: 6, weight_kg: 115, completed: true }),
    ];
    const next = reclassifyWarmupAsWork(sets, 0);
    expect(next[0].set_type).toBe('working');
    expect(next[0].reps).toBe(12);
    expect(next[0].weight_kg).toBe(95);
    expect(next[1]).toEqual(sets[1]);
    // The original array is untouched — a pure transform, not a mutation.
    expect(sets[0].set_type).toBe('warmup');
  });

  // Mutation check for the "not a constant" class of bug this repo's
  // testing discipline warns about: the SAME call on a different index must
  // change a DIFFERENT row.
  test('targets exactly the given index, not a hardcoded one', () => {
    const sets: LoggedSet[] = [
      set({ set_type: 'warmup', completed: true }),
      set({ set_type: 'warmup', completed: true }),
    ];
    const next = reclassifyWarmupAsWork(sets, 1);
    expect(next[0].set_type).toBe('warmup');
    expect(next[1].set_type).toBe('working');
  });
});

// The acceptance criterion made concrete: detecting a flag must never, by
// itself, change what localVolume reports. Only the explicit reclassify
// call (mirroring the athlete's own tap) moves a set's reps/tonnage across.
describe('advisory-only: detection never changes stored volume', () => {
  test('flagging a warm-up leaves it on the warm-up side until reclassified', () => {
    const sets: LoggedSet[] = [
      set({ set_type: 'warmup', reps: 12, weight_kg: 95, rpe: 7, completed: true }),
      set({ set_type: 'working', reps: 6, weight_kg: 115, completed: true }),
      set({ set_type: 'working', reps: 6, weight_kg: 115, completed: true }),
    ];

    const before = localVolume(sets);
    expect(before.warmup_sets).toBe(1);
    expect(before.warmup_reps).toBe(12);
    expect(before.warmup_tonnage_kg).toBe(12 * 95);
    expect(before.working_sets).toBe(2);
    expect(before.total_reps).toBe(12);

    // Merely detecting the flag (as the UI does on every tick) must change
    // nothing — it's a pure read.
    const flags = detectWarmupFatigue(
      { weightKg: 95, reps: 12, rir: null, rpe: 7 },
      { weightKg: 115, reps: 6 },
    );
    expect(flags.length).toBeGreaterThan(0);
    const afterDetection = localVolume(sets);
    expect(afterDetection).toEqual(before);

    // Only the explicit reclassify call moves it.
    const reclassified = localVolume(reclassifyWarmupAsWork(sets, 0));
    expect(reclassified.warmup_sets).toBe(0);
    expect(reclassified.working_sets).toBe(3);
    expect(reclassified.total_reps).toBe(24);
  });
});
