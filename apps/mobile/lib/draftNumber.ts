/**
 * Numbers in a draft the athlete is editing, held as TEXT until they confirm.
 *
 * ## The trap this exists to stop having two copies of
 *
 * Round-tripping an editable number through `Number` on every keystroke
 * deletes the decimal point out from under the cursor: `"1."` parses to `1`,
 * redisplays as `"1"`, and the next keystroke makes `15` — so an athlete
 * correcting a portion to 1.5 servings silently logs ten times what they
 * meant. Clearing a field collapses it to `0` the same way, because
 * `Number('')` is `0` and sails through a `>= 0` guard.
 *
 * The check-in form and the session logger both recorded that trap, and the
 * meal-estimate screen fell into it anyway; review caught it there. It is now
 * about to have a third site in the barcode draft, which is exactly the point
 * at which `apiRequest.ts` was extracted for the same reason — its own note
 * says the copies "had already drifted", and `apiError.ts` says having two
 * copies "has already produced two different answers". One function, one
 * place to be wrong.
 */

/**
 * Parse an edited field back, ONCE, at confirm time.
 *
 * An unparseable or empty field keeps the value it started with rather than
 * becoming zero: a blank calorie box means "I did not change this", not "this
 * meal had no calories". A comma is accepted as a decimal separator because
 * most of the world's keyboards produce one.
 */
export function parseOr(raw: string, fallback: number): number {
  const trimmed = raw.trim().replace(',', '.');
  if (trimmed === '') return fallback;
  const n = Number(trimmed);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}
