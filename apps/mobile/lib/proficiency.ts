import { apiRequest } from './apiRequest';
import type { TokenGetter } from './useAuthToken';

/**
 * The technique funnel, aggregated across every session — client half of
 * `GET /v1/bjj/proficiency`. (The path below omits the prefix: `apiRequest`
 * already carries `/v1`, and repeating it here would request `/v1/v1/...`.)
 *
 * **`attempted` and `scored` are DISJOINT**, which the backend's own comment
 * insists on and which any reader here has to carry: `attempted` is "went for
 * it and it did not land", not "total tries". So `attempted + scored` is how
 * often it was tried, and `scored / (attempted + scored)` is the hit rate.
 * Reading `attempted` as total tries is the natural mistake and gives
 * different numbers — see `lib/suggestion.ts`, where getting it wrong would
 * tell an athlete to try something they are already landing.
 *
 * `apps/web` has its own copy of this type. Not shared, because the two apps
 * cannot import from each other and there is no `packages/` yet — the same gap
 * the adherence rule ran into. Worth a shared package the third time this
 * happens.
 */
export type Proficiency = {
  technique_id: string;
  name: string;
  position: string;
  category: string;
  drilled: number;
  attempted: number;
  scored: number;
  conceded: number;
  /** How many separate sessions contributed — the honesty check on the rest. */
  sessions: number;
  last_seen: string;
};

/**
 * Read the funnel.
 *
 * Network-only, deliberately. This is an aggregate over every session the
 * athlete has ever logged, including ones synced from another device, so a
 * local answer would be a different and quietly smaller number. The caller
 * treats a failure as "no suggestion", never as an error worth a banner:
 * a suggestion is an offer, and an offer that cannot be made is not a fault
 * the athlete needs telling about.
 */
export function fetchProficiency(
  getToken: TokenGetter,
  signal?: AbortSignal,
): Promise<Proficiency[]> {
  // The endpoint answers `{ techniques, summary }`, NOT a bare array. Typing
  // it as an array compiled perfectly and crashed the Today screen on first
  // render with "undefined is not a function" — `rows.filter` on a response
  // that had no such property. TypeScript cannot catch this: the cast at the
  // parse boundary is an assertion about a server, not a check.
  //
  // `?? []` for the same reason `bjjFocus.ts` has one, and it documents the
  // consequence exactly: a drifted or older server omitting the field hands
  // `undefined` to a consumer inside a `useMemo`, which takes the render down
  // rather than degrading to no suggestion.
  return apiRequest<{ techniques?: Proficiency[] }>(getToken, '/bjj/proficiency', { signal }).then(
    (r) => r.techniques ?? [],
  );
}
