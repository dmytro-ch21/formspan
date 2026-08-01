import { useAuth } from '@clerk/clerk-expo';
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';

import { PREF_UNIT_SYSTEM, PREF_UNIT_SYSTEM_OWED, readPref, writePref } from './prefs';
import { getProfile, updateUnitSystem } from './profile';
import type { UnitSystem } from './units';
import { useAuthToken } from './useAuthToken';

/**
 * The athlete's display units — once, for the whole app.
 *
 * **This was a hook, and that was the bug.** `useUnits()` was called from six
 * screens, and each call site got its *own* `useState<UnitSystem>('metric')`
 * and its *own* `GET /v1/profile`. So the app held six independent copies of
 * one account-level enum, each starting at metric and resolving at its own
 * pace. The report was precise about the symptom: *"when a workout is finished
 * in today section it shows volume as tonnage not the lbs? why it is not
 * consistent?"* — from an athlete whose account was already set to imperial.
 *
 * Two things went wrong at once, and both are fixed by there being one copy:
 *
 * 1. **Every screen began at `metric`** and corrected itself a frame later,
 *    once its own async cache read resolved. A finished-session summary is
 *    rendered at mount, which is exactly that frame — so a big number appeared
 *    as "1.5t" and only then became "3,300lb".
 * 2. **Screens disagreed with each other**, because six resolutions racing six
 *    profile fetches do not land together. One screen showing pounds beside
 *    another showing kilograms is the "not consistent" in the report.
 *
 * It is also the same shape as a bug this codebase has already paid for on
 * web, where `useUnits` per call site cost one profile request per session
 * rendered — 200 of them — and is documented in
 * `apps/web/src/app/dashboard/sessions/page.tsx`.
 *
 * `unitsReady` exists so a unit-bearing number is never printed in a unit we
 * have not established yet. The wait is a local SQLite read, not a network call, so
 * in practice it is one frame — but rendering "1.5t" to someone who thinks in
 * pounds, even briefly, is the whole complaint.
 *
 * The offline and `owed` behaviour below is carried over unchanged; it was
 * already right, it was just being run six times.
 */

type UnitsState = {
  units: UnitSystem;
  /**
   * False until the cache has been consulted.
   *
   * NOT "until the server answered" — offline the cache *is* the answer, and
   * blocking on the network would put a spinner in front of a preference.
   *
   * Named `unitsReady` rather than `ready` because the screens that read it
   * already have a `ready`/`everLoaded` of their own.
   */
  unitsReady: boolean;
  setUnits: (u: UnitSystem) => Promise<void>;
  /**
   * The choice is applied on this device but hasn't reached the account.
   *
   * Worth surfacing rather than swallowing: the preference is supposed to
   * follow you to the web app and to a new phone, so "changed here only" is a
   * materially different outcome from "changed".
   */
  unsynced: boolean;
};

const UnitsContext = createContext<UnitsState>({
  units: 'metric',
  unitsReady: false,
  setUnits: async () => {},
  unsynced: false,
});

export function UnitsProvider({ children }: { children: React.ReactNode }) {
  const { userId } = useAuth();
  const getToken = useAuthToken();
  const [units, setLocal] = useState<UnitSystem>('metric');
  const [unitsReady, setReady] = useState(false);
  const [unsynced, setUnsynced] = useState(false);

  // The current account, readable from inside an in-flight promise. Comparing
  // a captured copy against a closed-over `userId` compares a value with
  // itself — the mistake ModulesProvider was caught making.
  const currentUser = useRef(userId);
  useEffect(() => {
    currentUser.current = userId;
  }, [userId]);

  useEffect(() => {
    let alive = true;
    (async () => {
      if (!userId) {
        // Signed out. Reset rather than retain: this provider sits above the
        // navigator and never remounts, so a kept value is the PREVIOUS
        // athlete's preference.
        if (alive) {
          setLocal('metric');
          setUnsynced(false);
          setReady(false);
        }
        return;
      }
      const forUser = userId;
      const cached = await readPref(userId, PREF_UNIT_SYSTEM);
      const local = cached === 'metric' || cached === 'imperial' ? cached : null;
      const owed = (await readPref(userId, PREF_UNIT_SYSTEM_OWED)) === '1';
      if (!alive || forUser !== currentUser.current) return;
      if (local) setLocal(local);
      if (owed) setUnsynced(true);
      // Ready once the CACHE has been consulted. Offline, that is the answer.
      setReady(true);

      try {
        const p = await getProfile(getToken);
        if (!alive || forUser !== currentUser.current) return;

        if (owed && local && local !== p.unit_system) {
          // The device holds a choice the account has never heard, so the
          // server's value is the *stale* one. Adopting it here would silently
          // undo what the athlete explicitly asked for — change units offline,
          // leave Settings, come back online, and the setting reverts with
          // nothing said. Retry the push instead; if it fails we stay owed.
          await updateUnitSystem(getToken, local);
        } else if (!owed) {
          setLocal(p.unit_system);
          await writePref(userId, PREF_UNIT_SYSTEM, p.unit_system);
        }

        if (owed) {
          await writePref(userId, PREF_UNIT_SYSTEM_OWED, '0');
          if (alive) setUnsynced(false);
        }
      } catch {
        // Offline, or the retry failed: the local value stands and stays owed.
      }
    })();
    return () => {
      alive = false;
    };
  }, [userId, getToken]);

  const setUnits = useCallback(
    async (u: UnitSystem) => {
      // Applied locally first so the whole app switches instantly; the
      // account-level write follows.
      setLocal(u);
      try {
        if (userId) await writePref(userId, PREF_UNIT_SYSTEM, u);
      } catch {
        // Leaves the switch applied in memory only — it won't survive a
        // restart. Nothing here can recover that, but it must not reject: the
        // caller is an onPress, so an escaping rejection is an unhandled
        // rejection.
      }
      try {
        await updateUnitSystem(getToken, u);
        if (userId) await writePref(userId, PREF_UNIT_SYSTEM_OWED, '0').catch(() => {});
        setUnsynced(false);
      } catch {
        // The debt is written to SQLite rather than kept in component state,
        // because Settings is a screen people leave straight away: an
        // in-memory flag would stop admitting the change was local-only while
        // it still was, and would let the next mount's profile read quietly
        // revert the choice.
        if (userId) await writePref(userId, PREF_UNIT_SYSTEM_OWED, '1').catch(() => {});
        setUnsynced(true);
      }
    },
    [getToken, userId],
  );

  const value = useMemo(
    () => ({ units, unitsReady, setUnits, unsynced }),
    [units, unitsReady, setUnits, unsynced],
  );
  return <UnitsContext.Provider value={value}>{children}</UnitsContext.Provider>;
}

export function useUnits(): UnitsState {
  return useContext(UnitsContext);
}
