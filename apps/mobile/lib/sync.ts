import { useEffect, useState } from 'react';
import { AppState, type AppStateStatus } from 'react-native';

import { isOffline } from './apiError';
import { countPendingSessions, syncSessions } from './sessionStore';
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
  for (const l of listeners) l(state);
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
    emit({ syncing: false, pending: 0, lastError: null, lastSyncAt: null });
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

/** Recount what's waiting, without syncing. Cheap: one indexed COUNT. */
export async function refreshPending(): Promise<void> {
  if (!creds) return;
  try {
    emit({ pending: await countPendingSessions(creds.userID) });
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
  emit({ syncing: true });

  running = (async () => {
    let retry = false;
    try {
      const result = await syncSessions(userID, getToken);
      // The account may have changed while this ran.
      if (creds?.userID !== userID) return;

      if (result.failed > 0) {
        failures++;
        emit({
          lastError: result.error ?? 'Sync failed.',
          // A failure whose cause was reachability tells us we are offline;
          // a 4xx does not — the server answered, it just refused.
          online: result.error ? !/reach VOLA/i.test(result.error) : state.online,
        });
        retry = true;
      } else {
        failures = 0;
        emit({ lastError: null, lastSyncAt: Date.now(), online: true });
      }
    } catch (err) {
      failures++;
      emit({
        lastError: err instanceof Error ? err.message : String(err),
        online: !isOffline(err),
      });
      retry = true;
    } finally {
      emit({ syncing: false });
      // Recount BEFORE deciding to retry. `schedule()` refuses to set a timer
      // with nothing pending, and reading a stale count here would skip the
      // retry for exactly the rows that need it — a session created moments
      // ago whose count hadn't been refreshed yet still reads as 0.
      await refreshPending();
      if (retry) schedule();
    }
  })();

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
  const wait = BACKOFF_MS[Math.min(failures - 1, BACKOFF_MS.length - 1)];
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
    const returned = previous.match(/inactive|background/) && next === 'active';
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
  if (running) await running.catch(() => {});
  await run('manual').catch(() => {});
  return state;
}
