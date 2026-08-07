import { readFileSync } from 'fs';
import { join } from 'path';

import { MUSCLE_GROUPS } from '../exerciseFacets';
import { MAX_SWAP_SUGGESTIONS } from '../sessions';

/**
 * The two apps must offer the same swaps.
 *
 * `apps/mobile` and `apps/web` each carry a full copy of the swap ranking AND
 * of the muscle taxonomy it depends on. The duplication is deliberate — the
 * apps share no package and mobile needs its copy offline — but this is
 * precisely the shape this repo has already been bitten by: the position
 * vocabulary lived in four client files and a taxonomy change updated one of
 * them until review caught it.
 *
 * The drift here would be quiet in a specific way. Both apps would keep
 * offering plausible swaps; they would simply offer *different* ones for the
 * same exercise, and nobody comparing a phone to a laptop would be able to say
 * which was right. Add a muscle to one copy and that muscle's exercises stop
 * being suggested on the other, with no error anywhere.
 *
 * Follows `searchParity.test.ts`, including its hard-won lesson: **every
 * extractor throws rather than silently comparing nothing.** That file's first
 * version compared only constants and passed while the two copies searched
 * different fields.
 *
 * It reads source text rather than importing web's module, because jest here
 * cannot resolve web's `@/` alias or its Next-flavoured imports. Brittle to
 * renames BY DESIGN.
 */

const WEB = join(__dirname, '../../../web/src/lib/api.ts');
const MOBILE = join(__dirname, '../sessions.ts');

function source(path: string): string {
  const src = readFileSync(path, 'utf8');
  if (src.length < 1000) throw new Error(`source looks empty at ${path}`);
  return src;
}

const webSource = () => source(WEB);

/**
 * Pulls the rank ladder out of either copy.
 *
 * **Both sides are extracted, and that is the fix for a hole review found.**
 * The first version compared web's source against literals written in this
 * file — so a tweak on WEB was caught while the identical tweak on MOBILE
 * passed the entire suite and the two apps quietly diverged. One-directional
 * parity is not parity; it is a test of one app that mentions two.
 * `searchParity.test.ts` already had this right, comparing extracted against
 * extracted.
 */
function rankLadder(path: string): string {
  const src = source(path);
  const m = src.match(/if \(pattern && carries\) return 3;[\s\S]{0,200}?return 0;/);
  if (!m) throw new Error(`could not find the swap rank ladder in ${path}`);
  return m[0].replace(/\s+/g, ' ').trim();
}

function tieBreak(path: string): string {
  const src = source(path);
  const m = src.match(/rank\(b\) - rank\(a\)[^;]*/);
  if (!m) throw new Error(`could not find the swap tie-break in ${path}`);
  return m[0].replace(/\s+/g, ' ').trim();
}

/** Pulls `{ key, muscles }` out of web's MUSCLE_GROUPS literal. */
function webMuscleGroups(): Map<string, string[]> {
  const src = webSource();
  const start = src.indexOf('const MUSCLE_GROUPS');
  if (start === -1) throw new Error('web has no MUSCLE_GROUPS — did it get renamed?');
  const end = src.indexOf('const MUSCLE_TO_GROUP', start);
  if (end === -1) throw new Error('could not find the end of web MUSCLE_GROUPS');
  const block = src.slice(start, end);

  const out = new Map<string, string[]>();
  const re = /key:\s*'([a-z-]+)',[\s\S]*?muscles:\s*\[([^\]]*)\]/g;
  for (const m of block.matchAll(re)) {
    out.set(
      m[1],
      [...m[2].matchAll(/'([^']+)'/g)].map((x) => x[1]),
    );
  }
  if (out.size === 0) throw new Error('extracted no muscle groups from web — the shape changed');
  return out;
}

describe('the muscle taxonomy the two apps rank on', () => {
  it('found both copies at all', () => {
    // Guards every assertion below. A renamed file would otherwise make this
    // whole suite pass by comparing nothing — the way `searchParity` failed
    // once already.
    expect(MUSCLE_GROUPS.length).toBeGreaterThan(0);
    expect(webMuscleGroups().size).toBeGreaterThan(0);
  });

  it('covers the same groups', () => {
    const web = webMuscleGroups();
    expect([...web.keys()].sort()).toEqual(MUSCLE_GROUPS.map((g) => g.key).sort());
  });

  it('puts the same muscles in each group', () => {
    // The drift that matters. Add `rear-delts` to one copy and that exercise
    // stops being suggested on the other app, silently.
    const web = webMuscleGroups();
    for (const g of MUSCLE_GROUPS) {
      expect({ group: g.key, muscles: [...(web.get(g.key) ?? [])].sort() }).toEqual({
        group: g.key,
        muscles: [...g.muscles].sort(),
      });
    }
  });
});

describe('the ranking tuning', () => {
  it('caps each tier at the same number', () => {
    const src = webSource();
    const m = src.match(/MAX_SWAP_SUGGESTIONS\s*=\s*(\d+)/);
    if (!m) throw new Error('web has no MAX_SWAP_SUGGESTIONS');
    expect(Number(m[1])).toBe(MAX_SWAP_SUGGESTIONS);
  });

  it('scores the tiers identically', () => {
    // Compared extracted-against-extracted, in both directions. Ranking is not
    // something either app's behavioural suite enumerates exhaustively, so the
    // copies can diverge in TUNING while every assertion on both sides stays
    // green — and the only symptom is the same exercise ranked differently on
    // a phone and a laptop.
    expect(rankLadder(WEB)).toBe(rankLadder(MOBILE));
  });

  it('still uses the ladder this feature was designed around', () => {
    // A third pin, against a literal. Without it, both copies could be edited
    // together and the comparison above would happily agree about the wrong
    // thing.
    expect(rankLadder(MOBILE)).toBe(
      'if (pattern && carries) return 3; if (pattern) return 2; if (carries) return 1; return 0;',
    );
  });

  it('breaks ties the same way, so the order matches on both', () => {
    expect(tieBreak(WEB)).toBe(tieBreak(MOBILE));
  });

  it('neither copy scores equipment', () => {
    // Both deliberately leave it out — if the barbell is taken, another
    // barbell movement is the one suggestion that cannot help, and the
    // opposite rule would be a guess too. One app quietly reintroducing it
    // would make the same swap rank differently on a phone and a laptop.
    const src = webSource();
    const ranking = src.slice(src.indexOf('export function swapSuggestions'));
    expect(ranking.slice(0, ranking.indexOf('return {'))).not.toMatch(/equipment/);
  });
});
