import {
  AGE_GROUPS,
  FRIEND_2015_TREADMILL,
  VO2MAX_BAND_REFERENCE,
  ageGroupFor,
  classifyVo2Max,
  vo2MaxBandLabel,
  vo2MaxBandSentence,
  type PercentileRow,
  type Vo2MaxSex,
} from '../vo2MaxBand';

const ORDER: (keyof PercentileRow)[] = ['p5', 'p10', 'p25', 'p50', 'p75', 'p90', 'p95'];
const SEXES: Vo2MaxSex[] = ['male', 'female'];

describe('the FRIEND 2015 table as transcribed', () => {
  it('rises through the percentiles within every sex and decade', () => {
    for (const sex of SEXES) {
      for (const group of AGE_GROUPS) {
        const row = FRIEND_2015_TREADMILL[sex][group];
        for (let i = 1; i < ORDER.length; i += 1) {
          expect([sex, group, ORDER[i], row[ORDER[i]] > row[ORDER[i - 1]]]).toEqual([sex, group, ORDER[i], true]);
        }
      }
    }
  });

  it('falls with every decade at every percentile', () => {
    for (const sex of SEXES) {
      for (const p of ORDER) {
        for (let i = 1; i < AGE_GROUPS.length; i += 1) {
          const younger = FRIEND_2015_TREADMILL[sex][AGE_GROUPS[i - 1]][p];
          const older = FRIEND_2015_TREADMILL[sex][AGE_GROUPS[i]][p];
          expect([sex, p, AGE_GROUPS[i], older < younger]).toEqual([sex, p, AGE_GROUPS[i], true]);
        }
      }
    }
  });

  it("matches the paper's own results sentence for the medians at both ends", () => {
    // "the 50th percentile V̇O2max of men and women aged 20 to 29 years decreased
    // from 48.0 and 37.6 … to 24.4 and 18.3 … for ages 70 to 79 years"
    expect(FRIEND_2015_TREADMILL.male['20-29'].p50).toBe(48.0);
    expect(FRIEND_2015_TREADMILL.female['20-29'].p50).toBe(37.6);
    expect(FRIEND_2015_TREADMILL.male['70-79'].p50).toBe(24.4);
    expect(FRIEND_2015_TREADMILL.female['70-79'].p50).toBe(18.3);
  });

  it('holds the FRIEND cutoffs, not the Cooper Clinic predicted values printed beside them', () => {
    // Read against both columns of Table 3; the Cooper values for men 20–29
    // are 39.0 / 43.9 / 48.5, which these must not be.
    expect(FRIEND_2015_TREADMILL.male['20-29']).toMatchObject({ p25: 40.1, p50: 48.0, p75: 55.2 });
    expect(FRIEND_2015_TREADMILL.male['60-69']).toMatchObject({ p25: 23.7, p50: 28.2, p75: 34.5 });
    expect(FRIEND_2015_TREADMILL.female['20-29']).toMatchObject({ p25: 30.5, p50: 37.6, p75: 44.7 });
    expect(FRIEND_2015_TREADMILL.female['60-69']).toMatchObject({ p25: 17.2, p50: 20.0, p75: 23.8 });
  });
});

describe('ageGroupFor', () => {
  it.each([
    [19, null],
    [20, '20-29'],
    [29, '20-29'],
    [30, '30-39'],
    [55, '50-59'],
    [79, '70-79'],
    [80, null],
  ])('age %p → %p', (age, group) => {
    expect(ageGroupFor(age)).toBe(group);
  });
});

describe('classifyVo2Max', () => {
  // A woman born 15 June 1990, reading taken 1 September 2026: 36, so the
  // 30–39 cutoffs 25.3 / 30.2 / 36.1 apply.
  const woman36 = { dateOfBirth: '1990-06-15', sex: 'female', on: '2026-09-01' };

  it.each([
    [25.2, 'low'],
    [25.3, 'below_average'],
    [30.1, 'below_average'],
    [30.2, 'above_average'],
    [36.0, 'above_average'],
    [36.1, 'high'],
    [70, 'high'],
  ])('a reading of %p is %p, with a cutoff belonging to the band above', (value, band) => {
    const r = classifyVo2Max({ ...woman36, value });
    expect(r).toEqual({
      kind: 'band',
      band,
      sex: 'female',
      ageGroup: '30-39',
      age: 36,
      cutoffs: { p25: 25.3, p50: 30.2, p75: 36.1 },
    });
  });

  it('uses the cutoffs for the sex on the profile', () => {
    // 36.1 is high for a woman of 36 (her 75th percentile) but below average
    // for a man of 36 (between his 25th, 35.9, and 50th, 42.4).
    expect(classifyVo2Max({ ...woman36, value: 36.1 })).toMatchObject({ band: 'high' });
    expect(classifyVo2Max({ ...woman36, sex: 'male', value: 36.1 })).toMatchObject({
      band: 'below_average',
      cutoffs: { p25: 35.9, p50: 42.4, p75: 49.2 },
    });
  });

  it('takes age on the reading date, so a reading from before a birthday stays in its own decade', () => {
    // 31.0 for a woman: below average at 20–29 (30.5 / 37.6), above average at 30–39 (30.2 / 36.1).
    const base = { dateOfBirth: '1990-06-15', sex: 'female', value: 31.0 };
    expect(classifyVo2Max({ ...base, on: '2020-06-14' })).toMatchObject({ age: 29, ageGroup: '20-29', band: 'below_average' });
    expect(classifyVo2Max({ ...base, on: '2020-06-15' })).toMatchObject({ age: 30, ageGroup: '30-39', band: 'above_average' });
  });

  it('asks for what is missing instead of guessing a band', () => {
    expect(classifyVo2Max({ ...woman36, dateOfBirth: null, value: 30 })).toEqual({
      kind: 'none',
      reason: 'missing_details',
      missing: ['date of birth'],
    });
    expect(classifyVo2Max({ ...woman36, sex: null, value: 30 })).toEqual({
      kind: 'none',
      reason: 'missing_details',
      missing: ['sex'],
    });
    expect(classifyVo2Max({ ...woman36, sex: 'other', value: 30 })).toEqual({
      kind: 'none',
      reason: 'missing_details',
      missing: ['sex'],
    });
    expect(classifyVo2Max({ ...woman36, dateOfBirth: null, sex: null, value: 30 })).toEqual({
      kind: 'none',
      reason: 'missing_details',
      missing: ['date of birth', 'sex'],
    });
  });

  it('has no band outside the ages the reference covers', () => {
    expect(classifyVo2Max({ dateOfBirth: '2007-01-01', sex: 'male', on: '2026-09-01', value: 50 })).toEqual({
      kind: 'none',
      reason: 'age_outside_reference',
      age: 19,
    });
    expect(classifyVo2Max({ dateOfBirth: '1946-01-01', sex: 'male', on: '2026-09-01', value: 30 })).toEqual({
      kind: 'none',
      reason: 'age_outside_reference',
      age: 80,
    });
  });

  it.each([null, Number.NaN, 0, -3])('treats a reading of %p as no reading', (value) => {
    expect(classifyVo2Max({ ...woman36, value })).toEqual({ kind: 'none', reason: 'no_reading' });
  });
});

describe('the words on screen', () => {
  it('names the four bands', () => {
    expect(['low', 'below_average', 'above_average', 'high'].map((b) => vo2MaxBandLabel(b as never))).toEqual([
      'Low',
      'Below average',
      'Above average',
      'High',
    ]);
  });

  it('says the band and who it compares against', () => {
    expect(vo2MaxBandSentence(classifyVo2Max({ dateOfBirth: '1990-06-15', sex: 'female', on: '2026-09-01', value: 31 }))).toBe(
      'Above average for women aged 30–39',
    );
    expect(vo2MaxBandSentence(classifyVo2Max({ dateOfBirth: '1990-06-15', sex: 'male', on: '2026-09-01', value: 31 }))).toBe(
      'Low for men aged 30–39',
    );
  });

  it('says what to add when a detail is missing, naming only what is missing', () => {
    expect(vo2MaxBandSentence({ kind: 'none', reason: 'missing_details', missing: ['date of birth', 'sex'] })).toBe(
      'Add your date of birth and sex in your profile to see how this compares with others your age.',
    );
    expect(vo2MaxBandSentence({ kind: 'none', reason: 'missing_details', missing: ['sex'] })).toBe(
      'Add your sex in your profile to see how this compares with others your age.',
    );
  });

  it('says plainly when the age is outside the reference, and says nothing with no reading', () => {
    expect(vo2MaxBandSentence({ kind: 'none', reason: 'age_outside_reference', age: 80 })).toBe(
      "The reference covers ages 20 to 79, so there's no band for your age.",
    );
    expect(vo2MaxBandSentence({ kind: 'none', reason: 'no_reading' })).toBeNull();
  });

  it('names the reference and that the reading is an estimate', () => {
    expect(VO2MAX_BAND_REFERENCE).toContain('FRIEND');
    expect(VO2MAX_BAND_REFERENCE).toContain('device estimate');
  });
});
