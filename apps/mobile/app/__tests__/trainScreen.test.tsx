import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';

import TrainScreen from '../(tabs)/train';
import type { Module } from '@/lib/modules';
import type { PlannedSession } from '@/lib/plan';
import type { Session } from '@/lib/sessions';
import type { Workout } from '@/lib/workouts';

/**
 * Train, as rendered — the half `lib/trainBoard.ts`'s tests cannot reach.
 *
 * Two properties live only here, and both are ordering rules that a correct
 * derivation can still get wrong on screen:
 *
 * 1. **Resume outranks every other CTA.** The derivation says there is a
 *    session to resume; only the render decides whether that fact displaces
 *    today's Start button or merely sits above it.
 * 2. **A discipline routes to the screen that fits it.** BJJ goes to
 *    `/bjj/log`, not the set logger. That is one `if` in `lib/startSession.ts`,
 *    it has its own tests, and this file checks that the button on Train is
 *    genuinely wired to it rather than to a second copy.
 *
 * Everything is driven through mocked reads of the app's real functions, so a
 * failure here is a failure in this screen and not in SQLite.
 */

jest.setTimeout(30_000);

const mockListLocalSessions = jest.fn((..._a: unknown[]): Promise<Session[]> => Promise.resolve([]));
const mockCachedWorkouts = jest.fn((..._a: unknown[]): Promise<Workout[]> => Promise.resolve([]));
jest.mock('@/lib/sessionStore', () => ({
  listLocalSessions: (...a: unknown[]) => mockListLocalSessions(...a),
  cachedWorkouts: (...a: unknown[]) => mockCachedWorkouts(...a),
}));

const mockListPlannedBetween = jest.fn(
  (..._a: unknown[]): Promise<PlannedSession[]> => Promise.resolve([]),
);
jest.mock('@/lib/plan', () => ({
  listPlannedBetween: (...a: unknown[]) => mockListPlannedBetween(...a),
}));

const mockPush = jest.fn();
jest.mock('expo-router', () => {
  const react = jest.requireActual<typeof import('react')>('react');
  return {
    useRouter: () => ({ push: mockPush }),
    // Runs the effect once on mount, which is what a focused screen does. The
    // real one also re-runs on refocus; nothing here navigates away.
    useFocusEffect: (cb: () => void | (() => void)) => react.useEffect(cb, [cb]),
  };
});

jest.mock('@clerk/clerk-expo', () => ({ useAuth: () => ({ userId: 'u1' }) }));

jest.mock('@/lib/sync', () => ({
  useSyncState: () => ({
    syncing: false,
    pending: 0,
    deferred: 0,
    lastSyncAt: null,
    lastError: null,
    online: true,
  }),
}));

function mod(over: Partial<Module> & { key: string }): Module {
  return {
    key: over.key,
    label: over.label ?? over.key,
    is_sport: over.is_sport ?? true,
    default_on: true,
    enabled: over.enabled ?? true,
    capabilities: {
      catalog: '',
      facets: [],
      has_goals: false,
      has_progression: false,
      has_food_log: false,
      record_kinds: [],
      ...(over.capabilities ?? {}),
    },
  } as Module;
}

const strength = mod({
  key: 'strength',
  label: 'Strength',
  capabilities: { catalog: 'exercises' } as Module['capabilities'],
});
const bjj = mod({
  key: 'bjj',
  label: 'BJJ',
  capabilities: { catalog: 'techniques' } as Module['capabilities'],
});

// `mock`-prefixed, because jest's module factory may not close over an
// ordinary out-of-scope variable — the guard against uninitialised mocks.
let mockModules: Module[] = [strength, bjj];
jest.mock('@/lib/ModulesProvider', () => ({
  useModules: () => ({ modules: mockModules, ready: true, stale: false, apply: jest.fn() }),
}));

function session(over: Partial<Session> & { id: string }): Session {
  return {
    id: over.id,
    user_id: 'u1',
    workout_id: null,
    sport: 'strength',
    name: 'Legs',
    started_at: new Date(Date.now() - 30 * 60_000).toISOString(),
    ended_at: 'ended_at' in over ? (over.ended_at ?? null) : new Date().toISOString(),
    notes: '',
    sets: [],
    created_at: '2026-08-26T09:00:00Z',
    updated_at: '2026-08-26T09:00:00Z',
    ...over,
  };
}

/** Today's local calendar day, the way the app computes it. */
function todayKey(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

beforeEach(() => {
  mockModules = [strength, bjj];
  mockPush.mockReset();
  mockListLocalSessions.mockReset();
  mockListLocalSessions.mockResolvedValue([]);
  mockCachedWorkouts.mockReset();
  mockCachedWorkouts.mockResolvedValue([]);
  mockListPlannedBetween.mockReset();
  mockListPlannedBetween.mockResolvedValue([]);
});

describe('resume outranks everything', () => {
  it('offers Resume, and does not offer to start the day as well', async () => {
    mockListLocalSessions.mockResolvedValue([session({ id: 'open', ended_at: null })]);
    mockListPlannedBetween.mockResolvedValue([
      { id: 'p1', day: todayKey(), sport: 'strength', workoutId: null, notes: '' },
    ]);

    render(<TrainScreen />);

    await waitFor(() => expect(screen.getByTestId('train-resume')).toBeTruthy());
    // The plan exists and is owed — the derivation would happily return it —
    // and the screen still does not render a competing Start. Delete the
    // `resume ?` branch and both of these go red.
    expect(screen.queryByTestId('train-today-p1')).toBeNull();
    expect(screen.queryByTestId('train-today-none')).toBeNull();
  });

  it('takes Resume to the session it names', async () => {
    mockListLocalSessions.mockResolvedValue([session({ id: 'open', ended_at: null })]);
    render(<TrainScreen />);

    fireEvent.press(await screen.findByTestId('train-resume'));
    expect(mockPush).toHaveBeenCalledWith({ pathname: '/session/[id]', params: { id: 'open' } });
  });

  // The branch that must survive any rebuild of this screen. A BJJ session
  // opened in the set logger renders a screen it can never fill, and the
  // reflection behind it becomes unreachable.
  it('takes a resumable BJJ session to the BJJ reader, not the set logger', async () => {
    mockListLocalSessions.mockResolvedValue([
      session({ id: 'roll', sport: 'bjj', name: 'Evening class', ended_at: null }),
    ]);
    render(<TrainScreen />);

    fireEvent.press(await screen.findByTestId('train-resume'));
    expect(mockPush).toHaveBeenCalledWith({ pathname: '/bjj/session/[id]', params: { id: 'roll' } });
  });

  it('says a day-old session is unfinished rather than in progress', async () => {
    mockListLocalSessions.mockResolvedValue([
      session({
        id: 'stale',
        ended_at: null,
        started_at: new Date(Date.now() - 30 * 60 * 60_000).toISOString(),
      }),
    ]);
    render(<TrainScreen />);

    expect(await screen.findByText('UNFINISHED')).toBeTruthy();
    expect(screen.getByText('Finish or discard')).toBeTruthy();
    expect(screen.queryByText('Resume')).toBeNull();
  });
});

describe("today's plan", () => {
  it('offers Start for a planned strength day', async () => {
    mockListPlannedBetween.mockResolvedValue([
      { id: 'p1', day: todayKey(), sport: 'strength', workoutId: 'w7', notes: '' },
    ]);
    mockCachedWorkouts.mockResolvedValue([
      {
        id: 'w7',
        owner_user_id: 'u1',
        name: 'Push A',
        sport: 'strength',
        goal: null,
        notes: '',
        visibility: 'private',
        items: [],
        created_at: '',
        updated_at: '',
      } as Workout,
    ]);

    render(<TrainScreen />);

    expect(await screen.findByTestId('train-today-p1')).toBeTruthy();
    expect(screen.getByText('Push A')).toBeTruthy();
    fireEvent.press(screen.getByTestId('up-next-log'));
    // The template rides along, so the chooser does not reappear for a day
    // whose plan is already decided.
    expect(mockPush).toHaveBeenCalledWith('/session/start?sport=strength&workout=w7');
  });

  it('says Log rather than Start for a discipline logged afterwards', async () => {
    mockListPlannedBetween.mockResolvedValue([
      { id: 'p2', day: todayKey(), sport: 'bjj', workoutId: null, notes: '' },
    ]);
    render(<TrainScreen />);

    expect(await screen.findByTestId('train-today-p2')).toBeTruthy();
    fireEvent.press(screen.getByTestId('up-next-log'));
    expect(mockPush).toHaveBeenCalledWith('/bjj/log');
  });
});

describe('quick start', () => {
  it('starts a strength session through the existing start flow', async () => {
    render(<TrainScreen />);
    fireEvent.press(await screen.findByTestId('train-quick-strength'));
    expect(mockPush).toHaveBeenCalledWith('/session/start?sport=strength');
  });

  // Criterion 5 of the ticket, and the one that is silent when broken: a BJJ
  // round pushed into the strength logger fails nothing.
  it('sends BJJ to the BJJ log, never to the set logger', async () => {
    render(<TrainScreen />);
    fireEvent.press(await screen.findByTestId('train-quick-bjj'));
    expect(mockPush).toHaveBeenCalledWith('/bjj/log');
  });

  it('drops a discipline that has been turned off', async () => {
    mockModules = [strength, mod({ key: 'bjj', label: 'BJJ', enabled: false })];
    render(<TrainScreen />);

    expect(await screen.findByTestId('train-quick-strength')).toBeTruthy();
    expect(screen.queryByTestId('train-quick-bjj')).toBeNull();
  });

  // ...but still NAMES it. An athlete who cannot see a discipline cannot tell
  // "turned off" from "not built" from "broken" — the one time that happened
  // the user went looking on a real phone and reported working features as
  // missing.
  it('still says a turned-off discipline exists', async () => {
    mockModules = [strength, mod({ key: 'bjj', label: 'BJJ', enabled: false })];
    render(<TrainScreen />);

    const note = await screen.findByTestId('train-off-sports');
    expect(note).toBeTruthy();
    fireEvent.press(note);
    expect(mockPush).toHaveBeenCalledWith('/profile/edit');
  });

  it('offers the settings screen when nothing at all is enabled', async () => {
    mockModules = [mod({ key: 'strength', enabled: false })];
    render(<TrainScreen />);

    expect(await screen.findByTestId('train-choose-sports')).toBeTruthy();
    expect(screen.queryByTestId('train-quick-start')).toBeNull();
  });
});

describe('it never claims an absence it has not checked', () => {
  /** A read that is still in flight when the assertion runs. */
  const pending = <T,>() => new Promise<T>(() => {});

  it('does not say the day is unplanned while the plan read is in flight', async () => {
    mockListPlannedBetween.mockReturnValue(pending<PlannedSession[]>());
    render(<TrainScreen />);

    // Quick start proves the screen has rendered — so the absence below is a
    // deliberate silence and not a test that asserted before the first paint.
    expect(await screen.findByTestId('train-quick-strength')).toBeTruthy();
    expect(screen.queryByTestId('train-today-none')).toBeNull();
    expect(screen.queryByTestId('train-today-unavailable')).toBeNull();
  });

  it('does not say nothing was logged while the session read is in flight', async () => {
    mockListLocalSessions.mockReturnValue(pending<Session[]>());
    render(<TrainScreen />);

    expect(await screen.findByTestId('train-quick-strength')).toBeTruthy();
    expect(screen.queryByTestId('train-recent-none')).toBeNull();
  });

  it('says the plan could not be read rather than showing an unplanned day', async () => {
    mockListPlannedBetween.mockRejectedValue(new Error('disk'));
    render(<TrainScreen />);

    expect(await screen.findByTestId('train-today-unavailable')).toBeTruthy();
    expect(screen.queryByTestId('train-today-none')).toBeNull();
  });

  it('says the history could not be read rather than showing an empty one', async () => {
    mockListLocalSessions.mockRejectedValue(new Error('disk'));
    render(<TrainScreen />);

    expect(await screen.findByTestId('train-recent-unavailable')).toBeTruthy();
    expect(screen.queryByTestId('train-recent-none')).toBeNull();
  });

  it('does claim an empty day once the read has answered', async () => {
    // The mirror of the in-flight cases, and what stops them passing by the
    // screen simply never rendering an empty state at all.
    render(<TrainScreen />);
    expect(await screen.findByTestId('train-today-none')).toBeTruthy();
    expect(await screen.findByTestId('train-recent-none')).toBeTruthy();
  });
});

describe('offline', () => {
  it('renders and starts a session with every network read absent', async () => {
    // The three reads this screen makes are SQLite. Nothing else is mocked in
    // — no fetch, no token, no sync run is requested — so a screen that had
    // grown a network dependency would fail here rather than on a phone in a
    // basement.
    mockListLocalSessions.mockResolvedValue([session({ id: 's1' })]);
    render(<TrainScreen />);

    fireEvent.press(await screen.findByTestId('train-quick-strength'));
    expect(mockPush).toHaveBeenCalledWith('/session/start?sport=strength');
    expect(screen.getByTestId('train-recent-s1')).toBeTruthy();
  });
});

describe('later', () => {
  it('shows the next planned day alongside a running session', async () => {
    const d = new Date();
    d.setDate(d.getDate() + 2);
    const day = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

    mockListLocalSessions.mockResolvedValue([session({ id: 'open', ended_at: null })]);
    mockListPlannedBetween.mockResolvedValue([
      { id: 'p9', day, sport: 'bjj', workoutId: null, notes: '' },
    ]);

    render(<TrainScreen />);

    expect(await screen.findByTestId('train-later')).toBeTruthy();
    expect(screen.getByText('BJJ session')).toBeTruthy();
  });

  it('draws no Later block at all when nothing is planned ahead', async () => {
    render(<TrainScreen />);
    expect(await screen.findByTestId('train-quick-strength')).toBeTruthy();
    expect(screen.queryByTestId('train-later')).toBeNull();
  });
});
