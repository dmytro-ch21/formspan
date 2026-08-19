"use client";

import { useEffect, useRef } from "react";
import { useAuth } from "@clerk/nextjs";

import {
  clearTelemetryForSignOut,
  installTelemetry,
  shouldClearForIdentity,
} from "@/lib/telemetryClient";

/**
 * Installs the reporter for the whole app.
 *
 * A component rather than a call in `layout.tsx` because the root layout is a
 * Server Component and this needs the browser — and because it needs Clerk's
 * `getToken`, which is a hook. It renders nothing.
 *
 * **The window listeners are live only once somebody is signed in**, and the
 * comment here used to claim otherwise. That is a consequence of the endpoint
 * being authenticated rather than a choice: an event captured with no token
 * cannot be sent, and buffering it until one appears is exactly the
 * misattribution guarded against below. Signed-out render crashes are still
 * reported, because `app/error.tsx` calls `capture` directly.
 */
export function Telemetry() {
  const { isSignedIn, userId, getToken } = useAuth();
  const lastUser = useRef<string | null>(null);

  useEffect(() => {
    const current = isSignedIn ? (userId ?? null) : null;

    // Keyed on WHO, not on whether. The effect also re-runs when `getToken`'s
    // identity changes, and clearing on that would drop events nobody had a
    // problem with — so the buffer is dropped exactly when the athlete it
    // belongs to changes, in either direction.
    //
    // The null → someone transition matters as much as someone → null, and
    // that half was missing: an error on a PUBLIC page — the sign-in screen,
    // the landing page — buffers an event with nobody signed in, and no timer
    // is running yet to flush it, so it sits there. The first athlete to sign
    // in on that browser then ships it under their token and owns it on the
    // Health screen. Low content risk, wrong attribution, and on a shared
    // computer that is somebody else's error against your name. Found in
    // review.
    if (shouldClearForIdentity(lastUser.current, current)) {
      clearTelemetryForSignOut();
      lastUser.current = current;
    }

    if (isSignedIn) installTelemetry(getToken);
  }, [isSignedIn, userId, getToken]);

  return null;
}
