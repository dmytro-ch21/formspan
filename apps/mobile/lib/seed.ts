import { cacheExercises, cacheWorkouts } from './sessionStore';
import { fetchExercises } from './exercises';
import { getProfile } from './profile';
import { listWorkouts } from './workouts';
import { fetchPinned } from './records';
import { PREF_PINNED_RECORDS, PREF_SEEDED_AT, readPref, writePref } from './prefs';
import type { TokenGetter } from './useAuthToken';

/**
 * Fill the local database once, so the app is usable before it is ever offline.
 *
 * **The gap this closes.** Every cache in this app is populated as a side
 * effect of a screen being opened while online. That is fine for an install
 * that has been used for a week, and useless for the case that actually
 * happens: install VOLA at home, open it, go to the gym, and discover the
 * exercise picker is empty because you never opened the Library. The offline
 * work so far made *what you have* survive; nothing made sure you had
 * anything.
 *
 * **Ordered by what the next step needs, not by importance.** The profile
 * carries the unit system, and a weight rendered in the wrong unit for even
 * one frame is the bug that started the units work. Exercises come next
 * because a workout's items are exercise ids, and a plan whose rows read as
 * raw UUIDs is not a plan. Workouts precede sessions for the same reason a
 * workout is pushed before a session that references it. Pinned records are
 * last: they are the only step whose absence costs nothing but a placeholder.
 *
 * **Partial progress is kept, and is not recorded as success.** Each step
 * writes its own cache as it completes, so a seed that dies halfway leaves
 * the athlete with a working catalog rather than nothing. But `PREF_SEEDED_AT`
 * is only written when every step succeeded — so the next launch tries again
 * instead of concluding, on the strength of a half-finished run, that there
 * is nothing left to fetch.
 *
 * **It is not a blocking splash.** Nothing here gates the UI. Screens already
 * render cache-first with honest loading and empty states; this runs behind
 * them and makes those caches non-empty sooner. Blocking a first launch on
 * five network calls would trade a rare bad gym session for a bad first
 * impression every single install.
 */

export type SeedStep = 'profile' | 'exercises' | 'workouts' | 'sessions' | 'pinned';

export type SeedResult = {
  /** Steps that completed and wrote their cache. */
  done: SeedStep[];
  /** Steps that failed; the seed will be retried on a later launch. */
  failed: SeedStep[];
  /** True only if every step succeeded. */
  complete: boolean;
};

/** Has a full seed ever finished for this account on this device? */
export async function hasSeeded(userID: string): Promise<boolean> {
  return (await readPref(userID, PREF_SEEDED_AT)) !== null;
}

/**
 * The steps, in dependency order.
 *
 * A list rather than a sequence of awaits so the order is inspectable — a
 * test can assert the ordering property directly instead of re-deriving it
 * from control flow, and adding a step cannot accidentally land in the wrong
 * place without the test noticing.
 */
export function seedSteps(): SeedStep[] {
  return ['profile', 'exercises', 'workouts', 'sessions', 'pinned'];
}

type Deps = {
  profile: () => Promise<unknown>;
  exercises: () => Promise<void>;
  workouts: () => Promise<void>;
  sessions: () => Promise<void>;
  pinned: () => Promise<void>;
};

/**
 * Run the seed once.
 *
 * `deps` is injectable so the ordering and the partial-failure behaviour can
 * be tested without a network or a database — those are the two properties
 * that matter here and neither is about any individual fetch.
 */
export async function runSeed(
  userID: string,
  deps: Deps,
  now: () => string = () => new Date().toISOString(),
): Promise<SeedResult> {
  const done: SeedStep[] = [];
  const failed: SeedStep[] = [];

  for (const step of seedSteps()) {
    try {
      await deps[step]();
      done.push(step);
    } catch {
      // Recorded and CONTINUED, not aborted. The steps are independent once
      // their inputs exist, so a failed workouts fetch should not also cost
      // the athlete their sessions — and offline every step fails anyway, in
      // which case there is nothing to abort early for.
      failed.push(step);
    }
  }

  const complete = failed.length === 0;
  // Only a clean run counts. Marking a partial seed as done would leave the
  // missing pieces missing until the athlete happened to open the screen that
  // fetches them — which is exactly the situation this exists to prevent.
  if (complete) await writePref(userID, PREF_SEEDED_AT, now());

  return { done, failed, complete };
}

/**
 * Seed on first launch for this account, if it has not been done.
 *
 * Safe to call on every launch: it reads one indexed pref and returns.
 */
export async function seedIfNeeded(
  userID: string,
  getToken: TokenGetter,
  extra: Pick<Deps, 'sessions'>,
): Promise<SeedResult | null> {
  if (await hasSeeded(userID)) return null;

  return runSeed(userID, {
    profile: () => getProfile(getToken),
    exercises: async () => {
      // Every sport at once rather than per-discipline: the whole catalog is
      // a few hundred rows, and fetching it by sport would mean re-running
      // this the first time someone enables a discipline in Settings.
      await cacheExercises(await fetchExercises(getToken, {}));
    },
    workouts: async () => {
      await cacheWorkouts(userID, await listWorkouts(getToken, 'mine'));
    },
    pinned: async () => {
      // Only the ids. Everything the Records screen draws around them —
      // names, thumbnails, load types — is in `exercise_cache` from step two,
      // so this needs no store of its own.
      await writePref(userID, PREF_PINNED_RECORDS, JSON.stringify(await fetchPinned(getToken)));
    },
    ...extra,
  });
}
