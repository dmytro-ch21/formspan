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
const config = {
  preset: 'jest-expo',
  /**
   * Above the 10s `asyncUtilTimeout` five component suites configure, because
   * jest's own default is 5000ms and it wins.
   *
   * Measured, not inferred: a `waitFor` configured at 10s dies at 5003ms with
   * jest's "Exceeded timeout of 5000 ms", and a bare 9s test dies at 5001ms.
   * So those files were asking for ten seconds of polling and getting five —
   * losing exactly the headroom they were given to survive a slow render under
   * load, which is the condition they were widened for.
   *
   * 15s rather than "off": a bound that a hung test hits in fifteen seconds is
   * worth keeping, and this is still two orders of magnitude under the ten
   * minutes the Go suite ran unbounded until F12. It raises the ceiling so the
   * configured budget is reachable; it does not remove one.
   *
   * It does not by itself fix the oversubscription flake — that is `maxWorkers`,
   * set below, and only for CI.
   */
  testTimeout: 15_000,
  testMatch: ['**/__tests__/**/*.test.ts?(x)'],
  collectCoverageFrom: ['lib/**/*.ts', 'components/**/*.tsx', 'app/**/*.tsx'],
  setupFilesAfterEnv: ['<rootDir>/jest.setup.js'],
};

/**
 * CI only — and the number is measured on the machine it applies to, which is
 * the whole point of issue #409.
 *
 * jest sizes its worker pool as `os.cpus().length - 1`. Measured from a real
 * `ubuntu-latest` step, not from GitHub's published spec: `nproc` = 4 and
 * `os.cpus().length` = 4, so jest picks **3**. But `lscpu` on that same runner
 * reports `Core(s) per socket: 2` and `Thread(s) per core: 2` — the four are
 * hyperthreads on **two physical cores**. Three workers plus the main process
 * is a four-way contest for two cores, and `/usr/bin/time` measured 311–330%
 * CPU against a 400% ceiling on exactly the runs that failed.
 *
 * The failure is never a wrong value, always a missing element — a `waitFor`
 * whose budget expires because the render it is waiting on never got scheduled.
 * Which suite loses is arbitrary; three different ones have been blamed.
 *
 * Measured on the full suite, 119 files, with the load that made it flake:
 *   unset (3 workers): 3 failures / 10 runs, 311–330% CPU, 28–31s
 *   maxWorkers: 2:     0 failures / 15 runs, 240–251% CPU, 24–32s
 * The cap costs no wall time, because the oversubscription was never buying
 * throughput — the same result the 10-core local measurement reached.
 *
 * NOT `workerIdleMemoryLimit`, and that was measured rather than assumed: peak
 * RSS on the failing runs was 785–910 MB against 15,989 MB of RAM. Memory was
 * never the scarce resource here, so a memory lever would have been a placebo
 * that appeared to work.
 *
 * Guarded on CI because a developer machine is the opposite case — 10 real
 * cores, no SMT, where jest's default of 9 is right for a solo run. When
 * several sessions share that machine, pass `--maxWorkers=3` on the command
 * line; the CLI overrides this, so the two are answers to two different
 * questions rather than rivals.
 *
 * If CI ever moves to a runner with more physical cores, re-measure rather than
 * scaling this number by the published vCPU count — that inference is the
 * defect this comment exists to record.
 */
if (process.env.CI) {
  config.maxWorkers = 2;
}

module.exports = config;
