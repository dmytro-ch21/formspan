import {
  hrMaxDerivationLines,
  hrMaxMissingCopy,
  hrMaxSourceLabel,
  resolveHRMax,
} from '../hrMax';

/**
 * Which maximum heart rate is in force, and why — N535/#966, design doc §3's
 * steps 2 and 3.
 *
 * The three properties worth defending, and each is a thing that would ship
 * silently if it broke:
 *
 *  1. **Precedence.** Observed beats estimated. Swapped, the app quietly goes
 *     on using `220 − age` for an athlete who has worn a strap for months, and
 *     nothing anywhere looks wrong — the zones are merely worse.
 *  2. **The label travels with the number.** A resolution whose `source` did
 *     not match its `kind` would score sessions against a measured maximum and
 *     file them as estimated, which is exactly the silent switch step 3
 *     forbids.
 *  3. **Absence stays absent.** No date of birth and no samples must not
 *     become a population average or a clamp to `MIN_HR_MAX_BPM`. N485 settled
 *     that once against a clamping implementation.
 *
 * Mutation-verified (see the ticket): swapping the precedence, dropping the
 * source label, and clamping the unresolved case each turn this file red.
 */

// Mid-afternoon UTC on purpose. `jest` runs this suite under
// `TZ=America/Los_Angeles` (see `apps/mobile/package.json`), and "recorded
// today" is a LOCAL-day question — an instant at 06:00Z on the 9th is the
// evening of the 8th in Los Angeles. An earlier draft of this file used
// 12:00Z and the fixture, not the code, was what went red. Both instants
// below sit inside the same local day in UTC and in the test timezone.
const ON = new Date('2026-09-09T20:00:00Z');
const DOB_36 = '1990-03-01'; // 36 on ON, so 220 - 36 = 184

describe('resolveHRMax — precedence', () => {
  it('uses the observed maximum when there is one, even though a date of birth is on file', () => {
    const r = resolveHRMax({
      observed: { bpm: 191, measured_at: '2026-08-20T09:00:00Z', sample_count: 12_400 },
      dateOfBirth: DOB_36,
      on: ON,
    });
    expect(r).toEqual({
      kind: 'observed',
      source: 'observed',
      bpm: 191,
      measuredAt: '2026-08-20T09:00:00Z',
      sampleCount: 12_400,
    });
  });

  it('falls back to 220 - age when there is no observed maximum', () => {
    const r = resolveHRMax({ observed: null, dateOfBirth: DOB_36, on: ON });
    expect(r).toEqual({ kind: 'estimated', source: 'estimated', bpm: 184, age: 36 });
  });

  it('a single observed sample still wins — thin evidence about YOU beats a formula about nobody', () => {
    const r = resolveHRMax({
      observed: { bpm: 176, measured_at: '2026-09-08T18:00:00Z', sample_count: 1 },
      dateOfBirth: DOB_36,
      on: ON,
    });
    expect(r.kind).toBe('observed');
    // ...and the screen is obliged to say how thin, which is the safeguard
    // rather than a threshold nobody has the evidence to pick.
    expect(hrMaxDerivationLines(r, ON)).toContainEqual({
      label: 'Readings behind it',
      value: '1 heart-rate sample',
    });
  });
});

describe('resolveHRMax — the label travels with the number', () => {
  it('kind and source always agree', () => {
    const cases = [
      resolveHRMax({
        observed: { bpm: 191, measured_at: '2026-08-20T09:00:00Z', sample_count: 5 },
        dateOfBirth: DOB_36,
        on: ON,
      }),
      resolveHRMax({ observed: null, dateOfBirth: DOB_36, on: ON }),
    ];
    for (const r of cases) {
      expect(r.kind).not.toBe('unresolved');
      if (r.kind !== 'unresolved') expect(r.source).toBe(r.kind);
    }
  });

  it('names which maximum is in force, in the athlete\'s own words', () => {
    expect(
      hrMaxSourceLabel(
        resolveHRMax({
          observed: { bpm: 191, measured_at: '2026-08-20T09:00:00Z', sample_count: 5 },
          dateOfBirth: null,
          on: ON,
        }),
      ),
    ).toBe('Measured from your own sessions');
    expect(hrMaxSourceLabel(resolveHRMax({ observed: null, dateOfBirth: DOB_36, on: ON }))).toBe(
      'Estimated from your age',
    );
  });
});

describe('resolveHRMax — an implausible observed value is discarded, not used and not clamped', () => {
  it.each([
    ['a dropped signal', 14],
    ['an electrical artefact', 300],
    ['exactly one under the floor', 99],
    ['exactly one over the ceiling', 251],
  ])('%s falls through to the age estimate', (_why, bpm) => {
    const r = resolveHRMax({
      observed: { bpm, measured_at: '2026-08-20T09:00:00Z', sample_count: 5 },
      dateOfBirth: DOB_36,
      on: ON,
    });
    expect(r).toEqual({ kind: 'estimated', source: 'estimated', bpm: 184, age: 36 });
  });

  it('the boundaries themselves are usable — 100 and 250 are in range', () => {
    for (const bpm of [100, 250]) {
      const r = resolveHRMax({
        observed: { bpm, measured_at: '2026-08-20T09:00:00Z', sample_count: 5 },
        dateOfBirth: DOB_36,
        on: ON,
      });
      expect(r).toMatchObject({ kind: 'observed', bpm });
    }
  });

  it('a discarded observed value with no date of birth is unresolved, never clamped', () => {
    const r = resolveHRMax({
      observed: { bpm: 300, measured_at: '2026-08-20T09:00:00Z', sample_count: 5 },
      dateOfBirth: null,
      on: ON,
    });
    expect(r).toEqual({ kind: 'unresolved', reason: 'nothing-to-go-on' });
    // Explicitly: not MIN_HR_MAX_BPM, not MAX_HR_MAX_BPM, not a number at all.
    expect(r).not.toHaveProperty('bpm');
  });
});

describe('resolveHRMax — absence names what is missing', () => {
  it('nothing at all to go on', () => {
    expect(resolveHRMax({ observed: null, dateOfBirth: null, on: ON })).toEqual({
      kind: 'unresolved',
      reason: 'nothing-to-go-on',
    });
    expect(resolveHRMax({ observed: undefined, dateOfBirth: undefined, on: ON })).toEqual({
      kind: 'unresolved',
      reason: 'nothing-to-go-on',
    });
  });

  it('a date of birth that seeds an unusable number is a typo, and says so differently', () => {
    // Recorded as ~136 years old: 220 - 136 = 84, below MIN_HR_MAX_BPM.
    const r = resolveHRMax({ observed: null, dateOfBirth: '1890-01-01', on: ON });
    expect(r).toEqual({ kind: 'unresolved', reason: 'date-of-birth-implausible' });
  });

  it('the two reasons produce different advice — record one vs. correct one', () => {
    const nothing = hrMaxMissingCopy('nothing-to-go-on');
    const typo = hrMaxMissingCopy('date-of-birth-implausible');
    expect(nothing.body).not.toBe(typo.body);
    expect(nothing.body).toMatch(/Add your date of birth/);
    expect(typo.body).toMatch(/typo/);
    // Both routes out are named in the no-data case: a monitor is the other
    // one, and an athlete told only about their profile would never learn it.
    expect(nothing.body).toMatch(/heart-rate monitor/);
  });

  it('shows no derivation for an answer that does not exist', () => {
    expect(
      hrMaxDerivationLines({ kind: 'unresolved', reason: 'nothing-to-go-on' }, ON),
    ).toEqual([]);
  });
});

describe('the derivation an athlete can audit', () => {
  it('an estimated maximum shows the arithmetic, not just the answer', () => {
    const r = resolveHRMax({ observed: null, dateOfBirth: DOB_36, on: ON });
    const lines = hrMaxDerivationLines(r, ON);
    expect(lines).toContainEqual({ label: 'The arithmetic', value: '220 − 36 = 184' });
    // And it states its own error bar, because that is the reason step 2
    // exists at all.
    expect(lines.map((l) => l.value).join(' ')).toMatch(/10-12 bpm/);
  });

  it('an observed maximum shows when it was recorded and how many readings stand behind it', () => {
    const r = resolveHRMax({
      observed: { bpm: 191, measured_at: '2026-09-09T17:00:00Z', sample_count: 12_400 },
      dateOfBirth: DOB_36,
      on: ON,
    });
    const lines = hrMaxDerivationLines(r, ON);
    expect(lines).toContainEqual({ label: 'Recorded', value: 'today' });
    expect(lines).toContainEqual({
      label: 'Readings behind it',
      value: '12,400 heart-rate samples',
    });
  });

  it('"today" and "yesterday" are the DEVICE\'s days, not UTC\'s', () => {
    // An athlete who peaked at 22:00 last night, reading this at 11:00 this
    // morning, is told "yesterday" — even where those two instants land on
    // the SAME UTC day, which they do for every timezone west of Greenwich.
    // Formatting in UTC instead tells a whole timezone that last night's
    // session happened today, or the reverse, depending which side of the
    // line they are on.
    //
    // Both instants are built from LOCAL components on purpose. Writing them
    // as UTC literals makes the test itself timezone-dependent — the first
    // draft of this case passed under the suite's pinned
    // `TZ=America/Los_Angeles` and failed under `TZ=UTC`, which is a test
    // asserting the timezone rather than the behaviour.
    const lastNight = new Date(2026, 8, 8, 22, 0, 0);
    const thisMorning = new Date(2026, 8, 9, 11, 0, 0);
    const lines = hrMaxDerivationLines(
      {
        kind: 'observed',
        source: 'observed',
        bpm: 191,
        measuredAt: lastNight.toISOString(),
        sampleCount: 3,
      },
      thisMorning,
    );
    expect(lines).toContainEqual({ label: 'Recorded', value: 'yesterday' });
  });

  it('a recorded date it cannot parse is said out loud, not rendered as Invalid Date', () => {
    const lines = hrMaxDerivationLines(
      { kind: 'observed', source: 'observed', bpm: 191, measuredAt: 'not a date', sampleCount: 3 },
      ON,
    );
    expect(lines).toContainEqual({ label: 'Recorded', value: 'at an unknown time' });
  });
});
