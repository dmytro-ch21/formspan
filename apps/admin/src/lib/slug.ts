/**
 * A PREVIEW of the id the server will derive from a name.
 *
 * Mirrors `technique.Slug` in the backend, which is the authority — this runs
 * in the browser as you type, so an operator sees the id before committing to
 * it. That matters more here than anywhere else in the app: the id is derived
 * once at creation and is immutable afterwards, because it becomes a foreign
 * key in athletes' training records. "São Paulo Pass" → `sao-paulo-pass`.
 *
 * DUPLICATED logic, deliberately, and labelled as a preview everywhere it is
 * shown. The apps share no package with the Go backend, so the choice is
 * between a preview that can in principle drift and no preview at all — and the
 * failure mode of drift is a displayed hint that differs from the id you get
 * back, not wrong data. The create screen shows the REAL id returned by the API
 * after saving, which is what the operator should trust.
 *
 * The fold covers the accented letters that actually turn up in grappling
 * vocabulary — Portuguese and Japanese romanisation — matching the backend's
 * `foldASCII` rather than doing full Unicode normalisation. A letter missing
 * from it produces a slightly uglier slug, never wrong data.
 */
const FOLD: Record<string, string> = {
  á: "a", à: "a", â: "a", ã: "a", ä: "a", å: "a",
  é: "e", è: "e", ê: "e", ë: "e",
  í: "i", ì: "i", î: "i", ï: "i",
  ó: "o", ò: "o", ô: "o", õ: "o", ö: "o",
  ú: "u", ù: "u", û: "u", ü: "u",
  ç: "c", ñ: "n", ß: "ss",
};

export function previewSlug(name: string): string {
  const folded = Array.from(name.trim().toLowerCase())
    .map((ch) => FOLD[ch] ?? ch)
    .join("");
  return folded.replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}
