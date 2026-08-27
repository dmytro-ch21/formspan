import { apiRequest } from './apiRequest';
import type { TokenGetter } from './useAuthToken';

/**
 * The social graph client: look a handle up, ask, answer, and list.
 *
 * ONLINE-ONLY, deliberately, and that is a real divergence from this app's
 * offline-first spine. The outbox exists so an athlete's OWN training survives
 * a gym dead-spot; a friend request is a message to another person, and
 * queueing one against a stale cache means asking someone who already answered
 * or renamed. Every call here surfaces its failure honestly instead — the
 * OfflineError copy is written for humans, and the screen shows it.
 */

export type FriendCard = {
  username: string;
  display_name: string | null;
  /**
   * A short-lived presigned URL to this person's uploaded avatar (N205).
   * Absent — never null — when they have no avatar; `Avatar` falls back to
   * the monogram on its own, so a screen just passes this straight through.
   */
  avatar_url?: string;
  /** Accepted-at for friends; requested-at for pending rows. */
  since: string;
};

export type FriendRequests = {
  incoming: FriendCard[];
  outgoing: FriendCard[];
};

export type PublicProfile = {
  username: string;
  display_name: string | null;
  avatar_url?: string;
};

/** Exact-match handle lookup — the search half of this screen. */
export function lookupUser(
  getToken: TokenGetter,
  username: string,
  signal?: AbortSignal,
): Promise<PublicProfile> {
  return apiRequest<PublicProfile>(
    getToken,
    `/users/${encodeURIComponent(username.trim().toLowerCase())}`,
    { signal },
  );
}

export function sendFriendRequest(getToken: TokenGetter, username: string): Promise<void> {
  return apiRequest<void>(getToken, '/friends/requests', {
    method: 'POST',
    body: JSON.stringify({ username }),
  });
}

export function listFriends(getToken: TokenGetter, signal?: AbortSignal): Promise<FriendCard[]> {
  return apiRequest<{ friends: FriendCard[] }>(getToken, '/friends', { signal }).then(
    (b) => b.friends ?? [],
  );
}

export function listRequests(getToken: TokenGetter, signal?: AbortSignal): Promise<FriendRequests> {
  return apiRequest<FriendRequests>(getToken, '/friends/requests', { signal });
}

export function acceptRequest(getToken: TokenGetter, username: string): Promise<void> {
  return apiRequest<void>(
    getToken,
    `/friends/requests/${encodeURIComponent(username)}/accept`,
    { method: 'POST' },
  );
}

/** Decline, cancel or unfriend — the server treats all three as "this
 *  relationship, gone", and this screen knows which one it offered. */
export function removeFriend(getToken: TokenGetter, username: string): Promise<void> {
  return apiRequest<void>(getToken, `/friends/${encodeURIComponent(username)}`, {
    method: 'DELETE',
  });
}

/** What is waiting for you, keyed by source.
 *
 * Derived server-side from the pending rows themselves — there is no
 * notifications table and no read/unread state, so ANSWERING a request is the
 * only thing that clears it. That is why this can be fetched on focus without
 * any local reconciliation: it cannot be stale in the way a cached unread flag
 * can, only out of date.
 *
 * ONLINE-ONLY, like the rest of this screen's social calls. A failed fetch
 * must leave the previous number alone rather than zero it: a badge is
 * believed, and "0" asserts that nothing is waiting.
 */
/**
 * Whether a freshly-fetched pending count should announce itself.
 *
 * Two rules, and both are the difference between a useful cue and an annoying
 * one:
 *
 * **A first count never announces.** `prev` is null until something has been
 * counted at least once, so opening the app to three waiting requests is
 * silent — they were already there, and a chime would be claiming they just
 * arrived. Only a rise from a number we have already seen means "new".
 *
 * **Only a rise.** Answering a request lowers the count, and celebrating your
 * own inbox getting shorter would be nonsense.
 *
 * Note what is NOT here: a failed fetch. The caller must leave `prev`
 * untouched on error, because the count endpoint is online-only and a network
 * blip resolving to 0 would first go silent (a fall) and then chime on the
 * next success (a rise) — announcing an arrival that never happened.
 */
export function announcesArrival(prev: number | null, next: number): boolean {
  return prev !== null && next > prev;
}

/**
 * The same rule across every badged source: any one rising is news.
 *
 * Per-source rather than on the total, because a total hides a SWAP — answer a
 * friend request in the same window a share arrives and the total is unchanged
 * while something genuinely new is sitting there. A missed chime is a benign
 * failure and a false one is not, so a total would have been defensible; this
 * costs one loop and avoids both.
 *
 * `prev[k] ?? 0` only matters if a source key appears that was not there
 * before, which the caller's fixed-shape object prevents today. If a third
 * source is ever added, first sight of it will compare against zero and chime
 * — which is the right answer for "something new is waiting" and the wrong one
 * for "the server just started reporting a source it always had". Worth
 * knowing before adding one.
 */
export function anyArrived(
  prev: Record<string, number> | null,
  next: Record<string, number>,
): boolean {
  if (prev === null) return false;
  return Object.keys(next).some((k) => announcesArrival(prev[k] ?? 0, next[k]));
}

export async function getPendingCounts(
  getToken: TokenGetter,
  signal?: AbortSignal,
): Promise<Record<string, number>> {
  const body = await apiRequest<{ pending: Record<string, number> }>(
    getToken,
    '/notifications',
    { signal },
  );
  return body.pending ?? {};
}
