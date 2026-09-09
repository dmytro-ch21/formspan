/**
 * W18/#957 — what the session screen SAYS when there is no heart-rate data,
 * and what "Sync heart rate" reports back. Pure: no I/O, no platform, so
 * both the component and its test can reason about every branch.
 *
 * Why this exists: the pre-W18 card said "turn on Health sync in Settings,
 * or it may not have synced yet" for every kind of absence, so an athlete
 * whose watch simply hadn't pushed its samples into Apple Health yet read
 * the same sentence as one who had never turned sync on — and nothing on
 * the screen told them VOLA was still going to look, or let them make it
 * look now. Both of those are decided here, from three facts the screen
 * already has: whether sync is on, when the session ended, and the clock.
 */

import { RETRY_WINDOW_DAYS, type SessionMetrics } from './biometric';

/** Which absence this is — each gets its own honest sentence below. */
export type HRAbsenceState =
  /** The sync-toggle read hasn't answered yet (or the session has no end
   *  time, which never renders this card anyway). Generic copy, no button. */
  | 'loading'
  /** Health sync is off for this platform — the only fix is in Settings. */
  | 'sync_off'
  /** Sync is on and the session is inside `RETRY_WINDOW_DAYS` — the
   *  orchestrator is still re-checking on its own; the button checks NOW. */
  | 'checking'
  /** Sync is on but the retry window closed with nothing found. The
   *  orchestrator has stopped; only the button can look again. */
  | 'gave_up';

export function hrAbsenceState(input: {
  /** `null` while the platform toggle read is still in flight. */
  syncOn: boolean | null;
  /** RFC3339, the session's own logged end. */
  endedAt: string | null | undefined;
  now: Date;
}): HRAbsenceState {
  if (input.syncOn === null) return 'loading';
  if (!input.syncOn) return 'sync_off';
  if (!input.endedAt) return 'loading';
  const endedMs = new Date(input.endedAt).getTime();
  if (!Number.isFinite(endedMs)) return 'loading';
  const ageMs = input.now.getTime() - endedMs;
  // Same inclusive bound as `needsEnrichmentAttempt`'s window check, so
  // this never says "gave up" for a session the orchestrator would still
  // retry, nor "checking" for one it has already abandoned.
  return ageMs <= RETRY_WINDOW_DAYS * 24 * 60 * 60 * 1000 ? 'checking' : 'gave_up';
}

/** The button makes sense whenever sync is on: while the orchestrator is
 *  still checking (the athlete may have just synced the watch) and after it
 *  has given up (same reason, and nothing else will look again). */
export function syncNowButtonVisible(state: HRAbsenceState): boolean {
  return state === 'checking' || state === 'gave_up';
}

/**
 * @param sourceLabel "Apple Health" or "Health Connect" —
 *   `healthSourceLabel` in `lib/vo2MaxSource.ts`.
 */
export function hrAbsenceCopy(state: HRAbsenceState, sourceLabel: string): string {
  switch (state) {
    case 'loading':
      return 'No heart-rate data for this session yet.';
    case 'sync_off':
      return `No heart-rate data for this session — turn on ${sourceLabel} sync in Settings to bring it in.`;
    case 'checking':
      return (
        `${sourceLabel} doesn't have heart rate for this session yet. Watches hand it over on their own ` +
        `schedule — often minutes, sometimes hours — so VOLA keeps checking for ${RETRY_WINDOW_DAYS} days. ` +
        `Synced your watch? Check now.`
      );
    case 'gave_up':
      return (
        `No heart-rate data for this session. VOLA checked ${sourceLabel} for ${RETRY_WINDOW_DAYS} days ` +
        `after it ended and found none — the watch may not have been worn, or never synced. ` +
        `You can still check once more.`
      );
  }
}

/**
 * N552/#1021 — whether this session already HAS heart rate, from the row the
 * screen already holds. One definition, because three screens ask it and the
 * automatic attempt below turns on the answer.
 *
 * The same three facts `hrSourceSentence` refuses to speak about: a missing
 * row, an `hr_source` of `'none'`, or a row with no samples behind it are all
 * "no heart rate", and the last two exist because the server records an
 * honest empty result rather than no result at all.
 */
export function sessionHasHeartRate(
  metrics: Pick<SessionMetrics, 'hr_source' | 'sample_count'> | null | undefined,
): boolean {
  return !!metrics && metrics.hr_source !== 'none' && metrics.sample_count > 0;
}

/**
 * N552/#1021 — whether to run ONE enrichment attempt automatically, without
 * the athlete tapping anything.
 *
 * ## Why this exists
 *
 * "Sync heart rate" (W18/#957) made the non-broadcasting path *recoverable*.
 * It did not make it *automatic*: an athlete whose wearable only ever reaches
 * VOLA through Apple Health / Health Connect finished a session, opened it,
 * and had to press a button to get their own numbers. The enrichment pass
 * otherwise runs on foreground return, sign-in and the Settings toggle — none
 * of which happens when you finish training and go straight to the report.
 * So the supported way to run without a broadcasting device involved a poke,
 * every time, which is the thing #1021 says it must not.
 *
 * ## The three guards, and why each is load-bearing
 *
 * - **`alreadyAttempted`** — once per screen instance. The attempt is a
 *   profile fetch plus a health read plus possibly an upload; a re-render
 *   must not re-run it.
 * - **`metricsLoaded` / `hasHeartRate`** — a session that already has a
 *   result gets nothing. Without this the hook would fire on EVERY open of
 *   every session under `RETRY_WINDOW_DAYS`, including ones whose report is
 *   sitting right there on screen.
 * - **`absence === 'checking'`** — and pointedly not `'gave_up'`. Past
 *   `RETRY_WINDOW_DAYS` the orchestrator has deliberately stopped, and an
 *   automatic attempt there would re-ask the health store on every open, for
 *   every old session, forever — exactly the unbounded ongoing cost
 *   `RETRY_WINDOW_DAYS` exists to prevent (see `needsEnrichmentAttempt`).
 *   The BUTTON still works there, because a tap is explicit intent; that
 *   distinction is W18's and this does not weaken it.
 */
export function autoSyncNowDue(input: {
  absence: HRAbsenceState;
  /** Has the screen's own metrics read answered at all? */
  metricsLoaded: boolean;
  /** `sessionHasHeartRate` of that read. */
  hasHeartRate: boolean;
  /** Has this screen instance already made its one attempt? */
  alreadyAttempted: boolean;
}): boolean {
  if (input.alreadyAttempted) return false;
  if (!input.metricsLoaded) return false;
  if (input.hasHeartRate) return false;
  return input.absence === 'checking';
}

/** The session fields one on-demand enrichment attempt needs — the shape a
 *  session screen already holds (`started_at`/`ended_at`, RFC3339), so the
 *  screen passes its own copy rather than the sync module re-reading a
 *  store. Structurally also what `sessionsNeedingBiometricSync` rows carry. */
export type EnrichableSession = { id: string; started_at: string; ended_at: string | null };

/**
 * What one on-demand enrichment attempt for one session came back with.
 * Produced by `enrichSessionNow` (iOS, `lib/biometricSync.ts`) and its
 * Health Connect twin (`lib/healthConnectSync.ts`); read by the card.
 */
export type SyncNowOutcome =
  /** Real samples were found, uploaded and computed — the caller re-reads
   *  the metrics and the report replaces this card. */
  | { status: 'found'; sampleCount: number }
  /** Health was asked, right now, and still has nothing for this window. */
  | { status: 'none' }
  /** Sync is off for this platform, or this binary can't read Health. */
  | { status: 'sync_off' }
  /** No date of birth on the profile — nothing to seed HRmax from, so the
   *  server can't compute zones even with samples in hand. */
  | { status: 'no_hrmax' }
  /** Network, or the Health read itself, failed. Nothing was recorded. */
  | { status: 'error' };

/** Always a sentence — #957 asks for the result "in words", and `found` is
 *  the one the athlete most wants to read. The card shows it under the
 *  button until the caller's metrics re-read replaces the whole card with
 *  the report; if that re-read fails (offline), the sentence stays, which
 *  is still the truth: the samples are uploaded and the ledger says so. */
export function syncNowOutcomeCopy(outcome: SyncNowOutcome, sourceLabel: string): string {
  switch (outcome.status) {
    case 'found':
      return `Found ${outcome.sampleCount} heart-rate ${outcome.sampleCount === 1 ? 'sample' : 'samples'} — building the report.`;
    case 'none':
      return `Still nothing in ${sourceLabel} for this session. Open your watch's app to push its data, then check again.`;
    case 'sync_off':
      return `Turn on ${sourceLabel} sync in Settings first.`;
    case 'no_hrmax':
      return 'Add your date of birth in Profile — VOLA needs it to work out your heart-rate zones.';
    case 'error':
      return "Couldn't check right now. Try again in a moment.";
  }
}
