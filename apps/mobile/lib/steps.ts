import { Platform } from 'react-native';

import { dayString, shortDate } from './calendar';
import { getDb, withTransaction } from './db';
import { PREF_STEPS_ASKED, readPref, writePref } from './prefs';
import { formatClock } from './trackerModel';

/**
 * Daily steps, read from Apple Health or Health Connect and kept on this phone
 * — N569 (#1130).
 *
 * Three layers, the split every Health feature in this app already uses:
 * `lib/healthkit.ts` / `lib/healthConnect.ts` are the native boundary, this file
 * is the pure decisions plus the local store, and `lib/healthkitSync.ts` /
 * `lib/healthConnectSync.ts` decide WHEN a read runs (their existing foreground,
 * sign-in and Settings triggers). The VOLA panel reads the store and nothing
 * else.
 *
 * ## Three states that must never collapse into one
 *
 * | What happened | Stored as | What the athlete reads |
 * |---|---|---|
 * | this phone has no Apple Health / Health Connect | `no_source` | there is nothing here to read steps from |
 * | the platform would not give VOLA steps | `refused` | VOLA is not being given steps, and how to change that |
 * | a read answered, and the answer was zero | a `daily_steps` row with `steps = 0` | **0 steps** |
 *
 * A refusal is never written as a row, so it can never be drawn as a number.
 * That is W15's (#954) posture carried to a new read: "not allowed" is not
 * "not there", and neither is "zero".
 *
 * ## Refusal is observable differently on each platform
 *
 * - **Android says no out loud.** A refused `Steps` read rejects with the
 *   package's `PERMISSION_ERROR`, which `lib/healthConnect.ts` turns into
 *   `HealthConnectPermissionError`. So Android can ALSO tell a fourth thing
 *   apart: permitted, but no app on the phone has written a single step
 *   (`no_data`). That is not zero either.
 * - **iOS never says no.** HealthKit answers a denied read with an empty result,
 *   on purpose (Apple treats "which types you refused" as private). An empty
 *   sum for today is therefore either a genuine zero or a refusal, and the only
 *   evidence that separates them is whether HealthKit has shared ANY step sample
 *   in the last {@link STEPS_LOOKBACK_DAYS} days. An iPhone records steps
 *   whenever it is carried, so a week of nothing is a refusal (or motion
 *   tracking switched off, which the athlete fixes in the same place). See
 *   {@link stepsFromHealthKit}.
 *
 * ## Why it is not synced to the server
 *
 * Recorded in `docs/decisions/history.md`'s N569 entry. In short: the phone is
 * the only thing that can read the count, the panel only needs today's, no web
 * surface consumes steps yet, and a second device reading the same Health store
 * would write a second copy of one count. The table is keyed so a later sync can
 * be added without reshaping it.
 */

export type StepSource = 'healthkit' | 'health_connect';

/**
 * The one step source this phone's platform can have, or `null` (web).
 *
 * **Load-bearing, not a convenience.** All three Health orchestrators are
 * started on every platform (`app/_layout.tsx`), so the Health Connect pass also
 * runs on an iPhone. Without this gate it would record `no_source` there — and
 * overwrite the reading HealthKit had just written, turning an iPhone's real
 * count into "no step source". Each platform's read checks it before writing.
 */
export function platformStepSource(): StepSource | null {
  if (Platform.OS === 'ios') return 'healthkit';
  if (Platform.OS === 'android') return 'health_connect';
  return null;
}

/** What the most recent read concluded, for this athlete on this phone. */
export type StepsReadState = 'read' | 'refused' | 'no_data' | 'no_source' | 'off' | 'not_asked';

const READ_STATES: readonly StepsReadState[] = ['read', 'refused', 'no_data', 'no_source', 'off', 'not_asked'];

/** What one native read answered. A transient failure is not an outcome: it throws. */
export type StepsOutcome = { kind: 'steps'; steps: number } | { kind: 'refused' } | { kind: 'no_data' };

/**
 * How far back a read looks for evidence that the platform shares steps at all
 * — see {@link stepsFromHealthKit}. A week, because a phone left in a drawer for
 * a day is ordinary and a phone that has recorded nothing for seven is not.
 */
export const STEPS_LOOKBACK_DAYS = 7;

function positiveCount(n: number | null | undefined): number | null {
  if (n == null || !Number.isFinite(n) || n <= 0) return null;
  return Math.round(n);
}

/**
 * iOS: today's cumulative sum and whether HealthKit shared any step sample in
 * the lookback, as one outcome.
 *
 * **The guard this whole feature rests on for iPhone.** HealthKit hands a denied
 * read back empty, so "no sum today" alone must not become `0 steps`. Only when
 * HealthKit has demonstrably shared step data recently is an empty today a real
 * zero; otherwise nothing is being shared, which is a refusal as far as anything
 * VOLA can observe.
 */
export function stepsFromHealthKit(sum: number | null | undefined, anySampleInLookback: boolean): StepsOutcome {
  const counted = positiveCount(sum);
  if (counted != null) return { kind: 'steps', steps: counted };
  return anySampleInLookback ? { kind: 'steps', steps: 0 } : { kind: 'refused' };
}

/**
 * Android: today's aggregate and whether any `Steps` record exists in the
 * lookback. A refusal never reaches this — it is thrown at the read site.
 *
 * The package reports an empty aggregate as `COUNT_TOTAL: 0` (verified against
 * `ReactStepsRecord.kt`'s `?: 0.0`), so a zero here is ambiguous in exactly the
 * way HealthKit's empty sum is, and it is resolved the same way: zero only when
 * some app on this phone has recorded steps recently, `no_data` when none has.
 */
export function stepsFromHealthConnect(total: number | null | undefined, anyRecordInLookback: boolean): StepsOutcome {
  const counted = positiveCount(total);
  if (counted != null) return { kind: 'steps', steps: counted };
  return anyRecordInLookback ? { kind: 'steps', steps: 0 } : { kind: 'no_data' };
}

/** Local midnight today, and the start of the lookback, for a read made at `now`. */
export function stepsWindow(now: Date): { dayStart: Date; lookbackStart: Date } {
  const dayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0);
  const lookbackStart = new Date(dayStart);
  lookbackStart.setDate(lookbackStart.getDate() - STEPS_LOOKBACK_DAYS);
  return { dayStart, lookbackStart };
}

// --- change signal ---------------------------------------------------------

const listeners = new Set<() => void>();

/**
 * Called after every write, so a screen already showing steps re-reads the store
 * when a foreground pass lands. Returns the unsubscribe.
 */
export function onStepsChanged(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function notifyStepsChanged(): void {
  for (const listener of [...listeners]) listener();
}

// --- the store ---------------------------------------------------------------

/**
 * Record what a read concluded. A count writes today's row AND the state, in one
 * transaction; anything else writes only the state and leaves every row alone —
 * a refusal does not delete yesterday's genuine reading, and it does not become
 * a zero either.
 */
export async function recordStepsOutcome(
  userID: string,
  source: StepSource,
  outcome: StepsOutcome,
  now: Date,
): Promise<void> {
  const db = await getDb();
  const at = now.toISOString();
  if (outcome.kind === 'steps') {
    const day = dayString(now);
    await withTransaction(db, async () => {
      await db.runAsync(
        `INSERT INTO daily_steps (user_id, day, steps, source, read_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (user_id, day) DO UPDATE SET
           steps = excluded.steps,
           source = excluded.source,
           read_at = excluded.read_at`,
        userID,
        day,
        outcome.steps,
        source,
        at,
      );
      await writeState(db, userID, 'read', source, at);
    });
  } else {
    await writeState(db, userID, outcome.kind, source, at);
  }
  notifyStepsChanged();
}

/** Record a state that no native read produced: no source, sync off, never asked. */
export async function recordStepsState(
  userID: string,
  state: 'no_source' | 'off' | 'not_asked',
  source: StepSource | null,
  now: Date,
): Promise<void> {
  const db = await getDb();
  await writeState(db, userID, state, source, now.toISOString());
  notifyStepsChanged();
}

async function writeState(
  db: Awaited<ReturnType<typeof getDb>>,
  userID: string,
  state: StepsReadState,
  source: StepSource | null,
  at: string,
): Promise<void> {
  await db.runAsync(
    `INSERT INTO steps_read_state (user_id, state, source, checked_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT (user_id) DO UPDATE SET
       state = excluded.state,
       source = excluded.source,
       checked_at = excluded.checked_at`,
    userID,
    state,
    source,
    at,
  );
}

/** Today's reading. `steps` may be 0: that is a reading, not an absence. */
export type StepsRow = { day: string; steps: number; source: StepSource; read_at: string };

/**
 * What this phone knows about `userID`'s steps on `day`.
 *
 * - `unknown`: no read has ever run for this athlete here. Not "no steps".
 * - `read`: the latest read answered. `today` is that day's row, or `null` when
 *   the latest read was on an earlier day — which is "not read yet today",
 *   never zero.
 * - every other state: why there is no count, with the platform that said so.
 */
export type StepsView =
  | { state: 'unknown' }
  | { state: 'read'; today: StepsRow | null; lastReadAt: string; source: StepSource | null }
  | {
      state: Exclude<StepsReadState, 'read'>;
      source: StepSource | null;
      checkedAt: string;
    };

function asSource(s: string | null): StepSource | null {
  return s === 'healthkit' || s === 'health_connect' ? s : null;
}

export async function localStepsView(userID: string, day: string): Promise<StepsView> {
  const db = await getDb();
  const status = await db.getFirstAsync<{ state: string; source: string | null; checked_at: string }>(
    `SELECT state, source, checked_at FROM steps_read_state WHERE user_id = ?`,
    userID,
  );
  if (!status || !READ_STATES.includes(status.state as StepsReadState)) return { state: 'unknown' };
  const state = status.state as StepsReadState;
  const source = asSource(status.source);
  if (state !== 'read') return { state, source, checkedAt: status.checked_at };

  const row = await db.getFirstAsync<{ day: string; steps: number; source: string; read_at: string }>(
    `SELECT day, steps, source, read_at FROM daily_steps WHERE user_id = ? AND day = ?`,
    userID,
    day,
  );
  const rowSource = row ? asSource(row.source) : null;
  return {
    state: 'read',
    today: row && rowSource ? { day: row.day, steps: row.steps, source: rowSource, read_at: row.read_at } : null,
    lastReadAt: status.checked_at,
    source,
  };
}

// --- the deliberate ask --------------------------------------------------------

/**
 * Whether this athlete has been asked for steps on this phone, by tapping the
 * explicit "Allow steps" action.
 *
 * **Why this exists at all.** Every foreground pass re-requests Health access
 * so a returning athlete is never asked twice, and on iOS a type added to that
 * request which the athlete has never decided on makes the system sheet appear.
 * Adding steps to it would have popped a Health sheet at an athlete who had
 * just opened the app to log a set. So the passes ask for steps only once this
 * says the athlete asked for them — see `requestHealthKitReadAuthorization`.
 */
export async function readStepsAsked(userID: string): Promise<boolean> {
  return (await readPref(userID, PREF_STEPS_ASKED)) === '1';
}

export function writeStepsAsked(userID: string): Promise<void> {
  return writePref(userID, PREF_STEPS_ASKED, '1');
}

// --- one read, platform-neutral ---------------------------------------------

/**
 * One steps read, in the order its answers depend on each other: is there a
 * source, is Health sync on, has the athlete been asked, and only then the
 * native read.
 *
 * **Never throws, and a failure writes nothing.** A read that fails for any
 * reason other than a refusal (the platform adapters turn refusals into an
 * outcome) leaves the previous state and row exactly as they were, so a
 * transient error can never become a zero or a refusal on screen. Returns what
 * was recorded, or `null` when nothing was.
 */
export async function runStepsRead(
  userID: string,
  source: StepSource,
  deps: {
    supported: () => boolean | Promise<boolean>;
    enabled: () => Promise<boolean>;
    read: (window: { dayStart: Date; lookbackStart: Date; now: Date }) => Promise<StepsOutcome>;
    now?: () => Date;
  },
): Promise<StepsReadState | null> {
  const now = deps.now ? deps.now() : new Date();
  try {
    if (!(await deps.supported())) {
      await recordStepsState(userID, 'no_source', null, now);
      return 'no_source';
    }
    if (!(await deps.enabled())) {
      await recordStepsState(userID, 'off', source, now);
      return 'off';
    }
    if (!(await readStepsAsked(userID))) {
      await recordStepsState(userID, 'not_asked', source, now);
      return 'not_asked';
    }
    const outcome = await deps.read({ ...stepsWindow(now), now });
    await recordStepsOutcome(userID, source, outcome, now);
    return outcome.kind === 'steps' ? 'read' : outcome.kind;
  } catch {
    return null;
  }
}

// --- refresh on demand --------------------------------------------------------

let refresher: (() => void) | null = null;
let lastRefreshAt = 0;

/** How often a screen may ask for a fresh read. Foreground passes are not throttled. */
export const STEPS_REFRESH_MIN_MS = 60_000;

/**
 * Registered by whichever platform orchestrator runs on this phone
 * (`startHealthKitImportOrchestrator` / `startHealthConnectSyncOrchestrator`),
 * so a screen can ask for a steps read without importing either.
 */
export function setStepsRefresher(fn: (() => void) | null): void {
  refresher = fn;
}

/**
 * Ask for a steps read now, at most once a minute. Fire-and-forget: the screen
 * keeps rendering the store, and re-reads it when {@link onStepsChanged} fires.
 * This is how VOLA stays current when it is opened directly, without Today.
 */
export function requestStepsRefresh(nowMs: number = Date.now()): void {
  if (!refresher) return;
  if (nowMs - lastRefreshAt < STEPS_REFRESH_MIN_MS) return;
  lastRefreshAt = nowMs;
  refresher();
}

// --- copy ------------------------------------------------------------------------

export function stepsSourceName(source: StepSource | null): string {
  if (source === 'healthkit') return 'Apple Health';
  if (source === 'health_connect') return 'Health Connect';
  return 'your health app';
}

/**
 * `As of 14:05` on the same day, `As of 9 Sep, 14:05` otherwise. A step count is
 * a reading of a counter that keeps moving, so it always says when it was read.
 */
export function stepsReadLabel(readAt: string, now: Date): string {
  const at = new Date(readAt);
  if (Number.isNaN(at.getTime())) return 'Read at an unknown time';
  const on = dayString(at);
  if (on === dayString(now)) return `As of ${formatClock(at)}`;
  return `As of ${shortDate(on)}, ${formatClock(at)}`;
}
