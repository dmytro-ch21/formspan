import { useEffect } from 'react';
import { act, configure, fireEvent, render, screen, waitFor } from '@testing-library/react-native';

import {
  ApiError,
  OfflineError,
  RequestDroppedError,
  TimeoutError,
} from '@/lib/apiError';

import ScanBarcodeScreen from '../../app/food/scan';

/**
 * The barcode scan screen.
 *
 * The camera itself cannot be driven here — a Simulator has no camera and jest
 * has no native module — so what is pinned is everything AROUND the camera,
 * which is where this feature can be wrong without anyone noticing:
 *
 *   - a scan must PROPOSE and never log. N26's rule, inherited whole.
 *   - "we do not have this one" and "I could not ask" must never render as
 *     each other. Absence reading as an answer is a failure this repo has hit
 *     repeatedly, and here the false version is a statement about the catalog
 *     caused by bad signal.
 *   - a misread packet must not reach the network at all, because a lookup on
 *     a misread comes back as an ordinary miss and gets reported as one.
 *   - an AI-drafted food resolving from the cache must still say its numbers
 *     were drafted. N40 measured what an unlabelled estimate is worth.
 */

/**
 * `useEffect`, captured for the `expo-router` mock below.
 *
 * A `mock`-prefixed binding rather than a `require('react')` inside the
 * factory: jest hoists `jest.mock` above the imports, so a factory may only
 * close over names it can prove are safe, and `mock*` is the prefix
 * babel-plugin-jest-hoist exempts. `require()` in a factory works but trips
 * `@typescript-eslint/no-require-imports`, and this app's lint gate is a
 * warning RATCHET — a new warning fails the build rather than being absorbed.
 */
const mockUseEffect = useEffect;

jest.setTimeout(30_000);
configure({ asyncUtilTimeout: 10_000 });

/**
 * The camera, reduced to the one thing a test can use: its scan callback.
 *
 * Captured into a module variable rather than fired from a rendered control,
 * because what is being simulated is the CAMERA DECODING A FRAME, not a tap.
 * Modelling it as a press would quietly test a button that does not exist.
 */
let mockScan: ((r: { data: string }) => void) | null = null;
let mockPermission: { granted: boolean; canAskAgain: boolean } | null = {
  granted: true,
  canAskAgain: true,
};
const mockRequestPermission = jest.fn();

jest.mock('expo-camera', () => ({
  CameraView: (props: { onBarcodeScanned?: (r: { data: string }) => void }) => {
    mockScan = props.onBarcodeScanned ?? null;
    return null;
  },
  useCameraPermissions: () => [mockPermission, mockRequestPermission],
}));

const mockLookup = jest.fn();
jest.mock('@/lib/barcodeApi', () => ({
  lookupBarcode: (...a: unknown[]) => mockLookup(...a),
}));

const mockCached = jest.fn();
const mockRemember = jest.fn();
jest.mock('@/lib/barcodeCache', () => ({
  cachedBarcode: (...a: unknown[]) => mockCached(...a),
  rememberBarcode: (...a: unknown[]) => mockRemember(...a),
}));

const mockLogFood = jest.fn();
jest.mock('@/lib/foodLog', () => ({ logFood: (...a: unknown[]) => mockLogFood(...a) }));

const mockReplace = jest.fn();
const mockBack = jest.fn();
jest.mock('expo-router', () => ({
  __esModule: true,
  // `KeyboardAwareScrollView` uses this. Keyed on the callback, matching the
  // shared setup's mock — pinned to `[]` it would render a container that can
  // never re-measure.
  useFocusEffect: (cb: () => void) => mockUseEffect(() => cb(), [cb]),
  useLocalSearchParams: () => ({ meal: 'lunch', date: '2026-08-19' }),
  useRouter: () => ({ push: jest.fn(), back: mockBack, replace: mockReplace }),
  Stack: { Screen: () => null },
}));

jest.mock('@/lib/sync', () => ({ request: jest.fn() }));

const OATS = {
  name: 'Rolled oats',
  brand: 'Flahavans',
  serving_label: '40 g',
  serving_grams: 40,
  kcal: 150,
  protein_g: 5,
  carb_g: 26,
  fat_g: 3,
  fibre_g: 4,
};

/** A real GTIN, so `normaliseBarcode` lets it through. */
const CODE = '4006381333931';

beforeEach(() => {
  mockScan = null;
  mockPermission = { granted: true, canAskAgain: true };
  mockRequestPermission.mockReset();
  mockLookup.mockReset();
  mockCached.mockReset().mockResolvedValue(null);
  mockRemember.mockReset().mockResolvedValue(undefined);
  mockLogFood.mockReset().mockResolvedValue('entry-1');
  mockReplace.mockReset();
  mockBack.mockReset();
});

async function scan(code = CODE) {
  render(<ScanBarcodeScreen />);
  await waitFor(() => expect(mockScan).not.toBeNull());
  await act(async () => {
    mockScan!({ data: code });
  });
}

/**
 * N426: the amount editor lives in a sheet, not an always-visible field —
 * "Amount" on the card is a tap target that opens it, and the field/portion
 * chips/servings-fallback control mount only once the sheet is open. Every
 * test below that reads or types into that control opens the sheet first.
 */
async function openAmountSheet() {
  await waitFor(() => expect(screen.getByTestId('scan-amount-row')).toBeTruthy());
  fireEvent.press(screen.getByTestId('scan-amount-row'));
}

describe('a resolved barcode', () => {
  beforeEach(() => mockLookup.mockResolvedValue({ status: 'found', food: OATS, source: 'off' }));

  /**
   * The rule this feature inherits from N26, and the single most important
   * assertion in the file. Delete the draft phase so a scan logs directly and
   * this goes red.
   */
  it('proposes an entry and logs nothing until it is confirmed', async () => {
    await scan();
    await waitFor(() => expect(screen.getByTestId('scan-name')).toBeTruthy());
    // N426: name and brand render as ONE line now (`displayName`), matching
    // the reference screenshot's single title bar rather than two lines.
    expect(screen.getByTestId('scan-name')).toHaveTextContent('Flahavans Rolled oats');
    expect(mockLogFood).not.toHaveBeenCalled();
  });

  /**
   * N117: the amount field is GRAMS now, not a bare "servings" multiplier —
   * OATS' basis is 40 g (`serving_grams: 40`), so typing "80" is the same
   * two servings the old test typed directly, and proves the grams-to-
   * servings arithmetic (`servingsForGrams`) still lands on the same number
   * a reader of `nutrition_entries.servings` has always expected.
   */
  it('logs the scaled figures once confirmed', async () => {
    await scan();
    await openAmountSheet();
    await waitFor(() => expect(screen.getByTestId('food-quantity-input')).toBeTruthy());
    fireEvent.changeText(screen.getByTestId('food-quantity-input'), '80');
    await act(async () => {
      fireEvent.press(screen.getByTestId('scan-log'));
    });
    expect(mockLogFood).toHaveBeenCalledTimes(1);
    const entry = mockLogFood.mock.calls[0][1];
    expect(entry.servings).toBe(2);
    expect(entry.kcal).toBe(300);
    expect(entry.protein_g).toBe(10);
    expect(entry.meal).toBe('lunch');
    expect(entry.eaten_on).toBe('2026-08-19');
    // A scanned product is not one of the athlete's own saved foods, so the
    // provenance FK must stay null rather than pointing at a cache row.
    expect(entry.source_food_id).toBeNull();
  });

  /**
   * N426, found in review: the sheet is a `Modal`, which UNMOUNTS its
   * children while closed rather than merely hiding them — so without
   * `initialGrams` seeding a remount from the current amount, closing the
   * sheet after typing a number and reopening it silently reset back to
   * the packet default. Concretely: type 80, tap Done (the card correctly
   * showed "80 g" — screen and log stayed in sync so nothing looked wrong
   * from the outside), tap Amount again — the field would show "40" (the
   * packet default) rather than resuming at "80".
   */
  it('resumes the typed amount when the sheet is reopened, rather than resetting it', async () => {
    await scan();
    await openAmountSheet();
    await waitFor(() => expect(screen.getByTestId('food-quantity-input')).toBeTruthy());
    fireEvent.changeText(screen.getByTestId('food-quantity-input'), '80');
    await act(async () => {
      fireEvent.press(screen.getByTestId('amount-sheet-done'));
    });
    expect(screen.getByTestId('scan-amount-value')).toHaveTextContent('80 g');

    await openAmountSheet();
    await waitFor(() => expect(screen.getByTestId('food-quantity-input')).toBeTruthy());
    // 80, not OATS' 40 g default — the sheet RESUMED, it did not reset.
    expect(screen.getByTestId('food-quantity-input').props.value).toBe('80');
  });

  /**
   * A fractional amount must survive to what gets logged, not round or
   * truncate to a whole number. Typed as two separate keystrokes ("6" then
   * "60", each a complete `fireEvent.changeText` value rather than a
   * concatenation) to match how the field is actually driven — the old
   * `scan-servings` version of this test pinned the equivalent property
   * (`"1."` then `"1.5"`) against `parseOr`; `parseQuantity`
   * (`lib/foodQuantity.ts`) is the control that replaced it (N117).
   */
  it('keeps a half serving a half rather than rounding it away', async () => {
    await scan();
    await openAmountSheet();
    await waitFor(() => expect(screen.getByTestId('food-quantity-input')).toBeTruthy());
    fireEvent.changeText(screen.getByTestId('food-quantity-input'), '6');
    fireEvent.changeText(screen.getByTestId('food-quantity-input'), '60');
    await act(async () => {
      fireEvent.press(screen.getByTestId('scan-log'));
    });
    // 60 g / 40 g basis = 1.5 servings.
    expect(mockLogFood.mock.calls[0][1].servings).toBe(1.5);
  });

  it('caches what it resolved so the next scan works offline', async () => {
    await scan();
    await waitFor(() => expect(mockRemember).toHaveBeenCalled());
    expect(mockRemember).toHaveBeenCalledWith('u1', CODE, OATS, 'off');
  });

  /**
   * N117 (#506) — reported from a device: scanning a Kinder bar showed
   * "Per 100 g", 560 kcal, with a bare "Servings" field defaulting to 1 —
   * matching the box (140 kcal for its own stated "2 Pieces (25g)") needed
   * computing 25/100 by hand first. This is that exact product, and the
   * screen must now open ALREADY matching the box.
   */
  describe('a food with the packet’s own serving stated', () => {
    const KINDER = {
      name: 'Kinder Chocolate',
      brand: 'Kinder',
      serving_label: '100 g',
      serving_grams: 100,
      packet_serving_label: '2 pieces (25 g)',
      packet_serving_grams: 25,
      kcal: 560,
      protein_g: 2,
      carb_g: 52,
      fat_g: 36,
      fibre_g: 0,
    };

    beforeEach(() => mockLookup.mockResolvedValue({ status: 'found', food: KINDER, source: 'off' }));

    /**
     * N426: the headline "Amount" row must show the packet's own serving on
     * FIRST LOOK — before the athlete has ever tapped it open — which is the
     * reference screenshot's whole point ("Amount: 2 Pieces" pre-filled).
     */
    it('shows the packet’s own serving on the Amount row before the sheet is ever opened', async () => {
      await scan();
      await waitFor(() => expect(screen.getByTestId('scan-amount-value')).toBeTruthy());
      expect(screen.getByTestId('scan-amount-value')).toHaveTextContent('2 pieces (25 g)');
      // The nutrition grid already reflects that default too, not a bare summary line.
      expect(screen.getByTestId('nutrition-panel-kcal')).toHaveTextContent('140');
      expect(screen.getByTestId('nutrition-panel-protein_g-value')).toHaveTextContent('0.5g');
    });

    it('opens the amount pre-filled to the packet’s own serving, not 100 g', async () => {
      await scan();
      await openAmountSheet();
      await waitFor(() => expect(screen.getByTestId('food-quantity-input')).toBeTruthy());
      // The default amount is 25 g (the packet's own), not 100 g.
      expect(screen.getByTestId('food-quantity-input').props.value).toBe('25');
      // The unchanged arithmetic basis still reads "Per 100 g" — checkable.
      expect(screen.getByText('Per 100 g')).toBeTruthy();
      // The packet's own serving offered as a selectable, already-selected chip.
      expect(screen.getByTestId('food-portion-25')).toBeTruthy();
    });

    it('logs the box’s own numbers when confirmed without touching the amount', async () => {
      await scan();
      await waitFor(() => expect(screen.getByTestId('scan-log')).toBeTruthy());
      await act(async () => {
        fireEvent.press(screen.getByTestId('scan-log'));
      });
      const entry = mockLogFood.mock.calls[0][1];
      // 140 kcal / 2 g protein — what the box says, not 560 / 2.
      expect(entry.kcal).toBe(140);
      expect(entry.protein_g).toBe(0.5);
      expect(entry.servings).toBe(0.25);
    });
  });

  it('normalises a UPC-A before looking it up', async () => {
    await scan('036000291452');
    await waitFor(() => expect(mockLookup).toHaveBeenCalled());
    // The 13-digit form, not the twelve the scanner read.
    expect(mockLookup.mock.calls[0][1]).toBe('0036000291452');
  });
});

describe('a barcode the catalog does not have', () => {
  beforeEach(() => mockLookup.mockResolvedValue({ status: 'unknown', code: CODE }));

  it('says so, names the digits, and offers the describe path', async () => {
    await scan();
    await waitFor(() => expect(screen.getByTestId('scan-unknown')).toBeTruthy());
    expect(screen.getByTestId('scan-unknown')).toHaveTextContent(/have this one/i);
    // The digits, so a missing product is distinguishable from a misread one.
    expect(screen.getByTestId('scan-unknown-detail')).toHaveTextContent(new RegExp(CODE));
    expect(screen.getByTestId('scan-unknown-describe')).toBeTruthy();
  });

  /**
   * The barcode is carried through, which is what lets the confirmed draft
   * teach this phone the packet.
   */
  it('hands the barcode to the describe screen', async () => {
    await scan();
    await waitFor(() => expect(screen.getByTestId('scan-unknown-describe')).toBeTruthy());
    fireEvent.press(screen.getByTestId('scan-unknown-describe'));
    expect(mockReplace).toHaveBeenCalledWith(expect.stringContaining(`barcode=${CODE}`));
  });
});

describe('a lookup that could not be made', () => {
  beforeEach(() => mockLookup.mockRejectedValue(new Error('Network request failed')));

  /**
   * The distinction the feature rests on. Collapse `unreachable` into
   * `unknown` and this goes red while every other test here stays green.
   */
  it('does NOT claim the catalog lacks the food', async () => {
    await scan();
    await waitFor(() => expect(screen.getByTestId('scan-unreachable')).toBeTruthy());
    expect(screen.queryByTestId('scan-unknown')).toBeNull();
    expect(screen.getByTestId('scan-unreachable')).toHaveTextContent(/check this one/i);
  });

  /**
   * And it must NOT offer to cache a guess against this barcode, because the
   * catalog may well hold the real product — an AI draft cached here would
   * shadow it on this phone permanently.
   */
  it('does not carry the barcode into the describe path', async () => {
    await scan();
    await waitFor(() => expect(screen.getByTestId('scan-unreachable-describe')).toBeTruthy());
    fireEvent.press(screen.getByTestId('scan-unreachable-describe'));
    expect(mockReplace).toHaveBeenCalledWith(expect.not.stringContaining('barcode='));
  });
});

describe('a code that did not read cleanly', () => {
  /**
   * A creased packet fails its own check digit routinely. Looking one up would
   * come back as an ordinary miss and be reported as "we do not have this
   * one" — a false statement about the catalog caused by a bad scan.
   */
  it('never reaches the network', async () => {
    await scan('4006381333932'); // valid length, wrong check digit
    expect(mockLookup).not.toHaveBeenCalled();
    expect(screen.getByTestId('scan-hint')).toHaveTextContent(/read cleanly/i);
  });
});

describe('the local cache', () => {
  it('resolves without asking the network at all', async () => {
    mockCached.mockResolvedValue({ food: OATS, source: 'off' });
    await scan();
    await waitFor(() => expect(screen.getByTestId('scan-name')).toBeTruthy());
    expect(mockLookup).not.toHaveBeenCalled();
    expect(screen.getByTestId('scan-provenance')).toHaveTextContent(/works offline/i);
  });

  /**
   * A food the athlete described, cached against a barcode, must keep saying
   * its numbers were drafted. Reporting it as merely "cached" would launder a
   * guess into a scan, in the one screen built on the premise that a barcode's
   * numbers are facts.
   */
  it('still says an AI-drafted food was drafted', async () => {
    mockCached.mockResolvedValue({ food: OATS, source: 'ai' });
    await scan();
    await waitFor(() => expect(screen.getByTestId('scan-provenance')).toBeTruthy());
    expect(screen.getByTestId('scan-provenance')).toHaveTextContent(/not read off the packet/i);
  });

  /**
   * Found in review, not in the original report: `describe.tsx` caches an
   * AI-drafted food against a barcode with `serving_grams: null` — a
   * described "1 egg" has no honest gram weight. Routing that food through
   * the grams-based `FoodQuantity` control would silently invent a 100 g
   * basis it never stated, which is exactly the fabricated-basis bug N117's
   * own acceptance criteria forbid, and a REGRESSION against this screen's
   * pre-N117 behaviour, which was basis-agnostic (a bare "servings" count).
   */
  describe('a food with no honest gram weight', () => {
    const EGG = {
      name: 'A large egg',
      brand: '',
      serving_label: '1 egg',
      serving_grams: null,
      packet_serving_label: null,
      packet_serving_grams: null,
      kcal: 78,
      protein_g: 6,
      carb_g: 0.6,
      fat_g: 5,
      fibre_g: 0,
    };

    beforeEach(() => mockCached.mockResolvedValue({ food: EGG, source: 'ai' }));

    it('offers a servings count, never a fabricated grams field', async () => {
      await scan();
      await openAmountSheet();
      await waitFor(() => expect(screen.getByTestId('scan-servings-fallback')).toBeTruthy());
      expect(screen.queryByTestId('food-quantity-input')).toBeNull();
      // States what the number is per, same as the grams path.
      expect(screen.getByText('Per 1 egg')).toBeTruthy();
    });

    /** N426: the Amount row itself must not fabricate a gram figure either. */
    it('shows the servings count on the Amount row, never a gram figure', async () => {
      await scan();
      await waitFor(() => expect(screen.getByTestId('scan-amount-value')).toBeTruthy());
      expect(screen.getByTestId('scan-amount-value')).toHaveTextContent('1 × 1 egg');
    });

    it('logs the food’s own numbers for the default 1 serving', async () => {
      await scan();
      await waitFor(() => expect(screen.getByTestId('scan-log')).toBeTruthy());
      await act(async () => {
        fireEvent.press(screen.getByTestId('scan-log'));
      });
      const entry = mockLogFood.mock.calls[0][1];
      expect(entry.kcal).toBe(78);
      expect(entry.protein_g).toBe(6);
      expect(entry.servings).toBe(1);
    });

    it('scales every macro when the servings count changes', async () => {
      await scan();
      await openAmountSheet();
      await waitFor(() => expect(screen.getByTestId('scan-servings-fallback')).toBeTruthy());
      fireEvent.changeText(screen.getByTestId('scan-servings-fallback'), '2');
      await act(async () => {
        fireEvent.press(screen.getByTestId('scan-log'));
      });
      const entry = mockLogFood.mock.calls[0][1];
      expect(entry.kcal).toBe(156);
      expect(entry.protein_g).toBe(12);
      expect(entry.servings).toBe(2);
    });

    /** N426: `ServingsFallback`'s half of the same resume-not-reset fix. */
    it('resumes the typed servings count when the sheet is reopened', async () => {
      await scan();
      await openAmountSheet();
      await waitFor(() => expect(screen.getByTestId('scan-servings-fallback')).toBeTruthy());
      fireEvent.changeText(screen.getByTestId('scan-servings-fallback'), '2');
      await act(async () => {
        fireEvent.press(screen.getByTestId('amount-sheet-done'));
      });
      expect(screen.getByTestId('scan-amount-value')).toHaveTextContent('2 × 1 egg');

      await openAmountSheet();
      await waitFor(() => expect(screen.getByTestId('scan-servings-fallback')).toBeTruthy());
      // 2, not the "1" default — resumed, not reset.
      expect(screen.getByTestId('scan-servings-fallback').props.value).toBe('2');
    });
  });
});

describe('camera permission', () => {
  it('explains why before asking, and offers a way past it', async () => {
    mockPermission = { granted: false, canAskAgain: true };
    render(<ScanBarcodeScreen />);
    expect(screen.getByTestId('scan-request-permission')).toBeTruthy();
    expect(screen.getByTestId('scan-permission-describe')).toBeTruthy();
    // No picture is taken, and the screen has to say so before the OS prompt.
    expect(screen.getByText(/nothing is uploaded/i)).toBeTruthy();
  });

  it('points at Settings once the prompt can no longer be shown', async () => {
    mockPermission = { granted: false, canAskAgain: false };
    render(<ScanBarcodeScreen />);
    expect(screen.queryByTestId('scan-request-permission')).toBeNull();
    expect(screen.getByText(/Settings/)).toBeTruthy();
  });
});

describe('a server without the barcode route', () => {
  /**
   * Was the guaranteed experience until N42 (#319) shipped the endpoint; now
   * it is VERSION SKEW, which is a permanent condition rather than a temporary
   * one — an installed mobile build updates on the App Store's schedule, so a
   * phone can outrun the deployed API by weeks. An unrouted path 404s with no
   * error envelope, so `apiRequest` fills the code with `unknown`: it must not
   * read as a missing product, and it must not show a raw
   * "Request failed (404)." to somebody holding a packet.
   */
  it('explains itself rather than blaming the catalog', async () => {
    mockLookup.mockRejectedValue(new ApiError('Request failed (404).', 'unknown', 404));
    await scan();
    await waitFor(() => expect(screen.getByTestId('scan-unreachable')).toBeTruthy());
    expect(screen.queryByTestId('scan-unknown')).toBeNull();
    expect(screen.getByText(/does not have barcode lookup/i)).toBeTruthy();
  });
});

/**
 * The taxonomy N55 put at the transport, seen from the screen that degrades to
 * a local cache.
 *
 * This screen tested `isOffline` alone. Once a timeout and a dropped connection
 * stopped being `OfflineError`, those two fell through to the raw message and
 * lost the one thing this screen knows that the transport does not — that a
 * barcode already scanned on this phone still resolves.
 */
describe('a lookup that never got an answer', () => {
  const dead = [
    ['no route to the API', new OfflineError()],
    ['a timeout', new TimeoutError()],
    ['a dropped connection', new RequestDroppedError()],
  ] as const;

  it.each(dead)('offers the local cache on %s, not just the offline case', async (_l, err) => {
    mockLookup.mockRejectedValue(err);
    await scan();
    await waitFor(() => expect(screen.getByTestId('scan-unreachable')).toBeTruthy());
    // The screen's own knowledge, which is what the transport cannot supply.
    expect(screen.getByText(/scanned on this phone before still works/i)).toBeTruthy();
    // And the diagnosis, so the three do not read alike.
    expect(screen.getByText(new RegExp(escapeRe(err.diagnosis), 'i'))).toBeTruthy();
  });

  it('never shows a raw transport message instead', async () => {
    // The regression: falling through to `err.message` drops the cache hint.
    mockLookup.mockRejectedValue(new TimeoutError());
    await scan();
    await waitFor(() => expect(screen.getByTestId('scan-unreachable')).toBeTruthy());
    expect(screen.queryByText(new TimeoutError().message)).toBeNull();
  });
});

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

describe('confirming twice', () => {
  /**
   * Two taps landing before React commits the re-render both read
   * `saving === false`, so a state guard leaks and the meal logs twice. This
   * screen already makes the same argument about `handling`; `confirming` is
   * the same fix one control further on. Raised in review.
   */
  it('logs once, not twice', async () => {
    mockLookup.mockResolvedValue({ status: 'found', food: OATS, source: 'off' });
    await scan();
    await waitFor(() => expect(screen.getByTestId('scan-log')).toBeTruthy());
    await act(async () => {
      fireEvent.press(screen.getByTestId('scan-log'));
      fireEvent.press(screen.getByTestId('scan-log'));
    });
    expect(mockLogFood).toHaveBeenCalledTimes(1);
  });
});

describe('a lookup that is taking too long', () => {
  /**
   * There is no request timeout beneath this screen, so on one bar the OS can
   * take tens of seconds to give up. A spinner with no exit is
   * indistinguishable from a hang.
   */
  it('offers a way out of the spinner', async () => {
    let release: (v: unknown) => void = () => {};
    mockLookup.mockReturnValue(new Promise((r) => { release = r; }));
    await scan();
    await waitFor(() => expect(screen.getByTestId('scan-looking-up')).toBeTruthy());

    fireEvent.press(screen.getByTestId('scan-cancel-lookup'));
    await waitFor(() => expect(screen.getByTestId('scan-hint')).toBeTruthy());
    expect(screen.queryByTestId('scan-looking-up')).toBeNull();
    release({ status: 'unknown', code: CODE });
  });
});

describe('a food from a provider this build does not know', () => {
  it('claims neither the VOLA catalog nor Open Food Facts', async () => {
    mockLookup.mockResolvedValue({ status: 'found', food: OATS, source: 'other' });
    await scan();
    await waitFor(() => expect(screen.getByTestId('scan-provenance')).toBeTruthy());
    const text = screen.getByTestId('scan-provenance');
    expect(text).toHaveTextContent(/outside food database/i);
    expect(text).not.toHaveTextContent(/VOLA food catalog/i);
    expect(text).not.toHaveTextContent(/Open Food Facts/i);
  });
});

describe('the shipped endpoint\'s unavailable code', () => {
  /**
   * 503 `unavailable` means the provider could not be reached. It is emphatically
   * not "we do not have this one", and the server's own message says so.
   */
  it('renders as could-not-ask', async () => {
    mockLookup.mockRejectedValue(
      new ApiError('could not reach the barcode provider — this is not the same as the food being unknown', 'unavailable', 503),
    );
    await scan();
    await waitFor(() => expect(screen.getByTestId('scan-unreachable')).toBeTruthy());
    expect(screen.queryByTestId('scan-unknown')).toBeNull();
    expect(screen.getByText(/not the same as the food being unknown/i)).toBeTruthy();
  });
});
