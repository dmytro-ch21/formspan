"use client";

import { useActionState } from "react";

import type { PublishResult } from "./actions";

/**
 * The one control that makes a draft visible to athletes. Serves both catalogs.
 *
 * Deliberately NOT part of the edit form. React would happily put it there as a
 * second submit button, and then a stray Enter in a text field could publish a
 * half-written row — the exact thing drafts exist to prevent. Its own form, its
 * own action, its own endpoint, all the way down.
 *
 * It says what it will do rather than naming itself after the state it is in:
 * "Publish" is an instruction, and the sentence beside it is the consequence.
 * That sentence stays catalog-NEUTRAL: techniques land in the library and
 * exercises in the workout catalog, so naming either one makes the button
 * contradict the notice printed directly above it on the other screen.
 */
export function PublishButton({
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
          {pending ? "Publishing…" : "Publish"}
        </button>
        <span className="text-[13px] text-text-secondary">
          Makes it visible to athletes. There is no unpublish — see the note.
        </span>
      </div>

      {result.status === "error" ? (
        // `role="alert"` rather than a styled div: this is the only feedback
        // the operator gets, and a failed publish that looks like a successful
        // one is worse than no button.
        <p role="alert" className="text-[13px] text-danger-text">
          {result.message}
        </p>
      ) : null}
    </form>
  );
}
