import { dayString } from '@/lib/calendar';
import type { Module } from '@/lib/modules';
import type { PlannedSession } from '@/lib/plan';
import type { Session } from '@/lib/sessions';
import { buildTodayBoard, todayPlanWindow, type TodayLead } from '@/lib/todayBoard';
import { PLAN_WINDOW_DAYS, type Source } from '@/lib/trainBoard';
import type { Workout } from '@/lib/workouts';

/**
 * Today's lead, and the one thing this module exists to get right.
 *
 * Every test below distinguishes a CORRECT implementation from the one that
 * shipped: `viewPlans`/`weekPlan` as plain arrays starting `[]`, with the read's
 * errors swallowed. Under that implementation "we have not looked", "the read
 * failed" and "nothing is planned" are one value, so **all five of the
 * `it never claims an absence it has not checked` cases below would report
 * `rest`** — which is what Today did on the first frame of every cold open.
 *
 * The five kinds are asserted separately and each has a vector that constructs
 * it. That is deliberate: #583 shipped a `ReadingState` whose `empty` prop was
 * unreachable, so a test asserting its copy never appeared was vacuously green
 * forever. A union is not coverage; a vector per kind is.
 */

const NOW = new Date('2026-08-26T18:00:00');
const TODAY = dayString(NOW);
const TOMORROW = '2026-08-27';

function mod(over: Partial<Module> & { key: string }): Module {
  return {
    key: over.key,
    label: over.label ?? over.key,
    is_sport: true,
    default_on: true,
    enabled: true,
    capabilities: {
      catalog: '',
      facets: [],
      has_goals: false,
      has_progression: false,
      has_food_log: false,
      record_kinds: [],
      ...(over.capabilities ?? {}),
    },
  } as Module;
}

const MODULES = [
  mod({ key: 'strength', label: 'Strength', capabilities: { catalog: 'exercises' } as Module['capabilities'] }),
  mod({ key: 'bjj', label: 'BJJ', capabilities: { catalog: 'techniques' } as Module['capabilities'] }),
];

let seq = 0;
function session(over: Partial<Session> & { id?: string } = {}): Session {
  return {
    id: over.id ?? `s${(seq += 1)}`,
    user_id: 'u1',
    workout_id: null,
    sport: 'strength',
    name: 'Legs',
    started_at: `${TODAY}T09:00:00`,
    ended_at: `${TODAY}T10:00:00`,
    notes: '',
    sets: [],
    created_at: '',
    updated_at: '',
    ...over,
  };
}

function plan(over: Partial<PlannedSession> & { id: string }): PlannedSession {
  return { day: TODAY, sport: 'strength', workoutId: null, notes: '', ...over };
}

const ready = <T,>(value: T): Source<T> => ({ state: 'ready', value });
const unread: Source<never> = { state: 'unread' };
const unavailable: Source<never> = { state: 'unavailable' };

function build(input: {
  sessions?: Source<Session[]>;
  plans?: Source<PlannedSession[]>;
  workouts?: Source<Workout[]>;
  now?: Date;
  viewDay?: Date;
}) {
  return buildTodayBoard({
    sessions: input.sessions ?? ready<Session[]>([]),
    plans: input.plans ?? ready<PlannedSession[]>([]),
    workouts: input.workouts ?? ready<Workout[]>([]),
    modules: MODULES,
    now: input.now ?? NOW,
    viewDay: input.viewDay,
  });
}

/** The lead's kind, or its `Source` state when it has none yet. */
function kindOf(lead: Source<TodayLead>): string {
  return lead.state === 'ready' ? lead.value.kind : lead.state;
}

describe('resume outranks everything, unconditionally', () => {
  const open = session({ id: 'open', ended_at: null });

  it('leads with the running session even when the plan is still loading', () => {
    // The word in the acceptance criterion is "unconditionally", and THIS is
    // the condition it has to survive. Fold the resume check into the same
    // combinator as the plan and this returns `unread` — the athlete is
    // standing in a gym with a clock running and the screen has lost it.
    expect(kindOf(build({ sessions: ready([open]), plans: unread }).lead)).toBe('resume');
  });

  it('leads with the running session even when the plan read has FAILED', () => {
    expect(kindOf(build({ sessions: ready([open]), plans: unavailable }).lead)).toBe('resume');
  });

  it('leads with the running session even when today is also planned', () => {
    const board = build({
      sessions: ready([open]),
      plans: ready([plan({ id: 'p1' })]),
    });
    expect(kindOf(board.lead)).toBe('resume');
  });

  it('takes the newest open session when there are two', () => {
    // Older unfinished sessions are deliberately not hidden — they stay in
    // Train's Recent list. The lead is the newest, from a newest-first read.
    const newer = session({ id: 'newer', ended_at: null, started_at: `${TODAY}T17:00:00` });
    const older = session({ id: 'older', ended_at: null, started_at: `${TODAY}T08:00:00` });
    const board = build({ sessions: ready([newer, older]) });
    expect(board.lead).toEqual({
      state: 'ready',
      value: { kind: 'resume', offer: { session: newer, stale: false } },
    });
  });

  it('still leads with a day-old session, but marks it stale', () => {
    const stale = session({
      id: 'stale',
      ended_at: null,
      // 30 hours before NOW — past the shared 24-hour boundary.
      started_at: new Date(NOW.getTime() - 30 * 3_600_000).toISOString(),
    });
    const lead = build({ sessions: ready([stale]) }).lead;
    expect(lead).toMatchObject({ value: { kind: 'resume', offer: { stale: true } } });
  });

  it('does not lead with a session that is finished', () => {
    expect(kindOf(build({ sessions: ready([session({ ended_at: `${TODAY}T10:00:00` })]) }).lead)).toBe(
      'rest',
    );
  });
});

describe('the day, once both reads have answered', () => {
  it('owes a plan nothing has met', () => {
    const lead = build({ plans: ready([plan({ id: 'p1' })]) }).lead;
    expect(kindOf(lead)).toBe('owed');
    expect(lead).toMatchObject({ value: { plans: [{ id: 'p1' }] } });
  });

  it("says the plan is DONE rather than 'nothing planned' once it is met", () => {
    // The one sentence that was flatly untrue at the exact moment an athlete
    // finished their last session. `owedOn` subtracts the met plan, so without
    // the unfiltered count this collapses back into `rest`.
    const lead = build({
      sessions: ready([session({ sport: 'strength' })]),
      plans: ready([plan({ id: 'p1', sport: 'strength' })]),
    }).lead;
    expect(lead).toEqual({ state: 'ready', value: { kind: 'done', planned: 1 } });
  });

  it('counts every plan on the day, not just the met one', () => {
    const lead = build({
      sessions: ready([session({ sport: 'strength' }), session({ sport: 'bjj' })]),
      plans: ready([
        plan({ id: 'p1', sport: 'strength' }),
        plan({ id: 'p2', sport: 'bjj' }),
      ]),
    }).lead;
    expect(lead).toEqual({ state: 'ready', value: { kind: 'done', planned: 2 } });
  });

  it('owes the second plan while only the first is met', () => {
    const lead = build({
      sessions: ready([session({ sport: 'strength' })]),
      plans: ready([
        plan({ id: 'p1', sport: 'strength' }),
        plan({ id: 'p2', sport: 'bjj' }),
      ]),
    }).lead;
    expect(lead).toMatchObject({ value: { kind: 'owed', plans: [{ id: 'p2' }] } });
  });

  it('is a rest day when nothing at all was planned', () => {
    expect(build({}).lead).toEqual({ state: 'ready', value: { kind: 'rest', loggedToday: 0 } });
  });

  it("counts an off-plan session, so a rest day does not say you did nothing", () => {
    // An athlete who lifted without planning it, told only "Nothing on the
    // plan", has been told their session did not count.
    const lead = build({ sessions: ready([session(), session()]) }).lead;
    expect(lead).toEqual({ state: 'ready', value: { kind: 'rest', loggedToday: 2 } });
  });

  it('does not count yesterday’s session as logged today', () => {
    const lead = build({
      sessions: ready([session({ started_at: '2026-08-25T09:00:00' })]),
    }).lead;
    expect(lead).toEqual({ state: 'ready', value: { kind: 'rest', loggedToday: 0 } });
  });

  it("ignores a plan on another day when deciding today's lead", () => {
    expect(kindOf(build({ plans: ready([plan({ id: 'p9', day: TOMORROW })]) }).lead)).toBe('rest');
  });

  it('names the template when the workout cache knows it', () => {
    const lead = build({
      plans: ready([plan({ id: 'p1', workoutId: 'w7' })]),
      workouts: ready([{ id: 'w7', name: 'Push A' } as Workout]),
    }).lead;
    expect(lead).toMatchObject({ value: { plans: [{ workoutName: 'Push A' }] } });
  });

  it('still owes the plan when the workout cache cannot be read', () => {
    // A failed NAME read degrades a label; it must never turn a known plan into
    // an unknown one. Rank the workout read alongside the others and a missing
    // cache erases a session the athlete is due to do.
    const lead = build({
      plans: ready([plan({ id: 'p1', workoutId: 'w7' })]),
      workouts: unavailable,
    }).lead;
    expect(kindOf(lead)).toBe('owed');
    expect(lead).toMatchObject({ value: { plans: [{ workoutName: null }] } });
  });

  it('asks the catalog kind for the verb, never the module key', () => {
    // `logsAfterwards`, so a second technique-shaped discipline gets Log
    // without this file learning its name — the same predicate
    // `startSessionHref` routes on, so the word and the destination cannot
    // disagree.
    const lead = build({
      plans: ready([plan({ id: 'p1', sport: 'bjj' }), plan({ id: 'p2', sport: 'strength' })]),
    }).lead;
    expect(lead).toMatchObject({
      value: {
        plans: [
          { id: 'p1', logsAfterwards: true },
          { id: 'p2', logsAfterwards: false },
        ],
      },
    });
  });
});

describe('it never claims an absence it has not checked', () => {
  /*
   * The live bug, five ways. Under the implementation this replaced — two
   * arrays initialised to `[]` and a `catch {}` — every one of these returned
   * "nothing planned", which is what put "Nothing planned" on the first frame
   * of every cold open.
   */
  it('is unread while the plan read is in flight', () => {
    expect(kindOf(build({ plans: unread }).lead)).toBe('unread');
  });

  it('is unread while the SESSION read is in flight', () => {
    // Not merely cosmetic: without the session list we cannot tell whether a
    // plan has been met, nor whether a session is open at all — so the rule
    // that resume outranks everything is one we have lost the ability to apply.
    expect(kindOf(build({ sessions: unread }).lead)).toBe('unread');
  });

  it('is unavailable when the plan read failed', () => {
    expect(kindOf(build({ plans: unavailable }).lead)).toBe('unavailable');
  });

  it('is unavailable when the session read failed', () => {
    expect(kindOf(build({ sessions: unavailable }).lead)).toBe('unavailable');
  });

  it('prefers unavailable over unread when one read failed and one has not answered', () => {
    // A permanent failure must not sit forever behind a spinner. "We could not
    // look" is the true sentence once either read has definitively failed.
    expect(kindOf(build({ sessions: unavailable, plans: unread }).lead)).toBe('unavailable');
    expect(kindOf(build({ sessions: unread, plans: unavailable }).lead)).toBe('unavailable');
  });

  it('never reaches a rest day from an unanswered read', () => {
    for (const input of [
      { plans: unread },
      { plans: unavailable },
      { sessions: unread },
      { sessions: unavailable },
    ]) {
      expect(kindOf(build(input).lead)).not.toBe('rest');
    }
  });
});

describe('viewDay: the restored day switcher, kept independent of `now`', () => {
  /*
   * The switcher removed by this ticket's first pass and restored on direct
   * user instruction after review. Every test here distinguishes browsing a
   * day from moving the clock — the exact bug a `viewDay` fed into
   * `buildTrainBoard` in place of `now` would reintroduce.
   */
  const YESTERDAY = '2026-08-25';
  const TOMORROW2 = '2026-08-28';

  it('owes a plan on the VIEWED day, not on real today', () => {
    const lead = build({
      plans: ready([plan({ id: 'p1', day: TOMORROW })]),
      viewDay: new Date(`${TOMORROW}T12:00:00`),
    }).lead;
    expect(kindOf(lead)).toBe('owed');
    expect(lead).toMatchObject({ value: { plans: [{ id: 'p1' }] } });
  });

  it('ignores a plan on today while browsing a different day', () => {
    // The mirror of the above: a plan that WOULD be owed on real today must
    // not leak into a rest/done verdict about a day the athlete stepped to.
    const lead = build({
      plans: ready([plan({ id: 'today-plan', day: TODAY })]),
      viewDay: new Date(`${TOMORROW}T12:00:00`),
    }).lead;
    expect(lead).toEqual({ state: 'ready', value: { kind: 'rest', loggedToday: 0 } });
  });

  it('counts sessions logged on the VIEWED day for the rest credit', () => {
    const lead = build({
      sessions: ready([session({ started_at: `${YESTERDAY}T09:00:00` })]),
      viewDay: new Date(`${YESTERDAY}T12:00:00`),
    }).lead;
    expect(lead).toEqual({ state: 'ready', value: { kind: 'rest', loggedToday: 1 } });
  });

  it('does not count that same session while viewing a different day', () => {
    const lead = build({
      sessions: ready([session({ started_at: `${YESTERDAY}T09:00:00` })]),
      viewDay: new Date(`${TODAY}T12:00:00`),
    }).lead;
    expect(lead).toEqual({ state: 'ready', value: { kind: 'rest', loggedToday: 0 } });
  });

  it('defaults viewDay to now when the caller omits it entirely', () => {
    // The common case — nobody has touched the switcher — must not require
    // every caller to compute and pass today's own date.
    const withDefault = build({ plans: ready([plan({ id: 'p1' })]) }).lead;
    const withExplicit = build({
      plans: ready([plan({ id: 'p1' })]),
      viewDay: NOW,
    }).lead;
    expect(withDefault).toEqual(withExplicit);
  });

  it('an open session still leads the screen while browsing yesterday', () => {
    // Resume is computed from `now`, never from `viewDay` — a live session
    // must not be hidden by stepping the switcher away from today, and
    // stepping away must not retroactively make it stale either.
    const open = session({ id: 'open', ended_at: null, started_at: `${TODAY}T09:00:00` });
    const lead = build({
      sessions: ready([open]),
      viewDay: new Date(`${YESTERDAY}T12:00:00`),
    }).lead;
    expect(lead).toEqual({
      state: 'ready',
      value: { kind: 'resume', offer: { session: open, stale: false } },
    });
  });

  it('LATER is unaffected by viewDay — it always follows real `now`', () => {
    const board = build({
      plans: ready([plan({ id: 'near', day: TOMORROW })]),
      viewDay: new Date(`${TOMORROW2}T12:00:00`),
    });
    // Browsing to the 28th does not make the 27th's plan disappear from LATER
    // just because the browsed day is now further out than it.
    expect(board.later).toMatchObject({ state: 'ready', value: { id: 'near' } });
  });

  it('resolves the template name for a plan on the viewed day', () => {
    // `toPlannedOffer` is the SAME helper Train's own `today` block calls —
    // this is the guard that a change to naming logic lands on both screens.
    const lead = build({
      plans: ready([plan({ id: 'p1', day: TOMORROW, workoutId: 'w7' })]),
      workouts: ready([{ id: 'w7', name: 'Push A' } as Workout]),
      viewDay: new Date(`${TOMORROW}T12:00:00`),
    }).lead;
    expect(lead).toMatchObject({ value: { plans: [{ workoutName: 'Push A' }] } });
  });
});

describe('later', () => {
  it('is the soonest planned day strictly after today', () => {
    const board = build({
      plans: ready([
        plan({ id: 'far', day: '2026-09-02' }),
        plan({ id: 'near', day: TOMORROW }),
        plan({ id: 'today', day: TODAY }),
      ]),
    });
    expect(board.later).toMatchObject({ state: 'ready', value: { id: 'near' } });
  });

  it('is null rather than unread when nothing is planned ahead', () => {
    expect(build({}).later).toEqual({ state: 'ready', value: null });
  });

  it('does not need the session list — nothing can have met a future day', () => {
    const board = build({
      sessions: unavailable,
      plans: ready([plan({ id: 'near', day: TOMORROW })]),
    });
    expect(board.later).toMatchObject({ state: 'ready', value: { id: 'near' } });
  });

  it('carries the plan read’s own state when it has none', () => {
    expect(build({ plans: unread }).later.state).toBe('unread');
    expect(build({ plans: unavailable }).later.state).toBe('unavailable');
  });

  it('survives beside a running session', () => {
    // Later is shown alongside a resume card, unlike today's plan: it is not a
    // competing action, it is the answer to "and after this?".
    const board = build({
      sessions: ready([session({ id: 'open', ended_at: null })]),
      plans: ready([plan({ id: 'near', day: TOMORROW })]),
    });
    expect(kindOf(board.lead)).toBe('resume');
    expect(board.later).toMatchObject({ state: 'ready', value: { id: 'near' } });
  });
});

describe('the plan window', () => {
  it('starts on the Monday of the current week, so THIS WEEK shares the read', () => {
    // 2026-08-26 is a Wednesday.
    expect(todayPlanWindow(new Date('2026-08-26T12:00:00')).from).toBe('2026-08-24');
  });

  it('reaches the same horizon Train uses, so LATER means one thing', () => {
    expect(todayPlanWindow(new Date('2026-08-26T12:00:00')).to).toBe('2026-09-09');
    expect(PLAN_WINDOW_DAYS).toBe(14);
  });

  it('covers a full fortnight across a spring-forward boundary', () => {
    // US DST starts 2026-03-08. A fortnight from 23:30 on the 1st is 23:30 on
    // the 15th — but `now + 14 * 86_400_000` is fourteen exact 24-hour spans,
    // and the hour the clocks gained pushes it to **00:30 on the 16th**, a day
    // late. `addDays` keeps the calendar date. Measured, not reasoned:
    // `addDays` → Sun Mar 15 23:30 PDT, milliseconds → Mon Mar 16 00:30 PDT.
    // The suite runs in America/Los_Angeles precisely so this is visible.
    //
    // **The vector took two tries and both misses are worth recording.** A
    // NOON vector cannot tell the two apart at all — an hour either side of
    // midday is the same calendar day whichever arithmetic runs — so the first
    // version of this test was green while the millisecond mutation survived.
    // That is the N177 shape exactly: a fixture instant that fell on the same
    // day either way. The second attempt moved to 00:30 with the sign of the
    // shift backwards; spring-forward maps an instant to a LATER wall clock,
    // so it also survived. Only mutating caught either.
    //
    // The live caller (`useTodayBoard`) normalises to noon before calling this,
    // so today the guard protects a FUTURE caller rather than a current bug.
    // It is cheaper to keep it correct than to remember the coupling.
    expect(todayPlanWindow(new Date('2026-03-01T23:30:00')).to).toBe('2026-03-15');
  });

  it('widens PAST to cover viewDay, when the switcher steps outside the week', () => {
    // Stepping three weeks back must not silently ask a question this query
    // cannot answer — the whole reason it is ONE bigger read rather than a
    // second one.
    const w = todayPlanWindow(
      new Date('2026-08-26T12:00:00'),
      new Date('2026-08-03T12:00:00'),
    );
    expect(w.from).toBe('2026-08-03');
    expect(w.to).toBe('2026-09-09');
  });

  it('widens FUTURE to cover viewDay, past Train\'s own horizon', () => {
    const w = todayPlanWindow(
      new Date('2026-08-26T12:00:00'),
      new Date('2026-10-01T12:00:00'),
    );
    expect(w.from).toBe('2026-08-24');
    expect(w.to).toBe('2026-10-01');
  });

  it('does not widen at all when viewDay is already inside the window', () => {
    // The common case: nobody has touched the switcher, or it is still within
    // the current week / 14-day horizon. One read, unchanged shape.
    const w = todayPlanWindow(
      new Date('2026-08-26T12:00:00'),
      new Date('2026-08-27T12:00:00'),
    );
    expect(w).toEqual(todayPlanWindow(new Date('2026-08-26T12:00:00')));
  });

  it('defaults viewDay to now, so a caller that never touched the switcher needs no second argument', () => {
    const now = new Date('2026-08-26T12:00:00');
    expect(todayPlanWindow(now, now)).toEqual(todayPlanWindow(now));
  });
});
