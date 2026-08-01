import { useAuth } from '@clerk/clerk-expo';
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';

import { fetchModules, normaliseModules, type Module } from './modules';
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
  /**
   * Adopt a set the caller already has — specifically the one PATCH /modules
   * returns. Without this, saving a toggle persisted server-side and nothing
   * in the app re-gated until the process restarted.
   */
  apply: (next: Module[]) => Promise<void>;
};

const ModulesContext = createContext<ModulesState>({
  modules: [],
  ready: false,
  stale: false,
  apply: async () => {},
});

export function ModulesProvider({ children }: { children: React.ReactNode }) {
  const { userId } = useAuth();
  const getToken = useAuthToken();
  const [modules, setModules] = useState<Module[]>([]);
  const [ready, setReady] = useState(false);
  const [stale, setStale] = useState(false);

  const refresh = useCallback(async () => {
    if (!userId) return;
    const forUser = userId;
    try {
      const fresh = await fetchModules(getToken);
      // The account may have changed while this was in flight. Without this,
      // A's server truth lands on B's screen after a fast sign-out/sign-in.
      if (forUser !== userId) return;
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

  const apply = useCallback(
    async (next: Module[]) => {
      setModules(next);
      setStale(false);
      if (userId) await writePref(userId, PREF_MODULES, JSON.stringify(next));
    },
    [userId],
  );

  useEffect(() => {
    let alive = true;
    (async () => {
      if (!userId) {
        // Signed out. Clear, don't just un-ready: the provider sits above the
        // navigator and never remounts, so a retained list is the PREVIOUS
        // athlete's configuration. On a shared device the next user would see
        // A's tabs, start buttons and chips — and if B is offline and has never
        // used this device, indefinitely, because the cache read finds nothing
        // and the refresh fails.
        if (alive) {
          setModules([]);
          setStale(false);
          setReady(false);
        }
        return;
      }
      // Same reason, for a switch rather than a sign-out.
      if (alive) setModules([]);
      const cached = await readPref(userId, PREF_MODULES);
      if (alive && cached) {
        try {
          // Through `normaliseModules`, not a bare cast. The cache is a parse
          // boundary like the wire is: a cache written by a build whose shape
          // differed would otherwise parse cleanly and then crash in render on
          // `m.capabilities.catalog`, on every launch, until it was overwritten.
          setModules(normaliseModules(JSON.parse(cached)));
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

  const value = useMemo(() => ({ modules, ready, stale, apply }), [modules, ready, stale, apply]);
  return <ModulesContext.Provider value={value}>{children}</ModulesContext.Provider>;
}

export function useModules(): ModulesState {
  return useContext(ModulesContext);
}

// `refresh` and a `useModuleEnabled` helper were exported here and consumed by
// nothing — the review's point that an unused export is a promise no code
// keeps. `refresh` stays internal (the mount effect uses it); the save path
// goes through `apply`, which needs no extra request because PATCH /modules
// already returns the merged set.
