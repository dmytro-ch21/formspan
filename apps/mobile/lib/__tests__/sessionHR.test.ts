import { readFileSync } from 'fs';
import { join } from 'path';

import { migratedFixture, type FixtureDb } from './support/sqlite';
import { sessionMeta } from '../sessionSummary';
import { cacheSessionHR, hrSummaryEntry, readSessionHRSummaries } from '../sessionHR';
import type { SessionMetrics } from '../biometric';

/**
 * N547/#990 — the heart rate a session's SUMMARY line shows.
 *
 * The athlete: *"In summaries we need to show avg hr as well, vo2 max."*
 *
 * Two properties carry the whole feature. The line must show a real average
 * where one is known, and it must show NOTHING — never a zero — everywhere
 * else, which is the `hr_source: 'none'` discipline the rest of the biometric
 * code already keeps. A "0 bpm avg" on a mat session would read as a corpse
 * the same way a "0 sets" chip reads as an abandoned session.
 */

let mockFixture: FixtureDb;
jest.mock('../db', () => {
  const real = jest.requireActual('../db');
  return { ...real, getDb: async () => mockFixture };
});

const USER = 'user_hr';

function metrics(over: Partial<SessionMetrics> = {}): SessionMetrics {
  return {
    session_id: 'ses-1',
    avg_hr_bpm: 142,
    max_hr_bpm: 171,
    trimp: null,
    active_kcal: null,
    hr_max_bpm: null,
    hr_max_source: null,
    time_in_zones: {},
    hr_source: 'window',
    sample_count: 120,
    ...over,
  } as SessionMetrics;
}

beforeEach(async () => {
  mockFixture = await migratedFixture();
});

describe('hrSummaryEntry — what the line says', () => {
  it('states the average when there is one', () => {
    expect(hrSummaryEntry({ avgHRBPM: 142, maxHRBPM: 171, hrSource: 'window' })).toBe('142 bpm avg');
  });

  it('rounds rather than showing a fraction of a heartbeat', () => {
    expect(hrSummaryEntry({ avgHRBPM: 141.6, maxHRBPM: 171, hrSource: 'window' })).toBe('142 bpm avg');
  });

  it('says nothing at all when there is nothing to say', () => {
    // Each of these is a DIFFERENT absence and all three print the same
    // thing: nothing. Never "0 bpm", never a dash — `sessionMeta` filters
    // nulls, so an unknown measure simply does not appear on the line.
    expect(hrSummaryEntry(undefined)).toBeNull();
    expect(hrSummaryEntry({ avgHRBPM: null, maxHRBPM: null, hrSource: 'window' })).toBeNull();
    expect(hrSummaryEntry({ avgHRBPM: 142, maxHRBPM: 171, hrSource: 'none' })).toBeNull();
  });

  it("a 'none' source outranks a stale average", () => {
    // The one case worth stating on its own: the server downgrades a row to
    // `hr_source: 'none'` when it finds no samples, and a number left beside
    // that is not this session's heart rate.
    expect(hrSummaryEntry({ avgHRBPM: 99, maxHRBPM: 120, hrSource: 'none' })).toBeNull();
  });
});

describe('the cache, against the real table', () => {
  it('round-trips what a summary needs', async () => {
    await cacheSessionHR(USER, 'ses-1', metrics());
    const got = await readSessionHRSummaries(USER, ['ses-1']);
    expect(got.get('ses-1')).toEqual({ avgHRBPM: 142, maxHRBPM: 171, hrSource: 'window' });
  });

  it('reads a batch in one query, and omits what it has never seen', async () => {
    await cacheSessionHR(USER, 'a', metrics());
    await cacheSessionHR(USER, 'b', metrics({ avg_hr_bpm: 118 }));
    const got = await readSessionHRSummaries(USER, ['a', 'b', 'never-enriched']);
    expect([...got.keys()].sort()).toEqual(['a', 'b']);
    expect(got.get('b')?.avgHRBPM).toBe(118);
    // Absent, not a zero — the row simply omits the measure.
    expect(got.get('never-enriched')).toBeUndefined();
  });

  it('a later enrichment overwrites an earlier one', async () => {
    // Enrichment retries: W18's cadence re-asks a session that found nothing,
    // so the second answer has to win. A row stuck on the first attempt would
    // show "no heart rate" forever after the watch finally synced.
    await cacheSessionHR(USER, 'ses-1', metrics({ avg_hr_bpm: null, hr_source: 'none', sample_count: 0 }));
    expect(hrSummaryEntry((await readSessionHRSummaries(USER, ['ses-1'])).get('ses-1'))).toBeNull();

    await cacheSessionHR(USER, 'ses-1', metrics({ avg_hr_bpm: 137, hr_source: 'window' }));
    expect(hrSummaryEntry((await readSessionHRSummaries(USER, ['ses-1'])).get('ses-1'))).toBe(
      '137 bpm avg',
    );
  });

  it('never mixes athletes', async () => {
    await cacheSessionHR(USER, 'ses-1', metrics());
    expect((await readSessionHRSummaries('someone_else', ['ses-1'])).size).toBe(0);
  });

  it('an empty request asks the database nothing', async () => {
    expect((await readSessionHRSummaries(USER, [])).size).toBe(0);
  });
});

describe('sessionMeta carries it, on both surfaces', () => {
  const run: Parameters<typeof sessionMeta>[0] = {
    sport: 'running',
    sets: [],
    started_at: '2026-09-09T10:00:00.000Z',
    ended_at: '2026-09-09T10:32:00.000Z',
  };

  it('appends the average LAST, after what the session was', () => {
    const line = sessionMeta(run, 'metric', { avgHRBPM: 148, maxHRBPM: 176, hrSource: 'window' });
    expect(line[line.length - 1]).toBe('148 bpm avg');
    // Duration still leads: the first entries identify the session, and the
    // heart rate qualifies it. A reader scanning a list should not step over
    // a bpm to find the distance.
    expect(line[0]).toMatch(/32/);
  });

  it('changes nothing when heart rate is unknown', () => {
    expect(sessionMeta(run, 'metric')).toEqual(sessionMeta(run, 'metric', undefined));
    expect(sessionMeta(run, 'metric').some((p) => p.includes('bpm'))).toBe(false);
  });

  it('omits it for a session that was asked about and had none', () => {
    const line = sessionMeta(run, 'metric', { avgHRBPM: null, maxHRBPM: null, hrSource: 'none' });
    expect(line.some((p) => p.includes('bpm'))).toBe(false);
  });
});

describe('both summary surfaces read the same rule', () => {
  /**
   * The library tests prove the rule. They say nothing about whether the two
   * screens that draw a summary actually pass heart rate to it — and a
   * surface silently omitting it would look exactly like a session with no
   * heart rate. Asserted at the source, as `hrReportWiring.test.ts` does for
   * the HR screens and W25 does for the ring tint.
   */
  it.each([
    ['app/(tabs)/index.tsx', 'Today’s logged rows'],
    ['components/TrainingCalendar.tsx', 'the calendar’s day detail'],
  ])('%s passes the cached heart rate', (rel) => {
    const src = readFileSync(join(__dirname, '..', '..', rel), 'utf8');
    expect(src).toMatch(/sessionMeta\(s, units, hr\.get\(s\.id\)\)/);
  });

  it('neither surface reads the cache row by row', () => {
    // The cache exists so a LIST does not make one request per row.
    // Reintroducing that against SQLite would be the same mistake, quieter —
    // so both surfaces use the batched hook, not the raw reader.
    for (const rel of ['app/(tabs)/index.tsx', 'components/TrainingCalendar.tsx']) {
      const src = readFileSync(join(__dirname, '..', '..', rel), 'utf8');
      expect(src).toContain('useSessionHRSummaries');
      expect(src).not.toContain('readSessionHRSummaries');
    }
  });
});

describe('the cache cannot cost an enrichment', () => {
  it('takes the session id from the caller, not from the response', async () => {
    // The enrichment sweep's own tests stub `computeSessionMetrics` with only
    // the two fields they assert on — no `session_id`. Reading the id off the
    // response therefore wrote a NULL key and threw inside the sweep, taking
    // the ledger write with it. The id is the caller's to supply: it already
    // knows which session it asked about.
    await cacheSessionHR(USER, 'from-caller', {
      avg_hr_bpm: 150,
      max_hr_bpm: 180,
      hr_source: 'window',
    });
    expect((await readSessionHRSummaries(USER, ['from-caller'])).get('from-caller')?.avgHRBPM).toBe(
      150,
    );
  });

  it('accepts a partial metrics object with absent averages', async () => {
    await cacheSessionHR(USER, 'thin', { hr_source: 'none' } as never);
    const got = (await readSessionHRSummaries(USER, ['thin'])).get('thin');
    expect(got).toEqual({ avgHRBPM: null, maxHRBPM: null, hrSource: 'none' });
    expect(hrSummaryEntry(got)).toBeNull();
  });
});
