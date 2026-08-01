import { newTraceId, traceparent } from './trace';
import { netFetch } from './authedFetch';
import type { TokenGetter } from './useAuthToken';

const API_URL = process.env.EXPO_PUBLIC_API_URL ?? 'http://localhost:8080';
const API_BASE = `${API_URL}/v1`;

export type RecordKind =
  | 'heaviest_weight'
  | 'estimated_1rm'
  | 'most_reps'
  | 'longest_time'
  | 'furthest_distance';

export type PersonalRecord = {
  kind: RecordKind;
  /** In storage units — kg, reps, seconds or metres. */
  value: number;
  reps: number | null;
  weight_kg: number | null;
  seconds: number | null;
  distance_m: number | null;
  rir: number | null;
  rpe: number | null;
  achieved_at: string;
  session_id: string;
  /** Set recently enough to still be worth celebrating. */
  is_recent: boolean;
};

export type ExerciseRecords = { exercise_id: string; records: PersonalRecord[] };

/** Short labels — these sit under a number on a phone, not in a paragraph. */
export const RECORD_LABEL: Record<RecordKind, string> = {
  heaviest_weight: 'Heaviest',
  estimated_1rm: 'Est. 1RM',
  most_reps: 'Most reps',
  longest_time: 'Longest',
  furthest_distance: 'Furthest',
};

async function call<T>(
  getToken: TokenGetter,
  path: string,
  init: RequestInit = {},
  signal?: AbortSignal,
): Promise<T> {
  const token = await getToken();
  const res = await netFetch(`${API_BASE}${path}`, {
    ...init,
    signal,
    headers: {
      ...init.headers,
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      traceparent: traceparent(newTraceId()),
    },
  });
  if (res.status === 204) return undefined as T;
  const body = await res.json().catch(() => null);
  if (!res.ok) throw new Error(body?.error?.message ?? `Request failed (${res.status}).`);
  return body as T;
}

/**
 * The caller's records. With no ids, the API answers for their pinned
 * shortlist and falls back to what they train most — so this returns
 * something useful before anyone has configured anything.
 */
export async function fetchRecords(
  getToken: TokenGetter,
  exerciseIDs?: string[],
  signal?: AbortSignal,
): Promise<ExerciseRecords[]> {
  const qs = exerciseIDs?.length ? `?exercise_ids=${exerciseIDs.map(encodeURIComponent).join(',')}` : '';
  const b = await call<{ records: ExerciseRecords[] }>(getToken, `/records${qs}`, {}, signal);
  return b.records ?? [];
}

export async function fetchPinned(
  getToken: TokenGetter,
  signal?: AbortSignal,
): Promise<string[]> {
  const b = await call<{ exercise_ids: string[] }>(getToken, '/records/pinned', {}, signal);
  return b.exercise_ids ?? [];
}

export async function setPinned(
  getToken: TokenGetter,
  exerciseIDs: string[],
): Promise<string[]> {
  const b = await call<{ exercise_ids: string[] }>(getToken, '/records/pinned', {
    method: 'PUT',
    body: JSON.stringify({ exercise_ids: exerciseIDs }),
  });
  return b.exercise_ids ?? [];
}

/** Formats a record in the unit its kind is actually measured in. */
export function formatRecord(
  r: PersonalRecord,
  fmtWeight: (kg: number) => string,
  fmtDistance: (m: number) => string,
): string {
  switch (r.kind) {
    case 'heaviest_weight':
    case 'estimated_1rm':
      return fmtWeight(r.value);
    case 'most_reps':
      return `${Math.round(r.value)}`;
    case 'longest_time': {
      const s = Math.round(r.value);
      const m = Math.floor(s / 60);
      return m > 0 ? `${m}m${s % 60 ? ` ${s % 60}s` : ''}` : `${s}s`;
    }
    case 'furthest_distance':
      return fmtDistance(r.value);
  }
}

/** "5 × 100kg · 2 RIR" — the set behind the number, so it can be checked. */
export function describeEvidence(r: PersonalRecord, fmtWeight: (kg: number) => string): string {
  const bits: string[] = [];
  if (r.reps != null && r.weight_kg != null) bits.push(`${r.reps} × ${fmtWeight(r.weight_kg)}`);
  else if (r.reps != null) bits.push(`${r.reps} reps`);
  if (r.rir != null) bits.push(`${r.rir} RIR`);
  else if (r.rpe != null) bits.push(`RPE ${r.rpe}`);
  return bits.join(' · ');
}
