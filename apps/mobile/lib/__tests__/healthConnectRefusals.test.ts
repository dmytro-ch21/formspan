/**
 * N527/#949 — what the Settings line under the Health Connect toggle may name,
 * and the per-user store the sync pass writes it to. The store runs against
 * real SQLite (`support/sqlite.ts`), so "per user" is the `prefs` table's own
 * key, not a mock's.
 *
 * WHEN a pass writes (overwrite versus keep, per pass outcome) is pinned where
 * the pass lives: `healthConnectSync.test.ts`, "the pass records its answer".
 */
import { migratedFixture, type FixtureDb } from './support/sqlite';
import { healthConnectReadRecordTypes } from '../healthConnect';
import {
  TOGGLE_LINE_TYPES,
  onHealthConnectRefusalsChanged,
  readHealthConnectRefusals,
  recordHealthConnectPassRefusals,
  refusalLineCopy,
  refusalsForToggleLine,
} from '../healthConnectRefusals';
import { PREF_HEALTH_CONNECT_REFUSED, readPref, writePref } from '../prefs';

let mockFixture: FixtureDb;
jest.mock('../db', () => {
  const real = jest.requireActual('../db');
  return { ...real, getDb: async () => mockFixture };
});

const USER = 'user_hc_refused';
const ROUTE = 'To change it, open Health Connect, then App permissions, then VOLA.';

beforeEach(async () => {
  mockFixture = await migratedFixture();
});

describe('which refused types the line names', () => {
  it('names exactly the types the Health Connect toggle asks for — whatever that list is today', () => {
    // The toggle's request is `healthConnectReadRecordTypes(false)`. If a type
    // joins it, this goes red until the line has words for it; if one leaves,
    // the line stops being able to name it.
    expect([...TOGGLE_LINE_TYPES].sort()).toEqual([...healthConnectReadRecordTypes(false)].sort());
    expect(TOGGLE_LINE_TYPES).not.toContain('Steps');
  });

  it('drops Steps — the Steps row already reports that refusal, with its own Ask again', () => {
    expect(refusalsForToggleLine(['Steps', 'ExerciseSession'])).toEqual(['ExerciseSession']);
    expect(refusalsForToggleLine(['Steps'])).toEqual([]);
  });

  it('names each type once, in display order, whatever order the pass met them in', () => {
    expect(refusalsForToggleLine(['Vo2Max', 'HeartRate', 'Vo2Max', 'ExerciseSession'])).toEqual([
      'ExerciseSession',
      'HeartRate',
      'Vo2Max',
    ]);
  });

  it('ignores anything that is not a toggle type, so a malformed stored value names nothing', () => {
    expect(refusalsForToggleLine([42, null, 'toString', 'exercise', { recordType: 'HeartRate' }])).toEqual([]);
  });
});

describe('the line, in the athlete\'s words', () => {
  it('says nothing when nothing the toggle asks for was refused', () => {
    expect(refusalLineCopy([])).toBeNull();
  });

  it('one type: what is not shared, what it costs, and where to change it', () => {
    expect(refusalLineCopy(['ExerciseSession'])).toBe(
      `Health Connect isn't sharing exercise sessions with VOLA, so walks and hikes won't appear on Today. ${ROUTE}`,
    );
    expect(refusalLineCopy(['HeartRate'])).toBe(
      `Health Connect isn't sharing heart rate with VOLA, so sessions won't get heart-rate zones or load. ${ROUTE}`,
    );
    expect(refusalLineCopy(['Vo2Max'])).toBe(
      `Health Connect isn't sharing VO2max with VOLA, so your VO2max trend won't update. ${ROUTE}`,
    );
  });

  it('two types: one natural list, not one line per type', () => {
    expect(refusalLineCopy(['ExerciseSession', 'HeartRate'])).toBe(
      `Health Connect isn't sharing exercise sessions or heart rate with VOLA, so walks and hikes won't appear on Today, and sessions won't get heart-rate zones or load. ${ROUTE}`,
    );
  });

  it('three types: still one sentence', () => {
    expect(refusalLineCopy(['ExerciseSession', 'HeartRate', 'Vo2Max'])).toBe(
      `Health Connect isn't sharing exercise sessions, heart rate or VO2max with VOLA, so walks and hikes won't appear on Today, sessions won't get heart-rate zones or load, and your VO2max trend won't update. ${ROUTE}`,
    );
  });

  it('never shows an enum name', () => {
    const copy = refusalLineCopy(TOGGLE_LINE_TYPES) ?? '';
    expect(copy).not.toMatch(/ExerciseSession|HeartRate|Vo2Max|Steps/);
    expect(copy.length).toBeGreaterThan(0);
  });
});

describe('the store', () => {
  it('reads empty before any pass has recorded anything', async () => {
    expect(await readHealthConnectRefusals(USER)).toEqual([]);
  });

  it("stores the pass's own list and reads back what the line may name", async () => {
    await recordHealthConnectPassRefusals(USER, ['Steps', 'HeartRate']);

    // Stored as the pass returned it...
    expect(JSON.parse((await readPref(USER, PREF_HEALTH_CONNECT_REFUSED)) ?? 'null')).toEqual(['Steps', 'HeartRate']);
    // ...and filtered on the way out.
    expect(await readHealthConnectRefusals(USER)).toEqual(['HeartRate']);
  });

  it('a later record overwrites, including with an empty list', async () => {
    await recordHealthConnectPassRefusals(USER, ['ExerciseSession']);
    expect(await readHealthConnectRefusals(USER)).toEqual(['ExerciseSession']);

    await recordHealthConnectPassRefusals(USER, []);

    expect(await readHealthConnectRefusals(USER)).toEqual([]);
  });

  it('is per user: another account on the same phone never reads this one', async () => {
    await recordHealthConnectPassRefusals(USER, ['ExerciseSession']);

    expect(await readHealthConnectRefusals('somebody_else')).toEqual([]);
    expect(await readHealthConnectRefusals(USER)).toEqual(['ExerciseSession']);
  });

  it('a stored value that is not a JSON list reads as nothing to say', async () => {
    await writePref(USER, PREF_HEALTH_CONNECT_REFUSED, '{not json');
    expect(await readHealthConnectRefusals(USER)).toEqual([]);

    await writePref(USER, PREF_HEALTH_CONNECT_REFUSED, '"ExerciseSession"');
    expect(await readHealthConnectRefusals(USER)).toEqual([]);
  });

  it('tells a listener after every record, until it unsubscribes', async () => {
    const listener = jest.fn();
    const unsubscribe = onHealthConnectRefusalsChanged(listener);

    await recordHealthConnectPassRefusals(USER, ['Vo2Max']);
    expect(listener).toHaveBeenCalledTimes(1);

    unsubscribe();
    await recordHealthConnectPassRefusals(USER, []);
    expect(listener).toHaveBeenCalledTimes(1);
  });
});
