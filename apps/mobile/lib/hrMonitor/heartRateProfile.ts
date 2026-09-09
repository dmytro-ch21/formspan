/**
 * N528/#958 — the Bluetooth Heart Rate Profile, as pure functions.
 *
 * GATT Heart Rate Service `0x180D`, Heart Rate Measurement characteristic
 * `0x2A37` (Bluetooth SIG, HRS 1.0 §3.1). Every Amazfit with "heart rate
 * broadcasting" on, every Garmin/Polar/Coros, every chest strap speaks
 * exactly this — which is why VOLA connects to "a heart-rate monitor", not
 * to a vendor. Nothing here touches Bluetooth; `liveHR.ts` does, and hands
 * the bytes in. Everything here is table-tested.
 */

/** 16-bit UUIDs, lower-case, as `react-native-ble-plx` normalises them. */
export const HEART_RATE_SERVICE_UUID = '0000180d-0000-1000-8000-00805f9b34fb';
export const HEART_RATE_MEASUREMENT_UUID = '00002a37-0000-1000-8000-00805f9b34fb';

export type HeartRateMeasurement = {
  bpm: number;
  /** `null` when the device does not report contact at all (flag bit 2). */
  sensorContact: boolean | null;
  /** RR intervals in milliseconds, oldest first; empty when not reported. */
  rrIntervalsMs: number[];
};

/**
 * Decodes one Heart Rate Measurement value (HRS §3.1.1). Layout, from the
 * flags byte: bit 0 — value is UINT16 (else UINT8); bits 1–2 — sensor contact
 * (bit 2 = supported, bit 1 = detected); bit 3 — energy expended field
 * present (UINT16, skipped); bit 4 — RR intervals present (UINT16 each, in
 * 1/1024 s). Returns `null` for a value too short to hold what its flags
 * claim, rather than a fabricated number.
 */
export function parseHeartRateMeasurement(bytes: Uint8Array): HeartRateMeasurement | null {
  if (bytes.length < 2) return null;
  const flags = bytes[0];
  const is16 = (flags & 0x01) !== 0;
  let i = 1;
  let bpm: number;
  if (is16) {
    if (bytes.length < 3) return null;
    bpm = bytes[1] | (bytes[2] << 8);
    i = 3;
  } else {
    bpm = bytes[1];
    i = 2;
  }
  const contactSupported = (flags & 0x04) !== 0;
  const sensorContact = contactSupported ? (flags & 0x02) !== 0 : null;
  if ((flags & 0x08) !== 0) {
    if (bytes.length < i + 2) return null;
    i += 2; // energy expended, kJ — not used
  }
  const rrIntervalsMs: number[] = [];
  if ((flags & 0x10) !== 0) {
    while (i + 1 < bytes.length) {
      const rr = bytes[i] | (bytes[i + 1] << 8);
      rrIntervalsMs.push(Math.round((rr * 1000) / 1024));
      i += 2;
    }
  }
  return { bpm, sensorContact, rrIntervalsMs };
}

/** `react-native-ble-plx` hands characteristic values over as base64. Hermes
 *  has `atob`, but a 20-line decoder costs nothing and never depends on the
 *  runtime having it. */
export function decodeBase64(value: string): Uint8Array {
  const table = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  const clean = value.replace(/[^A-Za-z0-9+/]/g, '');
  const out: number[] = [];
  let buffer = 0;
  let bits = 0;
  for (const ch of clean) {
    buffer = (buffer << 6) | table.indexOf(ch);
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out.push((buffer >> bits) & 0xff);
    }
  }
  return Uint8Array.from(out);
}

/** A reading older than this is stale — the number on screen dims and the
 *  status says so rather than showing a frozen value as live. */
export const LIVE_HR_STALE_AFTER_MS = 5_000;

/** Reconnect backoff after a dropped link: quick first, then easing off, and
 *  never longer than the cap — a gym's Bluetooth drops for seconds, not
 *  minutes, and an athlete mid-set should not wait long for the number to
 *  come back. */
export const RECONNECT_DELAYS_MS = [1_000, 2_000, 4_000, 8_000, 15_000] as const;
export function reconnectDelayMs(attempt: number): number {
  const i = Math.max(0, Math.min(attempt, RECONNECT_DELAYS_MS.length - 1));
  return RECONNECT_DELAYS_MS[i];
}

/**
 * Same zone floors as the backend's `ZoneForHR` (`trimp.go`): 50/60/70/80/90%
 * of HRmax. 0 = below zone 1. Kept identical on purpose — a live "zone 4"
 * on screen has to be the same zone 4 the report counts minutes in.
 */
export function zoneForBPM(bpm: number, hrMaxBPM: number | null): number {
  if (hrMaxBPM == null || hrMaxBPM <= 0 || bpm <= 0) return 0;
  const pct = bpm / hrMaxBPM;
  if (pct >= 0.9) return 5;
  if (pct >= 0.8) return 4;
  if (pct >= 0.7) return 3;
  if (pct >= 0.6) return 2;
  if (pct >= 0.5) return 1;
  return 0;
}

/** What every screen reads. `off` = no monitor remembered or nothing
 *  started; `unsupported` = this binary/device has no Bluetooth LE. */
export type LiveHRStatus =
  | 'off'
  | 'unsupported'
  | 'connecting'
  | 'connected'
  | 'reconnecting'
  | 'disconnected';

export type LiveHRState = {
  status: LiveHRStatus;
  device: { id: string; name: string } | null;
  bpm: number | null;
  /** RFC3339 of the latest reading, or null. */
  at: string | null;
  /** Reconnect attempts since the last successful connection. */
  attempt: number;
};

export const LIVE_HR_INITIAL: LiveHRState = { status: 'off', device: null, bpm: null, at: null, attempt: 0 };

export type LiveHREvent =
  | { type: 'start'; device: { id: string; name: string } }
  | { type: 'connected' }
  | { type: 'reading'; bpm: number; at: string }
  | { type: 'dropped' }
  | { type: 'retry' }
  | { type: 'gave_up' }
  | { type: 'unsupported' }
  | { type: 'stop' };

/** The whole state machine, so `liveHR.ts` only has to hand events in. */
export function reduceLiveHR(state: LiveHRState, event: LiveHREvent): LiveHRState {
  switch (event.type) {
    case 'start':
      return { status: 'connecting', device: event.device, bpm: null, at: null, attempt: 0 };
    case 'unsupported':
      return { ...LIVE_HR_INITIAL, status: 'unsupported' };
    case 'connected':
      return { ...state, status: 'connected', attempt: 0 };
    case 'reading':
      // A reading is proof of a live link, whatever the last transition said.
      return { ...state, status: 'connected', bpm: event.bpm, at: event.at, attempt: 0 };
    case 'dropped':
      // The last number stays visible (dimmed, per `isLiveReadingFresh`)
      // rather than vanishing — a frozen value that says "reconnecting" is
      // honest; an empty card mid-set is not.
      return { ...state, status: 'reconnecting', attempt: state.attempt + 1 };
    case 'retry':
      return { ...state, status: 'reconnecting', attempt: state.attempt + 1 };
    case 'gave_up':
      return { ...state, status: 'disconnected' };
    case 'stop':
      return LIVE_HR_INITIAL;
  }
}

/** Whether the number on screen may be shown as current. */
export function isLiveReadingFresh(state: LiveHRState, now: Date): boolean {
  if (state.status !== 'connected' || state.at == null) return false;
  const t = new Date(state.at).getTime();
  return Number.isFinite(t) && now.getTime() - t <= LIVE_HR_STALE_AFTER_MS;
}

/**
 * Short status copy for the in-session INDICATOR — never silent about a drop.
 *
 * Note `connected` returns the DEVICE NAME, deliberately: the chip is a heart
 * icon, a number and this label, with nothing else on screen saying where the
 * number comes from, so "Polar H10" is the useful sentence there and
 * "Connected" would be noise. That is exactly why it is wrong anywhere the
 * name is already on the line above — see `pairedMonitorStatusLabel`.
 */
export function liveHRStatusLabel(state: LiveHRState): string {
  switch (state.status) {
    case 'off':
      return '';
    case 'unsupported':
      return 'Bluetooth not available';
    case 'connecting':
      return `Connecting to ${state.device?.name ?? 'monitor'}…`;
    case 'connected':
      return state.device?.name ?? 'Monitor';
    case 'reconnecting':
      return 'Monitor disconnected — reconnecting…';
    case 'disconnected':
      return 'Monitor disconnected';
  }
}

/**
 * W20/#986 — the second line of Settings' paired-monitor row, which states a
 * CONNECTION STATE and never the device name.
 *
 * The row prints `remembered.name` as its title and used to print
 * `liveHRStatusLabel(live)` underneath, which for `connected` is the device
 * name again: "Amazfit Helio Strap / Amazfit Helio Strap". A separate
 * function rather than a change to that one, because the chip's behaviour is
 * correct for the chip (see above) and is still pinned by its own test.
 *
 * `pairedDeviceId`, when given, is the id of the monitor this row is about.
 * The live link belongs to whatever the orchestrator last started, so if that
 * is some other device this row's monitor is, honestly, not connected.
 */
export function pairedMonitorStatusLabel(state: LiveHRState, pairedDeviceId?: string | null): string {
  if (state.status === 'unsupported') return 'Bluetooth not available';
  if (isSomeOtherDevice(state, pairedDeviceId)) return 'Not connected';
  switch (state.status) {
    case 'off':
      return 'Not connected';
    case 'connecting':
      return 'Connecting…';
    case 'connected':
      return 'Connected';
    case 'reconnecting':
      return 'Disconnected — reconnecting…';
    case 'disconnected':
      return 'Disconnected';
  }
}

/**
 * Whether the live link is this row's monitor, connected right now. Shares
 * `isSomeOtherDevice` with `pairedMonitorStatusLabel` so the row's icon and
 * its words cannot disagree — a green heart over "Not connected" is the same
 * class of defect W20 was filed for, one element of the row overstating what
 * the other one says.
 */
export function isPairedMonitorConnected(state: LiveHRState, pairedDeviceId?: string | null): boolean {
  return state.status === 'connected' && !isSomeOtherDevice(state, pairedDeviceId);
}

/** The live link is held for a device that is not the one this row is about. */
function isSomeOtherDevice(state: LiveHRState, pairedDeviceId?: string | null): boolean {
  return pairedDeviceId != null && state.device != null && state.device.id !== pairedDeviceId;
}
