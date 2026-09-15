import { useCallback, useEffect, useState } from 'react';
import { AppState, Platform } from 'react-native';

import {
  askAlertPermission,
  cancelRestLockAlert,
  readAlertPermission,
  readRestLockAlertEnabled,
  refusedLineFor,
  writeRestLockAlertEnabled,
  type AlertPermission,
} from './restLockAlert';

/**
 * The Settings row for the rest timer's lock-screen alert — N195 (#612).
 *
 * **Off by default, and asking is the athlete's act.** The permission prompt
 * appears only when the athlete turns the row ON: never on mount, never on a
 * return to the app, never from a session. Turning it OFF never asks anything.
 *
 * The switch shows ON only when both halves hold, the preference and the
 * phone's permission. A preference that says on while the phone refuses would
 * be a switch claiming an alert that cannot sound. So that state shows OFF,
 * with a line saying why and where to change it.
 *
 * The permission is re-read when the app becomes active again, because the
 * place to change it is the system Settings app, and coming back from there is
 * an AppState change, not a focus change.
 *
 * The discoverability cost is recorded, not hidden: an athlete who never opens
 * Settings never learns this exists. That is the price of never prompting.
 */
export function useRestLockAlertSetting(userId: string | null | undefined) {
  const [pref, setPref] = useState<boolean | null>(null);
  const [permission, setPermission] = useState<AlertPermission | null>(null);
  const [asking, setAsking] = useState(false);
  /** Refused just now, on this visit — so the line shows even though the pref is off. */
  const [refusedOnAsk, setRefusedOnAsk] = useState(false);

  // Both reads settle into state from their promise, the same shape as the
  // screen's other preference reads.
  useEffect(() => {
    if (!userId) return;
    readRestLockAlertEnabled(userId).then(setPref).catch(() => {});
    readAlertPermission().then(setPermission).catch(() => {});
  }, [userId]);

  useEffect(() => {
    const sub = AppState.addEventListener('change', (s) => {
      if (s === 'active') readAlertPermission().then(setPermission).catch(() => {});
    });
    return () => sub.remove();
  }, []);

  const setOn = useCallback(
    async (on: boolean) => {
      if (!userId) return;
      if (!on) {
        setPref(false);
        setRefusedOnAsk(false);
        await cancelRestLockAlert();
        await writeRestLockAlertEnabled(userId, false).catch(() => {});
        return;
      }
      setAsking(true);
      try {
        let perm = await readAlertPermission();
        // Ask only when the platform will actually show a prompt. A permanent
        // refusal is answered by the line below, not by a prompt that never
        // appears and a switch that silently flips back.
        if (perm === 'undetermined' || perm === 'denied-can-ask') perm = await askAlertPermission();
        const granted = perm === 'granted';
        setPermission(perm);
        setPref(granted);
        setRefusedOnAsk(!granted);
        await writeRestLockAlertEnabled(userId, granted);
      } catch {
        // Could not ask or could not save: leave it off, which is honest.
        setPref(false);
      } finally {
        setAsking(false);
      }
    },
    [userId],
  );

  const refused = permission === 'denied' || permission === 'denied-can-ask';
  return {
    /** What the switch shows. */
    value: pref === true && permission === 'granted',
    /** Not yet known, or a prompt is up. */
    busy: pref === null || permission === null || asking,
    /** Said only when the athlete wanted it: on in prefs, or refused on this visit. */
    refusedLine: refused && (pref === true || refusedOnAsk) ? refusedLineFor(Platform.OS, permission) : null,
    setOn,
  };
}
