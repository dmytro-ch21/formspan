import { fireEvent, render, screen } from '@testing-library/react-native';

import SessionScreen from '../../app/session/[id]';
import type { Exercise } from '@/lib/exercises';
import type { LoggedSet } from '@/lib/sessions';
import { cachedExercises, readLocalSession, type LocalSession } from '@/lib/sessionStore';

/**
 * N452 (#755): the live logging screen says which number to type.
 *
 * `measureHint` has its own unit suite. This one renders the real screen, with
 * its boundaries mocked in the shape of `sessionElapsedTick.test.tsx`, because
 * the bug was never the rule: the template builder already said "8 each side",
 * and the screen where the 8 is typed did not ask. A unit test of the helper
 * stays green if the screen stops calling it.
 *
 * The hint is read from each field's accessible name, which the screen builds
 * from the label and the hint, so this also pins what VoiceOver announces.
 */

jest.mock('expo-router', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const React = require('react');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { Text } = require('react-native');
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

// The screen replaces the cached catalog with whatever the fetch returns, so
// the fetch has to return the same exercises. An empty list here would leave
// every set without an exercise, and "no hint" would pass for that reason.
jest.mock('@/lib/exercises', () => ({
  ...jest.requireActual('@/lib/exercises'),
  fetchExercises: jest.fn(async () => mockCatalog),
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
jest.mock('@/components/SessionShare', () => ({
  useSessionShare: () => ({}),
  ShareCardHost: () => null,
  ShareSessionButton: () => null,
}));
jest.mock('@/components/SessionCelebration', () => ({ SessionCelebration: () => null }));
jest.mock('@/components/HRSessionReport', () => ({ HRSessionReport: () => null }));

// --- fixtures ---------------------------------------------------------------

const STARTED_AT = '2026-09-13T07:00:00.000Z';

function exercise(
  id: string,
  name: string,
  flags: Pick<Exercise, 'load_mode' | 'implements' | 'is_unilateral'>,
): Exercise {
  return {
    id,
    name,
    sport: 'strength',
    movement_pattern: 'lunge',
    primary_muscles: [],
    secondary_muscles: [],
    equipment: [],
    load_type: 'weight_reps',
    instructions: '',
    media: [],
    ...flags,
  };
}

// Flags as the catalog has them (backend/internal/modules/exercise/exercises.json).
const mockCatalog: Exercise[] = [
  exercise('dumbbell-lunge', 'Dumbbell lunge', { load_mode: 'per_side', implements: 2, is_unilateral: true }),
  exercise('back-squat', 'Back squat', { load_mode: 'total', implements: 1, is_unilateral: false }),
];

function workingSet(exercise_id: string, position: number): LoggedSet {
  return {
    exercise_id,
    position,
    set_type: 'working',
    reps: 8,
    weight_kg: 25,
    seconds: null,
    distance_m: null,
    rir: null,
    rpe: null,
    notes: '',
    completed: false,
  };
}

function liveSession(): LocalSession {
  return {
    id: 's1',
    user_id: 'u1',
    workout_id: null,
    sport: 'strength',
    name: 'Legs',
    intent: 'normal',
    started_at: STARTED_AT,
    ended_at: null,
    notes: '',
    sets: [workingSet('dumbbell-lunge', 0), workingSet('back-squat', 1)],
    created_at: STARTED_AT,
    updated_at: STARTED_AT,
    dirty: false,
  };
}

/** Opens set `index`'s editor. Pressing the row again would close it. */
async function openSet(index: number) {
  await fireEvent.press(screen.getByTestId(`set-${index}`));
  await screen.findByTestId(`set-${index}-reps`);
}

/** The accessible name of one field of an open set. */
function fieldName(index: number, measure: 'reps' | 'weight'): string {
  return screen.getByTestId(`set-${index}-${measure}`).props.accessibilityLabel as string;
}

beforeEach(async () => {
  (readLocalSession as jest.Mock).mockImplementation(async () => liveSession());
  (cachedExercises as jest.Mock).mockImplementation(async () => mockCatalog);
  await render(<SessionScreen />);
  await screen.findByTestId('session-summary');
  // Both exercises have to be in the catalog the rows read, or every
  // assertion below would be about an exercise the screen never found.
  await screen.findByText('Dumbbell lunge');
  await screen.findByText('Back squat');
});

describe('the live logging form on a unilateral exercise', () => {
  it('says "each side" beside Reps', async () => {
    await openSet(0);
    expect(fieldName(0, 'reps')).toBe('Reps each side for set 1 of Dumbbell lunge');
  });

  it('keeps "per hand" beside Weight, which reads a different catalog fact', async () => {
    await openSet(0);
    expect(fieldName(0, 'weight')).toMatch(/^Weight \S+ per hand for set 1 of Dumbbell lunge$/);
  });
});

describe('the live logging form on a bilateral exercise', () => {
  it('says nothing beside Reps or Weight', async () => {
    await openSet(1);
    expect(fieldName(1, 'reps')).toBe('Reps for set 1 of Back squat');
    expect(fieldName(1, 'weight')).toMatch(/^Weight \S+ for set 1 of Back squat$/);
  });
});
