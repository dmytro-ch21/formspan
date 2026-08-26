import {
  BODY_NOISE_KG,
  MAX_INSIGHTS,
  freshRecords,
  isChecking,
  isUnavailable,
  nutritionWeek,
  reading,
  readingValue,
  whatChanged,
  type BodyChange,
  type ChangeFacts,
  type ChangeView,
  type FreshRecords,
  type Insight,
  type Reading,
} from '../progress';
import type { ExerciseRecords, PersonalRecord } from '../records';
import type { WeekReview, WeekTotals } from '../weekReview';

/**
 * The Progress tab's reading vocabulary, and the guard it exists for.
 *
 * ## What is actually being tested here
 *
 * Not "does the union have five members" — that is true by construction and a
 * test of it would pass forever. What matters is the ORDER the branches are
 * tried in, because every one of the three bugs this file exists to prevent was
 * a correctly-typed union whose classifier reached the wrong arm:
 *
 *  - an absent value with no failure must be `checking`, never `empty`;
 *  - an absent value with a failure must be `unavailable`, never `empty`;
 *  - "nothing changed" must be unreachable while any source is still loading.
 *
 * Each of those is asserted with a vector that a broken implementation would
 * classify differently — an input `{ value: null, failed: false }` separates a
 * correct classifier from one that treats absence as emptiness, and nothing
 * else does.
 *
 * ## Copy is pinned to literals
 *
 * The sentences below are written out rather than rebuilt from the same
 * template the implementation uses. A test that composes its expectation the
 * way the code composes its output agrees with any implementation, including a
 * wrong one — this repo has shipped two assertions that compared a constant
 * against itself and stayed green when the constant moved.
 */

const KG = (kg: number) => `${kg.toFixed(1)} kg`;

function totals(sessions: number): WeekTotals {
  return { sessions, days: sessions, seconds: 3600 * sessions, volumeKg: 0 };
}

function week(now: number, previous: number | null): WeekReview {
  return {
    from: '2026-08-24',
    to: '2026-08-30',
    totals: totals(now),
    bySport: [],
    planned: 0,
    met: 0,
    previous: previous === null ? null : totals(previous),
  };
}

function record(kind: PersonalRecord['kind'], isRecent: boolean): PersonalRecord {
  return {
    kind,
    value: 100,
    reps: 5,
    weight_kg: 100,
    seconds: null,
    distance_m: null,
    rir: null,
    rpe: null,
    achieved_at: '2026-08-20T10:00:00Z',
    session_id: 's1',
    is_recent: isRecent,
  };
}

describe('reading — the five kinds, and the order they are decided in', () => {
  it('classifies an absent value with no failure as checking, NOT empty', () => {
    // The whole file in one assertion. An implementation that asks "is the
    // value empty?" before "has anything answered?" returns `empty` here, and
    // that is the sentence that told an athlete with two years of weigh-ins to
    // start logging.
    expect(reading({ value: null, isEmpty: () => true })).toEqual({ state: 'checking' });
  });

  it('classifies an absent value after a failure as unavailable, NOT empty', () => {
    expect(reading({ value: null, failed: true, isEmpty: () => true })).toEqual({
      state: 'unavailable',
    });
  });

  it('classifies an answer that says nothing is there as empty', () => {
    expect(reading({ value: [] as number[], isEmpty: (v) => v.length === 0 })).toEqual({
      state: 'empty',
      stale: false,
    });
  });

  it('classifies an answer with something in it as ready', () => {
    expect(reading({ value: [1], isEmpty: (v) => v.length === 0 })).toEqual({
      state: 'ready',
      value: [1],
      stale: false,
    });
  });

  it('keeps an answer and marks it stale when a later refresh failed', () => {
    // Not `unavailable`: there IS an answer on screen. Collapsing these two
    // either hides real figures behind an error or presents stale ones as
    // current, and this app has done the second.
    expect(reading({ value: [1], failed: true })).toEqual({
      state: 'ready',
      value: [1],
      stale: true,
    });
    expect(reading({ value: [] as number[], failed: true, isEmpty: (v) => v.length === 0 })).toEqual(
      { state: 'empty', stale: true },
    );
  });

  it('reports off ahead of everything else, even with a value in hand', () => {
    // The vector that separates "off is checked first" from "off is checked
    // last": a module turned off while its data is still cached. Rendering the
    // figures is a claim about a discipline the athlete has said they do not
    // do.
    expect(reading({ enabled: false, value: [1, 2, 3] })).toEqual({ state: 'off' });
    expect(reading({ enabled: false, value: null, failed: true })).toEqual({ state: 'off' });
  });

  it('treats a falsy-but-real answer as an answer', () => {
    // `0`, `''` and `[]` are answers. A truthiness check here reports each of
    // them as "still loading", forever.
    expect(reading({ value: 0 })).toEqual({ state: 'ready', value: 0, stale: false });
    expect(reading({ value: '' })).toEqual({ state: 'ready', value: '', stale: false });
  });

  it('defaults to enabled, so an ungated read never reports off', () => {
    expect(reading({ value: 1 }).state).toBe('ready');
  });

  it('readingValue yields the value only in the ready state', () => {
    expect(readingValue({ state: 'ready', value: 7, stale: false })).toBe(7);
    for (const r of [
      { state: 'checking' },
      { state: 'unavailable' },
      { state: 'off' },
      { state: 'empty', stale: false },
    ] as Reading<number>[]) {
      expect(readingValue(r)).toBeNull();
    }
  });

  it('isChecking and isUnavailable are true for exactly one state each', () => {
    const all: Reading<number>[] = [
      { state: 'checking' },
      { state: 'unavailable' },
      { state: 'off' },
      { state: 'empty', stale: false },
      { state: 'ready', value: 1, stale: false },
    ];
    expect(all.filter(isChecking)).toEqual([{ state: 'checking' }]);
    expect(all.filter(isUnavailable)).toEqual([{ state: 'unavailable' }]);
  });
});

describe('whatChanged — "nothing changed" is a claim, and it needs every answer', () => {
  const nothingYet: ChangeFacts = {
    week: { state: 'checking' },
    records: { state: 'checking' },
    body: { state: 'checking' },
  };

  const allAnswered: ChangeFacts = {
    week: { state: 'ready', value: week(3, 3), stale: false },
    records: { state: 'ready', value: { count: 0, firstName: '' }, stale: false },
    body: { state: 'empty', stale: false },
  };

  it('is checking while ANY source is outstanding', () => {
    expect(whatChanged(nothingYet, KG)).toEqual({ state: 'checking' });
    // One source answered, two outstanding — still checking. This is the
    // vector that fails against an implementation checking only the first
    // source, which is the natural way to write it.
    expect(whatChanged({ ...nothingYet, week: allAnswered.week }, KG)).toEqual({
      state: 'checking',
    });
    expect(whatChanged({ ...nothingYet, records: allAnswered.records }, KG)).toEqual({
      state: 'checking',
    });
    expect(whatChanged({ ...nothingYet, body: allAnswered.body }, KG)).toEqual({
      state: 'checking',
    });
  });

  it('is quiet only once every source has answered', () => {
    expect(whatChanged(allAnswered, KG)).toEqual({ state: 'quiet' });
  });

  it('says it could not look, rather than that nothing happened, when a read failed', () => {
    expect(whatChanged({ ...allAnswered, records: { state: 'unavailable' } }, KG)).toEqual({
      state: 'unavailable',
    });
  });

  it('prefers checking over unavailable when both are outstanding', () => {
    // A spinner is the honest thing while something is still in flight; an
    // error over a request that has not finished is a verdict on a question
    // nobody has finished asking.
    expect(
      whatChanged({ ...nothingYet, records: { state: 'unavailable' } }, KG),
    ).toEqual({ state: 'checking' });
  });

  it('names a single new personal best', () => {
    const view = whatChanged(
      {
        ...allAnswered,
        records: { state: 'ready', value: { count: 1, firstName: 'Back squat' }, stale: false },
      },
      KG,
    );
    expect(view).toEqual({
      state: 'ready',
      insights: [
        {
          id: 'records',
          headline: 'New personal best: Back squat',
          detail: 'Set in the last 30 days.',
        },
      ],
    });
  });

  it('counts several new bests without naming them all', () => {
    const view = whatChanged(
      {
        ...allAnswered,
        records: { state: 'ready', value: { count: 3, firstName: 'Bench press' }, stale: false },
      },
      KG,
    );
    expect(view).toEqual({
      state: 'ready',
      insights: [
        {
          id: 'records',
          headline: '3 new personal bests',
          detail: 'Including Bench press, in the last 30 days.',
        },
      ],
    });
  });

  it('compares this week with last, in sessions rather than percentages', () => {
    const up = whatChanged({ ...allAnswered, week: ready(week(4, 2)) }, KG);
    expect(up).toEqual({
      state: 'ready',
      insights: [
        {
          id: 'consistency',
          headline: 'You are training more than last week',
          detail: "4 sessions so far, 2 more than last week's 2.",
        },
      ],
    });

    const down = whatChanged({ ...allAnswered, week: ready(week(1, 4)) }, KG);
    expect(down).toEqual({
      state: 'ready',
      insights: [
        {
          id: 'consistency',
          headline: 'You are training less than last week',
          detail: "1 session so far, 3 fewer than last week's 4.",
        },
      ],
    });
  });

  it('draws no comparison at all when the device cannot see last week', () => {
    // `previous: null` is `reviewWeek` refusing to sum a week the local list
    // only partly covers. Reading it as zero would report every athlete's
    // first look as an infinite improvement.
    expect(whatChanged({ ...allAnswered, week: ready(week(3, null)) }, KG)).toEqual({
      state: 'quiet',
    });
  });

  it('draws no comparison when the two weeks are equal', () => {
    expect(whatChanged({ ...allAnswered, week: ready(week(3, 3)) }, KG)).toEqual({
      state: 'quiet',
    });
  });

  it('reports a weight trend without judging its direction', () => {
    const falling = whatChanged({ ...allAnswered, body: ready(body(-0.6)) }, KG);
    expect(falling).toEqual({
      state: 'ready',
      insights: [
        {
          id: 'body',
          headline: 'Your weight trend is falling',
          detail: '0.6 kg over 7 days, smoothed.',
        },
      ],
    });
    // Rising is stated in the same neutral register — which way an athlete
    // wants it depends on the phase, which this block does not read.
    expect(insightsOf(whatChanged({ ...allAnswered, body: ready(body(0.6)) }, KG))[0].headline).toBe(
      'Your weight trend is rising',
    );
  });

  it('ignores a movement below the noise floor, and reports one at it', () => {
    // Pinned to a literal 0.09/0.1 rather than to `BODY_NOISE_KG ± ε`: an
    // assertion written against the constant moves with the constant and can
    // never catch it being changed.
    expect(BODY_NOISE_KG).toBe(0.1);
    expect(whatChanged({ ...allAnswered, body: ready(body(-0.09)) }, KG)).toEqual({
      state: 'quiet',
    });
    expect(whatChanged({ ...allAnswered, body: ready(body(-0.1)) }, KG).state).toBe('ready');
  });

  it('shows at most two insights, records first', () => {
    expect(MAX_INSIGHTS).toBe(2);
    const view = whatChanged(
      {
        week: ready(week(4, 2)),
        records: ready<FreshRecords>({ count: 1, firstName: 'Deadlift' }),
        body: ready(body(-0.8)),
      },
      KG,
    );
    expect(view.state).toBe('ready');
    const ids = insightsOf(view).map((i) => i.id);
    // Three qualify; two are shown, and the body one is what drops. Asserting
    // the ids as a literal list is what pins the ORDER as well as the cap — a
    // `.slice` with no ordering behind it would pass a length check.
    expect(ids).toEqual(['records', 'consistency']);
  });

  it('says what it can even while another source is still loading', () => {
    // A PR is worth telling somebody about before the body check-ins land.
    const view = whatChanged(
      {
        week: { state: 'checking' },
        records: ready<FreshRecords>({ count: 1, firstName: 'Overhead press' }),
        body: { state: 'checking' },
      },
      KG,
    );
    expect(view.state).toBe('ready');
  });

  it('formats the weight through the caller, so pounds are never printed as kilos', () => {
    const view = whatChanged(
      { ...allAnswered, body: ready(body(-1)) },
      (kg) => `${Math.round(kg * 2.20462 * 10) / 10} lb`,
    );
    expect(insightsOf(view)[0].detail).toBe('2.2 lb over 7 days, smoothed.');
  });
});

/** The insights of a ready view, or a failure that names what it got instead. */
function insightsOf(view: ChangeView): Insight[] {
  if (view.state !== 'ready') throw new Error(`expected a ready view, got ${view.state}`);
  return view.insights;
}

function ready<T>(value: T): Reading<T> {
  return { state: 'ready', value, stale: false };
}

function body(deltaKg: number): BodyChange {
  return { deltaKg, days: 7 };
}

describe('nutritionWeek — days elapsed, never days in a week', () => {
  const MON_TO_SUN = [
    '2026-08-24',
    '2026-08-25',
    '2026-08-26',
    '2026-08-27',
    '2026-08-28',
    '2026-08-29',
    '2026-08-30',
  ];

  it('carries the four states of a LoggedDaysView through unchanged', () => {
    expect(nutritionWeek({ state: 'off' }, MON_TO_SUN, '2026-08-26')).toEqual({ state: 'off' });
    expect(nutritionWeek({ state: 'checking' }, MON_TO_SUN, '2026-08-26')).toEqual({
      state: 'checking',
    });
    expect(nutritionWeek({ state: 'unavailable' }, MON_TO_SUN, '2026-08-26')).toEqual({
      state: 'unavailable',
    });
  });

  it('denominates against days that have happened', () => {
    // Wednesday. Three days have happened, not seven — "2 of 7" on a Wednesday
    // counts Thursday onwards as days the athlete failed to log.
    expect(
      nutritionWeek(
        { state: 'ready', days: new Set(['2026-08-24', '2026-08-26']) },
        MON_TO_SUN,
        '2026-08-26',
      ),
    ).toEqual({ state: 'ready', value: { logged: 2, elapsed: 3 }, stale: false });
  });

  it('cannot count a day outside the week, or one still to come', () => {
    // An entry filed under next Saturday and one under last Friday. Counting
    // either would push the numerator past a denominator drawn from the week.
    expect(
      nutritionWeek(
        { state: 'ready', days: new Set(['2026-08-21', '2026-08-24', '2026-08-29']) },
        MON_TO_SUN,
        '2026-08-26',
      ),
    ).toEqual({ state: 'ready', value: { logged: 1, elapsed: 3 }, stale: false });
  });

  it('reports an answered week with nothing in it as empty, not as zero-of-n', () => {
    expect(nutritionWeek({ state: 'ready', days: new Set() }, MON_TO_SUN, '2026-08-26')).toEqual({
      state: 'empty',
      stale: false,
    });
  });

  it('counts the whole week once it is over', () => {
    expect(
      nutritionWeek({ state: 'ready', days: new Set(MON_TO_SUN) }, MON_TO_SUN, '2026-08-30'),
    ).toEqual({ state: 'ready', value: { logged: 7, elapsed: 7 }, stale: false });
  });
});

describe('freshRecords — one piece of news per lift', () => {
  const named = (id: string) => ({ 'back-squat': 'Back squat', bench: 'Bench press' })[id] ?? id;

  it('counts exercises, not record rows', () => {
    // One lift that set BOTH a heaviest weight and an estimated 1RM in the
    // same session is one thing to tell somebody. Counting rows says "2 new
    // personal bests" for a single set.
    const list: ExerciseRecords[] = [
      {
        exercise_id: 'back-squat',
        records: [record('heaviest_weight', true), record('estimated_1rm', true)],
      },
    ];
    expect(freshRecords(list, named)).toEqual({ count: 1, firstName: 'Back squat' });
  });

  it('ignores a lift whose records are all older', () => {
    const list: ExerciseRecords[] = [
      { exercise_id: 'back-squat', records: [record('heaviest_weight', false)] },
      { exercise_id: 'bench', records: [record('heaviest_weight', true)] },
    ];
    expect(freshRecords(list, named)).toEqual({ count: 1, firstName: 'Bench press' });
  });

  it('reports nothing for an empty list', () => {
    expect(freshRecords([], named)).toEqual({ count: 0, firstName: '' });
  });

  it('falls back to the id when the catalog has no name cached', () => {
    const list: ExerciseRecords[] = [
      { exercise_id: 'zercher-squat', records: [record('heaviest_weight', true)] },
    ];
    expect(freshRecords(list, named).firstName).toBe('zercher-squat');
  });
});
