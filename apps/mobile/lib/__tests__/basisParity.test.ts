import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { RECORD_BASIS, basisFor, describeEvidence, type PersonalRecord } from '../records';

/**
 * The objective/modelled/reported classification says the same thing in every
 * language it is written in.
 *
 * `RecordKind` exists three times — Go, this app, and `apps/web/src/lib/api.ts`
 * — because the wire format is shared and each side needs its own type. The
 * basis classification therefore exists three times too, and three copies of a
 * rule is three chances for one of them to be wrong.
 *
 * This is the repo's established answer to that: `planHero.test.ts` extracts
 * web's angle formula from source and runs it rather than restating it, for the
 * same reason. A test that restated the mapping would only prove this file
 * agrees with itself.
 *
 * **What it proves:** that the Go classification and the TypeScript one assign
 * the same basis to the same kinds, and that neither has a kind the other
 * lacks. **What it cannot prove:** that either is *right* — that
 * `estimated_1rm` really is modelled is a claim about the estimator's SQL, and
 * it is pinned on the Go side by `TestBasisFor_EstimatedOneRMIsModelled`.
 */

const GO_BASIS = resolve(__dirname, '../../../../backend/internal/modules/session/basis.go');
const GO_RECORDS = resolve(__dirname, '../../../../backend/internal/modules/session/records.go');
const WEB_API = resolve(__dirname, '../../../web/src/lib/api.ts');

/**
 * Reads web's `RECORD_BASIS` out of its source.
 *
 * Web is checked here rather than in its own suite for the reason the file
 * header gives: this is where the anchor copy (Go) is already being read, and
 * a third copy pinned by nothing is exactly how one of three ends up wrong.
 * Both reviewers landed on the same point independently — web's map is
 * exhaustive over KEYS by type, so an omitted kind fails to compile, but a
 * wrong VALUE would not, and web is the analytical surface where people go to
 * interrogate a number.
 *
 * Same technique `planHero.test.ts` uses to reach into web from this suite.
 */
function webBasisByKind(): Record<string, string> {
  const src = readFileSync(WEB_API, 'utf8');
  const start = src.indexOf('export const RECORD_BASIS');
  if (start === -1) throw new Error('web api.ts has no RECORD_BASIS — did it move?');
  const body = src.slice(start, src.indexOf('};', start));
  const out: Record<string, string> = {};
  for (const m of body.matchAll(/^\s*([a-z0-9_]+):\s*"(measured|modelled|reported)"/gm)) {
    out[m[1]] = m[2];
  }
  return out;
}

/**
 * Reads `BasisFor`'s switch out of the Go source.
 *
 * Parses the constant NAMES out of each case arm and resolves them through the
 * `RecordKind` declarations in records.go, rather than assuming a naming
 * convention maps `RecordHeaviest` to `heaviest_weight`. The convention is not
 * even consistent — `RecordOneRM` is `estimated_1rm` — so guessing would make
 * this test agree with a guess.
 */
function goBasisByKind(): Record<string, string> {
  const constSrc = readFileSync(GO_RECORDS, 'utf8');
  // `RecordHeaviest RecordKind = "heaviest_weight"`
  const nameToWire = new Map<string, string>();
  for (const m of constSrc.matchAll(/(Record\w+)\s+RecordKind\s*=\s*"([a-z0-9_]+)"/g)) {
    nameToWire.set(m[1], m[2]);
  }
  expect(nameToWire.size).toBeGreaterThanOrEqual(5);

  const src = readFileSync(GO_BASIS, 'utf8');
  const body = src.slice(src.indexOf('func BasisFor'));
  const out: Record<string, string> = {};
  // `case RecordHeaviest, RecordMostReps:` … `return Measured, true`
  for (const m of body.matchAll(/case\s+([\w,\s]+?):[\s\S]*?return\s+(Measured|Modelled|Reported),/g)) {
    const basis = m[2].toLowerCase();
    for (const name of m[1].split(',').map((s) => s.trim())) {
      const wire = nameToWire.get(name);
      if (!wire) throw new Error(`BasisFor names ${name}, which records.go does not declare`);
      out[wire] = basis;
    }
  }
  return out;
}

describe('the basis classification agrees across languages', () => {
  it('classifies exactly the same kinds as Go', () => {
    expect(Object.keys(goBasisByKind()).sort()).toEqual(Object.keys(RECORD_BASIS).sort());
  });

  it('assigns the same basis to every kind as Go does', () => {
    expect(goBasisByKind()).toEqual(RECORD_BASIS);
  });

  /**
   * Guards the guard. If the extraction stops matching — a reformat, a rename,
   * a `switch` rewritten as a map — it returns `{}`, and both assertions above
   * would then be comparing nothing to nothing.
   */
  it('actually extracted the Go mapping', () => {
    const go = goBasisByKind();
    expect(Object.keys(go).length).toBeGreaterThanOrEqual(5);
    expect(go['estimated_1rm']).toBe('modelled');
    expect(go['heaviest_weight']).toBe('measured');
  });

  it('classifies exactly the same kinds on web', () => {
    expect(Object.keys(webBasisByKind()).sort()).toEqual(Object.keys(RECORD_BASIS).sort());
  });

  it('assigns the same basis on web as Go does', () => {
    // Against GO, not against this app's map — web agreeing with mobile while
    // both drift from the anchor is a state this should catch, not bless.
    expect(webBasisByKind()).toEqual(goBasisByKind());
  });

  it('actually extracted the web mapping', () => {
    const web = webBasisByKind();
    expect(Object.keys(web).length).toBeGreaterThanOrEqual(5);
    expect(web['estimated_1rm']).toBe('modelled');
  });
});

describe('basisFor', () => {
  it('calls a logged best measured', () => {
    expect(basisFor('heaviest_weight')).toBe('measured');
  });

  it('calls the 1RM estimate modelled, because it consumes RIR', () => {
    expect(basisFor('estimated_1rm')).toBe('modelled');
  });
});

function record(over: Partial<PersonalRecord> = {}): PersonalRecord {
  return {
    kind: 'heaviest_weight',
    value: 100,
    reps: 5,
    weight_kg: 100,
    seconds: null,
    distance_m: null,
    rir: null,
    rpe: null,
    achieved_at: '2026-08-09T10:00:00Z',
    session_id: 's1',
    is_recent: false,
    ...over,
  };
}

describe('describeEvidence keeps the two halves apart', () => {
  it('puts the logged set in measured and nothing in reported', () => {
    expect(describeEvidence(record(), 'metric')).toEqual({
      measured: '5 × 100kg',
      reported: '',
    });
  });

  it('never mixes a rating into the measured half', () => {
    // The regression that matters: this used to return "5 × 100kg · 2 RIR",
    // one string, one separator, an opinion presented as another column of the
    // measurement.
    const e = describeEvidence(record({ rir: 2 }), 'metric');
    expect(e.measured).toBe('5 × 100kg');
    expect(e.measured).not.toContain('RIR');
    expect(e.reported).toBe('2 RIR');
  });

  it('prefers RIR over RPE, matching the estimator', () => {
    expect(describeEvidence(record({ rir: 2, rpe: 8 }), 'metric').reported).toBe('2 RIR');
  });

  it('falls back to RPE when that is what was collected', () => {
    expect(describeEvidence(record({ rpe: 8 }), 'metric').reported).toBe('RPE 8');
  });

  it('reports nothing rather than zero when effort was never collected', () => {
    // `TrackEffortProvider` makes RIR/RPE optional and toggleable, so "absent"
    // is an ordinary state and must not render as a value.
    expect(describeEvidence(record({ rir: null, rpe: null }), 'metric').reported).toBe('');
  });
});
