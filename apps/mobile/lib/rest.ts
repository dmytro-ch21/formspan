import type { Exercise } from './exercises';

/**
 * Rest defaults, in seconds, by movement pattern.
 *
 * One number for everything would be wrong in both directions: three minutes
 * between lateral raises is standing around, and sixty seconds between heavy
 * squats isn't rest. Scaled to how much the movement actually costs you —
 * the same coarse `movement_pattern` the progression increments key off, so
 * there's one vocabulary doing both jobs rather than two.
 *
 * These are defaults, not prescriptions: the bar has ±15s and the number is
 * always visible, because the person resting knows better than the table.
 */
const REST_BY_PATTERN: Record<string, number> = {
  squat: 180,
  hinge: 180,
  olympic: 180,

  horizontal_push: 120,
  vertical_push: 120,
  horizontal_pull: 120,
  vertical_pull: 120,
  lunge: 120,
};

/** Isolation, core, rotation, and anything unmapped. */
const DEFAULT_REST = 60;

export function restSecondsFor(exercise: Exercise | undefined): number {
  if (!exercise) return DEFAULT_REST;
  // Conditioning and mobility aren't strength sets; a long prescribed rest
  // there is just the app being wrong out loud.
  if (exercise.load_type === 'distance_time' || exercise.load_type === 'time') {
    return DEFAULT_REST;
  }
  return REST_BY_PATTERN[exercise.movement_pattern] ?? DEFAULT_REST;
}

/** m:ss, and never a negative sign — an overrun reads as 0:00. */
export function formatRest(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  const mins = Math.floor(s / 60);
  const secs = s % 60;
  return `${mins}:${secs.toString().padStart(2, '0')}`;
}
