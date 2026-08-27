/**
 * The `GET /v1/sessions` query builder — N85.
 *
 * `listSessions` (used by the sync path) and `listSessionsPage` (used by the
 * new `/session/history` search screen) share one querystring builder
 * (`sessionQS`), mirroring `apps/web/src/lib/api.ts`'s `sessionQS` almost
 * verbatim so mobile's search hits the same filter the web page does. This
 * file pins the URL each option actually produces — the property a screen or
 * a sync loop can silently get wrong by passing the right value under the
 * wrong key.
 */

import { listSessions, listSessionsPage } from '../sessions';

const mockFetch = jest.fn();
// Spread, not replaced — `API_BASE` and the timeout constants live in this
// module too (see the same note in workoutsApi.test.ts / estimateApi.test.ts).
jest.mock('../authedFetch', () => ({
  ...jest.requireActual('../authedFetch'),
  netFetch: (...a: unknown[]) => mockFetch(...a),
}));
jest.mock('../trace', () => ({ newTraceId: () => 't', traceparent: () => 'tp' }));

const token = async () => 'tok';

function respond(body: unknown) {
  mockFetch.mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => body,
    headers: { get: () => null },
  });
}

beforeEach(() => mockFetch.mockReset());

describe('listSessions', () => {
  it('asks for nothing extra when called with no options', async () => {
    respond({ sessions: [] });
    await listSessions(token);
    const url = mockFetch.mock.calls[0][0] as string;
    expect(url.endsWith('/sessions')).toBe(true);
  });

  it('carries limit alone', async () => {
    respond({ sessions: [] });
    await listSessions(token, { limit: 5 });
    const url = mockFetch.mock.calls[0][0] as string;
    expect(url).toContain('/sessions?limit=5');
  });

  it('carries offset alongside limit — the fresh-install backfill in sessionStore.ts depends on this', async () => {
    respond({ sessions: [] });
    await listSessions(token, { limit: 200, offset: 400 });
    const url = mockFetch.mock.calls[0][0] as string;
    expect(url).toContain('limit=200');
    expect(url).toContain('offset=400');
  });

  it('omits offset when it is zero — a real page-zero call must not be misread as unfiltered', async () => {
    respond({ sessions: [] });
    await listSessions(token, { limit: 20, offset: 0 });
    const url = mockFetch.mock.calls[0][0] as string;
    // `offset=0` is the default the backend already assumes; the point of
    // this test is that a falsy 0 doesn't silently vanish differently from
    // any other falsy option below — it is dropped the same deliberate way.
    expect(url).not.toContain('offset');
  });

  it('returns whatever the response carries under `sessions`, defaulting to empty', async () => {
    respond({});
    const rows = await listSessions(token);
    expect(rows).toEqual([]);
  });
});

describe('listSessionsPage', () => {
  it('carries every filter under its own query key', async () => {
    respond({ sessions: [], total: 0, limit: 20, offset: 0 });
    await listSessionsPage(token, {
      limit: 20,
      offset: 40,
      sport: 'strength',
      q: 'leg day',
      from: '2026-06-01',
      to: '2026-08-01',
      tz: 'Europe/Berlin',
    });
    const url = mockFetch.mock.calls[0][0] as string;
    expect(url).toContain('limit=20');
    expect(url).toContain('offset=40');
    expect(url).toContain('sport=strength');
    // URLSearchParams encodes the space as `+`.
    expect(url).toContain('q=leg+day');
    expect(url).toContain('from=2026-06-01');
    expect(url).toContain('to=2026-08-01');
    expect(url).toContain('tz=Europe%2FBerlin');
  });

  it('omits tz when a caller sends no period — an unbounded query has no zone to resolve a boundary in', async () => {
    respond({ sessions: [], total: 0, limit: 20, offset: 0 });
    await listSessionsPage(token, { limit: 20 });
    const url = mockFetch.mock.calls[0][0] as string;
    expect(url).not.toContain('tz');
  });

  it('returns the page shape the search screen paginates on', async () => {
    const s1 = { id: 's1' };
    respond({ sessions: [s1], total: 37, limit: 20, offset: 0 });
    const page = await listSessionsPage(token, { limit: 20 });
    expect(page).toEqual({ sessions: [s1], total: 37, limit: 20, offset: 0 });
  });

  it('defaults total/limit/offset to 0 rather than undefined on a bare response', async () => {
    // The "Show older" button on `/session/history` compares `items.length`
    // against `total` — an `undefined` there is `NaN`-shaped math waiting to
    // happen, not a crash, which is worse: the button would just never say
    // the right thing.
    respond({ sessions: [] });
    const page = await listSessionsPage(token, {});
    expect(page).toEqual({ sessions: [], total: 0, limit: 0, offset: 0 });
  });
});
