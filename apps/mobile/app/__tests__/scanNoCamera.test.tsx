import { useEffect } from 'react';
import { render, screen } from '@testing-library/react-native';

/**
 * The scan screen on a binary whose native camera is missing.
 *
 * ## What this reproduces, and why it is a whole file of its own
 *
 * N91: "scanning a barcode closes the app instantly". The installed build had
 * `expo-camera` in `package.json` and in the JS bundle, and **not** in the iOS
 * project — measured, it was the one native dependency of twenty absent from
 * `ios/Podfile.lock`, and the `VOLA.app` binary built from it contained no
 * `ExpoCamera` symbol.
 *
 * `expo-camera`'s entry point is `requireNativeModule('ExpoCamera')` at module
 * scope, and that **throws** when the native half is absent. So the failure is
 * not in the camera, or in the scan handler, or in anything a `try/catch` audit
 * of the screen would find: it is the *import*, and it fires when Expo Router
 * evaluates the route module — i.e. on navigating to the screen, before a
 * preview has ever existed. In a Release build an unhandled JS error is fatal,
 * so the process dies with no red box and no dialog.
 *
 * The mock below is therefore a **throwing module factory**, not a stubbed
 * component. That is the entire point: `scanScreen.test.tsx` replaces
 * `expo-camera` with a working fake, which is exactly the shape of stub that
 * cannot falsify the assumption it was built from — it can only ever test the
 * case where the module loads. A separate file is needed because a module
 * factory is registered per test file, and the two cases are mutually
 * exclusive.
 *
 * ## Mutation-checked
 *
 * Remove the `try`/`catch` from `lib/cameraModule.ts` and this file fails at
 * import with `Cannot find native module 'ExpoCamera'` — the production
 * failure, reproduced. Remove the `if (!CameraView)` branch from
 * `app/food/scan.tsx` and the second test fails on the missing testID.
 *
 * **Both were demonstrated, and the second time was not academic.** A review
 * subagent mutation-tested this file's first guard and its restore raced a
 * commit in the same worktree, so the mutation was committed and pushed. This
 * test went red on it — in CI, in `verify`, and in two independent reviews.
 * Which is the point of it existing, and a reminder that a "restore" is only
 * confirmed by re-running the thing that fails, never by grepping the file.
 *
 * ## What this does NOT cover, deliberately
 *
 * It cannot tell you whether the binary is correctly built. Nothing in JS can:
 * the fault lives in `ios/Podfile.lock`, which is gitignored and generated, and
 * no test, lint or typecheck reads it. This pins the blast radius — a bad build
 * becomes a screen instead of a termination — and the build itself is checked
 * by rebuilding it.
 */

/**
 * `expo-camera`, absent.
 *
 * The message is copied verbatim from `expo-modules-core`'s
 * `requireNativeModule`, so the thing being simulated is the real throw rather
 * than a generic one.
 */
jest.mock('expo-camera', () => {
  throw new Error("Cannot find native module 'ExpoCamera'");
});

const mockUseEffect = useEffect;

const mockReplace = jest.fn();
jest.mock('expo-router', () => ({
  __esModule: true,
  useFocusEffect: (cb: () => void) => mockUseEffect(() => cb(), [cb]),
  useLocalSearchParams: () => ({ meal: 'lunch', date: '2026-08-19' }),
  useRouter: () => ({ push: jest.fn(), back: jest.fn(), replace: mockReplace }),
  Stack: { Screen: () => null },
}));

jest.mock('@/lib/barcodeApi', () => ({ lookupBarcode: jest.fn() }));
jest.mock('@/lib/barcodeCache', () => ({
  cachedBarcode: jest.fn(),
  rememberBarcode: jest.fn(),
}));
jest.mock('@/lib/foodLog', () => ({ logFood: jest.fn() }));
jest.mock('@/lib/sync', () => ({ request: jest.fn() }));

describe('the scan screen with no native camera', () => {
  it('reports the camera as absent rather than throwing on import', () => {
    // The import is INSIDE the test on purpose: a top-level import would make
    // the whole file fail to run, which reads as a broken test rather than as
    // the thing under test. `require` here proves the module graph survives.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { CameraView } = require('@/lib/cameraModule');

    // `null`, not `undefined`: the export is deliberately typed
    // `ComponentType | null`, which is what makes skipping the check a compile
    // error rather than a render-time crash. Asserting the exact value is what
    // keeps a future `as ComponentType` assertion from creeping back.
    expect(CameraView).toBeNull();
  });

  it('renders the explained dead end, and offers the path that still works', () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const ScanBarcodeScreen = require('../food/scan').default;

    render(<ScanBarcodeScreen />);

    expect(screen.getByTestId('scan-unavailable')).toBeTruthy();
    expect(screen.queryByTestId('scan-camera')).toBeNull();
    expect(screen.getByTestId('scan-unavailable-describe')).toBeTruthy();

    /*
     * Never the PERMISSION screen, and this is the assertion that has to be
     * `scan-permission-describe` rather than `scan-request-permission`.
     *
     * Measured, by mutating the branch away: the stub reports
     * `canAskAgain: false`, so the fallthrough renders the "you can turn it on
     * in Settings" variant, which has no request button — and an assertion on
     * the request button therefore passes in both worlds. It reads like a guard
     * and is not one. `scan-permission-describe` is on the permission screen in
     * BOTH its variants, so it is the id that actually distinguishes them.
     *
     * The distinction matters because a permission screen here would be a false
     * instruction: there is no camera in the binary, so nothing the athlete does
     * in Settings can produce one.
     */
    expect(screen.queryByTestId('scan-permission-describe')).toBeNull();
  });
});
