import { useEffect } from 'react';
import { act, configure, fireEvent, render, screen, waitFor } from '@testing-library/react-native';

import DescribeMealScreen from '../food/describe';

/**
 * The photo path on the describe screen — the one an athlete reaches by
 * tapping "Photograph the label" on the unknown-barcode screen, and the one
 * N92 (#433) was reported against.
 *
 * Two properties, and neither is "the manipulator was called":
 *
 *   - **The downscaled uri is what reaches the wire.** A call-count assertion
 *     passes against a screen that shrinks the frame and then uploads the
 *     original anyway, which is the whole 4–12MB failure N73 was. The only
 *     assertion that can see that is one on the uri handed to
 *     `photographMeal`.
 *   - **A local failure is never reported as a network failure.** Everything
 *     up to the request — opening the camera, re-encoding the frame — happens
 *     on the phone with the radio idle, so any message about signal there is
 *     false by construction. `identify.tsx` guards this and `describe.tsx` did
 *     not, which is the same bug in the second path.
 *
 * Deliberately NOT re-asserting N26's estimate/confirm flow or N41's barcode
 * learning; `describeBarcode.test.tsx` owns the latter and two files with
 * opinions about one rule is how they end up disagreeing.
 */

/** See describeBarcode.test.tsx — jest hoists factories above the imports. */
const mockUseEffect = useEffect;

jest.setTimeout(30_000);
configure({ asyncUtilTimeout: 10_000 });

const mockPhotograph = jest.fn();
jest.mock('@/lib/estimateApi', () => {
  const real = jest.requireActual('@/lib/estimateApi');
  return {
    ...real,
    describeMeal: jest.fn(),
    photographMeal: (...a: unknown[]) => mockPhotograph(...a),
  };
});

jest.mock('@/lib/barcodeCache', () => ({
  rememberBarcode: jest.fn(),
  cachedBarcode: jest.fn(),
}));
jest.mock('@/lib/foodLog', () => ({ logFood: jest.fn() }));
jest.mock('@/lib/sync', () => ({ request: jest.fn() }));

const mockLaunchCamera = jest.fn();
const mockPermission = jest.fn();
jest.mock('expo-image-picker', () => ({
  requestCameraPermissionsAsync: (...a: unknown[]) => mockPermission(...a),
  requestMediaLibraryPermissionsAsync: (...a: unknown[]) => mockPermission(...a),
  launchCameraAsync: (...a: unknown[]) => mockLaunchCamera(...a),
  launchImageLibraryAsync: (...a: unknown[]) => mockLaunchCamera(...a),
}));

const mockManipulate = jest.fn();
jest.mock('expo-image-manipulator', () => ({
  SaveFormat: { JPEG: 'jpeg' },
  manipulateAsync: (...a: unknown[]) => mockManipulate(...a),
}));

jest.mock('expo-router', () => ({
  __esModule: true,
  useFocusEffect: (cb: () => void) => mockUseEffect(() => cb(), [cb]),
  useLocalSearchParams: () => ({ meal: 'lunch', date: '2026-08-20' }),
  useRouter: () => ({ push: jest.fn(), back: jest.fn(), replace: jest.fn() }),
  Stack: { Screen: () => null },
}));

/** The 48MP frame straight off the camera, before any re-encode. */
const RAW_URI = 'file:///camera/IMG_4821_48mp.heic';
/** What the manipulator writes out at 1080px — the ONLY thing that may be sent. */
const SHRUNK_URI = 'file:///cache/ImageManipulator/shrunk-1080.jpg';

const draft = {
  estimate: {
    items: [
      {
        name: 'Protein bar',
        serving_label: '1 bar',
        servings: 1,
        portion_confidence: 'high',
        assumption: '',
        kcal: 200,
        protein_g: 20,
        carb_g: 20,
        fat_g: 6,
        fibre_g: 3,
      },
    ],
    note: '',
    model: 'test',
    source: 'photo',
  },
  quota: { used: 1, limit: 25, remaining: 24, resets_at: null },
};

/** Copy that claims something about the network. None of it may appear on a
 *  failure that never touched the network. */
const NETWORK_WORDS = [/signal/i, /connection/i, /offline/i, /reach/i];

async function tapCamera() {
  render(<DescribeMealScreen />);
  await act(async () => {
    fireEvent.press(screen.getByTestId('describe-camera'));
  });
}

beforeEach(() => {
  mockPhotograph.mockReset().mockResolvedValue(draft);
  mockPermission.mockReset().mockResolvedValue({ granted: true });
  mockLaunchCamera.mockReset().mockResolvedValue({ canceled: false, assets: [{ uri: RAW_URI }] });
  mockManipulate.mockReset().mockResolvedValue({ uri: SHRUNK_URI, width: 1080, height: 1440 });
});

it('uploads the DOWNSCALED frame, not the one the camera returned', async () => {
  await tapCamera();

  await waitFor(() => expect(mockPhotograph).toHaveBeenCalledTimes(1));

  const [, input] = mockPhotograph.mock.calls[0] as [unknown, { uri: string; mimeType: string }];
  // THE assertion. `expect(mockManipulate).toHaveBeenCalled()` would pass
  // against a screen that shrinks the frame and then uploads `picked.uri`
  // anyway — a mutation that was applied on #361 and caught by nothing else.
  expect(input.uri).toBe(SHRUNK_URI);
  expect(input.uri).not.toBe(RAW_URI);
  // The manipulator re-encodes to JPEG, so the asset's own type is no longer
  // what is on the wire. A stale `image/heic` here is refused by the vision
  // API at our expense rather than the caller's.
  expect(input.mimeType).toBe('image/jpeg');
});

it('asks for 1080px, which is what keeps the body under the endpoint cap', async () => {
  await tapCamera();
  await waitFor(() => expect(mockManipulate).toHaveBeenCalledTimes(1));

  const [uri, actions] = mockManipulate.mock.calls[0] as [string, { resize: { width: number } }[]];
  expect(uri).toBe(RAW_URI);
  expect(actions).toEqual([{ resize: { width: 1080 } }]);
});

it('does not blame the network when the frame cannot be re-encoded', async () => {
  // N92's mobile half. The radio is idle at this point — nothing has been
  // sent — so "try again when you have signal" is false by construction. It
  // was what the screen said, because the outer handler fed a message-less
  // failure to `messageFor`'s fallback.
  mockManipulate.mockRejectedValue(new Error(''));

  await tapCamera();

  const shown = await screen.findByTestId('describe-error');
  for (const word of NETWORK_WORDS) {
    expect(shown.props.children).not.toMatch(word);
  }
  expect(shown.props.children).toMatch(/photo could not be read/i);
  // And nothing was uploaded, which is the other half of "this never touched
  // the network".
  expect(mockPhotograph).not.toHaveBeenCalled();
});

it('shows the server its own words when the server answered', async () => {
  // A 503, a 429 and a 422 all arrive as an ApiError carrying copy written
  // for this screen. Rendering our own sentence over it is how a quota
  // exhaustion and a provider outage became one indistinguishable message.
  mockPhotograph.mockRejectedValue(
    new Error('you have used all 25 estimates for today — one more in about 3 hours'),
  );

  await tapCamera();

  const shown = await screen.findByTestId('describe-error');
  expect(shown.props.children).toMatch(/all 25 estimates/);
});

it('does not blame the network for a failure carrying no message', async () => {
  // The fallback branch. It fires precisely when we know NOTHING about what
  // went wrong — which is the worst possible moment to assert a specific
  // cause, and it used to assert the one an athlete cannot act on.
  mockPhotograph.mockRejectedValue(new Error(''));

  await tapCamera();

  const shown = await screen.findByTestId('describe-error');
  for (const word of NETWORK_WORDS) {
    expect(shown.props.children).not.toMatch(word);
  }
});
