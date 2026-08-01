/**
 * Tests for apps/mobile.
 *
 * **Why this exists at all.** Three history entries in a row noted that this
 * app had no test runner, so the only way to exercise its logic was a
 * throwaway Node harness compiled with `tsc` and thrown away again. That cost
 * real bugs: twice, a harness assertion passed *for the wrong reason* and was
 * only caught by deleting the code under test to see whether the test noticed.
 * Neither of those checks was repeatable, and neither ran in CI.
 *
 * `jest-expo` rather than a bare jest or vitest: it resolves React Native and
 * the `expo-*` native modules the way Metro does, so a test can import
 * `lib/session.ts` (expo-secure-store) or `lib/sync.ts` (react-native's
 * AppState) without the caller having to hand-stub the module graph — which is
 * exactly what made the harnesses fragile.
 *
 * The suite is deliberately **logic-first**, not component-first. What has
 * actually broken here is concurrency and state reconciliation: token
 * refreshes racing sign-out, sync runs interleaving, set transforms crossing a
 * group boundary. Rendering tests would be a lot of ceremony aimed away from
 * where the bugs are.
 */
module.exports = {
  preset: 'jest-expo',
  testMatch: ['**/__tests__/**/*.test.ts?(x)'],
  // The screens import Expo Router, native modules and Clerk; pulling those in
  // for a pure-logic suite buys nothing. Widen this when a component test
  // earns its place.
  collectCoverageFrom: ['lib/**/*.ts'],
};
