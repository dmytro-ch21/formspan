import {
  MAX_KCAL,
  MAX_MACRO_G,
  MIN_KCAL,
  parseManualTarget,
  targetMacrosLookOff,
  type ManualDraft,
} from '../manualTarget';

/**
 * Parsing a typed target.
 *
 * Every case here is about `Number()` on a string somebody half-typed, which is
 * where this can be wrong in a way an athlete would eventually notice — a
 * target of zero, or a silent 0 g of protein — rather than in a way that
 * throws.
 */

const FULL: ManualDraft = {
  kcal: '2400',
  protein_g: '180',
  carb_g: '260',
  fat_g: '80',
  fibre_g: '30',
};

function draft(over: Partial<ManualDraft>): ManualDraft {
  return { ...FULL, ...over };
}

describe('a complete draft', () => {
  it('parses to numbers', () => {
    const r = parseManualTarget(FULL);
    expect(r).toEqual({
      ok: true,
      input: { kcal: 2400, protein_g: 180, carb_g: 260, fat_g: 80, fibre_g: 30 },
    });
  });

  it('rounds, because the wire takes whole grams', () => {
    const r = parseManualTarget(draft({ kcal: '2400.6', protein_g: '180.4' }));
    expect(r.ok && r.input.kcal).toBe(2401);
    expect(r.ok && r.input.protein_g).toBe(180);
  });

  it('ignores surrounding whitespace rather than reading it as a value', () => {
    expect(parseManualTarget(draft({ kcal: '  2400  ' })).ok).toBe(true);
  });

  // iOS's decimal-pad shows a COMMA key in many locales, and ten other numeric
  // inputs in this app already normalise it. Without this a European athlete is
  // told a number they can see on screen "needs to be a number" — a
  // locale-dependent input block, invisible to anyone testing in en-US.
  it('reads a comma as a decimal point', () => {
    const r = parseManualTarget(draft({ fibre_g: '30,4' }));
    expect(r.ok && r.input.fibre_g).toBe(30);
  });
});

describe('blank fibre is null, never zero', () => {
  // A target that does not state fibre is not a zero-fibre target. `Number('')`
  // is a perfectly finite 0, so without the blank check FIRST this silence
  // would be stored as a measurement and averaged as one.
  it('stores an unstated fibre as null', () => {
    const r = parseManualTarget(draft({ fibre_g: '' }));
    expect(r.ok && r.input.fibre_g).toBeNull();
  });

  it('keeps a stated zero as zero', () => {
    // The other half of the same distinction: somebody who typed 0 said
    // something, and null would throw it away.
    const r = parseManualTarget(draft({ fibre_g: '0' }));
    expect(r.ok && r.input.fibre_g).toBe(0);
  });

  it('treats whitespace as blank, not as a number', () => {
    // `Number(' ')` is 0 too — the same trap one keystroke along.
    const r = parseManualTarget(draft({ fibre_g: '   ' }));
    expect(r.ok && r.input.fibre_g).toBeNull();
  });
});

describe('what it refuses', () => {
  // Without the `> 0` floor an empty calorie field parses to a finite 0 and an
  // untouched form saves a target of nothing.
  it('refuses an empty calorie field', () => {
    const r = parseManualTarget(draft({ kcal: '' }));
    expect(r.ok).toBe(false);
    expect(!r.ok && r.field).toBe('kcal');
  });

  it('refuses zero calories', () => {
    expect(parseManualTarget(draft({ kcal: '0' })).ok).toBe(false);
  });

  it('refuses negative calories', () => {
    expect(parseManualTarget(draft({ kcal: '-2400' })).ok).toBe(false);
  });

  it('refuses text', () => {
    expect(parseManualTarget(draft({ kcal: 'lots' })).ok).toBe(false);
  });

  // A blank macro is refused rather than defaulted, for the same reason blank
  // fibre is null: 0 g of protein reads as a decision, and nobody made it.
  it.each(['protein_g', 'carb_g', 'fat_g'] as const)('refuses a blank %s', (key) => {
    const r = parseManualTarget(draft({ [key]: '' }));
    expect(r.ok).toBe(false);
    expect(!r.ok && r.field).toBe(key);
  });

  it.each(['protein_g', 'carb_g', 'fat_g'] as const)('refuses a negative %s', (key) => {
    expect(parseManualTarget(draft({ [key]: '-1' })).ok).toBe(false);
  });

  it('refuses a negative fibre', () => {
    expect(parseManualTarget(draft({ fibre_g: '-1' })).ok).toBe(false);
  });

  it('refuses non-numeric fibre rather than reading it as absent', () => {
    // The blank branch returns null and the parse branch returns a problem;
    // routing 'x' into the first would store an unstated fibre for a field the
    // athlete plainly typed in.
    const r = parseManualTarget(draft({ fibre_g: 'x' }));
    expect(r.ok).toBe(false);
    expect(!r.ok && r.field).toBe('fibre_g');
  });

  // The rails are for a fat-fingered number pad with no thousands separator.
  // A 24,000 kcal target would otherwise be stored and judged against for
  // months, showing up only as "the ring never fills".
  it('refuses an implausible calorie figure', () => {
    expect(parseManualTarget(draft({ kcal: String(MAX_KCAL + 1) })).ok).toBe(false);
  });

  // The FLOOR is the half that matters most, and it did not exist at first:
  // 700 kcal — a dropped digit — passed the client and hit a permanent 400 the
  // screen then reported as a bad connection.
  it('refuses a calorie figure below the floor', () => {
    expect(parseManualTarget(draft({ kcal: String(MIN_KCAL - 1) })).ok).toBe(false);
  });

  it.each([MIN_KCAL, MAX_KCAL])('accepts one right on the boundary (%i)', (k) => {
    // Pins both comparisons as strict. Without these the rail could move a
    // whole unit in either direction and nothing would notice.
    expect(parseManualTarget(draft({ kcal: String(k) })).ok).toBe(true);
  });

  it.each(['protein_g', 'carb_g', 'fat_g', 'fibre_g'] as const)(
    'refuses an implausible %s',
    (key) => {
      expect(parseManualTarget(draft({ [key]: String(MAX_MACRO_G[key] + 1) })).ok).toBe(false);
    },
  );

  it.each(['protein_g', 'carb_g', 'fat_g', 'fibre_g'] as const)(
    'accepts %s right on its own ceiling',
    (key) => {
      // PER-MACRO, not one shared number. The server's rail is 500/1200/400/120
      // field by field; a single ceiling here would accept 1,200 g of fat and
      // hand the athlete a 400 the screen cannot explain.
      expect(parseManualTarget(draft({ [key]: String(MAX_MACRO_G[key]) })).ok).toBe(true);
    },
  );

  it('matches the server rail exactly, field for field', () => {
    // Pinned to LITERALS, deliberately. Asserting `MAX_MACRO_G.fat_g ===
    // MAX_MACRO_G.fat_g` would be true by construction; these numbers are
    // copied from `backend/internal/modules/nutrition/nutrition.go`'s
    // `Target.Validate`, and this is the line that goes red if the server's
    // move and these do not.
    expect(MIN_KCAL).toBe(800);
    expect(MAX_KCAL).toBe(8000);
    expect(MAX_MACRO_G).toEqual({ protein_g: 500, carb_g: 1200, fat_g: 400, fibre_g: 120 });
  });

  it('names the FIRST bad field rather than the last', () => {
    // The screen highlights one input and points at it. Reporting the last
    // failure would send somebody to a field they had not reached yet.
    const r = parseManualTarget(draft({ kcal: '', protein_g: '' }));
    expect(!r.ok && r.field).toBe('kcal');
  });
});

describe('the macros-do-not-add-up nudge', () => {
  // A target is a plan rather than a measurement, so unlike a food label its
  // macros genuinely should reconcile with its calories.
  it('is quiet when they reconcile', () => {
    // 180×4 + 260×4 + 80×9 = 2480, within 10% of 2400.
    const r = parseManualTarget(FULL);
    expect(r.ok && targetMacrosLookOff(r.input)).toBe(false);
  });

  it('fires when they do not', () => {
    // 50×4 + 50×4 + 20×9 = 580 against a stated 2400.
    const r = parseManualTarget(draft({ protein_g: '50', carb_g: '50', fat_g: '20' }));
    expect(r.ok && targetMacrosLookOff(r.input)).toBe(true);
  });

  it('is quiet when every macro is zero, rather than calling it a mismatch', () => {
    // Somebody setting a calories-only target has said nothing about macros.
    // A nudge here would fire on every one of them, which teaches people to
    // ignore the nudge that matters.
    const r = parseManualTarget(draft({ protein_g: '0', carb_g: '0', fat_g: '0' }));
    expect(r.ok && targetMacrosLookOff(r.input)).toBe(false);
  });
});
