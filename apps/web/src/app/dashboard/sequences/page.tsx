"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { useAuth } from "@clerk/nextjs";

import { listSequences, type Sequence } from "@/lib/api";

/**
 * Your sequences.
 *
 * A sequence is a CHAIN — what a class actually taught, in the order it flows.
 * The list is deliberately thin: a name, how long the chain is, and where it
 * starts. Everything else is one click away, and the API omits `steps` here for
 * exactly that reason.
 *
 * No "shared with me" section yet, and no share affordance anywhere on this
 * screen. Sharing is being built once, generically, across every ownable thing
 * in the app; a per-resource share button here would be the thing that has to
 * be undone.
 */
export default function SequencesPage() {
  const { getToken } = useAuth();
  const [list, setList] = useState<Sequence[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const c = new AbortController();
    listSequences(getToken, c.signal)
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
      <header className="flex items-baseline justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold">Sequences</h1>
          <p className="mt-1 text-sm text-neutral-500">
            The chains your classes taught, in the order they flow.
          </p>
        </div>
        <Link
          href="/dashboard/sequences/new"
          className="rounded-lg bg-neutral-900 px-4 py-2 text-sm font-medium text-white dark:bg-white dark:text-neutral-900"
        >
          New sequence
        </Link>
      </header>

      {error && (
        <p
          role="alert"
          className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800 dark:border-red-900 dark:bg-red-950 dark:text-red-200"
        >
          {error}
        </p>
      )}

      {/* null is "still loading" and [] is "genuinely none" — collapsing them
          shows the empty state for a moment on every open, which reads as "you
          have nothing" to someone who has plenty. */}
      {list === null && !error && (
        <p className="text-sm text-neutral-500">Loading…</p>
      )}

      {list !== null && list.length === 0 && (
        <div className="rounded-xl border border-dashed border-neutral-300 px-6 py-12 text-center dark:border-neutral-700">
          <p className="text-sm text-neutral-500">
            Nothing here yet. After a class, write down what it taught — closed
            guard, break, knee cut, side control — and the chain is worth more
            than the six techniques on their own.
          </p>
          <Link
            href="/dashboard/sequences/new"
            className="mt-4 inline-block rounded-lg border border-neutral-300 px-4 py-2 text-sm font-medium dark:border-neutral-700"
          >
            Build one
          </Link>
        </div>
      )}

      {list !== null && list.length > 0 && (
        <ul className="grid gap-3 sm:grid-cols-2">
          {list.map((s) => (
            <li key={s.id}>
              <Link
                href={`/dashboard/sequences/${s.id}`}
                className="block rounded-xl border border-neutral-200 p-4 hover:border-neutral-400 dark:border-neutral-800 dark:hover:border-neutral-600"
              >
                <p className="font-medium">{s.name}</p>
                <p className="mt-1 text-sm text-neutral-500">
                  {s.step_count} {s.step_count === 1 ? "step" : "steps"}
                  {s.start_position_name ? ` · from ${s.start_position_name}` : ""}
                  {/* Reference chains are readable and not editable. Said on the
                      card so it is not a surprise on the edit screen. */}
                  {!s.editable ? " · reference" : ""}
                </p>
                {s.description && (
                  <p className="mt-2 line-clamp-2 text-sm text-neutral-500">
                    {s.description}
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
