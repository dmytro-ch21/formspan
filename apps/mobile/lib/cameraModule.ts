/**
 * `expo-camera`, imported in the one way that cannot end the process.
 *
 * ## What this is defending against, precisely
 *
 * `expo-camera`'s JS entry point is, at module scope:
 *
 * ```js
 * export default requireNativeModule('ExpoCamera');
 * ```
 *
 * and `requireNativeModule` **throws** `Cannot find native module 'ExpoCamera'`
 * when the native half is not linked into the binary. So a plain
 * `import { CameraView } from 'expo-camera'` does not fail when the camera is
 * used — it fails when the *file* is evaluated, which for an Expo Router route
 * is the moment the athlete navigates to it. In a **Release** build an
 * unhandled JS error is fatal: the process is terminated with no red box, no
 * dialog and no JS stack anywhere the app can see. It reads, from the outside,
 * exactly like the app closing itself.
 *
 * That is not hypothetical. N91 was reported as "scanning a barcode closes the
 * app instantly", and the installed build had `expo-camera` in `package.json`
 * and in the JS bundle while the iOS project had never had `pod install` re-run
 * for it — measured: `expo-camera` was the ONE native dependency of the twenty
 * in `apps/mobile/package.json` absent from `ios/Podfile.lock`, and the
 * `VOLA.app` binary built from it contained no `ExpoCamera` symbol at all.
 *
 * ## This is a blast shield, NOT the repair
 *
 * A build whose native modules do not match its JS is still broken, and the
 * repair for that is `pnpm install` + `pod install` + a native rebuild — see
 * the trap in CLAUDE.md about a native dependency being declared by a merge and
 * installed by nobody. What this file changes is the FAILURE MODE: a mismatch
 * becomes a screen that says so and offers the other way to log the food,
 * instead of a termination that takes the athlete's unsaved session with it.
 *
 * The distinction matters enough to state, because the guard makes the
 * underlying problem quieter: nothing here makes a stale binary correct, and a
 * "scanning isn't available" screen on a build that should have a camera is a
 * BUILD bug being reported honestly rather than a feature that is missing.
 *
 * ## Why `require` in a `try` rather than a static import
 *
 * There is no other shape that works. An ESM `import` is hoisted above every
 * statement in the file, so it cannot be wrapped — the throw happens before any
 * `try` block exists. Metro still records the dependency statically (the
 * argument is a string literal), so the module is bundled exactly as before;
 * only the moment of failure moves.
 *
 * The same reasoning applies to any future screen that needs the camera: import
 * from here, never from `expo-camera` directly.
 */

import type { CameraViewProps, PermissionResponse } from 'expo-camera';
import type { ComponentType } from 'react';

/**
 * The subset of `expo-camera` this app actually uses.
 *
 * Narrowed on purpose: the stub below has to satisfy this type, and a type
 * covering the whole package would mean stubbing picture capture and video
 * recording that no screen here calls.
 */
type CameraModule = {
  CameraView: ComponentType<CameraViewProps>;
  useCameraPermissions: () => [PermissionResponse | null, () => Promise<unknown>];
};

function load(): CameraModule | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require('expo-camera') as CameraModule;
  } catch {
    // Deliberately swallowed, and deliberately not logged as an error the
    // athlete could see: the caller renders an explanation, and a console
    // error here would be the only trace in a Release build anyway.
    return null;
  }
}

const camera = load();

/**
 * The camera preview, or **`null` when this binary has no camera module**.
 *
 * The nullable type is the guard, and it is deliberately not asserted away.
 * An earlier draft exported it as `ComponentType<CameraViewProps>` with a
 * companion `cameraAvailable` boolean, and review was right to call that a
 * footgun: a caller who skipped the boolean would render `undefined`, React
 * would throw "Element type is invalid", and in a Release build that is another
 * fatal unhandled error — the identical crash, moved from import time to render
 * time. This PR exists because a shape that crashes by default shipped, so the
 * replacement had better not be one.
 *
 * Typed `| null`, forgetting the check is a **compile** error. `react` narrows
 * fine across an early return: `if (!CameraView) return …` leaves it non-null
 * for the rest of the component, because an imported binding is `const` and
 * TypeScript's control-flow analysis narrows it like any other.
 *
 * Read once at import rather than per render, since the answer cannot change
 * while the process is alive — a native module is either linked into the binary
 * or it is not.
 */
export const CameraView: ComponentType<CameraViewProps> | null = camera?.CameraView ?? null;

/**
 * The stub's permission answer.
 *
 * `status` is the string literal rather than `PermissionStatus.DENIED`, because
 * that enum is a **value** and importing a value from `expo-camera` is the
 * throw this whole file exists to avoid — it would run the package's module
 * scope at the top of this one, hoisted above the `try`.
 *
 * `canAskAgain: false` so a caller that somehow reaches the permission branch
 * without a camera renders a dead end, rather than a button that asks for a
 * permission nothing will ever answer.
 */
const DENIED = {
  status: 'denied',
  expires: 'never',
  granted: false,
  canAskAgain: false,
} as PermissionResponse;

/**
 * `useCameraPermissions`, always callable.
 *
 * A stub rather than a conditional call, because `react-hooks/rules-of-hooks`
 * is an error in this app and a hook behind `if (CameraView)` is exactly the
 * conditional-hook shape that made every BJJ session a black screen. One
 * unconditional call site, one of two implementations chosen at import.
 *
 * This is why the module is NOT a single discriminated union: narrowing is the
 * right shape for the component and the wrong one for the hook, so they are two
 * exports with two different jobs.
 *
 * The stub reports the camera as denied and unaskable, which is the honest
 * answer — there is no camera to grant access to — but callers must branch on
 * `CameraView` being null FIRST, so a missing module never renders as a
 * permission problem the athlete could go and "fix" in Settings.
 */
export const useCameraPermissions: CameraModule['useCameraPermissions'] =
  camera?.useCameraPermissions ?? (() => [DENIED, () => Promise.resolve(null)]);
