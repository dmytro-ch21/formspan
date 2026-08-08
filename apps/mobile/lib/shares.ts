import { apiRequest } from './apiRequest';
import type { TokenGetter } from './useAuthToken';

/**
 * Sending a training partner a copy of something, and answering what they sent.
 *
 * ONLINE-ONLY, for the same reason `friends.ts` is and against the same
 * offline-first spine: the outbox exists so an athlete's OWN training survives
 * a gym dead-spot, and a share is a message to another person. Queueing one
 * against a stale cache means sending a plan you have since rewritten, to
 * somebody who may have unfriended you — and accepting offline is worse still,
 * because the copy is made SERVER-SIDE inside a transaction this device cannot
 * hold. Every call here surfaces its failure honestly instead.
 *
 * GENERIC, mirroring the API. `resource_type` is a string rather than a union
 * because the server's registry is what decides which kinds exist, and a union
 * here would have to be edited in lockstep with a Go map for no benefit — a
 * kind this build has never heard of still renders, just without a destination.
 */

export type ShareCard = {
  id: string;
  resource_type: string;
  resource_label: string;
  /** The sender's handle, joined live server-side, so a rename propagates. */
  from: string;
  created_at: string;
};

export type SentShareCard = {
  id: string;
  resource_type: string;
  resource_label: string;
  /** The recipient's handle. Named `to`, not a neutral `counterpart` — one
   *  struct with a neutral field made every client render "shared with" over
   *  an inbox row. */
  to: string;
  created_at: string;
};

/** What accepting hands back: enough to navigate to YOUR OWN new copy. */
export type Accepted = {
  resource_type: string;
  resource_id: string;
};

export function shareResource(
  getToken: TokenGetter,
  toUsername: string,
  resourceType: string,
  resourceID: string,
): Promise<void> {
  return apiRequest<void>(getToken, '/shares', {
    method: 'POST',
    body: JSON.stringify({
      to_username: toUsername,
      resource_type: resourceType,
      resource_id: resourceID,
    }),
  });
}

export function listShareInbox(
  getToken: TokenGetter,
  signal?: AbortSignal,
): Promise<ShareCard[]> {
  return apiRequest<{ shares: ShareCard[] }>(getToken, '/shares/inbox', { signal }).then(
    (b) => b.shares ?? [],
  );
}

/**
 * What the caller is still waiting on.
 *
 * PENDING ONLY, and the screen has to say so. Declining deletes the row, so if
 * accepted shares stayed listed, a row that vanished would mean "they declined"
 * — the one inference decline-is-delete exists to prevent.
 */
export function listSentShares(
  getToken: TokenGetter,
  signal?: AbortSignal,
): Promise<SentShareCard[]> {
  return apiRequest<{ shares: SentShareCard[] }>(getToken, '/shares/sent', { signal }).then(
    (b) => b.shares ?? [],
  );
}

export function acceptShare(getToken: TokenGetter, shareID: string): Promise<Accepted> {
  return apiRequest<Accepted>(getToken, `/shares/${encodeURIComponent(shareID)}/accept`, {
    method: 'POST',
  });
}

/** Declining, and the sender taking it back. One verb, because both are
 *  "this, gone" and the screen knows which one it offered. */
export function dismissShare(getToken: TokenGetter, shareID: string): Promise<void> {
  return apiRequest<void>(getToken, `/shares/${encodeURIComponent(shareID)}`, {
    method: 'DELETE',
  });
}

/**
 * Why this workout is not shareable yet, or null if it is.
 *
 * **Sharing copies what the SERVER holds**, and on this client that is
 * routinely not what is on screen. Three separate ways, each with a different
 * honest answer:
 *
 *   - `unsynced` — the row exists only on this phone (`remote = 0`). Its id is
 *     client-generated, so the server has never heard of it and the share would
 *     come back a flat 404 naming nothing the athlete did wrong. This is the
 *     ordinary state of a plan built in a gym with no signal.
 *   - `owed` — pushed once, but this device holds edits the server has not got
 *     (`dirty` / `name_dirty`). The recipient would get the old version.
 *   - `unsavedOnScreen` — edits not yet even written locally. The same gate
 *     "Start session" already has, and for the same reason.
 *
 * A pure function so the wording and the precedence are testable without a
 * database or a screen: the failure this exists to prevent is silent on both
 * sides — sender and recipient each believe it worked — so it cannot be caught
 * by using the app.
 */
export function shareBlockedReason(state: {
  unsynced: boolean;
  owed: boolean;
  unsavedOnScreen: boolean;
}): string | null {
  // Checked FIRST because it is the more fundamental miss: a plan the server
  // has never seen cannot be "saved" into shape by the Save button, and
  // telling someone to save what they already saved is the kind of advice that
  // makes an app feel broken.
  if (state.unsynced) return 'Not synced yet — this becomes shareable once it reaches the server.';
  if (state.owed || state.unsavedOnScreen) {
    return 'Save your changes first — sharing sends the saved version.';
  }
  return null;
}
