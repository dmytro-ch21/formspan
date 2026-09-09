/**
 * W19/#985 — which window a session's heart rate is read from, decided from
 * times alone. Pure, so every case below is the real shipped decision with
 * no device, no health store and no network anywhere near it.
 *
 * The fixtures are the real incident's own shape wherever one exists: a
 * 90-minute BJJ class logged 18:41:48 → 20:11:48, which the strap itself
 * recorded as 19:19 → 20:47. See `lib/hrWorkoutWindow.ts`'s doc comment.
 */

import {
  WORKOUT_AMBIGUITY_MARGIN,
  paddedHRSearchWindow,
  selectWorkoutWindow,
  workoutSearchWindow,
  type WorkoutWindow,
} from '../hrWorkoutWindow';

const MINUTE = 60_000;

/** The incident's own logged window. */
const SESSION_START = '2026-09-08T22:41:48.000Z';
const SESSION_END = '2026-09-09T00:11:48.000Z';

function at(offsetMinutesFromStart: number): string {
  return new Date(new Date(SESSION_START).getTime() + offsetMinutesFromStart * MINUTE).toISOString();
}

function w(startMin: number, endMin: number): WorkoutWindow {
  return { start: at(startMin), end: at(endMin) };
}

/** The strap's own record of the class: 19:19 → 20:47, i.e. 37 minutes after
 *  the logged start and running 36 minutes past the logged end. */
const THE_CLASS = w(37, 125);

/**
 * **The two window builders are pinned to LITERAL minutes, deliberately.**
 * Deriving a fixture from the constant under test produces an assertion that
 * cannot fail — mutate the constant and the fixture follows it. That version
 * of these tests was written first and six mutations survived it; see
 * `lib/__tests__/biometric.test.ts`'s note on the same mistake, and CLAUDE.md's
 * "Verify that a check can fail".
 */
describe('paddedHRSearchWindow', () => {
  it("pads both ends by the athlete's own suggested 20 minutes", () => {
    const padded = paddedHRSearchWindow(SESSION_START, SESSION_END);
    expect(padded.start.getTime()).toBe(new Date(SESSION_START).getTime() - 20 * MINUTE);
    expect(padded.end.getTime()).toBe(new Date(SESSION_END).getTime() + 20 * MINUTE);
  });
});

describe('workoutSearchWindow', () => {
  it('looks back far enough that no admissible workout can start before the query does', () => {
    // For this 90-minute session: 20 minutes of padding, then a further 180 —
    // the longest workout `selectWorkoutWindow` could ever admit, since a
    // candidate must be at least half the session's length and so can be at
    // most twice it. Looking back by that much cannot miss a candidate.
    const search = workoutSearchWindow(SESSION_START, SESSION_END);
    expect(search.start.getTime()).toBe(new Date(SESSION_START).getTime() - (20 + 180) * MINUTE);
    // Not widened at the END: a workout starting after the padded window has
    // already failed the overlap rule before it began.
    expect(search.end.getTime()).toBe(new Date(SESSION_END).getTime() + 20 * MINUTE);
  });

  it('scales the lookback with the session, rather than adding a fourth constant that could drift', () => {
    const short = workoutSearchWindow('2026-09-08T10:00:00.000Z', '2026-09-08T10:10:00.000Z');
    const long = workoutSearchWindow('2026-09-08T10:00:00.000Z', '2026-09-08T20:00:00.000Z');
    const lookback = (s: { start: Date }) =>
      new Date('2026-09-08T10:00:00.000Z').getTime() - 20 * MINUTE - s.start.getTime();
    expect(lookback(short)).toBe(20 * MINUTE); // a 10-minute session: twice its length
    expect(lookback(long)).toBe(1200 * MINUTE); // a 10-hour one: twice its length
  });
});

describe('selectWorkoutWindow — the incident', () => {
  it("picks the strap's own class window over the athlete's typed one", () => {
    expect(selectWorkoutWindow(SESSION_START, SESSION_END, [THE_CLASS])).toEqual(THE_CLASS);
  });

  it('returns null when the store knows no workout at all — the fallback path stays reachable', () => {
    expect(selectWorkoutWindow(SESSION_START, SESSION_END, [])).toBeNull();
  });
});

describe('selectWorkoutWindow — what is admitted', () => {
  it('rejects a workout that merely grazes the session (the walk to the gym)', () => {
    // 80 minutes long, only its last 10 inside the logged window: 0.125 of
    // its own length, far under WORKOUT_MIN_OVERLAP_FRACTION.
    expect(selectWorkoutWindow(SESSION_START, SESSION_END, [w(-70, 10)])).toBeNull();
  });

  it('admits exactly at the overlap bar and rejects just under it', () => {
    // A 60-minute workout starting 30 minutes before the logged start: 30 of
    // its 60 minutes fall inside, i.e. exactly WORKOUT_MIN_OVERLAP_FRACTION.
    const atBar = w(-30, 30);
    expect(selectWorkoutWindow(SESSION_START, SESSION_END, [atBar])).toEqual(atBar);
    // One minute earlier and only 29 of 60 are inside.
    expect(selectWorkoutWindow(SESSION_START, SESSION_END, [w(-31, 29)])).toBeNull();
  });

  it('rejects a five-minute walk sitting entirely inside the class', () => {
    // Perfect 1.0 on the overlap bar; 0.055 on duration similarity. This is
    // the case the overlap rule alone cannot see.
    expect(selectWorkoutWindow(SESSION_START, SESSION_END, [w(20, 25)])).toBeNull();
  });

  it('rejects an all-day workout that engulfs the session', () => {
    // Also a perfect 1.0 on overlap — the opposite failure, same blind spot.
    expect(selectWorkoutWindow(SESSION_START, SESSION_END, [w(-180, 300)])).toBeNull();
  });

  it('admits exactly at the duration-similarity bar and rejects just under it', () => {
    // 45 minutes against the session's 90: exactly WORKOUT_MIN_DURATION_SIMILARITY,
    // and fully inside so the overlap rule is not what decides.
    const atBar = w(20, 65);
    expect(selectWorkoutWindow(SESSION_START, SESSION_END, [atBar])).toEqual(atBar);
    expect(selectWorkoutWindow(SESSION_START, SESSION_END, [w(20, 64)])).toBeNull();
  });

  it('ignores a workout with unparseable or inverted times rather than trusting it', () => {
    expect(
      selectWorkoutWindow(SESSION_START, SESSION_END, [
        { start: 'not a date', end: at(60) },
        { start: at(60), end: at(20) },
        { start: at(30), end: at(30) },
      ]),
    ).toBeNull();
  });

  it('returns null for a session with no duration of its own', () => {
    expect(selectWorkoutWindow(SESSION_START, SESSION_START, [THE_CLASS])).toBeNull();
    expect(selectWorkoutWindow('not a date', SESSION_END, [THE_CLASS])).toBeNull();
  });
});

describe('selectWorkoutWindow — several candidates', () => {
  it('prefers the one that matches the session most closely, not merely the one that contains it', () => {
    // Both pass every admission bar. The engulfing one overlaps the session
    // completely; the matching one IS the session. Overlap alone cannot tell
    // them apart — the union-based score is what does.
    const engulfing = w(-40, 130);
    const matching = w(-2, 88);
    expect(selectWorkoutWindow(SESSION_START, SESSION_END, [engulfing, matching])).toEqual(matching);
    // ...and order in the array must not decide it.
    expect(selectWorkoutWindow(SESSION_START, SESSION_END, [matching, engulfing])).toEqual(matching);
  });

  it('is not confused by an overlapping second record of the same class', () => {
    // A phone and a strap both logging the class a couple of minutes apart
    // is one event described twice — these overlap, so the ambiguity check
    // must not fire and the closer match must win.
    const strap = w(0, 90);
    const phone = w(3, 92);
    expect(selectWorkoutWindow(SESSION_START, SESSION_END, [phone, strap])).toEqual(strap);
  });

  it('declines when two comparably-good candidates do not overlap — a coin flip is not a measurement', () => {
    // Symmetric about the logged window: same length, same overlap, same
    // score, and genuinely separate. Nothing here says which one the athlete
    // was in, so picking either would be a guess wearing a measurement's
    // clothes — the same posture `fitHRWindow` takes.
    const before = w(-45, 45);
    const after = w(45, 135);
    expect(selectWorkoutWindow(SESSION_START, SESSION_END, [before, after])).toBeNull();
  });

  it('still chooses when a well-separated rival is clearly worse than the best', () => {
    // The class itself, plus a separate qualifying workout whose score is
    // more than WORKOUT_AMBIGUITY_MARGIN behind it. A margin that decided
    // everything would make the previous test's behaviour swallow this one.
    const best = w(0, 90);
    const worse = w(60, 150);
    const scoreOf = (c: WorkoutWindow) => {
      const s = new Date(SESSION_START).getTime();
      const e = new Date(SESSION_END).getTime();
      const cs = new Date(c.start).getTime();
      const ce = new Date(c.end).getTime();
      return (Math.min(e, ce) - Math.max(s, cs)) / (Math.max(e, ce) - Math.min(s, cs));
    };
    expect(scoreOf(best) - scoreOf(worse)).toBeGreaterThan(WORKOUT_AMBIGUITY_MARGIN);
    expect(selectWorkoutWindow(SESSION_START, SESSION_END, [worse, best])).toEqual(best);
  });

  it('resolves two identically-scored, identically-placed records the same way every time', () => {
    // Same times from two writers: they overlap, so this is not ambiguity —
    // but the answer still has to be stable across passes, or a session
    // flip-flops between two equally-correct windows on every retry.
    const a = { start: at(0), end: at(90) };
    const b = { start: at(0), end: at(90) };
    expect(selectWorkoutWindow(SESSION_START, SESSION_END, [a, b])).toEqual(a);
    expect(selectWorkoutWindow(SESSION_START, SESSION_END, [b, a])).toEqual(b);
  });
});
