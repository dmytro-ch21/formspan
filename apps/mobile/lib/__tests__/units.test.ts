import {
  formatDistance,
  formatEnergyCoefficient,
  formatFluid,
  formatGirth,
  formatHeight,
  formatMacroCoefficient,
  formatPace,
  formatWeight,
  formatWeightRate,
  fromDisplayDistance,
  fromDisplayFluid,
  fromDisplayGirth,
  fromDisplayHeight,
  fromDisplayWeight,
  fromFeetInches,
  girthUnit,
  heightUnit,
  toDisplayDistance,
  toDisplayFluid,
  toDisplayGirth,
  toDisplayHeight,
  toDisplayPerWeight,
  toDisplayWeight,
  toFeetInches,
  weightUnit,
  weightUnitName,
  type UnitSystem,
} from '../units';

/**
 * The units module, which had **no tests at all** until N105 — 16 exports of
 * conversion arithmetic that every screen in both apps reads, covered by
 * nothing on either platform.
 *
 * This file covers the source. `apps/web/src/lib/units.ts` is GENERATED from
 * it byte-for-byte and `check:units` fails if it is not, so re-running the same
 * arithmetic there would test the same code twice; web keeps a small smoke test
 * that the generated module imports and works, and no more.
 *
 * ## The round trip, and why only one direction is asserted
 *
 * **display → storage → display is exact.** The number the athlete typed comes
 * back unchanged. That is the property they can observe and the one that would
 * be a bug to lose.
 *
 * **storage → display → storage is NOT exact, and cannot be.** A display value
 * is rounded — `toDisplayWeight` to 1 dp in pounds — so information is
 * deliberately discarded on the way out. Measured before writing these tests:
 * 0 failures in 9,990 for the first direction, 16,627 failures of 17,001 for
 * the second, every one of them inside 0.001 kg.
 *
 * Asserting the second direction would be asserting a falsehood, and "fixing"
 * it would mean storing display units — which is the thing this module's own
 * header explains at length must never happen, because it makes every
 * historical row ambiguous the moment somebody changes the setting.
 *
 * So the loops below sweep the whole plausible range in BOTH systems rather
 * than spot-checking a value or two, because a conversion bug that only shows
 * up at one magnitude is exactly the kind a handful of examples misses.
 */

const BOTH: UnitSystem[] = ['metric', 'imperial'];

/** Rounds like the module does, so a test expectation cannot drift from it. */
const r = (v: number, p: number) => Math.round(v * 10 ** p) / 10 ** p;

describe('weight', () => {
  it('labels the unit in each system', () => {
    expect(weightUnit('metric')).toBe('kg');
    expect(weightUnit('imperial')).toBe('lb');
    expect(weightUnitName('metric')).toBe('kilograms');
    expect(weightUnitName('imperial')).toBe('pounds');
  });

  it('converts a known value in both directions', () => {
    // 100 kg is 220.46 lb; the display side rounds to 1 dp.
    expect(toDisplayWeight(100, 'imperial')).toBe(220.5);
    expect(toDisplayWeight(100, 'metric')).toBe(100);
    expect(fromDisplayWeight(220.5, 'imperial')).toBeCloseTo(100.017, 3);
    expect(fromDisplayWeight(100, 'metric')).toBe(100);
  });

  it('does not convert in the wrong direction', () => {
    // The single most likely bug in any of this, and the one a "did it change?"
    // assertion cannot see: multiplying where it should divide.
    expect(toDisplayWeight(100, 'imperial')).toBeGreaterThan(100);
    expect(fromDisplayWeight(100, 'imperial')).toBeLessThan(100);
  });

  it.each(BOTH)('round-trips every displayed value exactly (%s)', (u) => {
    const step = u === 'imperial' ? 0.1 : 0.01;
    const places = u === 'imperial' ? 1 : 2;
    let checked = 0;
    for (let v = 1; v <= 1000; v = r(v + step, places)) {
      const display = r(v, places);
      expect(toDisplayWeight(fromDisplayWeight(display, u), u)).toBe(display);
      checked += 1;
    }
    // The loop is the assertion; this proves the loop RAN. An off-by-one in the
    // bounds would otherwise make a vacuous pass indistinguishable from a real
    // one — nothing inside a zero-iteration loop can fail.
    expect(checked).toBeGreaterThan(900);
  });

  it('formats null as an em dash rather than throwing', () => {
    expect(formatWeight(null, 'metric')).toBe('—');
    expect(formatWeight(undefined, 'imperial')).toBe('—');
  });

  it('formats with the right unit attached', () => {
    expect(formatWeight(100, 'metric')).toBe('100kg');
    expect(formatWeight(100, 'imperial')).toBe('220.5lb');
  });
});

describe('height', () => {
  it('labels the unit in each system', () => {
    expect(heightUnit('metric')).toBe('cm');
    expect(heightUnit('imperial')).toBe('ft/in');
  });

  it('splits a known height into feet and inches', () => {
    // 180.3 cm is 71 inches, which is 5'11".
    expect(toFeetInches(180.3)).toEqual({ feet: 5, inches: 11 });
    expect(fromFeetInches(5, 11)).toBe(180.3);
  });

  it('formats feet and inches rather than decimal inches', () => {
    // "70.9 inches" is a faithful conversion nobody says out loud.
    expect(formatHeight(180.3, 'imperial')).toBe(`5'11"`);
    expect(formatHeight(180, 'metric')).toBe('180 cm');
    expect(formatHeight(null, 'imperial')).toBe('—');
  });

  it('round-trips every whole-inch height in the column’s valid range', () => {
    // The CHECK is (height_cm > 50 AND height_cm < 260): 20in = 50.8cm and
    // 102in = 259.1cm are the extreme heights that fit inside it.
    let checked = 0;
    for (let totalInches = 20; totalInches <= 102; totalInches++) {
      const feet = Math.floor(totalInches / 12);
      const inches = totalInches % 12;
      const cm = fromFeetInches(feet, inches);
      expect(cm).toBeGreaterThan(50);
      expect(cm).toBeLessThan(260);
      expect(toFeetInches(cm)).toEqual({ feet, inches });
      checked += 1;
    }
    expect(checked).toBe(83);
  });

  it('round-trips every one-decimal centimetre value', () => {
    let checked = 0;
    for (let cm = 50.1; cm <= 259.9; cm = r(cm + 0.1, 1)) {
      expect(fromDisplayHeight(toDisplayHeight(cm, 'metric'), 'metric')).toBe(cm);
      checked += 1;
    }
    expect(checked).toBeGreaterThan(2000);
  });

  it('round-trips imperial single-number heights too', () => {
    let checked = 0;
    for (let inches = 20; inches <= 102; inches = r(inches + 0.1, 1)) {
      const display = r(inches, 1);
      expect(toDisplayHeight(fromDisplayHeight(display, 'imperial'), 'imperial')).toBe(display);
      checked += 1;
    }
    expect(checked).toBeGreaterThan(800);
  });

  it('does not convert in the wrong direction', () => {
    expect(toDisplayHeight(180, 'imperial')).toBeLessThan(180);
    expect(fromDisplayHeight(71, 'imperial')).toBeGreaterThan(71);
  });
});

describe('girth', () => {
  it('is a decimal number in one unit, never feet and inches', () => {
    // A waist is "32.5 in", never 2'8½" — which is why this is separate from
    // formatHeight despite sharing the arithmetic.
    expect(girthUnit('metric')).toBe('cm');
    expect(girthUnit('imperial')).toBe('in');
    expect(formatGirth(82.6, 'imperial')).toBe('32.5 in');
    expect(formatGirth(82.6, 'metric')).toBe('82.6 cm');
    expect(formatGirth(null, 'metric')).toBe('—');
  });

  it.each(BOTH)('round-trips every displayed girth exactly (%s)', (u) => {
    let checked = 0;
    for (let v = 10; v <= 200; v = r(v + 0.1, 1)) {
      const display = r(v, 1);
      expect(toDisplayGirth(fromDisplayGirth(display, u), u)).toBe(display);
      checked += 1;
    }
    expect(checked).toBeGreaterThan(1800);
  });
});

describe('distance', () => {
  it('switches unit by magnitude in both systems', () => {
    expect(formatDistance(5000, 'metric')).toBe('5 km');
    expect(formatDistance(400, 'metric')).toBe('400 m');
    expect(formatDistance(5000, 'imperial')).toBe('3.11 mi');
    expect(formatDistance(400, 'imperial')).toBe('437 yd');
    expect(formatDistance(null, 'metric')).toBe('—');
  });

  it.each(BOTH)('round-trips every displayed distance exactly (%s)', (u) => {
    let checked = 0;
    for (let v = 1; v <= 2000; v++) {
      expect(toDisplayDistance(fromDisplayDistance(v, u), u)).toBe(v);
      checked += 1;
    }
    expect(checked).toBe(2000);
  });
});

describe('pace (N461/#772)', () => {
  it('formats a metric pace as minutes:seconds per kilometre', () => {
    // 324s = 5:24.
    expect(formatPace(324, 'metric')).toBe('5:24/km');
  });

  it('pads seconds under 10 but not minutes', () => {
    expect(formatPace(304, 'metric')).toBe('5:04/km');
  });

  it('converts to seconds per mile for imperial, not a bare unit relabel', () => {
    // 324s/km * (1609.344m / 1000m) = 521.43s/mi, rounds to 521s = 8:41.
    // A mutation that only swapped the suffix (still dividing by 1000)
    // would print "5:24/mi" here instead.
    expect(formatPace(324, 'imperial')).toBe('8:41/mi');
  });

  it('is unset for null, undefined, zero or a negative pace', () => {
    expect(formatPace(null, 'metric')).toBe('—');
    expect(formatPace(undefined, 'metric')).toBe('—');
    expect(formatPace(0, 'metric')).toBe('—');
    expect(formatPace(-5, 'metric')).toBe('—');
  });

  it('drops to 0:SS under a minute per unit', () => {
    expect(formatPace(45, 'metric')).toBe('0:45/km');
  });
});

describe('fluid', () => {
  it('exists on both platforms now', () => {
    // These four are the drift that motivated N105: apps/web's hand-copy
    // lacked all of them, so mobile could render a volume in the athlete's
    // units and web could not.
    expect(typeof toDisplayFluid).toBe('function');
    expect(typeof fromDisplayFluid).toBe('function');
    expect(typeof formatFluid).toBe('function');
  });

  it('promotes to litres in metric and stays in fl oz in imperial', () => {
    expect(formatFluid(2000, 'metric')).toBe('2 L');
    expect(formatFluid(500, 'metric')).toBe('500 ml');
    expect(formatFluid(2000, 'imperial')).toBe('67.6 fl oz');
    expect(formatFluid(null, 'metric')).toBe('—');
  });

  it('uses the US fluid ounce, not the imperial one', () => {
    // 29.5735 ml, not 28.4131. Mixing them puts a 4% error into a number
    // nobody would think to question.
    expect(fromDisplayFluid(1, 'imperial')).toBeCloseTo(29.57, 2);
  });

  it.each(BOTH)('round-trips every displayed volume exactly (%s)', (u) => {
    const step = u === 'imperial' ? 0.1 : 1;
    const places = u === 'imperial' ? 1 : 0;
    let checked = 0;
    for (let v = 1; v <= 200; v = r(v + step, places)) {
      const display = r(v, places);
      expect(toDisplayFluid(fromDisplayFluid(display, u), u)).toBe(display);
      checked += 1;
    }
    expect(checked).toBeGreaterThan(150);
  });
});

/**
 * A rate of change — the phase line on Goals, and the one figure on that screen
 * whose SIGN is the whole message.
 *
 * Added with `formatWeightRate` in N106 (#485). Before it existed web had a
 * private `signedKg` inside `Derivation.tsx` and mobile printed the server's
 * raw value with no sign handling at all, so one rate rendered two ways
 * depending on which app was open — the exact drift this module is generated
 * rather than duplicated to prevent.
 */
describe('formatWeightRate', () => {
  it('converts, because a rate scales linearly', () => {
    // −0.7 kg a week is −1.5 lb a week. An imperial athlete reading kilograms
    // on the screen that shows them their own arithmetic is the bug #483 closed.
    expect(formatWeightRate(-0.7, 'metric')).toBe('−0.7kg');
    expect(formatWeightRate(-0.7, 'imperial')).toBe('−1.5lb');
  });

  it('states the direction with a true minus sign, not a hyphen', () => {
    // U+2212. At small sizes beside a tabular figure an ASCII hyphen reads as a
    // dash rather than as arithmetic, and web already used the real character.
    expect(formatWeightRate(-0.5, 'metric')).toBe('−0.5kg');
    expect(formatWeightRate(-0.5, 'metric').charCodeAt(0)).toBe(0x2212);
  });

  it('signs a gain, so a bulk cannot be read as a cut', () => {
    expect(formatWeightRate(0.35, 'metric')).toBe('+0.35kg');
    expect(formatWeightRate(0.35, 'imperial')).toBe('+0.8lb');
  });

  it('leaves zero unsigned — it is a state, not a direction', () => {
    expect(formatWeightRate(0, 'metric')).toBe('0kg');
    expect(formatWeightRate(0, 'imperial')).toBe('0lb');
  });

  it('does not render a signed quantity that rounds to nothing', () => {
    // The trap this guard exists for: 0.02 kg is 0.044 lb, which displays as
    // 0.0 — so without the threshold an imperial athlete sees `+0lb`, a sign
    // attached to no quantity. The threshold is expressed in the IMPERIAL step
    // so "rounds to zero" means the same thing in both systems.
    expect(formatWeightRate(0.02, 'imperial')).toBe('0lb');
    expect(formatWeightRate(-0.02, 'imperial')).toBe('0lb');
    // Just above it, the sign comes back.
    expect(formatWeightRate(0.05, 'imperial')).toBe('+0.1lb');
  });

  it('reports an absent rate as absent, not as zero', () => {
    // A phase with no rate and a phase holding weight are different facts.
    expect(formatWeightRate(null, 'metric')).toBe('—');
    expect(formatWeightRate(undefined, 'imperial')).toBe('—');
  });
});

/**
 * Per-bodyweight coefficients — N111 (#494). `protein_g_per_kg`,
 * `fat_g_per_kg` and `kcal_per_kg` arrive from the server per KILOGRAM,
 * always; these are what convert them for an imperial athlete, the half of
 * the derivation N105 deliberately left alone.
 */
describe('toDisplayPerWeight', () => {
  it('leaves a metric coefficient untouched', () => {
    expect(toDisplayPerWeight(2.2, 'metric')).toBe(2.2);
    expect(toDisplayPerWeight(7700, 'metric')).toBe(7700);
  });

  it('DIVIDES by LB_PER_KG for imperial — a coefficient is a rate, not a weight', () => {
    // The sharpest way this goes wrong: multiplying instead of dividing,
    // which produces a number about 4.86× too large rather than a visibly
    // broken one. Asserted against a hand-computed value, not the module's
    // own arithmetic mirrored back at it.
    expect(toDisplayPerWeight(2.2, 'imperial')).toBeCloseTo(0.9979, 4);
    expect(toDisplayPerWeight(7700, 'imperial')).toBeCloseTo(3492.6612, 3);
  });

  it('is the inverse of toDisplayWeight’s multiplication, so the two sides of a derivation still multiply out', () => {
    // The whole point of converting the coefficient at all: an athlete's
    // bodyweight in lb times the coefficient in g/lb has to equal the same
    // athlete's bodyweight in kg times the coefficient in g/kg, because both
    // describe the same grams of protein.
    const weightKg = 84.3;
    const perKg = 2.2;
    const gramsFromKg = weightKg * perKg;
    const weightLb = toDisplayWeight(weightKg, 'imperial');
    const perLb = toDisplayPerWeight(perKg, 'imperial');
    // Both sides are display-precision (rounded), so this checks they agree
    // to within the display rounding rather than bit-for-bit.
    expect(weightLb * perLb).toBeCloseTo(gramsFromKg, 0);
  });
});

describe('formatMacroCoefficient', () => {
  it('renders a metric coefficient exactly as before N111', () => {
    expect(formatMacroCoefficient(2.2, 'metric')).toBe('2.2 g per kg');
    expect(formatMacroCoefficient(0.8, 'metric')).toBe('0.8 g per kg');
  });

  it('converts to g per lb for an imperial athlete', () => {
    // 2.2 g/kg converts to ~0.998 g/lb, which rounds to the familiar "about
    // 1g of protein per pound of bodyweight" bodybuilding heuristic — not a
    // coincidence chosen for the test, the actual converted figure.
    expect(formatMacroCoefficient(2.2, 'imperial')).toBe('1 g per lb');
    expect(formatMacroCoefficient(0.8, 'imperial')).toBe('0.36 g per lb');
  });

  it('trims a trailing zero rather than printing "1.00 g per lb"', () => {
    expect(formatMacroCoefficient(2.2, 'imperial')).not.toMatch(/\.0+/);
  });
});

describe('formatEnergyCoefficient', () => {
  it('renders the Wishnofsky figure unconverted for a metric athlete', () => {
    expect(formatEnergyCoefficient(7700, 'metric')).toBe('7700 kcal per kg');
  });

  it('converts to kcal per lb for an imperial athlete', () => {
    // NOT 3,500 — that is a separately-derived US rule of thumb (implying
    // ≈7,716 kcal/kg), close to but not the same number as this app's own
    // 7,700 kcal/kg actually converted. Rendering the real converted value is
    // what keeps this line multiplying out against the kg-based figure it
    // came from, rather than substituting a culturally familiar one that
    // does not.
    expect(formatEnergyCoefficient(7700, 'imperial')).toBe('3493 kcal per lb');
  });

  it('rounds to a whole number, matching every other kcal figure on these screens', () => {
    expect(formatEnergyCoefficient(7700, 'imperial')).not.toMatch(/\./);
  });
});
