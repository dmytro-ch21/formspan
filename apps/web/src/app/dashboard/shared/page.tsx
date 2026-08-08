"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { useAuth } from "@clerk/nextjs";

import {
  acceptShare,
  dismissShare,
  listShareInbox,
  listSentShares,
  type SentShareCard,
  type ShareCard,
} from "@/lib/api";

/**
 * Sharing — both directions of it.
 *
 * **Generic by design, and the design has now been paid off once.** The card
 * renders whatever `resource_type` says, so workouts arrived here as two map
 * entries below rather than as a second inbox — and plans and curricula will
 * arrive the same way. Filing this under Sequences instead would have meant
 * moving it the first time anything else was shared.
 *
 * ACCEPTING IS WHAT COPIES. Until then nothing exists in your library, which
 * is why the empty state is a real destination rather than an error: an inbox
 * you have cleared is the normal condition.
 *
 * THE SENT LIST SHOWS ONLY WHAT IS UNANSWERED, and the copy has to be honest
 * about that rather than leaving it to be discovered. Declining deletes, so if
 * an accepted share stayed visible here, a row that disappeared would mean
 * "they declined" — the one inference decline-is-delete exists to prevent. Both
 * answers therefore look the same from this side: the row is simply gone.
 */

/** Where a given kind of accepted thing lives, once it is yours. A type absent
 *  from this map still accepts — it just does not navigate, which is the right
 *  failure for a client that is older than the server it is talking to. */
const DESTINATION: Record<string, (id: string) => string> = {
  sequence: (id) => `/dashboard/sequences/${id}`,
  workout: (id) => `/dashboard/workouts/${id}`,
};

const KIND_LABEL: Record<string, string> = {
  sequence: "Sequence",
  workout: "Workout",
};

export default function SharedWithYouPage() {
  const { getToken } = useAuth();
  const router = useRouter();

  const [shares, setShares] = useState<ShareCard[] | null>(null);
  const [sent, setSent] = useState<SentShareCard[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  // Single-flight: a slow first load must not resolve after an accept and
  // repaint the row that was just cleared.
  const inflight = useRef<AbortController | null>(null);
  // An action's reload runs in a `finally`, which can land after the user has
  // navigated away — and `load()` starts TWO fresh requests. The effect
  // cleanup can only abort the flight that exists when it runs, so this is
  // what stops one being created afterwards. All three actions consult it;
  // the reviewer's note was "fix all three or none".
  const mounted = useRef(true);
  const load = useCallback(() => {
    inflight.current?.abort();
    const c = new AbortController();
    inflight.current = c;
    // Both directions in one round trip. A waterfall here would mean the
    // second list arriving visibly after the first on a gym wifi connection.
    return Promise.all([
      listShareInbox(getToken, c.signal),
      listSentShares(getToken, c.signal),
    ])
      .then(([inbox, outgoing]) => {
        if (c.signal.aborted) return;
        setShares(inbox);
        setSent(outgoing);
        setLoadError(null);
      })
      .catch((err) => {
        if (c.signal.aborted || (err as Error)?.name === "AbortError") return;
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

  // Reload only if this screen is still on screen.
  const reload = useCallback(() => (mounted.current ? load() : undefined), [load]);

  const accept = useCallback(
    async (card: ShareCard) => {
      setBusy(card.id);
      setActionError(null);
      try {
        const copy = await acceptShare(getToken, card.id);
        // Drop the row BEFORE navigating. A route transition is not instant,
        // and until it lands the accepted card is still on screen and still
        // clickable — a second tap would 404 against a share that is already
        // gone. Removing it locally is the honest state either way: the
        // server has accepted it.
        setShares((prev) => prev?.filter((s) => s.id !== card.id) ?? prev);
        const to = DESTINATION[copy.resource_type];
        // Navigate to the RECIPIENT'S copy — never the sender's id, which
        // they have no permission to open.
        if (to) router.push(to(copy.resource_id));
        else await reload();
      } catch (err) {
        setActionError(err instanceof Error ? err.message : String(err));
        // A 404 or a 410 both mean this row is a ghost: the sender took it
        // back, or deleted the thing itself. Refresh rather than leave a
        // button that can only fail again.
        await reload();
      } finally {
        setBusy(null);
      }
    },
    [getToken, router, reload],
  );

  // The sender's side of the same verb — DELETE /v1/shares/{id} covers
  // declining, cancelling and unsending, because all three are "this, gone".
  const cancel = useCallback(
    async (card: SentShareCard) => {
      setBusy(card.id);
      setActionError(null);
      try {
        await dismissShare(getToken, card.id);
      } catch (err) {
        setActionError(err instanceof Error ? err.message : String(err));
      } finally {
        await reload();
        setBusy(null);
      }
    },
    [getToken, reload],
  );

  const decline = useCallback(
    async (card: ShareCard) => {
      setBusy(card.id);
      setActionError(null);
      try {
        await dismissShare(getToken, card.id);
      } catch (err) {
        setActionError(err instanceof Error ? err.message : String(err));
      } finally {
        await reload();
        setBusy(null);
      }
    },
    [getToken, reload],
  );

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-semibold">Sharing</h1>
        <p className="mt-1 text-sm text-neutral-500">
          Accepting makes your own copy. What they change afterwards is theirs,
          not yours.
        </p>
      </header>

      {actionError && (
        <p role="alert" className="text-sm text-red-700 dark:text-red-300">
          {actionError}
        </p>
      )}
      {loadError && (
        <p role="alert" className="text-sm text-red-700 dark:text-red-300">
          {loadError}
        </p>
      )}

      {/* null is loading, [] is a cleared inbox. A failed load renders as
          neither — it renders as the error above. */}
      {shares === null && !loadError && (
        <p className="text-sm text-neutral-500">Loading…</p>
      )}

      {shares !== null && (
        <section className="space-y-2">
        <h2 className="text-xs font-semibold uppercase tracking-wide text-neutral-500">
          Shared with you
        </h2>

      {shares.length === 0 && (
        <p className="rounded-xl border border-dashed border-neutral-300 px-4 py-10 text-center text-sm text-neutral-500 dark:border-neutral-700">
          Nothing waiting. When a training partner sends you something, it
          lands here.
        </p>
      )}

      {shares.length > 0 && (
      <ul className="space-y-2">
        {shares.map((card) => (
          <li
            key={card.id}
            className="flex items-center gap-4 rounded-xl border border-neutral-200 p-4 dark:border-neutral-800"
          >
            <div className="min-w-0 flex-1">
              <p className="text-xs uppercase tracking-wide text-neutral-500">
                {KIND_LABEL[card.resource_type] ?? card.resource_type} from @
                {card.from}
              </p>
              <p className="mt-0.5 truncate font-medium">
                {card.resource_label}
              </p>
            </div>
            <div className="flex shrink-0 gap-2">
              <button
                type="button"
                onClick={() => accept(card)}
                disabled={busy !== null}
                aria-busy={busy === card.id}
                aria-label={`Accept ${card.resource_label} from ${card.from}`}
                className="rounded-lg border border-neutral-300 px-3 py-1.5 text-sm font-medium disabled:opacity-40 dark:border-neutral-700"
              >
                {/* Labelled per row like Decline: "Accept" repeated down a
                    list is indistinguishable when navigating by buttons.
                    The busy state is aria-busy plus real words rather than a
                    live region containing "…", which announces as nothing. */}
                <span aria-hidden>{busy === card.id ? "…" : "Accept"}</span>
                {busy === card.id && <span className="sr-only">Accepting…</span>}
              </button>
              <button
                type="button"
                onClick={() => decline(card)}
                disabled={busy !== null}
                aria-label={`Decline ${card.resource_label} from ${card.from}`}
                className="rounded-lg px-3 py-1.5 text-sm text-neutral-500 disabled:opacity-40"
              >
                Decline
              </button>
            </div>
          </li>
        ))}
      </ul>
      )}
        </section>
      )}

      {sent !== null && (
        <section className="space-y-2 border-t border-neutral-200 pt-6 dark:border-neutral-800">
          <h2 className="text-xs font-semibold uppercase tracking-wide text-neutral-500">
            Waiting on them
          </h2>
          {sent.length === 0 ? (
            // The disclosure lives HERE too, and this is the case that needs
            // it most: a sender who comes back to check and finds the row gone
            // is exactly the person about to conclude they were turned down.
            // Rendering the note only alongside surviving rows put it
            // everywhere except the moment it exists for.
            <p className="text-sm text-neutral-500">
              Nothing unanswered. Shares disappear once they answer — we
              don&apos;t say which way.
            </p>
          ) : (
            <>
              <ul className="space-y-2">
                {sent.map((card) => (
                  <li
                    key={card.id}
                    className="flex items-center gap-4 rounded-xl border border-neutral-200 p-4 dark:border-neutral-800"
                  >
                    <div className="min-w-0 flex-1">
                      <p className="text-xs uppercase tracking-wide text-neutral-500">
                        {KIND_LABEL[card.resource_type] ?? card.resource_type}{" "}
                        to @{card.to}
                      </p>
                      <p className="mt-0.5 truncate font-medium">
                        {card.resource_label}
                      </p>
                    </div>
                    <button
                      type="button"
                      onClick={() => cancel(card)}
                      disabled={busy !== null}
                      aria-busy={busy === card.id}
                      aria-label={`Cancel ${card.resource_label} sent to ${card.to}`}
                      className="shrink-0 rounded-lg px-3 py-1.5 text-sm text-neutral-500 disabled:opacity-40"
                    >
                      <span aria-hidden>
                        {busy === card.id ? "…" : "Cancel"}
                      </span>
                      {busy === card.id && (
                        <span className="sr-only">Cancelling…</span>
                      )}
                    </button>
                  </li>
                ))}
              </ul>
              {/* Said plainly, because the alternative is a sender concluding
                  from a vanished row that they were turned down. */}
              <p className="text-xs text-neutral-500">
                These disappear once they answer. We don&apos;t say which way.
              </p>
            </>
          )}
        </section>
      )}
    </div>
  );
}
