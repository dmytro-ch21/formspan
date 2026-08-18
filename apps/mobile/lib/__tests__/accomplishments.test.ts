import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  ACCOMPLISHMENT_KINDS,
  accomplishmentBadge,
  accomplishmentsFromSession,
  labelForAccomplishment,
  type Accomplishment,
  type AccomplishmentKind,
} from '../accomplishments';

const GO_SOURCE = resolve(
  __dirname,
  '../../../../backend/internal/modules/accomplishment/accomplishment.go',
);

function award(over: Partial<Accomplishment> = {}): Accomplishment {
  return {
    kind: 'first_scored',
    basis: 'reported',
    achieved_on: '2026-02-17',
    contest_id: null,
    contest_name: null,
    placement: null,
    entrants: null,
    session_id: 'ses-1',
    technique_id: null,
    technique_name: null,
    ...over,
  };
}

/**
 * The vocabulary says the same thing in both languages.
 *
 * `basisParity.test.ts` established the idiom and the reasoning applies
 * verbatim: the kind list exists in Go and again here because the wire format
 * is shared and each side needs its own type, and two copies of a vocabulary is
 * two chances for one to be wrong. So the Go constants are READ rather than
 * restated — a test that restated them would only prove this file agrees with
 * itself.
 *
 * What it cannot prove is that either side is *right*; that a submission win is
 * `measured` is pinned on the Go side by its own tests.
 */
describe('the kind vocabulary matches the backend', () => {
  const go = readFileSync(GO_SOURCE, 'utf8');
  // `FirstSubmissionWin Kind = "first_submission_win"` — the const block only.
  const goKinds = [...go.matchAll(/\bKind\s*=\s*"([a-z_]+)"/g)].map((m) => m[1]);

  it('finds the Go constants at all', () => {
    // Guards the regex itself: if the Go file is reshaped and this stops
    // matching, an empty list would make every comparison below vacuously true.
    expect(goKinds.length).toBeGreaterThan(0);
  });

  it('has exactly the kinds Go declares', () => {
    expect([...goKinds].sort()).toEqual([...ACCOMPLISHMENT_KINDS].sort());
  });

  it('gives every kind its own label', () => {
    const labels = ACCOMPLISHMENT_KINDS.map(labelForAccomplishment);
    expect(new Set(labels).size).toBe(ACCOMPLISHMENT_KINDS.length);
    for (const label of labels) expect(label).not.toBe('A first');
  });
});

describe('labelForAccomplishment', () => {
  it('names the two a session can earn', () => {
    expect(labelForAccomplishment('first_scored')).toBe('First technique landed');
    expect(labelForAccomplishment('first_drilled_scored')).toBe(
      'First drilled technique landed live',
    );
  });

  it('degrades honestly on a kind this build does not know', () => {
    // The server's vocabulary can grow ahead of an installed app, which updates
    // on the App Store's schedule rather than ours. The fallback must say
    // something true rather than render an empty badge.
    expect(labelForAccomplishment('first_black_belt_gold' as AccomplishmentKind)).toBe('A first');
  });
});

describe('accomplishmentsFromSession', () => {
  it('keeps only what this session earned', () => {
    const all = [
      award({ session_id: 'ses-1', kind: 'first_scored' }),
      award({ session_id: 'ses-2', kind: 'first_drilled_scored' }),
    ];
    expect(accomplishmentsFromSession(all, 'ses-1').map((a) => a.kind)).toEqual(['first_scored']);
  });

  it('never attaches a competition award to a session', () => {
    // Competition awards carry a contest and no session. Nobody finishes a
    // tournament by tapping Finish, so a gold medal must not surface on
    // whichever mat session happened to be logged next.
    const all = [
      award({
        kind: 'first_gold',
        basis: 'measured',
        session_id: null,
        contest_id: 'c-1',
        contest_name: 'IBJJF Pans',
        placement: 1,
        entrants: 32,
      }),
    ];
    expect(accomplishmentsFromSession(all, 'ses-1')).toEqual([]);
  });

  it('is empty when the session earned nothing, which is the normal case', () => {
    expect(accomplishmentsFromSession([award({ session_id: 'ses-9' })], 'ses-1')).toEqual([]);
  });
});

describe('accomplishmentBadge', () => {
  it('is nothing at all when nothing was earned', () => {
    // The common case by design — these fire once each in an athlete's life,
    // and a badge that appeared every session would be the wallpaper the whole
    // badge rule exists to prevent.
    expect(accomplishmentBadge([])).toBeNull();
  });

  it('names the single award', () => {
    expect(accomplishmentBadge([award({ kind: 'first_scored' })])).toEqual({
      label: 'First technique landed',
    });
  });

  it('counts rather than ranking when two land together', () => {
    // Genuinely possible: an athlete whose first-ever score is of something
    // drilled weeks ago earns both at once. Picking a winner would need a
    // ranking of achievements, which this feature is careful not to have.
    expect(
      accomplishmentBadge([
        award({ kind: 'first_scored' }),
        award({ kind: 'first_drilled_scored' }),
      ]),
    ).toEqual({ label: '2 firsts' });
  });
});
