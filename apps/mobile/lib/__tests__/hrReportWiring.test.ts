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
