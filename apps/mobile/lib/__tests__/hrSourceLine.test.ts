import { hrPathName } from '../hrPath';
import { hrSourceSentence } from '../hrMonitor/hrSourceLine';

/** N528/#958 — the report's one line about where its numbers came from. */

const m = (over: { hr_source?: 'window' | 'workout' | 'none'; sample_count?: number; hr_direct_count?: number }) => ({
  hr_source: 'window' as const,
  sample_count: 40,
  ...over,
});

describe('hrSourceSentence', () => {
  it('nothing to say without data', () => {
    expect(hrSourceSentence(null, 'Amazfit GTR 4', 'Apple Health')).toBeNull();
    expect(hrSourceSentence(m({ hr_source: 'none', sample_count: 0 }), 'Amazfit GTR 4', 'Apple Health')).toBeNull();
  });

  it('health store only — names the PATH and the platform, on both platforms', () => {
    expect(hrSourceSentence(m({ hr_direct_count: 0 }), null, 'Apple Health')).toBe('From Apple Health afterwards');
    expect(hrSourceSentence(m({}), null, 'Health Connect')).toBe('From Health Connect afterwards'); // pre-#976 server: field absent
  });

  it('all direct — names the live path and the monitor the phone remembers', () => {
    expect(hrSourceSentence(m({ hr_direct_count: 40 }), 'Amazfit GTR 4', 'Apple Health')).toBe(
      'Live over Bluetooth, from your Amazfit GTR 4',
    );
  });

  it('direct with gaps filled — says how many came from the health store', () => {
    expect(hrSourceSentence(m({ hr_direct_count: 37 }), 'Amazfit GTR 4', 'Apple Health')).toBe(
      'Live over Bluetooth, from your Amazfit GTR 4 · 3 readings from Apple Health filled gaps',
    );
    expect(hrSourceSentence(m({ sample_count: 2, hr_direct_count: 1 }), 'Polar H10', 'Health Connect')).toBe(
      'Live over Bluetooth, from your Polar H10 · 1 reading from Health Connect filled gaps',
    );
  });

  it('a monitor since forgotten still reads as a monitor, never as the health store', () => {
    expect(hrSourceSentence(m({ hr_direct_count: 40 }), null, 'Apple Health')).toBe(
      'Live over Bluetooth, from your heart-rate monitor',
    );
  });

  /**
   * N552/#1021 — the report and Settings must call a path the same thing.
   *
   * Asserted against `hrPathName` rather than against a literal on purpose:
   * the failure this guards is DRIFT (someone rewords the Settings copy and
   * the report keeps the old words, so the athlete cannot connect "you're on
   * From Apple Health afterwards" to the line on their own session). A
   * literal here would pass happily through exactly that.
   */
  it('uses the same path names Settings uses', () => {
    for (const label of ['Apple Health', 'Health Connect']) {
      expect(hrSourceSentence(m({ hr_direct_count: 0 }), null, label)).toBe(hrPathName('health', label));
      expect(hrSourceSentence(m({ hr_direct_count: 40 }), 'Polar H10', label)).toContain(hrPathName('live', label));
    }
  });
});
