import type { Session } from '../sessions';
import { restLine, weeklyDays } from '../trend';

/**
 * The strip under Recent, and the line on a day with nothing on it.
 *
 * The suite runs under `TZ=America/Los_Angeles`, which is load-bearing for
 * exactly ONE of the two bucketing errors: a Sunday-evening session placed by
 * its UTC date lands in the following week, and only a zone west of Greenwich
 * shows it. The mirror error — a Monday-morning session landing in the previous
 * week — needs a zone EAST of Greenwich, which a single-TZ suite structurally
 * cannot provide. The Monday case below is kept as documentation of the
 * intended behaviour, not as a guard; it passes against a UTC implementation
 * too. Review caught the header claiming otherwise.
 */

let n = 0;
function session(day: string, hour = 18): Session {
  n += 1;
  return {
    id: `s${n}`,
    user_id: 'u1',
    workout_id: null,
    sport: 'strength',
    name: '',
    started_at: new Date(`${day}T${String(hour).padStart(2, '0')}:00:00`).toISOString(),
    ended_at: null,
    notes: '',
    sets: [],
    created_at: '',
    updated_at: '',
  };
}

beforeEach(() => {
  n = 0;
});

// Wednesday 5 August 2026. Its week runs Mon 3 – Sun 9.
const NOW = new Date('2026-08-05T12:00:00');

describe('weeklyDays', () => {
  it('returns the asked-for number of weeks, oldest first, ending on now', () => {
    const w = weeklyDays([], NOW, 8);
    expect(w).toHaveLength(8);
    expect(w[7].start).toBe('2026-08-03');
    expect(w[0].start).toBe('2026-06-15');
    expect(w.map((x) => x.current)).toEqual([false, false, false, false, false, false, false, true]);
  });

  it('keeps empty weeks rather than closing the gap', () => {
    // A chart that cannot show a lay-off cannot show a comeback. Dropping the
    // blanks would draw a continuous history over a month somebody missed.
    // Five weeks, because that is how far back the data goes — see the window
    // test below.
    const w = weeklyDays([session('2026-07-08'), session('2026-08-04')], NOW, 8);
    expect(w.map((x) => x.days)).toEqual([1, 0, 0, 0, 1]);
    expect(w[0].start).toBe('2026-07-06');
  });

  describe('the window never runs past the data', () => {
    it('shortens to what is known rather than inventing empty weeks', () => {
      // The bug: a capped session read makes eight weeks out of six weeks of
      // rows by rendering the two oldest as zero — a fortnight off that never
      // happened, shown to the most consistent athletes first, because their
      // rows fill the cap fastest. Five honest bars beat eight with three
      // invented.
      const w = weeklyDays([session('2026-07-20')], NOW, 8);
      expect(w).toHaveLength(3);
      expect(w[0].start).toBe('2026-07-20');
    });

    it('still stops at the number asked for when the data runs deeper', () => {
      expect(weeklyDays([session('2025-01-01'), session('2026-08-04')], NOW, 4)).toHaveLength(4);
    });

    it('shows one week when everything is inside it', () => {
      expect(weeklyDays([session('2026-08-04')], NOW, 8)).toHaveLength(1);
    });

    it('shows the asked-for span when there is nothing at all', () => {
      // Nothing known is not the same as nothing to show: the caller hides the
      // strip entirely in that case, and collapsing to one bar here would make
      // the empty state depend on an arbitrary choice made in this function.
      expect(weeklyDays([], NOW, 8)).toHaveLength(8);
    });
  });

  it('counts days trained, not sessions', () => {
    // Two-a-days are normal in this sport; counting sessions makes a heavy
    // Tuesday look like a heavy week.
    const w = weeklyDays(
      [session('2026-08-04', 7), session('2026-08-04', 19), session('2026-08-05')],
      NOW,
      2,
    );
    expect(w[w.length - 1].days).toBe(2);
  });

  it('caps a week at seven', () => {
    const every = ['03', '04', '05', '06', '07', '08', '09'].map((d) => session(`2026-08-${d}`));
    expect(weeklyDays([...every, ...every], NOW, 1)[0].days).toBe(7);
  });

  it('ignores sessions older than the window', () => {
    expect(weeklyDays([session('2025-01-01')], NOW, 8).every((w) => w.days === 0)).toBe(true);
  });

  it('places a Sunday-evening session in its own week, not the next one', () => {
    // 21:00 Sunday in Los Angeles is already Monday in UTC. Bucketing on the
    // raw timestamp moves this bar one column right.
    const w = weeklyDays([session('2026-08-02', 21)], NOW, 2);
    expect(w.map((x) => x.days)).toEqual([1, 0]);
  });

  it('places a Monday-morning session in its own week, not the previous one', () => {
    // Documentation, not a guard — see the header. A UTC implementation passes
    // this too, because 06:00 Monday in Los Angeles is 13:00 Monday in UTC.
    const w = weeklyDays([session('2026-08-03', 6)], NOW, 2);
    expect(w.map((x) => x.days)).toEqual([1]);
  });

  it('is empty-safe', () => {
    expect(weeklyDays([], NOW, 1)).toEqual([{ start: '2026-08-03', days: 0, current: true }]);
  });
});

describe('restLine', () => {
  it('says the same thing all day and something else tomorrow', () => {
    const a = new Date('2026-08-05T06:00:00');
    const b = new Date('2026-08-05T23:00:00');
    expect(restLine(a)).toBe(restLine(b));
    expect(restLine(new Date('2026-08-06T06:00:00'))).not.toBe(restLine(a));
  });

  it('circulates rather than sticking, and comes back round', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 14; i++) {
      seen.add(restLine(new Date(2026, 7, 1 + i)));
    }
    // Every line reachable, not merely "more than one" — the weak version
    // passes against an implementation that alternates between two of five.
    expect(seen.size).toBe(5);
    expect(restLine(new Date(2026, 7, 1))).toBe(restLine(new Date(2026, 7, 6)));
  });

  it('never names the day, because the switcher decides which day this is', () => {
    // "Today looks like a rest day" shipped under a heading reading THU, AUG 6.
    for (let i = 0; i < 30; i++) {
      expect(restLine(new Date(2026, 7, 1 + i))).not.toMatch(/today|tomorrow|yesterday/i);
    }
  });

  it('never scolds or congratulates', () => {
    // The recorded UX direction rules out shame — but a cheerful "enjoy your
    // rest day!" aimed at someone injured is the same mistake wearing a smile.
    for (let i = 0; i < 30; i++) {
      const line = restLine(new Date(2026, 7, 1 + i));
      expect(line).not.toMatch(/!|enjoy|great|well done|earned|should|haven't|didn't/i);
    }
  });

  it('handles a pre-epoch date without going out of bounds', () => {
    expect(typeof restLine(new Date(1969, 5, 2))).toBe('string');
    expect(restLine(new Date(1969, 5, 2))).not.toBe(undefined);
  });
});
