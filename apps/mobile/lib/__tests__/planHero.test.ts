import { paletteFor, planIcon } from '../../components/PlanHero';
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
