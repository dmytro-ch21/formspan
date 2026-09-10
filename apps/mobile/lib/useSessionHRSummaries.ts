import { useEffect, useState } from 'react';

import { readSessionHRSummaries, type SessionHRSummary } from './sessionHR';

/**
 * N547/#990 — the cached heart rate for a list of sessions, for the surfaces
 * that draw a summary line.
 *
 * One batched read of `session_hr_summary`, not one per row: the callers are
 * lists, and a query per visible row is the shape the cache exists to avoid.
 * Reintroducing it against SQLite instead of the network would be the same
 * mistake, quieter.
 *
 * Starts empty and stays empty on failure, which is exactly right — an absent
 * entry means "not known" and `hrSummaryEntry` prints nothing for it. Heart
 * rate appearing a moment after the rows do is the correct trade: the rows
 * are the athlete's own logged sessions and must not wait on a biometric
 * cache to render at all.
 */
/**
 * One shared empty map, returned whenever there is nothing to look up.
 *
 * A module constant rather than `new Map()` per render: the value is handed
 * to components as a prop, so a fresh identity every render would make every
 * consumer re-render for a map that has not changed.
 */
const EMPTY: ReadonlyMap<string, SessionHRSummary> = new Map();

export function useSessionHRSummaries(
  userID: string | null | undefined,
  sessionIDs: string[],
): Map<string, SessionHRSummary> {
  const [hr, setHR] = useState<Map<string, SessionHRSummary>>(EMPTY as Map<string, SessionHRSummary>);
  // The ids, as one value, so the effect re-runs when the LIST changes rather
  // than on every render that rebuilds the array.
  const key = sessionIDs.join(',');
  const enabled = !!userID && key.length > 0;

  useEffect(() => {
    // Deliberately NO synchronous `setHR` on the disabled branch. Setting
    // state during an effect is what `react-hooks/set-state-in-effect` warns
    // about — it schedules a second render pass for a value already known at
    // render time — and this repo's lint ratchet only ever moves down, so the
    // warning is the design telling on itself rather than a number to raise.
    // The empty case is answered by the return below instead.
    if (!enabled || !userID) return;
    let live = true;
    readSessionHRSummaries(userID, key.split(','))
      .then((m) => {
        if (live) setHR(m);
      })
      .catch(() => {
        // Nothing to show is the honest fallback; the line simply omits it.
      });
    return () => {
      live = false;
    };
  }, [userID, key, enabled]);

  // While a NEW list is resolving, the previous map is still returned. That is
  // correct rather than stale: entries are keyed by session id, so a row still
  // on screen keeps its own value and a row that has gone simply is not asked
  // for.
  return enabled ? hr : (EMPTY as Map<string, SessionHRSummary>);
}
