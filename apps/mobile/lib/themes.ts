import { apiRequest } from './apiRequest';
import type { TokenGetter } from './useAuthToken';

/**
 * What a training week is about — one sentence, read-only on the phone.
 *
 * **Authored on web, per the platform rule.** Deciding what a block is FOR is a
 * desk activity, like building a template; the phone shows it while you train.
 * There is no write path here on purpose, not as an omission.
 *
 * **It is not a second focus list.** `lib/bjjFocus.ts` holds the rolling,
 * technique-level "what am I working on", and a theme carries no technique ids
 * and no exercise ids at all — prose only. That restriction is what keeps the
 * two from answering the same question differently; see the backend module.
 */
export type Theme = {
  /** The Monday of the week, as a calendar date. */
  week_start: string;
  title: string;
  notes: string;
};

export function fetchThemes(
  getToken: TokenGetter,
  range: { from: string; to: string },
): Promise<Theme[]> {
  const qs = new URLSearchParams({ from: range.from, to: range.to });
  // `?? []` at the parse boundary, for the reason `techniques.ts` and
  // `bjjFocus.ts` both document: a drifted server omitting the field hands
  // `undefined` to a `.map` inside a render rather than degrading to empty.
  return apiRequest<{ themes: Theme[] }>(getToken, `/themes?${qs}`).then(
    (r) => r.themes ?? [],
  );
}
