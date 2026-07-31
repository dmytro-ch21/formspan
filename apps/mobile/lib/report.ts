import { newTraceId, traceparent } from './trace';

const API_URL = process.env.EXPO_PUBLIC_API_URL ?? 'http://localhost:8080';
const API_BASE = `${API_URL}/v1`;

/**
 * Tells the server about a failure it has no way to observe.
 *
 * `sync_blocked` is the one that matters: the server refused a push and the
 * client has stopped retrying, so the athlete's training exists only on that
 * device. Every server-side metric stays green through this — the request that
 * would have carried the data never gets made again — which is exactly why the
 * client has to say so.
 */
export type ReportKind = 'client_error' | 'sync_blocked';

/**
 * Fire-and-forget by construction, and that is the whole design.
 *
 * Reporting a problem must never create one. It never throws, never blocks the
 * caller, and never retries: a device that cannot reach the API to *sync* also
 * cannot reach it to complain, and queuing failed reports would build a second
 * outbox whose failure mode is indistinguishable from the first one — while
 * spending exactly the connectivity the real outbox needs.
 *
 * Losing a report is therefore acceptable and losing training data is not. The
 * two are ranked, not balanced.
 */
export function report(
  getToken: () => Promise<string | null>,
  kind: ReportKind,
  message: string,
  details?: Record<string, unknown>,
): void {
  void (async () => {
    try {
      const token = await getToken();
      if (!token) return;
      await fetch(`${API_BASE}/client-errors`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          traceparent: traceparent(newTraceId()),
        },
        // Trimmed well under the server's 500 rather than to exactly it. The
        // server bounds *bytes* and `slice` counts UTF-16 code units, so a
        // message with any non-ASCII in it can pass this trim and still be
        // rejected — and since reporting is fire-and-forget, that rejection
        // would be completely silent. 200 leaves room for even 2 bytes per
        // character.
        body: JSON.stringify({ kind, message: message.slice(0, 200), details }),
      });
    } catch {
      // Deliberately silent. See above: the failure this reports is more
      // important than the report.
    }
  })();
}
