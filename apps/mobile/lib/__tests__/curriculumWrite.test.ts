/**
 * N83 — the write half of `lib/curriculum.ts`: `createCurriculum`,
 * `updateCurriculum`, `deleteCurriculum`. Mirrors `exercisesApi.test.ts`'s
 * shape (mock `apiRequest`, assert the exact call) because that is what a
 * thin wire wrapper needs pinned — the METHOD, the PATH (including `tz`,
 * which the server's `zoneOf` rejects the request without), and that the
 * body is exactly the input, JSON-encoded and nothing else.
 *
 * Getting any of these wrong is invisible in the UI until the request is
 * actually made — a `PUT` where the server wants `POST`, or a missing `tz`,
 * both come back as a 400/404 from a real server, which every one of these
 * screens' error banners would show as "something went wrong" with no hint
 * that the client built the wrong request.
 */

import {
  createCurriculum,
  deleteCurriculum,
  updateCurriculum,
  type CurriculumWrite,
} from '../curriculum';

const mockApi = jest.fn();
jest.mock('../apiRequest', () => ({ apiRequest: (...a: unknown[]) => mockApi(...a) }));
jest.mock('../history', () => ({
  ...jest.requireActual('../history'),
  localZone: () => 'Europe/Kyiv',
}));

const getToken = async () => 'token';

const WRITE: CurriculumWrite = {
  name: 'Guard passing',
  description: 'for winter',
  belt: null,
  visibility: 'private',
  items: [{ technique_id: 't1', notes: '' }],
};

beforeEach(() => mockApi.mockReset());

describe('createCurriculum', () => {
  it('POSTs to /curricula with the tz query param and the input as the body', async () => {
    mockApi.mockResolvedValue({ id: 'c1' });
    await createCurriculum(getToken, WRITE);
    expect(mockApi).toHaveBeenCalledWith(getToken, '/curricula?tz=Europe%2FKyiv', {
      method: 'POST',
      body: JSON.stringify(WRITE),
    });
  });

  it('returns the created curriculum', async () => {
    mockApi.mockResolvedValue({ id: 'c1', name: 'Guard passing' });
    expect(await createCurriculum(getToken, WRITE)).toEqual({ id: 'c1', name: 'Guard passing' });
  });
});

describe('updateCurriculum', () => {
  it('PATCHes the specific curriculum, tz included, URL-encoding the id', async () => {
    mockApi.mockResolvedValue({ id: 'c 1' });
    await updateCurriculum(getToken, 'c 1', WRITE);
    expect(mockApi).toHaveBeenCalledWith(getToken, '/curricula/c%201?tz=Europe%2FKyiv', {
      method: 'PATCH',
      body: JSON.stringify(WRITE),
    });
  });

  it('sends a metadata-only patch without an items key at all — never []', async () => {
    mockApi.mockResolvedValue({ id: 'c1' });
    await updateCurriculum(getToken, 'c1', { name: 'Renamed' });
    const [, , init] = mockApi.mock.calls[0];
    const body = JSON.parse((init as RequestInit).body as string);
    expect('items' in body).toBe(false);
    expect(body).toEqual({ name: 'Renamed' });
  });
});

describe('deleteCurriculum', () => {
  it('DELETEs the specific curriculum, with no tz and no body', async () => {
    mockApi.mockResolvedValue(undefined);
    await deleteCurriculum(getToken, 'c1');
    expect(mockApi).toHaveBeenCalledWith(getToken, '/curricula/c1', { method: 'DELETE' });
  });
});
