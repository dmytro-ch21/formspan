import { AppState, type AppStateStatus } from 'react-native';

import type { TokenGetter } from '../useAuthToken';
import { flushHRMonitorSamples } from './hrRecorder';
import { readRememberedMonitor } from './hrMonitorStore';
import { isBluetoothSupported, startLiveHR, stopLiveHR } from './liveHR';

/**
 * N528/#958 — keeps the live link alive while the app is open and there is a
 * remembered monitor: connect on foreground, drop on background (foreground
 * only, by the config plugin's `isBackgroundEnabled: false` — there is no
 * background mode to keep it alive, and no reason to: a session runs with the
 * screen on). Also flushes any recorded samples still owed to the server on
 * each foreground, so a session finished offline uploads when signal returns.
 *
 * Same shape as `startBiometricSyncOrchestrator`: one identity, one AppState
 * listener, returns the stop function. Identity changes stop the old link.
 */
let identity: { userID: string; getToken: TokenGetter } | null = null;

export function setHRMonitorIdentity(userID: string | null, getToken: TokenGetter | null): void {
  if (!userID || !getToken) {
    identity = null;
    void stopLiveHR();
    return;
  }
  identity = { userID, getToken };
}

/** Called by Settings after pairing/forgetting, so the link follows the
 *  athlete's choice without waiting for the next foreground. */
export async function connectIfRemembered(): Promise<void> {
  const id = identity;
  if (!id || !isBluetoothSupported()) return;
  const remembered = await readRememberedMonitor(id.userID);
  if (!remembered) {
    await stopLiveHR();
    return;
  }
  await startLiveHR({ id: remembered.id, name: remembered.name });
}

export function startHRMonitorOrchestrator(): () => void {
  const onChange = (next: AppStateStatus) => {
    if (next === 'active') {
      // W21/#992: NO auto-connect here any more. The link is opened by the
      // run that needs it (`app/running/[id].tsx`) and closed when that run
      // ends, so neither battery pays for a monitor nobody is reading. A
      // foregrounded app with a paired strap and no run in progress holds no
      // connection at all.
      const id = identity;
      if (id) {
        void flushHRMonitorSamples(id.userID, id.getToken).catch(() => {
          // Offline — next foreground.
        });
      }
    } else if (next === 'background') {
      void stopLiveHR();
    }
  };
  const sub = AppState.addEventListener('change', onChange);
  if (AppState.currentState === 'active') onChange('active');
  return () => {
    sub.remove();
    void stopLiveHR();
  };
}
