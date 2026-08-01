import { useAuth } from '@clerk/clerk-expo';
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';

import { PREF_TRACK_EFFORT, PREF_TRACK_EFFORT_OWED, readPref, writePref } from './prefs';
import { getProfile, setTrackEffort as pushTrackEffort } from './profile';
import { useAuthToken } from './useAuthToken';

/**
 * Whether to collect RIR and RPE — once, for the whole app.
 *
 * Collapsed from a per-call-site hook for the same reason `useUnits` was: two
 * screens each held their own copy and each fetched the profile to resolve it.
 * Fewer copies than units had, and a boolean can't render a wrong *number*, so
 * this one never produced a visible bug — but it is the same shape, and the
 * shape is what keeps costing us.
 *
 * **It also had a bug units did not**, and this is the substantive half of the
 * change: there was no record of a local choice that hadn't reached the
 * account. Turning effort off with no signal pushed to the server, failed, and
 * had the failure swallowed — then the next successful profile read did
 * `setOn(p.track_effort)` and overwrote the cache with the server's stale
 * `true`. The switch turned itself back on, minutes later, with nothing said.
 * `useUnits` carries an `owed` flag precisely to stop that, and its comment
 * describes this exact failure; this file was written from the same template
 * and left the flag out.
 *
 * So the rules here now match units:
 *
 *  - the local cache is what the UI reads and writes, and is authoritative
 *    while a push is owed;
 *  - the server's value is adopted only when nothing is owed — otherwise the
 *    server holds the *stale* value and we retry the push instead;
 *  - `unsynced` is surfaced rather than swallowed, because "changed on this
 *    phone only" is a materially different outcome from "changed".
 */

type TrackEffortState = {
  trackEffort: boolean;
  setTrackEffort: (on: boolean) => Promise<void>;
  /** The choice is applied here but hasn't reached the account. */
  unsynced: boolean;
};

const TrackEffortContext = createContext<TrackEffortState>({
  // Defaults on: the progression rule has no other input, and silently
  // withholding it would make the app look broken rather than simple.
  trackEffort: true,
  setTrackEffort: async () => {},
  unsynced: false,
});

export function TrackEffortProvider({ children }: { children: React.ReactNode }) {
  const { userId } = useAuth();
  const getToken = useAuthToken();
  const [on, setOn] = useState(true);
  const [unsynced, setUnsynced] = useState(false);

  // Readable from inside an in-flight promise; comparing a captured copy
  // against the closed-over `userId` compares a value with itself.
  const currentUser = useRef(userId);
  useEffect(() => {
    currentUser.current = userId;
  }, [userId]);

  useEffect(() => {
    let alive = true;
    (async () => {
      if (!userId) {
        // This provider sits above the navigator and never remounts, so a
        // retained value is the previous athlete's preference.
        if (alive) {
          setOn(true);
          setUnsynced(false);
        }
        return;
      }
      const forUser = userId;
      const cached = await readPref(userId, PREF_TRACK_EFFORT);
      const owed = (await readPref(userId, PREF_TRACK_EFFORT_OWED)) === '1';
      if (!alive || forUser !== currentUser.current) return;
      if (cached !== null) setOn(cached === 'on');
      if (owed) setUnsynced(true);

      try {
        const p = await getProfile(getToken);
        if (!alive || forUser !== currentUser.current) return;

        if (owed && cached !== null && (cached === 'on') !== p.track_effort) {
          // The device holds a choice the account has never heard, so the
          // server's value is the stale one. Adopting it would silently undo
          // what the athlete asked for. Retry the push instead.
          await pushTrackEffort(getToken, cached === 'on');
        } else if (!owed) {
          setOn(p.track_effort);
          await writePref(userId, PREF_TRACK_EFFORT, p.track_effort ? 'on' : 'off');
        }

        if (owed) {
          await writePref(userId, PREF_TRACK_EFFORT_OWED, '0');
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

  const setTrackEffort = useCallback(
    async (next: boolean) => {
      // Applied and persisted locally first, so the switch never lies about
      // its own state and the session screen honours it immediately.
      setOn(next);
      try {
        if (userId) await writePref(userId, PREF_TRACK_EFFORT, next ? 'on' : 'off');
      } catch {
        // In-memory only for this launch. Must not reject: the caller is an
        // onPress, and an escaping rejection is an unhandled rejection.
      }
      try {
        await pushTrackEffort(getToken, next);
        if (userId) await writePref(userId, PREF_TRACK_EFFORT_OWED, '0').catch(() => {});
        setUnsynced(false);
      } catch {
        if (userId) await writePref(userId, PREF_TRACK_EFFORT_OWED, '1').catch(() => {});
        setUnsynced(true);
      }
    },
    [getToken, userId],
  );

  const value = useMemo(
    () => ({ trackEffort: on, setTrackEffort, unsynced }),
    [on, setTrackEffort, unsynced],
  );
  return <TrackEffortContext.Provider value={value}>{children}</TrackEffortContext.Provider>;
}

export function useTrackEffort(): TrackEffortState {
  return useContext(TrackEffortContext);
}
