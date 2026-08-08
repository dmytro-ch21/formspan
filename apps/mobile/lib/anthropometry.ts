/**
 * What a run of check-ins actually means — the arithmetic, with no React in it.
 *
 * **Deterministic and explainable, like every other recommendation here.** The
 * card never says "you're doing well"; it says a rate, the target rate, and
 * which side of it you are on. A number an athlete can argue with beats a
 * verdict they have to trust — the same rule the progression suggestions follow.
 *
 * ## The one idea the whole file rests on: scale weight is noise
 *
 * Body mass swings 1–2 kg inside a day on water, glycogen and the previous
 * evening's meal. Two consecutive mornings can differ by more than a *good
 * week* of fat loss, so any rate computed from two readings is dominated by
 * the noise and will happily report gaining during a successful cut.
 *
 * So nothing here reads a single weight. Everything reads {@link trendWeight} —
 * a rolling mean — and rates are computed between two trends far enough apart
 * that the signal can exceed the error. That is the difference between a number
 * worth showing and a number that makes people quit.
 *
 * ## Units
 *
 * Kilograms and centimetres, always, matching storage. Display conversion is
 * `lib/units.ts`'s job and happens at the edge — see the note there for why a
 * converted stored value makes every historical row ambiguous.
 */

/** A check-in, reduced to what this file reads. */
export type Measured = {
  measured_on: string; // YYYY-MM-DD
  weight_kg?: number | null;
  waist_cm?: number | null;
  hips_cm?: number | null;
  neck_cm?: number | null;
};

export type PhaseKind =
  | 'cut'
  | 'lean_bulk'
  | 'recomposition'
  | 'maintenance'
  | 'making_weight';

export type Phase = {
  kind: PhaseKind;
  started_on: string;
  target_on?: string | null;
  target_weight_kg?: number | null;
};

/**
 * How many days of readings a trend averages over.
 *
 * Seven, and it is a whole week for a reason beyond smoothing: eating and
 * training both run on a weekly cycle for most people, so a seven-day mean
 * cancels the Saturday and the Monday rather than half of each. A shorter
 * window leaves the weekend in; a longer one is smoother but lags real change
 * by long enough to be discouraging.
 */
export const TREND_DAYS = 7;

/**
 * The fewest readings a trend will report from.
 *
 * Three, which is a judgement rather than a measurement. Two can be two halves
 * of one water swing; three is where a mean starts to be worth more than the
 * newest number. Below it {@link trendWeight} returns null and the card shows
 * the raw weight and says so, rather than dressing one reading up as a trend.
 */
export const MIN_TREND_READINGS = 3;

/**
 * Evidence-based rates, as a fraction of body mass per week.
 *
 * The cut range is where the literature actually lands: Garthe et al. (2011)
 * ran elite athletes at ~0.7%/week against ~1.4%/week and found the slow group
 * held — and in places added — lean mass while the fast group did not. Faster
 * cuts do not fail to lose weight; they fail to lose the *right* weight.
 *
 * The bulk range is tighter and the reason is symmetrical: past roughly
 * 0.5%/week the surplus outruns what muscle can actually be built from, and the
 * remainder is fat that has to come off later.
 *
 * `min` matters as much as `max`. A cut running at 0.05%/week is not cautious,
 * it is not happening, and saying so is more useful than praising it.
 */
export const RATE_TARGETS: Record<PhaseKind, { min: number; max: number } | null> = {
  cut: { min: 0.005, max: 0.01 },
  lean_bulk: { min: 0.0025, max: 0.005 },
  // A recomposition holds weight flat on purpose — see `recompSignal`, which is
  // what actually reads whether it is working.
  recomposition: { min: -0.0025, max: 0.0025 },
  maintenance: { min: -0.0025, max: 0.0025 },
  // Making weight has a deadline, so the required rate is computed from the
  // gap rather than prescribed. `makingWeightPlan` handles it.
  making_weight: null,
};

/** Days between two YYYY-MM-DD dates. Positive when `b` is later. */
export function daysBetween(a: string, b: string): number {
  const ms = Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`);
  return Math.round(ms / 86_400_000);
}

/**
 * The rolling mean of the readings in the `TREND_DAYS` ending at `on`.
 *
 * Null when there are too few — see {@link MIN_TREND_READINGS}. Null is a real
 * answer here and callers must render it as "not enough readings yet" rather
 * than as zero: a trend of 0 kg is the one number that is certainly wrong.
 *
 * Anchored on a DATE rather than on "the last N rows", so a fortnight's gap
 * does not silently average across it and report a stale figure as current.
 */
export function trendWeight(checkins: Measured[], on: string): number | null {
  const inWindow = checkins.filter((c) => {
    if (c.weight_kg == null || c.weight_kg <= 0) return false;
    const age = daysBetween(c.measured_on, on);
    return age >= 0 && age < TREND_DAYS;
  });
  if (inWindow.length < MIN_TREND_READINGS) return null;
  const sum = inWindow.reduce((t, c) => t + (c.weight_kg as number), 0);
  return round(sum / inWindow.length, 2);
}

/**
 * Change per week, as a fraction of body mass, between two trends.
 *
 * **Both ends are trends, never raw readings** — the whole point of the file.
 * Expressed as a fraction rather than in kilograms because the same absolute
 * loss is a different thing for a 60kg athlete and a 110kg one, and every
 * published rate is stated proportionally for exactly that reason.
 *
 * Null when either end is missing or the span is too short to say anything.
 */
export const MIN_RATE_DAYS = 7;

export function weeklyRate(
  checkins: Measured[],
  on: string,
  spanDays = 14,
): number | null {
  const now = trendWeight(checkins, on);
  if (now == null) return null;

  const thenOn = shiftDate(on, -spanDays);
  const then = trendWeight(checkins, thenOn);
  if (then == null || then <= 0) return null;

  const days = daysBetween(thenOn, on);
  if (days < MIN_RATE_DAYS) return null;
  return ((now - then) / then) * (7 / days);
}

/** Where a rate sits against the phase's target band. */
export type RateVerdict = 'on_target' | 'too_fast' | 'too_slow' | 'no_target' | 'unknown';

/**
 * Judge a rate against the phase, with the sign handled once and centrally.
 *
 * The sign is the trap. A cut's rate is NEGATIVE, so "too fast" is a rate below
 * `-max` and "too slow" is one above `-min` — which reads backwards and is
 * exactly the comparison that gets inverted when written inline at a call site.
 * It is written once, here, with a test that would fail if the two swapped.
 */
export function judgeRate(kind: PhaseKind, rate: number | null): RateVerdict {
  const band = RATE_TARGETS[kind];
  if (band == null) return 'no_target';
  if (rate == null) return 'unknown';

  if (kind === 'cut') {
    if (rate < -band.max) return 'too_fast';
    if (rate > -band.min) return 'too_slow';
    return 'on_target';
  }
  if (kind === 'lean_bulk') {
    if (rate > band.max) return 'too_fast';
    if (rate < band.min) return 'too_slow';
    return 'on_target';
  }
  // Recomposition and maintenance are a band around zero, so drifting either
  // way is "too fast" — there is no slow direction to be on.
  if (rate > band.max || rate < band.min) return 'too_fast';
  return 'on_target';
}

/**
 * Whether a recomposition is working.
 *
 * **The one case scale weight cannot answer at all**, and the reason girths
 * earn their place in this feature. Losing fat and gaining muscle at the same
 * rate holds weight perfectly flat: the scale reports nothing while the body
 * changes underneath it, which is when people conclude the plan has failed and
 * abandon a plan that is working.
 *
 * Waist is the fat proxy and a limb girth is the muscle proxy. Neither is
 * precise; together, and moving in opposite directions, they are the cheapest
 * honest evidence available without a DEXA scanner.
 */
export type RecompSignal = 'working' | 'stalled' | 'wrong_way' | 'unknown';

export function recompSignal(
  waistChangeCM: number | null,
  limbChangeCM: number | null,
): RecompSignal {
  if (waistChangeCM == null || limbChangeCM == null) return 'unknown';
  // Half a centimetre is roughly where tape error stops dominating for someone
  // measuring themselves. Below it, honestly, nothing has been observed.
  const noise = 0.5;
  const waistDown = waistChangeCM <= -noise;
  const limbUp = limbChangeCM >= noise;
  const waistUp = waistChangeCM >= noise;
  const limbDown = limbChangeCM <= -noise;

  // Both moved the right way, or both the wrong way — unambiguous.
  if (waistDown && limbUp) return 'working';
  if (waistUp && limbDown) return 'wrong_way';

  /*
    One signal moved and the other did not, or they disagree.

    The first version read `waistDown || limbUp` as 'working', which said a
    GROWING waist alongside a growing limb was a recomposition going well, and
    a shrinking waist alongside a shrinking limb likewise — the second is
    losing muscle. Raised in review.

    A single good signal with the other flat is genuine progress; anything with
    a bad signal in it is not, whatever else moved.
  */
  if (waistUp || limbDown) return 'wrong_way';
  if (waistDown || limbUp) return 'working';
  return 'stalled';
}

/**
 * Waist-to-height ratio.
 *
 * Reported instead of BMI, and that is a deliberate substitution rather than an
 * omission. BMI cannot tell muscle from fat, which makes it actively misleading
 * for the athletes this app is for — a lean 95kg grappler reads "obese". WHtR
 * measures where the mass actually sits, needs only a tape and a height, and is
 * the better predictor of the risks people track weight for in the first place.
 *
 * The rule of thumb it exists to support is "keep your waist under half your
 * height", i.e. 0.5.
 */
export function waistToHeight(waistCM: number | null, heightCM: number | null): number | null {
  if (!waistCM || !heightCM || waistCM <= 0 || heightCM <= 0) return null;
  return round(waistCM / heightCM, 3);
}

/** Waist-to-hip ratio — the other classic distribution measure. */
export function waistToHip(waistCM: number | null, hipsCM: number | null): number | null {
  if (!waistCM || !hipsCM || waistCM <= 0 || hipsCM <= 0) return null;
  return round(waistCM / hipsCM, 3);
}

/**
 * Body fat percentage by the US Navy circumference method.
 *
 * **An estimate, and rendered as one.** It is a regression fitted to tape
 * measurements, so it inherits every error in them and adds its own — commonly
 * ±3–4 percentage points against a DEXA scan, and worse at the extremes of
 * leanness where these athletes live. It earns its place anyway because the
 * *direction* it moves is reliable even where the absolute number is not, and
 * because it needs nothing but a tape.
 *
 * Returns null rather than guessing whenever an input is missing. In
 * particular the female formula needs hips and the male one does not, which is
 * why sex is required and not defaulted: defaulting it would silently apply the
 * wrong regression and produce a confident wrong number.
 */
export function navyBodyFat(input: {
  sex: 'male' | 'female' | null | undefined;
  heightCM: number | null | undefined;
  neckCM: number | null | undefined;
  waistCM: number | null | undefined;
  hipsCM?: number | null | undefined;
}): number | null {
  const { sex, heightCM, neckCM, waistCM, hipsCM } = input;
  if (!sex || !heightCM || !neckCM || !waistCM) return null;
  if (heightCM <= 0 || neckCM <= 0 || waistCM <= 0) return null;

  const log10 = Math.log10;
  let pct: number;
  if (sex === 'male') {
    // The waist-minus-neck term goes negative on a mis-typed pair, and log10
    // of that is NaN — which would render as "NaN%" rather than as nothing.
    const girth = waistCM - neckCM;
    if (girth <= 0) return null;
    pct = 495 / (1.0324 - 0.19077 * log10(girth) + 0.15456 * log10(heightCM)) - 450;
  } else {
    if (!hipsCM || hipsCM <= 0) return null;
    const girth = waistCM + hipsCM - neckCM;
    if (girth <= 0) return null;
    pct = 495 / (1.29579 - 0.35004 * log10(girth) + 0.221 * log10(heightCM)) - 450;
  }
  if (!Number.isFinite(pct) || pct <= 0 || pct >= 75) return null;
  return round(pct, 1);
}

/**
 * What making weight requires from here, and whether it is survivable.
 *
 * The one phase with a hard deadline, so the rate is derived from the gap
 * rather than prescribed. `safe` is judged against the same cut ceiling
 * everything else uses — this is not a different physiology just because there
 * is a competition attached, and an athlete pointed at 2%/week should be told
 * before the week they have to do it, not during.
 *
 * Deliberately says nothing about acute dehydration protocols. Those are real,
 * they are how the last kilo actually goes, and they are not something this app
 * should be coaching.
 */
export type MakingWeightPlan = {
  kilosToGo: number;
  daysLeft: number;
  requiredWeeklyRate: number;
  safe: boolean;
  /** True once the athlete is at or under the target. */
  made: boolean;
};

export function makingWeightPlan(
  currentKG: number | null,
  phase: Phase,
  today: string,
): MakingWeightPlan | null {
  if (currentKG == null || !phase.target_on || phase.target_weight_kg == null) return null;
  const daysLeft = daysBetween(today, phase.target_on);
  const kilosToGo = round(currentKG - phase.target_weight_kg, 2);
  if (kilosToGo <= 0) {
    return { kilosToGo: 0, daysLeft, requiredWeeklyRate: 0, safe: true, made: true };
  }
  // A deadline in the past or today cannot yield a rate — dividing by it would
  // produce Infinity and render as a number.
  if (daysLeft <= 0) {
    return { kilosToGo, daysLeft, requiredWeeklyRate: Infinity, safe: false, made: false };
  }
  const requiredWeeklyRate = (kilosToGo / currentKG) * (7 / daysLeft);
  return {
    kilosToGo,
    daysLeft,
    requiredWeeklyRate: round(requiredWeeklyRate, 4),
    safe: requiredWeeklyRate <= (RATE_TARGETS.cut as { max: number }).max,
    made: false,
  };
}

/**
 * Whether the weekly girth set is due.
 *
 * Girths are weekly because they do not move faster than that and the tape
 * error swamps the signal below it — so the check-in card asks for them once a
 * week and asks for a weight the rest of the time. One combined form every day
 * is the version people stop opening.
 */
export const GIRTH_INTERVAL_DAYS = 7;

export function girthsDue(checkins: Measured[], today: string): boolean {
  const last = checkins
    .filter((c) => c.waist_cm != null)
    .map((c) => c.measured_on)
    .sort()
    .pop();
  if (!last) return true;
  return daysBetween(last, today) >= GIRTH_INTERVAL_DAYS;
}

/** `YYYY-MM-DD` shifted by whole days, in UTC so it cannot cross a zone. */
export function shiftDate(on: string, days: number): string {
  const t = Date.parse(`${on}T00:00:00Z`) + days * 86_400_000;
  return new Date(t).toISOString().slice(0, 10);
}

function round(v: number, places: number): number {
  const f = 10 ** places;
  return Math.round(v * f) / f;
}
