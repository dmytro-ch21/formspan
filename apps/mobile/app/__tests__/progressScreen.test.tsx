import { configure, render, screen, waitFor, within } from '@testing-library/react-native';

import ProgressScreen from '../(tabs)/progress';
import type { ExerciseRecords } from '@/lib/records';
import type { Session } from '@/lib/sessions';

/**
 * The Progress tab: its ORDER, and its refusal to guess.
 *
 * Two properties are pinned here and both are structural rather than cosmetic.
 *
 * ## 1. Interpretation before raw data
 *
 * The ticket calls the section order a requirement "checkable by reading the
 * component tree, not just eyeballing a screenshot". `getAllByTestId` with a
 * regex returns matches in document order, so the whole hierarchy is one
 * assertion against a literal list — and a chart that drifted above the
 * sentence explaining it turns that list red.
 *
 * ## 2. Nothing on this screen may claim an absence it has not measured
 *
 * Every read here is history, and this codebase has three times shipped a
 * screen that rendered "you have nothing" during a fetch. The test for it is
 * the FIRST FRAME — with every promise still pending, no invitation to start
 * logging may be on screen anywhere. That is a vector a broken implementation
 * fails and a correct one passes; asserting the settled state proves nothing,
 * because both implementations agree once the data lands.
 *
 * The mocks are per-file and deliberately hand every read as a promise the test
 * controls, because "still pending" is the state under test and an
 * already-resolved default would make it unreachable.
 */

jest.setTimeout(30_000);
configure({ asyncUtilTimeout: 10_000 });

/** A promise plus its resolver, so a test can hold a read open. */
function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

let mockSessions = deferred<Session[]>();
let mockRecords = deferred<ExerciseRecords[]>();
let mockCheckins = deferred<unknown[]>();
let mockFoodDays = deferred<string[]>();
let mockPlanned = deferred<unknown[]>();

jest.mock('@/lib/sessionStore', () => ({
  listLocalSessions: () => mockSessions.promise,
  cachedExercises: () => Promise.resolve([{ id: 'back-squat', name: 'Back squat' }]),
}));
jest.mock('@/lib/plan', () => ({ listPlannedBetween: () => mockPlanned.promise }));
jest.mock('@/lib/foodLog', () => ({ localLoggedDays: () => mockFoodDays.promise }));
jest.mock('@/lib/records', () => ({
  ...jest.requireActual('@/lib/records'),
  fetchRecords: () => mockRecords.promise,
}));
jest.mock('@/lib/body', () => ({
  ...jest.requireActual('@/lib/body'),
  listCheckins: () => mockCheckins.promise,
}));
// `TrainingSummary` is rendered for real — the section-order assertion depends
// on its span control being in the tree — but its own two fetches are not what
// this file is about, so they never answer.
jest.mock('@/lib/history', () => ({
  ...jest.requireActual('@/lib/history'),
  fetchHistory: () => new Promise(() => {}),
}));

jest.mock('@/lib/sync', () => ({
  request: jest.fn(),
  syncNow: jest.fn(async () => {}),
  useSyncState: () => ({
    syncing: false,
    pending: 0,
    deferred: 0,
    lastSyncAt: null,
    lastError: null,
    online: true,
  }),
}));

// Mutable, because "the athlete's unit system is not known yet" is a state
// under test — see the imperial guard at the foot of this file.
let mockUnits: { units: string; unitsReady: boolean } = { units: 'metric', unitsReady: true };
jest.mock('@/lib/useUnits', () => ({
  useUnits: () => ({ ...mockUnits, foodUnit: 'g' }),
}));

const STRENGTH = {
  key: 'strength',
  label: 'Strength',
  is_sport: true,
  default_on: true,
  enabled: true,
  capabilities: {
    catalog: 'exercises',
    facets: [],
    has_goals: true,
    has_progression: true,
    has_food_log: false,
    record_kinds: ['heaviest_weight'],
  },
};
const bjj = (enabled: boolean) => ({
  key: 'bjj',
  label: 'BJJ',
  is_sport: true,
  default_on: true,
  enabled,
  capabilities: {
    catalog: 'techniques',
    facets: ['position', 'belt'],
    has_goals: false,
    has_progression: false,
    has_food_log: false,
    record_kinds: [],
  },
});
const nutrition = (enabled: boolean) => ({
  key: 'nutrition',
  label: 'Nutrition',
  is_sport: false,
  default_on: true,
  enabled,
  capabilities: {
    catalog: '',
    facets: [],
    has_goals: false,
    has_progression: false,
    has_food_log: true,
    record_kinds: [],
  },
});

// Mutable so a test can turn a discipline off. The factory is evaluated once,
// so the arrow has to READ the variable rather than close over its value.
let mockModules: unknown[] = [];
let mockModulesReady = true;
jest.mock('@/lib/ModulesProvider', () => ({
  useModules: () => ({ modules: mockModules, ready: mockModulesReady }),
}));

beforeEach(() => {
  mockSessions = deferred<Session[]>();
  mockRecords = deferred<ExerciseRecords[]>();
  mockCheckins = deferred<unknown[]>();
  mockFoodDays = deferred<string[]>();
  mockPlanned = deferred<unknown[]>();
  mockModules = [STRENGTH, bjj(true), nutrition(true)];
  mockModulesReady = true;
  mockUnits = { units: 'metric', unitsReady: true };
});

/**
 * Two smoothable clusters of weigh-ins, a week apart, for a today of
 * 2026-08-26.
 *
 * `trendWeight` averages readings whose age is 0–6 days, and needs at least
 * three — so BOTH ends have to be populated or the delta is null and no body
 * insight is drawn at all. The older cluster is placed against the far end
 * (2026-08-19), not against today: 2026-08-12 is exactly seven days from it and
 * falls outside the window, which is the mistake this comment exists to stop
 * somebody repeating.
 */
function weighIns() {
  const days = [
    '2026-08-14',
    '2026-08-15',
    '2026-08-16',
    '2026-08-24',
    '2026-08-25',
    '2026-08-26',
  ];
  // 80 kg for the older week, 79 kg for this one — a clear 1 kg fall.
  return days.map((measured_on, i) => ({
    measured_on,
    weight_kg: i < 3 ? 80 : 79,
  }));
}

/** Settle every read with something ordinary, so the screen reaches content. */
async function answerEverything() {
  mockSessions.resolve([]);
  mockRecords.resolve([]);
  mockCheckins.resolve([]);
  mockFoodDays.resolve([]);
  mockPlanned.resolve([]);
  await waitFor(() => expect(screen.getByTestId('records-state')).toBeTruthy());
}

describe('section order', () => {
  it('leads with This week and What changed, then the drill-downs', async () => {
    render(<ProgressScreen />);
    await answerEverything();

    // A literal list, in document order. Written out rather than derived from
    // anything the screen exports — a test that reads its expectation off the
    // implementation agrees with every implementation, including a reordered
    // one.
    expect(screen.getAllByTestId(/^progress-section-/).map((n) => n.props.testID)).toEqual([
      'progress-section-week',
      'progress-section-changed',
      'progress-section-training',
      'progress-section-body',
      'progress-section-nutrition',
      'progress-section-goals',
    ]);
  });

  it('puts the interpretation above the first chart', async () => {
    render(<ProgressScreen />);
    await answerEverything();

    // The narrower claim the ticket actually makes, asserted against the chart
    // itself rather than against the section wrapper: `training-span-1m` is a
    // control on `TrainingSummary`'s consistency grid, which is the first raw
    // chart on the screen.
    expect(
      screen
        .getAllByTestId(/^(progress-section-changed|training-span-1m)$/)
        .map((n) => n.props.testID),
    ).toEqual(['progress-section-changed', 'training-span-1m']);
  });
});

describe('the first frame, with every read still outstanding', () => {
  it('claims nothing about the athlete while nothing has answered', () => {
    render(<ProgressScreen />);

    // The three sentences this screen is allowed to say ONLY from an answer.
    // Each has shipped, on some screen, over a request in flight.
    expect(screen.queryByText(/Log a few sets and your bests show up here/)).toBeNull();
    expect(screen.queryByText(/Nothing logged this week yet/)).toBeNull();
    expect(screen.queryByText(/Nothing has moved much since last week/)).toBeNull();
    expect(screen.queryByTestId('what-changed-quiet')).toBeNull();

    // And it says which of them it is doing instead.
    expect(screen.getByLabelText('Looking for what changed')).toBeTruthy();
    expect(screen.getByLabelText('Loading your records')).toBeTruthy();
    expect(within(screen.getByTestId('progress-week-nutrition')).getByText('—')).toBeTruthy();
  });

  it('says a read failed rather than that there is nothing to show', async () => {
    render(<ProgressScreen />);
    mockSessions.reject(new Error('offline'));
    mockRecords.reject(new Error('offline'));
    mockCheckins.reject(new Error('offline'));
    mockFoodDays.reject(new Error('offline'));
    mockPlanned.reject(new Error('offline'));

    await waitFor(() =>
      expect(screen.getByText(/Couldn't load your records just now/)).toBeTruthy(),
    );
    expect(screen.getByText(/Couldn't load your week just now/)).toBeTruthy();
    expect(screen.getByTestId('what-changed-unavailable')).toBeTruthy();
    expect(
      within(screen.getByTestId('progress-week-nutrition')).getByText("Couldn't check"),
    ).toBeTruthy();

    // The failure must not have produced any of the empty-state copy.
    expect(screen.queryByText(/Log a few sets and your bests show up here/)).toBeNull();
    expect(screen.queryByTestId('what-changed-quiet')).toBeNull();
  });

  it('says nothing stands out only once every read has answered', async () => {
    render(<ProgressScreen />);
    await answerEverything();
    expect(screen.getByTestId('what-changed-quiet')).toBeTruthy();
  });
});

describe('what each athlete sees', () => {
  it('offers the position map to a grappler and explains its absence otherwise', async () => {
    render(<ProgressScreen />);
    await answerEverything();
    expect(screen.getByTestId('progress-bjj-positions')).toBeTruthy();
    expect(screen.queryByTestId('progress-bjj-off')).toBeNull();

    mockModules = [STRENGTH, bjj(false), nutrition(true)];
    screen.unmount();
    render(<ProgressScreen />);
    await answerEverything();
    // Not silence. An athlete cannot tell "turned off" from "not built" from
    // "broken", and this app has had that reported from a real phone.
    expect(screen.queryByTestId('progress-bjj-positions')).toBeNull();
    expect(screen.getByTestId('progress-bjj-off')).toHaveTextContent(/^BJJ is turned off,/);
  });

  it('draws no BJJ row and no BJJ explanation until the module list has answered', () => {
    mockModules = [];
    mockModulesReady = false;
    render(<ProgressScreen />);
    // An empty module list is an unanswered question, not a "no" — saying
    // "BJJ is turned off" here would be a claim about a setting nobody read.
    expect(screen.queryByTestId('progress-bjj-positions')).toBeNull();
    expect(screen.queryByTestId('progress-bjj-off')).toBeNull();
  });

  it('drops the food line for an athlete with nutrition off, and keeps the link', async () => {
    mockModules = [STRENGTH, bjj(true), nutrition(false)];
    render(<ProgressScreen />);
    await answerEverything();
    // No "0 of 3 days" about a feature this athlete does not use…
    expect(screen.queryByTestId('progress-week-nutrition')).toBeNull();
    // …and the way to the screen that explains it is still there. The
    // destination owns the off-state; hiding the link is what leaves the
    // athlete unable to reach the explanation.
    expect(screen.getByTestId('progress-nutrition')).toBeTruthy();
  });

  it('counts logged days against days elapsed, not against seven', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-08-26T12:00:00'));
    try {
      render(<ProgressScreen />);
      mockSessions.resolve([]);
      mockRecords.resolve([]);
      mockCheckins.resolve([]);
      // Monday and Wednesday of a week whose Wednesday is today.
      mockPlanned.resolve([]);
      mockFoodDays.resolve(['2026-08-24', '2026-08-26']);
      await waitFor(() =>
        expect(
          within(screen.getByTestId('progress-week-nutrition')).getByText('2 of 3 days'),
        ).toBeTruthy(),
      );
    } finally {
      jest.useRealTimers();
    }
  });
});

describe('what moved here from You', () => {
  it('renders the training summary and the records list', async () => {
    render(<ProgressScreen />);
    await answerEverything();
    // `training-span-1m` is TrainingSummary's span control; `records-manage`
    // is RecordsCard's "Choose". Both render unconditionally in their
    // components, so their presence here is the move having landed.
    expect(screen.getByTestId('training-span-1m')).toBeTruthy();
    expect(screen.getByTestId('records-manage')).toBeTruthy();
  });

  it('reaches the weight trend and the records screen', async () => {
    render(<ProgressScreen />);
    await answerEverything();
    expect(screen.getByTestId('progress-weight-trend')).toBeTruthy();
    expect(screen.getByTestId('records-manage')).toBeTruthy();
  });
});

/**
 * #483 — a weight printed in the wrong system, for one frame.
 *
 * Every sentence "What changed" can produce about the body contains a weight,
 * and there is no honest fallback: "1.0 kg" to an imperial athlete is wrong,
 * and a unit-less "1.0" is worse. So the read is `checking` until the athlete's
 * own system is known.
 *
 * The vector that separates a correct implementation from one that formats
 * with a default is `unitsReady: false` WITH the check-ins already answered —
 * a test that only ever runs with units ready cannot see the difference, and a
 * test with no check-ins would pass against either because there is nothing to
 * format.
 */
describe('the weight is never stated in a system nobody chose', () => {
  it('withholds the body insight until the unit system is known', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-08-26T12:00:00'));
    try {
      mockUnits = { units: 'metric', unitsReady: false };
      render(<ProgressScreen />);
      mockSessions.resolve([]);
      mockPlanned.resolve([]);
      mockRecords.resolve([]);
      mockFoodDays.resolve([]);
      mockCheckins.resolve(weighIns());

      await waitFor(() => expect(screen.getByTestId('records-state')).toBeTruthy());
      // Still looking, rather than a figure in kilograms.
      expect(screen.getByLabelText('Looking for what changed')).toBeTruthy();
      expect(screen.queryByTestId('what-changed-body')).toBeNull();
      expect(screen.queryByText(/kg/)).toBeNull();
    } finally {
      jest.useRealTimers();
    }
  });

  it('states it once the system is known, in that system', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-08-26T12:00:00'));
    try {
      mockUnits = { units: 'imperial', unitsReady: true };
      render(<ProgressScreen />);
      mockSessions.resolve([]);
      mockPlanned.resolve([]);
      mockRecords.resolve([]);
      mockFoodDays.resolve([]);
      mockCheckins.resolve(weighIns());

      // 1 kg is 2.2 lb. Pinned to the athlete's system rather than to the
      // storage unit, and to a literal rather than to a second call of the
      // formatter — which would agree with any formatter, right or wrong.
      const body = await screen.findByTestId('what-changed-body');
      expect(body).toHaveTextContent(/2\.2lb over 7 days, smoothed\./);
      expect(body).toHaveTextContent(/Your weight trend is falling/);
    } finally {
      jest.useRealTimers();
    }
  });
});
