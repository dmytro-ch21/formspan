import { useEffect } from 'react';
import { act, configure, fireEvent, render, screen, waitFor } from '@testing-library/react-native';

import { ApiError } from '@/lib/apiError';

import IdentifyMachineScreen from '../session/[id]/identify';

/**
 * The identify screen's commit path (N47).
 *
 * **There was no test for this screen at all**, which is why the finding this
 * file exists for survived a review that returned no blocking issues: the
 * commit path resolved a picked candidate by putting its exercise **id**
 * through the **name** search, and that works right up until a rename makes an
 * id stop being a slug of its name.
 *
 * What is pinned here is the commit path, not the camera — the camera cannot be
 * driven in jest, and the shortlist rendering is already governed by the rule
 * in the screen's own header.
 */

const mockUseEffect = useEffect;

jest.setTimeout(30_000);
configure({ asyncUtilTimeout: 10_000 });

const mockIdentify = jest.fn();
jest.mock('@/lib/identifyApi', () => {
  const real = jest.requireActual('@/lib/identifyApi');
  return { ...real, identifyMachine: (...a: unknown[]) => mockIdentify(...a) };
});

const mockFetchExercise = jest.fn();
jest.mock('@/lib/exercises', () => ({
  fetchExercise: (...a: unknown[]) => mockFetchExercise(...a),
  fetchExercises: jest.fn(() => {
    throw new Error('the commit path must never go through the name search');
  }),
}));

// Typed with a rest parameter so the spread below type-checks and so
// `mock.calls[0][3]` is reachable — an inferred zero-arg signature makes both
// a compile error, which `pnpm run verify` caught and `jest` alone did not.
const mockSwapExercise = jest.fn((..._a: unknown[]): unknown => [{ id: 'swapped' }]);
const mockEmptySet = jest.fn((..._a: unknown[]): unknown => ({ id: 'new' }));
jest.mock('@/lib/sessions', () => ({
  swapExercise: (...a: unknown[]) => mockSwapExercise(...a),
  emptySet: (...a: unknown[]) => mockEmptySet(...a),
}));

const mockReadSession = jest.fn();
const mockSaveSets = jest.fn();
jest.mock('@/lib/sessionStore', () => ({
  readLocalSession: (...a: unknown[]) => mockReadSession(...a),
  saveLocalSets: (...a: unknown[]) => mockSaveSets(...a),
}));

jest.mock('@/lib/sync', () => ({ request: jest.fn() }));

const mockLaunchCamera = jest.fn();
jest.mock('expo-image-picker', () => ({
  requestCameraPermissionsAsync: async () => ({ granted: true }),
  launchCameraAsync: (...a: unknown[]) => mockLaunchCamera(...a),
}));

let mockParams: Record<string, string> = { id: 'sess-1' };
jest.mock('expo-router', () => ({
  __esModule: true,
  useFocusEffect: (cb: () => void) => mockUseEffect(() => cb(), [cb]),
  useLocalSearchParams: () => mockParams,
  useRouter: () => ({ push: jest.fn(), back: jest.fn(), replace: jest.fn() }),
  Stack: { Screen: () => null },
}));

const ROW = {
  id: 'seated-cable-row',
  name: 'Cable Row Machine', // RENAMED — the id no longer slugs to the name.
  load_type: 'weight_reps',
};

function identification(candidates = [{ exercise_id: ROW.id, name: ROW.name, confidence: 0.8 }]) {
  return {
    identification: { equipment: 'cable-stack', candidates, model: 'test-model' },
  };
}

beforeEach(() => {
  mockParams = { id: 'sess-1' };
  mockIdentify.mockReset().mockResolvedValue(identification());
  mockFetchExercise.mockReset().mockResolvedValue(ROW);
  mockSwapExercise.mockClear();
  mockEmptySet.mockClear();
  mockReadSession.mockReset().mockResolvedValue({ sets: [] });
  mockSaveSets.mockReset().mockResolvedValue(undefined);
  mockLaunchCamera.mockReset().mockResolvedValue({
    canceled: false,
    assets: [{ uri: 'file:///machine.jpg' }],
  });
});

async function shootAndPick(name = ROW.name) {
  render(<IdentifyMachineScreen />);
  await act(async () => {
    fireEvent.press(screen.getByLabelText('Take a photo of the machine'));
  });
  await waitFor(() => expect(screen.getByLabelText(name)).toBeTruthy());
  await act(async () => {
    fireEvent.press(screen.getByLabelText(name));
  });
}

/**
 * The finding. A renamed exercise keeps its id (`TestRenamingKeepsTheID`,
 * #113, 2026-08-04), so resolving through the name search returns nothing and
 * the athlete is told the exercise is gone — about a row the server returned
 * seconds earlier. The mocked `fetchExercises` throws, so any regression to the
 * search path fails loudly rather than silently working on slug-shaped ids.
 */
it('resolves the picked candidate by id, not through the name search', async () => {
  await shootAndPick();
  expect(mockFetchExercise).toHaveBeenCalledWith(expect.anything(), 'seated-cable-row');
  expect(mockSaveSets).toHaveBeenCalled();
  expect(screen.queryByTestId('identify-error')).toBeNull();
});

describe('when the exercise cannot be fetched', () => {
  it('says it is gone only when the server says so', async () => {
    mockFetchExercise.mockRejectedValue(new ApiError('exercise not found', 'not_found', 404));
    await shootAndPick();
    await waitFor(() => expect(screen.getByTestId('identify-error')).toBeTruthy());
    expect(screen.getByTestId('identify-error')).toHaveTextContent(/no longer in the catalog/i);
    expect(mockSaveSets).not.toHaveBeenCalled();
  });

  /**
   * A dead network is not a statement about the catalog. Saying "no longer in
   * the catalog" there is a confident false answer — the same distinction the
   * barcode lookup turns on.
   */
  it('does NOT claim it is gone when it simply could not ask', async () => {
    mockFetchExercise.mockRejectedValue(new Error('Network request failed'));
    await shootAndPick();
    await waitFor(() => expect(screen.getByTestId('identify-error')).toBeTruthy());
    const text = screen.getByTestId('identify-error');
    expect(text).not.toHaveTextContent(/no longer in the catalog/i);
    expect(text).toHaveTextContent(/could not load/i);
  });
});

/**
 * `swapExercise` clears reps and weight unless the two exercises share a load
 * type, and it was being handed `undefined` — so an identify-driven swap wiped
 * the numbers even between two `weight_reps` machines. The row is fetched
 * anyway; this is what the fetching was for.
 */
describe('an identify-driven swap', () => {
  beforeEach(() => {
    mockParams = { id: 'sess-1', swap: 'old-machine' };
  });

  it('passes the replaced exercise’s load type so the numbers can carry', async () => {
    mockFetchExercise.mockImplementation(async (_t: unknown, id: string) =>
      id === 'old-machine' ? { ...ROW, id: 'old-machine', load_type: 'weight_reps' } : ROW,
    );
    await shootAndPick();
    await waitFor(() => expect(mockSwapExercise).toHaveBeenCalled());
    expect(mockSwapExercise).toHaveBeenCalledWith(
      expect.anything(),
      'old-machine',
      expect.objectContaining({ id: ROW.id }),
      'weight_reps',
    );
  });

  /** Losing the carry-over is worse than nothing; refusing the swap is worse still. */
  it('still swaps when the replaced exercise cannot be read', async () => {
    mockFetchExercise.mockImplementation(async (_t: unknown, id: string) => {
      if (id === 'old-machine') throw new Error('offline');
      return ROW;
    });
    await shootAndPick();
    await waitFor(() => expect(mockSwapExercise).toHaveBeenCalled());
    expect(mockSwapExercise.mock.calls[0][3]).toBeUndefined();
    expect(mockSaveSets).toHaveBeenCalled();
  });
});

/**
 * The contract says an empty candidate list is a 422 and never a 200. If that
 * were ever violated, the old render produced a heading — "Looks like a cable
 * stack. Which one is it?" — above nothing at all: answer-shaped, and an
 * answer to nothing.
 */
it('says so rather than rendering an empty shortlist', async () => {
  mockIdentify.mockResolvedValue(identification([]));
  render(<IdentifyMachineScreen />);
  await act(async () => {
    fireEvent.press(screen.getByLabelText('Take a photo of the machine'));
  });
  await waitFor(() => expect(screen.getByTestId('identify-empty')).toBeTruthy());
  expect(screen.getByTestId('identify-empty')).toHaveTextContent(/nothing in the catalog matched/i);
  expect(screen.queryByText(/Which one is it\?/)).toBeNull();
});

/**
 * `retryable` is about the IDENTIFICATION. Left alone across a commit failure,
 * a stale `true` renders "You can try again." beneath "Session not found on
 * this device" — a hint contradicting its own message.
 */
it('does not offer a retry that contradicts the commit error', async () => {
  mockReadSession.mockResolvedValue(null);
  await shootAndPick();
  await waitFor(() => expect(screen.getByTestId('identify-error')).toBeTruthy());
  expect(screen.getByTestId('identify-error')).toHaveTextContent(/Session not found/i);
  expect(screen.queryByText('You can try again.')).toBeNull();
});
