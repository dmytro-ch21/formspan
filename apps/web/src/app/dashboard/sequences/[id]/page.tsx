"use client";

import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { useAuth } from "@clerk/nextjs";

import { deleteSequence, getSequence, type Sequence } from "@/lib/api";

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
  const [confirming, setConfirming] = useState(false);
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
      setError(err instanceof Error ? err.message : String(err));
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
        {s.editable && (
          <div className="flex shrink-0 gap-2">
            <Link
              href={`/dashboard/sequences/${s.id}/edit`}
              className="rounded-lg border border-neutral-300 px-3 py-1.5 text-sm font-medium dark:border-neutral-700"
            >
              Edit
            </Link>
            <button
              type="button"
              onClick={() => (confirming ? remove() : setConfirming(true))}
              onBlur={() => setConfirming(false)}
              disabled={deleting}
              className="rounded-lg border border-red-300 px-3 py-1.5 text-sm font-medium text-red-700 disabled:opacity-40 dark:border-red-900 dark:text-red-400"
            >
              {/* aria-live, because a label swapping in place on an already
                  focused button is not reliably announced — the confirm step
                  would be silent to a screen reader otherwise. */}
              <span aria-live="polite">
                {deleting ? "Deleting…" : confirming ? "Really delete?" : "Delete"}
              </span>
            </button>
          </div>
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
