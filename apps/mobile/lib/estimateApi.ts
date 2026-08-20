import { transportDiagnosis } from './apiError';
import { apiRequest } from './apiRequest';
import { UPLOAD_TIMEOUT_MS } from './authedFetch';
import type { Macros, Meal } from './nutrition';
import type { TokenGetter } from './useAuthToken';

/**
 * Describe a meal, or photograph it, and get a draft to correct.
 *
 * ## A draft, never an entry
 *
 * Nothing here logs anything. The response fills a form the athlete edits and
 * confirms, and confirming goes through the ordinary offline outbox — so a
 * drafted meal becomes exactly the same kind of row as a typed one, with no
 * marker saying a model was involved. That is deliberate: what was eaten is
 * what the athlete said was eaten, whoever typed it first.
 *
 * ## Text first
 *
 * The text path costs a fraction of the photo path and covers most logging.
 * The camera is the fallback for a meal you cannot describe, not the front
 * door — which is why `describe` takes no image at all and the photo call is a
 * separate function rather than an optional argument.
 */

/** How sure the model is about the QUANTITY — never about what the food is. */
export type PortionConfidence = 'high' | 'medium' | 'low';

export type EstimatedItem = Macros & {
  name: string;
  serving_label: string;
  servings: number;
  portion_confidence: PortionConfidence;
  /**
   * The judgement the model had to make to give a number at all — "assumed a
   * medium egg". This is what tells the athlete WHICH field to correct, and it
   * is the reason a wrong estimate is fixable rather than just wrong.
   */
  assumption: string;
};

export type MealEstimate = {
  items: EstimatedItem[];
  /** What the model could not see. Empty is normal, not an error. */
  note: string;
  model: string;
  source: 'text' | 'photo';
};

export type EstimateQuota = {
  used: number;
  limit: number;
  remaining: number;
  /** When one more becomes available. Null when nothing is used. */
  resets_at: string | null;
};

/**
 * ONE budget covers both paths.
 *
 * There used to be a `source` field here, because the server capped photos and
 * descriptions separately. It no longer does — measured on the shipped model, a
 * photo costs ~1.2-1.5x a description of the SAME meal, while the number of
 * items in the meal moves the bill ~5x, so the split was rationing the wrong
 * thing. The field is gone rather than ignored: rendering "3 of 25 photos" from
 * a combined budget states something false about what the athlete may do next.
 */

export type EstimateResponse = {
  estimate: MealEstimate;
  quota: EstimateQuota;
};

/** Describe a meal in words. The cheap path, and the one to reach for first. */
export function describeMeal(
  getToken: TokenGetter,
  input: { description: string; meal?: Meal },
): Promise<EstimateResponse> {
  return apiRequest<EstimateResponse>(getToken, '/nutrition/estimate', {
    method: 'POST',
    body: JSON.stringify({ description: input.description, meal: input.meal ?? null }),
  });
}

/**
 * Photograph a meal.
 *
 * Multipart rather than base64-in-JSON, because base64 inflates a 5 MB photo
 * to 6.7 MB on the wire for no benefit. **The Content-Type header is
 * deliberately not set here** — `apiRequest` skips it for FormData so the
 * runtime can append the boundary token, and setting it by hand produces a
 * body the server cannot parse.
 */
export function photographMeal(
  getToken: TokenGetter,
  input: { uri: string; mimeType: string; description?: string; meal?: Meal },
): Promise<EstimateResponse> {
  const form = new FormData();
  // React Native's FormData takes this shape for a file rather than a Blob —
  // the uri is a local file path the bridge streams from, so the photo is
  // never held in JS memory as bytes.
  form.append('image', {
    uri: input.uri,
    name: 'meal.jpg',
    type: input.mimeType,
  } as unknown as Blob);
  if (input.description) form.append('description', input.description);
  if (input.meal) form.append('meal', input.meal);

  return apiRequest<EstimateResponse>(
    getToken,
    '/nutrition/estimate',
    { method: 'POST', body: form },
    // A photo plus a provider round trip is the slowest thing the app asks
    // for; the default deadline is sized for a JSON read.
    { timeoutMs: UPLOAD_TIMEOUT_MS },
  );
}

/**
 * The copy for a failed estimate.
 *
 * ## Why this exists at all (N55)
 *
 * The screen used to render `err.message` directly, with a fallback of *"Could
 * not reach the server. Try again when you have signal."* Two things went
 * wrong with that, and only one of them was the fallback:
 *
 * - **The 503.** The route answers 503 when the deploy has no provider key —
 *   a deliberate "this is not switched on here", by the handler's own comment.
 *   Passing the server's message through showed the athlete *"meal estimation
 *   is not available"* with no explanation and no route forward, and left them
 *   to work out that typing the meal in still works. It is not an outage and
 *   it is emphatically not a connection problem.
 * - **The transport.** A dead request has no status and no server message, so
 *   it took the network-flavoured fallback whatever had actually happened.
 *
 * ## What it deliberately does not map
 *
 * Only those two. Everything else the server answers keeps **its own**
 * message, because those messages are written for the athlete and several
 * carry information this file cannot reconstruct: the 429 says *"you have used
 * all 25 estimates for today — one more in 20 minutes"*, and a mapped
 * "you're out of estimates" would throw the reset away. Substituting copy for
 * a server that already answered well is a loss, not a fix.
 *
 * A message is never pattern-matched, per the API conventions — the two
 * branches that exist turn on the status and on the error's own class.
 */
export function estimateErrorMessage(err: unknown): string {
  const diagnosis = transportDiagnosis(err);
  if (diagnosis) return `${diagnosis} Enter the food by hand instead.`;

  const status = (err as { status?: number } | null)?.status;
  if (status === 503) {
    return "Estimating meals isn't switched on here yet. Enter the food by hand.";
  }

  // The server answered. Show what it said — and NOT a network fallback,
  // which is what this screen used to reach for when it had no message.
  const message = err instanceof Error ? err.message : '';
  return message || 'That did not work. Enter the food by hand instead.';
}

/**
 * Turn a draft item into something the log can take.
 *
 * The draft's shape is already the log's shape — that is not a coincidence,
 * it is what makes confirming a one-tap action rather than a translation. The
 * only thing dropped is `portion_confidence` and `assumption`: they are about
 * how the number was arrived at, and a logged entry records what was eaten,
 * not how confident a model was about it. Keeping them would put a model's
 * uncertainty into the athlete's own history.
 */
export function itemToEntry(it: EstimatedItem): Macros & {
  name: string;
  servings: number;
  serving_label: string;
} {
  return {
    name: it.name,
    servings: it.servings,
    serving_label: it.serving_label,
    kcal: it.kcal,
    protein_g: it.protein_g,
    carb_g: it.carb_g,
    fat_g: it.fat_g,
    fibre_g: it.fibre_g,
  };
}
