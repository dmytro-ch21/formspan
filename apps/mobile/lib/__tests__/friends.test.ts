/**
 * The rule that decides whether a pending count chimes.
 *
 * Worth a test rather than being obvious, because the interesting cases are
 * the two that look like each other: `null` (nothing counted yet) and `0`
 * (counted, and there was nothing). Collapse those into a falsy check — which
 * is exactly what `if (!prev)` would do — and opening the app to a waiting
 * request announces it as if it just arrived, on every single launch.
 *
 * The tests below are written so that each fails against a specific plausible
 * wrong implementation, not just against a deleted function:
 *   - `next > prev` alone (no null guard)  -> the first-look tests go red
 *   - `!prev` instead of `prev === null`   -> the 0 -> 1 test goes red
 *   - `next !== prev`                      -> the answered/fell test goes red
 *   - `next >= prev`                       -> the unchanged test goes red
 */
import { announcesArrival, anyArrived } from '../friends';

describe('whether a pending count announces itself', () => {
  it('says nothing the first time it counts, however many are waiting', () => {
    // Opening the app to three requests is not three arrivals. They were
    // already there, and the app has no basis for claiming otherwise.
    expect(announcesArrival(null, 3)).toBe(false);
  });

  it('says nothing on a first count of zero either', () => {
    expect(announcesArrival(null, 0)).toBe(false);
  });

  it('announces a rise from a count it has already seen', () => {
    expect(announcesArrival(1, 2)).toBe(true);
  });

  it('announces the FIRST request against a seen zero', () => {
    // The case that separates "counted, nothing waiting" from "not counted
    // yet". Both are falsy; only one of them means the next request is news.
    expect(announcesArrival(0, 1)).toBe(true);
  });

  it('stays quiet when a request is answered and the count falls', () => {
    expect(announcesArrival(2, 1)).toBe(false);
  });

  it('stays quiet when nothing changed', () => {
    // Every focus refetches, so this is the overwhelmingly common path — the
    // one that decides whether the feature is a cue or a nuisance.
    expect(announcesArrival(2, 2)).toBe(false);
  });

  it('stays quiet when the count falls to zero', () => {
    expect(announcesArrival(1, 0)).toBe(false);
  });
});

describe('across every badged source', () => {
  const at = (friend_requests: number, shares: number) => ({ friend_requests, shares });

  it('says nothing on the first look, whatever is waiting', () => {
    expect(anyArrived(null, at(2, 3))).toBe(false);
  });

  it('announces a friend request arriving', () => {
    expect(anyArrived(at(0, 0), at(1, 0))).toBe(true);
  });

  it('announces a share arriving', () => {
    // The source the badge did not cover until it was widened. If this goes
    // red, the chime has silently narrowed back to friend requests.
    expect(anyArrived(at(0, 0), at(0, 1))).toBe(true);
  });

  it('announces a share arriving in the same window a request is answered', () => {
    // THE case that rules out comparing totals: 1 + 0 and 0 + 1 both sum to 1,
    // so a total-based rule calls this "no change" while something new is
    // genuinely sitting there waiting to be opened.
    expect(anyArrived(at(1, 0), at(0, 1))).toBe(true);
  });

  it('stays quiet when nothing moved', () => {
    expect(anyArrived(at(2, 1), at(2, 1))).toBe(false);
  });

  it('stays quiet when both fall', () => {
    expect(anyArrived(at(2, 2), at(0, 0))).toBe(false);
  });

  it('stays quiet when one falls and the other holds', () => {
    expect(anyArrived(at(2, 1), at(1, 1))).toBe(false);
  });
});
