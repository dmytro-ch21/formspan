"use client";

import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { useAuth } from "@clerk/nextjs";

import { deleteClassPlan, getClassPlan, type ClassPlan, type ClassPlanBlock } from "@/lib/api";

const BLOCK_LABEL: Record<ClassPlanBlock["type"], string> = {
  warmup: "Warmup",
  technique_drill: "Technique drill",
  live_rounds: "Live rounds",
  notes: "Notes",
};

/**
 * One class plan, drawn as the schedule it is.
 *
 * Deliberately NOT drawn like a sequence: there is no position rail between
 * blocks, because a class plan's order is a SCHEDULE (ten minutes of this,
 * then fifteen of that) rather than a causal chain — see
 * `ClassPlanBuilder.tsx`'s header comment for the full contrast.
 *
 * Edit and Delete are ALWAYS shown, no `editable` gate — unlike
 * `sequences/[id]/page.tsx`. This domain has no VOLA-authored rows and no
 * sharing (classplan.go's package comment: `owner_user_id` is `NOT NULL`), so
 * every plan reachable by id here is the caller's own; the server 404s
 * anything else before this page ever has a plan to render an edit button
 * next to. No `ShareToFriend` and no copy affordance either, for the same
 * reason.
 *
 * "Schedule this class" (N442) is the other entry point the ticket asks for,
 * alongside scheduling from Plan itself. It is a plain link, not a second
 * builder: `/dashboard/calendar?scheduleClassPlan={id}` and the calendar page
 * reads that query param once, to preselect this plan in its own scheduling
 * form — this page does nothing with the date or time, which the calendar
 * already owns.
 */
export default function ClassPlanDetailPage() {
  const { getToken } = useAuth();
  const router = useRouter();
  const params = useParams<{ id: string }>();
  const id = params?.id ?? "";

  const [p, setP] = useState<ClassPlan | null>(null);
  const [error, setError] = useState<string | null>(null);
  /**
   * A delete that failed, as opposed to a page that would not load.
   *
   * Separate from `error` because that one drives a full-page early return —
   * right when the plan itself is unreachable, and wrong for a delete that
   * failed: it would replace the whole schedule and the controls with one
   * line of red, over a transient network blip. Matches
   * `sequences/[id]/page.tsx`'s `action`/`actionError` split.
   */
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [deleting, setDeleting] = useState(false);

  useEffect(() => {
    if (!id) return;
    const c = new AbortController();
    getClassPlan(getToken, id, c.signal)
      .then(setP)
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
      await deleteClassPlan(getToken, id);
      router.push("/dashboard/classplans");
    } catch (err) {
      setDeleteError(err instanceof Error ? err.message : String(err));
      setDeleting(false);
    }
  }, [getToken, id, router]);

  if (error) {
    return (
      <p role="alert" className="text-sm text-danger">
        {error}
      </p>
    );
  }
  if (!p) return <p className="text-sm text-text-muted">Loading…</p>;

  const blocks = p.blocks ?? [];

  return (
    <div className="space-y-6">
      <header className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <Link
            href="/dashboard/classplans"
            className="text-sm text-text-muted hover:underline"
          >
            ← Class plans
          </Link>
          <h1 className="mt-1 font-display text-3xl font-bold">{p.name}</h1>
          {p.description && (
            <p className="mt-1 text-sm text-text-muted">{p.description}</p>
          )}
          <p className="mt-2 text-sm text-text-dim">
            {p.block_count} {p.block_count === 1 ? "block" : "blocks"} ·{" "}
            <span className="font-medium text-text">
              {p.total_duration_minutes} min total
            </span>
          </p>
        </div>
        <div className="flex shrink-0 items-start gap-2">
          <Link
            href={`/dashboard/calendar?scheduleClassPlan=${encodeURIComponent(p.id)}`}
            className="rounded-pill border border-line px-5 py-2 text-sm font-bold transition hover:bg-surface-raised"
          >
            Schedule this class
          </Link>
          <Link
            href={`/dashboard/classplans/${p.id}/edit`}
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
            {/* aria-live: a label swapping in place on an already-focused
                button is not reliably announced, so the confirm step would
                be silent to a screen reader otherwise. */}
            <span aria-live="polite">
              {deleting ? "Deleting…" : confirming ? "Really delete?" : "Delete"}
            </span>
          </button>
        </div>
      </header>

      {deleteError && (
        <p role="alert" className="text-sm text-danger">
          {deleteError}
        </p>
      )}

      {blocks.length === 0 ? (
        <p className="rounded-card border border-dashed border-line px-4 py-8 text-center text-sm text-text-muted">
          This class plan has no blocks yet.
        </p>
      ) : (
        <ol className="space-y-2">
          {blocks.map((b) => (
            <li
              key={`${b.order}-${b.type}`}
              className="rounded-card border border-line p-4"
            >
              <div className="flex items-start gap-3">
                <span className="mt-0.5 w-5 shrink-0 text-sm tabular-nums text-text-dim">
                  {b.order + 1}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-baseline gap-2">
                    <span className="eyebrow">{BLOCK_LABEL[b.type]}</span>
                    <span className="stat text-sm">{b.duration_minutes} min</span>
                  </div>

                  {/* A technique_drill block shows the pick OR the free text,
                      whichever is set — never both, matching the backend's
                      XOR. A warmup/live_rounds block has neither. */}
                  {b.type === "technique_drill" && (
                    <p className="mt-1 text-sm font-medium">
                      {b.technique_id
                        ? `${b.technique_name}${b.technique_position ? ` · ${b.technique_position}` : ""}`
                        : b.free_text}
                    </p>
                  )}

                  {/* For a `notes` block the note IS the content, so it reads
                      as the main line rather than supplementary detail. */}
                  {b.type === "notes" ? (
                    b.notes && <p className="mt-1 text-sm">{b.notes}</p>
                  ) : (
                    b.notes && (
                      <p className="mt-1 text-sm text-text-muted">{b.notes}</p>
                    )
                  )}
                </div>
              </div>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
