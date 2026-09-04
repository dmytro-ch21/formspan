/**
 * N479/#824 — `useDetectedActivity`'s failure handling, found asymmetric in
 * review: `dismiss` already wrapped its write in `.catch()` (a lost
 * dismissal is a minor, self-correcting annoyance — the card just
 * reappears), but `logIt` did not, which meant a failed
 * `logDetectionAsSession` left the card gone from `items` with nothing
 * created — the athlete has every reason to believe the walk is logged, and
 * it isn't. This file locks in the fix: `logIt` puts the item BACK into
 * `items` on failure, same reasoning `useAuthToken.test.ts` gives for using
 * `renderHook` directly rather than pulling out a pure helper — the thing
 * under test IS the hook's own state transition across an async boundary.
 *
 * Every dependency is mocked — no real SQLite here, that lives in
 * `detectedActivity.test.ts`'s fixture suite.
 */

import { act, renderHook, waitFor } from '@testing-library/react-native';

import { useDetectedActivity } from '../useDetectedActivity';
import type { DetectedWorkout } from '../detectedActivity';

const mockReadRecentDetections = jest.fn();
const mockDismissDetection = jest.fn();
const mockLogDetectionAsSession = jest.fn();
jest.mock('../detectedActivity', () => ({
  ...jest.requireActual('../detectedActivity'),
  readRecentDetections: (...a: unknown[]) => mockReadRecentDetections(...a),
  dismissDetection: (...a: unknown[]) => mockDismissDetection(...a),
  logDetectionAsSession: (...a: unknown[]) => mockLogDetectionAsSession(...a),
}));

jest.mock('../sessionStore', () => ({ sessionsSince: () => Promise.resolve([]) }));

const USER = 'user_1';

function workout(overrides: Partial<DetectedWorkout> = {}): DetectedWorkout {
  return {
    id: 'hk-walk-1',
    type: 'walking',
    source: 'healthkit',
    startDate: '2026-09-01T07:00:00.000Z',
    endDate: '2026-09-01T07:32:00.000Z',
    durationSeconds: 1920,
    distanceMeters: 2400,
    ...overrides,
  };
}

beforeEach(() => {
  mockReadRecentDetections.mockReset();
  mockDismissDetection.mockReset();
  mockLogDetectionAsSession.mockReset();
});

async function seeded(items: DetectedWorkout[]) {
  mockReadRecentDetections.mockResolvedValue(items);
  const rendered = renderHook(() => useDetectedActivity(USER));
  act(() => {
    rendered.result.current.refresh();
  });
  await waitFor(() => expect(rendered.result.current.items).toEqual(items));
  return rendered;
}

describe('logIt', () => {
  it('removes the item immediately (optimistic) and never re-adds it on success', async () => {
    const w = workout();
    mockLogDetectionAsSession.mockResolvedValue(undefined);
    const { result } = await seeded([w]);

    act(() => {
      result.current.logIt(w);
    });
    expect(result.current.items).toEqual([]);

    // Give the resolved promise's microtask a turn — it must not put the
    // item back just because the write finished.
    await waitFor(() => expect(mockLogDetectionAsSession).toHaveBeenCalledWith(USER, w));
    expect(result.current.items).toEqual([]);
  });

  it('puts the item BACK when the write fails, unlike a failed dismiss', async () => {
    const w = workout();
    mockLogDetectionAsSession.mockRejectedValue(new Error('sqlite write failed'));
    const { result } = await seeded([w]);

    act(() => {
      result.current.logIt(w);
    });
    expect(result.current.items).toEqual([]);

    await waitFor(() => expect(result.current.items).toEqual([w]));
  });
});

describe('dismiss', () => {
  it('removes the item immediately and stays removed even when the write fails', async () => {
    const w = workout();
    mockDismissDetection.mockRejectedValue(new Error('sqlite write failed'));
    const { result } = await seeded([w]);

    act(() => {
      result.current.dismiss(w);
    });
    expect(result.current.items).toEqual([]);

    // Best-effort: a failed dismiss stays silent rather than restoring the
    // card — see this file's own doc comment for why that asymmetry with
    // `logIt` is intentional.
    await waitFor(() => expect(mockDismissDetection).toHaveBeenCalledWith(USER, w.id));
    expect(result.current.items).toEqual([]);
  });
});
