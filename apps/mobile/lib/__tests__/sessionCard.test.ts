import { MOUNTAIN_ORDER, mountainFor } from '../mountains';
import { headlineFor, type CardData } from '../sessionCard';

const card = (id: string, over: Partial<CardData> = {}): CardData => ({
  id,
  sport: 'strength',
  title: 'Lower — Squat & Hinge',
  eyebrow: 'STRENGTH',
  dateLabel: '9 AUG',
  stats: [],
  badges: [],
  ...over,
});

/** Realistic ids: the app generates UUIDs client-side for offline capture. */
function uuids(n: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < n; i++) {
    const hex = (x: number) => x.toString(16).padStart(8, '0');
    out.push(`${hex(i * 2654435761)}-1a2b-4c3d-8e5f-${hex(i * 40503)}${hex(i * 7919)}`);
  }
  return out;
}

describe('mountainFor', () => {
  // The whole reason it is a hash and not a counter: the same session must
  // render the same peak in the feed, on the completion screen, and in the
  // exported PNG — three places that never share anything but the id.
  it('is deterministic', () => {
    for (const id of uuids(50)) {
      expect(mountainFor(id)).toBe(mountainFor(id));
    }
  });

  // THE FAILURE THIS HASH EXISTS TO AVOID. `id.length % 8` gives every UUID
  // the same peak, because UUIDs are all the same length — a bug that looks
  // like "we only shipped one image" and passes any determinism test.
  it('spreads across every peak rather than clustering', () => {
    const seen = new Map<string, number>();
    for (const id of uuids(400)) {
      const m = mountainFor(id);
      seen.set(m, (seen.get(m) ?? 0) + 1);
    }
    expect(seen.size).toBe(MOUNTAIN_ORDER.length);
    // No peak may take more than a quarter of 400 ids. An even split is 12.5%;
    // a clustering hash would put 100% on one.
    for (const [name, count] of seen) {
      expect({ name, count }).toEqual({ name, count: expect.any(Number) });
      expect(count).toBeLessThan(100);
    }
  });

  it('only ever returns a peak that exists', () => {
    for (const id of uuids(100)) {
      expect(MOUNTAIN_ORDER).toContain(mountainFor(id));
    }
  });
});

describe('headlineFor', () => {
  it('says what actually happened when something did', () => {
    expect(headlineFor(card('a', { highlight: 'pr' }))).toContain('BEST');
    expect(headlineFor(card('a', { highlight: 'hardest' }))).toContain('HARDEST');
    expect(headlineFor(card('a', { highlight: 'streak' }))).toContain('GOING');
  });

  // An ordinary session gets an ordinary line. The praise has to be earned or
  // the card stops being read — the same argument as the accent being reserved
  // for PRs.
  it('does not claim a personal best for an ordinary session', () => {
    for (const id of uuids(60)) {
      const line = headlineFor(card(id));
      expect(line).not.toContain('BEST');
      expect(line).not.toContain('HARDEST');
    }
  });

  it('is deterministic, so re-opening does not reword the card', () => {
    for (const id of uuids(40)) {
      expect(headlineFor(card(id))).toBe(headlineFor(card(id)));
    }
  });

  // Different seeds, so the phrase and the picture do not correlate. Sharing a
  // seed would mean every "WORK DONE." card showed the same mountain, which is
  // the template look the rotation exists to prevent.
  it('does not correlate with the mountain', () => {
    const pairs = new Set<string>();
    for (const id of uuids(300)) {
      pairs.add(`${mountainFor(id)}|${headlineFor(card(id))}`);
    }
    // 8 peaks × 4 ordinary lines = 32 combinations. A shared seed collapses
    // this to 8 — one line per peak, every time.
    expect(pairs.size).toBeGreaterThan(20);
  });
});
