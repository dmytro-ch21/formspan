/**
 * Barcode normalisation.
 *
 * Pure arithmetic, so this is the one part of the scan feature a test can
 * genuinely prove — the camera is not drivable here and a device run is the
 * only thing that exercises it. That makes these assertions load-bearing
 * rather than incidental: every silent failure this feature could have is a
 * normalisation bug, because a wrongly-normalised code does not error, it
 * comes back as an ordinary "we do not have this one".
 */

import {
  FOOD_BARCODE_TYPES,
  checkDigit,
  expandUpcE,
  hasValidCheckDigit,
  normaliseBarcode,
} from '../barcode';

describe('checkDigit', () => {
  // Real GTINs, check digit removed. If the weighting were flipped (1,3
  // instead of 3,1 from the right) these would each come back wrong, which is
  // the mistake this is here to pin.
  // REAL published GTINs, check digit removed — not codes invented for the
  // test. An invented one agrees with whatever the implementation does, which
  // is exactly no evidence; the first draft of this file did that and the
  // vectors had to be re-derived independently before it meant anything.
  it.each([
    ['400638133393', '1'], // EAN-13
    ['03600029145', '2'], // UPC-A
    ['9638507', '4'], // EAN-8
    ['500011263792', '2'], // EAN-13
  ])('computes the check digit for %s', (partial, expected) => {
    expect(checkDigit(partial)).toBe(expected);
  });

  it('rejects a code whose stated check digit disagrees', () => {
    expect(hasValidCheckDigit('4006381333931')).toBe(true);
    // Same code, last digit bumped.
    expect(hasValidCheckDigit('4006381333932')).toBe(false);
  });
});

describe('normaliseBarcode', () => {
  it('leaves a valid EAN-13 alone', () => {
    expect(normaliseBarcode('4006381333931')).toBe('4006381333931');
  });

  /**
   * The reason this module exists. The SAME box is 12 digits in a US shop and
   * 13 in an EU one, differing by a leading zero that is implied rather than
   * printed, and Open Food Facts keys on the 13-digit form.
   */
  it('widens a UPC-A to the EAN-13 the catalog is keyed on', () => {
    expect(normaliseBarcode('036000291452')).toBe('0036000291452');
  });

  it('zero-pads an EAN-8', () => {
    expect(normaliseBarcode('96385074')).toBe('0000096385074');
  });

  /**
   * A carton of a multipack reduces to the unit inside it — and the check
   * digit is RECOMPUTED, because the carton's own is not the unit's. A test
   * that only checked the first twelve digits would pass with a wrong final
   * digit and every scan of a multipack would miss.
   */
  it('reduces an ITF-14 carton code to its unit EAN-13', () => {
    const unit = '5000112637922';
    const carton = `1${unit.slice(0, 12)}${checkDigit(`1${unit.slice(0, 12)}`)}`;
    expect(carton).toHaveLength(14);
    expect(normaliseBarcode(carton)).toBe(unit);
    expect(hasValidCheckDigit(normaliseBarcode(carton)!)).toBe(true);
  });

  /**
   * A misread must NOT resolve to a lookup.
   *
   * This is the assertion that keeps the screen honest. A creased or curved
   * packet routinely fails its own check digit, and a code that got through
   * here would be looked up, missed, and reported to the athlete as "we do not
   * have this one" — a false statement about the catalog caused by a bad scan.
   */
  it('rejects a code whose check digit does not verify', () => {
    expect(normaliseBarcode('4006381333932')).toBeNull();
    expect(normaliseBarcode('036000291453')).toBeNull();
  });

  it('rejects anything that is not digits', () => {
    expect(normaliseBarcode('https://example.com/promo')).toBeNull();
    expect(normaliseBarcode('')).toBeNull();
    expect(normaliseBarcode('12345')).toBeNull();
  });
});

/**
 * A UPC-E's check digit is the check digit of its UPC-A EXPANSION, not of its
 * own seven-digit prefix — which is why it can be verified at all, and is the
 * relationship the entry point's guard rests on. Derived here rather than
 * written as a literal so the test states that relationship instead of
 * assuming it.
 */
const PAYLOAD = '123450';
const FRAMED = `0${PAYLOAD}${expandUpcE(PAYLOAD)!.slice(-1)}`;

describe('expandUpcE', () => {
  /**
   * Every compression rule, one case each, keyed on the last payload digit.
   *
   * The expected values are derived INDEPENDENTLY of this module — from the
   * published rule, with a separately written check-digit routine — because a
   * vector produced by the code under test agrees with whatever that code
   * does. What is pinned here is the BODY LAYOUT: where the zero run goes for
   * each rule, which is the part a typo breaks silently and which no other
   * assertion in this file would catch.
   */
  it.each([
    ['012340', '001000002346'],
    ['012341', '001100002345'],
    ['012342', '001200002344'],
    ['012343', '001200000340'],
    ['012344', '001230000044'],
    ['012345', '001234000057'],
    ['123450', '012000003455'],
  ])('expands the payload %s', (payload, expected) => {
    expect(expandUpcE(payload)).toBe(expected);
    expect(hasValidCheckDigit(expected)).toBe(true);
  });

  it('reads the payload out of the 8-digit framed form', () => {
    expect(expandUpcE(FRAMED)).toBe(expandUpcE(PAYLOAD));
    expect(expandUpcE(PAYLOAD)).toBe('012000003455');
  });

  it('refuses a number system other than 0 or 1', () => {
    expect(expandUpcE('21234505')).toBeNull();
  });

  it('refuses a length that is not 6 or 8', () => {
    expect(expandUpcE('1234567')).toBeNull();
    expect(expandUpcE('')).toBeNull();
  });

  /** A UPC-E reaches the catalog as a 13-digit GTIN like everything else. */
  it('normalises a framed UPC-E through to 13 digits', () => {
    expect(normaliseBarcode(FRAMED, 'upc_e')).toBe('0012000003455');
  });

  /**
   * The bug this file did not catch, found in review.
   *
   * `expandUpcE` **computes** the check digit it returns, so the old guard —
   * `hasValidCheckDigit(expanded)` — was true by construction: it verified a
   * digit we had just derived ourselves and said nothing about what the camera
   * read. Every 8-digit vector written here was valid, so nothing went red.
   *
   * The consequence was the precise failure the feature exists to prevent: a
   * garbled read expands to a syntactically perfect UPC-A, gets looked up, and
   * is reported to the athlete as "we don't have this one" — or resolves to a
   * DIFFERENT REAL PRODUCT, since the expansion of a misread is still a
   * legitimate GTIN.
   */
  it('rejects a framed UPC-E whose scanned check digit disagrees', () => {
    expect(normaliseBarcode(FRAMED, 'upc_e')).not.toBeNull();

    // Same payload, every OTHER check digit. All nine must be refused — a loop
    // rather than one bad digit, because a guard that happens to reject one
    // value is not the same as one that accepts exactly the right value.
    for (let d = 0; d <= 9; d += 1) {
      const candidate = `0${PAYLOAD}${d}`;
      if (candidate === FRAMED) continue;
      expect(normaliseBarcode(candidate, 'upc_e')).toBeNull();
    }
  });

  /**
   * The 6-digit payload has no check digit to verify, so it cannot be
   * protected against a misread at all. Scanners emit the framed form;
   * accepting the bare payload was speculative generosity that cost the guard.
   */
  it('refuses the unverifiable 6-digit payload at the entry point', () => {
    expect(normaliseBarcode('123450', 'upc_e')).toBeNull();
    // The pure expansion still accepts it — it is a published algorithm and is
    // tested above. It is the ENTRY POINT that must not take an unverifiable
    // code.
    expect(expandUpcE('123450')).toBe('012000003455');
  });
});

describe('the check digit is verified as SCANNED, never as recomputed', () => {
  /**
   * The second instance of the same mistake. The ITF-14 path sliced off the
   * indicator digit and recomputed the check for what remained, so the guard
   * beneath it was again true by construction and a misread carton reached the
   * network. Found in review, alongside the UPC-E one.
   */
  it('rejects an ITF-14 whose own check digit disagrees', () => {
    const unit = '5000112637922';
    const partial = `1${unit.slice(0, 12)}`;
    const carton = `${partial}${checkDigit(partial)}`;
    expect(normaliseBarcode(carton, 'itf14')).toBe(unit);

    for (let d = 0; d <= 9; d += 1) {
      const candidate = `${partial}${d}`;
      if (candidate === carton) continue;
      expect(normaliseBarcode(candidate, 'itf14')).toBeNull();
    }
  });

  /**
   * Eight digits is EAN-8 or UPC-E and the string alone cannot say which, so
   * the scanner's own answer decides. Without this the module guessed — and
   * the guess is what made the vacuous UPC-E check reachable for every 8-digit
   * code beginning 0 or 1.
   */
  it('dispatches on the symbology the scanner reported', () => {
    const ean8 = '96385074';
    expect(normaliseBarcode(ean8, 'ean8')).toBe('0000096385074');
    // The same eight digits read as UPC-E are a different product entirely,
    // and here they do not verify as one.
    expect(normaliseBarcode(ean8, 'upc_e')).toBeNull();
  });

  it('still works when no symbology is supplied, falling back to length', () => {
    expect(normaliseBarcode('4006381333931')).toBe('4006381333931');
    expect(normaliseBarcode('036000291452')).toBe('0036000291452');
    expect(normaliseBarcode('96385074')).toBe('0000096385074');
  });
});

describe('FOOD_BARCODE_TYPES', () => {
  /**
   * A QR code on a cereal box points at a marketing site. Scanning for it
   * would produce a confident-looking read that resolves to nothing, which is
   * indistinguishable to the athlete from a missing product.
   */
  it('excludes symbologies that are never a food GTIN', () => {
    expect(FOOD_BARCODE_TYPES).not.toContain('qr');
    expect(FOOD_BARCODE_TYPES).not.toContain('code128');
    expect(FOOD_BARCODE_TYPES).not.toContain('pdf417');
  });

  it('covers the four GTIN symbologies plus the carton code', () => {
    expect([...FOOD_BARCODE_TYPES].sort()).toEqual(
      ['ean13', 'ean8', 'itf14', 'upc_a', 'upc_e'].sort(),
    );
  });
});
