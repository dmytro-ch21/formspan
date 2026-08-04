import { useEffect, useState } from 'react';
import { AppState, type AppStateStatus } from 'react-native';

import { isOffline } from './apiError';
import { countPendingSessions, countPendingWorkouts, syncSessions } from './sessionStore';
import { countPendingPlans, syncPlans } from './plan';
import type { SyncErrorKind } from './sessionStore';
import type { TokenGetter } from './useAuthToken';

/**
 * When training gets off this phone, and who decides.
 *
 * **Before this, nobody decided.** `syncSessions` was fired and forgotten from
 * seven call sites — session focus, the exercise picker, finishing a session,
 * starting one, Today's mount, a manual Retry. Each was a guess that *now*
 * might be a good moment. The consequence an athlete meets: log a whole
 * session in a basement gym, walk out into signal, and nothing happens. The
 * training sits on the phone until you happen to open a screen whose mount
 * fires a sync. There is no timer, no connectivity trigger, and nothing that
 * notices you came back.
 *
 * So this module owns the question. The call sites keep saying *"something
 * changed"*; this decides when to act on it.
 *
 * **Reachability, not radio state.** There is deliberately no
 * `expo-network`/NetInfo dependency here. The question worth answering is "can
 * I reach VOLA", and the OS answers a different one — a phone associated with
 * gym wifi that has no upstream reports itself perfectly connected, which is
 * exactly the case that started this whole thread. So online/offline is
 * inferred from whether requests actually succeed: an `OfflineError` means
 * offline, a completed sync means online. The OS listener is worth adding
 * later purely to *shorten* the wait after signal returns — it would be an
 * optimisation over the backoff below, not the source of truth.
 *
 * **What it does NOT do:** background sync. Nothing runs while the app is
 * killed or suspended — iOS would need a background task capability, and
 * pretending otherwise in the UI would be worse than the honest "syncs when
 * you open it" this gives.
 */

/** Everything the UI needs to say something truthful about sync state. */
export type SyncState = {
  /** A run is in progress right now. */
  syncing: boolean;
  /** Sessions holding local edits the server hasn't got. */
  pending: number;
  /**
   * Rows held back this run because something they depend on hasn't synced.
   *
   * Separate from an error on purpose: a session whose workout has not
   * reached the server is *waiting*, and saying "sync failed" would both
   * alarm the athlete and misdescribe a state that resolves itself.
   */
  deferred: number;
  /** When a run last completed with nothing failing. */
  lastSyncAt: number | null;
  /**
   * Why the last run failed, or null.
   *
   * Held separately from `pending` because they answer different questions:
   * pending>0 with no error is "not yet", pending>0 with an error is "and
   * here is what went wrong".
   */
  lastError: string | null;
  /**
   * Last observed reachability. Starts optimistic — assuming offline before
   * trying would delay the first sync for no reason.
   */
  online: boolean;
};

/**
 * Backoff between automatic retries, in ms.
 *
 * Ends at five minutes rather than growing forever: the thing being waited on
 * is usually a person walking out of a basement, and a schedule that has
 * drifted to an hour would leave a finished workout unsynced long after the
 * phone had signal again. The last entry repeats.
 */
const BACKOFF_MS = [5_000, 15_000, 60_000, 300_000];

let state: SyncState = {
  syncing: false,
  pending: 0,
  deferred: 0,
  lastSyncAt: null,
  lastError: null,
  online: true,
};

const listeners = new Set<(s: SyncState) => void>();
let timer: ReturnType<typeof setTimeout> | null = null;
let failures = 0;
/** Set while a run is in flight, so overlapping requests coalesce. */
let running: Promise<void> | null = null;
/** A change arrived while a run was in flight — run once more after it. */
let dirtyAgain = false;
let creds: { userID: string; getToken: TokenGetter } | null = null;

function emit(next: Partial<SyncState>): void {
  state = { ...state, ...next };
  for (const l of listeners) {
    try {
      l(state);
    } catch {
      // One throwing subscriber must not abort the rest, nor reject the
      // un-awaited run and leave `syncing: true` stuck on forever.
    }
  }
}

export function subscribeSync(fn: (s: SyncState) => void): () => void {
  listeners.add(fn);
  fn(state);
  return () => listeners.delete(fn);
}

export function syncState(): SyncState {
  return state;
}

/**
 * Who to sync as. Set once the athlete is known, cleared on sign-out.
 *
 * Held here rather than passed per call so the AppState listener and the
 * backoff timer — neither of which has a React context — can run a sync.
 */
export function setSyncIdentity(userID: string | null, getToken: TokenGetter | null): void {
  if (!userID || !getToken) {
    creds = null;
    cancelTimer();
    failures = 0;
    // Not a "synced" state — an unknown one. Reporting 0 pending for a
    // signed-out app would let the UI claim everything is safely on the
    // server when we simply have no one to ask about.
    emit({ syncing: false, pending: 0, deferred: 0, lastError: null, lastSyncAt: null });
    return;
  }
  creds = { userID, getToken };
  void refreshPending();
  request('sign-in');
}

function cancelTimer(): void {
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
}

/**
 * Recount what's waiting, without syncing. Cheap: two indexed COUNTs.
 *
 * Workouts are counted as well as sessions, and not for the badge's sake:
 * `pending` gates the machinery. `schedule()` refuses to set a retry timer
 * when it reads 0, and the foreground trigger declines to sync. So while this
 * counted sessions only, an edited plan that failed transiently — a 5xx,
 * which leaves `online: true` — got no backoff retry and no foreground retry,
 * and could sit on the device indefinitely until some unrelated action
 * happened to call `request()`. The offline case survived only by accident,
 * because `!state.online` trips the foreground gate on its own.
 */
export async function refreshPending(): Promise<void> {
  if (!creds) return;
  try {
    const [sessions, workouts, plans] = await Promise.all([
      countPendingSessions(creds.userID),
      countPendingWorkouts(creds.userID),
      countPendingPlans(creds.userID),
    ]);
    emit({ pending: sessions + workouts + plans });
  } catch {
    // A failed count must not break anything; the number is advisory.
  }
}

/**
 * "Something changed, or might have" — the only thing call sites need to say.
 *
 * Deliberately fire-and-forget and cheap to call: screens should not be
 * choosing sync moments, and should not have to care whether one is already
 * running. Overlapping requests coalesce into the run in flight plus at most
 * one more, so a burst of set edits does not become a burst of syncs.
 */
export function request(reason: string): void {
  if (!creds) return;
  if (running) {
    dirtyAgain = true;
    return;
  }
  cancelTimer();
  void run(reason);
}

async function run(reason: string): Promise<void> {
  if (!creds || running) return;
  const { userID, getToken } = creds;

  // Assigned before the emit: listeners run synchronously, and one that
  // called `request()` would otherwise see `running === null` and start a
  // second run.
  running = (async () => {
    let retry = false;
    try {
      const sessionResult = await syncSessions(userID, getToken);

      // Plans AFTER sessions, and the order is load bearing.
      //
      // `syncSessions` is what pushes dirty workouts, and `plans.workout_id` is
      // a real FK server-side — so a plan whose template has not landed is
      // refused with a 4xx, which classifies as `permanent` and would make the
      // orchestrator give up on a plan that is perfectly fine. Running plans
      // second means `unsyncedWorkoutIDs` is accurate when the plan push reads
      // it to decide what to defer.
      const planResult = await syncPlans(userID, getToken);

      // Merged so one failing half cannot be masked by the other succeeding.
      // Both surfaces — the pending count and the error banner — describe the
      // whole outbox, not one table of it.
      const result = {
        failed: sessionResult.failed + planResult.failed,
        deferred: sessionResult.deferred + planResult.deferred,
        error: sessionResult.error ?? planResult.error,
        errorKind: sessionResult.errorKind ?? planResult.errorKind,
      };

      // The account may have changed while this ran.
      if (creds?.userID !== userID) return;

      emit({ deferred: result.deferred });

      if (result.failed > 0) {
        failures++;
        const kind: SyncErrorKind = result.errorKind ?? 'transient';
        emit({
          lastError: result.error ?? 'Sync failed.',
          // Classified server-side of this boundary, from the error object.
          // This used to match on the message text, which the API conventions
          // forbid — and which would have inverted silently the first time
          // someone reworded our own offline copy.
          online: kind !== 'offline',
        });
        // A permanent rejection will be refused identically forever. Retrying
        // it costs a doomed request every backoff tick and every foreground,
        // for the life of the install, and the row stays dirty so `pending`
        // never reaches 0 to stop it. The error is already surfaced; leave it
        // to the athlete (or a later tombstone/repair path) rather than
        // grinding.
        retry = kind !== 'permanent';
      } else {
        failures = 0;
        emit({ lastError: null, lastSyncAt: Date.now(), online: true });
      }
    } catch (err) {
      // Same recheck as the success path: without it, a sign-out or account
      // switch mid-run leaves the previous athlete's error on screen.
      if (creds?.userID !== userID) return;
      failures++;
      emit({
        lastError: err instanceof Error ? err.message : String(err),
        online: !isOffline(err),
        // Cleared, not carried. The run threw before reporting a count, so
        // the previous run's number describes nothing that is true now.
        deferred: 0,
      });
      retry = true;
    } finally {
      if (creds?.userID !== userID) {
        // Torn down mid-run. Do not write this run's counts over the state
        // `setSyncIdentity` just cleared.
        emit({ syncing: false });
        return;
      }
      emit({ syncing: false });
      // Recount BEFORE deciding to retry. `schedule()` refuses to set a timer
      // with nothing pending, and reading a stale count here would skip the
      // retry for exactly the rows that need it — a session created moments
      // ago whose count hadn't been refreshed yet still reads as 0.
      await refreshPending();
      if (retry) schedule();
    }
  })();

  emit({ syncing: true });

  try {
    await running;
  } finally {
    running = null;
    if (dirtyAgain) {
      dirtyAgain = false;
      // Something landed mid-run; it was not included, so go again.
      request(`${reason}+queued`);
    }
  }
}

/**
 * Retry later, and only if there is something to retry for.
 *
 * Scheduling a timer with nothing pending would wake the app up to do
 * nothing, forever, on the chance the network improved.
 */
function schedule(): void {
  cancelTimer();
  if (state.pending === 0) return;
  // Clamped at both ends. `syncNow` zeroes `failures`, and it can do so while
  // a failing run is suspended on an await — so this can be reached with
  // failures === 0 and read BACKOFF_MS[-1], i.e. undefined, i.e. setTimeout
  // fires immediately.
  const wait = BACKOFF_MS[Math.max(0, Math.min(failures - 1, BACKOFF_MS.length - 1))];
  timer = setTimeout(() => {
    timer = null;
    request('backoff');
  }, wait);
}

/**
 * Sync when the app comes back to the foreground.
 *
 * This is the trigger that matters most, and the one that was missing: the
 * common shape is *finish a workout in a basement, pocket the phone, walk
 * out, open the app later*. That last step is a foreground transition, and
 * nothing was listening for it.
 *
 * Registered once at module scope rather than per screen — a listener per
 * mounted screen is how you get five syncs for one transition.
 */
let appStateSub: { remove: () => void } | null = null;

export function startSyncOrchestrator(): () => void {
  appStateSub?.remove();
  let previous: AppStateStatus = AppState.currentState;
  appStateSub = AppState.addEventListener('change', (next) => {
    // Compared, not regex-matched. `AppState.currentState` is documented as
    // possibly null at startup (and is not a string under jest), so calling
    // `.match` on it throws — taking the foreground trigger down with it, and
    // silently, since this runs inside a listener nobody awaits. A test found
    // this before a device did.
    const wasAway = previous === 'background' || previous === 'inactive';
    const returned = wasAway && next === 'active';
    previous = next;
    if (!returned) return;
    // A resume is also the moment to re-check what is waiting: the app may
    // have been killed and relaunched with rows still dirty.
    void refreshPending().then(() => {
      if (state.pending > 0 || !state.online) request('foreground');
    });
  });
  return () => {
    appStateSub?.remove();
    appStateSub = null;
    cancelTimer();
  };
}

/**
 * Sync state, for anything that wants to say something about it.
 *
 * A subscription rather than a context: the orchestrator is module state
 * because timers and the AppState listener live outside React, and wrapping
 * that in a provider would only add a layer that forwards it.
 */
export function useSyncState(): SyncState {
  const [s, setS] = useState<SyncState>(syncState);
  useEffect(() => subscribeSync(setS), []);
  return s;
}

/**
 * Sync now, and tell me how it went.
 *
 * For the one place a person explicitly asked — a Retry button. Everything
 * else should use `request`, which is allowed to decide that now is not the
 * moment. This always attempts, and resolves when the attempt is over so the
 * caller can report the outcome rather than guessing.
 */
export async function syncNow(): Promise<SyncState> {
  if (!creds) return state;
  cancelTimer();
  failures = 0;
  // A LOOP, not a single await. `run`'s finally re-fires when `dirtyAgain` is
  // set, occupying `running` again in the same microtask that resolves our
  // await — so a single `await running` then hits `run`'s in-flight guard and
  // returns having done nothing, while reporting the previous run's error and
  // stopping the spinner. That interleaving is reachable on exactly the tap
  // this button exists for: every foreground with pending rows sets
  // `dirtyAgain`.
  while (running) await running.catch(() => {});
  await run('manual').catch(() => {});
  return state;
}
