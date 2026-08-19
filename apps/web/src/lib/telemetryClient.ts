"use client";

import { DEFAULTS, TelemetryBuffer, type BufferedEvent, type Level, type ReportKind } from "@/lib/telemetry";
import { newTraceId, traceparent } from "@/lib/trace";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8080";
const API_BASE = `${API_URL}/v1`;

/**
 * The transport half for web.
 *
 * `telemetry.ts` decides WHAT leaves the browser; this decides when and puts it
 * on the wire. Its mobile counterpart does the same job against a completely
 * different runtime, and **that difference is why only the buffer is
 * duplicated**: React Native routes unhandled rejections through
 * `promise/setimmediate/rejection-tracking` into `ExceptionsManager`, bypassing
 * `ErrorUtils`; a browser has real `unhandledrejection` and `error` events.
 *
 * That is not a detail a good abstraction hides. It is the exact thing each
 * platform's correctness depends on — N43's worst defect was hooking the
 * browser's answer on the phone, where it installed nothing and did so
 * silently. A shared transport would have made that mistake structural.
 *
 * Everything else follows the mobile client, including the rule that outranks
 * the rest: **reporting a problem must never create one.** Nothing here throws,
 * nothing blocks a caller, and a failed send is never retried — but it IS
 * counted, so an operator can tell a quiet browser from one that stopped being
 * able to tell us anything.
 */

let buffer = new TelemetryBuffer();
let timer: ReturnType<typeof setInterval> | null = null;
let tokenSource: (() => Promise<string | null>) | null = null;
let installed = false;

/**
 * One trace id per page load, reused by every report from it.
 *
 * `api.ts` mints a fresh id per REQUEST, which is right for correlating one
 * call; this is the other axis — "what happened in this browser session" — and
 * the server already understands the header, so it costs nothing.
 */
const runTraceId = newTraceId();

export function sessionTraceId(): string {
  return runTraceId;
}

/** Record something. Never throws; never sends. */
export function capture(
  level: Level,
  kind: ReportKind,
  message: string,
  details?: Record<string, unknown>,
): void {
  try {
    buffer.record(level, kind, message, details, Date.now());
    if (buffer.shouldFlush(Date.now())) void flush();
  } catch {
    // A reporter that throws while reporting is the one failure that cannot be
    // reported. Swallowed unconditionally.
  }
}

/**
 * Send whatever is buffered, as one request.
 *
 * Drained before the await, not after a successful response — holding events
 * until the network confirms is how a browser on bad wifi accumulates the flood
 * the buffer exists to prevent. A failure is accounted through `recordLoss`.
 */
export async function flush(): Promise<void> {
  let batch: BufferedEvent[] = [];
  let lost = 0;
  try {
    if (buffer.size === 0) return;
    batch = buffer.drain(Date.now());
    if (batch.length === 0) return;

    const token = await tokenSource?.();
    if (!token) {
      buffer.recordLoss(batch.length);
      return;
    }

    // Taken before the send, so it must be given back on EVERY failure path
    // below — the mobile copy shipped a version that did not, and ten losses
    // plus a failed flush of five ended at five. Same bug is available here.
    lost = buffer.takeLost();
    const res = await fetch(`${API_BASE}/client-errors`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        traceparent: traceparent(runTraceId),
      },
      // `keepalive` so a flush started as the tab closes is still delivered —
      // and the claim is bounded, because the first version of this comment
      // overclaimed and review said so. It guarantees the request outlives the
      // page ONCE IT IS ON THE WIRE. It does not guarantee that the CORS
      // preflight completes (this API is cross-origin and the request carries
      // `Authorization`), nor that the `await tokenSource()` above it returns —
      // and Clerk's default token lives ~60s, so that call frequently is a
      // network refresh. A final flush therefore often does not make it.
      //
      // `sendBeacon` cannot carry the header, so this is still the right
      // design; it is just not a guarantee. The residual consequence is worth
      // knowing: the in-memory `lost` tally dies with the page too, so across
      // an unload "quiet" and "silenced" are not fully distinguishable on web
      // the way they are on the phone.
      keepalive: true,
      // **Below the redaction boundary.** Everything spread into `details`
      // here bypasses `redact()`, because it is composed after the buffer has
      // already sanitised what the caller supplied. That is fine for these —
      // every one is telemetry's own bookkeeping — and it must stay that way:
      // nothing athlete-derived may be added to this object. A `url:
      // location.href` here would leave the browser with no allowlist between
      // it and the wire, and the parity checker guards the buffer files, not
      // this hop. Found in review.
      body: JSON.stringify({
        events: batch.map((e, i) => ({
          kind: e.kind,
          message: e.message,
          error_code: e.level,
          details: {
            ...e.details,
            occurrences: e.count,
            suppressed: e.dropped,
            // Batch-scoped, so it rides on the first event only. On every
            // event, summing it would multiply by batch size.
            ...(i === 0 && lost > 0 ? { lost_events: lost } : null),
            first_at: new Date(e.firstAt).toISOString(),
            last_at: new Date(e.lastAt).toISOString(),
            fingerprint: e.fingerprint,
          },
        })),
      }),
    });
    if (!res.ok) buffer.recordLoss(batch.length + lost);
  } catch {
    buffer.recordLoss(batch.length + lost);
  }
}

/**
 * Install the browser's global handlers.
 *
 * Idempotent against React strict mode, which runs effects twice in
 * development — without the guard the listeners stack and every error is
 * captured twice, making the counts this feature exists to report into a lie.
 *
 * **It does NOT fully survive Fast Refresh**, and the first version of this
 * comment claimed it did. Editing this module re-evaluates it, so `installed`
 * resets to `false` while the previous module's anonymous listeners remain on
 * `window` — a reinstall then stacks a second set. Development-only, and the
 * honest scope is worth more than the reassurance: if exact counts in dev ever
 * matter, the flag belongs on `window` under a symbol rather than in module
 * scope.
 */
export function installTelemetry(getToken: () => Promise<string | null>): void {
  tokenSource = getToken;
  if (installed) return;
  if (typeof window === "undefined") return; // never on the server
  installed = true;

  // `window.onerror`'s event form, so a listener rather than an assignment —
  // assigning would clobber anything else that had registered, and this
  // observes rather than intercepts.
  window.addEventListener("error", (ev: ErrorEvent) => {
    try {
      capture("error", "client_error", describe(ev.error ?? ev.message), {
        reason: "unhandled",
      });
    } catch {
      // Never throw out of a handler we do not own.
    }
  });

  // The browser really does have this one — unlike React Native, where the
  // same name is a DOM API that silently installs nothing.
  window.addEventListener("unhandledrejection", (ev: PromiseRejectionEvent) => {
    try {
      capture("error", "client_error", describe(ev.reason), {
        reason: "unhandled_rejection",
      });
    } catch {
      /* as above */
    }
  });

  // A last flush as the tab goes away. `visibilitychange` rather than
  // `beforeunload`: mobile browsers frequently never fire `beforeunload`, and
  // `hidden` is the last event guaranteed on a backgrounded tab.
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") void flush();
  });

  if (!timer) {
    timer = setInterval(() => {
      if (buffer.shouldFlush(Date.now())) void flush();
    }, DEFAULTS.flushAfterMs);
  }
}

/**
 * Whether a change of signed-in athlete requires dropping the buffer.
 *
 * Pulled out of `Telemetry.tsx` as a plain function because the decision is
 * the part that was WRONG — the component only handled someone → null, and
 * missed null → someone, which is the case where a pre-auth event gets
 * attributed to whoever signs in next. A `useEffect` body cannot be
 * mutation-tested in this app (there is no jsdom here, deliberately), so the
 * logic worth guarding lives where a test can reach it and the component keeps
 * only the wiring.
 *
 * Keyed on WHO rather than on whether-signed-in: the effect also re-runs when
 * Clerk's `getToken` identity changes, and clearing on that would drop events
 * nobody had a problem with.
 */
export function shouldClearForIdentity(
  last: string | null,
  next: string | null,
): boolean {
  return last !== next;
}

/**
 * Drop the buffer and forget the account.
 *
 * **Must be called on sign-out**, or events buffered under one athlete — and
 * their accumulated loss tally — are POSTed under the next athlete's token and
 * attributed to them. That was a real blocking finding on the mobile side; the
 * same window exists here.
 *
 * It deliberately does not clear `installed`: the listeners are page-wide and
 * account-independent, and reinstalling would stack them.
 */
export function clearTelemetryForSignOut(): void {
  buffer = new TelemetryBuffer();
  tokenSource = null;
}

/** Full teardown, for tests. */
export function resetTelemetry(): void {
  if (timer) clearInterval(timer);
  timer = null;
  installed = false;
  tokenSource = null;
  buffer = new TelemetryBuffer();
}

/**
 * A message from whatever was thrown.
 *
 * **Not the stack**, deliberately — the same call the mobile copy makes. A
 * browser stack carries bundle paths and, in development, the developer's own
 * filesystem. The scrubbing of quoted content happens in the buffer, on every
 * path, so it is not repeated here.
 */
function describe(e: unknown): string {
  if (e instanceof Error) return `${e.name}: ${e.message}`;
  if (typeof e === "string") return e;
  if (e && typeof e === "object") {
    const o = e as { message?: unknown; code?: unknown; name?: unknown };
    const parts = [o.name, o.code, o.message].filter((v) => typeof v === "string");
    if (parts.length > 0) return parts.join(": ");
  }
  return "unknown error";
}
