"use client";

import { useActionState } from "react";

import type { PublishResult } from "./actions";

/**
 * F23/#523. Retires a live technique — the ADMIN CONSOLE TRIGGER the ticket
 * names, and the reason there is no `DELETE /admin/techniques/{id}`.
 *
 * Its own form, its own action, its own endpoint, matching PublishButton's
 * own reasoning: a stray Enter in a text field elsewhere on the page must
 * never withdraw a technique athletes are training. Unlike publishing,
 * retiring is reversible — see ReactivateButton — so the copy here says so
 * rather than warning of a point of no return.
 */
export function RetireButton({
  action,
}: {
  action: (prev: PublishResult, form: FormData) => Promise<PublishResult>;
}) {
  const [result, formAction, pending] = useActionState<PublishResult, FormData>(action, {
    status: "idle",
  });

  return (
    <form action={formAction} className="flex flex-col gap-2">
      <div className="flex items-center gap-3">
        <button
          type="submit"
          disabled={pending}
          className="rounded-[10px] border border-border px-4 py-2 font-semibold text-text disabled:opacity-60"
        >
          {pending ? "Retiring…" : "Retire"}
        </button>
        <span className="text-[13px] text-text-secondary">
          Removes it from the library and search. Every curriculum item and session tag that
          already names it keeps working — this can be undone.
        </span>
      </div>

      {result.status === "error" ? (
        <p role="alert" className="text-[13px] text-danger-text">
          {result.message}
        </p>
      ) : null}
    </form>
  );
}
