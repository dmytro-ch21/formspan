import { apiRequest } from './apiRequest';
import { formatDuration } from './history';
import { formatVolume, type UnitSystem } from './units';
import type { TokenGetter } from './useAuthToken';

/**
 * What your training partners have been doing.
 *
 * ONLINE-ONLY, like the rest of the social surface and for the same reason:
 * the offline outbox exists so an athlete's OWN training survives a gym
 * dead-spot. A feed is other people's data, and a cached one is a claim about
 * what they have been doing lately that gets less true every hour. It shows
 * its failure instead.
 *
 * **MOBILE ONLY**, deliberately. The web app sees shared content and manages
 * friends; posts and feeds are a phone thing, the same way live logging is.
 * There is no `apps/web` counterpart to this file and there should not be one.
 *
 * A row is the smallest thing that makes a card — who, what, when, and roughly
 * how much. No sets, no notes, no RPE, no exercise ids: a feed says *that*
 * somebody trained, not what their programme is. Enlarging it is a privacy
 * decision rather than a feature.
 */

export type FeedItem = {
  /**
   * The session's id. A KEY, not a handle to fetch with — no endpoint accepts
   * it from anyone but its owner, so there is nothing to navigate to.
   */
  id: string;
  /** The owner's handle, resolved live, so a rename propagates. */
  from: string;
  display_name: string | null;
  sport: string;
  name: string;
  started_at: string;
  /** Never null: unfinished sessions are excluded server-side. */
  ended_at: string;
  working_sets: number;
  tonnage_kg: number;
};

export type FeedPage = {
  items: FeedItem[];
  total: number;
  limit: number;
  offset: number;
};

/** Matches the server's own default. Stated here so the first request does not
 *  depend on an unstated agreement about page size. */
export const FEED_PAGE = 30;

export function fetchFeed(
  getToken: TokenGetter,
  { limit = FEED_PAGE, offset = 0 }: { limit?: number; offset?: number } = {},
  signal?: AbortSignal,
): Promise<FeedPage> {
  return apiRequest<FeedPage>(
    getToken,
    `/feed?limit=${limit}&offset=${offset}`,
    { signal },
  );
}

/**
 * How long ago, in the shortest honest words.
 *
 * A feed is scanned, so "2h" beats "at 14:32" — the question is how recent,
 * not when exactly. Pure, and `now` is a parameter rather than `Date.now()`
 * so it can be tested at all: a relative formatter that reads the clock itself
 * is a function whose output changes while you assert on it.
 *
 * Rounds DOWN throughout. "1h" the moment an hour has passed, never "1h" at 55
 * minutes — a feed that rounds up says things happened before they did.
 */
export function agoLabel(endedAt: string, now: number): string {
  const then = Date.parse(endedAt);
  if (Number.isNaN(then)) return '';
  const seconds = Math.floor((now - then) / 1000);
  // A clock skew between phone and server can put a finish slightly in the
  // future. "in 3 minutes" on a finished session reads as a bug, so anything
  // not yet a minute old — in either direction — is simply "now".
  if (seconds < 60) return 'just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  const weeks = Math.floor(days / 7);
  if (weeks < 5) return `${weeks}w ago`;
  // Past a month the exact number stops being the point.
  const months = Math.floor(days / 30);
  return months < 12 ? `${months}mo ago` : 'over a year ago';
}

/**
 * The chips under a feed row's title.
 *
 * OMITTED RATHER THAN ZEROED, which is the rule the Today tab's session cards
 * already follow: "0 sets" on a BJJ session reads as abandoned, when the truth
 * is that sets are not how that discipline is measured. A missing chip says
 * nothing; a zero says something false.
 *
 * **`formatVolume` and `formatDuration`, not local arithmetic.** Both were
 * reimplemented here first, and both diverged immediately: the duration read
 * "1h 0m" where the rest of the app reads "1h", and the volume was hardcoded
 * `kg` — so an imperial athlete would have read their friends' training in a
 * unit they never use, on the one surface where the numbers are somebody
 * else's and therefore hardest to sanity-check. `units.ts` states the rule
 * this broke: storage is kilograms and conversion happens at the last possible
 * moment on the way out.
 *
 * `units` is threaded in rather than read from a provider so this stays pure.
 */
export function feedMetrics(item: FeedItem, units: UnitSystem): { label: string; value: string }[] {
  const out: { label: string; value: string }[] = [];
  const seconds = (Date.parse(item.ended_at) - Date.parse(item.started_at)) / 1000;
  if (Number.isFinite(seconds) && seconds >= 60) {
    out.push({ label: 'time', value: formatDuration(seconds) });
  }
  if (item.working_sets > 0) {
    out.push({ label: 'sets', value: String(item.working_sets) });
  }
  if (item.tonnage_kg > 0) {
    out.push({ label: 'volume', value: formatVolume(item.tonnage_kg, units) });
  }
  return out;
}
