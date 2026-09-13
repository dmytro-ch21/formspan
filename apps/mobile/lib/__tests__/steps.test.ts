/**
 * N569 (#1130) — the steps decisions and the local store, against a real
 * database.
 *
 * The native reads are the one part no test here can reach (see
 * `lib/healthkit.ts` / `lib/healthConnect.ts`). What CAN be pinned, and is the
 * point of the ticket, is what their answers MEAN: three states that must never
 * collapse into one — no source, refused, a genuine zero — plus the rule that a
 * failed read writes nothing.
 */

import { migratedFixture, type FixtureDb } from './support/sqlite';
import {
  localStepsView,
  onStepsChanged,
  platformStepSource,
  readStepsAsked,
  recordStepsOutcome,
  requestStepsRefresh,
  runStepsRead,
  setStepsRefresher,
  stepsFromHealthConnect,
  stepsFromHealthKit,
  stepsReadLabel,
  stepsWindow,
  STEPS_LOOKBACK_DAYS,
  STEPS_REFRESH_MIN_MS,
  writeStepsAsked,
  type StepsOutcome,
} from '../steps';

let mockFixture: FixtureDb;
jest.mock('../db', () => {
  const real = jest.requireActual('../db');
  return { ...real, getDb: async () => mockFixture };
});

const USER = 'u1';
const OTHER = 'u2';
/** 2:05pm on Thursday 10 September 2026, in the suite's Los Angeles zone. */
const NOW = new Date(2026, 8, 10, 14, 5, 0);
const TODAY = '2026-09-10';

beforeEach(async () => {
  mockFixture = await migratedFixture();
});

const rowCount = () => (mockFixture.raw.prepare('SELECT count(*) AS n FROM daily_steps').get() as { n: number }).n;

describe('stepsFromHealthKit — iOS never says no, so an empty today needs evidence to be zero', () => {
  it('a positive sum is the count, rounded', () => {
    expect(stepsFromHealthKit(8412.4, false)).toEqual({ kind: 'steps', steps: 8412 });
  });

  it('nothing today, with step samples shared this week: a genuine zero', () => {
    expect(stepsFromHealthKit(undefined, true)).toEqual({ kind: 'steps', steps: 0 });
    expect(stepsFromHealthKit(0, true)).toEqual({ kind: 'steps', steps: 0 });
  });

  it('nothing today, and nothing shared all week: refused — never zero', () => {
    // Exactly what HealthKit returns for a denied read.
    expect(stepsFromHealthKit(undefined, false)).toEqual({ kind: 'refused' });
    expect(stepsFromHealthKit(0, false)).toEqual({ kind: 'refused' });
    expect(stepsFromHealthKit(Number.NaN, false)).toEqual({ kind: 'refused' });
  });
});

describe('stepsFromHealthConnect — a refusal is thrown before this; an empty aggregate needs evidence too', () => {
  it('a positive total is the count', () => {
    expect(stepsFromHealthConnect(1200, false)).toEqual({ kind: 'steps', steps: 1200 });
  });

  it('zero today, with Steps records this week: a genuine zero', () => {
    expect(stepsFromHealthConnect(0, true)).toEqual({ kind: 'steps', steps: 0 });
  });

  it('zero today, and no app has recorded a step all week: no_data — not zero', () => {
    expect(stepsFromHealthConnect(0, false)).toEqual({ kind: 'no_data' });
    expect(stepsFromHealthConnect(null, false)).toEqual({ kind: 'no_data' });
  });
});

describe('runStepsRead — the order the answers depend on, and the three states', () => {
  const read = jest.fn((_w: unknown): Promise<StepsOutcome> => Promise.resolve({ kind: 'steps', steps: 0 }));
  const deps = (over: Partial<Parameters<typeof runStepsRead>[2]> = {}) => ({
    supported: () => true,
    enabled: async () => true,
    read,
    now: () => NOW,
    ...over,
  });

  beforeEach(() => read.mockClear());

  it('no step source on this phone: "no_source", nothing read, no row', async () => {
    expect(await runStepsRead(USER, 'healthkit', deps({ supported: () => false }))).toBe('no_source');
    expect(await localStepsView(USER, TODAY)).toEqual({
      state: 'no_source',
      source: null,
      checkedAt: NOW.toISOString(),
    });
    expect(read).not.toHaveBeenCalled();
    expect(rowCount()).toBe(0);
  });

  it('Health sync off: "off", nothing read', async () => {
    expect(await runStepsRead(USER, 'healthkit', deps({ enabled: async () => false }))).toBe('off');
    expect(read).not.toHaveBeenCalled();
  });

  it('never asked for steps: "not_asked", and the platform is never read', async () => {
    expect(await runStepsRead(USER, 'health_connect', deps())).toBe('not_asked');
    expect(await localStepsView(USER, TODAY)).toMatchObject({ state: 'not_asked', source: 'health_connect' });
    expect(read).not.toHaveBeenCalled();
  });

  it('asked, and refused: "refused" — no row, so nothing can be drawn as a number', async () => {
    await writeStepsAsked(USER);
    read.mockResolvedValueOnce({ kind: 'refused' });

    expect(await runStepsRead(USER, 'healthkit', deps())).toBe('refused');

    expect(await localStepsView(USER, TODAY)).toEqual({
      state: 'refused',
      source: 'healthkit',
      checkedAt: NOW.toISOString(),
    });
    expect(rowCount()).toBe(0);
  });

  it('asked, and a genuine zero: a row with 0 steps', async () => {
    await writeStepsAsked(USER);
    read.mockResolvedValueOnce({ kind: 'steps', steps: 0 });

    expect(await runStepsRead(USER, 'healthkit', deps())).toBe('read');

    expect(await localStepsView(USER, TODAY)).toEqual({
      state: 'read',
      today: { day: TODAY, steps: 0, source: 'healthkit', read_at: NOW.toISOString() },
      lastReadAt: NOW.toISOString(),
      source: 'healthkit',
    });
  });

  it('reads with today from local midnight, and the lookback before it', async () => {
    await writeStepsAsked(USER);
    await runStepsRead(USER, 'healthkit', deps());
    expect(read).toHaveBeenCalledWith({ ...stepsWindow(NOW), now: NOW });
  });

  it('a failed read writes NOTHING: the earlier count stands, and it is not turned into zero or a refusal', async () => {
    await writeStepsAsked(USER);
    read.mockResolvedValueOnce({ kind: 'steps', steps: 5000 });
    await runStepsRead(USER, 'healthkit', deps());

    read.mockRejectedValueOnce(new Error('native failure'));
    const later = new Date(2026, 8, 10, 18, 0, 0);
    expect(await runStepsRead(USER, 'healthkit', deps({ now: () => later }))).toBeNull();

    expect(await localStepsView(USER, TODAY)).toMatchObject({
      state: 'read',
      today: { steps: 5000, read_at: NOW.toISOString() },
      lastReadAt: NOW.toISOString(),
    });
  });

  it('a later read the same day replaces the count rather than adding a row', async () => {
    await writeStepsAsked(USER);
    read.mockResolvedValueOnce({ kind: 'steps', steps: 5000 });
    await runStepsRead(USER, 'healthkit', deps());
    read.mockResolvedValueOnce({ kind: 'steps', steps: 9100 });
    const later = new Date(2026, 8, 10, 18, 0, 0);
    await runStepsRead(USER, 'healthkit', deps({ now: () => later }));

    expect(rowCount()).toBe(1);
    expect(await localStepsView(USER, TODAY)).toMatchObject({ today: { steps: 9100, read_at: later.toISOString() } });
  });
});

describe('the store', () => {
  it('a refusal after a count keeps the row on disk but makes refusal the answer', async () => {
    await recordStepsOutcome(USER, 'healthkit', { kind: 'steps', steps: 5000 }, NOW);
    await recordStepsOutcome(USER, 'healthkit', { kind: 'refused' }, new Date(2026, 8, 10, 18, 0, 0));

    expect(rowCount()).toBe(1);
    expect((await localStepsView(USER, TODAY)).state).toBe('refused');
  });

  it('is scoped per athlete: another account on this phone reads unknown, never the first one\'s steps', async () => {
    await recordStepsOutcome(USER, 'healthkit', { kind: 'steps', steps: 8412 }, NOW);
    await writeStepsAsked(USER);

    expect(await localStepsView(OTHER, TODAY)).toEqual({ state: 'unknown' });
    expect(await readStepsAsked(OTHER)).toBe(false);
    expect(await readStepsAsked(USER)).toBe(true);
  });

  it('a count on another day is not today\'s row', async () => {
    await recordStepsOutcome(USER, 'healthkit', { kind: 'steps', steps: 11000 }, new Date(2026, 8, 9, 22, 0, 0));
    expect(await localStepsView(USER, TODAY)).toMatchObject({ state: 'read', today: null });
  });

  it('tells a subscriber after every write, and stops once unsubscribed', async () => {
    const heard = jest.fn();
    const off = onStepsChanged(heard);
    await recordStepsOutcome(USER, 'healthkit', { kind: 'steps', steps: 1 }, NOW);
    expect(heard).toHaveBeenCalledTimes(1);
    off();
    await recordStepsOutcome(USER, 'healthkit', { kind: 'refused' }, NOW);
    expect(heard).toHaveBeenCalledTimes(1);
  });
});

describe('the platform gate', () => {
  it('is HealthKit under this suite (jest-expo runs as iOS)', () => {
    // The gate that stops the Health Connect pass on an iPhone overwriting a
    // HealthKit reading with "no_source" — exercised end to end in
    // `healthConnectSync.test.ts`.
    expect(platformStepSource()).toBe('healthkit');
  });
});

describe('requestStepsRefresh', () => {
  afterEach(() => setStepsRefresher(null));

  it('does nothing when no orchestrator owns steps on this phone', () => {
    setStepsRefresher(null);
    expect(() => requestStepsRefresh(1_000_000_000)).not.toThrow();
  });

  it('asks at most once a minute', () => {
    const refresh = jest.fn();
    setStepsRefresher(refresh);
    const t = 2_000_000_000;
    requestStepsRefresh(t);
    requestStepsRefresh(t + STEPS_REFRESH_MIN_MS - 1);
    expect(refresh).toHaveBeenCalledTimes(1);
    requestStepsRefresh(t + STEPS_REFRESH_MIN_MS);
    expect(refresh).toHaveBeenCalledTimes(2);
  });
});

describe('copy and windows', () => {
  it('stepsWindow starts today at local midnight and looks back a week before it', () => {
    const { dayStart, lookbackStart } = stepsWindow(NOW);
    expect(dayStart).toEqual(new Date(2026, 8, 10, 0, 0, 0));
    expect(lookbackStart).toEqual(new Date(2026, 8, 10 - STEPS_LOOKBACK_DAYS, 0, 0, 0));
  });

  it('stepsReadLabel says when a count was read — a time today, a date and time otherwise', () => {
    expect(stepsReadLabel(NOW.toISOString(), new Date(2026, 8, 10, 21, 0, 0))).toBe('As of 14:05');
    expect(stepsReadLabel(new Date(2026, 8, 9, 22, 0, 0).toISOString(), NOW)).toBe('As of 9 Sep, 22:00');
  });
});
