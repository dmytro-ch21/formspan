import { haversineMeters, type RoutePoint } from './running';

/**
 * Auto-pause detection for a live-tracked run (L11/#777, the "auto-pause"
 * half of L11 — the cadence half was evaluated and deliberately deferred, see
 * `docs/decisions/history.md`'s entry for the reasoning).
 *
 * Pure hysteresis over a stream of per-fix speeds: no SQLite, no location
 * APIs, no React — the same shape as `running.ts`'s calculation functions,
 * and for the same reason, testable with a fixture sequence of readings and
 * nothing else running. `app/running/[id].tsx` is the only caller and owns
 * all the side effects (stopping the clock, calling `setStatus`, persisting
 * progress) — this module only ever answers "pause now", "resume now", or
 * "nothing yet".
 *
 * ## Threshold: 0.3 m/s
 *
 * A dead stop reads near 0 m/s even through ordinary GPS jitter, while the
 * slowest pace anyone would call "jogging" is still well clear of it — a
 * 12-minute mile (a genuinely slow jog) is ~2.2 m/s, a brisk walk is
 * ~1.4 m/s, and even ambling is ~0.8 m/s. 0.3 m/s (~1.1 km/h) sits below all
 * of those with room to spare, which is what the ticket's "tuned to avoid
 * false positives at slow jogging pace" criterion asks for — it cannot
 * mistake a slow jog, or even a slow walk, for a stop.
 *
 * ## Hold time: 12 seconds
 *
 * The ticket's own example is the tuning target: "a runner stopped at a
 * crosswalk for 8 seconds shouldn't have their run history fragmented into
 * confusing pause/resume noise, but someone who stops for 2 minutes
 * definitely should auto-pause." 12 seconds sits clear above the 8-second
 * crosswalk figure (a routine street-crossing pause, not a long light) while
 * still being a small fraction of a genuine 2-minute stop — so the crosswalk
 * case never fires and the real stop fires within the first 6% of its
 * duration. It also comfortably exceeds a red light at a quiet crossing,
 * which is normally a well-defined "cross now" signal rather than an
 * open-ended wait; a runner stopped at a full vehicular light more likely
 * reads as the "should auto-pause" case regardless. There is no live GPS
 * ground truth to measure this against in CI (a real device/outdoor run is
 * `NEEDS HUMAN EVIDENCE` — see the PR), so this is a considered choice
 * against the two examples the ticket itself gives, not a guess.
 */
export const AUTO_PAUSE_SPEED_THRESHOLD_MPS = 0.3;
export const AUTO_PAUSE_HOLD_MS = 12000;

export type AutoPauseState = {
  /** When the current unbroken stretch of below-threshold fixes started, or
   *  `null` if the most recent known-speed fix was at/above the threshold. */
  belowSinceMs: number | null;
  /** Whether THIS module currently believes the run is auto-paused. The
   *  caller is the source of truth for the screen's actual status — this
   *  mirrors it only so the state machine knows whether a fix crossing back
   *  above threshold is a "resume" edge or a no-op. */
  autoPaused: boolean;
};

export const initialAutoPauseState: AutoPauseState = { belowSinceMs: null, autoPaused: false };

export type AutoPauseAction = 'pause' | 'resume' | null;

export type AutoPauseResult = { state: AutoPauseState; action: AutoPauseAction };

/**
 * Advances the hysteresis by one fix.
 *
 * `speedMps` of `null` means "unknown" (see `deriveSpeedMps`) — an unreadable
 * fix does neither: it does not reset a stop that is genuinely in progress
 * (which would let a runner who is actually stopped dodge auto-pause forever
 * by producing one bad fix every `holdMs`), and it does not itself count
 * toward starting or extending one (which would auto-pause on noise rather
 * than on a real stop).
 */
export function nextAutoPauseState(
  state: AutoPauseState,
  speedMps: number | null,
  nowMs: number,
  opts: { thresholdMps?: number; holdMs?: number } = {},
): AutoPauseResult {
  if (speedMps == null) return { state, action: null };

  const threshold = opts.thresholdMps ?? AUTO_PAUSE_SPEED_THRESHOLD_MPS;
  const holdMs = opts.holdMs ?? AUTO_PAUSE_HOLD_MS;

  if (speedMps < threshold) {
    const belowSinceMs = state.belowSinceMs ?? nowMs;
    if (!state.autoPaused && nowMs - belowSinceMs >= holdMs) {
      return { state: { belowSinceMs, autoPaused: true }, action: 'pause' };
    }
    return { state: { belowSinceMs, autoPaused: state.autoPaused }, action: null };
  }

  // At/above threshold: clears any in-progress stop immediately. Resuming is
  // not held the way pausing is — a runner who starts moving again should
  // not have to sustain it for 12 seconds before the app notices, and there
  // is no "confusing noise" risk on this side: at worst a single fast fix
  // resumes a stop that immediately re-triggers pause 12 seconds later,
  // which is a strictly better outcome than staying auto-paused through a
  // real restart.
  if (state.autoPaused) {
    return { state: { belowSinceMs: null, autoPaused: false }, action: 'resume' };
  }
  return { state: { belowSinceMs: null, autoPaused: false }, action: null };
}

/**
 * Speed for one GPS fix, in m/s.
 *
 * Prefers the platform's own reported speed (`coords.speed` from
 * `expo-location`) when it looks valid. iOS and Android both report a
 * negative sentinel (Core Location uses -1) when a fix carries no reliable
 * speed — common on the very first fix, or one degraded fix in a run of good
 * ones — so a negative value is treated as "unknown" rather than "stationary
 * or moving backwards".
 *
 * Falls back to distance/time against the last ACCEPTED fix (the same
 * segment shape `trackDistanceMeters` sums) when the native reading is
 * missing or negative — `haversineMeters` is what the live screen's own
 * distance and pace already use, so this can never disagree with those about
 * what "moving" looked like over the same two points.
 */
export function deriveSpeedMps(
  nativeSpeedMps: number | null | undefined,
  prev: Pick<RoutePoint, 'lat' | 'lng' | 'recorded_at'> | null,
  cur: Pick<RoutePoint, 'lat' | 'lng' | 'recorded_at'>,
): number | null {
  if (nativeSpeedMps != null && nativeSpeedMps >= 0) return nativeSpeedMps;
  if (!prev) return null;
  const dtSeconds = (new Date(cur.recorded_at).getTime() - new Date(prev.recorded_at).getTime()) / 1000;
  if (!(dtSeconds > 0)) return null;
  return haversineMeters(prev, cur) / dtSeconds;
}
