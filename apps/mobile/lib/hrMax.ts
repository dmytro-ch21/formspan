import {
  ageInYears,
  getObservedHRMax,
  hrMaxFromDateOfBirth,
  MAX_HR_MAX_BPM,
  MIN_HR_MAX_BPM,
  type HRMaxSource,
  type ObservedHRMax,
} from './biometric';
import { getProfile } from './profile';
import type { TokenGetter } from './useAuthToken';

/**
 * Which maximum heart rate is in force, and why — design doc §3's steps 2 and
 * 3 (`docs/decisions/health-integration-design.md`, L118-142), which were
 * decided on 2026-08-07 and never built.
 *
 * ## The three steps, and which of them existed before N535
 *
 * 1. Seed from `220 − age` and **mark the zones estimated wherever they are
 *    shown**. `hrMaxFromDateOfBirth` is that seed and has been since N477.
 * 2. **Replace it with the observed maximum across the athlete's own
 *    history** as soon as there is one. Nothing produced this. `'observed'`
 *    was a valid value in the client type, the server's validator, the
 *    database's CHECK constraint and the wire contract, and no code path
 *    anywhere could ever write it — the plumbing was complete and had no tap
 *    on the end of it.
 * 3. **Never silently switch between them.** Which maximum produced a given
 *    reading has to be visible.
 *
 * This module is steps 2 and 3. It does not compute an observed maximum —
 * that is the server's, deliberately, so iOS and Android report identical
 * numbers from identical evidence (§3's opening line) — it decides which of
 * the two candidates wins and carries the reason with it.
 *
 * ## Why the answer is a union rather than a number
 *
 * A bare `number | null` is exactly what made step 3 impossible to honour:
 * every caller received a beat count with no way to say where it came from,
 * so `computeSessionMetrics` hardcoded `'estimated'` at all four of its call
 * sites and `HRSessionReport` hardcoded the word "estimated" into a sentence.
 * Both were true, and both would have gone on being asserted the moment they
 * stopped being true. Returning the provenance ALONGSIDE the number is what
 * makes a silent switch unrepresentable rather than merely discouraged.
 *
 * ## Absence is a state, not an error
 *
 * `unresolved` is a first-class answer, and it names what is missing. It is
 * emphatically NOT a clamp to `MIN_HR_MAX_BPM`, and not `220 − 30` for an
 * athlete whose age we do not know: N485 already settled that argument once
 * against a clamping implementation, and `lib/biometric.ts`'s own doc comment
 * states the stance — "clamping is itself a fabricated number, just one
 * sitting exactly on the boundary".
 */

export type HRMaxResolution =
  | {
      kind: 'observed';
      source: Extract<HRMaxSource, 'observed'>;
      bpm: number;
      /** RFC3339 — when the peak was recorded. From the peak's OWN row. */
      measuredAt: string;
      /** How many heart-rate samples stand behind it. Thin evidence is still
       *  evidence, but the athlete gets to see how thin. */
      sampleCount: number;
    }
  | {
      kind: 'estimated';
      source: Extract<HRMaxSource, 'estimated'>;
      bpm: number;
      /** The age `220 − age` was computed from, so the arithmetic is checkable. */
      age: number;
    }
  | {
      kind: 'unresolved';
      reason: UnresolvedReason;
    };

export type UnresolvedReason =
  /** No heart-rate samples AND no date of birth: nothing to go on at all. */
  | 'nothing-to-go-on'
  /** A date of birth that seeds a number outside [100, 250] — an athlete
   *  recorded as roughly 120+ years old, i.e. a typo. Distinguished from
   *  'nothing-to-go-on' because the fix is different: correct the date,
   *  rather than record one. */
  | 'date-of-birth-implausible';

/**
 * Which maximum wins.
 *
 * **Observed beats estimated whenever there is one**, which is step 2 stated
 * as precedence. §3's argument for the order: "with a strap sampling every
 * second, a few hard sessions produce a better number than the formula ever
 * will" — `220 − age` carries a standard deviation of ±10-12 bpm, routinely
 * enough to move two zone boundaries, and it knows nothing about this
 * particular athlete.
 *
 * An observed value outside `[MIN_HR_MAX_BPM, MAX_HR_MAX_BPM]` is discarded
 * rather than used or clamped, and the age estimate is then tried: the server
 * stores whatever a strap reports, and a strap reporting 14 bpm (a dropped
 * signal) or 300 (an electrical artefact) is not a maximum. Note this is the
 * one place a fallback is allowed to happen — it is still not silent, because
 * the answer that comes back says `estimated`.
 */
export function resolveHRMax(input: {
  observed: ObservedHRMax | null | undefined;
  dateOfBirth: string | null | undefined;
  on: Date;
}): HRMaxResolution {
  const { observed, dateOfBirth, on } = input;

  if (observed && plausibleHRMax(observed.bpm)) {
    return {
      kind: 'observed',
      source: 'observed',
      bpm: Math.round(observed.bpm),
      measuredAt: observed.measured_at,
      sampleCount: observed.sample_count,
    };
  }

  const estimated = hrMaxFromDateOfBirth(dateOfBirth, on);
  if (estimated != null) {
    return { kind: 'estimated', source: 'estimated', bpm: estimated, age: ageInYears(dateOfBirth as string, on) };
  }

  return {
    kind: 'unresolved',
    reason: dateOfBirth ? 'date-of-birth-implausible' : 'nothing-to-go-on',
  };
}

function plausibleHRMax(bpm: number): boolean {
  return Number.isFinite(bpm) && bpm >= MIN_HR_MAX_BPM && bpm <= MAX_HR_MAX_BPM;
}

/**
 * The one-line badge that makes step 3 visible — "Estimated from your age" /
 * "Measured from your own sessions". Short on purpose: it sits beside a
 * number, and the full account is in `hrMaxDerivationLines` below.
 */
export function hrMaxSourceLabel(r: HRMaxResolution): string {
  switch (r.kind) {
    case 'observed':
      return 'Measured from your own sessions';
    case 'estimated':
      return 'Estimated from your age';
    case 'unresolved':
      return 'Not worked out yet';
  }
}

/**
 * The derivation, as the lines a screen shows under the number — `app/goals.tsx`'s
 * nutrition-target pattern, whose principle this repo states as auditable
 * recommendations: an argument you cannot inspect is a verdict.
 *
 * For an observed maximum that means WHICH maximum, WHERE it came from, and
 * WHEN it was recorded — including the sample count, because "your highest
 * ever reading" resting on four samples and on forty thousand are different
 * claims and the athlete is the only one who can tell which of theirs is
 * real.
 */
export function hrMaxDerivationLines(r: HRMaxResolution, now: Date): { label: string; value: string }[] {
  switch (r.kind) {
    case 'observed':
      return [
        { label: 'Where it came from', value: 'The highest heart rate your own sessions have recorded' },
        { label: 'Recorded', value: formatMeasuredAt(r.measuredAt, now) },
        {
          label: 'Readings behind it',
          value: `${r.sampleCount.toLocaleString()} heart-rate ${r.sampleCount === 1 ? 'sample' : 'samples'}`,
        },
      ];
    case 'estimated':
      return [
        { label: 'Where it came from', value: '220 − age, the standard starting estimate' },
        { label: 'Your age', value: `${r.age}` },
        { label: 'The arithmetic', value: `220 − ${r.age} = ${r.bpm}` },
        {
          label: 'How close it is',
          value: 'Within about 10-12 bpm for most people — enough to move a zone boundary',
        },
      ];
    case 'unresolved':
      return [];
  }
}

/**
 * What is missing, and what fixes it. Deliberately says "we cannot work this
 * out yet" rather than showing a number — see this file's doc comment.
 */
export function hrMaxMissingCopy(reason: UnresolvedReason): { title: string; body: string } {
  switch (reason) {
    case 'nothing-to-go-on':
      return {
        title: 'We cannot work out your zones yet',
        body:
          'Zones are bands of your maximum heart rate, and we have neither a measured one nor a date of birth to estimate from. ' +
          'Add your date of birth in your profile for a starting estimate, or wear a heart-rate monitor for a session or two and we will use your own highest reading instead.',
      };
    case 'date-of-birth-implausible':
      return {
        title: 'We cannot work out your zones yet',
        body:
          'The date of birth on your profile works out to a maximum heart rate outside anything we can use, so it is probably a typo. ' +
          'Correcting it in your profile will give you a starting estimate; wearing a heart-rate monitor will replace that with your own measured maximum.',
      };
  }
}

/** "3 September 2026" — or "today"/"yesterday" for the recent case. */
function formatMeasuredAt(iso: string, now: Date): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return 'at an unknown time';
  const days = Math.floor((startOfDay(now) - startOfDay(at)) / 86_400_000);
  if (days === 0) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 7) return `${days} days ago`;
  return at.toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric' });
}

function startOfDay(d: Date): number {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

/**
 * `resolveHRMax` with both halves fetched — the one call an enrichment pass
 * or a screen makes.
 *
 * **The observed read is tolerant and the profile read is not**, and the
 * asymmetry is deliberate. A failed profile read is the pre-existing "nothing
 * is computable this pass" condition every caller here already handles, so it
 * propagates unchanged. A failed `hr-max` read is new surface — an older API
 * that has never heard of this endpoint, or one flaky request — and the right
 * answer to it is the age estimate we would have used anyway, not the loss of
 * a whole sync pass to a feature that is an improvement on the status quo.
 * Falling back is safe precisely because it is not silent: what comes back
 * says `estimated`, and every surface shows that.
 */
export async function fetchHRMax(getToken: TokenGetter, now: Date): Promise<HRMaxResolution> {
  const [observed, profile] = await Promise.all([
    getObservedHRMax(getToken).catch(() => null),
    getProfile(getToken),
  ]);
  return resolveHRMax({ observed, dateOfBirth: profile.date_of_birth, on: now });
}
