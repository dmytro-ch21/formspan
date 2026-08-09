import { newTraceId, traceparent } from './trace';
import { netFetch } from './authedFetch';
import { formatDistance, formatEstimate, formatWeight, type UnitSystem } from './units';
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

/**
 * What kind of number this is — see `backend/internal/modules/session/basis.go`,
 * which carries the full argument and the three reading rules.
 *
 * In short: `measured` is what happened, `modelled` is derived from what
 * happened by a documented formula and may consume reported inputs, `reported`
 * is the athlete's own account. The distinction exists because a heaviest lift
 * and an estimated 1RM used to render as peers, and one of them is computed
 * from a self-rating.
 */
export type Basis = 'measured' | 'modelled' | 'reported';

/**
 * Classifies a record kind.
 *
 * **A local map rather than a field on the wire.** The basis is a property of
 * the vocabulary, not of a row — every `estimated_1rm` that has ever existed is
 * modelled — so sending it per record would ship a constant on every row and
 * let a row cached on a phone carry a stale classification if the vocabulary
 * ever changed. `RecordKind` already exists in three places (Go, here, and
 * `apps/web/src/lib/api.ts`); the classification belongs beside each copy, and
 * `basisParity.test.ts` reads the Go source to keep them from drifting.
 *
 * A `Record<RecordKind, Basis>` rather than a function with a fallback: the map
 * is exhaustive by type, so a new kind fails to compile here instead of
 * silently defaulting to `measured` — which is the failure this whole
 * distinction exists to prevent.
 */
export const RECORD_BASIS: Record<RecordKind, Basis> = {
  heaviest_weight: 'measured',
  most_reps: 'measured',
  longest_time: 'measured',
  furthest_distance: 'measured',
  // The one modelled record: Epley over reps and weight, with RIR/RPE folded in
  // as effective reps. Kept that way deliberately — RIR is genuinely how a
  // submaximal set becomes a 1RM estimate, and removing it would make the
  // estimate worse rather than more objective. What it needs is a label, not a
  // different formula.
  estimated_1rm: 'modelled',
};

export function basisFor(kind: RecordKind): Basis {
  return RECORD_BASIS[kind];
}

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

/**
 * Formats a record in the unit its kind is actually measured in.
 *
 * The two weight kinds are deliberately not formatted the same way. A heaviest
 * lift is a measurement — 62.55kg is what was on the bar, and the decimals are
 * real. An estimated 1RM is a rep-max curve's output, and rendering it as
 * "74.48kg" invites reading a modelled number as a measured one; `units` keeps
 * that distinction in one place, as `formatEstimate`.
 *
 * Takes the unit system rather than formatter callbacks: with the estimate
 * split out, a caller passing its own `fmtWeight` would have had to know which
 * kinds are estimates to route them correctly — which is this function's job.
 */
export function formatRecord(r: PersonalRecord, u: UnitSystem): string {
  switch (r.kind) {
    case 'heaviest_weight':
      return formatWeight(r.value, u);
    case 'estimated_1rm':
      return formatEstimate(r.value, u);
    case 'most_reps':
      return `${Math.round(r.value)}`;
    case 'longest_time': {
      const s = Math.round(r.value);
      const m = Math.floor(s / 60);
      return m > 0 ? `${m}m${s % 60 ? ` ${s % 60}s` : ''}` : `${s}s`;
    }
    case 'furthest_distance':
      return formatDistance(r.value, u);
  }
}

/**
 * The set behind the number, split by what kind of fact each half is.
 *
 * This used to return one string — `"5 × 100kg · 2 RIR"` — with the same
 * separator between the two halves, which is precisely the flattening this
 * distinction exists to undo. `5 × 100kg` is what was on the bar. `2 RIR` is
 * what the athlete reckoned was left in the tank. Joining them with a middle
 * dot presents an opinion as another column of the measurement.
 *
 * Returned as parts rather than a pre-joined string so the caller can style
 * them differently; nothing here decides how that looks.
 *
 * The weight is `formatWeight`, not `formatEstimate`, whatever kind of record
 * it evidences: this is the set that was logged, and it was measured even when
 * the number it supports is modelled.
 */
export type Evidence = {
  /** What was logged: "5 × 100kg", "12 reps". Empty when the set carried none. */
  measured: string;
  /** What the athlete reported: "2 RIR", "RPE 8". Empty when not collected —
   *  which is a normal state, since `TrackEffortProvider` makes it optional. */
  reported: string;
};

export function describeEvidence(r: PersonalRecord, u: UnitSystem): Evidence {
  const measured: string[] = [];
  if (r.reps != null && r.weight_kg != null) {
    measured.push(`${r.reps} × ${formatWeight(r.weight_kg, u)}`);
  } else if (r.reps != null) {
    measured.push(`${r.reps} reps`);
  }

  // RIR wins where both are present, matching the estimator's own precedence
  // (`backend/internal/modules/session/postgres.go` — "RIR is the observed
  // quantity and wins where both are present").
  const reported: string[] = [];
  if (r.rir != null) reported.push(`${r.rir} RIR`);
  else if (r.rpe != null) reported.push(`RPE ${r.rpe}`);

  return { measured: measured.join(' · '), reported: reported.join(' · ') };
}
