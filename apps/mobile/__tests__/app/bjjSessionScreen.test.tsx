import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';

import BjjSessionScreen from '../../app/bjj/session/[id]';
import type { SessionDetail } from '@/lib/bjjSession';
import {
  finishLocalSession,
  readLocalBjjDetail,
  readLocalSession,
  type LocalSession,
} from '@/lib/sessionStore';
import { dayString } from '@/lib/calendar';
import { addDays, fetchHistory, startOfWeek, today, type HistoryDay } from '@/lib/history';
import { fetchAccomplishments, type Accomplishment } from '@/lib/accomplishments';
import { playSound } from '@/lib/sounds';
import { getSessionMetrics, listBiometricSamples, type SessionMetrics } from '@/lib/biometric';

/**
 * Opening a BJJ session from Today crashed.
 *
 *   Rendered more hooks than during the previous render.
 *
 * A black screen and "Something went wrong" on every class in Recents — the
 * whole reason the reading half of BJJ logging exists, unreachable.
 *
 * The cause was one `useMemo` sitting BELOW the screen's two early returns
 * (`if (loading)` and `if (!session)`). React matches hooks positionally, so
 * the first render — which returns the spinner — called one fewer hook than
 * every render after the load resolved. Nothing about that is visible to the
 * typechecker: hook order is a runtime property.
 *
 * This test is the regression guard for the SCREEN. `react-hooks/rules-of-hooks`
 * (added to `apps/mobile` in the same change, because this app had no linter at
 * all) is the guard for the CLASS. Both matter: the lint rule catches the next
 * one before it runs, and this catches a version React reports at runtime that
 * a static rule cannot see — the transition itself.
 *
 * What makes it a real test rather than a smoke test is the TRANSITION. The
 * screen must render at least twice: once while loading, once with a session.
 * Asserting only on the settled state would pass against the broken code,
 * because by then the hook count is consistent again.
 */

// The house default for component tests in this suite — all three siblings set
// it, for the one-off cost of standing up the React Native module graph under
// jest-expo on a cold runner. Note it does NOT govern the `waitFor` calls below,
// which carry their own 1s budget; this measures at ~0.4s either way.
jest.setTimeout(30_000);

/*
 * TYPED, because a jest.mock factory is untyped and every one of these fields
 * was wrong before someone checked: `rpe` instead of `session_rpe` (so the RPE
 * stat silently rendered its `—` fallback), a `kind` outside the four legal
 * ones, tags with no `category` — which the "what happened live" section filters
 * on, so it could never have rendered — and neither required `gi` nor `dirty`.
 *
 * The two assertions passed regardless, which is the point: an untyped fixture
 * lets a test exercise fallback branches while reading as though it covers the
 * real ones. The `mock` prefix is what lets a jest.mock factory close over them.
 */
const mockSession: LocalSession = {
  id: 's1',
  user_id: 'u1',
  workout_id: null,
  sport: 'bjj',
  name: 'Gi class',
  intent: 'normal',
  started_at: '2026-08-04T18:00:00Z',
  ended_at: '2026-08-04T19:30:00Z',
  notes: '',
  sets: [],
  created_at: '2026-08-04T18:00:00Z',
  updated_at: '2026-08-04T19:30:00Z',
  dirty: false,
};

const mockDetail: SessionDetail = {
  kind: 'class',
  gi: true,
  rounds: 5,
  round_minutes: 5,
  session_rpe: 7,
  academy: '',
  note: '',
  body_note: '',
  tags: [
    { category: 'pass', event: 'drilled', position: 'Guard - Top', technique_id: 'knee-cut-pass', count: 1 },
    { category: 'pass', event: 'scored', position: 'Guard - Top', technique_id: 'knee-cut-pass', count: 2 },
  ],
};

// Resolve on a later tick. This DOCUMENTS the loading-then-loaded shape rather
// than creating it: `load()` is an async function, so its setState calls can
// never land in the initial synchronous render whatever the mocks return —
// measured, the test still fails against the broken screen with plain
// `Promise.resolve`. The two-render transition is structural. Keep the delay for
// legibility; do not rely on it as the guard.
const deferred = <T,>(value: T) => new Promise<T>((r) => setTimeout(() => r(value), 0));

jest.mock('@/lib/sessionStore', () => ({
  readLocalSession: jest.fn(() => deferred(mockSession)),
  readLocalBjjDetail: jest.fn(() => deferred(mockDetail)),
  saveLocalBjjDetail: jest.fn(async () => {}),
  renameLocalSession: jest.fn(async () => true),
  deleteLocalSession: jest.fn(async () => {}),
  finishLocalSession: jest.fn(async () => {}),
}));

jest.mock('@/lib/bjjSession', () => ({
  ...jest.requireActual('@/lib/bjjSession'),
  getDetail: jest.fn(() => deferred(mockDetail)),
}));

/*
 * The share card's server-side numbers, stubbed.
 *
 * Not for isolation — the hook already swallows a failure, because calories and
 * the VOLA score decorate a card that is complete without them. For
 * DETERMINISM: unmocked, mounting the finished-class test fires a real `fetch`
 * at `/v1/sessions/s1/card`, and on the machines this repo is developed on
 * there is usually an API listening on :8080. A component test that quietly
 * talks to whatever is running locally passes or fails for reasons that have
 * nothing to do with the code under test.
 */
jest.mock('@/lib/sessionCardApi', () => ({
  getSessionCard: jest.fn(() => new Promise(() => {})),
}));

jest.mock('@/lib/techniques', () => ({
  fetchTechniques: jest.fn(() =>
    deferred([
      {
        id: 'knee-cut-pass',
        name: 'Knee Cut Pass',
        aliases: [],
        category: 'Pass',
        position: 'Guard - Top',
        position_detail: '',
        gi_no_gi: 'Both',
        typical_belt: '',
        ibjjf_ruleset_id: '',
        setup_from: [],
      },
    ]),
  ),
}));

// NOTE: `useAuthToken` and `@clerk/clerk-expo` are deliberately NOT mocked here.
// jest.setup.js already provides them, and its token getter is identity-STABLE
// on purpose — its own comment explains that an unstable one turns any effect
// depending on it into an infinite refetch loop, "which was three live bugs".
// A local `useAuthToken: () => async () => 'token'` returns a fresh arrow per
// render and reproduces exactly that: measured at 17 refetches in one test.

/*
 * The history the streak and the milestone are both computed from.
 *
 * `requireActual` for everything else on purpose: `weekStreak`,
 * `carriedTheStreak`, `startOfWeek` and `milestoneForSession` are the logic
 * under test here, and stubbing any of them would leave this asserting that a
 * mock returns what it was told to.
 */
jest.mock('@/lib/history', () => ({
  ...jest.requireActual('@/lib/history'),
  fetchHistory: jest.fn(),
}));

// Sound and haptics reach native modules the celebration fires on mount.
jest.mock('@/lib/sounds', () => ({ playSound: jest.fn(), primeSounds: jest.fn() }));

/*
 * The accomplishments lookup (#284). Mocked to resolve empty by default so the
 * milestone tests below are not silently competing with a badge; the chime
 * tests override it.
 */
jest.mock('@/lib/accomplishments', () => ({
  ...jest.requireActual('@/lib/accomplishments'),
  fetchAccomplishments: jest.fn(async () => []),
}));
jest.mock('expo-haptics', () => ({
  notificationAsync: jest.fn(async () => {}),
  impactAsync: jest.fn(async () => {}),
  NotificationFeedbackType: { Success: 'success' },
  ImpactFeedbackStyle: { Light: 'light', Medium: 'medium' },
}));

/*
 * The finish control, reduced to a press.
 *
 * The hold gesture, its timing and its confirm dialog have their own suite
 * (`components/__tests__/holdToConfirm.test.tsx`), so re-driving them here
 * would test that component twice and this screen once. What this file is
 * about is what happens AFTER the confirmation.
 */
jest.mock('@/components/HoldToConfirm', () => {
  /*
    `require`, not `import`, and the disable is not laziness: `jest.mock` factories
    are hoisted above the import block, so a module referenced by an ESM import is
    not initialised when the factory runs. The sibling `expo-router` mock below
    does the same thing for the same reason. Scoped to these two lines so the
    rule keeps working everywhere else — this app holds a warning ratchet, and a
    new warning fails the gate rather than quietly raising it.
  */
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const React = require('react');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { Pressable, Text } = require('react-native');
  return {
    HoldToConfirm: ({
      label,
      onConfirm,
      testID,
    }: {
      label: string;
      onConfirm: () => void;
      testID?: string;
    }) =>
      React.createElement(
        Pressable,
        { onPress: onConfirm, testID },
        React.createElement(Text, null, label),
      ),
  };
});

jest.mock('@/lib/sync', () => ({
  request: jest.fn(),
  syncNow: jest.fn(async () => {}),
  useSyncState: () => ({
    syncing: false, pending: 0, deferred: 0, lastSyncAt: null, lastError: null, online: true,
  }),
}));

// N491/#852: the HR timeline's own fetch. Defaults match this file's
// existing (unmocked-until-now) real behaviour under jest — no network, so
// `getSessionMetrics` settles to `null` and there is nothing for a timeline
// to draw — so every pre-existing test in this file is unaffected. Individual
// tests below override `listBiometricSamples` to prove the wiring.
jest.mock('@/lib/biometric', () => ({
  getSessionMetrics: jest.fn(async () => null),
  listBiometricSamples: jest.fn(async () => []),
}));

jest.mock('expo-router', () => {
  const React = require('react');
  const { Text } = require('react-native');
  return {
    useFocusEffect: (cb: () => void) => React.useEffect(() => cb(), [cb]),
    useLocalSearchParams: () => ({ id: 's1' }),
    useRouter: () => ({ push: jest.fn(), back: jest.fn(), replace: jest.fn() }),
    Link: ({ children }: { children: React.ReactNode }) => React.createElement(Text, null, children),
    Stack: { Screen: () => null },
  };
});

it('renders through the loading transition without changing its hook count', async () => {
  // Render one throws if a hook count changes between renders, which is the
  // whole bug: the loading render returns before the memo, every later render
  // reaches it.
  render(<BjjSessionScreen />);

  // The loading branch is what renders first, and it must — see `deferred`.
  expect(screen.getByLabelText('Loading your session')).toBeTruthy();

  // ...and then the loaded branch, which is the render that used to throw.
  await waitFor(() => {
    expect(screen.getByText('Gi class')).toBeTruthy();
  });
});

it('shows the session it loaded, not an empty shell', async () => {
  // Guards the fix being "made the crash go away" rather than "made the screen
  // work" — an early `return null` would satisfy the test above.
  render(<BjjSessionScreen />);

  await waitFor(() => {
    expect(screen.getByText('Gi class')).toBeTruthy();
  });
  // The technique row comes from the hoisted useMemo specifically. If that memo
  // were dropped rather than moved, this is what would go missing.
  expect(screen.getByText('Knee Cut Pass')).toBeTruthy();
});

/**
 * N119/#508: a technique kept unmatched from dictation must still be
 * visible on the read view — "the athlete can see it was not recognised" —
 * even though it never joins `techniqueRows` above (no catalog id to join
 * on). Without a section of its own it would be saved, synced, and
 * invisible here, which is the same defect this ticket exists to fix,
 * recreated on the one screen an athlete reads a session back from.
 */
it('shows a technique the library never matched, distinctly from a named one', async () => {
  (readLocalBjjDetail as jest.Mock).mockImplementationOnce(() =>
    deferred({
      ...mockDetail,
      tags: [
        ...mockDetail.tags,
        {
          category: 'submission',
          event: 'scored',
          position: '',
          technique_id: null,
          count: 2,
          label: 'pool guards',
        },
      ],
    }),
  );

  render(<BjjSessionScreen />);

  await waitFor(() => {
    expect(screen.getByText('Gi class')).toBeTruthy();
  });

  // The matched technique still renders where it always did.
  expect(screen.getByText('Knee Cut Pass')).toBeTruthy();
  // And the unmatched one renders separately, quoted and with its own
  // count — never merged into a technique chip it has no id to join.
  expect(screen.getByText('“pool guards” ×2')).toBeTruthy();
  expect(screen.getByText('Said, not matched to the library')).toBeTruthy();
  // Its count must not ALSO leak into "What happened live"'s category
  // totals — the labelled tag is category submission/scored, which would
  // otherwise be exactly what feeds that grid's "Submissions" row. This
  // screen's `live` filter has to move in step with the wizard's own grid
  // (`bump()`/`tagCount()` in `app/bjj/reflect/[id].tsx` and
  // `lib/bjjSession.ts`, which never let a labelled tag reach it either) —
  // otherwise the same evidence would be counted once here and again above,
  // with nothing to explain the discrepancy against the wizard.
  expect(screen.queryByText('What happened live')).toBeNull();
});

/*
 * Sharing a class you logged, rather than only one you just finished.
 *
 * The card used to exist for exactly as long as the completion modal did —
 * dismiss it and a class became unshareable forever, which is most of a class's
 * life. That is invisible from the logging side and only shows up when somebody
 * opens Tuesday's session wanting to post it.
 *
 * The two assertions are a PAIR and neither is worth much alone: presence alone
 * passes against a button rendered unconditionally (which would offer to share a
 * class still in progress, with no `ended_at` to date the card from), and absence
 * alone passes against a button that was never built. Both are keyed on the same
 * `session.ended_at` the screen gates on.
 */
it('offers the share card on a class that has finished', async () => {
  render(<BjjSessionScreen />);

  await waitFor(() => {
    expect(screen.getByTestId('bjj-session-share')).toBeTruthy();
  });
});

it('offers no share card while the class is still open', async () => {
  (readLocalSession as jest.Mock).mockImplementation(() =>
    deferred({ ...mockSession, ended_at: null }),
  );

  render(<BjjSessionScreen />);

  await waitFor(() => {
    expect(screen.getByText('Gi class')).toBeTruthy();
  });
  // Present on the same screen, so this is not asserting against an unrendered
  // one: the finish control is what stands where Share stands afterwards.
  expect(screen.getByTestId('bjj-session-finish')).toBeTruthy();
  expect(screen.queryByTestId('bjj-session-share')).toBeNull();
});

/**
 * N491/#852's wiring: the screen fetches raw HR samples for the session's own
 * window (a second, independent call from the existing `getSessionMetrics`
 * one) and hands them to `<HRSessionReport>` as an already-built timeline —
 * `lib/__tests__/hrTimeline.test.ts` proves the shaping itself; this proves
 * the screen actually calls the right endpoint with the right window and
 * wires the result through, rather than only being true in the pure-logic
 * layer.
 */
describe('the HR timeline (N491/#852)', () => {
  afterEach(() => {
    (getSessionMetrics as jest.Mock).mockClear();
    (listBiometricSamples as jest.Mock).mockClear();
  });

  function fullMetrics(overrides: Partial<SessionMetrics> = {}): SessionMetrics {
    return {
      session_id: 's1',
      avg_hr_bpm: 140,
      max_hr_bpm: 172,
      trimp: 88,
      active_kcal: null,
      hr_max_bpm: 190,
      hr_max_source: 'estimated',
      time_in_zones: { '3': 30, '4': 10 },
      hr_source: 'window',
      sample_count: 40,
      computed_at: mockSession.ended_at as string,
      rule_version: 1,
      ...overrides,
    };
  }

  it('fetches heart_rate samples for exactly the session window and renders a timeline once there are enough', async () => {
    (getSessionMetrics as jest.Mock).mockResolvedValueOnce(fullMetrics());
    const samples = Array.from({ length: 40 }, (_, i) => ({
      id: `hr-${i}`,
      metric_type: 'heart_rate',
      source: 'apple_watch',
      source_platform: 'healthkit',
      value: 90 + i,
      unit: 'count/min',
      measured_at: new Date(new Date(mockSession.started_at).getTime() + i * 60_000).toISOString(),
    }));
    (listBiometricSamples as jest.Mock).mockResolvedValueOnce(samples);

    render(<BjjSessionScreen />);

    await waitFor(() => {
      expect(screen.getByTestId('bjj-session-hr-timeline')).toBeTruthy();
    });
    expect(listBiometricSamples).toHaveBeenCalledWith(
      expect.any(Function),
      'heart_rate',
      mockSession.started_at,
      mockSession.ended_at,
    );
  });

  it('renders no timeline when the raw-sample fetch comes back too sparse, even though metrics were full', async () => {
    (getSessionMetrics as jest.Mock).mockResolvedValueOnce(fullMetrics());
    (listBiometricSamples as jest.Mock).mockResolvedValueOnce([
      {
        id: 'hr-1',
        metric_type: 'heart_rate',
        source: 'apple_watch',
        source_platform: 'healthkit',
        value: 130,
        unit: 'count/min',
        measured_at: mockSession.started_at,
      },
    ]);

    render(<BjjSessionScreen />);

    await waitFor(() => {
      expect(screen.getByTestId('bjj-session-hr')).toBeTruthy();
    });
    expect(screen.queryByTestId('bjj-session-hr-timeline')).toBeNull();
  });

  it('renders no timeline when the raw-sample fetch fails, without breaking the rest of the report', async () => {
    (getSessionMetrics as jest.Mock).mockResolvedValueOnce(fullMetrics());
    (listBiometricSamples as jest.Mock).mockRejectedValueOnce(new Error('network'));

    render(<BjjSessionScreen />);

    await waitFor(() => {
      expect(screen.getByTestId('bjj-session-hr-stats')).toBeTruthy();
    });
    expect(screen.queryByTestId('bjj-session-hr-timeline')).toBeNull();
  });
});

/*
 * N487/#848: the live-session Finish path, which had no way to carry a real
 * end time at all before this ticket — `finishLocalSession(userId, id)`, no
 * third argument, always "now". The two tests below are the wiring: the
 * arithmetic for what an offset chip computes has its own suite
 * (`components/__tests__/endTimeCorrection.test.tsx`); this is about whether
 * `finishNow` actually reads the athlete's choice.
 */
describe('finishing with a corrected end time', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date(2026, 7, 20, 21, 30, 0)); // 21:30 local
    (readLocalSession as jest.Mock).mockImplementation(() =>
      deferred({
        ...mockSession,
        // N492: SAME day as the fake clock above, deliberately — this
        // describe block is the same-day case, and the backdated case has
        // its own describe block below. Before N492 the day never mattered
        // (the fallback was unconditional `undefined`), so this fixture
        // could get away with a `started_at` on a different day than the
        // fake clock — it just happened to still assert `undefined`. Once
        // the fallback started reading the day, that mismatch would have
        // made this test fail for the wrong reason: not "the fast path
        // broke" but "this was never the fast path".
        started_at: new Date(2026, 7, 20, 19, 0, 0).toISOString(),
        ended_at: null,
      }),
    );
    (finishLocalSession as jest.Mock).mockClear();
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  it('leaves the fast path alone: no correction opened, ended_at is real now', async () => {
    render(<BjjSessionScreen />);
    const finish = await screen.findByTestId('bjj-session-finish');
    fireEvent.press(finish);

    await waitFor(() => expect(finishLocalSession).toHaveBeenCalledTimes(1));
    // `undefined` — the session started TODAY, so `finishTimestampFor`
    // itself returns `undefined` (see `lib/calendar.ts`) and
    // `finishLocalSession` stamps real "now". Byte-identical outcome to
    // before N492 touched this file, for the case N492 doesn't change.
    expect(finishLocalSession).toHaveBeenCalledWith('u1', 's1', undefined);
  });

  it('sends the corrected end time when the athlete sets one before finishing', async () => {
    render(<BjjSessionScreen />);
    await screen.findByTestId('bjj-session-finish');
    // Read the fake clock back rather than trusting the literal set in
    // `beforeEach`: `findByTestId` above polls under fake timers, which
    // (correctly — see `waitFor`'s own fake-timer support) advances them by
    // its poll interval while it waits for the session to finish loading.
    // The screen's own `now()` capture below reads whatever the clock says
    // AT THAT MOMENT, so the assertion has to start from the same place.
    const openedAt = new Date();

    fireEvent.press(screen.getByTestId('bjj-session-finish-end-time-row'));
    fireEvent.press(screen.getByTestId('bjj-session-finish-end-time-offset-120'));

    fireEvent.press(screen.getByTestId('bjj-session-finish'));

    await waitFor(() => expect(finishLocalSession).toHaveBeenCalledTimes(1));
    expect(finishLocalSession).toHaveBeenCalledWith(
      'u1',
      's1',
      new Date(openedAt.getTime() - 120 * 60_000).toISOString(),
    );
  });
});

/*
 * N492: the fast path above only proves the SAME-DAY case — `mockSession`'s
 * `started_at` and the fake clock both sit on 2026-08-04. That is exactly the
 * case that hid this bug: `finishNow` used to pass `undefined` unconditionally
 * whenever no correction was opened, which happens to be correct on a same-day
 * finish and wrong on a backdated one, so nothing above would have caught it.
 *
 * This is the N434 bug, on this screen. A session rescheduled to a past day
 * (the month-grid sheet earlier in this file, `commitReschedule`) and then
 * finished today with no correction must still get `ended_at` on ITS day, not
 * the real day it was closed out — otherwise the elapsed Stat, `history`'s
 * totals and the reflection screen all read a multi-day "duration" for a
 * session that took minutes. `finishTimestampFor` (`lib/calendar.ts`) is the
 * same mapping the strength screen's own finish handler already applies; this
 * is the wiring test proving the BJJ screen now uses it too.
 */
describe('finishing a session backdated to a past day', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    // Real "now" is Thursday the 27th real time — three days after the
    // session's own (backdated) Monday.
    jest.setSystemTime(new Date(2026, 7, 27, 20, 3, 0));
    (readLocalSession as jest.Mock).mockImplementation(() =>
      deferred({
        ...mockSession,
        started_at: new Date(2026, 7, 24, 19, 45, 0).toISOString(), // Monday
        ended_at: null,
      }),
    );
    (finishLocalSession as jest.Mock).mockClear();
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  it("lands ended_at on the session's own day, not the real day it was finished", async () => {
    render(<BjjSessionScreen />);
    const finish = await screen.findByTestId('bjj-session-finish');
    fireEvent.press(finish);

    await waitFor(() => expect(finishLocalSession).toHaveBeenCalledTimes(1));

    const [userArg, idArg, endedAt] = (finishLocalSession as jest.Mock).mock.calls[0];
    expect(userArg).toBe('u1');
    expect(idArg).toBe('s1');
    // Not `undefined` — that was the bug: real "now" reaching the backend
    // three days after the session it belongs to.
    expect(endedAt).toBeDefined();
    expect(dayString(new Date(endedAt))).toBe('2026-08-24');
  });
});

/*
 * A milestone reached on the mat.
 *
 * This is a WIRING test, and it exists because wiring is the one class the
 * lib suite structurally cannot see. `lib/milestones.ts` was correct and fully
 * covered while this screen — the one a BJJ+strength athlete most often opens
 * the week from — never computed a milestone at all. Every lib test stayed
 * green through it; review found it by enumerating callers.
 *
 * The stakes are why it matters here rather than only on the strength screen:
 * `milestoneForSession` fires ONLY on the session that carried the streak, so
 * a rung the mat carries and this screen drops is not delayed to the next
 * session, it is lost for that week entirely.
 */

/** `n` consecutive trained weeks ending in the current one. */
function historyWithStreak(n: number, sessionsThisWeek: number) {
  const thisMonday = startOfWeek(today());
  const days: HistoryDay[] = [];
  for (let i = 0; i < n; i++) {
    days.push({
      date: addDays(thisMonday, -i * 7),
      sessions: i === 0 ? sessionsThisWeek : 1,
      working_sets: 0,
      total_reps: 0,
      tonnage_kg: 0,
      duration_seconds: 3600,
      sports: ['bjj'],
    });
  }
  return {
    from: days[days.length - 1].date,
    to: today(),
    totals: emptyTotals(),
    previous: emptyTotals(),
    days,
    sports: [{ sport: 'bjj', sessions: n }],
  };
}

const emptyTotals = () => ({
  sessions: 0,
  working_sets: 0,
  total_reps: 0,
  tonnage_kg: 0,
  duration_seconds: 0,
  exercises: 0,
  active_days: 0,
});

/** Finish the class, which is what opens the celebration card. */
async function finishTheClass() {
  (readLocalSession as jest.Mock).mockImplementation(() =>
    deferred({ ...mockSession, ended_at: null }),
  );
  render(<BjjSessionScreen />);
  const finish = await screen.findByTestId('bjj-session-finish');
  fireEvent.press(finish);
}

it('shows the rung when the class on the mat is what carried the streak', async () => {
  // Four consecutive weeks, and exactly ONE session in the current one — which
  // is what `carriedTheStreak` reads to decide that THIS session carried it.
  (fetchHistory as jest.Mock).mockResolvedValue(historyWithStreak(4, 1));

  await finishTheClass();

  await waitFor(() => {
    expect(screen.getByTestId('celebration-milestone')).toBeTruthy();
  });
  // The rung itself, not merely a block: a test keyed on the testID alone
  // would pass against a milestone for the wrong number of weeks.
  expect(screen.getByText('A month, unbroken')).toBeTruthy();
});

it('shows no rung for the week’s later classes', async () => {
  // Same four-week streak, but the current week already held a session before
  // this one — so this class is training, not a milestone. Without this the
  // card would open on every class for the rest of the week.
  (fetchHistory as jest.Mock).mockResolvedValue(historyWithStreak(4, 2));

  await finishTheClass();

  // The card itself must still appear, or this passes for the wrong reason —
  // a screen that never celebrated at all would also show no milestone.
  await waitFor(() => {
    expect(screen.getByTestId('session-celebration')).toBeTruthy();
  });
  expect(screen.queryByTestId('celebration-milestone')).toBeNull();
});

it('shows no rung on a week that reaches no rung', async () => {
  // Three weeks is not a month. Guards against a block that renders whenever
  // there is any streak at all.
  (fetchHistory as jest.Mock).mockResolvedValue(historyWithStreak(3, 1));

  await finishTheClass();

  await waitFor(() => {
    expect(screen.getByTestId('session-celebration')).toBeTruthy();
  });
  expect(screen.queryByTestId('celebration-milestone')).toBeNull();
});


/*
 * The chime ladder, where #284 and #276 meet.
 *
 * Three things can fire one sound on this card and only one may: a streak
 * MILESTONE, a BJJ FIRST, and the ordinary weekly streak, in that order. The
 * middle rung is new — before #284 a BJJ card had no badge at all — and the
 * rule that a first "takes the personal record's slot" existed only in prose
 * plus a comment. Nothing failed when the wiring was wrong: passing the
 * records-only flag instead of "earned a badge of either kind" left every test
 * green while a BJJ first chimed nothing.
 *
 * These assert the SOUND, because the sound is the whole subject — the badge
 * renders either way.
 */

const aFirst: Accomplishment = {
  kind: 'first_submission_win',
  basis: 'reported',
  achieved_on: null,
  contest_id: null,
  contest_name: null,
  placement: null,
  entrants: null,
  session_id: 's1',
  technique_id: null,
  technique_name: null,
};

/** The chime is deliberately delayed ~1.1s so it lands off `sessionComplete`. */
async function soundsAfterTheChimeDelay() {
  await act(async () => {
    jest.advanceTimersByTime(1500);
  });
  return (playSound as jest.Mock).mock.calls.map(([name]) => name);
}

describe('one sound per session', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    (playSound as jest.Mock).mockClear();
  });
  afterEach(() => {
    jest.useRealTimers();
    (fetchAccomplishments as jest.Mock).mockImplementation(async () => []);
  });

  it('chimes the first when the mat earns one', async () => {
    (fetchAccomplishments as jest.Mock).mockResolvedValue([aFirst]);
    (fetchHistory as jest.Mock).mockResolvedValue(historyWithStreak(2, 1));

    await finishTheClass();
    await waitFor(() => expect(screen.getByTestId('celebration-badge')).toBeTruthy());

    // `pr`, the rare-thing sound a first shares with a personal record — and
    // NOT `streak`, which is what fires if the badge fails to latch it out.
    expect(await soundsAfterTheChimeDelay()).toContain('pr');
  });

  it('lets a milestone outrank a first earned in the same class', async () => {
    (fetchAccomplishments as jest.Mock).mockResolvedValue([aFirst]);
    (fetchHistory as jest.Mock).mockResolvedValue(historyWithStreak(4, 1));

    await finishTheClass();
    await waitFor(() => expect(screen.getByTestId('celebration-milestone')).toBeTruthy());

    const played = await soundsAfterTheChimeDelay();
    expect(played).toContain('success');
    // The rung is rarer than the first, so the first stands down — the whole
    // point of the shared latch, and the half a wrong flag would invert.
    expect(played).not.toContain('pr');
  });
});

afterEach(() => {
  // Restored rather than left mutated — jest.mock's factory closes over
  // `mockSession` once, so an override leaks into every test after it.
  (readLocalSession as jest.Mock).mockImplementation(() => deferred(mockSession));
});
