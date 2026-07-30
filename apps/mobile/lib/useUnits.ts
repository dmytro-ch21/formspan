import { useCallback, useEffect, useState } from 'react';

import { useAuth } from '@clerk/clerk-expo';

import { PREF_UNIT_SYSTEM, readPref, writePref } from './prefs';
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
export function useUnits(): { units: UnitSystem; setUnits: (u: UnitSystem) => Promise<void> } {
  const { userId } = useAuth();
  const getToken = useAuthToken();
  const [units, setLocal] = useState<UnitSystem>('metric');

  useEffect(() => {
    let alive = true;
    (async () => {
      if (!userId) return;
      const cached = await readPref(userId, PREF_UNIT_SYSTEM);
      if (alive && (cached === 'metric' || cached === 'imperial')) setLocal(cached);
      try {
        const p = await getProfile(getToken);
        if (!alive) return;
        setLocal(p.unit_system);
        await writePref(userId, PREF_UNIT_SYSTEM, p.unit_system);
      } catch {
        // Offline: the cache is the answer.
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
      if (userId) await writePref(userId, PREF_UNIT_SYSTEM, u);
      await updateUnitSystem(getToken, u);
    },
    [getToken, userId],
  );

  return { units, setUnits };
}
