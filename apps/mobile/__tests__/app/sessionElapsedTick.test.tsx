import { act, render, screen } from '@testing-library/react-native';

import SessionScreen from '../../app/session/[id]';
import { elapsedSeconds } from '@/components/ElapsedStat';
import { readLocalSession, type LocalSession } from '@/lib/sessionStore';

/**
 * N566/#1126 — the session clock does not re-render the session screen.
 *
 * `app/session/[id].tsx` used to hold the elapsed time in `useState` with a 1s
 * interval, so the WHOLE screen — every exercise group and every set row —
 * re-rendered once a second for the life of every live session, to repaint the
 * Time figure. The tick now lives in `ElapsedStat`.
 *
 * **This renders the real screen, not a stand-in, and that is the point.** A
 * stand-in that owned `ElapsedStat` would prove the component ticks on its own
 * and would stay green if somebody put `setElapsed` back in the screen — a test
 * that cannot fail on the regression it exists for. Here the screen is mounted
 * with its boundaries mocked (store, network, router, heart rate), exactly the
 * shape of `support/runningScreen.tsx`.
 *
 * **The probe.** `Stat` is wrapped to record each render with its label. The
 * screen re-creates its `<Stat label="Sets">` element on every render of its
 * own, and nothing else re-renders that element, so the Sets count IS the
 * screen's render count. The Time `Stat` sits inside `ElapsedStat`, so its count
 * is the clock's. The load-bearing assertion is that the first stays flat while
 * the second climbs; either half alone would pass for the wrong reason — a
 * frozen clock makes the screen quiet too.
 */

const mockStatRenders: { label: string; value: string; slots?: number }[] = [];

jest.mock('@/components/ui/Stat', () => {
  const actual = jest.requireActual('@/components/ui/Stat');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const React = require('react');
  return {
    ...actual,
    Stat: (props: { label: string; value: string; slots?: number }) => {
      mockStatRenders.push({ label: props.label, value: props.value, slots: props.slots });
      return React.createElement(actual.Stat, props);
    },
  };
});

// --- the screen's boundaries -------------------------------------------------

jest.mock('expo-router', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const React = require('react');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { Text } = require('react-native');
  // One router and one params object for the life of the file: a fresh object
  // per render is an unstable dependency, and effects keyed on it would re-run
  // — re-rendering the screen for a reason that exists only in the mock.
  const router = { push: jest.fn(), back: jest.fn(), replace: jest.fn() };
  const params = { id: 's1' };
  return {
    useFocusEffect: (cb: () => void) => React.useEffect(() => cb(), [cb]),
    useLocalSearchParams: () => params,
    useRouter: () => router,
    Link: ({ children }: { children: React.ReactNode }) => React.createElement(Text, null, children),
    Stack: { Screen: () => null },
  };
});

jest.mock('@/lib/sessionStore', () => ({
  readLocalSession: jest.fn(),
  hydrateSession: jest.fn(async () => null),
  readCollapsedGroups: jest.fn(async () => []),
  saveCollapsedGroups: jest.fn(async () => {}),
  cachedExercises: jest.fn(async () => []),
  cacheExercises: jest.fn(async () => {}),
  cachedWorkouts: jest.fn(async () => []),
  deleteLocalSession: jest.fn(async () => {}),
  finishLocalSession: jest.fn(async () => {}),
  pushSession: jest.fn(async () => {}),
  saveLocalSets: jest.fn(async () => {}),
}));

jest.mock('@/lib/sync', () => ({
  request: jest.fn(),
  syncNow: jest.fn(async () => {}),
  useSyncState: () => ({
    syncing: false, pending: 0, deferred: 0, lastSyncAt: null, lastError: null, online: true,
  }),
}));

jest.mock('@/lib/exercises', () => ({
  ...jest.requireActual('@/lib/exercises'),
  fetchExercises: jest.fn(async () => []),
}));
jest.mock('@/lib/sessions', () => ({
  ...jest.requireActual('@/lib/sessions'),
  fetchSuggestions: jest.fn(async () => new Map()),
}));
jest.mock('@/lib/prefs', () => ({
  ...jest.requireActual('@/lib/prefs'),
  readPref: jest.fn(async () => null),
  writePref: jest.fn(async () => {}),
}));
jest.mock('@/lib/profile', () => ({
  ...jest.requireActual('@/lib/profile'),
  getExerciseUnits: jest.fn(async () => ({})),
  setExerciseUnit: jest.fn(async () => {}),
}));
jest.mock('@/lib/rest', () => ({
  ...jest.requireActual('@/lib/rest'),
  readAutoRest: jest.fn(async () => false),
  readRestSeconds: jest.fn(async () => 90),
  writeRestSeconds: jest.fn(async () => {}),
}));
jest.mock('@/lib/records', () => ({
  ...jest.requireActual('@/lib/records'),
  fetchRecords: jest.fn(async () => []),
}));
jest.mock('@/lib/history', () => ({
  ...jest.requireActual('@/lib/history'),
  fetchHistory: jest.fn(async () => []),
}));
jest.mock('@/lib/workouts', () => ({
  ...jest.requireActual('@/lib/workouts'),
  getWorkout: jest.fn(async () => null),
}));
jest.mock('@/lib/biometric', () => ({
  getSessionMetrics: jest.fn(async () => null),
  listExerciseHR: jest.fn(async () => []),
  listBiometricSamples: jest.fn(async () => []),
}));
jest.mock('@/lib/sessionHR', () => ({ cacheSessionHR: jest.fn(async () => {}) }));
jest.mock('@/lib/useSessionHRSync', () => ({
  useSessionHRSync: () => ({
    absence: 'checking',
    sourceLabel: 'Apple Health',
    syncNow: async () => ({ status: 'none' }),
    monitorName: null,
  }),
}));
jest.mock('@/lib/useUnits', () => ({ useUnits: () => ({ units: 'metric', unitsReady: true }) }));
jest.mock('@/lib/useTrackEffort', () => ({ useTrackEffort: () => ({ trackEffort: false }) }));
jest.mock('@/lib/sounds', () => ({ playSound: jest.fn(), primeSounds: jest.fn() }));
jest.mock('@/lib/voice', () => ({
  announce: jest.fn(),
  cuesForTransition: () => [],
  speak: jest.fn(),
  stopSpeaking: jest.fn(),
  voiceEnabled: () => false,
}));

// Surfaces a finished session reads back; each has its own suite, and none is
// on the path this file measures.
jest.mock('@/components/SessionShare', () => ({
  useSessionShare: () => ({}),
  ShareCardHost: () => null,
  ShareSessionButton: () => null,
}));
jest.mock('@/components/SessionCelebration', () => ({ SessionCelebration: () => null }));
jest.mock('@/components/HRSessionReport', () => ({ HRSessionReport: () => null }));

// --- fixtures ---------------------------------------------------------------

const STARTED_AT = '2026-09-11T07:00:00.000Z';

function liveSession(overrides: Partial<LocalSession> = {}): LocalSession {
  return {
    id: 's1',
    user_id: 'u1',
    workout_id: null,
    sport: 'strength',
    name: 'Push day',
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

const rendersOf = (label: string) => mockStatRenders.filter((r) => r.label === label);
const latest = (label: string) => rendersOf(label).at(-1);

/** One second per `act`, so each interval tick is its own macrotask, as on a device. */
async function advanceSeconds(n: number) {
  for (let i = 0; i < n; i++) {
    await act(() => {
      jest.advanceTimersByTime(1000);
    });
  }
}

async function renderSession(session: LocalSession) {
  (readLocalSession as jest.Mock).mockImplementation(async () => session);
  await render(<SessionScreen />);
  await screen.findByTestId('session-summary');
  // Let every load-time effect settle before anything is counted, so the
  // window below measures a session sitting open, not a screen still arriving.
  await advanceSeconds(1);
}

beforeEach(() => {
  jest.useFakeTimers();
  // Twelve minutes into the session.
  jest.setSystemTime(new Date(new Date(STARTED_AT).getTime() + 12 * 60_000));
  mockStatRenders.length = 0;
});

afterEach(() => {
  jest.useRealTimers();
});

describe('elapsedSeconds', () => {
  it('counts to now while open and to ended_at once finished, in whole seconds', () => {
    const from = new Date(STARTED_AT).getTime();
    expect(elapsedSeconds(STARTED_AT, null, from + 61_900)).toBe(61);
    expect(elapsedSeconds(STARTED_AT, '2026-09-11T07:47:30.000Z', from + 999_999_999)).toBe(47 * 60 + 30);
  });
});

describe('a live session', () => {
  it('ticks the Time figure without re-rendering the screen', async () => {
    await renderSession(liveSession());

    // Not vacuous: the probe sees the screen's stat row at all.
    expect(rendersOf('Sets').length).toBeGreaterThan(0);
    const screenBefore = rendersOf('Sets').length;
    const clockBefore = rendersOf('Time').length;
    const shownBefore = latest('Time')!.value;

    await advanceSeconds(5);

    // The clock moved, on screen, once per second...
    expect(latest('Time')!.value).not.toBe(shownBefore);
    expect(screen.getByText(latest('Time')!.value)).toBeTruthy();
    expect(rendersOf('Time').length - clockBefore).toBeGreaterThanOrEqual(5);
    // ...and the screen that owns every set row did not render for it. Before
    // N566 this was one render per second: 5 here, ~3,600 in an hour.
    expect(rendersOf('Sets').length - screenBefore).toBe(0);
  });

  it('is still derived from started_at, not counted up from mount', async () => {
    await renderSession(liveSession());
    // Mounted twelve minutes (and the settle second) after started_at.
    expect(latest('Time')!.value).toBe('12:01');
    await advanceSeconds(3);
    expect(latest('Time')!.value).toBe('12:04');
  });

  it('catches up after the JS thread was suspended, rather than resuming a count', async () => {
    // The reason it is derived at all. A phone in a pocket throttles the JS
    // thread: the wall clock moves and the interval does not fire. Fake timers
    // model exactly that — `setSystemTime` moves `Date.now()` and runs nothing.
    // A `seconds + 1` counter reads identically in every other test here.
    await renderSession(liveSession());
    expect(latest('Time')!.value).toBe('12:01');
    jest.setSystemTime(Date.now() + 60_000);
    await advanceSeconds(1);
    expect(latest('Time')!.value).toBe('13:02');
  });

  it('does count a render of the screen when the screen renders (the probe counts)', async () => {
    // Positive control. Without it, a probe that never saw the screen's own
    // renders would pass the zero assertion above forever.
    await renderSession(liveSession());
    const before = rendersOf('Sets').length;
    await screen.rerender(<SessionScreen />);
    expect(rendersOf('Sets').length).toBeGreaterThan(before);
  });
});

describe('a finished session', () => {
  it('shows the fixed duration and does not tick at all', async () => {
    await renderSession(liveSession({ ended_at: '2026-09-11T07:47:30.000Z' }));
    expect(latest('Time')!.value).toBe('47:30');
    const clockBefore = rendersOf('Time').length;
    const screenBefore = rendersOf('Sets').length;

    await advanceSeconds(5);

    expect(latest('Time')!.value).toBe('47:30');
    expect(rendersOf('Time').length - clockBefore).toBe(0);
    expect(rendersOf('Sets').length - screenBefore).toBe(0);
  });

  it('arms no interval at all for a finished session', async () => {
    // Asserted on the component alone, because through the screen a wasted
    // interval is invisible: the value is whole seconds from a fixed ended_at,
    // so every tick is a same-value update React skips, and the render counts
    // above stay flat either way. And not `jest.getTimerCount()`: measured, it
    // reads 3 for a lone finished `ElapsedStat` — the renderer's own timers —
    // so it cannot say whether this one armed anything.
    const { ElapsedStat } = jest.requireActual('@/components/ElapsedStat');
    const intervals = jest.spyOn(global, 'setInterval');
    const secondTicks = () => intervals.mock.calls.filter(([, ms]) => ms === 1000).length;

    const view = await render(
      <ElapsedStat startedAt={STARTED_AT} endedAt="2026-09-11T07:47:30.000Z" label="Time" />,
    );
    expect(secondTicks()).toBe(0);
    await view.unmount();
    // The control: an open one does arm exactly one.
    const open = await render(<ElapsedStat startedAt={STARTED_AT} endedAt={null} label="Time" />);
    expect(secondTicks()).toBe(1);
    // Every unmount and render in this file is AWAITED, and that is the part
    // that matters: RNTL 14's are async. With `view.unmount()` above left bare,
    // it overlapped the render below — two "overlapping act() calls" here, four
    // "not configured to support act" from later tests' screen teardown, and
    // (before this unmount existed) the NEXT test's screen never rendered
    // `session-summary` at all. Every test in this file still passed while it
    // leaked, which is F47's point. Measured with the awaits in place, deleting
    // this unmount changes nothing; it stays so no live interval outlives the
    // spy restored below.
    await open.unmount();
    intervals.mockRestore();
  });

  it('forwards the slot count StatRow injects, so the Time figure fits its column', async () => {
    await renderSession(liveSession({ ended_at: '2026-09-11T07:47:30.000Z' }));
    const slots = latest('Sets')!.slots;
    expect(slots).toBeGreaterThanOrEqual(3);
    expect(latest('Time')!.slots).toBe(slots);
  });
});
