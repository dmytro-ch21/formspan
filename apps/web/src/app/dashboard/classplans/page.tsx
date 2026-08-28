"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { useAuth } from "@clerk/nextjs";

import { listClassPlans, type ClassPlan } from "@/lib/api";

/**
 * Your class plans.
 *
 * A class plan is a SCHEDULE — what tonight's hour is going to look like,
 * block by block — not a chain and not a syllabus. The list stays thin for
 * the same reason `sequences/page.tsx` does: a name, how many blocks, and
 * how long the whole thing runs. Everything else is one click away, and the
 * API omits `blocks` here on purpose.
 *
 * No "shared with me" section and no reference/official labelling anywhere on
 * this screen, unlike sequences and workouts — this domain has neither. Every
 * class plan a caller can see is one they wrote (classplan.go's package
 * comment: `owner_user_id` is `NOT NULL`), so there is nothing here to label.
 */
export default function ClassPlansPage() {
  const { getToken } = useAuth();
  const [list, setList] = useState<ClassPlan[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const c = new AbortController();
    listClassPlans(getToken, c.signal)
      .then(setList)
      .catch((err) => {
        if ((err as Error)?.name !== "AbortError") {
          setError(err instanceof Error ? err.message : String(err));
        }
      });
    return () => c.abort();
  }, [getToken]);

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="eyebrow">Authoring</p>
          <h1 className="font-display text-4xl font-bold">Class plans</h1>
          <p className="mt-1 text-sm text-text-muted">
            What tonight&apos;s hour looks like, block by block.
          </p>
        </div>
        <Link
          href="/dashboard/classplans/new"
          className="rounded-pill bg-accent-fill px-5 py-2.5 text-sm font-bold text-accent-on-fill transition hover:brightness-110"
        >
          New class plan
        </Link>
      </header>

      {error && (
        <p
          role="alert"
          className="rounded-card border border-danger/40 bg-danger/10 px-4 py-3 text-sm"
        >
          {error}
        </p>
      )}

      {/* null is "still loading" and [] is "genuinely none" — collapsing them
          shows the empty state for a moment on every open, which reads as
          "you have nothing" to a coach who teaches four classes a week. */}
      {list === null && !error && (
        <p className="text-sm text-text-muted">Loading…</p>
      )}

      {list !== null && list.length === 0 && (
        <div className="rounded-card border border-dashed border-line px-6 py-12 text-center">
          <p className="text-sm text-text-muted">
            Nothing planned yet. Sketch tonight&apos;s class before you walk
            in — how long warmup runs, what you&apos;re drilling, how much
            time is left for rounds — and the next one starts from something
            instead of memory.
          </p>
          <Link
            href="/dashboard/classplans/new"
            className="mt-4 inline-block rounded-pill border border-line px-4 py-2 text-sm font-bold transition hover:bg-surface-raised"
          >
            Build one
          </Link>
        </div>
      )}

      {list !== null && list.length > 0 && (
        <ul className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {list.map((p) => (
            <li key={p.id}>
              <Link
                href={`/dashboard/classplans/${p.id}`}
                className="block h-full rounded-card border border-line bg-surface p-5 transition hover:bg-surface-raised"
              >
                <p className="font-display text-xl font-semibold">{p.name}</p>
                <p className="mt-1 text-sm text-text-muted">
                  {p.block_count} {p.block_count === 1 ? "block" : "blocks"} ·{" "}
                  {p.total_duration_minutes} min
                </p>
                {p.description && (
                  <p className="mt-2 line-clamp-2 text-sm text-text-dim">
                    {p.description}
                  </p>
                )}
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
