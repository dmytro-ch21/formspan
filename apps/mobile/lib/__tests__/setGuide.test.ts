import { GRIPS, SET_TYPES } from '../sessions';
import { gripGuide, setTypeGuide } from '../setGuide';

/**
 * The info panel's copy — covered because it is *reachable data*, not prose.
 *
 * Two failures are worth catching here and neither is a typo:
 *
 *  1. **A new pill with no sentence behind it.** Adding a seventh grip to
 *     `GRIPS`, or a seventh set type, puts a pill on screen whose long press
 *     opens the "no description yet" fallback — the one string that exists for
 *     values this build has genuinely never seen. Every pill the app itself
 *     offers must have real copy, so the check is driven off `GRIPS` and
 *     `SET_TYPES` rather than off a list repeated here.
 *  2. **A partial lookup.** `offeredGrips` deliberately renders a grip from a
 *     newer server (#256), so the guide has to answer for a key that is not in
 *     any union. If that ever became a `Record` index without a fallback, the
 *     crash would land on a long press in a gym, not in CI.
 */

describe('setTypeGuide', () => {
  it('has real copy for every set type the app offers', () => {
    for (const t of SET_TYPES) {
      const entry = setTypeGuide(t.key);
      expect(entry.title).toBe(t.label);
      expect(entry.body).not.toMatch(/no description for it yet/);
      expect(entry.body.length).toBeGreaterThan(40);
    }
  });

  it('states the two behaviours that are not merely labels', () => {
    // Warm-up and drop are the only set types the code treats differently
    // (`contributesVolume` / `countsAsSet`), so they are the only two whose
    // copy is allowed to promise anything — and the only two that must.
    expect(setTypeGuide('warmup').body).toMatch(/neither tonnage nor a set/);
    expect(setTypeGuide('drop').body).toMatch(/rather than counting as a set of its own/);
    // And the other half, which is the one athletes get wrong: it still counts
    // toward tonnage. Copy saying only "not a set" would read as "not logged".
    expect(setTypeGuide('drop').body).toMatch(/adds to your tonnage/);
  });
});

describe('gripGuide', () => {
  it('has real copy for every grip the app offers', () => {
    for (const g of GRIPS) {
      const entry = gripGuide(g.key);
      expect(entry.title).toBe(g.label);
      expect(entry.body).not.toMatch(/no description for it yet/);
      expect(entry.body.length).toBeGreaterThan(40);
    }
  });

  it('answers for a grip a newer server invented, without throwing', () => {
    const entry = gripGuide('sumo');
    // The raw key, because there is no label to look up — better than an empty
    // title on a panel the athlete deliberately opened.
    expect(entry.title).toBe('sumo');
    expect(entry.body).toMatch(/no description for it yet/);
  });

  it('says the unknown grip is recorded rather than broken', () => {
    // The failure this guards is tonal and it matters: the value IS held and
    // IS sent back correctly, so copy implying data loss would be a lie that
    // sends someone to re-enter a set that was fine.
    expect(gripGuide('sumo').body).toMatch(/Recorded on this set/);
  });
});
