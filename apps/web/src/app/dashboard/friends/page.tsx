"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useAuth } from "@clerk/nextjs";

import {
  acceptRequest,
  isConflict,
  isNotFound,
  listFriends,
  listRequests,
  lookupUser,
  removeFriend,
  sendFriendRequest,
  type FriendCard,
  type FriendRequests,
  type PublicProfile,
} from "@/lib/api";
import { linkLabel, linkState } from "@/lib/friendLinks";

/**
 * Friends, on the web — search a handle, ask, answer, and see who said yes.
 *
 * **This existed only on the phone until now, and the gap was sharper than it
 * looked.** `ShareToFriend` has always been able to send a plan to a friend,
 * and its empty state told you to go and add one *on your phone* — so web
 * could use the social graph and not build it. The API was complete the whole
 * time; nothing was missing but this screen.
 *
 * It is a deliberate half of the platform split: **the social SURFACE — the
 * feed, posts, pictures — is mobile only.** Web sees shared content and
 * manages friends, and nothing else social. So this is friend management, and
 * there is no feed here.
 *
 * ## Mirrored from `apps/mobile/app/friends/index.tsx`, on purpose
 *
 * Same sections in the same order, and the same copy, because the copy is the
 * hard-won part: the exact-match explanation, the two-step remove, the
 * distinction between "no friends" and "we could not ask". Two screens that
 * word the same refusal differently teach an athlete that one of them is
 * lying.
 *
 * ## Online-only, like its mobile counterpart
 *
 * A friend request is a message to another person. There is no queue and no
 * optimistic write: failures surface as copy.
 */

/** An action key, so one busy flag can disable everything without a screen
 *  full of booleans — the mobile screen's shape. */
type ActionKey = string;

export default function FriendsPage() {
  const { getToken } = useAuth();

  const [friends, setFriends] = useState<FriendCard[] | null>(null);
  const [requests, setRequests] = useState<FriendRequests | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [query, setQuery] = useState("");
  const [result, setResult] = useState<PublicProfile | null>(null);
  const [searchState, setSearchState] = useState<
    "idle" | "searching" | "missing" | "error"
  >("idle");
  const [searchMessage, setSearchMessage] = useState<string | null>(null);

  const [actionError, setActionError] = useState<string | null>(null);
  const [busy, setBusy] = useState<ActionKey | null>(null);
  const [confirmingRemove, setConfirmingRemove] = useState<string | null>(null);

  /**
   * SINGLE-FLIGHT, and a correctness guard rather than tidiness.
   *
   * A first load stalled on a bad link would otherwise resolve AFTER a
   * mutation and repaint its pre-mutation lists over the new ones — the
   * request you just sent disappears and its Add button comes back. Only the
   * most recently STARTED load may land, and the signal check means a response
   * that beats its own abort still cannot set state.
   *
   * `mounted` is the second half, copied from `/dashboard/shared`: an action's
   * reload runs in a `finally` that can land after navigation, and `load()`
   * starts two fresh requests. The effect cleanup can only abort the flight
   * that exists when it runs.
   */
  const inflight = useRef<AbortController | null>(null);
  const mounted = useRef(true);

  const load = useCallback(() => {
    inflight.current?.abort();
    const c = new AbortController();
    inflight.current = c;
    return Promise.all([
      listFriends(getToken, c.signal),
      listRequests(getToken, c.signal),
    ])
      .then(([f, r]) => {
        if (c.signal.aborted) return;
        setFriends(f);
        setRequests(r);
        // Cleared on SUCCESS, so a retry after a failure does not leave its
        // error sitting above a working list.
        setLoadError(null);
      })
      .catch((err: unknown) => {
        if (c.signal.aborted || (err as Error)?.name === "AbortError") return;
        // A failed load leaves `friends` null, which must never render as
        // "no friends".
        setLoadError(err instanceof Error ? err.message : String(err));
      });
  }, [getToken]);

  useEffect(() => {
    mounted.current = true;
    void load();
    return () => {
      mounted.current = false;
      inflight.current?.abort();
    };
  }, [load]);

  const reload = useCallback(
    () => (mounted.current ? load() : undefined),
    [load],
  );

  const search = useCallback(async () => {
    // The Find button disables itself while searching; the Enter key does not,
    // and two lookups in flight resolve in whatever order the network feels
    // like — a slow earlier one overwriting a newer answer.
    if (searchState === "searching") return;
    const q = query.trim().toLowerCase();
    if (!q) return;
    setSearchState("searching");
    setSearchMessage(null);
    setResult(null);
    try {
      setResult(await lookupUser(getToken, q));
      setSearchState("idle");
    } catch (err) {
      if (isNotFound(err)) {
        setSearchState("missing");
        // The API's one-404-for-everything is deliberate; the copy here turns
        // it into instruction rather than mystery.
        setSearchMessage(
          `Nobody goes by “${q}”. Handles are exact — check the spelling with your friend.`,
        );
        return;
      }
      setSearchState("error");
      setSearchMessage(err instanceof Error ? err.message : String(err));
    }
  }, [getToken, query, searchState]);

  const act = useCallback(
    async (key: ActionKey, fn: () => Promise<void>) => {
      if (busy) return;
      setBusy(key);
      setActionError(null);
      try {
        await fn();
        await reload();
      } catch (err) {
        setActionError(err instanceof Error ? err.message : String(err));
        // These two say the other side already acted — they cancelled the
        // request you are accepting, or unfriended before your remove. The row
        // on screen is a ghost, so refresh rather than leaving a control that
        // can only fail again. Keep the message; only the lists are wrong.
        if (isNotFound(err) || isConflict(err)) await reload();
      } finally {
        setBusy(null);
        setConfirmingRemove(null);
      }
    },
    [busy, reload],
  );

  const link = result ? linkState(result.username, friends, requests) : "none";
  const linkText = linkLabel(link);

  return (
    <div className="flex flex-col gap-8">
      <header>
        <p className="eyebrow">Social</p>
        <h1 className="font-display text-4xl font-bold">Friends</h1>
        <p className="mt-2 max-w-prose text-sm text-text-muted">
          Training partners you have both agreed to. Friends can send you a
          workout or a sequence, and — if they turn it on — you can see the
          sessions they finish.
        </p>
      </header>

      {actionError && (
        <p
          role="alert"
          className="rounded-card border border-danger/40 bg-danger/10 px-4 py-3 text-sm"
        >
          {actionError}
        </p>
      )}

      <section className="flex flex-col gap-3">
        <h2 className="eyebrow">Add a friend</h2>
        <form
          className="flex flex-wrap items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            void search();
          }}
        >
          <input
            value={query}
            // Lowercased as it is typed, because the handle rule is
            // lowercase-canonical and nobody typing what a friend told them is
            // careful about it.
            onChange={(e) => setQuery(e.target.value.toLowerCase())}
            placeholder="their exact handle, e.g. dmytro_bjj"
            aria-label="Search by username"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            className="w-72 rounded-pill border border-line bg-surface px-4 py-2 text-sm placeholder:text-text-dim focus-visible:border-text"
          />
          <button
            type="submit"
            disabled={searchState === "searching" || query.trim() === ""}
            className="rounded-pill border border-line px-5 py-2 text-sm font-bold transition hover:bg-surface-raised disabled:cursor-not-allowed disabled:opacity-30"
          >
            {searchState === "searching" ? "Finding…" : "Find"}
          </button>
        </form>

        {/* SEARCH IS EXACT-MATCH BY DESIGN — the API refuses to be an
            enumeration surface — so this line teaches the interaction rather
            than apologising for it. */}
        {searchMessage && (
          <p
            className={
              searchState === "error" ? "text-sm text-danger" : "text-sm text-text-muted"
            }
            // The 404 arm is the screen's key teaching copy and used to
            // appear silently: only the error arm had live semantics, so
            // somebody who pressed Enter and cannot see the page was told
            // nothing at all.
            role={searchState === "error" ? "alert" : "status"}
          >
            {searchMessage}
          </p>
        )}

        {result && (
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-card border border-line bg-surface px-4 py-3">
            <div className="min-w-0">
              <p className="truncate font-medium">@{result.username}</p>
              {result.display_name && (
                <p className="truncate text-sm text-text-muted">
                  {result.display_name}
                </p>
              )}
            </div>
            {/* Until BOTH lists are in, `linkState` answers "unknown" rather
                than "none" — offering Add to somebody already asked is the
                thing this avoids. The 409 backs it up server-side; saying
                nothing is better than saying wrong. */}
            {linkText !== null ? (
              <p className="text-sm text-text-muted">{linkText}</p>
            ) : (
              <button
                type="button"
                onClick={() =>
                  void act(`add-${result.username}`, () =>
                    sendFriendRequest(getToken, result.username),
                  )
                }
                disabled={busy !== null}
                aria-busy={busy === `add-${result.username}`}
                className="rounded-pill bg-accent-fill px-5 py-2 text-sm font-bold text-accent-on-fill transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {busy === `add-${result.username}` ? "Sending…" : "Add friend"}
              </button>
            )}
          </div>
        )}
      </section>

      {loadError && (
        <div
          role="alert"
          className="flex flex-wrap items-center justify-between gap-3 rounded-card border border-danger/40 bg-danger/10 px-4 py-3 text-sm"
        >
          <span>{loadError}</span>
          {/* Without this the only recovery is a browser reload — and worse,
              the result card above sits on "Checking…" forever, because
              `linkState` answers "unknown" against lists that will never
              arrive. Copy that claims progress beside an error saying it
              failed. Mobile has pull-to-refresh for exactly this. */}
          <button
            type="button"
            onClick={() => void load()}
            className="shrink-0 rounded-pill border border-line px-4 py-1.5 text-sm font-bold transition hover:bg-surface-raised"
          >
            Try again
          </button>
        </div>
      )}

      {/* null is loading, [] is genuinely nobody. A failed load renders as
          NEITHER — it renders as the error above, because "you have no
          friends" is a cruel way to say "we could not ask". */}
      {friends === null && !loadError && (
        <p className="text-sm text-text-muted">Loading…</p>
      )}

      {requests !== null && requests.incoming.length > 0 && (
        <section className="flex flex-col gap-2">
          <h2 className="eyebrow">Want to be your friend</h2>
          <ul className="flex flex-col gap-2">
            {requests.incoming.map((c) => (
              <li
                key={c.username}
                className="flex items-center gap-4 rounded-card border border-line bg-surface px-4 py-3"
              >
                <Person card={c} />
                <div className="flex shrink-0 items-center gap-2">
                  <button
                    type="button"
                    onClick={() =>
                      void act(`accept-${c.username}`, () =>
                        acceptRequest(getToken, c.username),
                      )
                    }
                    disabled={busy !== null}
                    aria-busy={busy === `accept-${c.username}`}
                    // Labelled per row: "Accept" repeated down a list is
                    // indistinguishable when navigating by buttons.
                    aria-label={`Accept ${c.username}`}
                    className="rounded-pill border border-line px-4 py-1.5 text-sm font-bold transition hover:bg-surface-raised disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    {/* Real words rather than "…" plus an `sr-only` twin: the
                        twin was inert, since `aria-label` excludes it from the
                        name and nothing announced its insertion. `aria-busy`
                        carries the state; this carries the meaning. */}
                    {busy === `accept-${c.username}` ? "Accepting…" : "Accept"}
                  </button>
                  <button
                    type="button"
                    onClick={() =>
                      void act(`decline-${c.username}`, () =>
                        removeFriend(getToken, c.username),
                      )
                    }
                    disabled={busy !== null}
                    aria-label={`Decline ${c.username}`}
                    className="rounded-pill px-4 py-1.5 text-sm text-text-muted transition hover:text-text disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    Decline
                  </button>
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}

      {requests !== null && requests.outgoing.length > 0 && (
        <section className="flex flex-col gap-2">
          <h2 className="eyebrow">Waiting on</h2>
          <ul className="flex flex-col gap-2">
            {requests.outgoing.map((c) => (
              <li
                key={c.username}
                className="flex items-center gap-4 rounded-card border border-line bg-surface px-4 py-3"
              >
                {/* The handle only, matching mobile: an outgoing request is
                    somebody you have not met in the app yet, and their display
                    name is not something you have been shown. */}
                <p className="min-w-0 flex-1 truncate font-medium">
                  @{c.username}
                </p>
                <button
                  type="button"
                  onClick={() =>
                    void act(`cancel-${c.username}`, () =>
                      removeFriend(getToken, c.username),
                    )
                  }
                  disabled={busy !== null}
                  aria-busy={busy === `cancel-${c.username}`}
                  aria-label={`Cancel request to ${c.username}`}
                  className="shrink-0 rounded-pill px-4 py-1.5 text-sm text-text-muted transition hover:text-text disabled:cursor-not-allowed disabled:opacity-40"
                >
                  {busy === `cancel-${c.username}` ? "Cancelling…" : "Cancel"}
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}

      {friends !== null && (
        <section className="flex flex-col gap-2">
          <h2 className="eyebrow">Friends</h2>
          {friends.length === 0 ? (
            <p className="rounded-card border border-dashed border-line px-6 py-12 text-center text-sm text-text-muted">
              Nobody yet. Ask a training partner for their handle — sharing
              lands here next.
            </p>
          ) : (
            <ul className="flex flex-col gap-2">
              {friends.map((c) => (
                <li
                  key={c.username}
                  className="flex items-center gap-4 rounded-card border border-line bg-surface px-4 py-3"
                >
                  <Person card={c} />
                  <button
                    type="button"
                    onClick={() =>
                      confirmingRemove === c.username
                        ? void act(`remove-${c.username}`, () =>
                            removeFriend(getToken, c.username),
                          )
                        : setConfirmingRemove(c.username)
                    }
                    // Blurring abandons the confirmation, so a half-pressed
                    // Remove does not sit armed on a row you have walked away
                    // from.
                    onBlur={() => setConfirmingRemove(null)}
                    disabled={busy !== null}
                    aria-busy={busy === `remove-${c.username}`}
                    // Tracks the ARMED state. A constant label overrides the
                    // button's content for the accessible name, so a screen
                    // reader would say "Remove X" while it visibly reads
                    // "Really remove?" — a label-in-name mismatch, and voice
                    // control cannot activate what it can see.
                    aria-label={
                      confirmingRemove === c.username
                        ? `Confirm removing ${c.username}`
                        : `Remove ${c.username}`
                    }
                    className="shrink-0 rounded-pill px-4 py-1.5 text-sm text-text-muted transition hover:text-danger disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    {/* Two-step in place, and it ANNOUNCES: a label swapping
                        on an already-focused control is silent to a screen
                        reader otherwise. */}
                    <span aria-live="polite">
                      {busy === `remove-${c.username}`
                        ? "Removing…"
                        : confirmingRemove === c.username
                          ? "Really remove?"
                          : "Remove"}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

      {/* Said once, at the bottom, rather than beside every control: it is the
          property that makes removing somebody feel safe to do. */}
      <p className="text-xs text-text-muted">
        Removing a friend, declining a request and cancelling one you sent are
        the same thing — the connection goes, and nothing tells them which of
        the three it was.
      </p>
    </div>
  );
}

function Person({ card }: { card: FriendCard }) {
  return (
    <div className="min-w-0 flex-1">
      <p className="truncate font-medium">@{card.username}</p>
      {card.display_name && (
        <p className="truncate text-sm text-text-muted">{card.display_name}</p>
      )}
    </div>
  );
}
