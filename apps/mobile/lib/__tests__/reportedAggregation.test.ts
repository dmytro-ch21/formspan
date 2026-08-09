import { readdirSync, readFileSync, statSync } from 'node:fs';
import { extname, join, relative, resolve } from 'node:path';

/**
 * Nothing aggregates a self-rating.
 *
 * This is reading rule 3 from `backend/internal/modules/session/basis.go`, and
 * it is the one rule with no reader to point a test at — **because nothing
 * aggregates a reported value yet**. That is exactly why it is a scan and not a
 * unit test: the rule has no call site to guard, so the only way to enforce it
 * is to notice the first one that appears.
 *
 * ## The trap it protects
 *
 * `TrackEffortProvider` lets an athlete turn RIR/RPE collection off and on
 * whenever they like. So an average over any window can be computed from a
 * silently changing sample — three sessions of RPE in a twelve-session window
 * average the three, report a number for the twelve, and nothing on screen says
 * the denominator moved. The output looks identical whether effort was
 * collected always, sometimes or never. That is not a rounding error; it is a
 * measurement of one thing presented as a measurement of another.
 *
 * ## Why one scan across the whole stack
 *
 * Rule 3 is a cross-stack rule — the aggregate could as easily be a Postgres
 * `AVG` as a client `reduce` — and splitting it into a Go guard and a jest
 * guard would make it two half-rules, each looking like the whole one. This
 * suite already reads backend source (`basisParity.test.ts`), so the reach is
 * established.
 *
 * ## What it can and cannot catch
 *
 * **Can:** a SQL aggregate over a reported column, and a client identifier
 * named for what it does (`avgRpe`, `rpeAverage`, `totalRir`). Those are the
 * shapes this actually arrives in.
 *
 * **Cannot:** `sets.reduce((a, s) => a + (s.rpe ?? 0), 0)` assigned to
 * something vague. A scan cannot read intent, and pretending otherwise would be
 * the "regex standing in for behaviour" mistake `CLAUDE.md` records. What it
 * buys is that the *obvious* way in is closed and a deliberate one has to be
 * argued for — which is the point at which someone reads rule 3.
 *
 * A failure here is not necessarily a bug. It is a claim that needs rule 3
 * answered: either the window is one where the rating was collected throughout,
 * or the aggregate is wrong. Say which, in a comment, and add the file to
 * `ARGUED`.
 */

const REPO = resolve(__dirname, '../../../..');

/** Where a rating could plausibly be aggregated. */
const SEARCH = [
  'backend/internal',
  'backend/migrations',
  'apps/mobile/lib',
  'apps/mobile/app',
  'apps/web/src',
];

const EXTENSIONS = new Set(['.go', '.sql', '.ts', '.tsx']);

/**
 * The fields that are the athlete's own account.
 *
 * `notes`/`body_note` are deliberately absent: free text cannot be averaged, so
 * including them would only produce false positives on every `notes` column.
 */
const REPORTED = ['rir', 'rpe', 'session_rpe'];

/**
 * True SQL aggregates only.
 *
 * `GREATEST`/`LEAST` are deliberately NOT here and must never be added. They
 * are row-wise scalar functions, and `postgres.go` uses
 * `GREATEST(0, 10 - LEAST(ss.rpe, 10))` to convert one set's RPE into effective
 * reps — a per-row transformation, not an aggregate, and the very computation
 * rule 2 permits. Flagging it would make this test fail on correct code, which
 * is how a guard gets disabled.
 *
 * `COUNT` is also absent: counting how many sets carried a rating is a fact
 * about collection, not an average of opinions, and is the honest thing to
 * report ALONGSIDE one.
 */
const AGGREGATES = ['avg', 'sum', 'stddev', 'variance', 'var_samp', 'var_pop', 'percentile_cont', 'percentile_disc'];

/** Client identifiers named for averaging a rating. */
const NAMED_AGGREGATION = new RegExp(
  `\\b(avg|average|mean|sum|total)[A-Za-z]*(${REPORTED.join('|')})\\b` +
    `|\\b(${REPORTED.join('|')})[A-Za-z]*(Avg|Average|Mean|Sum|Total)\\b`,
  'i',
);

const SQL_AGGREGATION = new RegExp(
  `\\b(${AGGREGATES.join('|')})\\s*\\(\\s*(distinct\\s+)?[a-z0-9_]*\\.?(${REPORTED.join('|')})\\b`,
  'i',
);

/**
 * Files that have argued their case.
 *
 * Empty, and that is the finding: nothing in this codebase aggregates a rating
 * today. An entry here is a promise that the file states which window it covers
 * and why the sample does not move inside it.
 */
const ARGUED: string[] = [];

/** This file names every pattern it looks for, so it would flag itself. */
const SELF = 'apps/mobile/lib/__tests__/reportedAggregation.test.ts';

function filesUnder(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    let entries: string[];
    try {
      entries = readdirSync(d);
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(d, entry);
      if (statSync(full).isDirectory()) {
        if (entry === 'node_modules' || entry === '.next' || entry === '.expo') continue;
        walk(full);
      } else if (EXTENSIONS.has(extname(entry))) {
        out.push(full);
      }
    }
  };
  walk(dir);
  return out;
}

const scanned = SEARCH.flatMap((d) => filesUnder(join(REPO, d)))
  .map((path) => ({ file: relative(REPO, path), source: readFileSync(path, 'utf8') }))
  .filter(({ file }) => file !== SELF && !ARGUED.includes(file));

describe('reading rule 3: no aggregate spans a window a rating may not cover', () => {
  /**
   * Guards the guard. A wrong root, a changed layout or an over-eager filter
   * yields an empty list, and every assertion below then passes by checking
   * nothing — the failure this repo has shipped before.
   */
  it('actually found the source to scan', () => {
    expect(scanned.length).toBeGreaterThan(200);
    const files = scanned.map((s) => s.file);
    // Named anchors, so "found 200 files" cannot be satisfied by the wrong 200.
    expect(files).toContain('backend/internal/modules/session/postgres.go');
    expect(files).toContain('apps/mobile/lib/records.ts');
    expect(files).toContain('apps/web/src/lib/api.ts');
  });

  it('finds no SQL aggregate over a reported column', () => {
    const offenders = scanned
      .filter(({ source }) => SQL_AGGREGATION.test(source))
      .map(({ file }) => file);
    expect(offenders).toEqual([]);
  });

  it('finds no client identifier named for averaging a rating', () => {
    const offenders = scanned
      .filter(({ source }) => NAMED_AGGREGATION.test(source))
      .map(({ file }) => file);
    expect(offenders).toEqual([]);
  });

  /**
   * The exemption that must survive: converting one set's RPE to effective reps
   * is rule 2 working, not rule 3 breaking. If a future edit added GREATEST or
   * LEAST to `AGGREGATES`, this goes red before the guard starts failing on
   * correct code — which is the failure that gets a guard deleted.
   */
  it('does not mistake a per-row RPE conversion for an aggregate', () => {
    const estimator = readFileSync(
      join(REPO, 'backend/internal/modules/session/postgres.go'),
      'utf8',
    );
    expect(estimator).toMatch(/GREATEST\(0, 10 - LEAST\(ss\.rpe, 10\)\)/);
    expect(SQL_AGGREGATION.test(estimator)).toBe(false);
  });
});
