import { readFileSync } from 'fs';
import { join } from 'path';

import { bandAngleFor, paletteFor, planIcon } from '../../components/PlanHero';
import { SEEDED_PLAN_IDS } from './seededPlans';

/**
 * The plan artwork, which is generated rather than authored.
 *
 * Worth pinning because "looks fine" is the only feedback this ever gets, and
 * the two ways it can be wrong are both silent: a palette that changes between
 * launches, and every plan landing on the same one.
 */

describe('the gradient a plan gets', () => {
  it('is the same every time, for the same plan', () => {
    // A random pick would shimmer between renders and make a screenshot taken
    // last week disagree with the app.
    expect(paletteFor('public-ppl-push')).toEqual(paletteFor('public-ppl-push'));
  });

  it('does not put every seeded plan on the same colour', () => {
    // The failure that makes the browse list harder to scan rather than
    // easier, and the one a glance at a single plan cannot reveal.
    const used = new Set(SEEDED_PLAN_IDS.map((id) => paletteFor(id).join()));
    expect(used.size).toBeGreaterThan(3);
  });

  it('always returns a real pair of colours', () => {
    for (const id of [...SEEDED_PLAN_IDS, '', 'x']) {
      const [a, b] = paletteFor(id);
      expect(a).toMatch(/^#[0-9a-f]{6}$/);
      expect(b).toMatch(/^#[0-9a-f]{6}$/);
    }
  });
});

describe('the two apps agree about a plan', () => {
  /**
   * Web holds its own copy of the palette and the hash.
   *
   * The property is narrow but real: a given plan must look the same on a
   * phone and on a laptop. These tiles are the first thing anyone would
   * screenshot, and two devices disagreeing about a plan's colour is the kind
   * of small wrongness nobody reports and everybody notices.
   *
   * Reads source text rather than importing web's module — jest here cannot
   * resolve web's `@/` alias. Brittle to renames BY DESIGN, and every
   * extractor throws rather than silently comparing nothing, which is the
   * lesson `searchParity.test.ts` records learning the hard way.
   */
  const MOBILE = join(__dirname, '../../components/PlanHero.tsx');
  const WEB = join(__dirname, '../../../web/src/components/PlanHero.tsx');

  function webPalettes(): string[][] {
    const src = readFileSync(WEB, 'utf8');
    const start = src.indexOf('const PALETTES');
    if (start === -1) throw new Error('web PlanHero has no PALETTES — renamed?');
    const end = src.indexOf('];', start);
    if (end === -1) throw new Error('could not find the end of web PALETTES');
    const rows = [...src.slice(start, end).matchAll(/\[\s*"(#[0-9a-f]{6})",\s*"(#[0-9a-f]{6})"\s*\]/g)];
    if (rows.length === 0) throw new Error('extracted no palettes from web');
    return rows.map((m) => [m[1], m[2]]);
  }

  /**
   * The one thing every test here leans on and none of them used to check.
   *
   * Both recomputations below hash the id with *this file's* arithmetic. If web
   * changed its hash and nothing compared the two, every assertion would keep
   * passing while the two apps painted different plans — the test would be
   * measuring the test.
   */
  it('hashes an id the same way', () => {
    const body = (path: string) => {
      const src = readFileSync(path, 'utf8');
      const start = src.indexOf('function hash(');
      if (start === -1) throw new Error(`no hash() in ${path} — renamed?`);
      const end = src.indexOf('\n}', start);
      if (end === -1) throw new Error(`could not find the end of hash() in ${path}`);
      return src.slice(start, end).replace(/\s+/g, ' ');
    };
    expect(body(WEB)).toBe(body(MOBILE));
  });

  it('uses the same palettes, in the same order', () => {
    // Order matters as much as membership: the hash indexes into this array,
    // so reordering one copy silently repaints every plan on that platform.
    // Guarded because a loop over an empty list asserts nothing at all.
    expect(SEEDED_PLAN_IDS.length).toBeGreaterThan(0);
    const mine = SEEDED_PLAN_IDS.map((id) => [...paletteFor(id)]);
    const theirs = webPalettes();
    for (const [i, id] of SEEDED_PLAN_IDS.entries()) {
      // Recompute web's choice with web's own array and the shared hash.
      const n = [...id].reduce((a, c) => (a * 31 + c.charCodeAt(0)) >>> 0, 0);
      expect({ id, colours: theirs[n % theirs.length] }).toEqual({ id, colours: mine[i] });
    }
  });

  /**
   * Web's angle formula, RUN rather than matched.
   *
   * The first version of this test matched web's source against a literal
   * regex and then asserted `bandAngleFor(x) === bandAngleFor(x)` — a
   * tautology. It pinned web's text and constrained mobile not at all, so the
   * obvious one-sided fix (mobile's `>>` → `>>>`) would have left it green
   * while seven of the seventeen seeded plans tilted differently on a phone
   * than on a laptop: a test certifying the exact property it could not see
   * break. Extracting the four constants AND the shift operator, then
   * recomputing, is what makes a one-sided edit go red.
   */
  function webAngleFor(id: string): number {
    const src = readFileSync(WEB, 'utf8');
    const m = src.match(
      /return (-?\d+) \+ \(\(hash\(id\) (>>>?) (\d+)\) % (\d+)\) \* (\d+);/,
    );
    if (!m) throw new Error('web bandAngleFor differs in shape or was renamed');
    const [, base, op, shift, mod, step] = m;
    const n = [...id].reduce((a, c) => (a * 31 + c.charCodeAt(0)) >>> 0, 0);
    const shifted = op === '>>>' ? n >>> Number(shift) : n >> Number(shift);
    return Number(base) + ((shifted % Number(mod)) * Number(step));
  }

  it('tilts the band the same way', () => {
    expect(SEEDED_PLAN_IDS.length).toBeGreaterThan(0);
    for (const id of SEEDED_PLAN_IDS) {
      expect({ id, angle: webAngleFor(id) }).toEqual({ id, angle: bandAngleFor(id) });
    }
  });
});

describe('the band angle', () => {
  it('stays inside the range the arithmetic reads as producing', () => {
    // The signed-shift bug this exists for: `>>` sent the seven seeded ids
    // whose hash exceeds 2^31 to a negative remainder, and one plan to -91° —
    // a near-vertical band, outside -44..44, that looked deliberate on screen.
    for (const id of [...SEEDED_PLAN_IDS, '', 'x', 'public-zzzzzzzzzzzzzzzzz']) {
      expect(bandAngleFor(id)).toBeGreaterThanOrEqual(-44);
      expect(bandAngleFor(id)).toBeLessThanOrEqual(44);
      expect((bandAngleFor(id) + 44) % 11).toBe(0);
    }
  });

  it('gives no two seeded plans the same tile', () => {
    // Palette OR angle may collide; both together is a duplicate tile, and two
    // identical tiles in a grid is what makes it unscannable. Six palettes and
    // nine angles clear the seeded seventeen — barely enough that adding plans
    // should re-run this rather than assume it.
    const tiles = SEEDED_PLAN_IDS.map((id) => `${paletteFor(id).join()}@${bandAngleFor(id)}`);
    expect(new Set(tiles).size).toBe(SEEDED_PLAN_IDS.length);
  });
});

describe('the glyph', () => {
  it('marks the two plans that are a different kind of session', () => {
    expect(planIcon('endurance')).toBe('heart');
    expect(planIcon('powerlifting')).toBe('weight');
  });

  it('falls back for everything else, including a plan with no goal', () => {
    expect(planIcon('hypertrophy')).toBe('workout');
    expect(planIcon('general')).toBe('workout');
    expect(planIcon(null)).toBe('workout');
  });
});
