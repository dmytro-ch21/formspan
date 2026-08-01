import { useAuth } from '@clerk/clerk-expo';
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';

import { fetchModules, type Module } from './modules';
import { PREF_MODULES, readPref, writePref } from './prefs';
import { useAuthToken } from './useAuthToken';

/**
 * The user's enabled disciplines, available everywhere and settled before the
 * first frame.
 *
 * A context rather than a hook-per-screen, for a reason the codebase has
 * already paid for once: `useUnits` fetches the profile per call site with no
 * shared cache, which cost *one `GET /v1/profile` per session rendered* — 200
 * identical requests for one account-level enum. Module state is needed by the
 * tab bar and by every tab, so the same shape would be worse.
 *
 * **Cached in `prefs` and read before the first render**, following
 * `useTrackEffort`. Not an optimisation: the tab bar is built from this, so a
 * value that arrives one render late means the tabs visibly rearrange on every
 * cold start. `ready` exists so the shell can hold a frame rather than show the
 * wrong one — the same trick `app/_layout.tsx` already uses for Clerk.
 *
 * Offline, the cache IS the answer. A preference is the last thing that should
 * need a server.
 */

type ModulesState = {
  modules: Module[];
  /** False until we've read the cache — hold the UI, don't guess. */
  ready: boolean;
  /** True when the last server refresh failed and we're serving the cache. */
  stale: boolean;
  refresh: () => Promise<void>;
};

const ModulesContext = createContext<ModulesState>({
  modules: [],
  ready: false,
  stale: false,
  refresh: async () => {},
});

export function ModulesProvider({ children }: { children: React.ReactNode }) {
  const { userId } = useAuth();
  const getToken = useAuthToken();
  const [modules, setModules] = useState<Module[]>([]);
  const [ready, setReady] = useState(false);
  const [stale, setStale] = useState(false);

  const refresh = useCallback(async () => {
    if (!userId) return;
    try {
      const fresh = await fetchModules(getToken);
      setModules(fresh);
      setStale(false);
      // Whole set in one key. Per-module keys would mean N reads before the
      // first paint, which is the thing this cache exists to avoid.
      await writePref(userId, PREF_MODULES, JSON.stringify(fresh));
    } catch {
      // The cache stands. Deliberately not surfaced as an error: a disabled
      // discipline reappearing is confusing, but a whole app refusing to draw
      // because a preference endpoint blinked is worse.
      setStale(true);
    }
  }, [getToken, userId]);

  useEffect(() => {
    let alive = true;
    (async () => {
      if (!userId) {
        // Signed out. Not "no modules" — `ready` stays false so nothing
        // renders a tab bar built from an empty list.
        if (alive) setReady(false);
        return;
      }
      const cached = await readPref(userId, PREF_MODULES);
      if (alive && cached) {
        try {
          setModules(JSON.parse(cached) as Module[]);
        } catch {
          // A corrupt cache is not worth blocking on; the refresh below
          // replaces it.
        }
      }
      // Ready once the CACHE has been consulted, not once the server answers.
      // Waiting for the network here would put a spinner in front of the whole
      // app every cold start, offline or not.
      if (alive) setReady(true);
      await refresh();
    })();
    return () => {
      alive = false;
    };
  }, [userId, refresh]);

  const value = useMemo(
    () => ({ modules, ready, stale, refresh }),
    [modules, ready, stale, refresh],
  );
  return <ModulesContext.Provider value={value}>{children}</ModulesContext.Provider>;
}

export function useModules(): ModulesState {
  return useContext(ModulesContext);
}

/**
 * Whether a discipline is on.
 *
 * Unknown keys return **false**, deliberately. This is the guard for a
 * persisted filter naming a discipline that has since been turned off, and for
 * a build that predates a discipline the server knows about — in both cases
 * hiding is the safe answer, because showing would mean rendering a chip whose
 * content can't load.
 */
export function useModuleEnabled(key: string): boolean {
  const { modules } = useModules();
  return modules.some((m) => m.key === key && m.enabled);
}
