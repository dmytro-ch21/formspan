import { useEffect, useState, useSyncExternalStore } from 'react';

import { LIVE_HR_STALE_AFTER_MS, isLiveReadingFresh, type LiveHRState } from './heartRateProfile';
import { getLiveHR, subscribeLiveHR } from './liveHR';

/** The live heart-rate state, re-rendering on every store change. */
export function useLiveHR(): LiveHRState {
  return useSyncExternalStore(subscribeLiveHR, getLiveHR, getLiveHR);
}

/**
 * Whether the number may be shown as current — re-evaluated on a timer so a
 * stream that silently stops (monitor taken off, no disconnect event yet)
 * dims within `LIVE_HR_STALE_AFTER_MS` rather than looking alive forever.
 */
export function useLiveHRFresh(state: LiveHRState): boolean {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (state.status !== 'connected') return;
    const id = setInterval(() => setNow(Date.now()), LIVE_HR_STALE_AFTER_MS / 2);
    return () => clearInterval(id);
  }, [state.status]);
  return isLiveReadingFresh(state, new Date(Math.max(now, state.at ? new Date(state.at).getTime() : 0)));
}
