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
