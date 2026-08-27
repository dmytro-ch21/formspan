/**
 * N84 — the technique funnel becomes a browsable phone screen, not just the
 * Today card's suggestion feed. Two things this pins:
 *
 * 1. `bucketOf` is a straight port of `apps/web`'s own bucketing, and it has
 *    to stay one — a technique landing in a different bucket on the phone
 *    than on the desk is the two screens disagreeing about the same funnel.
 * 2. `fetchProficiencyFull`/`fetchProficiency` go through ONE request, and
 *    `fetchProficiency`'s existing shape (an array, no summary) survives —
 *    the Today card and the reflection wizard both call it today and neither
 *    expects a `{ techniques, summary }` object.
 */

import { bucketOf, fetchProficiency, fetchProficiencyFull, type Proficiency } from '../proficiency';

const mockApi = jest.fn();
jest.mock('../apiRequest', () => ({ apiRequest: (...a: unknown[]) => mockApi(...a) }));

const getToken = async () => 'token';

function row(over: Partial<Proficiency> = {}): Proficiency {
  return {
    technique_id: 'armbar-closed-guard',
    name: 'Armbar from closed guard',
    position: 'Guard - Bottom',
    category: 'Submission',
    drilled: 0,
    attempted: 0,
    scored: 0,
    conceded: 0,
    defended: 0,
    sessions: 0,
    last_seen: '2026-08-01',
    ...over,
  };
}

beforeEach(() => mockApi.mockReset());

describe('bucketOf', () => {
  it('buckets a technique landed at least once as "working"', () => {
    expect(bucketOf(row({ scored: 1 }))).toBe('working');
  });

  it('buckets a technique tried live but never landed as "stalled"', () => {
    expect(bucketOf(row({ attempted: 3 }))).toBe('stalled');
  });

  it('buckets a drilled, never-tried technique as "untried"', () => {
    expect(bucketOf(row({ drilled: 4 }))).toBe('untried');
  });

  it('buckets pure defensive evidence as "working", not "against"', () => {
    // The exact inversion web's own comment records: before this rule, a
    // technique whose only record was "they went for it and I stopped them"
    // fell through to "used on you" — the precise opposite of what happened.
    expect(bucketOf(row({ defended: 3 }))).toBe('working');
  });

  it('buckets a row with no evidence of the athlete\'s own as "against"', () => {
    expect(bucketOf(row({ conceded: 2 }))).toBe('against');
  });

  it('treats attempted and scored as disjoint when both are present', () => {
    // attempted=2, scored=1 -> tried=3, scored>0 -> working. Reading
    // `attempted` as a total (rather than "tried and missed") would still
    // land here by coincidence; the sharper check is the stalled case above,
    // where scored is genuinely zero.
    expect(bucketOf(row({ attempted: 2, scored: 1 }))).toBe('working');
  });
});

describe('fetchProficiencyFull / fetchProficiency', () => {
  const SUMMARY = { techniques: 1, drilled: 1, tried_live: 0, landed: 0 };

  it('reads techniques and summary off one response', async () => {
    mockApi.mockResolvedValue({ techniques: [row()], summary: SUMMARY });
    const r = await fetchProficiencyFull(getToken);
    expect(r.techniques).toHaveLength(1);
    expect(r.summary).toEqual(SUMMARY);
    expect(mockApi).toHaveBeenCalledTimes(1);
    expect(mockApi).toHaveBeenCalledWith(getToken, '/bjj/proficiency', { signal: undefined });
  });

  it('normalises a missing techniques field to an empty array, not undefined', async () => {
    // An older or drifted server omitting the field must not hand `undefined`
    // to a consumer inside a `useMemo`, which takes the whole render down.
    mockApi.mockResolvedValue({});
    const r = await fetchProficiencyFull(getToken);
    expect(r.techniques).toEqual([]);
    expect(r.summary).toBeNull();
  });

  it('fetchProficiency stays a bare array — its existing callers never asked for a summary', async () => {
    mockApi.mockResolvedValue({ techniques: [row()], summary: SUMMARY });
    const rows = await fetchProficiency(getToken);
    expect(Array.isArray(rows)).toBe(true);
    expect(rows).toHaveLength(1);
  });

  it('fetchProficiency makes exactly one request, not two', async () => {
    // If this ever regresses to fetchProficiency calling the endpoint itself
    // AND fetchProficiencyFull calling it again, the Today card and this
    // screen would both pay for the read on one focus.
    mockApi.mockResolvedValue({ techniques: [], summary: SUMMARY });
    await fetchProficiency(getToken);
    expect(mockApi).toHaveBeenCalledTimes(1);
  });
});
