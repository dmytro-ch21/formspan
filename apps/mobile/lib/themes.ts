import { apiRequest } from './apiRequest';
import type { TokenGetter } from './useAuthToken';

/**
 * What a training week is about — one sentence, readable AND writable on the
 * phone.
 *
 * **Authored here too, as of N82.** This file used to say "read-only on the
 * phone… no write path here on purpose" — a decision the mobile-first rule in
 * `CLAUDE.md` (2026-08-19) supersedes on the exclusivity, not on the design:
 * a capability may be richer on web, it may not be only on web. `setTheme`
 * and `deleteTheme` below call the exact same `PUT`/`DELETE
 * /v1/themes/{weekStart}` the web calendar's `setTheme`/`deleteTheme` in
 * `apps/web/src/lib/api.ts` already use — no backend change, because the
 * endpoint already existed for the web client.
 *
 * **The write path is as small as the read path**, because a theme is
 * genuinely one field an athlete sets: a short line of prose. There is full
 * parity with web here, not a reduction — web's own `ThemeRow` edits only
 * `title` too (its `setTheme` call always sends `notes: ""`), so mobile
 * matches it exactly rather than a cut-down version of it.
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

/**
 * `MaxTitle` mirrored from the Go module (`backend/internal/modules/theme`)
 * and from `apps/web`'s implicit `maxLength={80}` on its own input — not
 * enforced client-side beyond the `TextInput`'s own `maxLength`, since the
 * server is the actual guarantee and this repo's convention (see
 * `theme.go`'s own comment on `MaxTitle`) is that a client-side copy exists
 * for the error message, not for safety.
 */
export const MAX_THEME_TITLE = 80;

/**
 * Trims a submitted title, mirroring the Go module's `CleanTitle` — pulled out
 * as its own function for the identical reason `theme.go` gives: the decision
 * of "empty title clears the theme, non-empty title sets it" has to be
 * reachable by a test that never touches the network.
 */
export function cleanThemeTitle(raw: string): string {
  return raw.trim();
}

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

/**
 * Creates or replaces a week's theme. `weekStart` must be a Monday.
 *
 * One verb rather than create-then-update, matching web's `setTheme`: a week
 * holds at most one theme, and the caller names the week.
 */
export function setTheme(
  getToken: TokenGetter,
  weekStart: string,
  input: { title: string; notes?: string },
): Promise<Theme> {
  return apiRequest<Theme>(getToken, `/themes/${encodeURIComponent(weekStart)}`, {
    method: 'PUT',
    body: JSON.stringify({ title: input.title, notes: input.notes ?? '' }),
  });
}

export function deleteTheme(getToken: TokenGetter, weekStart: string): Promise<void> {
  return apiRequest<void>(getToken, `/themes/${encodeURIComponent(weekStart)}`, {
    method: 'DELETE',
  });
}
