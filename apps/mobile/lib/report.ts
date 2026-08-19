import { capture } from './telemetryClient';

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
  _getToken: () => Promise<string | null>,
  kind: ReportKind,
  message: string,
  details?: Record<string, unknown>,
): void {
  // Now a thin front for the buffered reporter rather than its own `fetch`.
  //
  // The old body posted once per call, which was right while this had exactly
  // one deliberate call site. It is wrong the moment the crash path feeds the
  // same pipe: a render loop throwing sixty times a second was sixty POSTs a
  // second. `telemetry.ts` coalesces, caps, batches and bounds; everything the
  // old comment promised about never throwing and never retrying is preserved
  // there, and the message trimming and detail redaction are stricter.
  //
  // `_getToken` is unused: the reporter holds the token source installed at the
  // root, so a call site no longer has to supply one. Kept in the signature so
  // this stays a drop-in for the existing caller, and because a caller that
  // *had* a token is not a caller that should be rewritten to prove it.
  capture('error', kind, message, details);
}
