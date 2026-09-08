import { migratedFixture, type FixtureDb } from './support/sqlite';
import { forgetMonitor, parseRememberedMonitor, readRememberedMonitor, rememberMonitor } from '../hrMonitor/hrMonitorStore';

/** N528/#958 — the remembered monitor, through the real prefs table. */

let mockFixture: FixtureDb;
jest.mock('../db', () => {
  const real = jest.requireActual('../db');
  return { ...real, getDb: async () => mockFixture };
});

const USER = 'user_hr_store';

beforeEach(async () => {
  mockFixture = await migratedFixture();
});

describe('parseRememberedMonitor', () => {
  it('reads a well-formed value, defaults a blank name, and refuses anything malformed', () => {
    expect(parseRememberedMonitor('{"id":"abc","name":"Amazfit GTR 4","rememberedAt":"t"}')).toEqual({ id: 'abc', name: 'Amazfit GTR 4', rememberedAt: 't' });
    expect(parseRememberedMonitor('{"id":"abc","name":""}')).toMatchObject({ name: 'Heart-rate monitor' });
    expect(parseRememberedMonitor(null)).toBeNull();
    expect(parseRememberedMonitor('')).toBeNull();
    expect(parseRememberedMonitor('not json')).toBeNull();
    expect(parseRememberedMonitor('{"name":"no id"}')).toBeNull();
    expect(parseRememberedMonitor('{"id":"","name":"empty id"}')).toBeNull();
  });
});

describe('remember / read / forget', () => {
  it('round-trips per user and forgets cleanly', async () => {
    expect(await readRememberedMonitor(USER)).toBeNull();
    const now = new Date('2026-09-08T10:00:00.000Z');
    await rememberMonitor(USER, { id: 'dev-1', name: 'Amazfit GTR 4' }, now);
    expect(await readRememberedMonitor(USER)).toEqual({ id: 'dev-1', name: 'Amazfit GTR 4', rememberedAt: now.toISOString() });
    expect(await readRememberedMonitor('someone_else')).toBeNull();
    await forgetMonitor(USER);
    expect(await readRememberedMonitor(USER)).toBeNull();
  });
});
