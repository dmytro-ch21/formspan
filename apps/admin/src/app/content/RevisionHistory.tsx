"use client";

import { useActionState } from "react";

import type { Exercise, Revision, Technique } from "@/lib/api";
import { formatUTC } from "@/lib/format";
import type { PublishResult } from "./actions";

/**
 * What happened to this catalog row, and the way back. Serves techniques and
 * exercises — the history renders identically for either.
 *
 * The console is the only writer of this content and there is no pull request
 * between a save and the athlete library, so this list is the entire record of
 * who changed what — the thing a PR history would otherwise be.
 *
 * Newest first, and the CURRENT state is revision 1 in the list rather than
 * something separate: each entry is the row as it looked after that write, so
 * the top row is what is live now. That is why restoring is a copy rather than
 * a replay.
 */
export function RevisionHistory({
  revisions,
  restore,
}: {
  // Both catalogs, because the history renders identically for either: the
  // component only reads `payload.name`, and a second near-identical component
  // is how the two would drift apart.
  revisions: Revision<Technique | Exercise>[];
  restore: (revision: number) => (prev: PublishResult, form: FormData) => Promise<PublishResult>;
}) {
  if (revisions.length === 0) {
    return (
      <p className="text-[13px] text-text-secondary">
        No history yet. A row gets one the first time it is edited here — the shipped catalog
        has none, which is not a gap: nothing has changed it.
      </p>
    );
  }

  return (
    <ol className="flex flex-col">
      {revisions.map((rev, i) => (
        <li
          key={rev.revision}
          className={`grid grid-cols-[auto_1fr_auto_auto] items-center gap-4 rounded-lg px-3 py-3 text-[13px] ${
            i % 2 === 0 ? "bg-card" : ""
          }`}
        >
          <span className="font-mono text-[12px] text-text-muted">#{rev.revision}</span>
          <span>
            <span className="font-semibold">{rev.action}</span>
            {/* The name AT THAT REVISION, which is the useful thing when the
                change being reviewed is a rename. */}
            <span className="text-text-secondary"> — {rev.payload.name}</span>
          </span>
          <span className="truncate font-mono text-[11px] text-text-muted" title={rev.actor}>
            {rev.actor}
          </span>
          <span className="flex items-center gap-3 justify-self-end text-text-secondary">
            {formatUTC(rev.created_at)}
            {/* No restore on the newest entry: it is already the current state,
                so the button would do nothing but add a revision saying so. */}
            {i > 0 ? <RestoreButton action={restore(rev.revision)} /> : null}
          </span>
        </li>
      ))}
    </ol>
  );
}

function RestoreButton({
  action,
}: {
  action: (prev: PublishResult, form: FormData) => Promise<PublishResult>;
}) {
  const [result, formAction, pending] = useActionState<PublishResult, FormData>(action, {
    status: "idle",
  });

  return (
    <form action={formAction}>
      <button
        type="submit"
        disabled={pending}
        className="rounded-[8px] border border-border-strong px-3 py-1 text-[12px] font-semibold disabled:opacity-60"
      >
        {pending ? "Restoring…" : "Restore"}
      </button>
      {result.status === "error" ? (
        <span role="alert" className="ml-2 text-[12px] text-danger-text">
          {result.message}
        </span>
      ) : null}
    </form>
  );
}
