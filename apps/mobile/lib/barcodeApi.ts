/**
 * Resolve a scanned barcode into a food.
 *
 * ## The three outcomes, and why they are a union rather than an exception
 *
 * A lookup has three honest endings and only one of them is an error:
 *
 * - **`found`** — the catalog knows this packet. Its macros are what is
 *   PRINTED ON THE PACK, not a guess.
 * - **`unknown`** — the server answered, and it genuinely does not have this
 *   one. An ordinary outcome, not a failure.
 * - **it threw** — we could not ask. Offline, or the server broke.
 *
 * The middle one is returned rather than thrown precisely so a caller cannot
 * accidentally collapse it into the third. Those two render as the same
 * rejected promise if `unknown` is an exception, and the screen then has to
 * re-derive the difference from a status code — which is how "I could not ask"
 * ends up on screen as "we do not have this one", stating something false
 * about the catalog because the wifi was bad. This repo has shipped that class
 * of bug more than once; `apiError.ts`'s own `isNotFound` note is about the
 * same mistake in the profile screen.
 *
 * ## What N41 does and does not own
 *
 * This module is a CLIENT. The endpoint below is N42's to build, along with
 * the on-demand Open Food Facts fetch behind it and the shared cache it writes
 * to. N41 is the phone half: the scanner, the draft, and the confirm.
 */

import { ApiError, isNotFound } from './apiError';
import { apiRequest } from './apiRequest';
import type { Macros } from './nutrition';
import type { TokenGetter } from './useAuthToken';

/**
 * A food a barcode resolved to.
 *
 * Shaped to drop straight into a log entry, same reasoning as
 * `estimateApi.itemToEntry` — the draft's shape being the log's shape is what
 * makes confirming one tap instead of a translation.
 *
 * Note there is no confidence field and no assumption field, and that is the
 * point rather than an omission: those two exist on an ESTIMATE because a
 * model had to guess at a quantity. A barcode's macros are a fact off the
 * packet. Rendering a confidence badge beside them would be inventing doubt.
 */
export type ScannedFood = Macros & {
  name: string;
  brand: string;
  /** What one serving IS, as the packet states it: "100 g", "1 bar (45 g)". */
  serving_label: string;
  /** Null where the packet gives no honest gram weight. Never invented. */
  serving_grams: number | null;
};

/**
 * Where the answer came from.
 *
 * Surfaced because the two are not equally trustworthy and the athlete is
 * entitled to know which they are looking at: `catalog` is a curated row,
 * `off` is crowd-sourced from Open Food Facts and can be wrong in ways a
 * curated row is not.
 */
export type ScanSource = 'catalog' | 'off';

/**
 * Where a CACHED row came from — the lookup's two sources, plus one the server
 * never sends.
 *
 * `ai` is a food the athlete reached by describing or photographing a packet
 * the catalog did not have, then confirmed. It is cached against the barcode
 * so the next scan of that packet finds something, and it is kept as its own
 * value because **it must stay permanently distinguishable from a figure read
 * off a label.**
 *
 * That is not fastidiousness. N40 measured the estimator doubling a quantity
 * and reporting `medium` confidence with no hedge, while flagging an item it
 * had invented three separate ways — it cannot tell you which of its own
 * numbers to distrust. Letting an AI-drafted row wear `off`'s or `catalog`'s
 * provenance would hand a guess the credibility of a fact, in the one screen
 * built on the premise that a barcode's numbers are facts.
 */
export type CachedSource = ScanSource | 'ai';

export type BarcodeLookup =
  | { status: 'found'; food: ScannedFood; source: ScanSource }
  /** The server answered and has nothing. `code` is echoed back for the copy. */
  | { status: 'unknown'; code: string };

type BarcodeResponse = { food: ScannedFood; source: ScanSource };

/**
 * Ask the server what this barcode is.
 *
 * Throws `OfflineError` when the phone could not ask at all, and `ApiError`
 * for any answer that is not a clean hit or a clean `not_found` — both of
 * which the caller must render differently from `unknown`.
 *
 * **A 404 is only read as `unknown` when it carries the contract's error
 * envelope.** An unrouted path also 404s, and treating that as "we do not have
 * this one" would tell every athlete the catalog lacked their food when the
 * truth is the endpoint is not deployed. `apiRequest` fills `code` with
 * `'unknown'` when a response has no envelope to read, which is what separates
 * the two here.
 */
export async function lookupBarcode(
  getToken: TokenGetter,
  code: string,
): Promise<BarcodeLookup> {
  try {
    const res = await apiRequest<BarcodeResponse>(
      getToken,
      `/nutrition/catalog/barcode/${encodeURIComponent(code)}`,
    );
    return { status: 'found', food: res.food, source: res.source };
  } catch (err) {
    if (isNotFound(err) && err instanceof ApiError && err.code === 'not_found') {
      return { status: 'unknown', code };
    }
    throw err;
  }
}
