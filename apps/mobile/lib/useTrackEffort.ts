import { useCallback, useEffect, useState } from 'react';

import { useAuth } from '@clerk/clerk-expo';

import { readPref, writePref } from './prefs';
import { getProfile, setTrackEffort as pushTrackEffort } from './profile';
import { useAuthToken } from './useAuthToken';

const PREF = 'track_effort';

/**
 * Whether to collect RIR and RPE, cached locally.
 *
 * Mirrors `useUnits`, and for the reason that bit us: the first version read
 * and wrote the profile directly, so with no API reachable the toggle
 * flipped and snapped straight back — indistinguishable from a broken
 * switch. In an offline-first app a *preference* is the last thing that
 * should need a server.
 *
 * So the local cache is what the UI reads and writes, and the account-level
 * write is opportunistic. It still belongs on the profile rather than being
 * purely local, because it changes what the web app collects too.
 */
export function useTrackEffort(): {
  trackEffort: boolean;
  setTrackEffort: (on: boolean) => Promise<void>;
} {
  const { userId } = useAuth();
  const getToken = useAuthToken();
  // Defaults on: the progression rule has no other input, and silently
  // withholding it would make the app look broken rather than simple.
  const [on, setOn] = useState(true);

  useEffect(() => {
    let alive = true;
    (async () => {
      if (!userId) return;
      const cached = await readPref(userId, PREF);
      if (alive && cached !== null) setOn(cached === 'on');
      try {
        const p = await getProfile(getToken);
        if (!alive) return;
        setOn(p.track_effort);
        await writePref(userId, PREF, p.track_effort ? 'on' : 'off');
      } catch {
        // Offline: the cache is the answer.
      }
    })();
    return () => {
      alive = false;
    };
  }, [userId, getToken]);

  const set = useCallback(
    async (next: boolean) => {
      // Applied and persisted locally first, so the switch never lies about
      // its own state and the session screen honours it immediately.
      setOn(next);
      if (userId) await writePref(userId, PREF, next ? 'on' : 'off');
      await pushTrackEffort(getToken, next).catch(() => {
        // The local value stands; the next successful profile read
        // reconciles it.
      });
    },
    [getToken, userId],
  );

  return { trackEffort: on, setTrackEffort: set };
}
