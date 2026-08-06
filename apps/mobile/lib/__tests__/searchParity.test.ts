import { readFileSync } from 'fs';
import { join } from 'path';

/**
 * The two apps' searches must agree about the same catalog.
 *
 * `apps/mobile/lib/techniques.ts` and `apps/web/src/lib/api.ts` each carry a
 * full copy of the technique search — fold, stop words, field weights, scoring.
 * The duplication is deliberate and documented in both files (the apps share no
 * package, and mobile needs its copy to work offline), and for a long time
 * nothing enforced that the copies agreed.
 *
 * Both apps now run the same behavioural cases against the real catalog —
 * techniqueSearch.test.ts here, and apps/web/src/lib/__tests__ over there. That
 * is the primary guard and it is the one to extend first.
 *
 * This file covers what those cannot: the two suites assert a handful of
 * queries each, so the copies can drift in TUNING while both stay green.
 * Change W_ALIAS on the phone alone and every behavioural assertion still
 * passes, while the same query returns the 21 armbars in a different order on
 * each device. Ranking is not something either suite enumerates exhaustively,
 * so the tuned values are compared directly instead.
 *
 * It reads source text rather than importing the web module, because jest here
 * cannot resolve web's `@/` alias or its Next-flavoured imports. That makes it
 * brittle to renames BY DESIGN — every extractor throws rather than silently
 * comparing nothing, and the first test asserts both files were found at all.
 *
 * HOW THIS FILE FAILED ONCE ALREADY, which is the honest thing to record: its
 * first version compared only constants and passed while the two copies
 * searched DIFFERENT FIELDS — mobile indexed `function`, web did not, and
 * "advance" returned 131 on the phone against 0 on the desktop. Comparing the
 * tuning is not comparing the search. The field-set and rung-shape tests below
 * were added because of that, and they are the ones that would have caught it.
 * If you add a dimension to the scoring, add its comparison here too; the
 * constants are the easy half and they are not the half that broke.
 */

const MOBILE = join(__dirname, '../techniques.ts');
const WEB = join(__dirname, '../../../web/src/lib/api.ts');

/** Pull `const NAME = <number>;` out of a source file. */
function numericConst(src: string, name: string): string {
  const m = src.match(new RegExp(`const\\s+${name}\\s*=\\s*([0-9_]+)\\s*;`));
  if (!m) throw new Error(`${name} not found — was it renamed?`);
  return m[1].replace(/_/g, '');
}

/** Pull the quoted members out of `new Set([...])`, ignoring quote style. */
function stopWords(src: string): string[] {
  const m = src.match(/const STOP_WORDS = new Set\(\[([\s\S]*?)\]\)/);
  if (!m) throw new Error('STOP_WORDS not found — was it renamed?');
  return [...m[1].matchAll(/['"]([^'"]+)['"]/g)].map((x) => x[1]).sort();
}

describe('mobile and web search stay in step', () => {
  const mobile = readFileSync(MOBILE, 'utf8');
  const web = readFileSync(WEB, 'utf8');

  it('found both copies to compare', () => {
    // If a refactor moves either file this test would otherwise pass by
    // comparing two empty extractions — assert the sources are real first.
    expect(mobile).toContain('export function searchTechniques');
    expect(web).toContain('export function searchTechniques');
    expect(mobile).toContain('export function rankTechniques');
    expect(web).toContain('export function rankTechniques');
  });

  it('shares one stop-word vocabulary', () => {
    const m = stopWords(mobile);
    expect(m.length).toBeGreaterThan(5);
    expect(stopWords(web)).toEqual(m);
  });

  it.each(['W_NAME', 'W_ALIAS', 'W_POSITION', 'W_META'])(
    'agrees on %s',
    (name) => {
      expect(numericConst(web, name)).toBe(numericConst(mobile, name));
    },
  );

  it('searches the same set of fields', () => {
    // ADDED AFTER THIS TEST FAILED TO CATCH THE THING IT EXISTS FOR.
    //
    // The first version of this file compared stop words, weights and bonuses,
    // and passed while the two copies searched DIFFERENT FIELDS: mobile
    // indexed `function`, web did not, because web's TechniqueSummary type
    // omitted a field the API had always sent. Measured over the shipped
    // catalog, "advance" returned 131 on the phone and 0 on the desktop, and
    // "side control" — the query the whole change was written for — returned
    // different sets. Nothing saw it. The behavioural suites could not: web
    // cannot exercise a field web does not search.
    //
    // Constants are the easy half of parity. This compares the SHAPE: which
    // fields each copy folds, and which are consulted at each scoring rung.
    const foldedFields = (src: string) => {
      const m = src.match(/const built: Folded = \{([\s\S]*?)\n  \};/);
      if (!m) throw new Error('folded() literal not found — was it renamed?');
      return [...m[1].matchAll(/^\s{4}(\w+):/gm)].map((x) => x[1]).sort();
    };
    const fields = foldedFields(mobile);
    expect(fields).toContain('fn');
    expect(foldedFields(web)).toEqual(fields);

    // ...and the rungs, in order, as the sequence of field names each tests.
    const rungs = (src: string) => {
      const body = src.slice(src.indexOf('function scoreTechnique'));
      const loop = body.slice(0, body.indexOf('if (best === 0)'));
      return [...loop.matchAll(/f\.(\w+)/g)].map((x) => x[1]);
    };
    const m = rungs(mobile);
    expect(m).toContain('fn');
    expect(rungs(web)).toEqual(m);
  });

  it('breaks ties the same way', () => {
    // mobile has no Intl.Collator, so an identical result set could still be
    // ordered differently on the two platforms. Nothing else compares this.
    const tieBreak = (src: string) => {
      const m = src.match(/b\.score - a\.score \|\| (.+?)\)\n/);
      if (!m) throw new Error('tie-break not found — was rankTechniques changed?');
      return m[1].replace(/\s+/g, '');
    };
    expect(tieBreak(web)).toBe(tieBreak(mobile));
  });

  it('agrees on the contiguity bonuses', () => {
    // The ladder that decides which of 21 armbars lands on top. Extracted as a
    // sequence rather than named constants because they are written inline in
    // both files; order matters, so the comparison keeps it.
    const bonuses = (src: string) => {
      const body = src.slice(src.indexOf('function scoreTechnique'));
      return [...body.slice(0, body.indexOf('return score;')).matchAll(/score \+= ([0-9_]+)/g)].map(
        (x) => x[1].replace(/_/g, ''),
      );
    };
    const m = bonuses(mobile);
    expect(m.length).toBeGreaterThanOrEqual(5);
    expect(bonuses(web)).toEqual(m);
  });
});
