"use client";

import { useActionState } from "react";

import type { PublishResult } from "./actions";

/**
 * F23/#523. Undoes a retirement — the inverse of RetireButton, and the reason
 * retiring is a decision an operator can walk back rather than a one-way door
 * like publishing.
 */
export function ReactivateButton({
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
          className="rounded-[10px] bg-accent-dark px-4 py-2 font-semibold text-page disabled:opacity-60"
        >
          {pending ? "Reactivating…" : "Reactivate"}
        </button>
        <span className="text-[13px] text-text-secondary">
          Makes it visible and recommendable again.
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
