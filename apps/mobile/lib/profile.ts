import { ApiError, isNotFound, parseRetryAfterMs } from './apiError';
import { apiRequest } from './apiRequest';
import { netFetch } from './authedFetch';
import type { TokenGetter } from './useAuthToken';
import { newTraceId, traceparent } from './trace';
import type { FoodUnit, UnitSystem } from './units';

const API_URL = process.env.EXPO_PUBLIC_API_URL ?? 'http://localhost:8080';
const API_BASE = `${API_URL}/v1`;

/**
 * Module toggles are NOT here any more. They moved to `lib/modules.ts` and
 * GET/PATCH /v1/modules, because four boolean columns meant a migration and a
 * dozen unchecked edits per new discipline.
 */
export type Profile = {
  user_id: string;
  /** The unique handle, or null until claimed. Lowercase by server rule. */
  username: string | null;
  display_name: string | null;
  date_of_birth: string | null;
  sex: string | null;
  /** Centimetres. What waist-to-height and the body-fat estimate need. */
  height_cm: number | null;
  unit_system: UnitSystem;
  /** null until the athlete chooses — see PREF_FOOD_UNIT. */
  food_unit: FoodUnit | null;
  track_effort: boolean;
  /**
   * The ONLY thing that makes this athlete's training readable by another
   * athlete. Off by default and read live server-side, so switching it off
   * retracts every past session at once.
   *
   * Turning it ON is retroactive — friends see finished sessions from before
   * the switch too. The Settings copy says so rather than leaving it to be
   * found out.
   */
  share_training_with_friends: boolean;
  /**
   * How MUCH of a shared session travels — the numbers alone, or the exercise
   * and technique list with them.
   *
   * SUBORDINATE to the switch above: it does nothing while that one is off,
   * which is why the settings screen dims it there rather than letting an
   * athlete configure a disclosure that is not happening.
   *
   * Optional on the type only so a client built against an older response
   * still parses; read it as `?? false`, never assume it is present. False is
   * the safe reading either way — a privacy switch that fails open is not one.
   */
  share_training_details?: boolean;
  /**
   * Daily movement outside logged training, or null when the athlete has never
   * chosen. Optional on the TYPE only so a response from an older server still
   * parses; read it as `?? null` rather than assuming it is present.
   */
  activity_level?: string | null;
  /**
   * A short-lived presigned URL to the athlete's uploaded avatar (N12) —
   * already resized server-side. **Absent, not null, when there is none** —
   * the server omits the key entirely rather than sending an empty string,
   * so `profile.avatar_url` is the whole check; there is no third state to
   * misread. The monogram (`lib/monogram.ts`) is the fallback everywhere
   * this is absent, and everywhere a real image FAILS to load — a network
   * blip must not turn into a broken-image icon.
   */
  avatar_url?: string;
};

/** The fields the edit screen can change. Omitted keys are left alone. */
export type ProfilePatch = Partial<{
  track_effort: boolean;
  share_training_with_friends: boolean;
  share_training_details: boolean;
  /** Claim or rename only — never null. The server treats null as "leave
   *  unchanged" (the profile-wide COALESCE contract), so a clear cannot be
   *  expressed and the save path must OMIT the key rather than null it. */
  username: string;
  display_name: string | null;
  date_of_birth: string | null;
  sex: string | null;
  /** Centimetres. What waist-to-height and the body-fat estimate need. */
  height_cm: number | null;
  /** Never null — the server's COALESCE contract reads null as "leave
   *  unchanged", so going back to "never chosen" cannot be expressed and the
   *  save path must OMIT the key rather than null it. Same rule as username. */
  activity_level: string;
}>;

/**
 * Saves profile edits, creating the row first if there isn't one.
 *
 * Same reasoning as the unit preference: PATCH on a missing profile is a
 * 404, which is right for the API and a dead end for someone who reached
 * this screen without ever going through onboarding.
 */
export async function updateProfile(
  getToken: TokenGetter,
  patch: ProfilePatch,
): Promise<Profile> {
  const send = () =>
    request<Profile>(getToken, '/profile', { method: 'PATCH', body: JSON.stringify(patch) });
  try {
    return await send();
  } catch (err) {
    // Branch on the status, not the message. Messages are explicitly not part
    // of the contract, so matching /not found/ broke two ways: it would stop
    // working the day someone reworded the string server-side, and — worse —
    // it treated *any* failure whose message happened to contain those words
    // as "no profile yet". Offline it also cost two doomed requests instead of
    // one, because a network error can't match and can't create either.
    if (!isNotFound(err)) throw err;
    await request<Profile>(getToken, '/profile', { method: 'POST', body: JSON.stringify({}) });
    return send();
  }
}

async function request<T>(
  getToken: TokenGetter,
  path: string,
  init: RequestInit = {},
): Promise<T> {
  const token = await getToken();
  const res = await netFetch(`${API_BASE}${path}`, {
    ...init,
    headers: {
      ...init.headers,
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      traceparent: traceparent(newTraceId()),
    },
  });
  if (res.status === 204) return undefined as T;
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    throw new ApiError(
      body?.error?.message ?? `Request failed (${res.status}).`,
      body?.error?.code ?? 'unknown',
      res.status,
      // F17 (#403): the fifth hand-rolled request builder found by review —
      // the other four (apiRequest.ts, sessions.ts, workouts.ts, plansApi.ts)
      // already read this before the Response fell out of scope.
      parseRetryAfterMs(res.headers?.get('Retry-After')),
    );
  }
  return body as T;
}

/**
 * Per-exercise unit overrides, as a map of exercise id → unit system.
 *
 * A missing key means "use the profile default" — there is deliberately no
 * third state, so clearing an override removes the key rather than storing
 * a sentinel.
 */
export async function getExerciseUnits(
  getToken: TokenGetter,
): Promise<Record<string, UnitSystem>> {
  const b = await request<{ exercise_units: Record<string, UnitSystem> }>(
    getToken,
    '/profile/exercise-units',
  );
  return b.exercise_units ?? {};
}

/** Pass null to clear the override and fall back to the profile default. */
export async function setExerciseUnit(
  getToken: TokenGetter,
  exerciseID: string,
  unit: UnitSystem | null,
): Promise<void> {
  await request<void>(getToken, `/profile/exercise-units/${encodeURIComponent(exerciseID)}`, {
    method: 'PUT',
    body: JSON.stringify({ unit_system: unit }),
  });
}

export function setTrackEffort(
  getToken: TokenGetter,
  on: boolean,
): Promise<Profile> {
  return updateProfile(getToken, { track_effort: on } as never);
}

/**
 * Stores the daily-movement level, creating the profile if there is not one.
 *
 * Goes through `updateProfile` for its 404-then-POST recovery: the Goals tab is
 * a tab, so an athlete can reach it without ever having been through
 * onboarding, and "pick how much you move" failing on a row that does not exist
 * yet is a dead end with no explanation.
 */
export function setActivityLevel(
  getToken: TokenGetter,
  level: string,
): Promise<Profile> {
  return updateProfile(getToken, { activity_level: level });
}

export function getProfile(getToken: TokenGetter): Promise<Profile> {
  return request<Profile>(getToken, '/profile');
}

/**
 * Upload or replace the avatar — the same call either way, because the
 * server's storage key is deterministic per account (N12).
 *
 * Multipart, like `identifyMachine` — a photo has no sensible JSON
 * transport, and `apiRequest` (not this file's own `request`, which always
 * sets `Content-Type: application/json`) is what leaves the boundary token
 * to the runtime.
 */
export function uploadAvatar(
  getToken: TokenGetter,
  photo: { uri: string; mimeType: string },
): Promise<Profile> {
  const form = new FormData();
  form.append('avatar', {
    uri: photo.uri,
    name: 'avatar.jpg',
    type: photo.mimeType,
  } as unknown as Blob);
  return apiRequest<Profile>(getToken, '/profile/avatar', { method: 'POST', body: form });
}

/** Remove the avatar. The monogram is the fallback everywhere it was shown. */
export async function removeAvatar(getToken: TokenGetter): Promise<void> {
  await apiRequest<void>(getToken, '/profile/avatar', { method: 'DELETE' });
}

/**
 * Sets the unit preference, creating the profile if there isn't one yet.
 *
 * PATCH on a missing profile is a 404, which is the right answer for the
 * API — but not a useful one here. Someone can reach Settings without ever
 * having been through onboarding, and "choose your units" failing because
 * of a row that doesn't exist yet is a dead end with no explanation.
 */
export async function updateUnitSystem(
  getToken: TokenGetter,
  unit: UnitSystem,
): Promise<Profile> {
  const patch = () =>
    request<Profile>(getToken, '/profile', {
      method: 'PATCH',
      body: JSON.stringify({ unit_system: unit }),
    });
  try {
    return await patch();
  } catch (err) {
    // Status, not message — see updateProfile above.
    if (!isNotFound(err)) throw err;
    await request<Profile>(getToken, '/profile', { method: 'POST', body: JSON.stringify({}) });
    return patch();
  }
}

/**
 * Persist the food-quantity unit on the account.
 *
 * Same PATCH endpoint as `updateUnitSystem`, and deliberately NOT its retry
 * shape: that one catches a 404 and creates the profile first, because units
 * can be set from onboarding before a profile row exists. The food unit is only
 * reachable from the food log, which already requires a profile — so a 404 here
 * means something is wrong rather than something is missing, and creating a
 * profile as a side effect of a unit toggle would hide it.
 *
 * The earlier version of this comment claimed the retry shape was mirrored. It
 * was not, and a comment asserting a property the code lacks is worse than no
 * comment. Raised in review.
 */
export async function updateFoodUnit(
  getToken: TokenGetter,
  unit: FoodUnit,
): Promise<Profile> {
  return request<Profile>(getToken, '/profile', {
    method: 'PATCH',
    body: JSON.stringify({ food_unit: unit }),
  });
}
