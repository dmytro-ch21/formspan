import { useCallback, useEffect, useState } from 'react';

import { useAuth } from '@clerk/clerk-expo';

import { PREF_UNIT_SYSTEM, PREF_UNIT_SYSTEM_OWED, readPref, writePref } from './prefs';
import { getProfile, updateUnitSystem } from './profile';
import type { UnitSystem } from './units';
import { useAuthToken } from './useAuthToken';

/**
 * The athlete's display units.
 *
 * Read from the local cache first so the session screen renders correctly
 * with no signal — showing kilograms to someone who thinks in pounds, purely
 * because the phone is offline, would be a worse failure than showing
 * nothing. The server is then consulted and the cache refreshed, because the
 * preference belongs to the account and has to follow them to the web app
 * and to a new phone.
 */
export function useUnits(): {
  units: UnitSystem;
  setUnits: (u: UnitSystem) => Promise<void>;
  /**
   * The choice is applied on this device but hasn't reached the account.
   *
   * Worth surfacing rather than swallowing: the preference is supposed to
   * follow you to the web app and to a new phone, so "changed here only" is a
   * materially different outcome from "changed".
   */
  unsynced: boolean;
} {
  const { userId } = useAuth();
  const getToken = useAuthToken();
  const [units, setLocal] = useState<UnitSystem>('metric');
  const [unsynced, setUnsynced] = useState(false);

  useEffect(() => {
    let alive = true;
    (async () => {
      if (!userId) return;
      const cached = await readPref(userId, PREF_UNIT_SYSTEM);
      const local = cached === 'metric' || cached === 'imperial' ? cached : null;
      const owed = (await readPref(userId, PREF_UNIT_SYSTEM_OWED)) === '1';
      if (!alive) return;
      if (local) setLocal(local);
      if (owed) setUnsynced(true);

      try {
        const p = await getProfile(getToken);
        if (!alive) return;

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

        // Either the retry landed, or the server already agreed with us.
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
        // restart. Nothing here can recover that, but it must not reject:
        // the caller is `onPress={() => setUnits(u.key)}`, so an escaping
        // rejection is the same unhandled-rejection shape this change fixes
        // one block below.
      }
      try {
        await updateUnitSystem(getToken, u);
        if (userId) await writePref(userId, PREF_UNIT_SYSTEM_OWED, '0').catch(() => {});
        setUnsynced(false);
      } catch {
        // Previously unguarded, which offline meant an unhandled promise
        // rejection *and* a change that silently never reached the account —
        // the tick moved, the web app never heard, and nothing said so.
        //
        // The debt is written to SQLite rather than kept in component state,
        // because Settings is a screen people leave straight away: an
        // in-memory flag would stop admitting the change was local-only while
        // it still was, and would let the next mount's profile read quietly
        // revert the choice. Retried on mount; a general preference outbox
        // arrives with the sync orchestrator.
        if (userId) await writePref(userId, PREF_UNIT_SYSTEM_OWED, '1').catch(() => {});
        setUnsynced(true);
      }
    },
    [getToken, userId],
  );

  return { units, setUnits, unsynced };
}
