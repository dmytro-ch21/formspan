/**
 * Which revision a restore button asks for, and how it travels.
 *
 * THE FIELD NAME AND THE READER LIVE TOGETHER ON PURPOSE. `RevisionHistory`
 * renders the hidden input; both catalogs' restore actions read it. Three
 * copies of the string `"revision"` in three files is how a rename half-lands
 * and the console starts restoring nothing, so there is one.
 *
 * Why a form field rather than a bound argument: a Server Component may hand a
 * Client Component a *server reference*, and a closure that returns one is not
 * that. Binding the revision server-side meant passing
 * `(revision) => action.bind(null, id, revision)`, which threw "Functions
 * cannot be passed directly to Client Components", 500'd the whole detail page,
 * and surfaced as the root boundary's "the API didn't respond as expected" —
 * the one explanation that was not true. It typechecked, because the prop type
 * described the closure.
 *
 * `id` stays bound: it is the page's, and nothing a client sends may decide
 * which row gets written. `revision` is per-button and scoped to that id by the
 * API, so a form field is the right place for it.
 */
export const REVISION_FIELD = "revision";

/**
 * Returns the revision number, or null if the field is missing or not one.
 *
 * Null rather than a throw so the caller can say what actually happened. The
 * API rejects an unknown revision on its own, but not a NaN — that goes out as
 * the literal path segment "NaN" and comes back a 404 that means nothing.
 */
export function revisionFrom(form: FormData): number | null {
  const raw = String(form.get(REVISION_FIELD) ?? "");
  const n = Number(raw);
  return Number.isInteger(n) && n >= 1 ? n : null;
}
