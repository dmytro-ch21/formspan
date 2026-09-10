/**
 * N552/#1021 — the one FACT Settings cannot state from configuration alone:
 * does this device's health store actually hold any recent heart rate?
 *
 * Without it, Settings can only report what is switched on, and "VOLA will
 * read your session from Apple Health" is a promise rather than an
 * observation — which is exactly the shape of statement this ticket exists
 * to stop making. An athlete with no wearable at all, and an athlete whose
 * Apple Watch is feeding Health every few minutes, are in completely
 * different situations and had identical copy.
 *
 * Deliberately thin: one bounded read, best-effort, never throws, and only
 * ever called when the sync toggle is already on (so it can never be the
 * thing that provokes a permission prompt the athlete did not ask for).
 *
 * ## What a `false` does and does not mean, per platform
 *
 * On iOS, `healthkit.queryHeartRateSamples` returns `[]` for a DECLINED
 * grant exactly as it does for an empty store — HealthKit does not let an
 * app distinguish the two for read authorization (design doc §5.1, and that
 * function's own doc comment). So `false` here means "found none", never
 * "nothing wrote any", and `lib/hrPath.ts`'s copy for it is worded as an
 * observation with an action rather than as a diagnosis.
 *
 * On Android a refused grant DOES surface, as `HealthConnectPermissionError`
 * — which is reported as `null` (unknown), not as `false`, because a refusal
 * is genuinely a different situation from an empty store and W15/#954 is the
 * ticket that established this app must not swallow one as the other.
 */

import { queryHeartRateSamples as queryHCHeartRate } from './healthConnect';
import { queryHeartRateSamples as queryHKHeartRate } from './healthkit';
import type { HealthSource } from './vo2MaxSource';

/**
 * How far back "recent" reaches — 24 hours.
 *
 * Long enough that a wearable worn yesterday and synced this morning still
 * answers `true`, and short enough that the answer is about the athlete's
 * CURRENT setup rather than a watch they stopped wearing last month. Also
 * bounds the read: a day of Apple Watch background heart rate is a few
 * hundred samples, well under `QUANTITY_QUERY_LIMIT`, for one read on one
 * screen.
 */
export const HEALTH_HR_PROBE_HOURS = 24;

/**
 * `true` if the store holds at least one heart-rate reading in the last
 * `HEALTH_HR_PROBE_HOURS`, `false` if it holds none, `null` if the question
 * could not be answered (access refused, or the read failed).
 */
export async function healthStoreHasRecentHeartRate(
  source: HealthSource,
  now: Date = new Date(),
): Promise<boolean | null> {
  const start = new Date(now.getTime() - HEALTH_HR_PROBE_HOURS * 60 * 60 * 1000);
  try {
    if (source === 'healthkit') {
      const samples = await queryHKHeartRate(start, now);
      return samples.length > 0;
    }
    const readings = await queryHCHeartRate(start.toISOString(), now.toISOString());
    return readings.length > 0;
  } catch {
    // A refused Health Connect grant throws `HealthConnectPermissionError`
    // here (W15/#954 made that refusal surface rather than read as "no
    // data"), and it lands in the same `null` as any other read failure —
    // NOT in `false`. The distinction that matters to the athlete is
    // "found none" versus "could not tell", and `hrPathDetail`'s
    // `'health_unknown'` copy names permission as one of the two reasons.
    return null;
  }
}
