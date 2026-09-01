import { apiRequest } from './apiRequest';
import { netFetch, SLOW_REQUEST_TIMEOUT_MS } from './authedFetch';
import type { TokenGetter } from './useAuthToken';

/**
 * BJJ rank, client half of `internal/modules/bjj`.
 *
 * `current` on {@link Standing} is DERIVED server-side from `promotions`, not
 * stored — see the backend's `StandingFrom`. This client never computes a
 * rank itself, for the same reason the server doesn't let a date decide it:
 * two independent derivations are two chances to disagree.
 */
export type Belt = 'white' | 'blue' | 'purple' | 'brown' | 'black';

/** Belts, in rank order — for a picker that doesn't hardcode the list again. */
export const BELTS: Belt[] = ['white', 'blue', 'purple', 'brown', 'black'];

export const MAX_STRIPES = 4;
export const MAX_DEGREE = 6;

export type Rank = {
  belt: Belt;
  stripes: number;
  /** Black-belt degrees. 0 on every other belt. */
  degree: number;
};

/** What the add/edit form sends — a Rank plus the promotion's own facts. */
export type PromotionInput = Rank & {
  /** "YYYY-MM-DD", or null when the athlete doesn't remember. */
  promoted_on: string | null;
  academy: string;
  instructor: string;
  note: string;
};

export type Promotion = PromotionInput & {
  id: string;
  /**
   * A presigned link that **expires** — see the backend handler. Never cache
   * it: a stored one is a broken image with extra steps. Absent when there is
   * no photo attached, or the environment has no object storage configured. A
   * promotion with no photo is exactly as valid a record as one with one; see
   * `promoted_on`'s own "undated promotion still establishes rank" reasoning.
   */
  photo_url?: string;
  created_at: string;
  updated_at: string;
};

export type Standing = {
  /** Null means no rank recorded — a real state, not a loading placeholder. */
  current: Rank | null;
  time_at_current_days: number | null;
  promotions: Promotion[];
};

/**
 * The promotion that awarded the rank the athlete currently holds.
 *
 * `Standing.current` is a Rank — belt, stripes, degree — and carries no
 * academy or date, because the server derives it as the *highest* recorded
 * rank rather than the latest row. The school and the date live on the
 * `Promotion` that granted it, so it has to be found by matching.
 *
 * Ties broken by the latest `promoted_on`, with undated promotions ranking
 * last: a rank entered twice (a correction, a re-entry) should show the date
 * the athlete most recently stated, and a dated record is better evidence than
 * an undated one whatever order they were typed in.
 *
 * Returns null when nothing matches — reachable, since the rank can be derived
 * from a promotion the athlete has since edited. The header then shows the
 * belt alone rather than inventing a school.
 */
export function awardingPromotion(standing: Standing): Promotion | null {
  const { current, promotions } = standing;
  if (!current) return null;
  const matches = promotions.filter(
    (p) => p.belt === current.belt && p.stripes === current.stripes && p.degree === current.degree,
  );
  if (matches.length === 0) return null;
  return matches.reduce((best, p) => {
    if (!p.promoted_on) return best;
    if (!best.promoted_on) return p;
    return p.promoted_on > best.promoted_on ? p : best;
  });
}

/**
 * "12 Mar 2024" — a promotion is a date you remember, not a timestamp.
 *
 * Short month deliberately: spelled out, "12 March 2024" overruns a third of a
 * phone's width and renders as "March 12, 20…", which loses the year — the one
 * part of a promotion date anybody actually quotes.
 */
export function formatAwardDate(day: string): string {
  // Parsed from parts rather than `new Date(day)`, which reads a bare
  // YYYY-MM-DD as UTC midnight and renders as the previous day west of
  // Greenwich — the same trap the plan module documents.
  const [y, m, d] = day.split('-').map(Number);
  if (!y || !m || !d) return day;
  return new Date(y, m - 1, d).toLocaleDateString(undefined, {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
}

export function getStanding(getToken: TokenGetter): Promise<Standing> {
  return apiRequest<Standing>(getToken, '/bjj/standing');
}

export function createPromotion(
  getToken: TokenGetter,
  input: PromotionInput,
): Promise<Promotion> {
  return apiRequest<Promotion>(getToken, '/bjj/promotions', {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export function updatePromotion(
  getToken: TokenGetter,
  id: string,
  input: PromotionInput,
): Promise<Promotion> {
  return apiRequest<Promotion>(getToken, `/bjj/promotions/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: JSON.stringify(input),
  });
}

export function deletePromotion(getToken: TokenGetter, id: string): Promise<void> {
  return apiRequest<void>(getToken, `/bjj/promotions/${encodeURIComponent(id)}`, {
    method: 'DELETE',
  });
}

type PromotionUploadTicket = {
  upload_url: string;
  content_type: string;
  max_bytes: number;
  expires_in: number;
  promotion: Promotion;
};

/**
 * Attach or replace a promotion's photo. Same two-step shape as
 * `body.ts`'s `uploadCheckinPhoto` and for the same reason: the bytes never
 * touch our API, only a short-lived signed URL does.
 *
 * **Unlike a check-in, the promotion must already exist** — there is no
 * date-keyed upsert to fall back on, so this can only be called with a real
 * id. A brand-new promotion is created first (`createPromotion`), and only
 * then can a photo be attached to the id it returns.
 *
 * The `promotion` on the returned ticket deliberately has an EMPTY
 * `photo_url` — see the backend handler's own comment: the key is
 * deterministic for this promotion, so presigning it here would resolve to
 * whatever was at that key before this upload finished. Callers that need to
 * display the fresh photo re-fetch (`getStanding`) after this resolves.
 */
export async function uploadPromotionPhoto(
  getToken: TokenGetter,
  id: string,
  localUri: string,
): Promise<Promotion> {
  const ticket = await apiRequest<PromotionUploadTicket>(
    getToken,
    `/bjj/promotions/${encodeURIComponent(id)}/photo`,
    { method: 'POST' },
  );

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
    // The slow budget, not the default: a multi-megabyte PUT to object
    // storage over whatever the gym's wifi is doing.
    { timeoutMs: SLOW_REQUEST_TIMEOUT_MS },
  );
  if (!res.ok) {
    throw new Error(`Couldn't upload that photo (${res.status}).`);
  }
  return ticket.promotion;
}

/**
 * The obvious next step from a current rank — one more stripe, or the next
 * belt once a stripe run is full.
 *
 * A suggestion for the add-promotion form to start from, not a value the
 * server ever sees or trusts: the athlete can change every field before
 * saving, and a jump (three stripes to a new belt, say) is exactly the case
 * this exists to make one tap instead of five.
 *
 * Black is degrees, not stripes — advancing past `MAX_DEGREE` has nowhere
 * further to go, so it holds rather than wrapping to white.
 */
export function nextRank(current: Rank): Rank {
  if (current.belt === 'black') {
    return { belt: 'black', stripes: 0, degree: Math.min(current.degree + 1, MAX_DEGREE) };
  }
  if (current.stripes < MAX_STRIPES) {
    return { belt: current.belt, stripes: current.stripes + 1, degree: 0 };
  }
  const next = BELTS[Math.min(BELTS.indexOf(current.belt) + 1, BELTS.length - 1)];
  return { belt: next, stripes: 0, degree: 0 };
}

/**
 * "3 years", "6 months", "12 days" — the coarsest unit that doesn't round to
 * zero. Matches how a grappler actually states time at a belt; nobody says
 * "1,097 days".
 */
export function describeTimeAtBelt(days: number): string {
  const years = Math.floor(days / 365);
  if (years >= 1) return `${years} ${years === 1 ? 'year' : 'years'}`;
  const months = Math.floor(days / 30);
  if (months >= 1) return `${months} ${months === 1 ? 'month' : 'months'}`;
  return `${days} ${days === 1 ? 'day' : 'days'}`;
}
