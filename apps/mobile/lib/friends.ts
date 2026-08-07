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
