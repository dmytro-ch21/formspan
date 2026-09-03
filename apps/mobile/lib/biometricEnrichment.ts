/**
 * The §2 "window join" and its supporting decisions (design doc
 * `docs/decisions/health-integration-design.md` §2, §6.2) — pure, over plain
 * data, with no Health Connect (or HealthKit) import anywhere in this file.
 *
 * This is the platform-agnostic half N478's ticket asks to keep separable
 * from the Android-specific reading code in `lib/healthConnect.ts`, so that
 * whichever ticket lands N477 (iOS) can import this file unchanged rather
 * than re-deriving the same math a second time. Every function here is
 * exercised by `lib/__tests__/biometricEnrichment.test.ts` without a device,
 * exactly the class of logic `apps/mobile/lib/__tests__/` exists for
 * ("what breaks in this app is concurrency and state reconciliation, not
 * rendering").
 */

/** One heart-rate reading, reduced to plain data — what a `HeartRateRecord`'s
 *  `samples` array becomes after `lib/healthConnect.ts` maps it. */
export type RawHeartRateSample = {
  /** RFC3339 */
  time: string;
  beatsPerMinute: number;
};

/**
 * Individual samples actually inside `[windowStart, windowEnd]`, inclusive.
 *
 * Needed because Health Connect's own `timeRangeFilter` on `readRecords`
 * filters at the RECORD level, not the sample level — a `HeartRateRecord`
 * whose interval merely OVERLAPS the query window is returned in full, and
 * its `samples` array can carry points from a few seconds either side of the
 * record's queried boundary. Clipping here is what makes the window join
 * exact rather than approximately-the-window, the same edge case the design
 * doc's `enrich.ts` sketch calls out ("a session that spans midnight, a
 * watch workout that starts before ours").
 */
export function heartRateSamplesInWindow(
  samples: readonly RawHeartRateSample[],
  windowStart: string,
  windowEnd: string,
): RawHeartRateSample[] {
  const startMs = new Date(windowStart).getTime();
  const endMs = new Date(windowEnd).getTime();
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) return [];
  return samples.filter((s) => {
    const t = new Date(s.time).getTime();
    return Number.isFinite(t) && t >= startMs && t <= endMs;
  });
}

/**
 * Health Connect's own read wall (design doc §5.2): by default a read
 * permission only ever surfaces the previous 30 days of another app's
 * history — reading further back needs a SEPARATE, Play-review-gated
 * permission (`PERMISSION_READ_HEALTH_DATA_HISTORY`) this ticket does not
 * request. Attempting to read past the wall without it is a native ERROR,
 * not an empty result (§5.2 again) — so the fix is not to attempt it: a
 * session whose window starts before the wall is skipped before any native
 * call is made, which is what turns an inevitable failure into a documented,
 * predictable gap instead of a confusing one (#823's own acceptance
 * criterion).
 */
export const HEALTH_CONNECT_HISTORY_WALL_DAYS = 30;

export function isWithinHealthConnectHistoryWall(
  sessionStartedAt: string,
  now: Date,
  wallDays: number = HEALTH_CONNECT_HISTORY_WALL_DAYS,
): boolean {
  const startedMs = new Date(sessionStartedAt).getTime();
  if (!Number.isFinite(startedMs)) return false;
  const wallStartMs = now.getTime() - wallDays * 24 * 60 * 60 * 1000;
  return startedMs >= wallStartMs;
}

/** A caller-supplied HRmax outside this range corrupts every zone a
 *  session's TRIMP is built from — mirrors
 *  `backend/internal/modules/biometric/handler.go`'s `minHRMaxBPM`/
 *  `maxHRMaxBPM` exactly, so a value this module estimates is never
 *  rejected by the server that receives it. */
export const MIN_HR_MAX_BPM = 100;
export const MAX_HR_MAX_BPM = 250;

/**
 * The Fox/Haskell age-based HRmax estimate (`220 - age`) — a rough one, and
 * openly so: it is a fallback for an athlete with no measured HRmax on file,
 * not a claim of precision. `null` when there is nothing to estimate from
 * (no date of birth) or the result would need clamping so hard it no longer
 * means anything (an implausible age) — a caller getting `null` back should
 * still upload raw samples via `putBiometricSamples`, just skip
 * `computeSessionMetrics`, which requires a real value.
 */
export function estimateHRMaxBPM(
  dateOfBirth: string | null | undefined,
  now: Date = new Date(),
): number | null {
  if (!dateOfBirth) return null;
  const dob = new Date(dateOfBirth);
  const dobMs = dob.getTime();
  if (!Number.isFinite(dobMs) || dobMs > now.getTime()) return null;

  let age = now.getFullYear() - dob.getFullYear();
  const hadBirthdayThisYear =
    now.getMonth() > dob.getMonth() ||
    (now.getMonth() === dob.getMonth() && now.getDate() >= dob.getDate());
  if (!hadBirthdayThisYear) age -= 1;
  if (age < 0 || age > 130) return null;

  const estimate = 220 - age;
  return Math.min(MAX_HR_MAX_BPM, Math.max(MIN_HR_MAX_BPM, estimate));
}

/** What this device already knows about one session's enrichment attempt —
 *  the local ledger row (see `lib/db.ts`'s `health_connect_enrichment`
 *  table). */
export type EnrichmentLedgerEntry = {
  /** `'window'` once real evidence has been found and stored — a session
   *  never needs retrying past that point. `'none'` means the last attempt
   *  found zero samples; see `needsEnrichmentAttempt` for the retry
   *  window. */
  hrSource: 'window' | 'none';
  /** RFC3339, when the last attempt ran. */
  attemptedAt: string;
};

/**
 * How long a `'none'` result stays worth re-checking, and how long between
 * re-checks.
 *
 * The watch may not have synced its samples to the phone yet at the moment
 * the athlete closes the app (design doc §6.4: "enrichment is not
 * blocking… possibly much later") — so a fresh `'none'` deserves a few more
 * tries. Past `RETRY_WINDOW_DAYS`, a session that still has no samples
 * almost certainly never will (no watch, or the watch was never worn for
 * this one), and asking Health Connect again on every single foreground
 * return forever, for every session an athlete without a wearable has ever
 * logged, is real ongoing cost with no plausible upside.
 */
export const RETRY_WINDOW_DAYS = 3;
export const RETRY_COOLDOWN_HOURS = 12;

/** A finished session, reduced to what enrichment needs to know about it. */
export type EnrichmentCandidate = {
  id: string;
  /** RFC3339 */
  startedAt: string;
  /** RFC3339, or `null` for a session still in progress — never a
   *  candidate. */
  endedAt: string | null;
};

/**
 * Whether THIS session is worth asking Health Connect about right now —
 * everything except the history-wall check, which
 * `selectEnrichmentCandidates` applies separately since it needs no ledger
 * state at all.
 */
export function needsEnrichmentAttempt(
  session: Pick<EnrichmentCandidate, 'endedAt'>,
  ledgerEntry: EnrichmentLedgerEntry | undefined,
  now: Date,
): boolean {
  if (!session.endedAt) return false;
  if (!ledgerEntry) return true;
  if (ledgerEntry.hrSource === 'window') return false;

  const endedMs = new Date(session.endedAt).getTime();
  if (!Number.isFinite(endedMs)) return false;
  const stillWorthRetrying = now.getTime() - endedMs <= RETRY_WINDOW_DAYS * 24 * 60 * 60 * 1000;
  if (!stillWorthRetrying) return false;

  const attemptedMs = new Date(ledgerEntry.attemptedAt).getTime();
  if (!Number.isFinite(attemptedMs)) return true;
  return now.getTime() - attemptedMs >= RETRY_COOLDOWN_HOURS * 60 * 60 * 1000;
}

/**
 * Every locally-known finished session actually worth an enrichment pass
 * right now — combines `needsEnrichmentAttempt` (the ledger/retry decision)
 * with the history-wall skip (§5.2), so a caller need not remember to apply
 * both. Order is preserved from `sessions`.
 */
export function selectEnrichmentCandidates<S extends EnrichmentCandidate>(
  sessions: readonly S[],
  ledger: ReadonlyMap<string, EnrichmentLedgerEntry>,
  now: Date,
): S[] {
  return sessions.filter((s) => {
    if (!needsEnrichmentAttempt(s, ledger.get(s.id), now)) return false;
    return isWithinHealthConnectHistoryWall(s.startedAt, now);
  });
}
