import type { Module } from '../modules';
import type { PlannedSession } from '../plan';
import type { Session } from '../sessions';
import {
  buildTrainBoard,
  planWindow,
  RECENT_LIMIT,
  STALE_SESSION_MS,
  type Source,
} from '../trainBoard';
import type { Workout } from '../workouts';

/**
 * What Train offers, and — the half these tests exist for — what it refuses to
 * claim.
 *
 * The screen reads three local tables. Every one of them can be unread, failed,
 * or answered-and-empty, and this codebase has shipped the collapse of those
 * three into one value **three times**: a trend card telling an athlete with two
 * years of weigh-ins to start logging, a tracker screen telling somebody with a
 * month of history that they track nothing, and a card rendering its empty state
 * during a fetch that had not returned. Each time the missing kind was *not
 * answered yet*, and each time the type could not help, because an unanswered
 * read and an empty one are the same array.
 *
 * So the emptiness assertions below are not padding around the happy path. They
 * are the point, and every one of them distinguishes `unread` from `ready` with
 * an empty value — a pair a collapsed implementation returns identically.
 */

function mod(over: Partial<Module> & { key: string }): Module {
  return {
    key: over.key,
    label: over.label ?? over.key,
    is_sport: over.is_sport ?? true,
    default_on: true,
    enabled: over.enabled ?? true,
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

const strength = mod({
  key: 'strength',
  label: 'Strength',
  capabilities: { catalog: 'exercises' } as Module['capabilities'],
});
const bjj = mod({
  key: 'bjj',
  label: 'BJJ',
  capabilities: { catalog: 'techniques' } as Module['capabilities'],
});
const running = mod({ key: 'running', label: 'Running' });
const MODULES = [strength, bjj, running];

// Deliberately mid-afternoon local. The suite runs under
// `TZ=America/Los_Angeles`, so a `dayString` built out of `toISOString()` would
// name tomorrow here — which is the exact off-by-one this project runs the
// suite in that zone to catch.
const NOW = new Date('2026-08-26T15:00:00-07:00');
const TODAY = '2026-08-26';

// `...over` last, so every default below is genuinely a default — including
// `ended_at`, where an explicit `null` in the override is what makes a session
// unfinished. Restating a field before the spread would be dead code that
// looked load-bearing.
function session(over: Partial<Session> & { id: string }): Session {
  return {
    user_id: 'u1',
    workout_id: null,
    sport: 'strength',
    name: 'Legs',
    started_at: '2026-08-26T09:00:00-07:00',
    ended_at: '2026-08-26T10:00:00-07:00',
    notes: '',
    sets: [],
    created_at: '2026-08-26T09:00:00Z',
    updated_at: '2026-08-26T09:00:00Z',
    ...over,
  };
}

function plan(over: Partial<PlannedSession> & { id: string }): PlannedSession {
  return { day: TODAY, sport: 'strength', workoutId: null, notes: '', ...over };
}

function workout(over: Partial<Workout> & { id: string }): Workout {
  return {
    owner_user_id: 'u1',
    name: 'Push A',
    sport: 'strength',
    goal: 'hypertrophy',
    notes: '',
    visibility: 'private',
    items: [],
    created_at: '2026-08-01T00:00:00Z',
    updated_at: '2026-08-01T00:00:00Z',
    ...over,
  };
}

const ready = <T,>(value: T): Source<T> => ({ state: 'ready', value });
const unread = { state: 'unread' } as const;
const unavailable = { state: 'unavailable' } as const;

function build(over: {
  sessions?: Source<Session[]>;
  plans?: Source<PlannedSession[]>;
  workouts?: Source<Workout[]>;
  modules?: Module[];
  now?: Date;
}) {
  return buildTrainBoard({
    sessions: over.sessions ?? ready([]),
    plans: over.plans ?? ready([]),
    workouts: over.workouts ?? ready([]),
    modules: over.modules ?? MODULES,
    now: over.now ?? NOW,
  });
}

describe('resume', () => {
  it('offers the newest unfinished session', () => {
    const board = build({
      sessions: ready([
        session({ id: 'newest', started_at: '2026-08-26T14:00:00-07:00', ended_at: null }),
        session({ id: 'older', started_at: '2026-08-26T08:00:00-07:00', ended_at: null }),
      ]),
    });
    expect(board.resume).toEqual({
      state: 'ready',
      value: { session: expect.objectContaining({ id: 'newest' }), stale: false },
    });
  });

  it('offers nothing when every session is finished', () => {
    const board = build({ sessions: ready([session({ id: 's1' })]) });
    expect(board.resume).toEqual({ state: 'ready', value: null });
  });

  // **The pair the collapse would make identical.** "Nothing to resume" and "we
  // have not looked" are both falsy in a naive implementation; only the state
  // tells them apart, and the screen renders differently for each.
  it('does not claim there is nothing to resume before the read answers', () => {
    expect(build({ sessions: unread }).resume).toEqual({ state: 'unread' });
    expect(build({ sessions: unavailable }).resume).toEqual({ state: 'unavailable' });
  });

  it('marks a session older than a day as stale rather than in progress', () => {
    const started = new Date(NOW.getTime() - STALE_SESSION_MS - 60_000).toISOString();
    const board = build({ sessions: ready([session({ id: 'old', started_at: started, ended_at: null })]) });
    expect(board.resume).toMatchObject({ state: 'ready', value: { stale: true } });
  });

  // The other side of the boundary. Without this, `stale: true` as a constant
  // passes the test above — a mutation that survived exactly this shape once
  // already on this codebase, because every vector was on one side.
  it('does not mark a session just under a day old as stale', () => {
    const started = new Date(NOW.getTime() - STALE_SESSION_MS + 60_000).toISOString();
    const board = build({ sessions: ready([session({ id: 'fresh', started_at: started, ended_at: null })]) });
    expect(board.resume).toMatchObject({ state: 'ready', value: { stale: false } });
  });
});

describe("today's plan", () => {
  it('offers a plan for today', () => {
    const board = build({ plans: ready([plan({ id: 'p1' })]) });
    expect(board.today).toMatchObject({ state: 'ready' });
    expect(board.today.state === 'ready' && board.today.value.map((p) => p.id)).toEqual(['p1']);
  });

  it('ignores a plan for another day', () => {
    const board = build({ plans: ready([plan({ id: 'p1', day: '2026-08-27' })]) });
    expect(board.today).toEqual({ state: 'ready', value: [] });
  });

  // `owedOn` is `lib/adherence.ts`'s and is not reimplemented here; this pins
  // that Train actually asks it. Offering "Start BJJ" for a class already
  // logged is the duplicate that subtraction exists to prevent, and it is the
  // loud kind — the athlete has just come back from the mat.
  it('drops a plan a logged session has already met', () => {
    const board = build({
      sessions: ready([session({ id: 's1', sport: 'bjj', started_at: '2026-08-26T19:00:00-07:00' })]),
      plans: ready([plan({ id: 'p1', sport: 'bjj' })]),
    });
    expect(board.today).toEqual({ state: 'ready', value: [] });
  });

  it('names the template when the cache holds it', () => {
    const board = build({
      plans: ready([plan({ id: 'p1', workoutId: 'w7' })]),
      workouts: ready([workout({ id: 'w7', name: 'Push A' })]),
    });
    expect(board.today.state === 'ready' && board.today.value[0].workoutName).toBe('Push A');
  });

  it('carries the log-afterwards verb from the module registry, not the key', () => {
    // `judo`, not `bjj` — the predicate reads the catalog kind, so a second
    // technique-shaped discipline gets the right verb without this module
    // learning its name. A `key === 'bjj'` implementation passes every
    // bjj-only vector and fails this one.
    const judo = mod({ key: 'judo', capabilities: { catalog: 'techniques' } as Module['capabilities'] });
    const board = build({ plans: ready([plan({ id: 'p1', sport: 'judo' })]), modules: [judo] });
    expect(board.today.state === 'ready' && board.today.value[0].logsAfterwards).toBe(true);
  });

  it('does not claim the day is unplanned before the plan read answers', () => {
    expect(build({ plans: unread }).today).toEqual({ state: 'unread' });
  });

  // An unread SESSION list makes today's plan unknown too, because `owedOn`
  // subtracts them. Without this, a plan already met renders as owed for the
  // first frames of every open.
  it('does not claim a plan is owed before the session read answers', () => {
    expect(build({ sessions: unread, plans: ready([plan({ id: 'p1' })]) }).today).toEqual({
      state: 'unread',
    });
  });

  it('reports a failed read as unavailable rather than as an empty day', () => {
    expect(build({ plans: unavailable }).today).toEqual({ state: 'unavailable' });
  });

  // Unavailable outranks unread, so a permanent failure cannot hide behind a
  // spinner forever. Reverse the precedence and this goes red.
  it('prefers unavailable over unread when the two reads disagree', () => {
    expect(build({ sessions: unread, plans: unavailable }).today).toEqual({ state: 'unavailable' });
    expect(build({ sessions: unavailable, plans: unread }).today).toEqual({ state: 'unavailable' });
  });

  // **The asymmetry that makes the workout cache non-fatal.** A failed name
  // lookup must degrade a LABEL, never a plan's existence — the plan is still
  // known and still startable, and it renders as the discipline alone.
  it('still offers the plan when the workout cache could not be read', () => {
    const board = build({
      plans: ready([plan({ id: 'p1', workoutId: 'w7' })]),
      workouts: unavailable,
    });
    expect(board.today).toMatchObject({ state: 'ready' });
    expect(board.today.state === 'ready' && board.today.value[0]).toMatchObject({
      id: 'p1',
      workoutName: null,
    });
  });

  it('leaves the name null when the cache no longer holds the template', () => {
    const board = build({
      plans: ready([plan({ id: 'p1', workoutId: 'gone' })]),
      workouts: ready([workout({ id: 'w7' })]),
    });
    expect(board.today.state === 'ready' && board.today.value[0].workoutName).toBeNull();
  });
});

describe('later', () => {
  it('takes the soonest day after today', () => {
    const board = build({
      plans: ready([
        plan({ id: 'far', day: '2026-09-02' }),
        plan({ id: 'near', day: '2026-08-28' }),
      ]),
    });
    expect(board.later.state === 'ready' && board.later.value?.id).toBe('near');
  });

  // Sorting is what makes the assertion above meaningful, and the fixture is
  // deliberately given in the WRONG order so that dropping the sort — or
  // taking `[0]` off the raw list — goes red rather than passing by luck.
  it('never offers today as later', () => {
    const board = build({ plans: ready([plan({ id: 'p1', day: TODAY })]) });
    expect(board.later).toEqual({ state: 'ready', value: null });
  });

  it('never offers a past day as later', () => {
    const board = build({ plans: ready([plan({ id: 'p1', day: '2026-08-25' })]) });
    expect(board.later).toEqual({ state: 'ready', value: null });
  });

  it('does not claim nothing is coming before the read answers', () => {
    expect(build({ plans: unread }).later).toEqual({ state: 'unread' });
  });
});

describe('recent', () => {
  it('shows the newest session per discipline rather than the newest N sessions', () => {
    // Three strength days and one BJJ. A plain "newest four" fills the block
    // with strength and hides that this athlete also rolls, which is the one
    // thing a multi-sport list is for.
    const board = build({
      sessions: ready([
        session({ id: 's3', sport: 'strength', started_at: '2026-08-26T09:00:00-07:00' }),
        session({ id: 's2', sport: 'strength', started_at: '2026-08-25T09:00:00-07:00' }),
        session({ id: 's1', sport: 'strength', started_at: '2026-08-24T09:00:00-07:00' }),
        session({ id: 'b1', sport: 'bjj', started_at: '2026-08-23T19:00:00-07:00' }),
      ]),
    });
    expect(board.recent.state === 'ready' && board.recent.value.map((s) => s.id)).toEqual([
      's3',
      'b1',
    ]);
  });

  it('leaves the resumable session out — it is already the card above', () => {
    const board = build({
      sessions: ready([
        session({ id: 'open', sport: 'strength', started_at: '2026-08-26T14:00:00-07:00', ended_at: null }),
        session({ id: 'done', sport: 'strength', started_at: '2026-08-25T09:00:00-07:00' }),
      ]),
    });
    expect(board.recent.state === 'ready' && board.recent.value.map((s) => s.id)).toEqual(['done']);
  });

  it(`shows at most ${RECENT_LIMIT} disciplines`, () => {
    const board = build({
      sessions: ready(
        ['a', 'b', 'c', 'd'].map((k, i) =>
          session({ id: k, sport: k, started_at: `2026-08-2${6 - i}T09:00:00-07:00` }),
        ),
      ),
    });
    expect(board.recent.state === 'ready' && board.recent.value).toHaveLength(RECENT_LIMIT);
  });

  // History is not an offer. Quick start hides a switched-off discipline
  // because starting one would be wrong; hiding a session that HAPPENED
  // because a toggle moved afterwards is the N61 lie, where an athlete looked
  // for working features and reported them missing.
  it('keeps a session from a discipline that has since been turned off', () => {
    const board = build({
      sessions: ready([session({ id: 'b1', sport: 'bjj' })]),
      modules: [strength, mod({ key: 'bjj', enabled: false })],
    });
    expect(board.recent.state === 'ready' && board.recent.value.map((s) => s.id)).toEqual(['b1']);
  });

  it('does not claim nothing was logged before the read answers', () => {
    expect(build({ sessions: unread }).recent).toEqual({ state: 'unread' });
    expect(build({ sessions: unavailable }).recent).toEqual({ state: 'unavailable' });
  });
});

describe('planWindow', () => {
  it('starts today, in the local calendar', () => {
    expect(planWindow(NOW).from).toBe(TODAY);
  });

  /**
   * The instant that separates `dayString` from `toISOString().slice(0, 10)`.
   *
   * **The assertion above does not**, which is the whole reason this one is
   * written separately rather than folded into it. `NOW` is 15:00 local, which
   * under `TZ=America/Los_Angeles` is 22:00 UTC — the same calendar day either
   * way — so a UTC-derived window passes it. Mutation-tested: swapping in
   * `toISOString().slice(0, 10)` left the whole suite green until this case
   * existed. A guard is only exercised by the input it is meant to reject.
   *
   * At 20:00 local the two disagree: UTC has already rolled to the 27th, so a
   * UTC window opens tomorrow and **today's own plan falls outside it** —
   * invisible, on the evening an athlete is most likely to be checking what
   * they still owe.
   */
  it('names the local day even when UTC has already rolled over', () => {
    const evening = new Date('2026-08-26T20:00:00-07:00');
    expect(evening.toISOString().slice(0, 10)).toBe('2026-08-27'); // the wrong answer, pinned
    expect(planWindow(evening).from).toBe('2026-08-26');
  });

  it('reaches far enough ahead that Later has something to find', () => {
    expect(planWindow(NOW).to > planWindow(NOW).from).toBe(true);
    expect(planWindow(NOW).to).toBe('2026-09-09');
  });
});
