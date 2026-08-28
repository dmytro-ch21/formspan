/**
 * Reading a gram basis back out of a `serving_label` (N90).
 *
 * `nutrition_entries` and a recipe's `nutrition_recipe_items` both have no
 * gram column — a quantity is a multiplier against whatever `serving_label`
 * (or `of_what`) says one unit is, and that label is free text. "100 g" is
 * what almost everything on this screen defaults to and states honestly; "1
 * scoop (30 g)" and "1 egg" do not, and must not be treated as though they do.
 *
 * This is a hand-written, small duplicate of
 * `apps/mobile/lib/foodQuantity.ts`'s identically named functions — not
 * generated, unlike `units.ts` — because this logic is specific to how each
 * app models a quantity-against-a-free-text-label row, not a pure unit
 * conversion. Keep the regex and the null-on-anything-else behaviour in sync
 * by hand if either changes; `apps/mobile/lib/__tests__/foodQuantity.test.ts`
 * carries the same assertions.
 */

/**
 * A gram basis, or null when the label does not honestly state one.
 *
 * Matches ONLY a bare number and "g" — `/^\d+(\.\d+)?\s*g$/i` after trimming —
 * so "100 g" is a basis and "1 scoop (30 g)" is not: the 30 g there describes
 * the scoop parenthetically, not a claim that one serving IS 30 g. A
 * permissive match would offer a grams control that then silently counts
 * scoops, or eggs, as grams.
 */
export function gramsBasisFromLabel(label: string): number | null {
  const m = /^(\d+(?:\.\d+)?)\s*g$/i.exec(label.trim());
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * Grams -> a quantity multiplier, for a label that honestly states a gram
 * basis — null when it does not, so a caller falls back to editing the
 * multiplier directly rather than inventing a basis this function just
 * refused to guess.
 */
export function quantityForLabelGrams(label: string, grams: number): number | null {
  const basis = gramsBasisFromLabel(label);
  if (basis == null) return null;
  return grams / basis;
}

/**
 * What was typed, or null for anything that is not a usable quantity — same
 * contract as `apps/mobile/lib/foodQuantity.ts`'s `parseQuantity`. Rejects
 * zero and negatives: a quantity of zero is not a quantity, and the backend's
 * own `servings > 0` / `quantity > 0` checks would refuse it anyway.
 */
export function parseQuantity(text: string): number | null {
  const trimmed = text.trim().replace(",", ".");
  if (trimmed === "") return null;
  const n = Number(trimmed);
  if (!Number.isFinite(n) || n <= 0) return null;
  return n;
}
