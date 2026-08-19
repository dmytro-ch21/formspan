"use client";

import { useEffect } from "react";

import { capture } from "@/lib/telemetryClient";

/**
 * The route error boundary — and the reason it exists is that it REPORTS.
 *
 * Next renders this when a Server or Client Component throws during render.
 * Nothing in `window.addEventListener('error')` sees that: React catches it at
 * the boundary, so without this file a render crash is invisible to the
 * reporter while being the single most visible thing to the athlete.
 *
 * `digest` is Next's own id for a server-side error, and it is the ONLY way to
 * join this to the server log — the real message and stack are withheld from
 * the client in production on purpose, so the digest is what an operator
 * matches against.
 */
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    capture("fatal", "client_error", `${error.name}: ${error.message}`, {
      reason: "render_boundary",
      // Allowlisted as `code`, since that is what it is: an opaque server-side
      // identifier, not content. Nothing about the athlete is in it.
      code: error.digest,
    });
  }, [error]);

  return (
    <div className="flex min-h-[60vh] flex-col items-center justify-center gap-4 p-8 text-center">
      <h1 className="font-display text-2xl uppercase">Something broke</h1>
      <p className="max-w-md text-sm text-text-muted">
        This has been reported. Nothing you had logged is affected — your
        training and food are stored on the server, not on this page.
      </p>
      <button
        type="button"
        onClick={reset}
        className="rounded-control bg-accent-fill px-4 py-2 text-sm font-semibold text-accent-on-fill"
      >
        Try again
      </button>
      {error.digest && (
        <p className="text-[0.6875rem] text-text-dim">
          {/* Shown so a support conversation has something exact to quote. It
              is an opaque id, not a stack — safe to put on screen. */}
          Reference {error.digest}
        </p>
      )}
    </div>
  );
}
