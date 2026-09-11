/**
 * A render harness for the running session screen, `app/running/[id].tsx`
 * (N563/#1068).
 *
 * **Why this exists.** The running screen was the one session screen nothing
 * could render. It mounts a map, asks the OS for location permission, drains
 * a background GPS task's fix queue on a timer, holds a Bluetooth heart-rate
 * link and speaks split announcements — so every invariant about it was
 * pinned by reading its source text instead (`hrReportWiring.test.ts`), and a
 * behaviour that only exists when the component actually runs could not be
 * checked at all. N545's heart-rate timeline was split off to this ticket for
 * exactly that reason: wiring a chart into the one surface with no test.
 *
 * **The shape: mock at the screen's own boundaries, and nothing inside them.**
 * Every module this harness replaces is one the screen reaches OUT through —
 * the OS (`expo-location`), the disk (`sessionStore`, the fix queue in
 * `runningTrackingTask`), the network (`biometric`), the radio (`hrMonitor/*`),
 * the speaker (`voice`). What stays real is what the screen DECIDES with:
 * `lib/running.ts`'s distance and split arithmetic, the auto-pause hysteresis,
 * `HRSessionReport` and its state machine, `hrSourceSentence`, the timeline
 * builder and axis, `useSessionVo2Max`. A test here can therefore fail because
 * the screen is wrong, and not only because a mock said so.
 *
 * **A scenario, not a script.** `renderRunningScreen` takes the world the
 * screen wakes up into — the session row, the saved track, the permission
 * answer, the queued fixes, the metrics row, the raw samples — resets every
 * mock and installs that world, then renders. Each call is fully determined
 * by its argument, so no test inherits a previous test's implementation (the
 * `mockClear`-vs-`mockReset` trap `bjjSessionScreen.test.tsx` documents).
 *
 * **It lives in one module on purpose.** `jest.mock` is hoisted within the
 * file that calls it, and this file both registers the mocks and imports the
 * screen, so the screen always resolves against them. A test file imports
 * this module and nothing it mocks. Put this module FIRST in a test's import
 * list anyway — a module imported earlier than the mocks are registered would
 * keep its real dependencies.
 *
 * What it deliberately cannot do: advance a GPS clock in real time, draw a
 * map, show a system permission alert, or connect a monitor. Those are
 * `docs/testing/device-checks.md`'s, and a mock pretending otherwise would be
 * apparatus that cannot fail.
 */
import { render } from '@testing-library/react-native';
import * as Location from 'expo-location';

import RunningSessionScreen from '../../../app/running/[id]';
import {
  getSessionMetrics,
  listBiometricSamples,
  type BiometricSample,
  type SessionMetrics,
} from '@/lib/biometric';
import type { HRAbsenceState } from '@/lib/hrAbsence';
import { stopLiveHR } from '@/lib/hrMonitor/liveHR';
import { connectIfRemembered } from '@/lib/hrMonitor/orchestrator';
import type { SessionDetail as RunningDetail } from '@/lib/running';
import {
  clearRunFixQueue,
  pruneRunFixesToRestoredTrack,
  readRunFixQueue,
  startRunTracking,
  stopRunTracking,
  type QueuedFix,
} from '@/lib/runningTrackingTask';
import {
  finishLocalSession,
  readLocalRunningDetail,
  readLocalSession,
  saveLocalRunningDetail,
  saveLocalSets,
  type LocalSession,
} from '@/lib/sessionStore';
import { request as requestSync } from '@/lib/sync';
import { useSessionHRSync } from '@/lib/useSessionHRSync';
import { announce } from '@/lib/voice';

// --- the screen's boundaries -------------------------------------------------

jest.mock('expo-location', () => ({
  getForegroundPermissionsAsync: jest.fn(),
  requestForegroundPermissionsAsync: jest.fn(),
}));

/*
 * `require`, not `import`, in every factory here — and each one disabled on its
 * own line: `jest.mock` factories are hoisted above the import block, and the
 * lint ratchet caps `no-require-imports` per rule, so a blanket disable would
 * hide the next real one (bjjSessionScreen.test.tsx's `HoldToConfirm` mock is
 * the precedent).
 *
 * The global stand-in (jest.setup.js) is a plain function component, which
 * cannot carry the ref the screen calls `animateCamera` on — so the newest fix
 * of every drain would throw inside `processFix`, be swallowed by the drain's
 * own catch as "a dropped GPS fix", and the track would never persist. That
 * is a harness bug that reads exactly like the screen's own "athlete never
 * moved" failure, so this one exposes the method.
 */
jest.mock('react-native-maps', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const React = require('react');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { View } = require('react-native');
  const MapView = React.forwardRef(
    (props: { children?: React.ReactNode }, ref: React.Ref<unknown>) => {
      React.useImperativeHandle(ref, () => ({ animateCamera: () => {} }));
      return React.createElement(View, { ...props, testID: 'running-map' }, props.children);
    },
  );
  MapView.displayName = 'MapView';
  return {
    __esModule: true,
    default: MapView,
    Polyline: (props: object) => React.createElement(View, props),
    Marker: (props: object) => React.createElement(View, props),
  };
});

jest.mock('expo-router', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const React = require('react');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { Text } = require('react-native');
  const router = { push: jest.fn(), back: jest.fn(), replace: jest.fn() };
  return {
    useFocusEffect: (cb: () => void) => React.useEffect(() => cb(), [cb]),
    useLocalSearchParams: () => ({ id: 'run-1' }),
    useRouter: () => router,
    Link: ({ children }: { children: React.ReactNode }) => React.createElement(Text, null, children),
    Stack: { Screen: () => null },
  };
});

jest.mock('@/lib/sessionStore', () => ({
  readLocalSession: jest.fn(),
  readLocalRunningDetail: jest.fn(),
  saveLocalRunningDetail: jest.fn(),
  saveLocalSets: jest.fn(),
  finishLocalSession: jest.fn(),
}));

jest.mock('@/lib/runningTrackingTask', () => ({
  startRunTracking: jest.fn(),
  stopRunTracking: jest.fn(),
  readRunFixQueue: jest.fn(),
  clearRunFixQueue: jest.fn(),
  pruneRunFixesToRestoredTrack: jest.fn(),
}));

jest.mock('@/lib/sync', () => ({
  request: jest.fn(),
  syncNow: jest.fn(async () => {}),
  useSyncState: () => ({
    syncing: false, pending: 0, deferred: 0, lastSyncAt: null, lastError: null, online: true,
  }),
}));

// Only the two calls anything on this screen makes. Deliberately not a
// `requireActual` spread: an unmocked network function reached by a future
// change should fail loudly here, not quietly talk to whatever API is running
// on this machine.
jest.mock('@/lib/biometric', () => ({
  getSessionMetrics: jest.fn(),
  listBiometricSamples: jest.fn(),
}));

jest.mock('@/lib/sessionHR', () => ({ cacheSessionHR: jest.fn(async () => {}) }));

// The absence state and the on-demand sync are the hook's own tests' business;
// here they are an input the report renders.
jest.mock('@/lib/useSessionHRSync', () => ({ useSessionHRSync: jest.fn() }));

// The radio. `LiveHRIndicator` is replaced whole: its states are its own
// suite's, and the live chip's presence is all a screen test can mean by it.
jest.mock('@/lib/hrMonitor/useLiveHR', () => ({ useLiveHR: () => ({ status: 'off' }) }));
jest.mock('@/lib/hrMonitor/useHRRecording', () => ({ useHRRecording: jest.fn() }));
jest.mock('@/lib/hrMonitor/useHRMax', () => ({
  ...jest.requireActual('@/lib/hrMonitor/useHRMax'),
  useHRMax: () => null,
}));
jest.mock('@/lib/hrMonitor/orchestrator', () => ({ connectIfRemembered: jest.fn(async () => {}) }));
jest.mock('@/lib/hrMonitor/liveHR', () => ({ stopLiveHR: jest.fn(async () => {}) }));
jest.mock('@/components/LiveHRIndicator', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const React = require('react');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { View } = require('react-native');
  return { LiveHRIndicator: ({ testID }: { testID?: string }) => React.createElement(View, { testID }) };
});

jest.mock('@/lib/voice', () => ({ announce: jest.fn() }));

// The hold gesture has its own suite (`holdToConfirm.test.tsx`); here it is a
// press, so a test is about what happens after the athlete confirms.
jest.mock('@/components/HoldToConfirm', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const React = require('react');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { Pressable, Text } = require('react-native');
  return {
    HoldToConfirm: ({ label, onConfirm, testID }: { label: string; onConfirm: () => void; testID?: string }) =>
      React.createElement(Pressable, { onPress: onConfirm, testID }, React.createElement(Text, null, label)),
  };
});

// --- fixtures ---------------------------------------------------------------

export const RUN_ID = 'run-1';
/** The jest.setup.js Clerk mock's user — the id every store call is keyed on. */
export const USER_ID = 'u1';

const STARTED_AT = '2026-09-06T07:00:00.000Z';
const ENDED_AT = '2026-09-06T07:40:00.000Z';

/** A run the athlete has not finished — the live-tracking branch. */
export function openRun(overrides: Partial<LocalSession> = {}): LocalSession {
  return {
    id: RUN_ID,
    user_id: USER_ID,
    workout_id: null,
    sport: 'running',
    name: 'Morning run',
    intent: 'normal',
    started_at: STARTED_AT,
    ended_at: null,
    notes: '',
    sets: [],
    created_at: STARTED_AT,
    updated_at: STARTED_AT,
    dirty: false,
    ...overrides,
  };
}

/** A run reopened after it finished — the report branch. 40 minutes long. */
export function finishedRun(overrides: Partial<LocalSession> = {}): LocalSession {
  return openRun({ ended_at: ENDED_AT, updated_at: ENDED_AT, ...overrides });
}

/** The saved detail for a finished run: 5 km in 25 minutes, no route. */
export function runDetail(overrides: Partial<RunningDetail> = {}): RunningDetail {
  return {
    session_id: RUN_ID,
    route_points: [],
    splits: [],
    elevation_gain_m: null,
    avg_pace_sec_per_km: 300,
    distance_m: 5000,
    duration_seconds: 1500,
    source: 'phone_gps',
    ...overrides,
  };
}

/**
 * A metrics row with real heart rate. Its window defaults to the run's own
 * logged one; pass `hr_window_start/end` to model W19's watch-workout window.
 */
export function hrMetrics(overrides: Partial<SessionMetrics> = {}): SessionMetrics {
  return {
    session_id: RUN_ID,
    avg_hr_bpm: 148,
    max_hr_bpm: 171,
    trimp: 64,
    active_kcal: null,
    hr_max_bpm: 190,
    hr_max_source: 'estimated',
    time_in_zones: { '3': 20, '4': 12 },
    hr_source: 'window',
    sample_count: 40,
    hr_window_start: STARTED_AT,
    hr_window_end: ENDED_AT,
    computed_at: ENDED_AT,
    rule_version: 1,
    ...overrides,
  };
}

/** One heart-rate reading per minute from `from`, one per entry of `bpms`. */
export function hrSamples(from: string, bpms: readonly number[]): BiometricSample[] {
  const t0 = new Date(from).getTime();
  return bpms.map((value, i) => ({
    id: `hr-${i}`,
    metric_type: 'heart_rate',
    source: 'apple_watch',
    source_platform: 'healthkit',
    value,
    unit: 'count/min',
    measured_at: new Date(t0 + i * 60_000).toISOString(),
  }));
}

/** A GPS fix as the background task queues it. Moving at 3 m/s by default. */
export function queuedFix(id: number, lat: number, lng: number, recordedAt: string, overrides: Partial<QueuedFix> = {}): QueuedFix {
  return { id, lat, lng, elevation_m: null, accuracy_m: 5, speed_mps: 3, recorded_at: recordedAt, ...overrides };
}

// --- the scenario -----------------------------------------------------------

export type RunningScreenScenario = {
  /** The local session row. `null` models "not on this device". Default: an open run. */
  session?: LocalSession | null;
  /** The saved running detail. Default: none. */
  detail?: RunningDetail | null;
  /** What the OS says about foreground location. Default: already granted. */
  permission?: { granted: boolean; canAskAgain: boolean; grantedOnRequest?: boolean };
  /** Every fix the background task has queued, served past the screen's cursor. */
  fixes?: QueuedFix[];
  /** `getSessionMetrics`' answer. `null` is "no heart rate for this session". Default: null. */
  metrics?: SessionMetrics | null | Error;
  /** Raw samples by metric type; an Error for `heart_rate` makes that fetch reject. */
  samples?: { heart_rate?: BiometricSample[] | Error; vo2_max?: BiometricSample[] };
  /** Which no-HR card to render. Default: 'checking'. */
  hrAbsence?: HRAbsenceState;
};

const asMock = (fn: unknown) => fn as jest.Mock;

/** Every boundary the screen reached, for assertions. */
export const runningMocks = {
  location: {
    getPermissions: asMock(Location.getForegroundPermissionsAsync),
    requestPermissions: asMock(Location.requestForegroundPermissionsAsync),
  },
  store: {
    readSession: asMock(readLocalSession),
    readDetail: asMock(readLocalRunningDetail),
    saveDetail: asMock(saveLocalRunningDetail),
    saveSets: asMock(saveLocalSets),
    finish: asMock(finishLocalSession),
  },
  tracking: {
    start: asMock(startRunTracking),
    stop: asMock(stopRunTracking),
    readQueue: asMock(readRunFixQueue),
    clearQueue: asMock(clearRunFixQueue),
    prune: asMock(pruneRunFixesToRestoredTrack),
  },
  biometric: {
    getSessionMetrics: asMock(getSessionMetrics),
    listSamples: asMock(listBiometricSamples),
  },
  sync: { request: asMock(requestSync) },
  hr: {
    useSessionHRSync: asMock(useSessionHRSync),
    connectIfRemembered: asMock(connectIfRemembered),
    stopLiveHR: asMock(stopLiveHR),
  },
  announce: asMock(announce),
};

/** The testID each of the screen's top-level branches renders. */
export const RUNNING_BRANCH = {
  loading: 'running-loading',
  error: 'running-error',
  permissionDenied: 'running-permission-denied',
  live: 'running-live-screen',
  finished: 'running-finished',
} as const;

/**
 * Reset every boundary, install `scenario`, and render the screen.
 *
 * Wait for a `RUNNING_BRANCH` testID before asserting anything. RNTL's awaited
 * `render` flushes microtasks, so with these immediately-resolving stores the
 * screen is usually PAST `running-loading` by the time this returns — measured:
 * asserting the loading branch straight after it failed. A test about the
 * loading state has to hold a store call open itself.
 */
export async function renderRunningScreen(scenario: RunningScreenScenario = {}) {
  for (const group of Object.values(runningMocks)) {
    for (const fn of Object.values(typeof group === 'function' ? { group } : group)) {
      (fn as jest.Mock).mockReset();
    }
  }

  const session = scenario.session === undefined ? openRun() : scenario.session;
  const permission = scenario.permission ?? { granted: true, canAskAgain: true };
  const fixes = scenario.fixes ?? [];

  const m = runningMocks;
  m.store.readSession.mockImplementation(async () => session);
  m.store.readDetail.mockImplementation(async () => scenario.detail ?? null);
  m.store.saveDetail.mockImplementation(async () => {});
  m.store.saveSets.mockImplementation(async () => {});
  m.store.finish.mockImplementation(async () => {});

  m.location.getPermissions.mockImplementation(async () => ({
    granted: permission.granted,
    canAskAgain: permission.canAskAgain,
    status: permission.granted ? 'granted' : 'denied',
  }));
  m.location.requestPermissions.mockImplementation(async () => {
    const granted = permission.grantedOnRequest ?? false;
    return { granted, canAskAgain: !granted, status: granted ? 'granted' : 'denied' };
  });

  m.tracking.start.mockImplementation(async () => {});
  m.tracking.stop.mockImplementation(async () => {});
  // Honours the cursor the screen passes, the way the real queue does — so a
  // fix is served once per mount, and a screen that failed to advance its
  // cursor would see the same fix again.
  m.tracking.readQueue.mockImplementation(async (_user: string, _session: string, afterID: number) =>
    fixes.filter((f) => f.id > afterID),
  );
  m.tracking.clearQueue.mockImplementation(async () => {});
  m.tracking.prune.mockImplementation(async () => {});

  m.biometric.getSessionMetrics.mockImplementation(async () => {
    if (scenario.metrics instanceof Error) throw scenario.metrics;
    return scenario.metrics ?? null;
  });
  // Keyed on the metric type, never on call order: the screen reads VO₂max
  // through the same function, and a call-order mock silently hands the heart
  // rate fetch the wrong answer (bjjSessionScreen.test.tsx's `answerSamples`).
  m.biometric.listSamples.mockImplementation(async (_token: unknown, metricType: string) => {
    const answer = scenario.samples?.[metricType as 'heart_rate' | 'vo2_max'];
    if (answer instanceof Error) throw answer;
    return answer ?? [];
  });

  const syncNow = async () => ({ status: 'none' as const });
  const hrSync = {
    absence: scenario.hrAbsence ?? 'checking',
    sourceLabel: 'Apple Health',
    syncNow,
    monitorName: null,
  };
  m.hr.useSessionHRSync.mockImplementation(() => hrSync);
  m.hr.connectIfRemembered.mockImplementation(async () => {});
  m.hr.stopLiveHR.mockImplementation(async () => {});

  await render(<RunningSessionScreen />);
  return runningMocks;
}
