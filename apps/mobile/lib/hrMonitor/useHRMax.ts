import { useEffect, useState } from 'react';

import { fetchHRMax, type HRMaxResolution } from '../hrMax';
import type { TokenGetter } from '../useAuthToken';

/**
 * The athlete's HRmax and where it came from, for colouring a live number by
 * zone.
 *
 * **N528/#958 read only the `220 − age` seed; N535/#966 made it the full
 * resolution** — the observed maximum from the athlete's own sessions when
 * there is one, the age estimate otherwise, and `unresolved` when there is
 * neither. `null` while the answer is still in flight, or when the request
 * failed: the bpm then renders with no zone colour rather than against a
 * guessed ceiling, which is the same "we have the beats but not the scale"
 * honesty the number itself already had.
 *
 * Returning the resolution rather than a bare number is what lets a caller
 * that wants to say WHICH maximum it is colouring against do so; callers that
 * only need the beats read `.bpm` off it (see `hrMaxBpmOf`).
 */
export function useHRMax(getToken: TokenGetter, enabled: boolean): HRMaxResolution | null {
  const [hrMax, setHRMax] = useState<HRMaxResolution | null>(null);
  useEffect(() => {
    if (!enabled) return;
    let live = true;
    fetchHRMax(getToken, new Date())
      .then((r) => {
        if (live) setHRMax(r);
      })
      .catch(() => {
        // Offline — no zone colour this time; the number itself is unaffected.
      });
    return () => {
      live = false;
    };
  }, [getToken, enabled]);
  return hrMax;
}

/** The beats, or null when there is no usable maximum — what the zone
 *  classifier and the live indicator take. */
export function hrMaxBpmOf(r: HRMaxResolution | null): number | null {
  return r == null || r.kind === 'unresolved' ? null : r.bpm;
}
