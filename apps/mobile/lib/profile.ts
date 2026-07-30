import { newTraceId, traceparent } from './trace';
import type { UnitSystem } from './units';

const API_URL = process.env.EXPO_PUBLIC_API_URL ?? 'http://localhost:8080';
const API_BASE = `${API_URL}/v1`;

export type Profile = {
  user_id: string;
  display_name: string | null;
  unit_system: UnitSystem;
  bjj_enabled: boolean;
  strength_enabled: boolean;
  nutrition_enabled: boolean;
  running_enabled: boolean;
};

async function request<T>(
  getToken: () => Promise<string | null>,
  path: string,
  init: RequestInit = {},
): Promise<T> {
  const token = await getToken();
  if (!token) throw new Error('Not signed in.');
  const res = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: {
      ...init.headers,
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      traceparent: traceparent(newTraceId()),
    },
  });
  const body = await res.json().catch(() => null);
  if (!res.ok) throw new Error(body?.error?.message ?? `Request failed (${res.status}).`);
  return body as T;
}

export function getProfile(getToken: () => Promise<string | null>): Promise<Profile> {
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
  getToken: () => Promise<string | null>,
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
    if (!/not found/i.test(err instanceof Error ? err.message : '')) throw err;
    await request<Profile>(getToken, '/profile', { method: 'POST', body: JSON.stringify({}) });
    return patch();
  }
}
