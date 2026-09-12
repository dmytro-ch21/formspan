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

/**
 * Test seam — installs a fake BLE manager and resets every module-level
 * connection state, so a test can drive the real `startLiveHR`/`stopLiveHR`
 * against a scripted peripheral. `null` restores "no Bluetooth in this
 * binary". Never called outside tests.
 */
export function __setBleManagerForTests(m: unknown, cancelAckMs = 2_000): void {
  cancelAckTimeoutMs = cancelAckMs;
  manager = (m as BleManagerLike | null) ?? null;
  if (active?.retryTimer) clearTimeout(active.retryTimer);
  active = null;
  generation++;
  state = LIVE_HR_INITIAL;
  readingListeners.clear();
  opChain = Promise.resolve();
}

// ------------------------------------------------------------ bluetooth ---

type Subscription = { remove(): void };
type BleDevice = {
  id: string;
  name: string | null;
  localName?: string | null;
  /** Advertisement signal strength in dBm, when the radio reported one. */
  rssi?: number | null;
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

export type FoundMonitor = {
  id: string;
  name: string;
  /**
   * W20/#986 — advertisement signal strength in dBm, `null` when the radio
   * did not report one. Only ever shown to separate two devices advertising
   * the SAME name (`lib/hrMonitor/monitorList.ts` decides); it is not an
   * identifier and never appears on an unambiguous row.
   */
  rssi: number | null;
};

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
    onFound({
      id: device.id,
      name: device.name ?? device.localName ?? 'Heart-rate monitor',
      // `allowDuplicates: false`, so this is the first advertisement's
      // reading and it does not then flicker under the athlete's finger.
      rssi: typeof device.rssi === 'number' ? device.rssi : null,
    });
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
 * Every connect/disconnect runs one at a time, in call order.
 *
 * Without this, two overlapping calls both pass their own guards and the
 * loser's `connectToDevice` still resolves afterwards — a native BLE
 * connection nobody holds a handle to any more, plus a reconnect timer for
 * a link that was superseded. The `generation` counter below protects the
 * JS state machine; it cannot protect a native handle a stale continuation
 * already opened. Found by review, pinned by `liveHRConnection.test.ts`.
 *
 * The callers make this necessary rather than theoretical:
 * `connectIfRemembered()` is invoked, unserialized, from the AppState
 * listener, from `setHRMonitorIdentity`, and from Settings' pick/forget —
 * a phone call arriving mid-connect is enough to overlap two of them.
 */
let opChain: Promise<unknown> = Promise.resolve();
function serialized<T>(op: () => Promise<T>): Promise<T> {
  const run = opChain.then(op, op);
  // Never let one failed op poison the chain for the next.
  opChain = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

/**
 * How long to wait for the OS to acknowledge a disconnect before moving on.
 *
 * Serializing means a `stopLiveHR` that never resolves would wedge every
 * later connect — live HR would silently never come back for the rest of
 * the app's life, which is worse than the race it fixes. A BLE stack that
 * has stopped answering is exactly the case: we stop waiting, having
 * already dropped our own listeners, and let the next op proceed.
 */
let cancelAckTimeoutMs = 2_000;

/**
 * Connects to the remembered monitor and streams readings into the store
 * until `stopLiveHR`. Idempotent for the same device; switching devices
 * stops the old link first. Never throws — every failure is a state.
 * Serialized against every other connect/disconnect (see `serialized`).
 */
export function startLiveHR(device: { id: string; name: string }): Promise<void> {
  return serialized(() => startLiveHRInner(device));
}

async function startLiveHRInner(device: { id: string; name: string }): Promise<void> {
  const m = bleManager();
  if (!m) {
    dispatch({ type: 'unsupported' });
    return;
  }
  if (active && active.device.id === device.id) return;
  await stopLiveHRInner();
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
    // Still ours? Every caller of `connectAttempt` goes through `serialized`,
    // so nothing can move the generation while this await is in flight —
    // these two checks are belt to that braces, not the mechanism.
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
    // NOT through `serialized`, deliberately. `stopLiveHRInner` has two
    // defences against this callback reviving a link after a stop, and each
    // is enough on its own: it clears `retryTimer`, so the callback normally
    // never runs; and it nulls `active` and bumps `generation` synchronously,
    // so a callback that does run bails at the top of `connectAttempt` — on
    // `!a`, or on the generation check if a newer start has set `active`
    // again. Queueing it would change nothing any test can observe, and an
    // unobservable difference is not worth the extra machinery.
    //
    // The "reconnect while backgrounding" test pins the pair, not either half:
    // removing both lets a second connect through and its post-backoff connect
    // count goes red; removing either alone stays green, correctly. Before
    // F54/#1118 it asserted status only, which a connect in flight never
    // changes, so it pinned neither.
    void connectAttempt(gen);
  }, reconnectDelayMs(state.attempt - 1));
}

/** Manual retry after `disconnected` — the athlete's own tap. */
export function retryLiveHR(): Promise<void> {
  return serialized(async () => {
    const a = active;
    if (!a) return;
    dispatch({ type: 'start', device: a.device });
    await connectAttempt(a.generation);
  });
}

export function stopLiveHR(): Promise<void> {
  return serialized(() => stopLiveHRInner());
}

async function stopLiveHRInner(): Promise<void> {
  const a = active;
  active = null;
  generation++;
  if (a) {
    if (a.retryTimer) clearTimeout(a.retryTimer);
    a.monitor?.remove();
    a.disconnect?.remove();
    const m = bleManager();
    if (m) {
      try {
        // Bounded: see `cancelAckTimeoutMs`. Our own listeners are already
        // gone by here, so proceeding early costs nothing but a native
        // handle the OS will reap.
        await Promise.race([
          m.cancelDeviceConnection(a.device.id),
          new Promise((resolve) => setTimeout(resolve, cancelAckTimeoutMs)),
        ]);
      } catch {
        // Already gone — that is the state we wanted.
      }
    }
  }
  // No generation guard here on purpose. An earlier draft had one, against
  // a later start overtaking a stalled cancel — but every connect and
  // disconnect now goes through `serialized`, so no newer operation can be
  // running while this one is, and the guard could never fire. A test could
  // not reach it either; an unreachable safety net that nothing exercises
  // reads as protection and provides none.
  dispatch({ type: 'stop' });
}
