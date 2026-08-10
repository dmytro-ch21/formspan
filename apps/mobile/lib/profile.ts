import { ApiError, isNotFound } from './apiError';
import { netFetch } from './authedFetch';
import type { TokenGetter } from './useAuthToken';
import { newTraceId, traceparent } from './trace';
import type { UnitSystem } from './units';

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

export function getProfile(getToken: TokenGetter): Promise<Profile> {
  return request<Profile>(getToken, '/profile');
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
