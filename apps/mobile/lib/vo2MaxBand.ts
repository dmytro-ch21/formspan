/**
 * Where a VO₂max reading sits for the athlete's age and sex — N546 (#989).
 *
 * The athlete compared VOLA with Zepp: a bare number means little without a
 * band. This file turns a reading into one, and says plainly when it cannot.
 *
 * ## The reference, and why this one
 *
 * The cutoffs are the measured-VO₂max percentiles from the FRIEND registry
 * (Fitness Registry and the Importance of Exercise National Database):
 *
 * > Kaminsky LA, Arena R, Myers J. Reference Standards for Cardiorespiratory
 * > Fitness Measured With Cardiopulmonary Exercise Testing: Data From the
 * > Fitness Registry and the Importance of Exercise National Database.
 * > *Mayo Clin Proc.* 2015;90(11):1515–1523. doi:10.1016/j.mayocp.2015.07.026.
 * > PMID 26455884. PMCID PMC4919021.
 *
 * Table 3, the "FRIEND" columns: maximal treadmill tests with gas analysis,
 * adults 20–79 without known cardiovascular disease, peak RER ≥ 1.00 (7,783
 * tests). The same table prints Cooper Clinic *predicted* values beside them;
 * those are not used. The numbers below were read from the PMC full text and
 * then read a second time, cell by cell, before being written here — see the
 * N546 entry in `docs/decisions/history.md` for how.
 *
 * FRIEND was chosen over ACSM's published classification (which reprints the
 * Cooper Institute's data) because it is measured rather than predicted, it
 * is openly available in full, and it is the registry Apple's cardio fitness
 * levels are reported to use. That last point is from secondary reporting,
 * not from Apple's own support pages, which name the four levels but not a
 * source — so it is a reason, not a claim the screen makes.
 *
 * ## The four bands
 *
 * FRIEND prints percentiles; it does not name bands. VOLA names four, split at
 * the 25th, 50th and 75th percentiles for the athlete's sex and decade:
 *
 * | Band          | Where the reading falls        |
 * |---------------|--------------------------------|
 * | Low           | below the 25th percentile      |
 * | Below average | 25th to below the 50th         |
 * | Above average | 50th to below the 75th         |
 * | High          | 75th percentile or above       |
 *
 * The names are Apple Health's for its own four cardio fitness levels, so an
 * athlete who has read both sees the same vocabulary. Apple does not publish
 * its cutoffs, so VOLA's band can differ from Apple's near an edge; nothing on
 * screen says they match. The names are also deliberately not ACSM's "poor",
 * which reads as a verdict on the athlete rather than a position in a
 * population (`vola-athlete-ux`: no shame, in copy or mechanics).
 *
 * A reading exactly on a cutoff belongs to the band above it.
 *
 * ## When there is no band
 *
 * - No reading: nothing to classify.
 * - No date of birth, or a sex other than the two the reference reports: the
 *   band would be a guess, so the screen asks for the missing detail instead.
 * - An age outside 20–79 on the reading's date: FRIEND has no percentiles
 *   there, and extrapolating one would be inventing a health reference.
 *
 * ## Age is taken on the reading's date, not today
 *
 * A reading from the month before a birthday belongs to the decade the athlete
 * was in when it was measured. Classifying an old reading against today's age
 * would move it between bands without anything about the reading changing.
 */

import { ageInYears } from './biometric';

export type Vo2MaxSex = 'male' | 'female';

export type Vo2MaxBand = 'low' | 'below_average' | 'above_average' | 'high';

export type AgeGroup = '20-29' | '30-39' | '40-49' | '50-59' | '60-69' | '70-79';

export const AGE_GROUPS: readonly AgeGroup[] = ['20-29', '30-39', '40-49', '50-59', '60-69', '70-79'];

/** Every percentile Table 3 prints, so the table can be checked against the paper row by row. */
export type PercentileRow = {
  p5: number;
  p10: number;
  p25: number;
  p50: number;
  p75: number;
  p90: number;
  p95: number;
};

/**
 * FRIEND 2015, Table 3, measured VO₂max (mL·kg⁻¹·min⁻¹) from treadmill tests.
 * Transcribed exactly as printed; see the file comment for the citation.
 */
export const FRIEND_2015_TREADMILL: Record<Vo2MaxSex, Record<AgeGroup, PercentileRow>> = {
  male: {
    '20-29': { p5: 29.0, p10: 32.1, p25: 40.1, p50: 48.0, p75: 55.2, p90: 61.8, p95: 66.3 },
    '30-39': { p5: 27.2, p10: 30.2, p25: 35.9, p50: 42.4, p75: 49.2, p90: 56.5, p95: 59.8 },
    '40-49': { p5: 24.2, p10: 26.8, p25: 31.9, p50: 37.8, p75: 45.0, p90: 52.1, p95: 55.6 },
    '50-59': { p5: 20.9, p10: 22.8, p25: 27.1, p50: 32.6, p75: 39.7, p90: 45.6, p95: 50.7 },
    '60-69': { p5: 17.4, p10: 19.8, p25: 23.7, p50: 28.2, p75: 34.5, p90: 40.3, p95: 43.0 },
    '70-79': { p5: 16.3, p10: 17.1, p25: 20.4, p50: 24.4, p75: 30.4, p90: 36.6, p95: 39.7 },
  },
  female: {
    '20-29': { p5: 21.7, p10: 23.9, p25: 30.5, p50: 37.6, p75: 44.7, p90: 51.3, p95: 56.0 },
    '30-39': { p5: 19.0, p10: 20.9, p25: 25.3, p50: 30.2, p75: 36.1, p90: 41.4, p95: 45.8 },
    '40-49': { p5: 17.0, p10: 18.8, p25: 22.1, p50: 26.7, p75: 32.4, p90: 38.4, p95: 41.7 },
    '50-59': { p5: 16.0, p10: 17.3, p25: 19.9, p50: 23.4, p75: 27.6, p90: 32.0, p95: 35.9 },
    '60-69': { p5: 13.4, p10: 14.6, p25: 17.2, p50: 20.0, p75: 23.8, p90: 27.0, p95: 29.4 },
    '70-79': { p5: 13.1, p10: 13.6, p25: 15.6, p50: 18.3, p75: 20.8, p90: 23.1, p95: 24.1 },
  },
};

/** The decade FRIEND reports for an age in whole years, or `null` outside 20–79. */
export function ageGroupFor(age: number): AgeGroup | null {
  if (!Number.isInteger(age) || age < 20 || age > 79) return null;
  const decade = Math.floor(age / 10) * 10;
  return `${decade}-${decade + 9}` as AgeGroup;
}

export type Vo2MaxBandResult =
  | {
      kind: 'band';
      band: Vo2MaxBand;
      sex: Vo2MaxSex;
      ageGroup: AgeGroup;
      /** Whole years on the reading's date. */
      age: number;
      cutoffs: { p25: number; p50: number; p75: number };
    }
  | { kind: 'none'; reason: 'no_reading' }
  | { kind: 'none'; reason: 'missing_details'; missing: ('date of birth' | 'sex')[] }
  | { kind: 'none'; reason: 'age_outside_reference'; age: number };

/**
 * Classify one reading.
 *
 * `on` is the reading's own calendar day (`YYYY-MM-DD`). `sex` is the profile's
 * raw value; anything but `'male'` or `'female'` counts as missing, because the
 * reference reports only those two.
 */
export function classifyVo2Max(input: {
  value: number | null;
  dateOfBirth: string | null;
  sex: string | null;
  on: string;
}): Vo2MaxBandResult {
  const { value, dateOfBirth, sex, on } = input;
  if (value === null || !Number.isFinite(value) || value <= 0) return { kind: 'none', reason: 'no_reading' };

  const missing: ('date of birth' | 'sex')[] = [];
  if (!dateOfBirth) missing.push('date of birth');
  if (sex !== 'male' && sex !== 'female') missing.push('sex');
  if (missing.length > 0) return { kind: 'none', reason: 'missing_details', missing };

  const age = ageInYears(dateOfBirth as string, new Date(`${on}T00:00:00Z`));
  const ageGroup = ageGroupFor(age);
  if (ageGroup === null) return { kind: 'none', reason: 'age_outside_reference', age };

  const knownSex = sex as Vo2MaxSex;
  const { p25, p50, p75 } = FRIEND_2015_TREADMILL[knownSex][ageGroup];
  const band: Vo2MaxBand = value >= p75 ? 'high' : value >= p50 ? 'above_average' : value >= p25 ? 'below_average' : 'low';
  return { kind: 'band', band, sex: knownSex, ageGroup, age, cutoffs: { p25, p50, p75 } };
}

/** The band's name as the athlete reads it. */
export function vo2MaxBandLabel(band: Vo2MaxBand): string {
  switch (band) {
    case 'low':
      return 'Low';
    case 'below_average':
      return 'Below average';
    case 'above_average':
      return 'Above average';
    case 'high':
      return 'High';
  }
}

/**
 * The one line under the reading: the band and who it compares against, or
 * what would make a band possible. `null` when there is no reading to talk
 * about.
 */
export function vo2MaxBandSentence(result: Vo2MaxBandResult): string | null {
  if (result.kind === 'band') {
    const who = result.sex === 'male' ? 'men' : 'women';
    return `${vo2MaxBandLabel(result.band)} for ${who} aged ${result.ageGroup.replace('-', '–')}`;
  }
  switch (result.reason) {
    case 'no_reading':
      return null;
    case 'missing_details': {
      const list = result.missing.join(' and ');
      return `Add your ${list} in your profile to see how this compares with others your age.`;
    }
    case 'age_outside_reference':
      return "The reference covers ages 20 to 79, so there's no band for your age.";
  }
}

/**
 * Where the band comes from, said once, beside it. It names the kind of
 * measurement the reference used, because the athlete's number is a device
 * estimate and the reference's is a lab test — the band is a guide, and the
 * screen says so rather than letting a percentile read as a diagnosis.
 */
export const VO2MAX_BAND_REFERENCE =
  'Compared with FRIEND, a US registry of VO2max measured in treadmill tests. Your reading is a device estimate, so treat the band as a guide.';
