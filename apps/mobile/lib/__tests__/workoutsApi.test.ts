import { ApiError, isNotFound, isPermanentRejection } from '../apiError';
import { deleteWorkout, createWorkout, replaceItems } from '../workouts';

/**
 * The error CONTRACT of lib/workouts.ts, tested against the real module.
 *
 * This exists because of a specific near-miss. `workoutPush.test.ts` mocks
 * this module and has its mocks reject with `ApiError` — so its "a 404 counts
 * as success" and "a permanent refusal restores the row" tests passed while
 * the real module threw a plain `Error`, which `isNotFound` and
 * `isPermanentRejection` both answer `false` for. The mock was supplying the
 * contract under test, and no mutation of `sessionStore.ts` could reveal it,
 * because the defect was in the dependency.
 *
 * So: one test file that never mocks `../workouts`, asserting the property
 * the other file's mocks assume. If they drift apart again, this fails.
 */

const mockFetch = jest.fn();
jest.mock('../authedFetch', () => ({ netFetch: (...a: unknown[]) => mockFetch(...a) }));
jest.mock('../trace', () => ({ newTraceId: () => 't', traceparent: () => 'tp' }));
jest.mock('expo-crypto', () => ({ randomUUID: () => 'uuid' }));

const token = async () => 'tok';
const respond = (status: number, code: string) =>
  mockFetch.mockResolvedValue({
    ok: false,
    status,
    json: async () => ({ error: { code, message: 'nope' } }),
  });

beforeEach(() => mockFetch.mockReset());

describe('every workout call rejects with an ApiError', () => {
  // Each verb is listed because the classification happens per call site in
  // pushWorkoutRow, and one un-migrated path is enough to revive the bug.
  const calls: [string, () => Promise<unknown>][] = [
    ['deleteWorkout', () => deleteWorkout(token, 'w1')],
    ['createWorkout', () => createWorkout(token, {
      id: 'w1', name: 'n', sport: 'strength', goal: null, visibility: 'private',
    })],
    ['replaceItems', () => replaceItems(token, 'w1', [])],
  ];

  it.each(calls)('%s', async (_name, call) => {
    respond(404, 'not_found');
    await expect(call()).rejects.toBeInstanceOf(ApiError);
  });
});

it('a 404 is recognised as not-found, not as an unknown failure', async () => {
  respond(404, 'not_found');
  const err = await deleteWorkout(token, 'w1').catch((e) => e);
  expect(isNotFound(err)).toBe(true);
});

it('a 400 is recognised as a permanent refusal', async () => {
  respond(400, 'invalid_input');
  const err = await deleteWorkout(token, 'w1').catch((e) => e);
  expect(isPermanentRejection(err)).toBe(true);
});

it('carries the server code and status, not just a message', async () => {
  respond(409, 'already_exists');
  const err = (await createWorkout(token, {
    id: 'w1', name: 'n', sport: 'strength', goal: null, visibility: 'private',
  }).catch((e) => e)) as ApiError;
  expect([err.code, err.status]).toEqual(['already_exists', 409]);
});

it('still prefers the envelope message a person can act on', async () => {
  // Regression guard: the migration to ApiError must not cost the specific
  // messages the API writes for user-actionable cases.
  respond(400, 'invalid_input');
  const err = (await replaceItems(token, 'w1', []).catch((e) => e)) as ApiError;
  expect(err.message).toBe('nope');
});
