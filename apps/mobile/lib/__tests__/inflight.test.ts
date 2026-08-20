/**
 * The guard that decides whether a finished request may still set state.
 *
 * Extracted from `library.tsx` and tested here because the bug it fixes is
 * **unobservable in a component test**: an unmounted screen has no tree to
 * query, and React 19 no longer warns about a state update on one. So the
 * inline version — `abortRef.current === ac` — could be wrong for an unmount
 * while every screen test stayed green, with a comment above it claiming the
 * case was covered. Mutation-checked: removing `!run.signal.aborted` from the
 * implementation turns the unmount case below red, and nothing else in the
 * suite notices.
 */

import { stillWanted } from '../inflight';

describe('stillWanted', () => {
  it('says yes while this run is the current one', () => {
    const run = new AbortController();
    expect(stillWanted(run, run)).toBe(true);
  });

  it('says no when a newer run replaced it', () => {
    // The supersede case: fast typing fires a request per debounce window, and
    // showing an error for an abandoned one makes typing look broken.
    const older = new AbortController();
    const newer = new AbortController();
    expect(stillWanted(newer, older)).toBe(false);
  });

  it('says no when the screen unmounted, even though the ref still points here', () => {
    // **The case the inline version got wrong.** The cleanup aborts the
    // controller and leaves the ref alone, so an identity check passes and the
    // state set runs on a component that is gone.
    const run = new AbortController();
    run.abort(); // what the unmount cleanup does
    expect(stillWanted(run, run)).toBe(false);
  });

  it('says no when both happened', () => {
    const older = new AbortController();
    const newer = new AbortController();
    older.abort();
    expect(stillWanted(newer, older)).toBe(false);
  });

  it('says no when there is no current run at all', () => {
    const run = new AbortController();
    expect(stillWanted(null, run)).toBe(false);
    expect(stillWanted(undefined, run)).toBe(false);
  });

  it('says YES for a request that timed out', () => {
    // Load-bearing, and the reason the deadline moved to the transport (N55):
    // `netFetch` aborts its OWN controller and throws `TimeoutError`, leaving
    // the caller's untouched. If a timeout aborted this one, the screen would
    // treat it as an unmount and show nothing — which is precisely the
    // permanent spinner `position/[id].tsx` shipped.
    const run = new AbortController();
    // No abort here: that is the whole assertion.
    expect(stillWanted(run, run)).toBe(true);
    expect(run.signal.aborted).toBe(false);
  });
});
