import { PermissionsAndroid, Platform } from 'react-native';

import {
  HEART_RATE_MEASUREMENT_UUID,
  HEART_RATE_SERVICE_UUID,
  LIVE_HR_INITIAL,
  decodeBase64,
  parseHeartRateMeasurement,
  reduceLiveHR,
  reconnectDelayMs,
  type LiveHREvent,
  type LiveHRState,
} from './heartRateProfile';

/**
 * N528/#958 — the live heart-rate stream, app-wide. One store, one Bluetooth
 * link, whoever is looking: the Today card, a session screen's indicator
 * and the recorder all read the same `LiveHRState` and never talk to
 * Bluetooth themselves.
 *
 * Everything Bluetooth goes through `react-native-ble-plx`, loaded lazily on
 * first use: a Simulator build has no BLE and the jest suite has no native
 * module, and neither must crash at import (the `expo-camera` lesson —
 * `vola-mobile-build` skill). When the module is missing, the state says
 * `unsupported` and every screen renders nothing for it.
 */

// ---------------------------------------------------------------- store ---

type Listener = () => void;
let state: LiveHRState = LIVE_HR_INITIAL;
const listeners = new Set<Listener>();
/** Readings fan out here too — the recorder subscribes for the raw stream
 *  rather than diffing state snapshots. */
const readingListeners = new Set<(bpm: number, at: Date) => void>();

export function getLiveHR(): LiveHRState {
  return state;
}

export function subscribeLiveHR(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function subscribeLiveHRReadings(listener: (bpm: number, at: Date) => void): () => void {
  readingListeners.add(listener);
  return () => {
    readingListeners.delete(listener);
  };
}

function dispatch(event: LiveHREvent): void {
  const next = reduceLiveHR(state, event);
  if (next === state) return;
  state = next;
  for (const l of listeners) l();
}

/** Test seam — jest drives the store without Bluetooth. */
export function __dispatchLiveHRForTests(event: LiveHREvent): void {
  dispatch(event);
}

// ------------------------------------------------------------ bluetooth ---

type Subscription = { remove(): void };
type BleDevice = {
  id: string;
  name: string | null;
  localName?: string | null;
  discoverAllServicesAndCharacteristics(): Promise<BleDevice>;
  monitorCharacteristicForService(
    serviceUUID: string,
    characteristicUUID: string,
    listener: (error: unknown, characteristic: { value: string | null } | null) => void,
  ): Subscription;
};
type BleManagerLike = {
  state(): Promise<string>;
  startDeviceScan(
    uuids: string[] | null,
    options: { allowDuplicates?: boolean } | null,
    listener: (error: unknown, device: BleDevice | null) => void,
  ): void;
  stopDeviceScan(): void;
  connectToDevice(id: string, options?: { timeout?: number }): Promise<BleDevice>;
  cancelDeviceConnection(id: string): Promise<unknown>;
  onDeviceDisconnected(id: string, listener: (error: unknown, device: BleDevice | null) => void): Subscription;
  destroy(): void;
};

let manager: BleManagerLike | null | undefined; // undefined = not tried yet

function bleManager(): BleManagerLike | null {
  if (manager !== undefined) return manager;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require('react-native-ble-plx') as { BleManager: new () => BleManagerLike };
    manager = new mod.BleManager();
  } catch {
    manager = null;
  }
  return manager;
}

/** Whether this binary can talk Bluetooth LE at all. */
export function isBluetoothSupported(): boolean {
  return bleManager() !== null;
}

/**
 * Android 12+ asks for BLUETOOTH_SCAN / BLUETOOTH_CONNECT at runtime; older
 * Android scans under location permission instead. iOS prompts on first use
 * of the manager, from the string in app.config.js. Resolves false when the
 * athlete declined — the caller then says so rather than scanning into
 * silence.
 */
export async function ensureBluetoothPermissions(): Promise<boolean> {
  if (Platform.OS !== 'android') return true;
  const api = typeof Platform.Version === 'number' ? Platform.Version : parseInt(String(Platform.Version), 10);
  if (api >= 31) {
    const res = await PermissionsAndroid.requestMultiple([
      PermissionsAndroid.PERMISSIONS.BLUETOOTH_SCAN,
      PermissionsAndroid.PERMISSIONS.BLUETOOTH_CONNECT,
    ]);
    return Object.values(res).every((v) => v === PermissionsAndroid.RESULTS.GRANTED);
  }
  const res = await PermissionsAndroid.request(PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION);
  return res === PermissionsAndroid.RESULTS.GRANTED;
}

export type FoundMonitor = { id: string; name: string };

/**
 * Scans for Heart Rate Profile devices for `timeoutMs`, reporting each new
 * one once. Filtered on the service UUID at the radio, so an athlete's
 * headphones and the gym's forty other peripherals never appear. Resolves
 * when the scan ends; `stop` ends it early.
 */
export function scanForMonitors(
  onFound: (device: FoundMonitor) => void,
  timeoutMs = 12_000,
): { done: Promise<void>; stop: () => void } {
  const m = bleManager();
  let stopped = false;
  let finish: () => void = () => {};
  const done = new Promise<void>((resolve) => {
    finish = () => {
      if (stopped) return;
      stopped = true;
      m?.stopDeviceScan();
      resolve();
    };
  });
  if (!m) {
    finish();
    return { done, stop: finish };
  }
  const seen = new Set<string>();
  m.startDeviceScan([HEART_RATE_SERVICE_UUID], { allowDuplicates: false }, (error, device) => {
    if (error || !device || seen.has(device.id)) return;
    seen.add(device.id);
    onFound({ id: device.id, name: device.name ?? device.localName ?? 'Heart-rate monitor' });
  });
  setTimeout(finish, timeoutMs);
  return { done, stop: finish };
}

// ----------------------------------------------------------- connection ---

let active: {
  device: { id: string; name: string };
  monitor: Subscription | null;
  disconnect: Subscription | null;
  retryTimer: ReturnType<typeof setTimeout> | null;
  generation: number;
} | null = null;
let generation = 0;

/** Give up after this many consecutive failed reconnects; the screen then
 *  says "disconnected" and the athlete can retry by hand. */
export const MAX_RECONNECT_ATTEMPTS = 6;

/**
 * Connects to the remembered monitor and streams readings into the store
 * until `stopLiveHR`. Idempotent for the same device; switching devices
 * stops the old link first. Never throws — every failure is a state.
 */
export async function startLiveHR(device: { id: string; name: string }): Promise<void> {
  const m = bleManager();
  if (!m) {
    dispatch({ type: 'unsupported' });
    return;
  }
  if (active && active.device.id === device.id) return;
  await stopLiveHR();
  const gen = ++generation;
  active = { device, monitor: null, disconnect: null, retryTimer: null, generation: gen };
  dispatch({ type: 'start', device });
  await connectAttempt(gen);
}

async function connectAttempt(gen: number): Promise<void> {
  const m = bleManager();
  const a = active;
  if (!m || !a || a.generation !== gen) return;
  try {
    const dev = await m.connectToDevice(a.device.id, { timeout: 10_000 });
    if (!active || active.generation !== gen) return;
    await dev.discoverAllServicesAndCharacteristics();
    if (!active || active.generation !== gen) return;
    a.monitor?.remove();
    a.monitor = dev.monitorCharacteristicForService(
      HEART_RATE_SERVICE_UUID,
      HEART_RATE_MEASUREMENT_UUID,
      (error, characteristic) => {
        if (!active || active.generation !== gen) return;
        if (error) return; // the disconnect listener below owns the transition
        const value = characteristic?.value;
        if (!value) return;
        const parsed = parseHeartRateMeasurement(decodeBase64(value));
        if (!parsed || parsed.bpm <= 0) return;
        const at = new Date();
        dispatch({ type: 'reading', bpm: parsed.bpm, at: at.toISOString() });
        for (const l of readingListeners) l(parsed.bpm, at);
      },
    );
    a.disconnect?.remove();
    a.disconnect = m.onDeviceDisconnected(a.device.id, () => {
      if (!active || active.generation !== gen) return;
      dispatch({ type: 'dropped' });
      scheduleReconnect(gen);
    });
    dispatch({ type: 'connected' });
  } catch {
    if (!active || active.generation !== gen) return;
    dispatch({ type: 'retry' });
    scheduleReconnect(gen);
  }
}

function scheduleReconnect(gen: number): void {
  const a = active;
  if (!a || a.generation !== gen) return;
  if (state.attempt >= MAX_RECONNECT_ATTEMPTS) {
    dispatch({ type: 'gave_up' });
    return;
  }
  if (a.retryTimer) clearTimeout(a.retryTimer);
  a.retryTimer = setTimeout(() => {
    a.retryTimer = null;
    void connectAttempt(gen);
  }, reconnectDelayMs(state.attempt - 1));
}

/** Manual retry after `disconnected` — the athlete's own tap. */
export async function retryLiveHR(): Promise<void> {
  const a = active;
  if (!a) return;
  dispatch({ type: 'start', device: a.device });
  await connectAttempt(a.generation);
}

export async function stopLiveHR(): Promise<void> {
  const a = active;
  active = null;
  generation++;
  if (a) {
    if (a.retryTimer) clearTimeout(a.retryTimer);
    a.monitor?.remove();
    a.disconnect?.remove();
    try {
      await bleManager()?.cancelDeviceConnection(a.device.id);
    } catch {
      // Already gone — that is the state we wanted.
    }
  }
  dispatch({ type: 'stop' });
}
