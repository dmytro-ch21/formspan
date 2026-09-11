import { configure, render, screen, fireEvent } from '@testing-library/react-native';

import SettingsScreen from '../../app/settings';
import { findAllByType, switchWrappers } from '@/lib/__tests__/support/tree';

/**
 * The Settings toggles are the PLATFORM's switch (F43/#1042).
 *
 * Three hand-rolled toggles used to move their knob by flipping
 * `alignSelf: 'flex-end'` — a layout property, changed with no transition, so
 * the knob teleported. The fix was never to animate them: a settings toggle is
 * flipped constantly and belongs in the "platform default or nothing" tier,
 * which this app got half right by not animating and half wrong by not using
 * the platform's control.
 *
 * ## What this file guards, and why each is separate
 *
 * The swap's two predicted failure modes are both structural and both silent,
 * so they are asserted rather than left to a device check:
 *
 * - **Double-toggle.** The row owns the press. A `<Switch>` that could also be
 *   touched would fire its own handler AND the row's, toggling twice and
 *   landing back where it started — which reads as "the toggle does nothing".
 * - **Double-announce.** The row already reports `role="switch"` with a
 *   `checked` state. A nested native `<Switch>` reports a role of its own, so
 *   VoiceOver would read the control twice.
 *
 * ## What it cannot see
 *
 * That the knob GLIDES. That is the whole point of the change and it is a
 * device criterion on #1042 — `<Switch>` renders as a host component in jest
 * with no animation to observe. What is checkable here is that the platform
 * control is the one on screen, which is the thing that buys the glide.
 */

jest.setTimeout(30_000);
configure({ asyncUtilTimeout: 10_000 });

jest.mock('@/lib/healthkit', () => ({ isHealthKitSupported: () => false }));
jest.mock('@/lib/healthkitSync', () => ({
  readHealthKitImportEnabled: async () => false,
  triggerHealthKitImportNow: jest.fn(),
  writeHealthKitImportEnabled: async () => {},
}));
jest.mock('@/lib/biometricSync', () => ({
  readBiometricSyncFailureCount: async () => 0,
  triggerBiometricSyncNow: jest.fn(),
}));
jest.mock('@/lib/healthConnect', () => ({ isHealthConnectSupported: async () => false }));
jest.mock('@/lib/healthConnectSync', () => ({
  readHealthConnectImportEnabled: async () => false,
  triggerHealthConnectSyncNow: jest.fn(),
  writeHealthConnectImportEnabled: async () => {},
}));
jest.mock('@/lib/rest', () => ({ readAutoRest: async () => false, writeAutoRest: async () => {} }));
/*
  `mock`-prefixed because jest forbids a factory closing over anything else.
  And the factory hands back a WRAPPER rather than the spy itself: `jest.mock`
  is hoisted above this declaration, the factory runs while `app/settings` is
  being imported, and reading the const at that moment finds it still in its
  temporal dead zone — so the module got `writeSoundsEnabled: undefined` and
  the screen died with "is not a function" the first time a row was pressed.
  Calling through a closure defers the read to press time, when it exists.
*/
const mockWriteSoundsEnabled = jest.fn(async () => {});
jest.mock('@/lib/sounds', () => ({
  playSound: jest.fn(),
  readSoundsEnabled: async () => true,
  writeSoundsEnabled: (...args: unknown[]) => mockWriteSoundsEnabled(...(args as [])),
}));
jest.mock('@/lib/voice', () => ({
  readVoiceEnabled: async () => true,
  speak: jest.fn(),
  writeVoiceEnabled: async () => {},
}));
jest.mock('@/lib/useTrackEffort', () => ({
  useTrackEffort: () => ({ trackEffort: true, setTrackEffort: async () => {}, unsynced: false }),
}));
jest.mock('@/lib/profile', () => ({
  getProfile: async () => ({ share_training_with_friends: false, share_training_details: false }),
  updateProfile: async () => ({}),
}));
jest.mock('@/lib/telemetryClient', () => ({ rejectionTrackingActive: () => false }));
jest.mock('@/lib/session', () => ({ clearSessionToken: async () => {} }));

/**
 * Every native `<Switch>` currently mounted, in tree order. `RCTSwitch` is the
 * host component React Native's `<Switch>` renders down to — the same way the
 * ring tests reach for `RNSVGCircle`.
 */
const switches = () => findAllByType(screen.root, 'RCTSwitch');

/**
 * The wrapper query lives in `support/tree.ts` because the same invariant holds
 * at three call sites. Every assertion below also checks this count equals the
 * switch count, which is what catches a switch rendered with no wrapper at all
 * — the case a per-wrapper loop would silently pass by iterating nothing.
 */
const wrappers = () => switchWrappers(screen.root);

it('renders the platform switch, not a hand-rolled knob', async () => {
  await render(<SettingsScreen />);
  await screen.findByTestId('settings-sounds');
  // If the swap were reverted, the rows would be plain Views and this is zero.
  expect(switches().length).toBeGreaterThan(0);
});

/*
  These two assert on the WRAPPER, and the first draft of this file did not —
  it checked `onValueChange` on the switch and the role on the row, and
  mutation testing caught both as worthless:

  - `onValueChange` never reaches the host node at all. React Native's
    `<Switch>` maps it to `onChange`, which is ALWAYS a function because the
    component attaches its own internal handler regardless. So the assertion
    was reading a prop that is undefined whether or not a handler was passed,
    and adding `onValueChange={onChange}` back left the suite green.
  - the accessibility test only ever looked at the row, so deleting
    `accessibilityElementsHidden` from the switch — the exact double-announce
    this change risks — also left it green.

  What actually makes the switch inert is the wrapper, so the wrapper is what
  is asserted.
*/
it('the switch is touch-inert, so one tap on it cannot toggle twice', async () => {
  await render(<SettingsScreen />);
  await screen.findByTestId('settings-sounds');

  const found = wrappers();
  expect(found.length).toBeGreaterThan(0);
  // Every switch is wrapped — not just "the wrapped ones are correct".
  expect(found.length).toBe(switches().length);

  for (const w of found) {
    // `pointerEvents: 'none'` is the whole protection: the row above owns the
    // press, and a switch that could also be touched would fire both handlers
    // and land back where it started.
    expect(w.props.pointerEvents).toBe('none');
  }
});

it('the switch is hidden from the accessibility tree, so the row announces once', async () => {
  await render(<SettingsScreen />);
  await screen.findByTestId('settings-sounds');

  const found = wrappers();
  expect(found.length).toBeGreaterThan(0);
  expect(found.length).toBe(switches().length);

  for (const w of found) {
    // The native switch carries an `accessibilityRole` of its own — confirmed
    // on the rendered host node — so without both of these VoiceOver reads
    // the control twice: once for the row, once for the switch inside it.
    expect(w.props.accessibilityElementsHidden).toBe(true);
    expect(w.props.importantForAccessibility).toBe('no-hide-descendants');
  }

  // And the row is the one accessible control, carrying the state.
  const row = screen.getByTestId('settings-sounds');
  expect(row.props.accessibilityRole).toBe('switch');
  expect(row.props.accessibilityState).toMatchObject({ checked: true });
});

it('pressing the ROW still toggles, exactly once', async () => {
  await render(<SettingsScreen />);
  const row = await screen.findByTestId('settings-sounds');

  mockWriteSoundsEnabled.mockClear();
  await fireEvent.press(row);

  // Once, not twice: the row's own handler is the only one wired.
  expect(mockWriteSoundsEnabled).toHaveBeenCalledTimes(1);
});
