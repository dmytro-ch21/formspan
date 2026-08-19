import { apiRequest } from './apiRequest';
import type { TokenGetter } from './useAuthToken';

/**
 * Point the camera at a gym machine and get a shortlist of exercises (N44).
 *
 * The client half of `POST /v1/exercises/identify`. The server answers from a
 * closed shortlist of the catalog's machine equipment and re-checks every id it
 * gets back, so what arrives here is already validated: real catalog ids, names
 * taken from the catalog rather than the model, deduplicated, capped at four,
 * and every one using the reported equipment.
 *
 * **What this module must not do is choose.** See `MachineCandidate.confidence`.
 */

/** One exercise the server believes the photo shows. */
export interface MachineCandidate {
  exercise_id: string;
  name: string;
  /**
   * The model's own score, 0..1.
   *
   * **Display it or ignore it; never threshold on it, and never sort by it —
   * the array is already ranked.** It is not calibrated to "is this right": the
   * model has never seen this catalog. At best it means "how clearly can I see
   * a machine", which is worth showing to somebody deciding whether to retake a
   * photo and worthless as a filter.
   */
  confidence: number;
}

export interface MachineIdentification {
  /** The equipment family, e.g. `cable-stack`. Every candidate uses it. */
  equipment: string;
  /** Ranked, most likely first. Never empty — an empty answer is a 422. */
  candidates: MachineCandidate[];
  /** The model id the provider reported using. */
  model: string;
}

export interface IdentifyResponse {
  identification: MachineIdentification;
}

/**
 * Send the photo.
 *
 * Multipart rather than base64-in-JSON: base64 inflates a 5 MB photo to 6.7 MB
 * on the wire for nothing, and unlike the meal estimate there is no text path
 * here, so multipart is the only transport the endpoint accepts.
 *
 * **The Content-Type header is deliberately not set** — `apiRequest` skips it
 * for FormData so the runtime can append the boundary token, and setting it by
 * hand produces a body the server cannot parse.
 */
export function identifyMachine(
  getToken: TokenGetter,
  input: { uri: string; mimeType: string },
): Promise<IdentifyResponse> {
  const form = new FormData();
  // React Native's FormData takes this shape for a file rather than a Blob —
  // the uri is a local file path the bridge streams from, so the photo is never
  // held in JS memory as bytes.
  form.append('image', {
    uri: input.uri,
    name: 'machine.jpg',
    type: input.mimeType,
  } as unknown as Blob);

  return apiRequest<IdentifyResponse>(getToken, '/exercises/identify', {
    method: 'POST',
    body: form,
  });
}

/**
 * The copy for a failed identification.
 *
 * Separate from the screen so it can be tested without rendering, and because
 * the distinction it draws is the one most easily lost: **a 422 is not an
 * error the athlete caused, and it is not worth retrying.** The server read the
 * photo and no machine on the shortlist matched — the remedy is a different
 * photo, not the same request again.
 *
 * Deliberately not reusing the shared network-flavoured fallback: its wording
 * sends somebody to check their signal, which is the wrong diagnosis for every
 * case here except the last one.
 */
export function identifyErrorMessage(err: unknown): string {
  const status = (err as { status?: number } | null)?.status;
  switch (status) {
    case 422:
      // The honest one. Naming what would help is the whole value of this
      // message — "could not identify" alone leaves the athlete pressing the
      // same button on the same machine.
      return 'Could not tell which machine that is. Try a straighter shot of the whole machine, with the label in frame.';
    case 429:
      return 'That is a lot of photos in a short while. Give it a few minutes, or search for the exercise instead.';
    case 400:
      return 'That photo could not be read. Try taking another.';
    case 503:
      return 'Machine recognition is unavailable right now. Search for the exercise instead.';
    default:
      return 'Could not reach the server. Try again when you have signal, or search for the exercise instead.';
  }
}

/**
 * Whether a failure is worth offering a retry for.
 *
 * **A 422 is deterministic**: the same photo produces the same refusal, so a
 * "try again" button on that path is a button that cannot work. It offers
 * "retake" instead, which is a different action, and the distinction matters
 * because the two are one word apart in the UI and opposite in effect.
 */
export function isRetryable(err: unknown): boolean {
  const status = (err as { status?: number } | null)?.status;
  return status !== 422 && status !== 400 && status !== 429;
}
