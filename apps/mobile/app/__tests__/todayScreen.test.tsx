import { fireEvent, render, screen, waitFor, within } from '@testing-library/react-native';

import TodayScreen from '../(tabs)/index';
import type { Entry } from '@/lib/nutrition';
import type { Module } from '@/lib/modules';
import type { PlannedSession } from '@/lib/plan';
import type { Session } from '@/lib/sessions';
import type { Workout } from '@/lib/workouts';

/**
 * Today, as rendered.
 *
 * ## Why this file did not exist before, and why it does now
 *
 * Today is the app's most-opened screen and had **no screen-level test at
 * all** — its coverage was `todayDaySwitcher.test.tsx`, two derivations lifted
 * out of it, one of which was true by construction. That is how the
 * empty-vs-unknown collapse sat live on it: `viewPlans`/`weekPlan` started `[]`
 * and `refreshPlan` swallowed its errors, so the screen asserted **"Nothing
 * planned"** on the first frame of every cold open and kept asserting it when
 * the read failed. Nothing could have gone red.
 *
 * `lib/todayBoard.ts` has its own tests for the derivation. Three properties
 * live only here, because only the render decides them:
 *
 * 1. **A `Source` state reaches the right COPY.** The derivation returning
 *    `unread` proves nothing about whether the screen draws an empty day.
 * 2. **Resume displaces the plan** rather than sitting above it.
 * 3. **A discipline routes to the screen that fits it** — `logsAfterwards`,
 *    through `lib/startSession.ts`, on both the plan card and the resume card.
 *    That is one `if`, it has its own tests, and this file checks the buttons
 *    are wired to it rather than to a second copy. A BJJ round pushed into the
 *    strength logger fails nothing and is silent.
 *
 * Everything is driven through mocked reads of the app's real functions, so a
 * failure here is a failure in this screen and not in SQLite.
 */

jest.setTimeout(30_000);

// ── the three reads the board makes ───────────────────────────────────────
const mockListLocalSessions = jest.fn(
  (..._a: unknown[]): Promise<Session[]> => Promise.resolve([]),
);
const mockCachedWorkouts = jest.fn((..._a: unknown[]): Promise<Workout[]> => Promise.resolve([]));
jest.mock('@/lib/sessionStore', () => ({
  listLocalSessions: (...a: unknown[]) => mockListLocalSessions(...a),
  cachedWorkouts: (...a: unknown[]) => mockCachedWorkouts(...a),
  trainingSince: () => Promise.resolve(null),
}));

const mockListPlannedBetween = jest.fn(
  (..._a: unknown[]): Promise<PlannedSession[]> => Promise.resolve([]),
);
jest.mock('@/lib/plan', () => ({
  listPlannedBetween: (...a: unknown[]) => mockListPlannedBetween(...a),
}));

// ── navigation ────────────────────────────────────────────────────────────
const mockPush = jest.fn();
jest.mock('expo-router', () => {
  const react = jest.requireActual<typeof import('react')>('react');
  return {
    useRouter: () => ({ push: mockPush }),
    // Fires the effect on mount, which is what a focused screen does.
    useFocusEffect: (cb: () => void | (() => void)) => react.useEffect(cb, [cb]),
  };
});

jest.mock('@clerk/clerk-expo', () => ({ useAuth: () => ({ userId: 'u1' }) }));
// A STABLE getter, not a fresh arrow per render. `useAuthToken` is a
// dependency of four of Today's `useCallback`s, so a mock returning a new
// function each time changes their identity every render — and the focus
// effect that depends on them then re-runs forever. It does not merely spin:
// the first version of this file exhausted V8's heap and aborted the worker,
// which reads as a broken test file rather than as an unstable mock.
const mockGetToken = () => Promise.resolve('tok');
jest.mock('@/lib/useAuthToken', () => ({ useAuthToken: () => mockGetToken }));

jest.mock('@/lib/sync', () => ({
  request: jest.fn(),
  syncNow: jest.fn(async () => ({ lastError: null })),
  useSyncState: () => ({
    syncing: false,
    pending: 0,
    deferred: 0,
    lastSyncAt: null,
    lastError: null,
    online: true,
  }),
}));

// ── everything Today fetches that this file is not about ──────────────────
//
// Stubbed to resolve empty rather than left to hit the network. A rejected
// promise here would be indistinguishable from the failures the tests below
// DO construct, which is the apparatus trap: a screen showing "couldn't read"
// for the wrong reason still passes an assertion that it says so.
jest.mock('@/lib/themes', () => ({ fetchThemes: () => Promise.resolve([]) }));
const mockFunnel = jest.fn((..._a: unknown[]): Promise<unknown[]> => Promise.resolve([]));
jest.mock('@/lib/proficiency', () => ({
  fetchProficiency: (...a: unknown[]) => mockFunnel(...a),
}));
jest.mock('@/lib/curriculum', () => ({ listWorkingCurricula: () => Promise.resolve([]) }));
jest.mock('@/lib/body', () => ({
  listCheckins: () => Promise.resolve([]),
  listPhases: () => Promise.resolve([]),
}));
jest.mock('@/lib/prefs', () => ({
  ...jest.requireActual('@/lib/prefs'),
  readPref: () => Promise.resolve(null),
  writePref: () => Promise.resolve(),
}));
// `localEntries` is a real jest.fn (not a constant resolver), unlike its
// neighbours here — Momentum's day-following behaviour (N179/#584 follow-up)
// is specifically that it reads the BROWSED day, not always real today, so
// the tests for that need to see which `on` argument this was called with.
const mockLocalEntries = jest.fn((..._a: unknown[]): Promise<Entry[]> => Promise.resolve([]));
jest.mock('@/lib/foodLog', () => ({
  localEntries: (...a: unknown[]) => mockLocalEntries(...a),
  localLoggedDays: () => Promise.resolve([]),
  localTargetView: () => Promise.resolve({ state: 'unknown' }),
  recentsFor: () => Promise.resolve([]),
  cacheTargets: () => Promise.resolve(),
  logFood: () => Promise.resolve(),
}));
jest.mock('@/lib/nutritionApi', () => ({
  ...jest.requireActual('@/lib/nutritionApi'),
  listTargets: () => Promise.resolve([]),
}));
// The tracker day, stubbed at the HOOK rather than at its four SQLite calls.
//
// Every field is a module-scope constant, for the same reason `mockGetToken`
// is: `refresh` is a dependency of Today's refresh effect, so a fresh closure
// per render re-runs it forever. And `state: 'ready'` with no trackers is a
// reachable state — the server provisions water on first list, so a device that
// has been told and has none is real — which is what makes the assertion on
// `today-trackers-empty` an assertion about something that can happen.
const mockTrackerRefresh = () => () => {};
const mockTrackerDay = {
  view: { state: 'ready' as const, trackers: [] },
  entriesFor: () => [],
  refresh: mockTrackerRefresh,
  addTap: () => {},
  removeEntry: () => {},
  openSettings: () => {},
};
jest.mock('@/lib/useTrackerDay', () => ({ useTrackerDay: () => mockTrackerDay }));

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
const nutrition = mod({
  key: 'nutrition',
  label: 'Nutrition',
  is_sport: false,
  capabilities: { has_food_log: true } as Module['capabilities'],
});

// `mock`-prefixed, because jest's module factory may not close over an
// ordinary out-of-scope variable — the guard against uninitialised mocks.
let mockModules: Module[] = [strength, bjj, nutrition];
jest.mock('@/lib/ModulesProvider', () => ({
  useModules: () => ({ modules: mockModules, ready: true, stale: false, apply: jest.fn() }),
}));

// `...over` last, so `ended_at: null` in an override is what makes a session
// unfinished and every field above is genuinely a default.
function session(over: Partial<Session> & { id: string }): Session {
  return {
    user_id: 'u1',
    workout_id: null,
    sport: 'strength',
    name: 'Legs',
    started_at: new Date(Date.now() - 30 * 60_000).toISOString(),
    ended_at: new Date().toISOString(),
    notes: '',
    sets: [],
    created_at: '',
    updated_at: '',
    ...over,
  };
}

/** Today's local calendar day, the way the app computes it. */
function todayKey(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function dayFromNow(n: number): string {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** A logged food entry, defaulted to today so a test only sets what it means. */
function entry(over: Partial<Entry> & { id: string }): Entry {
  return {
    eaten_on: todayKey(),
    meal: 'breakfast',
    name: 'Food',
    servings: 1,
    serving_label: '1 serving',
    source_food_id: null,
    notes: '',
    kcal: 100,
    protein_g: 10,
    carb_g: 10,
    fat_g: 5,
    fibre_g: null,
    ...over,
  };
}

beforeEach(() => {
  mockModules = [strength, bjj, nutrition];
  mockPush.mockReset();
  mockListLocalSessions.mockReset();
  mockListLocalSessions.mockResolvedValue([]);
  mockCachedWorkouts.mockReset();
  mockCachedWorkouts.mockResolvedValue([]);
  mockListPlannedBetween.mockReset();
  mockListPlannedBetween.mockResolvedValue([]);
  mockFunnel.mockReset();
  mockFunnel.mockResolvedValue([]);
  mockLocalEntries.mockReset();
  mockLocalEntries.mockResolvedValue([]);
});

describe('the active session outranks everything', () => {
  it('leads with Resume and renders no competing plan card', async () => {
    mockListLocalSessions.mockResolvedValue([session({ id: 'open', ended_at: null })]);
    mockListPlannedBetween.mockResolvedValue([
      { id: 'p1', day: todayKey(), sport: 'strength', workoutId: null, notes: '' },
    ]);

    render(<TodayScreen />);

    await waitFor(() => expect(screen.getByTestId('resume-session')).toBeTruthy());
    // The plan exists and is owed — the derivation would happily return it —
    // and the screen still renders no competing Start. Delete the `resume`
    // branch in `buildTodayBoard` and both of these go red.
    expect(screen.queryByTestId('today-plan-p1')).toBeNull();
    expect(screen.queryByTestId('today-unplanned')).toBeNull();
    expect(screen.queryByTestId('today-all-done')).toBeNull();
  });

  it('opens the session it names', async () => {
    mockListLocalSessions.mockResolvedValue([session({ id: 'open', ended_at: null })]);
    render(<TodayScreen />);

    fireEvent.press(await screen.findByTestId('resume-session'));
    expect(mockPush).toHaveBeenCalledWith({ pathname: '/session/[id]', params: { id: 'open' } });
  });

  // The branch that must survive any rebuild of this screen. A BJJ session
  // opened in the set logger renders a screen it can never fill, and the
  // reflection behind it becomes unreachable — it is entered by `replace` from
  // the log screen and linked from nowhere else.
  it('takes a resumable BJJ session to the BJJ reader, not the set logger', async () => {
    mockListLocalSessions.mockResolvedValue([
      session({ id: 'roll', sport: 'bjj', name: 'Evening class', ended_at: null }),
    ]);
    render(<TodayScreen />);

    fireEvent.press(await screen.findByTestId('resume-session'));
    expect(mockPush).toHaveBeenCalledWith({ pathname: '/bjj/session/[id]', params: { id: 'roll' } });
  });

  it('omits the set count on a discipline that cannot hold one', async () => {
    mockListLocalSessions.mockResolvedValue([
      session({ id: 'roll', sport: 'bjj', name: 'Evening class', ended_at: null }),
    ]);
    render(<TodayScreen />);

    expect(await screen.findByTestId('resume-session')).toBeTruthy();
    expect(screen.queryByText('0 working sets')).toBeNull();
  });

  it('says a day-old session is unfinished rather than in progress', async () => {
    mockListLocalSessions.mockResolvedValue([
      session({
        id: 'stale',
        ended_at: null,
        started_at: new Date(Date.now() - 30 * 60 * 60_000).toISOString(),
      }),
    ]);
    render(<TodayScreen />);

    expect(await screen.findByText('UNFINISHED')).toBeTruthy();
    expect(screen.getByText('Finish or discard')).toBeTruthy();
    expect(screen.queryByText('Continue')).toBeNull();
  });
});

describe("today's plan", () => {
  it('offers Start for a planned strength day, template and all', async () => {
    mockListPlannedBetween.mockResolvedValue([
      { id: 'p1', day: todayKey(), sport: 'strength', workoutId: 'w7', notes: '' },
    ]);
    mockCachedWorkouts.mockResolvedValue([{ id: 'w7', name: 'Push A' } as Workout]);

    render(<TodayScreen />);

    expect(await screen.findByTestId('today-plan-p1')).toBeTruthy();
    expect(screen.getByText('Push A')).toBeTruthy();
    fireEvent.press(screen.getByTestId('up-next-log'));
    // The template rides along, so the chooser does not reappear for a day
    // whose plan is already decided.
    expect(mockPush).toHaveBeenCalledWith('/session/start?sport=strength&workout=w7');
  });

  // Criterion 5 of the epic, and the one that is silent when broken.
  it('sends a planned BJJ day to the BJJ log, never to the set logger', async () => {
    mockListPlannedBetween.mockResolvedValue([
      { id: 'p2', day: todayKey(), sport: 'bjj', workoutId: null, notes: '' },
    ]);
    render(<TodayScreen />);

    expect(await screen.findByTestId('today-plan-p2')).toBeTruthy();
    fireEvent.press(screen.getByTestId('up-next-log'));
    expect(mockPush).toHaveBeenCalledWith('/bjj/log');
  });

  it('announces Log rather than Start for a discipline logged afterwards', async () => {
    mockListPlannedBetween.mockResolvedValue([
      { id: 'p2', day: todayKey(), sport: 'bjj', workoutId: null, notes: '' },
    ]);
    render(<TodayScreen />);

    const card = await screen.findByTestId('today-plan-p2');
    expect(card.props.accessibilityLabel).toBe('Log BJJ session, planned for today');
  });

  it("says the plan is done rather than 'nothing planned' once it is met", async () => {
    // The one sentence that was flatly untrue at the exact moment an athlete
    // finished their last session.
    mockListPlannedBetween.mockResolvedValue([
      { id: 'p1', day: todayKey(), sport: 'strength', workoutId: null, notes: '' },
    ]);
    mockListLocalSessions.mockResolvedValue([session({ id: 's1', sport: 'strength' })]);

    render(<TodayScreen />);

    expect(await screen.findByTestId('today-all-done')).toBeTruthy();
    expect(screen.queryByTestId('today-unplanned')).toBeNull();
    expect(screen.getByText('1 session logged against the plan.')).toBeTruthy();
  });
});

describe('a rest day is a real state', () => {
  it('says what is true and offers the plan, without scolding', async () => {
    render(<TodayScreen />);

    const rest = await screen.findByTestId('today-unplanned');
    expect(rest).toBeTruthy();
    // The copy invites rather than reprimands, and it names rest as a state
    // rather than an absence. `restLine` is date-circulated, so the title is
    // asserted through the meta line, which is fixed.
    expect(
      screen.getByText(
        'Rest counts — or plan something here, or log an unplanned session with New log.',
      ),
    ).toBeTruthy();
    fireEvent.press(rest);
    expect(mockPush).toHaveBeenCalledWith('/(tabs)/workouts');
  });

  it('credits a session logged off-plan instead of implying nothing happened', async () => {
    // Nothing was scheduled AND the athlete trained. Told only "Nothing on the
    // plan", they have been told their session did not count.
    mockListLocalSessions.mockResolvedValue([session({ id: 's1' })]);
    render(<TodayScreen />);

    expect(await screen.findByText(/You logged 1 session today anyway/)).toBeTruthy();
  });
});

describe('it never claims an absence it has not checked', () => {
  /** A read that is still in flight when the assertion runs. */
  const pending = <T,>() => new Promise<T>(() => {});

  it('does not say the day is unplanned while the plan read is in flight', async () => {
    mockListPlannedBetween.mockReturnValue(pending<PlannedSession[]>());
    render(<TodayScreen />);

    // The week strip proves the screen has rendered — so the absence below is
    // a deliberate silence and not a test that asserted before the first paint.
    expect(await screen.findByTestId('today-week-strip')).toBeTruthy();
    expect(screen.queryByTestId('today-unplanned')).toBeNull();
    expect(screen.queryByTestId('today-all-done')).toBeNull();
    expect(screen.queryByTestId('today-lead-unavailable')).toBeNull();
  });

  it('does not say the day is unplanned while the SESSION read is in flight', async () => {
    // Without the session list the screen cannot tell whether a plan has been
    // met, nor whether a session is open — so it may not claim a rest day.
    mockListLocalSessions.mockReturnValue(pending<Session[]>());
    render(<TodayScreen />);

    expect(await screen.findByTestId('today-week-strip')).toBeTruthy();
    expect(screen.queryByTestId('today-unplanned')).toBeNull();
  });

  it('says it could not read the plan rather than showing an unplanned day', async () => {
    mockListPlannedBetween.mockRejectedValue(new Error('disk'));
    render(<TodayScreen />);

    expect(await screen.findByTestId('today-lead-unavailable')).toBeTruthy();
    expect(screen.queryByTestId('today-unplanned')).toBeNull();
    // **It blames the PLAN, and only the plan.** The session read answered, and
    // a resume would have short-circuited this block entirely — so we know
    // nothing is part-finished, and saying "we could not check for an
    // unfinished session" here would send the athlete looking in the wrong
    // place. This copy asserted both halves unconditionally until review.
    expect(screen.getByText("We couldn't read today's plan just now.")).toBeTruthy();
    expect(screen.queryByText(/unfinished session/)).toBeNull();
  });

  it('names the unfinished-session check when THAT is what failed', async () => {
    mockListLocalSessions.mockRejectedValue(new Error('disk'));
    render(<TodayScreen />);

    expect(await screen.findByTestId('today-lead-unavailable')).toBeTruthy();
    expect(screen.queryByTestId('today-unplanned')).toBeNull();
    // Here the screen genuinely cannot tell whether something is open, so the
    // rule that a running session outranks everything is the one it has just
    // lost the ability to apply. Worth saying: the athlete may have one.
    expect(
      screen.getByText(
        'That covers your plan and any unfinished session. New log still works.',
      ),
    ).toBeTruthy();
  });

  it('does claim a rest day once both reads have answered', async () => {
    // The mirror of the three above, and what stops them passing by the screen
    // simply never rendering the rest state at all.
    render(<TodayScreen />);
    expect(await screen.findByTestId('today-unplanned')).toBeTruthy();
  });
});

describe('insight', () => {
  // The Tier 0 offer, which is the only prompt that CREATES the evidence the
  // suggestion tier reads. `fetchProficiency` is stubbed to `[]` — no
  // technique-level detail has ever been recorded — and `readPref` to null, so
  // the offer has never been shown. Two BJJ sessions is the lower bound.
  it('offers the detail prompt once BJJ is being logged with nothing coming out', async () => {
    mockListLocalSessions.mockResolvedValue([
      session({ id: 'r1', sport: 'bjj' }),
      session({ id: 'r2', sport: 'bjj' }),
    ]);
    render(<TodayScreen />);

    expect(await screen.findByTestId('today-offer-detail')).toBeTruthy();
  });

  it('does not offer it on a single BJJ session', async () => {
    // One is not a habit, and the first log should be uncomplicated. Without a
    // negative case the bound above is unexercised in either direction.
    mockListLocalSessions.mockResolvedValue([session({ id: 'r1', sport: 'bjj' })]);
    render(<TodayScreen />);

    expect(await screen.findByTestId('today-week-strip')).toBeTruthy();
    expect(screen.queryByTestId('today-offer-detail')).toBeNull();
  });

  it('names the suggestion card by the words printed on it', async () => {
    // WCAG 2.5.3. The label read "try {name} live" while the card says
    // "Try {name} in a round", so "tap try armbar in a round" matched nothing
    // under Voice Control — and this branch fixes the same thing on two other
    // cards, so the card was inconsistent with its own neighbours. Review
    // caught it; nothing asserted the label at all before this test.
    // Two rows, and the first is not decoration: `funnelGap` refuses to make
    // any suggestion until SOMETHING in the funnel has a live counter on it,
    // because otherwise the rule collapses to "drilled a lot, recently" over
    // data that could never have been recorded. The second row is the
    // candidate — six drills, nothing live, seen recently.
    mockFunnel.mockResolvedValue([
      {
        technique_id: 't0',
        name: 'Triangle',
        position: 'guard',
        category: 'submission',
        drilled: 2,
        attempted: 1,
        scored: 1,
        conceded: 0,
        sessions: 2,
        last_seen: new Date().toISOString(),
      },
      {
        technique_id: 't1',
        name: 'Armbar',
        position: 'guard',
        category: 'submission',
        drilled: 6,
        attempted: 0,
        scored: 0,
        conceded: 0,
        sessions: 3,
        last_seen: new Date().toISOString(),
      },
    ]);
    render(<TodayScreen />);

    const card = await screen.findByTestId('today-suggestion');
    expect(screen.getByText('Try Armbar in a round')).toBeTruthy();
    expect(card.props.accessibilityLabel).toContain('Try Armbar in a round');
  });

  it('draws no Insight heading when there is nothing to say', async () => {
    render(<TodayScreen />);
    expect(await screen.findByTestId('today-week-strip')).toBeTruthy();
    expect(screen.queryByText('Insight')).toBeNull();
  });
});

describe('later', () => {
  it('shows the next planned day, with no button on it', async () => {
    mockListPlannedBetween.mockResolvedValue([
      { id: 'p9', day: dayFromNow(2), sport: 'bjj', workoutId: null, notes: '' },
    ]);
    render(<TodayScreen />);

    expect(await screen.findByTestId('today-later')).toBeTruthy();
    expect(screen.getByText('BJJ session')).toBeTruthy();
    // Starting tomorrow's session today is how a plan stops meaning anything.
    expect(screen.queryByTestId('today-plan-p9')).toBeNull();
  });

  it('is shown alongside a running session', async () => {
    mockListLocalSessions.mockResolvedValue([session({ id: 'open', ended_at: null })]);
    mockListPlannedBetween.mockResolvedValue([
      { id: 'p9', day: dayFromNow(2), sport: 'bjj', workoutId: null, notes: '' },
    ]);
    render(<TodayScreen />);

    expect(await screen.findByTestId('resume-session')).toBeTruthy();
    expect(screen.getByTestId('today-later')).toBeTruthy();
  });

  it('draws no Later block at all when nothing is planned ahead', async () => {
    render(<TodayScreen />);
    expect(await screen.findByTestId('today-week-strip')).toBeTruthy();
    expect(screen.queryByTestId('today-later')).toBeNull();
  });

  it('draws no Later block while the plan read is in flight', async () => {
    mockListPlannedBetween.mockReturnValue(new Promise<PlannedSession[]>(() => {}));
    render(<TodayScreen />);
    expect(await screen.findByTestId('today-week-strip')).toBeTruthy();
    expect(screen.queryByTestId('today-later')).toBeNull();
  });
});

describe('the day switcher, restored on direct user instruction', () => {
  // "we can go to before dates or future ones" — continuous navigation FROM
  // Today, which is why it is a switcher on this screen rather than a link to
  // Plan. See the note on `dayOffset` in the screen for the full reasoning and
  // the `ac-verifier` criterion this reverses.

  it('is hidden while a session is open', async () => {
    // The only thing it drives is the OWED/DONE/REST section, which the
    // resume card replaces entirely and which ignores viewDay by design — a
    // visible switcher here would be a control that does nothing.
    mockListLocalSessions.mockResolvedValue([session({ id: 'open', ended_at: null })]);
    render(<TodayScreen />);

    expect(await screen.findByTestId('resume-session')).toBeTruthy();
    expect(screen.queryByTestId('today-day')).toBeNull();
  });

  it('is shown, reading TODAY, when nothing is open', async () => {
    render(<TodayScreen />);
    expect(await screen.findByTestId('today-day')).toBeTruthy();
    expect(screen.getByText('TODAY')).toBeTruthy();
  });

  it('steps forward to reveal a plan on tomorrow', async () => {
    mockListPlannedBetween.mockResolvedValue([
      { id: 'p9', day: dayFromNow(1), sport: 'strength', workoutId: null, notes: '' },
    ]);
    render(<TodayScreen />);

    // Nothing is owed on today itself in this fixture.
    expect(await screen.findByTestId('today-unplanned')).toBeTruthy();
    fireEvent.press(screen.getByTestId('today-day-next'));

    expect(await screen.findByTestId('today-plan-p9')).toBeTruthy();
    expect(screen.queryByTestId('today-unplanned')).toBeNull();
  });

  it('a plan owed on a browsed FUTURE day still routes through startSessionHref', async () => {
    mockListPlannedBetween.mockResolvedValue([
      { id: 'p9', day: dayFromNow(1), sport: 'bjj', workoutId: null, notes: '' },
    ]);
    render(<TodayScreen />);
    await screen.findByTestId('today-unplanned');
    fireEvent.press(screen.getByTestId('today-day-next'));

    fireEvent.press(await screen.findByTestId('up-next-log'));
    expect(mockPush).toHaveBeenCalledWith('/bjj/log');
  });

  it('steps to a past day with an unmet plan: no press, says Not logged', async () => {
    mockListPlannedBetween.mockResolvedValue([
      { id: 'p1', day: dayFromNow(-1), sport: 'strength', workoutId: null, notes: '' },
    ]);
    render(<TodayScreen />);
    await screen.findByTestId('today-unplanned');
    fireEvent.press(screen.getByTestId('today-day-prev'));

    const card = await screen.findByTestId('today-plan-p1');
    expect(screen.getByText('Not logged')).toBeTruthy();
    // `past` drops the Log button and the press handler entirely.
    expect(screen.queryByTestId('up-next-log')).toBeNull();
    expect(card.props.accessibilityRole).toBe('text');
  });

  it('a past rest day says nothing was logged, not "rest counts"', async () => {
    render(<TodayScreen />);
    await screen.findByTestId('today-unplanned');
    fireEvent.press(screen.getByTestId('today-day-prev'));

    expect(await screen.findByText('Nothing was planned, and nothing logged.')).toBeTruthy();
    expect(screen.queryByText(/Rest counts/)).toBeNull();
  });

  it('a future rest day does not say "rest counts" either — nothing has happened yet', async () => {
    render(<TodayScreen />);
    await screen.findByTestId('today-unplanned');
    fireEvent.press(screen.getByTestId('today-day-next'));

    expect(await screen.findByText('Nothing planned yet. Plan something here.')).toBeTruthy();
    expect(screen.queryByText(/Rest counts/)).toBeNull();
  });

  it('a past day credits a session logged off-plan, in the past tense', async () => {
    mockListLocalSessions.mockResolvedValue([
      session({ id: 's1', started_at: `${dayFromNow(-1)}T09:00:00.000Z` }),
    ]);
    render(<TodayScreen />);
    await screen.findByTestId('today-unplanned');
    fireEvent.press(screen.getByTestId('today-day-prev'));

    expect(await screen.findByText('You logged 1 session then anyway.')).toBeTruthy();
  });

  it('"planned and done" reads in the past tense for a browsed past day', async () => {
    mockListPlannedBetween.mockResolvedValue([
      { id: 'p1', day: dayFromNow(-1), sport: 'strength', workoutId: null, notes: '' },
    ]);
    mockListLocalSessions.mockResolvedValue([
      session({ id: 's1', sport: 'strength', started_at: `${dayFromNow(-1)}T09:00:00.000Z` }),
    ]);
    render(<TodayScreen />);
    await screen.findByTestId('today-unplanned');
    fireEvent.press(screen.getByTestId('today-day-prev'));

    expect(await screen.findByText('Everything planned was logged.')).toBeTruthy();
    expect(screen.queryByText('That is everything planned.')).toBeNull();
  });

  it('pressing the label returns to today from anywhere', async () => {
    render(<TodayScreen />);
    await screen.findByTestId('today-day');
    fireEvent.press(screen.getByTestId('today-day-next'));
    fireEvent.press(screen.getByTestId('today-day-next'));
    // Stepped away: the readout no longer says TODAY.
    expect(screen.queryByText('TODAY')).toBeNull();

    fireEvent.press(screen.getByTestId('today-day-label'));
    expect(await screen.findByText('TODAY')).toBeTruthy();
  });

  it('the label is a plain readout on today — no onPress, so no button role', async () => {
    render(<TodayScreen />);
    const label = await screen.findByTestId('today-day-label');
    expect(label.props.accessibilityRole).toBe('text');
  });

  it('does NOT move LATER — it names the same next planned day regardless of viewDay', async () => {
    mockListPlannedBetween.mockResolvedValue([
      { id: 'later1', day: dayFromNow(3), sport: 'bjj', workoutId: null, notes: '' },
    ]);
    render(<TodayScreen />);
    expect(await screen.findByTestId('today-later')).toBeTruthy();
    fireEvent.press(screen.getByTestId('today-day-next'));
    expect(await screen.findByTestId('today-later')).toBeTruthy();
  });
});

describe('the six blocks', () => {
  it('keeps Log Food one tap from Today', async () => {
    // The ticket's third test step: any additional confirmation step is a
    // failure. `onLog` goes straight at the food flow.
    render(<TodayScreen />);
    fireEvent.press(await screen.findByTestId('today-log-food'));
    expect(mockPush).toHaveBeenCalledWith('/food/add');
  });

  it('renders the daily-progress and this-week blocks', async () => {
    render(<TodayScreen />);
    expect(await screen.findByTestId('today-momentum')).toBeTruthy();
    expect(screen.getByTestId('today-trackers-empty')).toBeTruthy();
    expect(screen.getByTestId('today-progress')).toBeTruthy();
    expect(screen.getByTestId('today-week-strip')).toBeTruthy();
    expect(screen.getByTestId('today-training')).toBeTruthy();
  });

  it('no longer carries the deep analytics, which moved to Progress', async () => {
    // "Reduced on this screen (moved, not deleted)" — the week review is drawn
    // by Progress's `ThisWeek`, the weekly bars by its `TrainingSummary`, and
    // the calendar by `components/progress/TrainingHistory.tsx`. Asserted by
    // their own testIDs, so re-adding one here goes red rather than merely
    // looking busy.
    mockListLocalSessions.mockResolvedValue([session({ id: 's1' })]);
    render(<TodayScreen />);

    expect(await screen.findByTestId('today-week-strip')).toBeTruthy();
    expect(screen.queryByTestId('week-review')).toBeNull();
    expect(screen.queryByTestId('today-trend')).toBeNull();
    expect(screen.queryByTestId('training-calendar')).toBeNull();
    // Recent sessions live on Train, from the same read, and are reachable by
    // date through the calendar on Progress.
    expect(screen.queryByTestId('session-s1')).toBeNull();
  });

  it('sends the week strip to Progress, where the review now lives', async () => {
    render(<TodayScreen />);
    fireEvent.press(await screen.findByTestId('week-strip-review'));
    expect(mockPush).toHaveBeenCalledWith('/(tabs)/progress');
  });

  it('offers the settings screen when nothing at all is enabled', async () => {
    mockModules = [mod({ key: 'strength', enabled: false })];
    render(<TodayScreen />);

    expect(await screen.findByTestId('start-session-none')).toBeTruthy();
    expect(screen.queryByTestId('today-new-log')).toBeNull();
  });

  it('names a food module that is turned off rather than hiding the slot', async () => {
    mockModules = [strength, mod({ ...nutrition, enabled: false })];
    render(<TodayScreen />);

    expect(await screen.findByTestId('today-fuel-off')).toBeTruthy();
    expect(screen.queryByTestId('today-momentum')).toBeNull();
  });
});

describe('the date, folded into the switcher (N179/#584 follow-up)', () => {
  // The bug: the switcher read `TODAY` and a second, separate `<Text>`
  // immediately below it repeated the exact same date — one fact, twice.
  // `subLabel` folds it into the pill; see `PeriodSwitcher`'s own tests for
  // the component-level coverage. What matters here is that TODAY the screen
  // no longer renders a redundant standalone line.

  it('speaks the date as part of the switcher’s own accessible name', async () => {
    render(<TodayScreen />);
    const label = await screen.findByTestId('today-day-label');
    expect(label.props.accessibilityLabel).toMatch(/^TODAY, [A-Z][a-z]+day, [A-Z][a-z]+ \d{1,2}$/);
  });

  it('renders the weekday-and-date string exactly once, not twice', async () => {
    render(<TodayScreen />);
    await screen.findByTestId('today-day');
    // "Wednesday, 26 August" — the exact shape `todayLabel` produces. Before
    // the fix this matched TWO nodes: the standalone `<Text style={styles
    // .date}>` and (once browsing) the pill's own short label. Folding it in
    // leaves exactly one.
    expect(screen.getAllByText(/^[A-Z][a-z]+day, [A-Z][a-z]+ \d{1,2}$/)).toHaveLength(1);
  });
});

describe('Momentum follows the browsed day (N179/#584 follow-up)', () => {
  // Reversed on direct user instruction: "no matter where we switch the
  // Todays momentum with cals and stuff shows todays stats we need to show
  // real things." Momentum used to always read real today regardless of
  // `viewDay`; it now reads whichever day the switcher is showing.

  it('reads real today’s entries with nothing browsed', async () => {
    mockLocalEntries.mockResolvedValue([entry({ id: 'e1' })]);
    render(<TodayScreen />);

    const momentum = within(await screen.findByTestId('today-momentum'));
    expect(await momentum.findByText('1 entry')).toBeTruthy();
    expect(mockLocalEntries).toHaveBeenCalledWith('u1', todayKey());
  });

  it('re-fetches and shows the BROWSED day’s entries once the switcher steps back', async () => {
    const yesterday = dayFromNow(-1);
    mockLocalEntries.mockImplementation((..._a: unknown[]) => {
      const on = _a[1] as string;
      return Promise.resolve(on === yesterday ? [entry({ id: 'e1' }), entry({ id: 'e2' })] : []);
    });
    render(<TodayScreen />);
    await screen.findByTestId('today-momentum');

    fireEvent.press(screen.getByTestId('today-day-prev'));

    const momentum = within(await screen.findByTestId('today-momentum'));
    expect(await momentum.findByText('2 entries')).toBeTruthy();
    expect(mockLocalEntries).toHaveBeenCalledWith('u1', yesterday);
  });

  it('keeps Log Food pinned to real today even while browsing a different day', async () => {
    // The decision recorded in the history entry: logging stays on real
    // today regardless of which day's stats are on screen, rather than
    // silently logging retroactively into a browsed day. `/food/add` with no
    // date param is what makes it default to today.
    render(<TodayScreen />);
    await screen.findByTestId('today-day');
    fireEvent.press(screen.getByTestId('today-day-prev'));

    fireEvent.press(await screen.findByTestId('today-log-food'));
    expect(mockPush).toHaveBeenCalledWith('/food/add');
  });
});

describe('offline', () => {
  it('renders and starts a session with every network read absent', async () => {
    // The board's three reads are SQLite. A screen that had grown a network
    // dependency for its primary block would fail here rather than on a phone
    // in a basement.
    mockListPlannedBetween.mockResolvedValue([
      { id: 'p1', day: todayKey(), sport: 'strength', workoutId: null, notes: '' },
    ]);
    render(<TodayScreen />);

    expect(await screen.findByTestId('today-plan-p1')).toBeTruthy();
    fireEvent.press(screen.getByTestId('up-next-log'));
    expect(mockPush).toHaveBeenCalledWith('/session/start?sport=strength');
  });
});
