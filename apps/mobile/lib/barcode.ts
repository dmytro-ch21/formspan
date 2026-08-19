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
 * Expand a compressed UPC-E payload to its full UPC-A twelve digits.
 *
 * UPC-E is the short code on things too small for a full barcode — a soda can,
 * a chocolate bar — so on a US-first product set this is not an exotic case.
 * The compression is a published, fully deterministic rule keyed on the LAST
 * digit of the six-digit payload; there is nothing to guess.
 *
 * Accepts the six-digit payload or the eight-digit framed form (number system
 * + payload + check digit). **The returned check digit is COMPUTED, never the
 * one that was scanned** — which is why callers must not then "verify" the
 * result and think they have checked anything. `normaliseBarcode` compares the
 * computed digit against the scanned one instead; see the note there.
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
 * which is what makes this identical for EAN-8, UPC-A, EAN-13 and ITF-14
 * rather than four near-copies.
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
 * Which symbology a scanned string is, preferring what the SCANNER said.
 *
 * The scanner knows; length does not. Eight digits is EAN-8 *or* UPC-E and
 * nothing about the string settles it — the previous version of this module
 * guessed, and guessing is what let a misread through (see `normaliseBarcode`).
 * `type` comes straight from expo-camera's `BarcodeScanningResult`.
 *
 * Falls back to length only when the caller has no type to give, which is the
 * test harness and nothing else on a device.
 */
function symbology(code: string, type?: string): 'upc_e' | 'itf14' | 'gtin' | null {
  switch (type) {
    case 'upc_e':
      return 'upc_e';
    case 'itf14':
      return 'itf14';
    case 'ean13':
    case 'ean8':
    case 'upc_a':
      return 'gtin';
    default:
      break;
  }
  if (code.length === 14) return 'itf14';
  if (code.length === 8 || code.length === 12 || code.length === 13) return 'gtin';
  return null;
}

/**
 * The one form a lookup is made in: a 13-digit GTIN, or null if this was never
 * a food barcode.
 *
 * - **UPC-A (12)** gains the leading zero that the printed code leaves implied.
 *   This is the whole US/EU difference and the reason this function exists.
 * - **EAN-8 (8)** is zero-padded to 13. Leading zeros contribute nothing to the
 *   weighted sum and do not shift any existing digit's position from the right,
 *   so padding provably preserves the check digit rather than merely seeming to.
 * - **ITF-14 (14)** drops its leading packaging-level digit and is re-checked,
 *   so a multipack carton resolves to the unit inside it.
 * - **UPC-E** is expanded, then handled as UPC-A.
 *
 * ## Every path verifies the check digit AS SCANNED, before transforming
 *
 * This is the correctness rule of the whole module, and the first version of it
 * got this wrong in two places in the same way. `expandUpcE` and the ITF-14
 * reduction both **compute** a fresh check digit, so calling
 * `hasValidCheckDigit` on their OUTPUT is true by construction — it verifies a
 * digit we just derived and tells you nothing about what the camera read. Both
 * looked like guards and neither was one, and no test could see it because
 * every vector written for them was valid.
 *
 * The consequence was the exact failure this feature exists to avoid: a garbled
 * 8-digit read expands to a *syntactically perfect* UPC-A, gets looked up, and
 * comes back as "we do not have this one" — a false statement about the
 * catalog — or, worse, as a different real product. Found in review.
 *
 * So a misread returns null and never reaches the network: for UPC-E the
 * computed digit is compared against the **scanned** one, and ITF-14 is checked
 * before its indicator is removed.
 */
export function normaliseBarcode(raw: string, type?: string): string | null {
  const code = raw.trim();
  if (!isDigits(code)) return null;

  switch (symbology(code, type)) {
    case 'upc_e': {
      // The 8-digit framed form ONLY. The 6-digit payload carries no check
      // digit at all, so it cannot be verified — and accepting an unverifiable
      // code is exactly the hole above. Scanners emit the framed form; the bare
      // payload was speculative generosity that cost the guard.
      if (code.length !== 8) return null;
      const expanded = expandUpcE(code);
      if (!expanded) return null;
      // THE check. `expanded`'s last digit was computed from the payload; this
      // asks whether it agrees with what the camera actually read.
      if (expanded[expanded.length - 1] !== code[7]) return null;
      return `0${expanded}`;
    }

    case 'itf14': {
      if (code.length !== 14 || !hasValidCheckDigit(code)) return null;
      // Drop the packaging indicator, then restore a correct check digit for
      // the 13-digit code that remains — the carton's own is not the unit's.
      const body = code.slice(1, 13);
      return `${body}${checkDigit(body)}`;
    }

    case 'gtin': {
      if (code.length !== 8 && code.length !== 12 && code.length !== 13) return null;
      if (!hasValidCheckDigit(code)) return null;
      return code.padStart(13, '0');
    }

    default:
      return null;
  }
}
