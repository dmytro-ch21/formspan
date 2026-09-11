import { readFileSync } from 'fs';
import { join } from 'path';

/**
 * N528/#958 — a WIRING invariant, checked at the source level because no
 * unit test can reach across files to see it.
 *
 * This exists because it already went wrong: the strength and BJJ screens
 * got `hrSourceLine` (and, in W18, `absence`/`onSyncNow`) and the running
 * screen silently did not — a whole sport whose finished report never said
 * where its numbers came from, and whose no-HR card still showed the
 * pre-W18 catch-all sentence. Nothing failed; the screens render fine
 * without the props, which is exactly why it survived typecheck, lint and
 * every component test. `ac-verifier` caught it by reading the call sites.
 *
 * A component test per screen would be the better instrument, but the
 * running screen mounts MapView and GPS tracking and has no test harness
 * today. This is the same shape as `check-verify-chain.py` (which reads
 * package.json's own text): the invariant is "these three call sites agree",
 * and the text is where that lives.
 */

const SCREENS = [
  'app/session/[id].tsx',
  'app/bjj/session/[id].tsx',
  'app/running/[id].tsx',
] as const;

/** Every prop a finished session's report needs to be honest about its
 *  source (N528) and about an absence (W18). */
const REQUIRED_PROPS = ['absence=', 'sourceLabel=', 'onSyncNow=', 'hrSourceLine='] as const;

function screenSource(rel: string): string {
  return readFileSync(join(__dirname, '..', '..', rel), 'utf8');
}

describe('every session screen wires HRSessionReport the same way', () => {
  it.each(SCREENS)('%s renders HRSessionReport at all', (rel) => {
    // Guards the guard: if a screen stops rendering the report, the prop
    // assertions below would pass vacuously.
    expect(screenSource(rel)).toContain('<HRSessionReport');
  });

  it.each(SCREENS)('%s passes every source/absence prop', (rel) => {
    const src = screenSource(rel);
    for (const prop of REQUIRED_PROPS) {
      expect(src).toContain(prop);
    }
  });
});

/**
 * N544/#987 + W21/#992 — the OTHER half of the same wiring invariant: live
 * heart rate belongs to a run and to nothing else.
 *
 * The athlete's decision, in their words: *"let's disable the active hr for
 * today and bjj and strength, we will keep it only for running sessions for
 * monitoring and coaching"*, and *"lets make the bluetooth active
 * specifically when we want to activate a run."* W21 made that structural —
 * the BLE link is opened by `startWatch()` and released on finish/unmount —
 * so a live chip on a strength or BJJ screen could no longer connect even if
 * it were still rendered. It would sit at "Connecting…" forever, which is
 * worse than absent.
 *
 * Both halves are asserted, because they fail independently: the DISPLAY
 * (`LiveHRIndicator`) reappearing would show a dead chip, and the RECORDING
 * (`useHRRecording`) reappearing would arm a writer for a stream nothing
 * opens. `ac-verifier` graded #987 criterion 3 NOT MET for the absence of
 * exactly this guard — the suite above passed unchanged after the chips were
 * removed, so nothing would have noticed them coming back.
 */
const NON_RUNNING_SCREENS = ['app/session/[id].tsx', 'app/bjj/session/[id].tsx'] as const;
const RUN_ONLY_SYMBOLS = ['LiveHRIndicator', 'useHRRecording'] as const;

describe('live heart rate is running-only', () => {
  it.each(RUN_ONLY_SYMBOLS)('the running screen still uses %s', (symbol) => {
    // Guards the guard: without this, deleting the feature outright would
    // satisfy the absence assertions below and read as a pass.
    expect(screenSource('app/running/[id].tsx')).toContain(symbol);
  });

  it.each(NON_RUNNING_SCREENS)('%s has neither the live chip nor the recorder', (rel) => {
    const src = screenSource(rel);
    for (const symbol of RUN_ONLY_SYMBOLS) {
      expect(src).not.toContain(symbol);
    }
  });

  it('no screen other than the run opens the Bluetooth link', () => {
    // `connectIfRemembered` is the one entry point that starts a link. Settings
    // pairing calls it too (and releases it on unmount — see
    // `HRMonitorPairing`), so the assertion is about SESSION screens.
    for (const rel of NON_RUNNING_SCREENS) {
      expect(screenSource(rel)).not.toContain('connectIfRemembered');
    }
    expect(screenSource('app/running/[id].tsx')).toContain('connectIfRemembered');
  });
});

/**
 * W21/#992 — every restore of a saved track is followed by the prune that
 * makes the drain exactly-once, checked by COUNTING the two against each
 * other rather than by reading either one.
 *
 * This is the guard that would have caught the defect both reviewers found:
 * the running screen restores `route_points` on two mount branches, and only
 * one of them pruned. Nothing else could see it — a missing call type-checks,
 * lints, and leaves every unit test green, because the helper it fails to
 * call is itself perfectly correct and perfectly tested.
 *
 * Counting is deliberate. Asserting the prune merely APPEARS is the check
 * that cannot fail: it was present, on the wrong branch, throughout the bug.
 */
describe('the running screen prunes the fix queue wherever it restores a track', () => {
  it('has one prune per restored track, and at least one of each', () => {
    const src = screenSource('app/running/[id].tsx');
    const restores = src.match(/pointsRef\.current = existing\.route_points/g) ?? [];
    const prunes = src.match(/pruneRunFixesToRestoredTrack\(/g) ?? [];

    // Guards the guard: zero and zero would otherwise agree happily.
    expect(restores.length).toBeGreaterThan(0);
    expect(prunes.length).toBe(restores.length);
  });
});

/**
 * N552/#1021 — two wiring invariants that no unit test can reach, in the
 * same source-level style as the ones above and for the same reason: both
 * failed silently once already in this area (the running screen missing
 * `hrSourceLine` entirely), and both are "a call site agrees with a module",
 * which is a fact about text.
 */
/** Source with `//` and block comments removed — see the brand-copy check
 *  below for why that distinction is the point rather than a weakening. */
function withoutComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

describe('Settings names the two heart-rate paths', () => {
  const PAIRING = 'components/settings/HRMonitorPairing.tsx';

  it.each(['hrPathState', 'hrPathHeadline', 'hrPathDetail', 'nonBroadcastingNote', 'BROADCAST_STEPS'])(
    'renders %s',
    (symbol) => {
      expect(screenSource(PAIRING)).toContain(symbol);
    },
  );

  it('holds no brand-specific broadcast copy of its own', () => {
    // The defect: the shipped copy named the Amazfit that produced N528, in
    // two places, which read as "VOLA supports Amazfit". Brand names now
    // live in `BROADCAST_STEPS` — one generic list, under a rule that says
    // the brand is never checked — so any reappearing here is drift back to
    // the thing this ticket removed.
    //
    // COMMENTS ARE STRIPPED FIRST, and that is not a loophole: this file's
    // own doc comment has to be free to say which watch the old copy named,
    // and a check that forbade the explanation along with the defect is one
    // somebody deletes rather than satisfies. What is asserted is that no
    // brand reaches the SCREEN.
    const src = withoutComments(screenSource(PAIRING));
    // Guards the guard: without a positive assertion, deleting the file's
    // copy altogether would pass — and, since the stripper is itself the
    // apparatus here, this also proves it did not blank the whole file.
    expect(src).toContain('BROADCAST_RULE');
    for (const brand of ['Amazfit', 'Zepp', 'Garmin', 'Polar', 'Coros', 'Suunto']) {
      expect(src).not.toContain(brand);
    }
  });

  it('is given the health toggle it describes, rather than re-reading it', () => {
    const settings = screenSource('app/settings.tsx');
    expect(settings).toContain('<HRMonitorPairing');
    expect(settings).toContain('healthSyncOn=');
    expect(settings).toContain('healthSource=');
  });
});

describe('finishing a session kicks enrichment whichever path it was on', () => {
  const REL = 'lib/hrMonitor/useHRRecording.ts';

  it('never gates the kick on how many monitor rows flushed', () => {
    const src = screenSource(REL);
    // Guards the guard: the flush still has to be there for the assertion
    // below to be about anything.
    expect(src).toContain('flushHRMonitorSamples(');
    // The N528 shape, and this ticket's third criterion's actual bug: a run
    // finished with a non-broadcasting wearable flushes zero rows, so the
    // health store was never asked until the next foreground return.
    expect(src).not.toMatch(/if \(n > 0\)/);
  });

  it('kicks it on both the flushed and the failed-flush branch', () => {
    const src = screenSource(REL);
    expect(src).toContain('.then(kickEnrichment)');
    // The catch calls it too — offline is about the MONITOR's rows and says
    // nothing about what the health store holds for this session.
    expect(src).toContain('kickEnrichment();');
  });

  it('dispatches to the platform that actually has a health store', () => {
    const src = screenSource(REL);
    expect(src).toContain('healthSourceFor(');
    expect(src).toContain('triggerBiometricSyncNow');
    expect(src).toContain('triggerHealthConnectSyncNow');
  });
});

/**
 * N545/#988 + N563/#1068 — the chart's window must be the window the NUMBERS
 * came from, on every screen that draws one.
 *
 * W19/#985 moved a session's heart rate off the athlete's typed start/end and
 * onto the watch's own workout window, because a 90-minute class was being
 * scored almost entirely from pre-class background readings. A timeline built
 * over the logged window would draw a real curve, with a real time axis and a
 * marked peak, underneath an avg/max/TRIMP measured from a different stretch
 * of time — the same bug W19 fixed, re-entered through the chart. N545 fixed
 * it on the BJJ screen.
 *
 * N563 wired strength and running to the same chart and lifted BJJ's inline
 * fetch into `lib/useSessionHRTimeline.ts`, which takes the metrics ROW rather
 * than two timestamps. So the invariant now has two halves, pinned separately
 * because they fail separately:
 *
 *  - the hook reads the metrics window and has no session time to be wrong
 *    with;
 *  - every screen hands the hook its `hrMetrics`, and fetches and builds no
 *    timeline of its own.
 *
 * The second half is what a render test cannot see. A screen that inlined its
 * own fetch over `started_at`/`ended_at` draws a perfectly good chart — over
 * the wrong stretch of time, on a session whose two windows usually agree —
 * and strength has no render harness at all. `hrTimelineAxis.test.ts` covers
 * what the chart does with a window; this covers which window it is handed.
 * Comments are stripped before the negative assertions so each screen's own
 * explanation of the trap cannot trip them.
 */
describe('the session HR timeline is built from the metrics window, not the logged one', () => {
  const HOOK = 'lib/useSessionHRTimeline.ts';

  it('the hook fetches and builds over the metrics window', () => {
    const src = withoutComments(screenSource(HOOK));
    expect(src).toContain('metrics?.hr_window_start');
    expect(src).toContain('metrics?.hr_window_end');
    expect(src).toContain("listBiometricSamples(getToken, 'heart_rate', windowStart, windowEnd)");
    expect(src).toContain('buildHRTimeline(samples, windowStart, windowEnd)');
  });

  it('the hook has no session time to be wrong with', () => {
    const src = withoutComments(screenSource(HOOK));
    // Guards the guard: the comment stripper is apparatus too, and a blanked
    // file would satisfy the absence below.
    expect(src).toContain('export function useSessionHRTimeline(');
    expect(src).not.toMatch(/started_?at|ended_?at/i);
  });

  it.each(SCREENS)('%s gets its timeline from the hook, handed the metrics row', (rel) => {
    const src = withoutComments(screenSource(rel));
    expect(src).toContain('useSessionHRTimeline(getToken, id, hrMetrics)');
    expect(src).toContain('hrTimeline={hrTimeline}');
  });

  it.each(SCREENS)('%s fetches and builds no timeline of its own', (rel) => {
    const src = withoutComments(screenSource(rel));
    // Guards the guard, as above.
    expect(src).toContain('<HRSessionReport');
    expect(src).not.toContain('buildHRTimeline(');
    expect(src).not.toContain("'heart_rate'");
  });

  it.each(SCREENS)('%s passes the logged window, so the differing-window caption can fire', (rel) => {
    // `timelineCaption` and N522's footnote both compare the metrics window
    // against these; a screen that omits them is silent about a mismatch
    // rather than wrong about one, which is the quieter failure.
    const src = withoutComments(screenSource(rel));
    expect(src).toContain('sessionStartedAt=');
    expect(src).toContain('sessionEndedAt=');
  });
});
