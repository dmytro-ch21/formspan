"use client";

import { useEffect } from "react";

import { failureFromDigest, type AdminFailure } from "@/lib/adminFailure";
import { VolaLockup } from "./Brand";

/**
 * Error boundary for every admin screen's backend calls. Without this, each
 * failure mode (API down, 401 on an expired token, 403 from an
 * ADMIN_USER_IDS mismatch) surfaces as Next's unstyled default error page.
 *
 * The 403 case is the most likely one in practice: this app's own gate and
 * the backend's RequireAdmin read separate copies of ADMIN_USER_IDS, so
 * they can drift — the UI lets you in and the API then refuses.
 *
 * **Classified by `error.digest`, never by `error.message` — F65 (#1182).** It
 * used to be `message.includes("403")`, which worked in development and nowhere
 * else: a production build replaces a Server Component error's message before
 * it reaches this component, so every production failure fell through to "confirm
 * the API is running" — the drift 403 included. `adminFailure.ts` has the
 * measurement and the digest format; the server stamps it where the failure is
 * created.
 *
 * A failure nothing classified gets copy that says so, plus the digest to find
 * it in the server log. It used to get the API-is-down copy too, which sent the
 * operator to check a healthy API for what was a render bug.
 *
 * Moved up from `users/` to cover the whole app. `/content` and `/health` had
 * no boundary at all, so every read on them — the authored list, the ownership
 * check, the positions vocabulary — crashed to the default page. The write path
 * reports its own failures inside the form; this is for the reads around it.
 *
 * Branded, and for the same reason as `NotAuthorized`: this replaces the whole
 * page, masthead included, so without the lockup the likeliest failure in the
 * console is the one screen that doesn't look like it belongs to it. Inert
 * rather than a link home — "Try again" is the way out of here, and a logo
 * linking to a route that is currently throwing is a loop.
 */
export default function AdminError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("admin: failed to load", error);
  }, [error]);

  const failure = failureFromDigest(error.digest);
  const reference = failure?.ref ?? error.digest;

  return (
    <main className="flex min-h-screen flex-1 flex-col items-center justify-center gap-3 px-6 text-center">
      {/* Named on the wrapper — the primitives are unconditionally
          `aria-hidden`, so a standalone lockup has no accessible name and no
          way to be given one from outside. */}
      <span role="img" aria-label="VOLA Admin" className="mb-2">
        <VolaLockup width={104} />
      </span>

      <h1 className="font-barlow-condensed text-2xl font-bold tracking-[0.06em] uppercase">
        Couldn&apos;t load admin data
      </h1>

      <p className="max-w-md text-sm text-text-secondary">
        <Explanation failure={failure} />
      </p>

      {reference ? (
        <p className="max-w-md text-xs text-text-secondary">
          Reference <code>{reference}</code> — the server log shows the full error beside it.
        </p>
      ) : null}

      <button
        type="button"
        onClick={reset}
        className="mt-2 rounded-[9px] border border-border-strong px-3.5 py-2.5 font-barlow-condensed text-[11px] font-semibold tracking-[0.14em] text-button-text uppercase"
      >
        Try again
      </button>
    </main>
  );
}

function Explanation({ failure }: { failure: AdminFailure | null }) {
  switch (failure?.kind) {
    case "forbidden":
      return (
        <>
          The API rejected this account as not-an-admin. Your Clerk user ID is on this app&apos;s{" "}
          <code>ADMIN_USER_IDS</code> list but not the API&apos;s — check that the API&apos;s own{" "}
          <code>ADMIN_USER_IDS</code> (<code>backend/.env</code> locally) has the same value.
        </>
      );
    case "unauthorized":
      return <>The API rejected the session token. Try signing out and back in.</>;
    case "timeout":
      return (
        <>
          The API took too long to answer. It was reachable but didn&apos;t respond in time — try
          again, and check the API&apos;s logs if it keeps happening.
        </>
      );
    case "unreachable":
      return (
        <>
          Couldn&apos;t reach the API. Confirm it&apos;s running and reachable at{" "}
          <code>NEXT_PUBLIC_API_URL</code>.
        </>
      );
    case "api":
      return (
        <>
          The API answered with an error (HTTP {failure.status}). The server log has the detail.
        </>
      );
    default:
      return (
        <>
          Something failed while building this page, and it wasn&apos;t an API response this
          console recognises. The server log has the full error.
        </>
      );
  }
}
