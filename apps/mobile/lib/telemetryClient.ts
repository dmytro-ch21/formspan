import { DEFAULTS, TelemetryBuffer, type BufferedEvent, type Level, type ReportKind } from './telemetry';
import { newTraceId, traceparent } from './trace';

const API_URL = process.env.EXPO_PUBLIC_API_URL ?? 'http://localhost:8080';
const API_BASE = `${API_URL}/v1`;

/**
 * The transport half: a process-wide buffer, a timer, and the global handlers.
 *
 * `telemetry.ts` decides WHAT leaves the device; this decides when it goes and
 * puts it on the wire. Split so that everything with a rule in it is pure and
 * testable without a device, and everything here is the thin part that cannot
 * be — a timer, a fetch and two runtime hooks.
 *
 * # Reporting a problem must never create one
 *
 * `report.ts` established this and it still holds, harder now that the crash
 * path feeds in: nothing here throws, nothing blocks a caller, and a failed
 * send is never retried. A device that cannot reach the API to *sync* cannot
 * reach it to complain either, and a retry queue for reports would be a second
 * outbox competing for exactly the connectivity the real one needs.
 *
 * Losing a report is acceptable; losing training data is not. The two are
 * ranked, not balanced.
 *
 * **But a lost report is COUNTED.** `recordLoss` feeds the tally that rides out
 * on the next successful flush, so an operator can tell a quiet device from one
 * that stopped being able to tell us anything. That distinction is the whole
 * reason this file is careful — the failure being guarded against is a failure
 * the surrounding machinery reports as success.
 */

let buffer = new TelemetryBuffer();
let timer: ReturnType<typeof setInterval> | null = null;
let tokenSource: (() => Promise<string | null>) | null = null;
let installed = false;
let previousErrorHandler: ((e: unknown, isFatal?: boolean) => void) | null = null;
let rejectionTrackingInstalled = false;

/**
 * One trace id for the whole app run.
 *
 * Deliberately NOT a fresh one per request, which is what `apiRequest` does.
 * The server already correlates by trace, so a stable id per run is what turns
 * "the athlete says it broke around four" into one query rather than a scan —
 * and it costs nothing, because the header is already being sent.
 */
const runTraceId = newTraceId();

/** The run's trace id, so a support conversation has something to quote. */
export function sessionTraceId(): string {
  return runTraceId;
}

/**
 * Record something. Never throws; never sends.
 *
 * The buffer decides whether this occurrence is worth a payload; the flush
 * decides when. A caller does not get to force either, which is what stops the
 * next person to add a call site from reintroducing per-occurrence sending.
 */
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
    // A reporter that throws while reporting is the one failure mode that
    // cannot be reported. Swallowed unconditionally.
  }
}

/**
 * Send whatever is buffered, as ONE request.
 *
 * The buffer is drained before the await, not after a successful response —
 * see `TelemetryBuffer.drain`. Holding events until the network confirms is how
 * a device with no signal accumulates the flood this whole module exists to
 * prevent.
 */
export async function flush(): Promise<void> {
  let batch: BufferedEvent[] = [];
  let lost = 0;
  try {
    if (buffer.size === 0) return;
    batch = buffer.drain(Date.now());
    if (batch.length === 0) return;

    // `useAuthToken`'s getter returns a token or THROWS `OfflineError` — it
    // never returns null — so this branch is reached when signed out, not when
    // offline. Offline lands in the catch below, which accounts for the loss
    // the same way. Stated because the first version of this comment claimed
    // the opposite and review caught it.
    const token = await tokenSource?.();
    if (!token) {
      // The events are already out of the buffer, so account for them rather
      // than pretending they sent.
      buffer.recordLoss(batch.length);
      return;
    }

    // Taken before the send, so it has to be given back on every failure path
    // below. Taking it and dropping it on a 4xx was the bug review found: ten
    // ring evictions plus a failed flush of five ended the tally at five, not
    // fifteen — events dropped with nothing counted, which is the one thing
    // this design forbids.
    lost = buffer.takeLost();
    const res = await fetch(`${API_BASE}/client-errors`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        traceparent: traceparent(runTraceId),
      },
      body: JSON.stringify({
        events: batch.map((e, i) => ({
          kind: e.kind,
          message: e.message,
          error_code: e.level,
          details: {
            ...e.details,
            // The three numbers that keep a suppression honest. `occurrences`
            // is the true count behind one coalesced row; `suppressed` is what
            // the per-fingerprint cap hid; `lost_events` is whole events that
            // fell off the ring or died in a failed flush. Without them a
            // bounded reporter and a broken one look identical.
            occurrences: e.count,
            suppressed: e.dropped,
            // Batch-scoped, so it goes on the FIRST event only. Stamped on
            // every event it would multiply by batch size the moment anyone
            // summed it — a made-up number in the field whose whole job is to
            // be trustworthy about loss. Found in review.
            ...(i === 0 && lost > 0 ? { lost_events: lost } : null),
            first_at: new Date(e.firstAt).toISOString(),
            last_at: new Date(e.lastAt).toISOString(),
            fingerprint: e.fingerprint,
          },
        })),
      }),
    });
    if (!res.ok) {
      // A 4xx means this batch will never be accepted, so there is nothing to
      // retry — but the loss is real and is carried forward, INCLUDING the
      // earlier tally this send was carrying.
      buffer.recordLoss(batch.length + lost);
    }
  } catch {
    buffer.recordLoss(batch.length + lost);
  }
}

/**
 * Install the global handlers.
 *
 * Idempotent, because Fast Refresh re-runs module bodies and a second
 * `setGlobalHandler` would chain onto our own wrapper — each reload adding a
 * layer, which is a leak that only shows up in development and only after a
 * while.
 */
export function installTelemetry(getToken: () => Promise<string | null>): void {
  tokenSource = getToken;
  if (installed) return;
  installed = true;

  // Unhandled JS errors. `ErrorUtils` is React Native's, not the DOM's, and it
  // is the only hook that sees an error thrown outside a component tree.
  const errorUtils = (
    globalThis as {
      ErrorUtils?: {
        getGlobalHandler?: () => (e: unknown, isFatal?: boolean) => void;
        setGlobalHandler?: (h: (e: unknown, isFatal?: boolean) => void) => void;
      };
    }
  ).ErrorUtils;

  previousErrorHandler = errorUtils?.getGlobalHandler?.() ?? null;
  const chainTo = previousErrorHandler;
  errorUtils?.setGlobalHandler?.((e: unknown, isFatal?: boolean) => {
    try {
      capture(isFatal ? 'fatal' : 'error', 'client_error', describe(e), { reason: 'unhandled' });
    } catch {
      // Swallowed as well as chained. `describe(e)` runs as an ARGUMENT, so it
      // is inside this try — and letting it escape would throw a NEW error out
      // of the runtime's own error handler, from the reporter, while it was
      // reporting. Reporting a problem must never create one.
    } finally {
      // **`finally`, not after the call.** `describe(e)` is evaluated as an
      // ARGUMENT, so it runs outside `capture`'s own try/catch — and it can
      // throw, on a hostile proxy or an Error subclass whose `name` getter
      // throws. When it did, the chain below was skipped and the reporter had
      // swallowed the red box in development and the runtime's fatal handling
      // in production, for exactly the strange errors most worth seeing.
      // Found in review.
      chainTo?.(e, isFatal);
    }
  });

  installRejectionTracking();

  if (!timer) {
    timer = setInterval(() => {
      if (buffer.shouldFlush(Date.now())) void flush();
    }, DEFAULTS.flushAfterMs);
    (timer as unknown as { unref?: () => void }).unref?.();
  }
}

/**
 * Unhandled promise rejections — and this is NOT `addEventListener`.
 *
 * The first version used `globalThis.addEventListener('unhandledrejection')`,
 * which is a DOM API. **React Native does not have it**, so that install was a
 * silent no-op and the half of N43 that matters most — the offline sync path is
 * almost entirely promises — did not exist. Review suspected it; the runtime
 * confirms it: RN polyfills promises in `Core/polyfillPromise.js` and enables
 * `promise/setimmediate/rejection-tracking` with the options in
 * `Libraries/promiseRejectionTrackingOptions.js`, whose `onUnhandled` calls
 * `ExceptionsManager.handleException` **directly**, bypassing the `ErrorUtils`
 * global handler entirely. So neither hook above would ever have seen one.
 *
 * The fix is to re-enable rejection tracking with options that wrap RN's own,
 * which is what every reporter that works on RN does. RN's `onUnhandled` is
 * still called, so the development warning is unchanged.
 *
 * **If this cannot be installed, it says so out loud.** A reporter whose
 * rejection half is quietly missing is the exact failure this project keeps
 * meeting — a CI run with no checks reading as passing, a skipped test printing
 * `ok`, an empty array meaning both "none" and "we never asked". So a failure
 * here buffers a `client_error` rather than being swallowed: the Health screen
 * shows the gap instead of showing nothing.
 */
function installRejectionTracking(): void {
  try {
    // Required lazily and defensively: these are RN-internal paths, stable
    // across versions in practice but not contractually. A version that moves
    // them must degrade to "rejections not captured, and we said so" rather
    // than to a crash on launch.
    // `require`, not `import`, and the rule is disabled rather than the
    // headroom spent: a static import would be hoisted and evaluated at module
    // load, so a React Native version that moved either path would crash the
    // app on launch instead of degrading to "rejections not captured, and we
    // said so". Being lazy is the whole safety property here.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const tracking = require('promise/setimmediate/rejection-tracking') as {
      enable: (opts: Record<string, unknown>) => void;
    };
    const rnOptions =
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      (require('react-native/Libraries/promiseRejectionTrackingOptions') as {
        default?: Record<string, unknown>;
      }).default ?? {};

    const rnUnhandled = rnOptions.onUnhandled as
      | ((id: unknown, rejection: unknown) => void)
      | undefined;

    tracking.enable({
      ...rnOptions,
      allRejections: true,
      onUnhandled: (id: unknown, rejection: unknown) => {
        try {
          capture('error', 'client_error', describe(rejection), {
            reason: 'unhandled_rejection',
          });
        } catch {
          // Same rule as above: never throw out of a handler we do not own.
        } finally {
          // Same rule as the error handler: observe, never intercept. RN's own
          // handler still runs, so the dev warning and the exception report
          // are unchanged.
          rnUnhandled?.(id, rejection);
        }
      },
    });
    rejectionTrackingInstalled = true;
  } catch {
    rejectionTrackingInstalled = false;
    // Deliberately visible. This is the one failure that would otherwise leave
    // the feature half-missing with everything looking fine.
    capture('error', 'client_error', 'telemetry: rejection tracking unavailable', {
      reason: 'install_failed',
    });
  }
}

/** Whether the rejection hook is live. Read by tests, and worth having as a
 *  fact rather than an assumption, given the first version was a no-op. */
export function rejectionTrackingActive(): boolean {
  return rejectionTrackingInstalled;
}

/**
 * Clear the buffer and forget the account.
 *
 * **Must be called on sign-out.** Without it, events buffered under athlete A —
 * plus A's accumulated loss tally — are POSTed under athlete B's token at the
 * next flush and attributed to B in `health_events`. That is a real privacy
 * bug and review found it: this function existed and documented the hazard,
 * and nothing called it. The adjacent `setSyncIdentity` effect clears identity
 * on sign-out for exactly the same reason.
 *
 * It deliberately does NOT set `installed = false`. Uninstalling and
 * reinstalling would stack a second wrapper on top of the first — each one
 * chaining to the last — so every error would be captured twice and the count
 * would be a lie. The handlers are process-wide and account-independent; only
 * the buffer and the token source are per-account.
 */
export function clearTelemetryForSignOut(): void {
  buffer = new TelemetryBuffer();
  tokenSource = null;
}

/** Full teardown, for tests. Unhooks what it installed, so a reinstall in the
 *  same process cannot layer handlers. */
export function resetTelemetry(): void {
  if (timer) clearInterval(timer);
  timer = null;
  const errorUtils = (
    globalThis as { ErrorUtils?: { setGlobalHandler?: (h: unknown) => void } }
  ).ErrorUtils;
  if (previousErrorHandler) errorUtils?.setGlobalHandler?.(previousErrorHandler);
  previousErrorHandler = null;
  rejectionTrackingInstalled = false;
  installed = false;
  tokenSource = null;
  buffer = new TelemetryBuffer();
}

/**
 * A message from whatever was thrown.
 *
 * **Deliberately not the stack.** A stack is the most useful thing here and
 * also the most dangerous: React Native stacks carry file paths, and in a dev
 * build those include the developer's home directory. The `name: message` pair
 * fingerprints well enough to group, and the server already has the request
 * that failed.
 */
function describe(e: unknown): string {
  if (e instanceof Error) return `${e.name}: ${e.message}`;
  if (typeof e === 'string') return e;
  // Object-shaped rejections: read a message or code if there is one rather
  // than mapping every one of them to a single string. All of them collapsing
  // to "unknown error" made distinct bugs share one fingerprint AND one cap
  // slot, so each suppressed the others. Found in review.
  if (e && typeof e === 'object') {
    const o = e as { message?: unknown; code?: unknown; name?: unknown };
    const parts = [o.name, o.code, o.message].filter((v) => typeof v === 'string');
    if (parts.length > 0) return parts.join(': ');
  }
  return 'unknown error';
}

