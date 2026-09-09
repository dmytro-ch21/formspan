import {
  ZONE_FLOORS,
  ZONES,
  zoneBandBpmLabel,
  zoneBpmLabel,
  zoneBpmRanges,
  zoneForBPM,
} from '../hrZones';

/**
 * The zone vocabulary — N534's labels and N535's beats.
 *
 * ## The load-bearing test is the round trip, not the examples
 *
 * `zoneBpmRanges` prints a range and `zoneForBPM` classifies against the same
 * floors, and the ONE failure that matters here is those two disagreeing: a
 * screen saying "zone 3 starts at 152" while the classifier calls 152 zone 2.
 * A boundary off by one beat is invisible in every screenshot and in every
 * hand-written example that happens to sit in the middle of a band, so the
 * round-trip test below walks every printed boundary through the classifier
 * rather than asserting a list of numbers somebody typed.
 *
 * Mutation-verified (N535): changing a `Math.ceil` to `Math.round`, and
 * shifting one `ZONE_FLOORS` entry by 0.01, each turn this file red.
 */

describe('zoneForBPM — the same floors as the backend', () => {
  it('50/60/70/80/90 % of HRmax, inclusive floors', () => {
    expect(zoneForBPM(99, 200)).toBe(0);
    expect(zoneForBPM(100, 200)).toBe(1);
    expect(zoneForBPM(120, 200)).toBe(2);
    expect(zoneForBPM(140, 200)).toBe(3);
    expect(zoneForBPM(160, 200)).toBe(4);
    expect(zoneForBPM(180, 200)).toBe(5);
    expect(zoneForBPM(210, 200)).toBe(5);
  });

  it('no HRmax, or nothing to classify, is zone 0 — the number renders without a colour', () => {
    expect(zoneForBPM(150, null)).toBe(0);
    expect(zoneForBPM(150, undefined)).toBe(0);
    expect(zoneForBPM(150, 0)).toBe(0);
    expect(zoneForBPM(0, 200)).toBe(0);
  });

  it('mirrors ZONE_FLOORS rather than restating it', () => {
    // The consolidation N535 performed: this used to be a hardcoded ladder in
    // `hrMonitor/heartRateProfile.ts`. If it ever stops deriving from the
    // array, an edit to the array will silently stop moving the classifier.
    const hrMax = 200;
    ZONE_FLOORS.forEach((floor, i) => {
      expect(zoneForBPM(floor * hrMax, hrMax)).toBe(i + 1);
    });
  });
});

describe('zoneBpmRanges — what the athlete actually reads', () => {
  it('every printed boundary classifies into the zone it is printed under', () => {
    // The round trip. Swept across HRmaxes that land on and off whole beats,
    // because the rounding only misbehaves for some of them: 200 divides
    // every floor exactly, 191 divides none of them.
    for (const hrMax of [200, 191, 187, 173, 165, 154, 143, 201, 249, 100]) {
      for (const r of zoneBpmRanges(hrMax)) {
        expect({ hrMax, zone: r.zone, at: r.from, got: zoneForBPM(r.from, hrMax) }).toEqual({
          hrMax,
          zone: r.zone,
          at: r.from,
          got: r.zone,
        });
        // One beat below a floor belongs to the zone underneath — which for
        // zone 1 means outside the scored zones altogether.
        expect(zoneForBPM(r.from - 1, hrMax)).toBe(r.zone - 1);
        if (r.to !== null) {
          expect(zoneForBPM(r.to, hrMax)).toBe(r.zone);
        }
      }
    }
  });

  it('bands are contiguous with no gap and no overlap', () => {
    const ranges = zoneBpmRanges(187);
    for (let i = 0; i < ranges.length - 1; i += 1) {
      expect(ranges[i].to).toBe(ranges[i + 1].from - 1);
    }
  });

  it('zone 5 has no ceiling — a bpm above HRmax is still zone 5, not out of range', () => {
    const ranges = zoneBpmRanges(190);
    expect(ranges[4].to).toBeNull();
    expect(zoneForBPM(220, 190)).toBe(5);
  });

  it('covers exactly the five zones, in order', () => {
    expect(zoneBpmRanges(190).map((r) => r.zone)).toEqual([...ZONES]);
  });
});

describe('the labels', () => {
  it('reads as a range, and open-ended at the top', () => {
    const ranges = zoneBpmRanges(190);
    expect(zoneBpmLabel(ranges[0])).toBe('95-113 bpm');
    expect(zoneBpmLabel(ranges[4])).toBe('171+ bpm');
  });

  it('a band spans the low zone floor to the high zone ceiling', () => {
    // A tempo run's "Zones 3-4" against a 190 HRmax.
    expect(zoneBandBpmLabel(3, 4, 190)).toBe('133-170 bpm');
  });

  it('a band reaching zone 5 is open-ended, never capped at HRmax', () => {
    // Sprints are "Zones 4-5". Capping at 190 would tell an athlete who saw
    // 194 that they left the zone, which the classifier does not agree with.
    expect(zoneBandBpmLabel(4, 5, 190)).toBe('152+ bpm');
  });

  it('a single-zone band still reads as a range', () => {
    expect(zoneBandBpmLabel(2, 2, 190)).toBe('114-132 bpm');
  });
});
