import { PREF_HR_MONITOR, readPref, writePref } from '../prefs';

/**
 * N528/#958 — the one heart-rate monitor this athlete has paired, remembered
 * on this phone. The backend never learns its name (`source` is the closed
 * `hr_monitor` value); this is where "from your Amazfit GTR 4" comes from.
 */
export type RememberedMonitor = {
  /** The platform's device id — a CoreBluetooth UUID on iOS, a MAC on
   *  Android — which is why it is per-phone, not synced. */
  id: string;
  /** The advertised name at pairing time, e.g. "Amazfit GTR 4". */
  name: string;
  /** RFC3339. */
  rememberedAt: string;
};

/** Pure: what a pref value decodes to. Anything malformed reads as "none",
 *  never as a half-device. */
export function parseRememberedMonitor(raw: string | null): RememberedMonitor | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as Partial<RememberedMonitor>;
    if (typeof v.id !== 'string' || v.id === '' || typeof v.name !== 'string') return null;
    return { id: v.id, name: v.name || 'Heart-rate monitor', rememberedAt: typeof v.rememberedAt === 'string' ? v.rememberedAt : '' };
  } catch {
    return null;
  }
}

export async function readRememberedMonitor(userID: string): Promise<RememberedMonitor | null> {
  return parseRememberedMonitor(await readPref(userID, PREF_HR_MONITOR));
}

export async function rememberMonitor(userID: string, device: { id: string; name: string }, now: Date = new Date()): Promise<RememberedMonitor> {
  const m: RememberedMonitor = { id: device.id, name: device.name || 'Heart-rate monitor', rememberedAt: now.toISOString() };
  await writePref(userID, PREF_HR_MONITOR, JSON.stringify(m));
  return m;
}

export async function forgetMonitor(userID: string): Promise<void> {
  await writePref(userID, PREF_HR_MONITOR, '');
}
