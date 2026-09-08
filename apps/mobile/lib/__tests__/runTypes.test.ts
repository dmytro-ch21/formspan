import { ZONES } from '../hrZones';
import {
  RUN_GOALS,
  RUN_TYPES,
  runFocusOptions,
  runTypeById,
  runTypesForGoal,
  type RunGoalId,
} from '../runTypes';

/**
 * The run catalog's invariants — N534.
 *
 * This is authored content, so the tests worth having are the ones that catch
 * an EDIT going wrong rather than a function computing wrong: a duplicated id
 * after a copy-paste, a zone band typed backwards, a goal id that no longer
 * exists because N536 renamed one. None of those would throw; every one would
 * render a subtly wrong library.
 */

describe('the catalog itself', () => {
  it('is not empty', () => {
    // Guards every other test in this file. A `filter` that returned nothing
    // would satisfy "all entries are valid" vacuously, which is the shape this
    // repo's own "verify a check can fail" rule keeps finding.
    expect(RUN_TYPES.length).toBeGreaterThanOrEqual(8);
  });

  it('has no duplicate ids', () => {
    const ids = RUN_TYPES.map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('has no duplicate names either', () => {
    // Ids are what the code joins on; names are what the athlete reads. Two
    // rows reading "Tempo run" would be one bug wearing the other's clothes.
    const names = RUN_TYPES.map((r) => r.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it('gives every run a name, a purpose, a feel, a structure and a note', () => {
    for (const r of RUN_TYPES) {
      expect(r.name.length).toBeGreaterThan(0);
      expect(r.trains.length).toBeGreaterThan(0);
      // The feel is the half that works without a heart-rate strap — an entry
      // missing it is only usable by an athlete who already owns a watch.
      expect(r.effort.length).toBeGreaterThan(0);
      expect(r.structure.length).toBeGreaterThan(0);
      expect(r.note.length).toBeGreaterThan(0);
    }
  });
});

describe('zone bands', () => {
  it('names only zones that exist', () => {
    for (const r of RUN_TYPES) {
      for (const z of r.zones) {
        expect(ZONES).toContain(z);
      }
    }
  });

  it('is ordered low-to-high', () => {
    // A band typed `[4, 3]` renders as "Zones 4-3" and would sort and filter
    // as nonsense everywhere downstream.
    for (const r of RUN_TYPES) {
      expect(r.zones[0]).toBeLessThanOrEqual(r.zones[1]);
    }
  });
});

describe('durations', () => {
  it('are ordered and positive', () => {
    for (const r of RUN_TYPES) {
      expect(r.minutes[0]).toBeGreaterThan(0);
      expect(r.minutes[0]).toBeLessThanOrEqual(r.minutes[1]);
    }
  });
});

describe('goals', () => {
  it('only reference goals that exist', () => {
    const known = Object.keys(RUN_GOALS);
    for (const r of RUN_TYPES) {
      expect(r.goals.length).toBeGreaterThan(0);
      for (const g of r.goals) {
        expect(known).toContain(g);
      }
    }
  });

  it('leaves no goal with nothing to prescribe', () => {
    // The mirror of the test above, and the one that actually matters to
    // N536: a goal the picker offers but which no run type serves would give
    // an athlete an empty week. Checked in this direction because the forward
    // check passes happily while a goal sits unused.
    for (const goal of Object.keys(RUN_GOALS) as RunGoalId[]) {
      expect(runTypesForGoal(goal).length).toBeGreaterThan(0);
    }
  });
});

describe('heart rate is not a valid guide for every run', () => {
  it('flags the short-effort runs and only those', () => {
    // Load-bearing for N538 (the live trainer), not cosmetic: heart rate lags
    // effort by roughly 30 seconds, so a 15-second stride is finished before
    // the heart responds. A trainer that zone-coached these would read zone 2
    // during an all-out sprint and tell the athlete to speed up.
    const flagged = RUN_TYPES.filter((r) => r.hrUnreliable).map((r) => r.id);
    expect(flagged.sort()).toEqual(['sprints', 'strides']);
  });

  it('flags nothing whose work interval is long enough for heart rate to catch up', () => {
    // Stated as a property rather than a second hardcoded list, so adding a
    // long interval session with the flag copy-pasted on fails here.
    for (const r of RUN_TYPES) {
      if (r.hrUnreliable) expect(r.minutes[0]).toBeLessThanOrEqual(35);
    }
  });
});

describe('runFocusOptions', () => {
  it('offers every focus the catalog actually uses', () => {
    const offered = runFocusOptions().map((o) => o.key);
    const used = new Set(RUN_TYPES.map((r) => r.trains));
    expect(new Set(offered)).toEqual(used);
  });

  it('never offers a focus with no runs behind it', () => {
    // The reason it is derived rather than listed: a filter that yields an
    // empty list is worse than no filter, and this is the same "state that
    // cannot be constructed" rule `library.tsx`'s `showExtras` gate applies.
    for (const o of runFocusOptions()) {
      expect(RUN_TYPES.some((r) => r.trains === o.key)).toBe(true);
    }
  });

  it('lists each focus once', () => {
    const offered = runFocusOptions().map((o) => o.key);
    expect(offered.length).toBe(new Set(offered).size);
  });
});

describe('runTypeById', () => {
  it('finds a real one', () => {
    expect(runTypeById('tempo')?.name).toBe('Tempo run');
  });

  it('returns undefined rather than throwing for an unknown id', () => {
    // The route param case: a stale deep link must land on an honest "not
    // found", not crash the screen.
    expect(runTypeById('no-such-run')).toBeUndefined();
  });
});

describe('runTypesForGoal', () => {
  it('returns only runs that claim the goal', () => {
    for (const r of runTypesForGoal('marathon')) {
      expect(r.goals).toContain('marathon');
    }
  });

  it('preserves catalog order', () => {
    // Catalog order is easy-to-hard and deliberate; a goal's list read
    // alphabetically would put Sprints between Recovery run and Tempo run and
    // imply a progression that is not there.
    const ids = runTypesForGoal('marathon').map((r) => r.id);
    const catalogOrder = RUN_TYPES.filter((r) => r.goals.includes('marathon')).map((r) => r.id);
    expect(ids).toEqual(catalogOrder);
  });

  it('does not answer yes to everything', () => {
    // Guards against `includes` degenerating: a predicate that always returned
    // true would satisfy every other test in this describe block.
    expect(runTypesForGoal('marathon').length).toBeLessThan(RUN_TYPES.length);
  });
});
