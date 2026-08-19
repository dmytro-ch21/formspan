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
  try {
    if (buffer.size === 0) return;
    batch = buffer.drain(Date.now());
    if (batch.length === 0) return;

    const token = await tokenSource?.();
    if (!token) {
      // Not signed in, or Clerk is unreachable. The events are already out of
      // the buffer, so account for them rather than pretending they sent.
      buffer.recordLoss(batch.length);
      return;
    }

    const lost = buffer.takeLost();
    const res = await fetch(`${API_BASE}/client-errors`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        traceparent: traceparent(runTraceId),
      },
      body: JSON.stringify({
        events: batch.map((e) => ({
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
            lost_events: lost,
            first_at: new Date(e.firstAt).toISOString(),
            last_at: new Date(e.lastAt).toISOString(),
            fingerprint: e.fingerprint,
          },
        })),
      }),
    });
    if (!res.ok) {
      // A 4xx means this batch will never be accepted, so there is nothing to
      // retry — but the loss is real and is carried forward.
      buffer.recordLoss(batch.length);
    }
  } catch {
    buffer.recordLoss(batch.length);
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
  // is the only hook that sees an error thrown outside a component tree — which
  // is where the sync path throws, since it runs off a timer rather than in a
  // render.
  const errorUtils = (
    globalThis as {
      ErrorUtils?: {
        getGlobalHandler?: () => (e: unknown, isFatal?: boolean) => void;
        setGlobalHandler?: (h: (e: unknown, isFatal?: boolean) => void) => void;
      };
    }
  ).ErrorUtils;

  const previous = errorUtils?.getGlobalHandler?.();
  errorUtils?.setGlobalHandler?.((e: unknown, isFatal?: boolean) => {
    capture(isFatal ? 'fatal' : 'error', 'client_error', describe(e), {
      reason: 'unhandled',
    });
    // **Always chain.** Replacing the default handler without calling it
    // swallows the red box in development and, worse, stops the runtime doing
    // whatever it would have done in production — turning a visible crash into
    // an app that quietly misbehaves. The reporter observes; it does not
    // intercept.
    previous?.(e, isFatal);
  });

  // Unhandled promise rejections. The offline sync path is almost entirely
  // promises, so this is the hook that actually covers the bugs N43 was filed
  // for; `ErrorUtils` alone would miss them.
  const g = globalThis as unknown as {
    addEventListener?: (t: string, cb: (ev: { reason?: unknown }) => void) => void;
  };
  g.addEventListener?.('unhandledrejection', (ev) => {
    capture('error', 'client_error', describe(ev?.reason), { reason: 'unhandled_rejection' });
  });

  if (!timer) {
    timer = setInterval(() => {
      if (buffer.shouldFlush(Date.now())) void flush();
    }, DEFAULTS.flushAfterMs);
    // Do not hold the event loop open for a reporter.
    (timer as unknown as { unref?: () => void }).unref?.();
  }
}

/** Tear down, for tests and for a sign-out that must not leak one account's
 *  buffered events into the next account's flush. */
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
 * **Deliberately not the stack.** A stack is the most useful thing here and
 * also the most dangerous: React Native stacks carry file paths, and in a dev
 * build those include the developer's home directory. The `name: message` pair
 * fingerprints well enough to group, and the server already has the request
 * that failed.
 */
function describe(e: unknown): string {
  if (e instanceof Error) return `${e.name}: ${e.message}`;
  if (typeof e === 'string') return e;
  return 'unknown error';
}
