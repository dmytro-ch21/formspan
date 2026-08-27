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
  /**
   * Them going for it and the athlete stopping them — the mirror of
   * `attempted`, and the defensive half of the 2x2 the tag vocabulary forms.
   * Added for N84: `bucketOf` below reads it, and its absence is exactly what
   * made `apps/web`'s own proficiency page briefly mis-bucket a pure-defence
   * technique as "used on you" — see that page's own note. Required by the
   * contract, matching `apps/web/src/lib/api.ts`'s `BjjProficiency`.
   */
  defended: number;
  /** How many separate sessions contributed — the honesty check on the rest. */
  sessions: number;
  last_seen: string;
};

/** Counts of TECHNIQUES, not of reps — matches `apps/web`'s `BjjProficiencySummary`. */
export type ProficiencySummary = {
  techniques: number;
  drilled: number;
  tried_live: number;
  landed: number;
};

/**
 * Read the funnel, with the headline it folds to.
 *
 * Network-only, deliberately — see {@link fetchProficiency}'s note, which
 * applies here unchanged. This is the full response; `fetchProficiency` below
 * is a thin projection of it kept for its existing callers (the Today card's
 * suggestion logic and the reflection wizard), which want the list and have
 * never wanted the summary. Both go through ONE request rather than two
 * disagreeing reads of the same endpoint.
 */
export function fetchProficiencyFull(
  getToken: TokenGetter,
  signal?: AbortSignal,
): Promise<{ techniques: Proficiency[]; summary: ProficiencySummary | null }> {
  // `?? []` / `?? null` at the parse boundary, for the reason `bjjFocus.ts`
  // documents: a drifted or older server omitting a field must not hand
  // `undefined` to a consumer inside a `useMemo`, which takes the render down
  // rather than degrading gracefully.
  return apiRequest<{ techniques?: Proficiency[]; summary?: ProficiencySummary }>(
    getToken,
    '/bjj/proficiency',
    { signal },
  ).then((r) => ({ techniques: r.techniques ?? [], summary: r.summary ?? null }));
}

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
  return fetchProficiencyFull(getToken, signal).then((r) => r.techniques);
}

/** Below this, a hit rate is noise rather than a measurement. Matches web's page. */
export const MIN_TRIES_FOR_RATE = 5;

export type Bucket = 'all' | 'untried' | 'working' | 'stalled' | 'against';

/**
 * Every row lands in exactly one bucket, and the chip counts sum to
 * "Everything" — a straight port of `apps/web/src/app/dashboard/proficiency/page.tsx`'s
 * `bucketOf`, kept byte-for-byte in its reasoning because the two screens
 * describe the same funnel and must not disagree about which bucket a
 * technique falls in.
 *
 * `against` is reachable and returns rows the API's own filter allows through
 * (`technique_id IS NOT NULL`, nothing more) — a technique whose only evidence
 * is a `conceded` tag comes back with zeroes across drilled/attempted/scored
 * and `defended`. No shipped client authors one today; it still has to be
 * handled rather than assumed away, or the chip counts silently stop summing
 * to "Everything".
 */
export function bucketOf(p: Proficiency): Exclude<Bucket, 'all'> {
  const tried = p.attempted + p.scored;
  if (tried > 0) return p.scored > 0 ? 'working' : 'stalled';
  if (p.drilled > 0) return 'untried';
  // Defending it IS live evidence, and of the athlete succeeding — see web's
  // note on why this is checked before falling through to `against`.
  if (p.defended > 0) return 'working';
  return 'against';
}
