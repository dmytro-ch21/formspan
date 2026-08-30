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
// Bumped on every install and on `resetTelemetry`. The self-test below
// resolves on its own timer, well after `installRejectionTracking` returns —
// long enough that a test's `resetTelemetry` (or Fast Refresh re-running this
// module) can land in between. A stale timer completing after that must not
// overwrite state a newer install (or a reset) already owns.
let rejectionTrackingEpoch = 0;
let rejectionSelfTestTimer: ReturnType<typeof setTimeout> | null = null;
// Real time, not simulated: the underlying tracker (either engine) waits to
// see if a late `.catch` shows up before calling `onUnhandled` at all — the
// `promise` package's own fallback path waits up to 2000ms for anything not
// in its TypeError/RangeError/ReferenceError whitelist, which our marker
// never is. 3000ms clears that with margin. Overridable for tests, which
// would otherwise carry that wait for real, once per `installTelemetry` call.
let rejectionSelfTestTimeoutMs = 3000;

/**
 * Exists for tests — the production default above would make every test in
 * this file that calls `installTelemetry` carry a real multi-second wait for
 * a self-test result nothing in that test even reads. Harmless in
 * production; nothing there calls it.
 */
export function setRejectionSelfTestTimeoutMsForTests(ms: number): void {
  rejectionSelfTestTimeoutMs = ms;
}

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
 * **The fix that shipped for that (N43) composed over
 * `promise/setimmediate/rejection-tracking` and set the flag true the instant
 * `enable()` returned without throwing — and that is a second, quieter version
 * of the exact same bug (N463).** `enable()` patches
 * `Promise._B`/`Promise._C` on `promise/setimmediate/core`'s OWN Promise
 * class — not `globalThis.Promise`. On Hermes, which is this app's engine on
 * every platform it ships to, `Core/polyfillPromise.js` takes the
 * `HermesInternal.hasPromise()` branch and never replaces `globalThis.Promise`
 * with that class, so the two are unrelated objects: the tracker patches a
 * Promise class the app never constructs anything from. `enable()` still
 * returns cleanly — it has no way to know its target is disconnected — so the
 * old flag came back `true` while genuinely observing nothing, forever, on
 * every build this app ships. That is defect #1 from #463 in its most
 * concrete form: "enable() didn't throw" is not "rejections arrive".
 *
 * **The fix: use whichever tracker actually sees `globalThis.Promise`, and
 * prove it rather than assume it.** Hermes ships its own tracker,
 * `HermesInternal.enablePromiseRejectionTracker`, typed identically to
 * `promise/setimmediate/rejection-tracking`'s `enable` (RN's own
 * `flow/HermesInternalType.js` says so) — and it is wired to the SAME
 * `globalThis.Promise` the app's code actually uses, because Hermes's
 * `hasPromise()` is exactly the condition under which `globalThis.Promise`
 * stays Hermes's own. Where Hermes does not provide native Promise support,
 * `polyfillPromise.js` DOES replace `globalThis.Promise` with
 * `promise/setimmediate/es6-extensions` — the very class
 * `promise/setimmediate/rejection-tracking` patches — so the original
 * mechanism is exactly right there. Which one is live is chosen once, here,
 * by asking Hermes rather than assuming either engine.
 *
 * That still leaves "the composed handler is wired to the right Promise but
 * something else about it is wrong" — RN re-enabling tracking after us, this
 * app's options shape drifting from what either API expects, a second
 * consumer overwriting the handler. So immediately after installing, this
 * deliberately rejects a promise NOBODY catches and waits, on a real clock,
 * to see whether the handler installed above is the one that reports it. Only
 * that observation — not the `enable()` call returning — sets the flag true.
 *
 * **If this cannot be installed, or installs but never delivers, it says so
 * out loud**, with DIFFERENT wording for the two cases so they read apart in
 * `health_events`: a reporter whose rejection half is quietly missing is the
 * exact failure this project keeps meeting — a CI run with no checks reading
 * as passing, a skipped test printing `ok`, an empty array meaning both "none"
 * and "we never asked".
 */
function installRejectionTracking(): void {
  const epoch = ++rejectionTrackingEpoch;
  if (rejectionSelfTestTimer) clearTimeout(rejectionSelfTestTimer);
  rejectionSelfTestTimer = null;
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

    // A fresh object per install: it can only ever be `===` the rejection we
    // deliberately create below, never a real error the app throws — even one
    // that happens to share a message, a code, or (for an object rejection) a
    // reference from elsewhere in the same run.
    const selfTestMarker: Record<string, never> = {};
    let selfTestObserved = false;

    const composedOptions = {
      ...rnOptions,
      allRejections: true,
      onUnhandled: (id: unknown, rejection: unknown) => {
        if (rejection === selfTestMarker) {
          // Our own probe, not a real rejection. Observed, not reported —
          // and not chained to `rnUnhandled` either, which would otherwise
          // print a dev-mode "Uncaught (in promise)" warning for a promise
          // that was never a real problem.
          selfTestObserved = true;
          return;
        }
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
    };

    const hermes = (
      globalThis as {
        HermesInternal?: {
          hasPromise?: () => boolean;
          enablePromiseRejectionTracker?: (opts: Record<string, unknown>) => void;
        };
      }
    ).HermesInternal;

    // Which `Promise` constructor the self-test rejects on has to match
    // whichever one the tracker just installed is actually wired to — see the
    // doc comment above. On Hermes that is `globalThis.Promise` itself. In
    // the fallback branch it is NOT `globalThis.Promise` under Jest (Node's
    // own native Promise, unrelated to either tracker) — it is this exact
    // class, the same one `enable()` just patched, and the same one
    // `Core/Promise.js` makes `globalThis.Promise` on a real non-Hermes
    // device. Requiring it explicitly rather than reading `globalThis.Promise`
    // is what keeps the self-test faithful in both places it runs.
    let selfTestPromise: { reject: (v: unknown) => unknown };

    if (hermes?.hasPromise?.() === true && typeof hermes.enablePromiseRejectionTracker === 'function') {
      // The branch that matters on-device: Hermes owns `globalThis.Promise`
      // here, and this is the tracker actually wired to it.
      hermes.enablePromiseRejectionTracker(composedOptions);
      selfTestPromise = globalThis.Promise;
    } else {
      tracking.enable(composedOptions);
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      selfTestPromise = require('promise/setimmediate/es6-extensions') as {
        reject: (v: unknown) => unknown;
      };
    }

    // Deliberately unhandled: no `.catch`, no `await`. Whichever tracker was
    // just installed above is the one that has to notice THIS.
    selfTestPromise.reject(selfTestMarker);

    rejectionSelfTestTimer = setTimeout(() => {
      rejectionSelfTestTimer = null;
      // A later install or a `resetTelemetry` already moved on; this result
      // is about an install nothing points at any more.
      if (epoch !== rejectionTrackingEpoch) return;
      if (selfTestObserved) {
        rejectionTrackingInstalled = true;
      } else {
        rejectionTrackingInstalled = false;
        // Distinct wording from the require-throws message below on purpose:
        // this is "installed, but proven not to deliver", a different failure
        // mode that needs to read apart in `health_events`.
        capture(
          'error',
          'client_error',
          'telemetry: rejection tracking installed but not delivering',
          { reason: 'self_test_not_observed' },
        );
      }
    }, rejectionSelfTestTimeoutMs);
    (rejectionSelfTestTimer as unknown as { unref?: () => void }).unref?.();
  } catch {
    rejectionTrackingInstalled = false;
    // Deliberately visible. This is the one failure that would otherwise leave
    // the feature half-missing with everything looking fine.
    capture('error', 'client_error', 'telemetry: rejection tracking unavailable', {
      reason: 'install_failed',
    });
  }
}

/**
 * Whether we have PROVEN a rejection reaches our handler — not whether
 * `enable()` returned without throwing. Read by tests and (via
 * `apps/mobile/app/settings.tsx`) by an athlete on the device it is actually
 * about, and worth having as a fact rather than an assumption: the first
 * version of this file was a no-op that believed itself installed, and the
 * second (N463) was `enable()` returning cleanly while patching a Promise
 * class the app never used — both looked identical to this function's old
 * body, which is why what it returns now is the outcome of a real self-test,
 * not the success of a call that could not tell the difference.
 */
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
  if (rejectionSelfTestTimer) clearTimeout(rejectionSelfTestTimer);
  rejectionSelfTestTimer = null;
  // Invalidates any self-test still in flight, so its result — arriving on
  // its own timer, after this call returns — cannot land on a state this
  // reset already claimed to have cleared.
  rejectionTrackingEpoch++;
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

