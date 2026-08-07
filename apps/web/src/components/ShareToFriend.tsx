"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useAuth } from "@clerk/nextjs";

import {
  ApiError,
  listFriends,
  shareResource,
  type FriendCard,
} from "@/lib/api";

/**
 * Share this thing with a friend.
 *
 * **A friend PICKER, not a handle field**, and that is the product decision
 * this component exists to hold. You can only share with people who already
 * agreed to hear from you, so typing a handle could only ever produce one of
 * two outcomes: a friend you could have picked from a list, or a 404. A text
 * input would invite the second and teach nothing.
 *
 * It is also generic on purpose — `resourceType`/`resourceId`, no mention of
 * sequences — because the API is one surface for everything shareable and
 * plans and workouts will mount this same component. It lives in
 * `src/components` rather than beside the sequence route for exactly that
 * reason: a generic component with a sequence-shaped ADDRESS is one that the
 * second caller has to move, and moving it after something imports the path
 * is strictly more work than moving it now.
 *
 * The API's 404 covers "not your friend", "no such handle" and "not yours to
 * send" alike, deliberately, so the copy here cannot be more specific than the
 * server is willing to be.
 */
export function ShareToFriend({
  resourceType,
  resourceId,
}: {
  resourceType: string;
  resourceId: string;
}) {
  const { getToken } = useAuth();
  const [open, setOpen] = useState(false);
  const [friends, setFriends] = useState<FriendCard[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState<string | null>(null);
  const [sentTo, setSentTo] = useState<string[]>([]);
  const panel = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);

  // Loaded on OPEN rather than on mount: most visits to a sequence are not
  // visits to share it, and the friends list is somebody else's data to fetch
  // only when it is about to be shown.
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!open || friends !== null) return;
    const c = new AbortController();
    listFriends(getToken, c.signal)
      .then((rows) => {
        if (c.signal.aborted) return;
        setFriends(rows);
        // Cleared on SUCCESS. Without this a failed load leaves its red alert
        // sitting above a working list after the retry, and — worse — the
        // loading indicator stays suppressed because it is gated on `!error`.
        setError(null);
      })
      .catch((err) => {
        if (c.signal.aborted || (err as Error)?.name === "AbortError") return;
        setError(err instanceof Error ? err.message : String(err));
      });
    return () => c.abort();
  }, [open, friends, getToken, attempt]);

  // Escape closes and a click outside dismisses, and BOTH put focus back on
  // the trigger.
  //
  // The comment here used to claim the focus restore while the code did no
  // such thing — closing simply unmounted the panel and dropped focus to
  // document.body, which for anyone picking a friend by keyboard means losing
  // their place entirely. Review caught the gap between the comment and the
  // code; this is the code catching up.
  const close = useCallback(() => {
    setOpen(false);
    trigger.current?.focus();
  }, []);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    const onClick = (e: MouseEvent) => {
      const t = e.target as Node;
      if (panel.current?.contains(t) || trigger.current?.contains(t)) return;
      close();
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("mousedown", onClick);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("mousedown", onClick);
    };
  }, [open, close]);

  const send = useCallback(
    async (username: string) => {
      setSending(username);
      setError(null);
      try {
        await shareResource(getToken, username, resourceType, resourceId);
        setSentTo((prev) => [...prev, username]);
      } catch (err) {
        // A 409 says it is ALREADY sitting unanswered in their inbox, which is
        // the same outcome the sender wanted — reporting it in red would make
        // a no-op look like a failure. `code` is contract; the message is not.
        if (err instanceof ApiError && err.code === "already_exists") {
          setSentTo((prev) => [...prev, username]);
        } else {
          setError(err instanceof Error ? err.message : String(err));
        }
      } finally {
        setSending(null);
      }
    },
    [getToken, resourceType, resourceId],
  );

  return (
    <div className="relative">
      <button
        type="button"
        ref={trigger}
        onClick={() => (open ? close() : setOpen(true))}
        aria-expanded={open}
        aria-haspopup="dialog"
        className="rounded-lg border border-neutral-300 px-3 py-1.5 text-sm font-medium dark:border-neutral-700"
      >
        Share
      </button>

      {open && (
        <div
          ref={panel}
          role="dialog"
          aria-label="Share with a friend"
          className="absolute right-0 z-10 mt-2 w-72 rounded-xl border border-neutral-200 bg-white p-3 shadow-lg dark:border-neutral-800 dark:bg-neutral-900"
        >
          <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-neutral-500">
            Send a copy to
          </p>

          {error && (
            <div className="mb-2">
              <p role="alert" className="text-sm text-red-700 dark:text-red-300">
                {error}
              </p>
              {friends === null && (
                // Reachable only for a failed LOAD. Without it the sole retry
                // is close-and-reopen, which nothing tells you about.
                <button
                  type="button"
                  onClick={() => setAttempt((n) => n + 1)}
                  className="mt-1 text-sm font-medium underline"
                >
                  Try again
                </button>
              )}
            </div>
          )}

          {/* null is LOADING and [] is "no friends yet" — a failed load must
              never render as the empty state, which would read as "you have no
              friends" when the truth is "we could not ask". */}
          {friends === null && !error && (
            <p className="text-sm text-neutral-500">Loading…</p>
          )}

          {friends?.length === 0 && (
            <p className="text-sm text-neutral-500">
              Nobody yet. Add a training partner on your phone, then share this
              with them.
            </p>
          )}

          <ul className="max-h-64 space-y-1 overflow-y-auto">
            {friends?.map((f) => {
              const sent = sentTo.includes(f.username);
              return (
                <li key={f.username}>
                  <button
                    type="button"
                    onClick={() => send(f.username)}
                    disabled={sending !== null || sent}
                    className="flex w-full items-center justify-between gap-2 rounded-lg px-2 py-2 text-left text-sm hover:bg-neutral-100 disabled:opacity-60 dark:hover:bg-neutral-800"
                  >
                    <span className="min-w-0">
                      <span className="block truncate font-medium">
                        @{f.username}
                      </span>
                      {f.display_name && (
                        <span className="block truncate text-xs text-neutral-500">
                          {f.display_name}
                        </span>
                      )}
                    </span>
                    <span
                      aria-live="polite"
                      className="shrink-0 text-xs text-neutral-500"
                    >
                      {sending === f.username
                        ? "Sending…"
                        : sent
                          ? "Sent ✓"
                          : ""}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>

          {/* Said once, here, rather than in a tooltip nobody opens: this is
              the property that makes sharing safe to accept. */}
          <p className="mt-2 border-t border-neutral-200 pt-2 text-xs text-neutral-500 dark:border-neutral-800">
            They get their own copy. Your later edits stay yours.
          </p>
        </div>
      )}
    </div>
  );
}
