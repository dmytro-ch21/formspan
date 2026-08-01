import { ApiError } from '../apiError';
import { pushSession, syncSessions } from '../sessionStore';

/**
 * What the push does with a tombstone.
 *
 * Two behaviours moved here from `deleteLocalSession`, and one added:
 *
 * - a never-pushed session is dropped locally with **no server call**. That
 *   decision used to live at delete time, reading `remote` — which is racy,
 *   because a first push flips it partway through, so a delete in that window
 *   hard-deleted locally while the push it raced created the session on the
 *   server. Deciding inside the serialised sync sees what is true then.
 * - a 404 counts as success.
 * - a **permanent** refusal restores the mockRow, because the session was not
 *   deleted and hiding it forever would be a lie — and would pin `pending`
 *   above zero for the life of the install.
 */

const mockDel = jest.fn();
const mockPull = jest.fn();
jest.mock('../sessions', () => ({
  deleteSession: (...a: unknown[]) => mockDel(...a),
  listSessions: (...a: unknown[]) => mockPull(...a),
  startSession: jest.fn(),
  replaceSets: jest.fn(),
  finishSession: jest.fn(),
  getSession: jest.fn(),
}));

type Row = {
  id: string; user_id: string; remote: number; dirty: number;
  deleted_at: string | null; updated_at: string; sets_json: string;
};
let mockRow: Row | null = null;
let mockTombstoned: string[] = [];
const mockRan: string[] = [];

jest.mock('../db', () => ({
  getDb: async () => ({
    getFirstAsync: async () => mockRow,
    getAllAsync: async (sql: string) => {
      if (/deleted_at IS NOT NULL/.test(sql)) return mockTombstoned.map((id) => ({ id }));
      if (/dirty = 1/.test(sql)) return [];
      return [];
    },
    runAsync: async (sql: string) => {
      mockRan.push(sql.trim().split('\n')[0]);
      if (/^DELETE FROM local_sessions/.test(sql.trim())) mockRow = null;
      if (/SET deleted_at = NULL/.test(sql) && mockRow) {
        mockRow.deleted_at = null;
        mockRow.dirty = 0;
      }
    },
  }),
}));

const seed = (over: Partial<Row> = {}) => {
  mockRan.length = 0;
  mockRow = {
    id: 's1', user_id: 'u1', remote: 1, dirty: 1,
    deleted_at: '2026-08-01T00:00:00Z', updated_at: '2026-08-01T00:00:00Z',
    sets_json: '[]', ...over,
  };
};

beforeEach(() => {
  mockDel.mockReset();
  mockPull.mockReset();
  mockTombstoned = [];
});

it('drops a never-pushed session without calling the server', async () => {
  seed({ remote: 0 });
  await pushSession('u1', 's1', async () => 'tok');
  expect(mockDel).not.toHaveBeenCalled();
  expect(mockRow).toBeNull();
});

it('deletes on the server, then locally, for a synced session', async () => {
  seed({ remote: 1 });
  mockDel.mockResolvedValue(undefined);
  await pushSession('u1', 's1', async () => 'tok');
  expect(mockDel).toHaveBeenCalledTimes(1);
  expect(mockRow).toBeNull();
});

it('treats a 404 as success', async () => {
  seed({ remote: 1 });
  mockDel.mockRejectedValue(new ApiError('gone', 'not_found', 404));
  await pushSession('u1', 's1', async () => 'tok');
  expect(mockRow).toBeNull();
});

it('keeps the tombstone when the delete fails transiently', async () => {
  seed({ remote: 1 });
  mockDel.mockRejectedValue(new Error('Network request failed'));
  await expect(pushSession('u1', 's1', async () => 'tok')).rejects.toThrow();
  expect(mockRow?.deleted_at).toEqual(expect.any(String));
  expect(mockRow?.dirty).toBe(1);
});

it('RESTORES the session when the server refuses permanently', async () => {
  // Otherwise the mockRow stays hidden for the life of the install while
  // `pending` never reaches zero and every foreground retries a doomed
  // request — the failure PR2 fixed for updates and had not applied here.
  seed({ remote: 1 });
  mockDel.mockRejectedValue(new ApiError('nope', 'invalid_input', 400));

  await expect(pushSession('u1', 's1', async () => 'tok')).rejects.toThrow();

  expect(mockRow).not.toBeNull();
  expect(mockRow?.deleted_at).toBeNull();
  expect(mockRow?.dirty).toBe(0);
});

describe('the pull', () => {
  // THE headline guard of this feature — without it the pull writes the
  // server's copy straight back over a delete — and it had no coverage at
  // all: sync.test.ts mocks syncSessions wholesale, so nothing exercised the
  // real pull loop.
  it('skips a session this device has tombstoned', async () => {
    mockRow = {
      id: 's1', user_id: 'u1', remote: 1, dirty: 0,
      deleted_at: '2026-08-01T00:00:00Z', updated_at: '2026-08-01T00:00:00Z',
      sets_json: '[]',
    };
    mockTombstoned = ['s1'];
    mockPull.mockResolvedValue([
      { id: 's1', user_id: 'u1', sport: 'strength', name: 'back', started_at: 'x',
        ended_at: null, notes: '', sets: [], updated_at: '2026-08-02T00:00:00Z' },
    ]);
    mockRan.length = 0;

    await syncSessions('u1', async () => 'tok');

    // No INSERT/upsert for the tombstoned id — the server's copy is refused.
    expect(mockRan.some((q) => /INSERT INTO local_sessions/.test(q))).toBe(false);
  });
});

// The read filters and the pending count were pinned here by asserting on
// query TEXT. They are now executed against a real database in
// tombstoneSql.test.ts, which is strictly stronger — a text assertion proves
// a clause is present, not that SQLite honours it. Removed rather than kept
// alongside, so nobody reads text-matching as an accepted way to test SQL.
