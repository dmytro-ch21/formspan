/**
 * "Is this run still the one whose results anybody wants?"
 *
 * A screen that reloads on every keystroke keeps one `AbortController` in a
 * ref and aborts the previous one. Three things then end a run, and only one
 * of them is a failure worth showing:
 *
 * - **superseded** — a newer run replaced the ref;
 * - **unmounted** — the cleanup aborted the controller;
 * - **it actually failed** — a timeout, a 500, no route.
 *
 * ## Why this is a function rather than one line inlined at each site
 *
 * Because the obvious inline version is wrong in a way nothing notices, and it
 * was wrong here. `techniqueAbortRef.current === ac` looks like it covers both
 * of the first two, and it does not: an unmount calls `abort()` and **leaves
 * the ref pointing at the same controller**, so the check passes and the state
 * set runs on a component that is gone. React 19 no longer warns about that,
 * so the only symptom is nothing at all — and a comment sat above it claiming
 * the case was handled.
 *
 * That is the same class as the `signal.reason` bug this file's neighbours
 * document: a guarantee asserted in prose that the runtime does not provide.
 * The remedy is the same — make it a thing that can be tested, and test it.
 *
 * **Note what it does NOT cover, deliberately: a timeout.** Since N55 the
 * deadline belongs to `netFetch`, which aborts its own internal controller and
 * throws `TimeoutError`. The caller's controller is untouched, so a timed-out
 * run is still "wanted" and still reports its error — which is the whole point
 * of moving the deadline there.
 */
export function stillWanted(
  current: AbortController | null | undefined,
  run: AbortController,
): boolean {
  return current === run && !run.signal.aborted;
}
