import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';

import SessionScreen from '../../app/session/[id]';
import type { Exercise } from '@/lib/exercises';
import type { LoggedSet } from '@/lib/sessions';
import { cachedExercises, readLocalSession, type LocalSession } from '@/lib/sessionStore';

/**
 * N207 (#661): ticking a set folds its row.
 *
 * A set row has been one summary line with a disclosure since the screen was
 * built; the editor opens on a tap. What the athlete hit was the row they had
 * OPENED to type the numbers into: ticking it left the editor standing, so the
 * finished set still dominated the screen and pushed the next one down.
 *
 * So the tick closes the editor, in the same tap — no second gesture — and an
 * un-tick puts back the editor the tick closed. Rendered for real, with the
 * boundaries mocked in the shape of `strengthSetHints.test.tsx`, because the
 * rule lives in the row component's own state and there is no helper to test
 * instead.
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

const STARTED_AT = '2026-09-15T07:00:00.000Z';

const mockCatalog: Exercise[] = [
  {
    id: 'back-squat',
    name: 'Back squat',
    sport: 'strength',
    movement_pattern: 'squat',
    primary_muscles: [],
    secondary_muscles: [],
    equipment: [],
    load_type: 'weight_reps',
    instructions: '',
    media: [],
    load_mode: 'total',
    implements: 1,
    is_unilateral: false,
  },
];

function workingSet(position: number): LoggedSet {
  return {
    exercise_id: 'back-squat',
    position,
    set_type: 'working',
    reps: 8,
    weight_kg: 100,
    seconds: null,
    distance_m: null,
    rir: null,
    rpe: null,
    notes: '',
    completed: false,
  };
}

function liveSession(sets: LoggedSet[] = [workingSet(0), workingSet(1)]): LocalSession {
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
    sets,
    created_at: STARTED_AT,
    updated_at: STARTED_AT,
    dirty: false,
  };
}

// --- helpers ----------------------------------------------------------------

/** Whether set `index`'s editor is showing. Reps is always one of its fields here. */
function editorOpen(index: number): boolean {
  return screen.queryByTestId(`set-${index}-reps`) != null;
}

/** Whether set `index`'s tick reads as done, from what VoiceOver is told. */
function ticked(index: number): boolean {
  return screen.getByTestId(`done-${index}`).props.accessibilityState?.checked === true;
}

/** Taps set `index`'s row head, which opens or closes its editor. */
async function pressRow(index: number) {
  await fireEvent.press(screen.getByTestId(`set-${index}`));
}

/** Taps set `index`'s tick. One tap: that is the whole gesture being tested. */
async function pressTick(index: number) {
  await fireEvent.press(screen.getByTestId(`done-${index}`));
}

async function renderSession(session: LocalSession) {
  (readLocalSession as jest.Mock).mockImplementation(async () => session);
  (cachedExercises as jest.Mock).mockImplementation(async () => mockCatalog);
  await render(<SessionScreen />);
  await screen.findByTestId('session-summary');
  await screen.findByText('Back squat');
}

describe('ticking a set', () => {
  beforeEach(() => renderSession(liveSession()));

  it('closes the editor the athlete opened, in the same tap', async () => {
    await pressRow(0);
    expect(editorOpen(0)).toBe(true);

    await pressTick(0);

    expect(ticked(0)).toBe(true);
    expect(editorOpen(0)).toBe(false);
  });

  it('keeps the numbers typed just before the tick, and the folded row still names them', async () => {
    await pressRow(0);
    await fireEvent.changeText(screen.getByTestId('set-0-reps'), '10');

    await pressTick(0);

    // Closing the editor unmounts the fields. Every keystroke is already a
    // commit, so nothing typed is lost — and the one line left on screen is
    // what identifies the set.
    expect(editorOpen(0)).toBe(false);
    expect(screen.getByTestId('set-0').props.accessibilityLabel).toMatch(/^Set 1\. 10 /);
  });

  it('leaves a row that was never opened exactly as it was', async () => {
    await pressTick(0);

    expect(ticked(0)).toBe(true);
    expect(editorOpen(0)).toBe(false);
  });

  it('touches no other row', async () => {
    await pressRow(1);
    await pressRow(0);

    await pressTick(0);

    expect(editorOpen(0)).toBe(false);
    expect(editorOpen(1)).toBe(true);
  });
});

describe('un-ticking a set', () => {
  beforeEach(() => renderSession(liveSession()));

  it('puts back the editor the tick closed, with the numbers in it', async () => {
    await pressRow(0);
    await fireEvent.changeText(screen.getByTestId('set-0-reps'), '10');
    await pressTick(0);
    expect(editorOpen(0)).toBe(false);

    await pressTick(0);

    expect(ticked(0)).toBe(false);
    expect(editorOpen(0)).toBe(true);
    expect(screen.getByTestId('set-0-reps').props.value).toBe('10');
  });

  it('does not open a row the tick never closed', async () => {
    await pressTick(0);
    await pressTick(0);

    expect(ticked(0)).toBe(false);
    expect(editorOpen(0)).toBe(false);
  });

  it('leaves a done set the athlete re-opened to correct open', async () => {
    await pressTick(0);
    await pressRow(0);
    expect(editorOpen(0)).toBe(true);

    await pressTick(0);

    expect(ticked(0)).toBe(false);
    expect(editorOpen(0)).toBe(true);
  });

  it('forgets the fold once the athlete has opened and closed the row by hand', async () => {
    await pressRow(0);
    await pressTick(0);
    await pressRow(0);
    await pressRow(0);
    expect(editorOpen(0)).toBe(false);

    await pressTick(0);

    // They closed it themselves after the tick; reopening it now would be
    // overriding a choice made more recently than the one being restored.
    expect(editorOpen(0)).toBe(false);
  });

  it('forgets the fold when the list changes shape between the tick and the un-tick', async () => {
    await pressRow(0);
    await pressTick(0);
    await fireEvent.press(screen.getByTestId('add-set-back-squat'));
    await screen.findByTestId('set-2');

    await pressTick(0);

    // Rows are keyed by index, so once a set is added or swiped away the row in
    // this slot may hold a different set, and restoring an editor here could
    // open one nobody closed. Adding is the shape change a test can drive; the
    // swipe is a gesture it cannot.
    expect(ticked(0)).toBe(false);
    expect(editorOpen(0)).toBe(false);
  });
});

describe('a countdown ticking a set', () => {
  // A one-second timer target on a squat: the timer's completion path ticks the
  // set (`recordTimedSet(…, true)`) with no tap on the row at all.
  beforeEach(() => renderSession(liveSession([{ ...workingSet(0), seconds: 1 }, workingSet(1)])));

  it('leaves the editor open, because nobody tapped the row', async () => {
    await pressRow(0);
    expect(editorOpen(0)).toBe(true);

    await fireEvent.press(screen.getByTestId('start-timer-0'));
    await waitFor(() => expect(ticked(0)).toBe(true), { timeout: 5000 });

    // Folding here would move the rows under an athlete who is not touching
    // them. The fold belongs to the tick's own tap, not to `completed`.
    expect(editorOpen(0)).toBe(true);
  }, 15000);
});
