/**
 * The digits off a packet, turned into the one form a lookup can use.
 *
 * Pure arithmetic and no React, same split as `nutrition.ts` — every rule here
 * is testable without a camera, which matters because the camera is the one
 * part of this feature a test cannot drive.
 *
 * ## Why this file exists at all
 *
 * A scanner does not hand back "the barcode". It hands back whichever
 * symbology it happened to read, and the SAME box of cereal is `upc_a` in a US
 * shop and `ean13` in an EU one — twelve digits versus thirteen, differing by
 * a leading zero that is implied rather than printed. Open Food Facts keys on
 * the thirteen-digit form. So a lookup that passes the scanner's string
 * through unchanged finds the EU product and misses the US one, and the miss
 * is INVISIBLE: it comes back as an ordinary "we do not have this", which is
 * exactly the absence-reads-as-answer failure this feature is built to avoid.
 *
 * Normalising here means the screen's "we do not have this one" is about the
 * catalog rather than about which side of the Atlantic the packet was printed.
 */

/**
 * The symbologies worth scanning for on food.
 *
 * Deliberately NOT the full `BarcodeType` list. A QR code on a cereal box goes
 * to a marketing site, not to a product, and `code128` is a shelf label — both
 * would resolve to nothing while looking like a successful scan. Restricting
 * the scanner is what makes "nothing happened" mean "keep aiming" rather than
 * "we read a code and it meant nothing".
 *
 * `itf14` is the carton/case code. It is on multipacks an athlete really does
 * pick up, and it reduces to the unit EAN-13 by dropping its packaging digit —
 * see `normaliseBarcode`.
 */
export const FOOD_BARCODE_TYPES = ['ean13', 'ean8', 'upc_a', 'upc_e', 'itf14'] as const;

/** Digits only, and one of the lengths a food symbology actually produces. */
function isDigits(s: string): boolean {
  return s.length > 0 && /^[0-9]+$/.test(s);
}

/**
 * Expand a compressed UPC-E to its full UPC-A twelve digits.
 *
 * UPC-E is the short code on things too small for a full barcode — a soda can,
 * a chocolate bar — so on a US-first product set this is not an exotic case.
 * The compression is a published, fully deterministic rule keyed on the LAST
 * digit of the six-digit payload; there is nothing to guess.
 *
 * **It accepts both the six-digit payload and the eight-digit form** (number
 * system + payload + check digit), because the two platforms do not agree on
 * which one they hand back and this app cannot verify that from a test. Taking
 * either is what stops that disagreement becoming a silent lookup miss on one
 * platform only.
 *
 * Number system must be 0 or 1: UPC-E is not defined for any other, and a code
 * claiming otherwise is a misread rather than a product.
 */
export function expandUpcE(raw: string): string | null {
  if (!isDigits(raw)) return null;

  let system = '0';
  let payload: string;
  if (raw.length === 6) {
    payload = raw;
  } else if (raw.length === 8) {
    system = raw[0];
    payload = raw.slice(1, 7);
  } else {
    return null;
  }
  if (system !== '0' && system !== '1') return null;

  const d = payload.split('');
  const last = d[5];
  let body: string;
  switch (last) {
    // manufacturer = d0 d1 last, product = d2 d3 d4
    case '0':
    case '1':
    case '2':
      body = `${d[0]}${d[1]}${last}0000${d[2]}${d[3]}${d[4]}`;
      break;
    case '3':
      body = `${d[0]}${d[1]}${d[2]}00000${d[3]}${d[4]}`;
      break;
    case '4':
      body = `${d[0]}${d[1]}${d[2]}${d[3]}00000${d[4]}`;
      break;
    default:
      // 5-9: the last digit IS the final product digit.
      body = `${d[0]}${d[1]}${d[2]}${d[3]}${d[4]}0000${last}`;
      break;
  }
  const withSystem = `${system}${body}`;
  return `${withSystem}${checkDigit(withSystem)}`;
}

/**
 * The GTIN check digit for a code given WITHOUT it.
 *
 * Weights alternate 3 and 1 from the RIGHTMOST character of the partial code,
 * which is what makes this identical for EAN-8, UPC-A and EAN-13 rather than
 * three near-copies.
 */
export function checkDigit(partial: string): string {
  let sum = 0;
  for (let i = 0; i < partial.length; i += 1) {
    const digit = Number(partial[partial.length - 1 - i]);
    sum += i % 2 === 0 ? digit * 3 : digit;
  }
  return String((10 - (sum % 10)) % 10);
}

/** Does the code's own check digit agree with its digits? */
export function hasValidCheckDigit(code: string): boolean {
  if (!isDigits(code) || code.length < 8) return false;
  return checkDigit(code.slice(0, -1)) === code[code.length - 1];
}

/**
 * The one form a lookup is made in: a 13-digit GTIN, or null if this was never
 * a food barcode.
 *
 * - **UPC-A (12)** gains the leading zero that the printed code leaves implied.
 *   This is the whole US/EU difference and the reason this function exists.
 * - **EAN-8 (8)** is zero-padded to 13. It is a distinct, shorter allocation —
 *   padding is the canonical GTIN-13 widening, not a guess.
 * - **ITF-14 (14)** drops its leading packaging-level digit and is re-checked,
 *   so a multipack carton resolves to the unit inside it.
 * - **UPC-E** is expanded first, then handled as UPC-A.
 *
 * **The check digit is verified, and a failure returns null.** A misread is a
 * real outcome of pointing a camera at a curved or creased packet, and an
 * unverified misread would be looked up, missed, and reported to the athlete
 * as "we do not have this one" — telling them something false about the
 * catalog when the truth is that the scan was bad and they should try again.
 * Distinguishing those two is most of this feature's honesty.
 */
export function normaliseBarcode(raw: string): string | null {
  const trimmed = raw.trim();
  if (!isDigits(trimmed)) return null;

  let code = trimmed;

  // UPC-E first: its 8-digit form collides with EAN-8 on length alone, and the
  // two are told apart by the check digit, so try the expansion and keep it
  // only if it verifies.
  if (code.length === 6) {
    const expanded = expandUpcE(code);
    return expanded ? `0${expanded}` : null;
  }
  if (code.length === 8) {
    const expanded = expandUpcE(code);
    if (expanded && hasValidCheckDigit(expanded)) return `0${expanded}`;
  }

  if (code.length === 14) {
    // Drop the packaging indicator, then restore a correct check digit for the
    // 13-digit code that remains — the carton's own check digit is not the
    // unit's.
    const body = code.slice(1, 13);
    code = `${body}${checkDigit(body)}`;
  }

  if (code.length === 8) {
    code = code.padStart(13, '0');
  } else if (code.length === 12) {
    code = `0${code}`;
  }

  if (code.length !== 13) return null;
  return hasValidCheckDigit(code) ? code : null;
}
