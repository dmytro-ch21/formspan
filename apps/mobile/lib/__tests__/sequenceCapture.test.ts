import { ApiError, OfflineError } from '../apiError';
import {
  captureSequence,
  listSequences,
  pendingSequenceCount,
  syncSequences,
} from '../sequences';
import { migratedFixture, type FixtureDb } from './support/sqlite';

/**
 * Capturing a chain on the mat, against a real database.
 *
 * The capture moment is the changing room after class, which is a gym
 * dead-spot more often than not — so every property worth testing here is
 * about what happens when the network is absent or hostile, and each one is a
 * bug this codebase has already shipped once in the sessions, workouts or
 * plans outbox:
 *
 *  - a permanent refusal that leaves the row dirty forever, so `pending` never
 *    reaches zero and the sync screen nags about something that can never go;
 *  - a push that keeps walking the queue against a dead network, turning one
 *    offline capture into N pointless requests;
 *  - a list that shows the server's copy AND the outbox copy of one chain, so
 *    a successful capture looks like it happened twice;
 *  - an order that survives the write and is lost on the read, which for a
 *    sequence is the entire content.
 */

let db: FixtureDb;
let mockFixture: FixtureDb;
let mockUuidSeq = 0;

jest.mock('../db', () => {
  const real = jest.requireActual('../db');
  return { ...real, getDb: async () => mockFixture };
});

jest.mock('expo-crypto', () => ({
  randomUUID: () => `uuid-${++mockUuidSeq}`,
}));

const mockApi = jest.fn();
jest.mock('../apiRequest', () => ({
  apiRequest: (...a: unknown[]) => mockApi(...a),
}));

// ApiError is (message, code, status) — status LAST. Getting that order wrong
// hands `isPermanentStatus` a string, every failure classifies as transient,
// and the 5xx test passes for entirely the wrong reason. It did, here, before
// the 4xx test next to it disagreed.
const USER = 'u1';
const getToken = async () => 'token';

beforeEach(async () => {
  db = await migratedFixture();
  mockFixture = db;
  mockUuidSeq = 0;
  mockApi.mockReset().mockResolvedValue({ sequences: [] });
});

/** The raw row, for asserting on outbox flags the public API hides. */
async function row(id: string) {
  return db.getFirstAsync<{ dirty: number; remote: number; last_error: string | null; steps_json: string }>(
    `SELECT dirty, remote, last_error, steps_json FROM sequences WHERE id = ?`,
    id,
  );
}

const CHAIN = {
  name: 'Closed guard to side control',
  steps: [
    { technique_id: 'closed-guard-standing-break' },
    { technique_id: 'knee-cut-pass' },
    { technique_id: 'side-control-knee-on-belly' },
  ],
};

describe('capturing offline', () => {
  it('writes locally and owes it to the server', async () => {
    const id = await captureSequence(USER, CHAIN);
    expect(id).toBe('uuid-1');

    const r = await row(id);
    expect(r?.dirty).toBe(1);
    // `remote = 0` is what tells "never pushed" from "pushed and failed" —
    // collapsing them makes a failed push indistinguishable from a fresh row.
    expect(r?.remote).toBe(0);
    expect(await pendingSequenceCount(USER)).toBe(1);
  });

  it('preserves step order, which for a chain is the whole content', async () => {
    const id = await captureSequence(USER, CHAIN);
    const stored = JSON.parse((await row(id))!.steps_json) as { technique_id: string }[];
    expect(stored.map((s) => s.technique_id)).toEqual([
      'closed-guard-standing-break',
      'knee-cut-pass',
      'side-control-knee-on-belly',
    ]);

    // ...and back out through the public read, which is where a re-sort would
    // actually bite. Asserted separately: the write could be right and the
    // read still order by id or name.
    const [seq] = await listSequences(USER, getToken);
    expect(seq.steps?.map((s) => s.technique_id)).toEqual([
      'closed-guard-standing-break',
      'knee-cut-pass',
      'side-control-knee-on-belly',
    ]);
  });

  it('is visible with no network at all', async () => {
    await captureSequence(USER, CHAIN);
    mockApi.mockRejectedValue(new OfflineError());

    // The load-bearing one. If this returned [] the athlete would think the
    // capture failed and do it again, which is how you get two chains.
    const list = await listSequences(USER, getToken);
    expect(list).toHaveLength(1);
    expect(list[0].pending).toBe(true);
  });

  it('does not swallow a real server fault as "you have none"', async () => {
    // Offline resolves to the outbox; a 500 must NOT, or a broken server reads
    // as an empty library — the failure this codebase keeps re-learning.
    mockApi.mockRejectedValue(new ApiError('boom', 'internal', 500));
    await expect(listSequences(USER, getToken)).rejects.toThrow();
  });
});

describe('pushing', () => {
  it('sends the client id, so a retry cannot double-create', async () => {
    const id = await captureSequence(USER, CHAIN);
    mockApi.mockResolvedValue({ id });

    const res = await syncSequences(USER, getToken);
    expect(res.pushed).toBe(1);

    const [, path, init] = mockApi.mock.calls[0] as [unknown, string, { body: string }];
    expect(path).toBe('/sequences');
    const body = JSON.parse(init.body);
    // Without this the server mints a new id per retry and a flaky gym
    // connection produces one chain per attempt.
    expect(body.id).toBe(id);
    expect(body.steps).toHaveLength(3);

    const r = await row(id);
    expect(r?.dirty).toBe(0);
    expect(r?.remote).toBe(1);
    expect(await pendingSequenceCount(USER)).toBe(0);
  });

  it('stops owing a permanently-refused capture, and says why', async () => {
    const id = await captureSequence(USER, CHAIN);
    mockApi.mockRejectedValue(new ApiError('bad steps', 'invalid_input', 400));

    const res = await syncSequences(USER, getToken);
    expect(res.failed).toBe(1);
    expect(res.errorKind).toBe('permanent');

    const r = await row(id);
    // A 4xx will not become a 2xx. Left dirty, the outbox never drains and the
    // pending badge nags forever about something that can never go.
    expect(r?.dirty).toBe(0);
    expect(r?.last_error).toContain('bad steps');
    expect(await pendingSequenceCount(USER)).toBe(0);
    // The athlete's row is still on the phone — refusing to send it is not a
    // reason to destroy it. Checked later, with the server reachable again,
    // because that is when the athlete would actually look.
    mockApi.mockResolvedValue({ sequences: [] });
    const list = await listSequences(USER, getToken);
    expect(list.some((s) => s.id === id)).toBe(false); // no longer pending…
    expect(await row(id)).not.toBeNull(); // …but not deleted either
  });

  it('keeps owing a transiently-failed capture', async () => {
    const id = await captureSequence(USER, CHAIN);
    mockApi.mockRejectedValue(new ApiError('later', 'internal', 503));

    const res = await syncSequences(USER, getToken);
    expect(res.errorKind).toBe('transient');
    // Still dirty: a 5xx is exactly what the retry ladder exists for.
    expect((await row(id))?.dirty).toBe(1);
    expect(await pendingSequenceCount(USER)).toBe(1);
  });

  it('stops walking the queue when the network is gone', async () => {
    await captureSequence(USER, CHAIN);
    await captureSequence(USER, { ...CHAIN, name: 'Second' });
    await captureSequence(USER, { ...CHAIN, name: 'Third' });
    mockApi.mockRejectedValue(new OfflineError());

    const res = await syncSequences(USER, getToken);
    expect(res.errorKind).toBe('offline');
    // ONE attempt, not three. Three captures in a dead-spot must not become
    // three round trips against a network that is not there.
    expect(mockApi).toHaveBeenCalledTimes(1);
    expect(await pendingSequenceCount(USER)).toBe(3);
  });

  it('does not jam the outbox behind a corrupt local row', async () => {
    const bad = await captureSequence(USER, CHAIN);
    await db.runAsync(`UPDATE sequences SET steps_json = ? WHERE id = ?`, 'not json{', bad);
    const good = await captureSequence(USER, { ...CHAIN, name: 'Fine' });
    mockApi.mockResolvedValue({});

    const res = await syncSequences(USER, getToken);
    // The corrupt one is retired with a reason; the good one still goes.
    expect(res.failed).toBe(1);
    expect(res.pushed).toBe(1);
    expect((await row(bad))?.dirty).toBe(0);
    expect((await row(bad))?.last_error).toContain('corrupt');
    expect((await row(good))?.remote).toBe(1);
  });
});

describe('the merged list', () => {
  it('shows one chain, not two, in the window after a push', async () => {
    const id = await captureSequence(USER, CHAIN);
    // The server now knows it, but suppose the local row is still dirty —
    // exactly the window between a successful POST and the flag being written.
    mockApi.mockResolvedValue({
      sequences: [{ id, name: CHAIN.name, description: '', start_position_id: null, step_count: 3, editable: true }],
    });

    const list = await listSequences(USER, getToken);
    expect(list).toHaveLength(1);
    // Local wins: it is the copy that still has to go, and showing the
    // server's would hide that.
    expect(list[0].pending).toBe(true);
  });

  it('shows the server’s chains alongside pending ones', async () => {
    await captureSequence(USER, CHAIN);
    mockApi.mockResolvedValue({
      sequences: [
        { id: 'from-web', name: 'Built at a desk', description: '', start_position_id: null, step_count: 4, editable: true },
      ],
    });

    const list = await listSequences(USER, getToken);
    expect(list).toHaveLength(2);
    expect(list.find((s) => s.id === 'from-web')?.pending).toBeUndefined();
  });

  it('scopes to the signed-in athlete', async () => {
    // A shared phone. An unscoped outbox would show one account's captures to
    // the next person who signs in, and push them under the new token.
    await captureSequence(USER, CHAIN);
    await captureSequence('someone-else', { ...CHAIN, name: 'Theirs' });

    const list = await listSequences(USER, getToken);
    expect(list).toHaveLength(1);
    expect(await pendingSequenceCount(USER)).toBe(1);
    expect(await pendingSequenceCount('someone-else')).toBe(1);
  });
});
