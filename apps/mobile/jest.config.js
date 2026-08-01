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
 * The suite was deliberately **logic-first**, and mostly still is: what breaks
 * here is concurrency and state reconciliation — token refreshes racing
 * sign-out, sync runs interleaving, set transforms crossing a group boundary.
 *
 * **Component tests earned their place in the PR #80 review.** Two of its
 * blocking findings were defects that existed ONLY in the render path: a
 * screen adopting the server's copy of a workout over an unpushed local edit,
 * and a list rendering the raw network response instead of the reconciled
 * cache — so an offline-created workout vanished when a stale response
 * landed. Both were correct in SQLite and wrong on screen, which is precisely
 * the class a logic-only suite cannot see. `@testing-library/react-native`
 * covers those; it is not an invitation to snapshot every view.
 */
module.exports = {
  preset: 'jest-expo',
  testMatch: ['**/__tests__/**/*.test.ts?(x)'],
  collectCoverageFrom: ['lib/**/*.ts', 'components/**/*.tsx', 'app/**/*.tsx'],
  setupFilesAfterEnv: ['<rootDir>/jest.setup.js'],
};
