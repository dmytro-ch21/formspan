"use client";

import { useState, useTransition } from "react";

import { clearAvatarAction } from "../actions";

/**
 * N12's moderation answer, on screen: an admin removes an account's avatar
 * here. There is no in-app report flow yet — a takedown is initiated
 * however a complaint reaches an operator today (email, a DM), the same way
 * every other admin action in this console is reached.
 *
 * A client component specifically for the pending/error state around one
 * button — everything else on this page is a plain server-rendered read.
 */
export function AvatarModeration({ userID, hasAvatar }: { userID: string; hasAvatar: boolean }) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  // Optimistic-on-success, not on click: a failed removal must keep showing
  // the button rather than silently pretending the avatar is gone.
  const [removed, setRemoved] = useState(false);

  if (!hasAvatar || removed) {
    return <p className="text-sm text-text-secondary">No avatar uploaded.</p>;
  }

  return (
    <div className="flex flex-col gap-2">
      <p className="text-sm text-text-secondary">
        This account has an uploaded avatar. Seeing it means opening the account in the app —
        this console does not render it.
      </p>
      <button
        type="button"
        disabled={pending}
        onClick={() => {
          setError(null);
          startTransition(async () => {
            const result = await clearAvatarAction(userID);
            if (result.ok) {
              setRemoved(true);
            } else {
              setError(result.message);
            }
          });
        }}
        className="w-fit rounded-md border border-border-strong px-3 py-1.5 text-[13px] font-semibold text-danger-text disabled:opacity-50"
      >
        {pending ? "Removing…" : "Remove avatar"}
      </button>
      {error && (
        <p role="alert" className="text-xs text-danger-text">
          {error}
        </p>
      )}
    </div>
  );
}
