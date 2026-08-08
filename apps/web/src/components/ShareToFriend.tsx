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
 * is strictly more work than moving it now. **Workouts are the second caller,
 * and they cost one line at the call site** — which is the claim this file's
 * placement was making.
 *
 * The API's 404 covers "not your friend", "no such handle" and "not yours to
 * send" alike, deliberately, so the copy here cannot be more specific than the
 * server is willing to be.
 */
export function ShareToFriend({
  resourceType,
  resourceId,
  disabled = false,
  disabledReason,
}: {
  resourceType: string;
  resourceId: string;
  /**
   * For when the thing on screen is not the thing the server would send.
   *
   * A workout with unsaved edits is the case: sharing copies what is STORED,
   * so a sender who has just reordered their template would hand over the old
   * order and have no way to know. The same reason "Start session" is disabled
   * while dirty. Sequences pass neither prop — they save on submit, so the
   * question cannot arise there.
   */
  disabled?: boolean;
  disabledReason?: string;
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

  // Going disabled while the panel is open closes it — DURING RENDER, not in
  // an effect. React's documented "adjust state when a prop changes" shape;
  // an effect here is `react-hooks/set-state-in-effect`, and it is right to
  // complain, since this is derivation rather than synchronisation with
  // anything outside React. Left as a stale `open`, re-enabling the button
  // would pop the panel open again on its own.
  //
  // Reachable, if narrowly: the panel does not trap focus, so a keyboard user
  // can tab out to the plan and type. `setOpen` rather than `close()` — the
  // focus restore would aim at a button that is disabled at this instant, and
  // focusing a disabled button puts focus nowhere.
  if (open && disabled) setOpen(false);

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
        disabled={disabled}
        // The reason travels with the control, in BOTH channels. A disabled
        // button with no explanation is indistinguishable from a broken one —
        // and `title` alone would not do it, because a disabled button
        // suppresses the mouse events some browsers raise the tooltip from.
        // So the reason goes into the accessible name too.
        title={disabled ? disabledReason : undefined}
        aria-label={disabled && disabledReason ? `Share. ${disabledReason}` : undefined}
        className="rounded-pill border border-line px-5 py-2 text-sm font-bold transition hover:bg-surface-raised disabled:cursor-not-allowed disabled:opacity-30"
      >
        Share
      </button>

      {open && !disabled && (
        <div
          ref={panel}
          role="dialog"
          aria-label="Share with a friend"
          className="absolute right-0 z-10 mt-2 w-72 rounded-card border border-line bg-surface p-3 shadow-lg"
        >
          <p className="eyebrow mb-2">Send a copy to</p>

          {error && (
            <div className="mb-2">
              <p role="alert" className="text-sm text-danger">
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
            <p className="text-sm text-text-muted">Loading…</p>
          )}

          {friends?.length === 0 && (
            <p className="text-sm text-text-muted">
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
                    className="flex w-full items-center justify-between gap-2 rounded-lg px-2 py-2 text-left text-sm transition hover:bg-surface-raised disabled:opacity-60"
                  >
                    <span className="min-w-0">
                      <span className="block truncate font-medium">
                        @{f.username}
                      </span>
                      {f.display_name && (
                        <span className="block truncate text-xs text-text-muted">
                          {f.display_name}
                        </span>
                      )}
                    </span>
                    <span
                      aria-live="polite"
                      className="shrink-0 text-xs text-text-muted"
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
          <p className="mt-2 border-t border-line pt-2 text-xs text-text-muted">
            They get their own copy. Your later edits stay yours.
          </p>
        </div>
      )}
    </div>
  );
}
