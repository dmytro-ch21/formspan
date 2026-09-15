import { useEffect, useRef } from 'react';
import { AppState } from 'react-native';

import type { Countdown } from './countdown';
import {
  cancelRestLockAlert,
  isAway,
  lockAlertPlan,
  readAlertPermission,
  readRestLockAlertEnabled,
  scheduleRestLockAlert,
} from './restLockAlert';

/**
 * Keeps the rest timer's lock-screen alert in step with the countdown and the
 * app's state — N195 (#612). The decisions are `lockAlertPlan`'s; this is only
 * when to ask it, and in what order to act.
 *
 * **In the foreground this does nothing at all** — no native call, no pref
 * read. It acts on an AppState change, on a countdown that changes while the
 * app is away, and on unmount. Nothing on the set-logging path waits on it.
 *
 * ## The work is SERIALISED, and that is the stale-notification guard
 *
 * Scheduling is two awaits (preference, permission) and one native call. An
 * athlete who locks the phone and unlocks it a moment later produces
 * `background` then `active` inside that window. Run concurrently, the cancel
 * could land first and the schedule after it, leaving an alert armed for a
 * rest that is already back on screen — the one outcome the ticket calls
 * worse than none. A promise chain makes the cancel wait its turn.
 *
 * `armed` spares the native cancel when nothing was scheduled by this mount.
 * Something scheduled by a previous process is cleared at launch instead.
 */
export function useRestLockAlert(timer: Countdown | null, userId: string | null | undefined): void {
  const timerRef = useRef(timer);
  const userRef = useRef(userId);
  const armedRef = useRef(false);
  const chainRef = useRef<Promise<void>>(Promise.resolve());

  // Written from effects, not render — the repo's `react-hooks/refs` rule, and
  // because render can run without committing.
  const reconcileRef = useRef<(appState: string) => void>(() => {});
  useEffect(() => {
    reconcileRef.current = (appState: string) => {
      chainRef.current = chainRef.current.then(async () => {
        if (!isAway(appState)) {
          if (armedRef.current) {
            armedRef.current = false;
            await cancelRestLockAlert();
          }
          return;
        }
        const uid = userRef.current;
        let enabled = false;
        try {
          enabled =
            !!uid &&
            (await readRestLockAlertEnabled(uid)) &&
            (await readAlertPermission()) === 'granted';
        } catch {
          // Unreadable preference or permission: no alert, which is the default.
        }
        const plan = lockAlertPlan({ appState, timer: timerRef.current, enabled, now: Date.now() });
        if (plan.kind === 'schedule') {
          armedRef.current = true;
          try {
            await scheduleRestLockAlert(plan);
          } catch {
            // A failed schedule is a missing alert, never a broken screen.
          }
        } else if (armedRef.current) {
          armedRef.current = false;
          await cancelRestLockAlert();
        }
      });
    };
  });

  useEffect(() => {
    userRef.current = userId;
  }, [userId]);

  useEffect(() => {
    timerRef.current = timer;
    // A countdown that changes while the app is away (a guided run stepping on
    // while `inactive`) is re-planned. On screen, a tap on +15, Skip or Stop
    // reaches `reconcile` as `active`, whose branch returns before any read or
    // native call, because nothing can be armed while the app is active.
    // Deliberately not guarded here as well: a second guard with the same
    // outcome is one no test can tell apart from dead code.
    reconcileRef.current(AppState.currentState);
  }, [timer]);

  useEffect(() => {
    const sub = AppState.addEventListener('change', (s) => reconcileRef.current(s));
    return () => {
      sub.remove();
      // Leaving the session screen ends the rest, so it ends the alert too.
      reconcileRef.current('active');
    };
  }, []);
}
