/**
 * Display units — GENERATED FILE, DO NOT EDIT.
 *
 * Generated from `apps/mobile/lib/units.ts` by `scripts/sync-units.py`. Edit
 * that file, run `python3 scripts/sync-units.py --write`, and commit both.
 * `pnpm run check:units` fails if this copy is out of date, in `verify` and in
 * CI, so an edit made here instead is caught rather than silently lost on the
 * next regeneration.
 *
 * The reason it is generated rather than shared or hand-copied is recorded in
 * the generator's docstring and in the source file's header: hand-copies had
 * already drifted (this file was missing all four fluid functions), and a
 * shared workspace package was built and abandoned two bundlers down in N50.
 * Generation costs no bundler configuration, because this file sits exactly
 * where it always sat.
 */

export type UnitSystem = 'metric' | 'imperial';

export const UNIT_SYSTEMS: { key: UnitSystem; label: string; detail: string }[] = [
  { key: 'metric', label: 'Metric', detail: 'kilograms · metres' },
  { key: 'imperial', label: 'Imperial', detail: 'pounds · miles' },
];

const LB_PER_KG = 2.2046226218;
const M_PER_MILE = 1609.344;
const M_PER_YARD = 0.9144;

/** The default an account starts on, and what to fall back to when unknown. */
export const DEFAULT_UNIT_SYSTEM: UnitSystem = 'metric';

/**
 * The one-line description of a system, for a settings row.
 *
 * An accessor rather than `UNIT_SYSTEMS[0]` at the call site: indexing the
 * table couples the caller to its ORDER, and `you.tsx` previously avoided that
 * by writing the words out a second time instead — which is the duplication
 * this whole module is being reshaped to remove.
 */
export function unitSystemDetail(u: UnitSystem): string {
  return UNIT_SYSTEMS.find((s) => s.key === u)?.detail ?? '';
}

export function weightUnit(u: UnitSystem): string {
  return u === 'imperial' ? 'lb' : 'kg';
}

/**
 * The unit's name in words, for a screen reader.
 *
 * `weightUnit` returns the written abbreviation, and a screen reader says `lb`
 * as the two letters "L B". An accessible label needs the spoken form, so it
 * gets its own function rather than a second literal at each call site — which
 * is exactly how "Target weight in kilograms" came to sit on a field that was
 * about to ask for pounds.
 */
export function weightUnitName(u: UnitSystem): string {
  return u === 'imperial' ? 'pounds' : 'kilograms';
}

/** Storage (kg) → what to show. */
export function toDisplayWeight(kg: number, u: UnitSystem): number {
  return u === 'imperial' ? round(kg * LB_PER_KG, 1) : round(kg, 2);
}

/** What was typed → storage (kg). */
export function fromDisplayWeight(v: number, u: UnitSystem): number {
  // Kept to 3 decimals so a pounds round-trip doesn't accumulate float dust
  // in the database, while still preserving 0.5 lb precision.
  return u === 'imperial' ? round(v / LB_PER_KG, 3) : v;
}

export function formatWeight(kg: number | null | undefined, u: UnitSystem): string {
  if (kg == null) return '—';
  return `${trim(toDisplayWeight(kg, u))}${weightUnit(u)}`;
}

/**
 * A rate of change — "−0.7kg per week", "+1.5lb per week".
 *
 * A rate scales linearly, so this is `formatWeight` on the magnitude with the
 * direction stated separately. The **sign is the whole point**: a phase's rate
 * arrives signed from the server and the difference between losing and gaining
 * three quarters of a kilogram a week is the difference between two training
 * blocks. Rendering the magnitude alone is a real bug, not a cosmetic one.
 *
 * Three details, each of which was a difference between the two platforms
 * before this existed:
 *
 *  - **A true minus sign (U+2212), not a hyphen.** Web already used one; mobile
 *    printed the ASCII hyphen the server sent. At small sizes a hyphen beside a
 *    tabular figure reads as a dash rather than as arithmetic.
 *  - **Zero is unsigned.** "−0kg" is not a direction, and a rate of zero means
 *    the weight is being held — which is a state the caller usually wants to
 *    say in words instead. The threshold is half of imperial's own display
 *    precision, so a rate that rounds to nothing cannot render as a signed
 *    quantity that rounds to nothing.
 *  - **A space before the unit is NOT added here**, because `formatWeight` does
 *    not add one. Two spellings of one unit is exactly the drift this module
 *    exists to prevent, so the period ("per week") is the caller's to append.
 *
 * This lives here rather than in a screen because both platforms render it, and
 * a private copy in one of them is how they came to disagree in the first
 * place: web had `signedKg` inside `Derivation.tsx` and mobile had no sign at
 * all.
 *
 * **Mobile is the only caller so far, and web's private copies still exist.**
 * N106 added this and wired the mobile screen to it; it deliberately did not
 * migrate `apps/web`, which is a different screen and a different ticket. So
 * the two platforms are still capable of disagreeing, and on one case they
 * actually do: web's `signedKg` calls anything under **0.005 kg** zero, while
 * this calls anything under **≈0.0227 kg** zero (half of imperial's 0.1 lb
 * step). A rate between those two renders `+0.01kg` on web and `0kg` here.
 * Known, narrow, and out of scope — recorded so the next person deletes web's
 * copies against this behaviour rather than assuming they already match.
 */
export function formatWeightRate(
  kgPerWeek: number | null | undefined,
  u: UnitSystem,
): string {
  if (kgPerWeek == null) return '—';
  // Half of imperial's 0.1 lb display step, expressed in kg, so "rounds to
  // zero" means the same thing in both systems rather than in kilograms only.
  const negligible = 0.05 / LB_PER_KG;
  if (Math.abs(kgPerWeek) < negligible) return formatWeight(0, u);
  return `${kgPerWeek > 0 ? '+' : '−'}${formatWeight(Math.abs(kgPerWeek), u)}`;
}

/**
 * Cumulative load — "volume" in the UI — which lives at a different order of
 * magnitude than a single set.
 *
 * `formatWeight` is right for "100kg" on a bar and wrong for a quarter of a
 * million: a block's volume through it reads `251147kg`, which nobody takes
 * in at a glance — least of all on a phone. Tonnes above 1000kg, separators
 * throughout.
 *
 * Deliberately not folded into `formatWeight`: abbreviating there would turn
 * every heavy single on the session screen into `0.2t`.
 */
/**
 * An estimate, rendered at the precision an estimate actually has.
 *
 * `formatWeight` keeps two decimals because a logged set is a measurement —
 * 62.55kg is what was on the bar. A one-rep max derived from a rep-max curve
 * is not, and "143.88kg" invites reading a modelled number as a measured one.
 * Rounded to whole display units: 144kg, 317lb.
 */
export function formatEstimate(kg: number | null | undefined, u: UnitSystem): string {
  if (kg == null) return '—';
  return `${Math.round(toDisplayWeight(kg, u))}${weightUnit(u)}`;
}

export function formatVolume(kg: number | null | undefined, u: UnitSystem): string {
  if (kg == null) return '—';
  if (u === 'metric') {
    // Rounded before the comparison, or 999.6 renders as "1,000kg".
    if (Math.round(kg) < 1000) return `${Math.round(kg).toLocaleString()}kg`;
    return `${(Math.round(kg / 100) / 10).toLocaleString(undefined, {
      minimumFractionDigits: 1,
      maximumFractionDigits: 1,
    })}t`;
  }
  // Pounds run an order of magnitude larger, so the same block that reads
  // 251.1t reads 553,684lb — the exact mouthful this function exists to
  // avoid, for the majority of the target market. Abbreviated past six
  // digits; short tons are avoided because "t" would then mean two things.
  const lb = Math.round(kg * LB_PER_KG);
  if (lb < 100_000) return `${lb.toLocaleString()}lb`;
  return `${(Math.round(lb / 100) / 10).toLocaleString(undefined, {
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  })}k lb`;
}

/**
 * Distance switches unit by magnitude, in both systems — nobody says "0.02
 * miles" and nobody says "5000 metres" for a run.
 */
export function formatDistance(metres: number | null | undefined, u: UnitSystem): string {
  if (metres == null) return '—';
  if (u === 'imperial') {
    if (metres >= M_PER_MILE / 2) return `${trim(round(metres / M_PER_MILE, 2))} mi`;
    return `${trim(round(metres / M_PER_YARD, 0))} yd`;
  }
  if (metres >= 1000) return `${trim(round(metres / 1000, 2))} km`;
  return `${trim(round(metres, 0))} m`;
}

/** The unit a distance *input* takes — one unit, so the field is unambiguous. */
export function distanceInputUnit(u: UnitSystem): string {
  return u === 'imperial' ? 'yd' : 'm';
}

export function toDisplayDistance(metres: number, u: UnitSystem): number {
  return u === 'imperial' ? round(metres / M_PER_YARD, 0) : round(metres, 0);
}

export function fromDisplayDistance(v: number, u: UnitSystem): number {
  return u === 'imperial' ? round(v * M_PER_YARD, 2) : v;
}

/**
 * Body length — height, and the girth sites that share its arithmetic.
 *
 * Stored in **centimetres**, always, same rule as everything above:
 * `profiles.height_cm` is `NUMERIC(5, 1)` with `CHECK (height_cm > 50 AND
 * height_cm < 260)`, and the check-in girths are centimetres too.
 *
 * **Imperial height is not one number, and that is the whole design.** Nobody
 * says "70.9 inches" — they say 5'11". So the display side is feet-and-inches
 * and the input side is two fields, which is why this section exports a pair
 * (`toFeetInches` / `fromFeetInches`) alongside the single-number functions
 * the other quantities have. A single inches box would be a faithful unit
 * conversion and an unusable control.
 *
 * ## The round trip, stated precisely
 *
 * Two directions exist and only one of them can hold:
 *
 * - **display → storage → display is EXACT** — the number the athlete typed
 *   comes back unchanged. Measured over the whole valid range: 0 failures for
 *   all 83 whole-inch heights from 1'8" to 8'6", and 0 for all 2,099
 *   one-decimal centimetre values.
 * - **storage → display → storage is NOT exact**, and cannot be, because a
 *   display value is rounded. This is not a defect and it is the same
 *   asymmetry `toDisplayWeight` has: 16,627 of 17,001 kilogram values differ
 *   by up to 0.001 kg after a round trip through pounds.
 *
 * The first is the property worth having, because it is the one an athlete can
 * observe. The second is what would force storing display units, which is the
 * thing this whole file exists to avoid.
 *
 * `fromFeetInches` rounds to **one decimal on purpose**: that is the column's
 * own precision, so the client and Postgres agree about what was stored rather
 * than the database silently rounding a value the app still believes.
 */
const CM_PER_INCH = 2.54;

export function heightUnit(u: UnitSystem): string {
  return u === 'imperial' ? 'ft/in' : 'cm';
}

/** Storage (cm) → feet and whole inches, for a two-field imperial input. */
export function toFeetInches(cm: number): { feet: number; inches: number } {
  const total = Math.round(cm / CM_PER_INCH);
  return { feet: Math.floor(total / 12), inches: total % 12 };
}

/** Feet and inches → storage (cm), at the column's own precision. */
export function fromFeetInches(feet: number, inches: number): number {
  return round((feet * 12 + inches) * CM_PER_INCH, 1);
}

/**
 * Storage (cm) → the single number a metric input shows.
 *
 * Imperial callers want `toFeetInches` instead; this returns total inches so
 * that a caller which genuinely needs one number (a chart axis, say) has one.
 */
export function toDisplayHeight(cm: number, u: UnitSystem): number {
  return u === 'imperial' ? round(cm / CM_PER_INCH, 1) : round(cm, 1);
}

/** What was typed → storage (cm). */
export function fromDisplayHeight(v: number, u: UnitSystem): number {
  return u === 'imperial' ? round(v * CM_PER_INCH, 1) : round(v, 1);
}

export function formatHeight(cm: number | null | undefined, u: UnitSystem): string {
  if (cm == null) return '—';
  if (u === 'imperial') {
    const { feet, inches } = toFeetInches(cm);
    return `${feet}'${inches}"`;
  }
  return `${trim(round(cm, 1))} cm`;
}

/**
 * A girth — waist, hips, a limb — which is a length but not a height.
 *
 * Same storage (cm) and same conversion, but rendered as a decimal number in
 * one unit rather than feet-and-inches: a waist is "32.5 in", never 2'8½".
 * Kept separate from `formatHeight` so that distinction cannot be lost by
 * somebody reusing the wrong one.
 */
export function girthUnit(u: UnitSystem): string {
  return u === 'imperial' ? 'in' : 'cm';
}

export function toDisplayGirth(cm: number, u: UnitSystem): number {
  return u === 'imperial' ? round(cm / CM_PER_INCH, 1) : round(cm, 1);
}

export function fromDisplayGirth(v: number, u: UnitSystem): number {
  return u === 'imperial' ? round(v * CM_PER_INCH, 1) : round(v, 1);
}

/**
 * The girth unit as a screen reader should SAY it.
 *
 * `girthUnit` returns the abbreviation a sighted athlete reads next to the
 * field; VoiceOver pronounces "in" as the word "in" and "cm" as two letters,
 * so a label built from the abbreviation reads out wrong in both systems.
 * Same reasoning as `weightUnitName`, and the same reason it is a function
 * rather than a literal at the call site.
 */
export function girthUnitName(u: UnitSystem): string {
  return u === 'imperial' ? 'inches' : 'centimetres';
}

export function formatGirth(cm: number | null | undefined, u: UnitSystem): string {
  if (cm == null) return '—';
  return `${trim(toDisplayGirth(cm, u))} ${girthUnit(u)}`;
}

/**
 * Liquid volume — a daily tracker's millilitres, shown as ml or fl oz.
 *
 * **Not `formatVolume` above**, which already owns that word and means
 * cumulative barbell LOAD. The collision is real enough to be worth the
 * awkward name: a tracker card asking for "the volume" and getting tonnes is
 * exactly the kind of thing that compiles.
 *
 * Stored in millilitres, always, for the same reason weights are kilograms —
 * an athlete who flips the setting must not find last week's water rewritten.
 * The US fluid ounce (29.5735 ml), not the imperial one (28.4131): this app's
 * "imperial" is the American convention throughout (pounds, miles, yards), and
 * mixing the two ounces would put a 4% error into a number nobody would think
 * to question.
 */
const ML_PER_FL_OZ = 29.5735295625;

export function fluidUnit(u: UnitSystem): string {
  return u === 'imperial' ? 'fl oz' : 'ml';
}

/** Storage (ml) → what to show. */
export function toDisplayFluid(ml: number, u: UnitSystem): number {
  return u === 'imperial' ? round(ml / ML_PER_FL_OZ, 1) : round(ml, 0);
}

/** What was typed → storage (ml). */
export function fromDisplayFluid(v: number, u: UnitSystem): number {
  return u === 'imperial' ? round(v * ML_PER_FL_OZ, 2) : v;
}

/**
 * A volume with its unit, promoted to litres past a litre in metric.
 *
 * "2000 ml" is a number you read digit by digit; "2 L" is one you take in. The
 * imperial side deliberately does NOT promote to US pints or quarts — an
 * athlete tracking water thinks in fluid ounces all the way up, and "62.5 fl
 * oz" stays comparable with the 8 fl oz glass beside it.
 */
export function formatFluid(ml: number | null | undefined, u: UnitSystem): string {
  if (ml == null) return '—';
  if (u === 'imperial') return `${trim(toDisplayFluid(ml, u))} fl oz`;
  if (Math.abs(ml) >= 1000) return `${trim(round(ml / 1000, 2))} L`;
  return `${trim(round(ml, 0))} ml`;
}

/* ---------------------------------------------------------------------------
 * Food quantities (N90)
 *
 * **Grams are stored, always** — the same rule as kilograms above, and for the
 * same reason: a stored converted value makes every historical row ambiguous
 * the moment somebody changes the setting.
 *
 * The food unit is its OWN setting rather than a reading of UnitSystem.
 * Kitchen scales and US nutrition labels are both in grams, so an imperial
 * athlete weighing chicken still wants grams; deriving it from `imperial` would
 * be wrong for most of the people it affects. `profiles.food_unit` stores the
 * choice and is null until one is made — which is when `defaultFoodUnit` below
 * applies, and only then.
 * ------------------------------------------------------------------------- */

export type FoodUnit = 'g' | 'oz';

/**
 * International avoirdupois ounce — a unit of MASS. Exact by definition.
 *
 * **There are two different ounces in this file and they are not
 * interchangeable.** This one weighs food; `ML_PER_FL_OZ` measures liquid, and
 * the US fluid ounce is 29.5735 ml. They differ by 4%, both abbreviate to "oz"
 * in ordinary speech, and using one for the other produces a number that looks
 * entirely reasonable. Same hazard `formatVolume` and `formatFluid` already
 * carry above — an "oz" with no qualifier is ambiguous, so every symbol here
 * says which.
 */
const G_PER_OZ = 28.349523125;

/**
 * What an athlete who has never chosen sees. The ONLY place UnitSystem touches
 * food — once `profiles.food_unit` is set, this is not consulted again.
 */
export function defaultFoodUnit(u: UnitSystem): FoodUnit {
  return u === 'imperial' ? 'oz' : 'g';
}

/** Storage (g) -> what to show in the field. */
export function toDisplayGrams(grams: number, u: FoodUnit): number {
  // 2dp in ounces because 0.01oz is ~0.28g — finer than any kitchen scale, and
  // enough that a round trip does not visibly move. Whole grams because no
  // scale an athlete owns reads a fraction of one.
  return u === 'oz' ? round(grams / G_PER_OZ, 2) : round(grams, 0);
}

/** What was typed -> storage (g). */
export function fromDisplayGrams(v: number, u: FoodUnit): number {
  // 2dp rather than whole grams: rounding a typed ounce value to an integer
  // gram would make the oz round trip lossy at small quantities, which is
  // exactly what the test asserts against.
  return u === 'oz' ? round(v * G_PER_OZ, 2) : v;
}

export function foodUnitLabel(u: FoodUnit): string {
  return u === 'oz' ? 'oz' : 'g';
}

/** A quantity with its unit, for display — "150g", "5.29oz". */
export function formatFoodQuantity(grams: number | null | undefined, u: FoodUnit): string {
  if (grams == null) return '—';
  return `${trim(toDisplayGrams(grams, u))}${foodUnitLabel(u)}`;
}

function round(v: number, places: number): number {
  const f = 10 ** places;
  return Math.round(v * f) / f;
}

/** Drops a trailing ".0" so 100 reads as "100", not "100.0". */
function trim(v: number): string {
  return String(v);
}
