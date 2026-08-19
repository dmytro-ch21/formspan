"use client";

import { useEffect } from "react";
import { useAuth } from "@clerk/nextjs";

import { clearTelemetryForSignOut, installTelemetry } from "@/lib/telemetryClient";

/**
 * Installs the reporter for the whole app.
 *
 * A component rather than a call in `layout.tsx` because the root layout is a
 * Server Component and this needs the browser — and because it needs Clerk's
 * `getToken`, which is a hook. Rendered once at the root, it mounts before any
 * page and the handlers are live for the first error a session can produce.
 *
 * It renders nothing.
 */
export function Telemetry() {
  const { isSignedIn, getToken } = useAuth();

  useEffect(() => {
    if (!isSignedIn) {
      // Clear on sign-out, before anything can flush. Without it one athlete's
      // buffered events — and their loss tally — go out under the next
      // athlete's token and are attributed to them. This was a blocking review
      // finding on mobile; the same 30-second window exists here.
      clearTelemetryForSignOut();
      return;
    }
    installTelemetry(getToken);
  }, [isSignedIn, getToken]);

  return null;
}
