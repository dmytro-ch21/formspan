"use client";

import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { useAuth } from "@clerk/nextjs";

import {
  copySequence,
  deleteSequence,
  getSequence,
  type Sequence,
} from "@/lib/api";
import { ShareToFriend } from "@/components/ShareToFriend";

/**
 * One sequence, drawn as the chain it is.
 *
 * The positions are rendered BETWEEN the steps rather than as a property of
 * them, because that is what a sequence claims: this move puts you where the
 * next one starts. Drawn as a flat list of techniques it would be
 * indistinguishable from a curriculum, which orders the same objects to mean
 * something entirely different.
 *
 * A step whose destination is unrecorded shows as a gap on purpose. That is
 * honest — the library knows `to_position` for 170 of 542 techniques, so most
 * chains genuinely have holes — and it is the prompt to fill one in.
 */
export default function SequenceDetailPage() {
  const { getToken } = useAuth();
  const router = useRouter();
  const params = useParams<{ id: string }>();
  const id = params?.id ?? "";

  const [s, setS] = useState<Sequence | null>(null);
  const [error, setError] = useState<string | null>(null);
  /**
   * An action that failed, as opposed to a page that would not load.
   *
   * Separate from `error` because that one drives a full-page early return —
   * right when the sequence itself is unreachable, and wrong for a copy or a
   * delete that failed: it replaces the chain, the share button and the retry
   * with one line of red, and the load effect never clears it, so a transient
   * network blip destroys the page until a hard reload. Review found the copy
   * path feeding into it; `remove` had the same shape already.
   */
  const [action, setAction] = useState<{ id: string; message: string } | null>(null);
  const actionError = action?.id === id ? action.message : null;
  const [confirming, setConfirming] = useState(false);
  /**
   * WHICH sequence is being copied, not whether one is — and the same for the
   * action error.
   *
   * `router.push` to another sequence stays inside the `[id]` segment, so Next
   * REUSES this component rather than remounting it (the fact the edit route's
   * `key={s.id}` exists for). Plain booleans therefore survive the navigation:
   * copy, press Back, and the original's button is stuck disabled at
   * "Copying…" for the life of the instance. Review found it.
   *
   * Keying the state on the id and DERIVING the flag during render fixes it
   * without an effect — which is what `react-hooks/set-state-in-effect`
   * refused when this was written as a reset, correctly. Nothing to clear:
   * when `id` changes the derived value is already false.
   */
  const [copyingId, setCopyingId] = useState<string | null>(null);
  const copying = copyingId === id;
  const [deleting, setDeleting] = useState(false);

  useEffect(() => {
    if (!id) return;
    const c = new AbortController();
    getSequence(getToken, id, c.signal)
      .then(setS)
      .catch((err) => {
        if ((err as Error)?.name !== "AbortError") {
          setError(err instanceof Error ? err.message : String(err));
        }
      });
    return () => c.abort();
  }, [getToken, id]);

  const remove = useCallback(async () => {
    setDeleting(true);
    try {
      await deleteSequence(getToken, id);
      router.push("/dashboard/sequences");
    } catch (err) {
      setAction({ id, message: err instanceof Error ? err.message : String(err) });
      setDeleting(false);
    }
  }, [getToken, id, router]);

  if (error) {
    return (
      <p role="alert" className="text-sm text-red-700 dark:text-red-300">
        {error}
      </p>
    );
  }
  if (!s) return <p className="text-sm text-neutral-500">Loading…</p>;

  const steps = s.steps ?? [];

  return (
    <div className="space-y-6">
      <header className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <Link
            href="/dashboard/sequences"
            className="text-sm text-neutral-500 hover:underline"
          >
            ← Sequences
          </Link>
          <h1 className="mt-1 text-2xl font-semibold">{s.name}</h1>
          {s.description && (
            <p className="mt-1 text-sm text-neutral-500">{s.description}</p>
          )}
        </div>
        {/* Gated on `editable`, which the SERVER resolves. The client never
            compares user ids to decide this — that shape is how client-side
            authorization gets written by accident. */}
        <div className="flex shrink-0 items-start gap-2">
          {/* Share is OUTSIDE the `editable` gate, unlike Edit and Delete.
              Passing on a chain you can read is not a write to it, and the
              server tests visibility rather than ownership for exactly this
              reason — a VOLA-authored sequence is something you can already
              show a training partner by hand. */}
          <ShareToFriend resourceType="sequence" resourceId={s.id} />
          {/* Copy is the counterpart to Edit, not a sibling of it: it appears
              exactly where Edit does not. A chain you cannot edit was, until
              F9, a chain you could only look at — the edit route even told you
              to "copy it to make it yours" with nothing behind the sentence.

              Visibility gates it server-side, so this renders for any
              non-editable chain rather than only for VOLA's. `official` picks
              the WORDS below; it does not decide whether you may copy. */}
          {!s.editable && (
            <button
              type="button"
              disabled={copying}
              onClick={async () => {
                setCopyingId(s.id);
                try {
                  const mine = await copySequence(getToken, s.id);
                  router.push(`/dashboard/sequences/${mine.id}`);
                } catch (err) {
                  setAction({
                    id: s.id,
                    message: err instanceof Error ? err.message : String(err),
                  });
                  // Only on failure. On success the navigation changes `id`,
                  // which makes `copying` false by derivation — no reset, and
                  // no stale flag left on the page you came from.
                  setCopyingId(null);
                }
              }}
              className="rounded-pill bg-accent-fill px-5 py-2 text-sm font-bold text-accent-on-fill transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {/* aria-live for the same reason Delete has it below: a label
                  swapping in place on an already focused button is not
                  reliably announced. */}
              <span aria-live="polite">
                {copying ? "Copying…" : "Copy to my sequences"}
              </span>
            </button>
          )}
          {s.editable && (
            <>
            {/* Tokens, not raw `neutral-*`. Share moved to the design system
                when workouts started mounting it beside tokenized controls,
                and leaving its neighbours behind made this row a pill next to
                two rectangles. */}
            <Link
              href={`/dashboard/sequences/${s.id}/edit`}
              className="rounded-pill border border-line px-5 py-2 text-sm font-bold transition hover:bg-surface-raised"
            >
              Edit
            </Link>
            <button
              type="button"
              onClick={() => (confirming ? remove() : setConfirming(true))}
              onBlur={() => setConfirming(false)}
              disabled={deleting}
              className="rounded-pill border border-danger/40 px-5 py-2 text-sm font-bold text-danger transition hover:bg-danger/10 disabled:cursor-not-allowed disabled:opacity-40"
            >
              {/* aria-live, because a label swapping in place on an already
                  focused button is not reliably announced — the confirm step
                  would be silent to a screen reader otherwise. */}
              <span aria-live="polite">
                {deleting ? "Deleting…" : confirming ? "Really delete?" : "Delete"}
              </span>
            </button>
            </>
          )}
        </div>
        {/* Inline, beside the controls that produced it — the page and its
            retry survive. The full-page `error` return above is for a sequence
            that would not load, where there is nothing else to show. */}
        {actionError && (
          <p role="alert" className="text-sm text-red-700 dark:text-red-300">
            {actionError}
          </p>
        )}
      </header>

      <ol className="space-y-1">
        {/* Wrapped in <li>: <ol> permits only li/script/template, and this
            opening node is a DIRECT child. The per-step nodes below sit inside
            their step's <li> and are fine as divs. */}
        <li>
          <Node
            label={s.start_position_name ?? "Start not recorded"}
            muted={!s.start_position_id}
          />
        </li>
        {steps.map((step) => {
          // A submission ENDS the exchange; anything else with no destination
          // is merely unrecorded. Both are a null id, and `function` is the
          // only thing that tells them apart — rendering them the same way
          // would say a finished armbar left the athlete nowhere.
          const finishes = step.function === "finish";
          return (
            <li key={`${step.order}-${step.technique_id}`} className="space-y-1">
              <div className="flex items-start gap-3 rounded-xl border border-neutral-200 p-3 dark:border-neutral-800">
                <span className="mt-0.5 w-5 shrink-0 text-sm tabular-nums text-neutral-400">
                  {step.order + 1}
                </span>
                <div className="min-w-0">
                  {/* Plain text, NOT a link to the library. A
                      `?technique=` deep link was written here first and the
                      Library page reads no such param — it would have looked
                      like "open this technique" and delivered the top of the
                      grid with the panel shut. An affordance the destination
                      does not support is worse than none. */}
                  <p className="font-medium">{step.name}</p>
                  <p className="text-xs text-neutral-500">
                    {step.position}
                    {step.category ? ` · ${step.category}` : ""}
                  </p>
                  {step.notes && (
                    <p className="mt-1 text-sm text-neutral-600 dark:text-neutral-400">
                      {step.notes}
                    </p>
                  )}
                </div>
              </div>
              <Node
                label={
                  step.ends_at_position_name ??
                  (finishes ? "Ends the exchange" : "Not recorded")
                }
                // NOT `!ends_at_position_id` alone. The muted treatment is the
                // gap prompt; a finished submission is a definite outcome, and
                // fading it identically to missing data files a finish under
                // "unrecorded" in the one channel the athlete reads fastest.
                muted={!step.ends_at_position_id && !finishes}
              />
            </li>
          );
        })}
      </ol>

      {steps.length === 0 && (
        <p className="rounded-xl border border-dashed border-neutral-300 px-4 py-8 text-center text-sm text-neutral-500 dark:border-neutral-700">
          This sequence has no steps yet.
        </p>
      )}
    </div>
  );
}

/** A position in the chain — the rails the steps run between. */
function Node({ label, muted }: { label: string; muted?: boolean }) {
  return (
    <div className="flex items-center gap-2 pl-1 text-sm">
      <span
        aria-hidden
        className="inline-block h-2 w-2 shrink-0 rounded-full bg-neutral-400 dark:bg-neutral-600"
      />
      <span
        className={
          muted
            ? "italic text-neutral-400 dark:text-neutral-600"
            : "font-medium text-neutral-600 dark:text-neutral-400"
        }
      >
        {label}
      </span>
    </div>
  );
}
