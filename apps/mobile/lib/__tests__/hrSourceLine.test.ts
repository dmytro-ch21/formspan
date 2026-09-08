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

  it('health store only — names the platform, on both platforms', () => {
    expect(hrSourceSentence(m({ hr_direct_count: 0 }), null, 'Apple Health')).toBe('From Apple Health');
    expect(hrSourceSentence(m({}), null, 'Health Connect')).toBe('From Health Connect'); // pre-#976 server: field absent
  });

  it('all direct — names the monitor the phone remembers', () => {
    expect(hrSourceSentence(m({ hr_direct_count: 40 }), 'Amazfit GTR 4', 'Apple Health')).toBe('From your Amazfit GTR 4');
  });

  it('direct with gaps filled — says how many came from the health store', () => {
    expect(hrSourceSentence(m({ hr_direct_count: 37 }), 'Amazfit GTR 4', 'Apple Health')).toBe(
      'From your Amazfit GTR 4 · 3 readings from Apple Health filled gaps',
    );
    expect(hrSourceSentence(m({ sample_count: 2, hr_direct_count: 1 }), 'Polar H10', 'Health Connect')).toBe(
      'From your Polar H10 · 1 reading from Health Connect filled gaps',
    );
  });

  it('a monitor since forgotten still reads as a monitor, never as the health store', () => {
    expect(hrSourceSentence(m({ hr_direct_count: 40 }), null, 'Apple Health')).toBe('From your heart-rate monitor');
  });
});
