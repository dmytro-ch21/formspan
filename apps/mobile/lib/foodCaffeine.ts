/**
 * Food-to-caffeine, N468/#792.
 *
 * **Read `coffeeCaffeine.ts` first — this is its sibling, not a rewrite of
 * it.** That file already dual-writes a coffee TRACKER TAP to the caffeine
 * tracker with a cited mg figure. What did not exist anywhere in this app
 * before this ticket: a link from a food item LOGGED as food (searched and
 * added under a meal, e.g. "Latte" under Breakfast) to the caffeine tracker
 * at all. Confirmed before writing anything: no food/nutrition record in this
 * app — not the catalog, not a saved food, not an AI-drafted entry — carries
 * a caffeine figure today.
 *
 * ## The scoping question the ticket asks to answer explicitly, not skip
 *
 * Two real options for where a logged food item's caffeine figure comes from:
 *
 * - **A schema field** (`caffeine_mg` on the catalog, saved foods and the AI
 *   estimation prompt) — accurate, but backend schema work: a migration, a
 *   catalog back-fill, and a prompt change, none of which this ticket's other
 *   three pieces touch.
 * - **A name-matching heuristic** — ships with no backend change at all,
 *   using only what a logged `Entry` already carries (`name`, `servings`).
 *
 * **This file takes the heuristic**, for three reasons: it keeps this whole
 * ticket mobile-only, matching the issue's own framing that each of its four
 * pieces "can be built and shipped separately"; a schema field back-filled
 * for old catalog rows and AI drafts is real, separate backend work with its
 * own migration-numbering and content-pipeline concerns (`cmd/exportcontent`,
 * `scan-library.py`) that do not belong bundled into a mobile-first ticket;
 * and the heuristic's failure mode is the SAME one `coffeeCaffeine.ts`
 * already accepts for its own "other" bucket — a known, named
 * under-estimate rather than a silent, unbounded one. **This is a deliberate
 * v1, not a final answer** — a `caffeine_mg` field is the natural follow-up
 * once this proves the linkage is worth having, and nothing here forecloses
 * adding one later (a schema field would simply outrank this heuristic at
 * the call site, never invalidate it).
 *
 * ## What the heuristic gets wrong, named rather than hidden
 *
 * - **False positives**: a food NAMED after a caffeinated drink but not one —
 *   "coffee cake", "coffee ice cream" — matches the "coffee" keyword and
 *   would be counted. Not solved here; `decaf` is the one exclusion this
 *   file makes (Mayo's own table puts decaf at 1-2 mg, negligible against
 *   the rounding this file already does).
 * - **False negatives**: an unlisted brand, a homemade drink under its own
 *   name, or a category this file does not recognise (matcha, chocolate)
 *   contributes nothing — silently, exactly like `coffeeCaffeine.ts`'s
 *   `other` bucket, which "posts no invented number" for the identical
 *   reason. No figure is invented for a category this file cannot cite.
 * - **The servings scaling assumes a drink-count basis** (`caffeineMgForFoodEntry`
 *   multiplies the per-serving figure by `entry.servings`), which is right
 *   for "2 lattes" but wrong for a catalog/barcode row logged on a
 *   per-100g basis — a 330 ml energy drink logged as "3.3 servings of
 *   100 g" would post 3.3× its real caffeine, because `servings` there
 *   counts grams-of-hundred, not drinks. **frontend-reviewer, N468
 *   review** — not solved here (this file has no reliable way to tell a
 *   drink-count `serving_label` from a weight-basis one), named so the next
 *   reader does not assume the scaling is always right.
 *
 * ## Every mg figure is cited, not invented
 *
 * Espresso, brewed coffee and black tea reuse the EXACT figures
 * `coffeeCaffeine.ts` already cites (63 / 95 / 47 mg), from the same Mayo
 * Clinic source, so a reader comparing the two files never finds two
 * numbers for one drink. Energy drinks, energy shots and cola are new
 * categories this file adds — verified directly against a mirror of the
 * same Mayo Clinic article ("Caffeine content for coffee, tea, soda and
 * more") rather than carried over from memory: an energy drink averages 79
 * mg per 8 fl oz, an energy shot 200 mg per 2 fl oz, and cola 33 mg per 8 fl
 * oz. Treated the same way `coffeeCaffeine.ts` treats its own figures — a
 * reference for ONE serving as logged, not a measurement of any particular
 * can or cup.
 */

/** One keyword group: every phrase in `words` posts the same mg per serving. */
type FoodCaffeineGroup = {
  mgPerServing: number;
  /** Matched as a whole word/phrase — see `containsPhrase` below. */
  words: readonly string[];
};

/**
 * Checked in order; the FIRST matching group wins. Ordered most-specific
 * first: "energy shot" before the broader "energy drink", "espresso"
 * (63 mg) before the broader coffee family (95 mg) so an actual espresso
 * is not counted as a full brewed cup.
 */
const GROUPS: readonly FoodCaffeineGroup[] = [
  { mgPerServing: 200, words: ['energy shot', '5 hour energy', '5-hour energy'] },
  // frontend-reviewer, N468 review: a bare 'monster' matched "Monster
  // Burger" as readily as an actual energy drink — broader than any of
  // this group's other phrases need to be, and the easiest of the accepted
  // false positives to just not have. 'monster energy' alone still catches
  // the brand by name.
  { mgPerServing: 79, words: ['energy drink', 'red bull', 'monster energy'] },
  { mgPerServing: 63, words: ['espresso', 'macchiato', 'ristretto'] },
  {
    mgPerServing: 95,
    words: ['coffee', 'latte', 'cappuccino', 'americano', 'mocha', 'cold brew'],
  },
  { mgPerServing: 47, words: ['tea', 'chai'] },
  { mgPerServing: 33, words: ['cola', 'coke', 'pepsi'] },
];

/** Escapes a phrase for use inside a `RegExp`. */
function escapeForRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Whole-word/whole-phrase match, case-insensitive — "tea" does not match "steal". */
function containsPhrase(haystack: string, phrase: string): boolean {
  return new RegExp(`\\b${escapeForRegex(phrase)}\\b`, 'i').test(haystack);
}

/**
 * The reference mg for ONE serving of a food, from its name alone — or
 * `null` when nothing here recognises it. See the file header for what this
 * does and does not catch.
 */
export function caffeineMgForFoodName(name: string): number | null {
  const n = name.toLowerCase();
  // Mayo's own table puts decaf at 1-2 mg — negligible next to the whole-mg
  // rounding every figure here already does, and "decaf latte" would
  // otherwise match the coffee family at full strength.
  if (/\bdecaf(feinated)?\b/.test(n)) return null;
  for (const g of GROUPS) {
    if (g.words.some((w) => containsPhrase(n, w))) return g.mgPerServing;
  }
  return null;
}

/**
 * The mg a logged food ENTRY is worth — the per-serving figure above, scaled
 * by how many servings were actually logged, matching how every other macro
 * on an `Entry` already scales with `servings` (see `scale()`/`rescale()` in
 * `nutrition.ts`). Rounded to a whole mg, matching the whole-number figures
 * this file and `coffeeCaffeine.ts` both cite — a fraction of a milligram is
 * false precision for a name-matched estimate.
 *
 * `null` when the name is not recognised, or when `servings` is zero or
 * negative (nothing was actually logged to scale).
 */
export function caffeineMgForFoodEntry(entry: { name: string; servings: number }): number | null {
  if (entry.servings <= 0) return null;
  const per = caffeineMgForFoodName(entry.name);
  if (per == null) return null;
  return Math.round(per * entry.servings);
}

/**
 * The infix that marks a caffeine-tracker entry as ORIGINATING from a logged
 * food item — the "mark-origin-and-refuse-removal" half of this ticket's own
 * two named structural choices (see the ticket for the other, derive-at-
 * read-time). Chosen over deriving the caffeine total at read time because
 * every OTHER surface that renders a tracker (`TrackerCard`'s glyphs, bar,
 * `footLine`, the cutoff line, `targetCount`) already reads a real
 * `tracker_entries` row and none of them know how to merge in a value that
 * was never actually written — re-deriving would mean teaching every one of
 * those a second, virtual-row code path for the one tracker that has food
 * behind it. A real row, marked by its own id, reuses all of that for free
 * and reuses the exact dual-write/outbox mechanics `logCoffeeTap` already
 * has working and tested, one origin further.
 *
 * **Why a suffix with a fresh random tail, not a pure function of the food
 * entry's id** (unlike `coffeeCaffeine.ts`'s `pairedCaffeineEntryId`, which
 * IS a pure function of the coffee entry's id). `tracker_entries` has no
 * UPDATE path anywhere in this app — server and client both only ever
 * create or tombstone one (`LogEntry`'s own `ON CONFLICT (id) DO NOTHING`
 * means a second write under the same id would be silently ignored by the
 * server, leaving the client showing a number the server never has). So
 * editing a food item whose caffeine figure changes (a different name, a
 * different serving count) cannot reuse one deterministic id across edits —
 * it has to tombstone the old row and mint a genuinely new one. The infix is
 * what lets a caller find "whichever caffeine entry a food entry currently
 * has, if any" (`id LIKE '<foodEntryId>-fcaf-%'`, see `trackers.ts`'s
 * `findLiveFoodCaffeineEntry`) without needing to have remembered it.
 */
export const FOOD_CAFFEINE_ID_INFIX = '-fcaf-';

/**
 * How much of the tail survives — **frontend-reviewer, N468 review**: this
 * used to accept a whole `randomUUID()` as the tail, producing a 78-char id
 * (36 + 6 + 36) against `backend/internal/modules/tracker/tracker.go`'s
 * 64-character entry-id limit. Every entry over the limit was rejected
 * PERMANENTLY (classified `permanent`, `dirty` cleared, `remote` left at 0)
 * — the row stayed on the phone that logged it, forever, and never reached
 * the server, a second device, or web, with no error surfaced anywhere. This
 * is the same constraint `coffeeCaffeine.ts`'s own `pairedCaffeineEntryId`
 * already states and solves with a 4-character suffix; this file did not
 * inherit it. 8 hex characters (the first chunk of a fresh `randomUUID()`,
 * before its first hyphen) keeps a food entry id at 36 + 6 + 8 = 50
 * characters — comfortably under 64 — while still carrying enough entropy
 * (32 bits) that two supersedes of the SAME food entry colliding is not a
 * realistic concern.
 */
const FOOD_CAFFEINE_TAIL_LENGTH = 8;

/**
 * One caffeine entry id caused by food entry `foodEntryId`, tagged `tail`.
 *
 * `tail` is truncated to {@link FOOD_CAFFEINE_TAIL_LENGTH} HERE, not left to
 * the caller to remember — a single enforcement point, so nothing that ever
 * calls this can regress the 64-character limit above by passing a longer
 * one.
 */
export function pairedFoodCaffeineEntryId(foodEntryId: string, tail: string): string {
  return `${foodEntryId}${FOOD_CAFFEINE_ID_INFIX}${tail.slice(0, FOOD_CAFFEINE_TAIL_LENGTH)}`;
}

/**
 * Whether a caffeine-tracker entry ORIGINATED from a logged food item —
 * what the tracker UI checks before allowing a direct remove (see
 * `TrackerList.tsx`). A food-caused entry redirects to "edit or remove the
 * food log entry instead" rather than being removable in place, so the two
 * can never independently disagree about whether that food was eaten.
 */
export function isFoodCaffeineEntryId(entryId: string): boolean {
  return entryId.includes(FOOD_CAFFEINE_ID_INFIX);
}
