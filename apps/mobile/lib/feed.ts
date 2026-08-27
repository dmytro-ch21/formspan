import { apiRequest } from './apiRequest';
import { formatDuration } from './history';
import type { CardData } from './sessionCard';
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
  /**
   * A short-lived presigned URL to the owner's uploaded avatar (N205).
   * Absent — never null — when they have no avatar; `Avatar` falls back to
   * the monogram on its own, so `FeedRow` just passes this straight through.
   */
  avatar_url?: string;
  sport: string;
  name: string;
  started_at: string;
  /** Never null: unfinished sessions are excluded server-side. */
  ended_at: string;
  working_sets: number;
  tonnage_kg: number;
  /**
   * What was actually done — up to five exercises or techniques.
   *
   * EMPTY unless the owner turned `share_training_details` on, which is a
   * second opt-in separate from the one that puts them in the feed at all.
   * Empty rather than absent, and rendered identically to an empty session on
   * purpose: a client that drew "this athlete has details hidden" would
   * advertise who has the switch off.
   *
   * Optional on the type only so a client built against the older response
   * shape still parses — read it through `?? []`, never assume it is there.
   */
  detail?: FeedDetail[];
  /** How many names `detail` left out, for a "+4 more" line. */
  more?: number;
};

/**
 * One line of what was done.
 *
 * The same wire shape as the session card's own detail, because ONE component
 * renders both — with one difference the server enforces: a feed row never
 * carries a `conceded` outcome. What was done TO you is the half of a roll
 * worth reviewing on your own card, and a friend's feed is not where it goes.
 */
export type FeedDetail = {
  name: string;
  /** Strength: the top working set, e.g. "140 kg × 5". */
  figure?: string;
  /** BJJ: `scored`, `attempted` or `drilled`. Never `conceded`. */
  outcome?: string;
  /** BJJ: how many times, when more than one. */
  count?: number;
};

export type FeedPage = {
  items: FeedItem[];
  total: number;
  limit: number;
  offset: number;
  /**
   * How far back the feed reaches, in days (N13). The ONE place to read
   * this — the window used to be stated as a bare "3 days" in two separate
   * strings on this screen, with nothing tying either to the server's real
   * constant. Read it off every response rather than hardcoding a number in
   * copy; it is present on every page, including an empty first page.
   */
  window_days: number;
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

/**
 * A feed row as the poster card renders it.
 *
 * The feed and the completion screen show THE SAME CARD. That is the whole
 * point of the redesign — the thing you are proud of at the end of a session
 * is the thing your training partners see — and it is why `SessionCard` takes
 * a plain `CardData` and reads nothing from a screen.
 *
 * ## What a friend's card cannot carry, and why it is not an oversight
 *
 * **No calories and no VOLA Score.** Both exist on your own card and neither
 * may appear on somebody else's, because of where they come from rather than
 * how interesting they are:
 *
 *   - The calorie estimate is computed from the owner's bodyweight, height,
 *     age and sex. Publishing it publishes an inference about their body, and
 *     nobody opted into that by opting into a feed.
 *   - The score is a percentile against the owner's OWN last twenty sessions,
 *     so it is only meaningful next to a history the reader cannot see. "78"
 *     with no baseline is a number that invites comparison between people,
 *     which this app has no leaderboards precisely to avoid.
 *
 * So the strip is the three things a feed row has always carried — time, sets,
 * volume — and the card is complete without the other two.
 *
 * ## No badges either
 *
 * A PR is derived from the owner's history and the feed row does not carry it.
 * Rather than infer one, the card simply gets none, which is already its
 * commonest state.
 *
 * `units` and `now` are threaded in rather than read from providers, so this
 * stays pure and testable — the same rule `feedMetrics` and `agoLabel` follow.
 */
export function cardFromFeedItem(item: FeedItem, units: UnitSystem, now: number): CardData {
  const metrics = feedMetrics(item, units);
  return {
    id: item.id,
    sport: item.sport,
    title: item.name || labelForSport(item.sport),
    eyebrow: item.sport === 'bjj' ? 'BJJ' : item.sport.toUpperCase(),
    // WHEN, not the date. A feed is scanned for recency — "2h ago" is the
    // question being asked — where a card kept on your own session is a
    // record of a day and gets the date.
    dateLabel: agoLabel(item.ended_at, now).toUpperCase(),
    stats: metrics.map((m) => ({ label: m.label, value: m.value })),
    detail: item.detail ?? [],
    more: item.more ?? 0,
    // Never a badge on somebody else's card — see above.
    badges: [],
    // No handle: the row already carries the person in its header, and the
    // card's foot falling back to the wordmark is what makes a feed of these
    // read as posters rather than as repeated signatures.
  };
}

/** A sport's own word, for a session that was never named. */
function labelForSport(sport: string): string {
  return sport === 'bjj' ? 'BJJ session' : 'Training';
}
