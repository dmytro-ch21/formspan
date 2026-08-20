import { apiRequest } from './apiRequest';
import { netFetch, SLOW_REQUEST_TIMEOUT_MS } from './authedFetch';
import type { PhaseKind } from './anthropometry';
import type { TokenGetter } from './useAuthToken';

/**
 * Body check-ins: what the athlete weighs and measures, and the phase they are
 * measuring it against.
 *
 * The arithmetic that makes any of it mean something is in
 * `lib/anthropometry.ts` and runs on the phone, so the card works standing on a
 * bathroom scale with no signal. This module only moves the rows.
 *
 * **Online-only, deliberately, and it is the one thing here worth arguing
 * about.** Sessions are offline-first because they are logged mid-workout in a
 * basement; a check-in is thirty seconds by a scale, at home, once a day. The
 * cost of an offline outbox for it is a second sync surface with its own
 * conflict rules, and the benefit is a case that barely occurs. If weighing in
 * at a gym with no signal turns out to be common, this is the note that says
 * the decision was made knowingly rather than overlooked.
 */

export type Checkin = {
  user_id: string;
  measured_on: string; // YYYY-MM-DD

  weight_kg: number | null;

  neck_cm: number | null;
  shoulders_cm: number | null;
  chest_cm: number | null;
  waist_cm: number | null;
  hips_cm: number | null;
  thigh_cm: number | null;
  calf_cm: number | null;
  upper_arm_cm: number | null;
  forearm_cm: number | null;

  measured_side: 'left' | 'right';
  /**
   * A presigned link that **expires** — see the backend handler. Never cache
   * it: a stored one is a broken image with extra steps.
   */
  photo_url?: string;
  notes: string;
};

export type Phase = {
  id: string;
  user_id: string;
  kind: PhaseKind;
  started_on: string;
  target_on: string | null;
  target_weight_kg: number | null;
  ended_on: string | null;
  notes: string;
};

/** The girth sites, in the order the form asks for them. */
export const GIRTH_SITES = [
  { key: 'neck_cm', label: 'Neck' },
  { key: 'shoulders_cm', label: 'Shoulders' },
  { key: 'chest_cm', label: 'Chest' },
  { key: 'waist_cm', label: 'Waist' },
  { key: 'hips_cm', label: 'Hips' },
  { key: 'upper_arm_cm', label: 'Upper arm' },
  { key: 'forearm_cm', label: 'Forearm' },
  { key: 'thigh_cm', label: 'Thigh' },
  { key: 'calf_cm', label: 'Calf' },
] as const;

export type GirthKey = (typeof GIRTH_SITES)[number]['key'];

/**
 * How each site is taken.
 *
 * Shown in the form rather than buried in a help screen, because **the single
 * biggest source of error in self-measurement is not the tape, it is measuring
 * a different place next week.** A number taken two inches higher than last
 * time is noise that looks exactly like progress.
 */
export const GIRTH_HOW: Record<GirthKey, string> = {
  neck_cm: 'Just below the larynx, tape sloping slightly down at the front.',
  shoulders_cm: 'Widest point, arms relaxed at your sides.',
  chest_cm: 'At nipple height, at the end of a normal breath out.',
  waist_cm: 'At the navel, relaxed — not sucked in, not pushed out.',
  hips_cm: 'The widest point of the glutes, feet together.',
  upper_arm_cm: 'Midway between shoulder and elbow, arm relaxed and hanging.',
  forearm_cm: 'The widest point below the elbow, arm hanging.',
  thigh_cm: 'Midway between hip and knee, weight on both feet.',
  calf_cm: 'The widest point, weight on both feet.',
};

/** The phase vocabulary, with the labels an athlete recognises. */
export const PHASE_LABELS: Record<PhaseKind, { label: string; hint: string }> = {
  cut: { label: 'Cut', hint: 'Lose fat, keep the muscle' },
  lean_bulk: { label: 'Lean bulk', hint: 'Add muscle, minimise the fat' },
  recomposition: { label: 'Recomp', hint: 'Weight flat, composition moving' },
  maintenance: { label: 'Maintain', hint: 'Hold where you are' },
  making_weight: { label: 'Making weight', hint: 'A division, on a date' },
};

export function listCheckins(
  getToken: TokenGetter,
  range: { from: string; to: string },
): Promise<Checkin[]> {
  const qs = new URLSearchParams(range);
  // `?? []` at the parse boundary, the house rule: a drifted server omitting
  // the field would otherwise hand `undefined` to a `.map` inside a render.
  return apiRequest<{ checkins: Checkin[] }>(getToken, `/body/checkins?${qs}`).then(
    (r) => r.checkins ?? [],
  );
}

/** What a save may set. Absent means "not measured" — it never clears. */
export type CheckinInput = Partial<Record<GirthKey, number | null>> & {
  weight_kg?: number | null;
  measured_side?: 'left' | 'right';
  notes?: string;
};

export function saveCheckin(
  getToken: TokenGetter,
  date: string,
  input: CheckinInput,
): Promise<Checkin> {
  return apiRequest<Checkin>(getToken, `/body/checkins/${date}`, {
    method: 'PUT',
    body: JSON.stringify(input),
  });
}

/** Removes the whole day — the only way to clear a mistyped measurement. */
export function deleteCheckin(getToken: TokenGetter, date: string): Promise<void> {
  return apiRequest<void>(getToken, `/body/checkins/${date}`, { method: 'DELETE' });
}

export function listPhases(getToken: TokenGetter): Promise<Phase[]> {
  return apiRequest<{ phases: Phase[] }>(getToken, '/body/phases').then((r) => r.phases ?? []);
}

export function createPhase(
  getToken: TokenGetter,
  input: {
    id: string;
    kind: PhaseKind;
    started_on: string;
    target_on?: string | null;
    target_weight_kg?: number | null;
    notes?: string;
  },
): Promise<Phase> {
  return apiRequest<Phase>(getToken, '/body/phases', {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export function endPhase(getToken: TokenGetter, id: string, endedOn?: string): Promise<Phase> {
  return apiRequest<Phase>(getToken, `/body/phases/${id}/end`, {
    method: 'POST',
    body: JSON.stringify(endedOn ? { ended_on: endedOn } : {}),
  });
}

type UploadTicket = {
  upload_url: string;
  content_type: string;
  max_bytes: number;
  expires_in: number;
  checkin: Checkin;
};

/**
 * Upload a progress photo for one day.
 *
 * Two requests and one direct PUT to storage, in that order:
 *
 *   1. ask the API for a short-lived signed URL,
 *   2. PUT the bytes straight to the bucket.
 *
 * **The bytes never touch our API**, which is what keeps a multi-megabyte
 * upload on bad gym wifi from being the API's problem. The signed URL is a
 * bearer credential for exactly one object and expires in minutes.
 *
 * Step 2 goes through `netFetch`, which is `fetch` plus this app's offline-error
 * translation and **adds no headers of its own** — that is the property that
 * matters. The PUT goes to Cloudflare, not to us, and must not carry our
 * `Authorization` or `traceparent`: signing covers the request, and an extra
 * signed-header mismatch is a rejected upload.
 */
export async function uploadCheckinPhoto(
  getToken: TokenGetter,
  date: string,
  localUri: string,
): Promise<Checkin> {
  const ticket = await apiRequest<UploadTicket>(getToken, `/body/checkins/${date}/photo`, {
    method: 'POST',
  });

  const blob = await (await fetch(localUri)).blob();
  if (blob.size > ticket.max_bytes) {
    // The caller downscales before getting here; this is the backstop that
    // turns a silent storage rejection into a sentence.
    throw new Error(
      `That photo is ${Math.round(blob.size / 1024 / 1024)}MB — it needs to be under ${Math.round(
        ticket.max_bytes / 1024 / 1024,
      )}MB.`,
    );
  }

  const res = await netFetch(
    ticket.upload_url,
    {
      method: 'PUT',
      // Exactly the content type that was signed. Anything else is refused by
      // the signature, which is the point of signing it.
      headers: { 'Content-Type': ticket.content_type },
      body: blob,
    },
    // The slow budget, not the default: this is a multi-megabyte PUT to
    // object storage over whatever the changing room has, and it is the one
    // request in the app most likely to be slow for reasons of size alone.
    { timeoutMs: SLOW_REQUEST_TIMEOUT_MS },
  );
  if (!res.ok) {
    throw new Error(`Couldn't upload that photo (${res.status}).`);
  }
  return ticket.checkin;
}
