/**
 * A glyph for a food, derived from its CATEGORY and nothing else.
 *
 * ## The failure this is shaped around
 *
 * A wrong glyph is worse than no glyph. A steak beside a tofu product is the
 * thing an athlete notices, and it quietly costs the whole list its
 * credibility — if one row is obviously wrong, none of them can be trusted at a
 * glance, which is the entire value of a glyph.
 *
 * So this is a **closed map over a curated vocabulary**, and deliberately NOT
 * keyword matching on the name. Keyword matching is the option that manufactures
 * exactly the failure above: "beef-flavoured tofu" contains "beef", "chicken-
 * style seitan" contains "chicken", and "butter beans" contain "butter". Every
 * one of those is a confident wrong answer produced by a rule that looks
 * sensible. A category map cannot produce one, because it never reads the name.
 *
 * ## Why a category map is enough
 *
 * The seeded catalog's 177 foods carry 18 categories, and they are curated
 * rather than free-form in practice. Measured: every seeded row has one, and
 * `foodGlyph.test.ts` fails if the seed grows a category this map does not
 * cover — so the map cannot silently fall behind the data.
 *
 * `category` is nevertheless a free-text column (`TEXT`, 1-40 chars, migration
 * `000062`) with no CHECK constraint, so an admin-authored food can carry
 * anything at all. That is precisely why the fallback is unconditional and
 * neutral rather than clever.
 *
 * ## Emoji rather than the brand icon set, and the cost of that
 *
 * Worth stating plainly, because it is a departure. This app's iconography is
 * `assets/brand/`'s SVG set, drawn with `currentColor` so it follows the accent
 * and the light/dark toggle. **Nothing in the app uses pictorial emoji today** —
 * the only glyphs in the UI are typographic (`✓`, `○`).
 *
 * Emoji are used here because the brand kit holds three food-ish icons against
 * eighteen categories, and commissioning fifteen more is `assets/brand/` work
 * rather than a screen task. The costs are real: emoji carry their own colour
 * and cannot follow the accent, and they render differently across OS versions.
 *
 * The mitigation is that this is the ONLY place any of it is decided. Swapping
 * to brand icons later is this file and nothing else.
 */

/**
 * The glyph for a food whose category this build does not recognise.
 *
 * A plate: it says "food" and claims nothing about which food. Every path that
 * cannot answer confidently lands here rather than guessing.
 */
export const NEUTRAL_GLYPH = '🍽️';

/**
 * Category → glyph, for the vocabulary the seeded catalog actually uses.
 *
 * Each entry names a CATEGORY, never a specific food, which is what keeps it
 * honest: `poultry` is a drumstick because every poultry row is poultry, and no
 * row in it can be contradicted by the picture. Where no category-level glyph
 * exists without implying a specific food — `plant_protein` covers tofu,
 * tempeh and seitan, none of which has an emoji — a deliberately generic one is
 * used rather than the nearest-looking food.
 */
const CATEGORY_GLYPHS: Record<string, string> = {
  vegetable: '🥦',
  fruit: '🍎',
  grain: '🌾',
  dairy: '🥛',
  nut_seed: '🥜',
  seafood: '🐟',
  condiment: '🧂',
  red_meat: '🥩',
  beverage: '🥤',
  sweet_snack: '🍫',
  poultry: '🍗',
  fat_oil: '🫒',
  legume: '🫘',
  pork: '🥓',
  // Tofu, tempeh, seitan. No emoji names any of them, and every near-miss is a
  // MEAT — which is the one substitution this feature must never make. A
  // sprout claims only "plant".
  plant_protein: '🌱',
  prepared: '🍱',
  supplement: '💊',
  egg: '🥚',
};

/** The categories this build knows. Exported so a test can pin the coverage. */
export const KNOWN_CATEGORIES = Object.keys(CATEGORY_GLYPHS);

/**
 * The glyph for a category.
 *
 * Case- and whitespace-insensitive, because the column is free text and a
 * stray `Vegetable` would otherwise degrade a whole category to neutral without
 * anything reporting it. Not fuzzy beyond that: an unrecognised category is
 * neutral, never a nearest match.
 */
export function glyphFor(category: string | null | undefined): string {
  if (!category) return NEUTRAL_GLYPH;
  return CATEGORY_GLYPHS[category.trim().toLowerCase()] ?? NEUTRAL_GLYPH;
}
