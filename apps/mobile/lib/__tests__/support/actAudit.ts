/**
 * F47 (#1057) — the act audit: what the in-`act` teardown absorbs, made
 * visible again.
 *
 * `jest.setup.js` tears every test down inside `act`, and that ended the
 * flake. It also meant an async chain a test never awaited could finish inside
 * that `act` and print nothing, so a census of 0 stopped proving the chain was
 * awaited (M7 in the F47 history entry). This records exactly that case: a
 * state update that lands WHILE THE TEARDOWN RUNS, from a promise
 * continuation. `jest.setup.js` prints one `act audit:` line per finding, next
 * to React's own act warnings, so the census counts both.
 *
 * **What it does not flag, on purpose: an update made synchronously inside a
 * timer callback.** `VirtualizedList` re-arms a cell-batch timer on every
 * render and `app/library.tsx` debounces search on one. No test can await
 * either, and the unmount clears them. A promise continuation that runs AFTER
 * a timer fired (a mock resolved on `setTimeout`) is still a continuation, and
 * is flagged.
 *
 * **How.** React gives nothing public to observe where an update came from.
 * Two things are observable. When an update is scheduled inside `act`, React
 * pushes a root-schedule task onto `ReactSharedInternals.actQueue`. And the
 * stack at that push says two things: whether it is a state update
 * (`scheduleUpdateOnFiber`, not a root render or unmount through
 * `updateContainer`), and whether it runs synchronously in a timer callback
 * (a timer frame below any microtask frame).
 *
 * **Its limits, stated so a 0 is read correctly.**
 * - **The teardown only.** A chain absorbed by a later `act` INSIDE the test
 *   body is not seen. A rule for that was built and dropped: it could not tell
 *   a leaked chain from a test that holds a promise and releases it inside
 *   `act` on purpose, and all 8 of its full-suite findings were the second
 *   kind. The F47 history entry has the measurement.
 * - React pushes once per batch, so a continuation update in the same batch
 *   as an exempt timer update can be missed. A miss, never a false report.
 * - A chain whose next step is not due until after the unmount is invisible
 *   here, as it is to React: an update to an unmounted tree schedules nothing.
 * - **A test file that calls `jest.resetModules()` and then renders** gets a
 *   fresh `react` whose internals this never instrumented, so that file reads
 *   0. No component test does today (the two files that reset modules render
 *   nothing); a new one would need to install the audit on its own `react`.
 * - It reads React internals (`actQueue`, and reconciler function names in a
 *   development build's stack). The controls in
 *   `components/__tests__/actAudit.test.tsx` drive real React, so a React
 *   upgrade that moves either turns them red rather than turning this silent.
 */

export interface Finding {
  /** The nearest frame that is not React, jest or this module. */
  frame: string;
}

export interface StackReading {
  /** A state update, as opposed to a root render, an unmount or React's own bookkeeping. */
  update: boolean;
  /** Running synchronously inside a timer or immediate callback. */
  timerCallback: boolean;
  frame: string;
}

const TIMER_FRAME = /\b(listOnTimeout|processTimers|processImmediate|callTimer)\b/;
const MICROTASK_FRAME = /\b(processTicksAndRejections|runNextTicks|runMicrotasks)\b/;
const NOT_THE_CAUSE =
  /react-reconciler|\/node_modules\/react\/|\/node_modules\/scheduler\/|support\/actAudit|jest\.setup|node:internal|\(<anonymous>\)$/;

/** Reads a stack captured at the moment React queued work on `act`'s queue. */
export function readStack(stack: string, root: string): StackReading {
  const frames = stack
    .split('\n')
    .slice(1)
    .map((line) => line.trim())
    .filter((line) => line.startsWith('at '));
  const update =
    frames.some((f) => /\bscheduleUpdateOnFiber\b/.test(f)) &&
    !frames.some((f) => /\bupdateContainer/.test(f));
  const timer = frames.findIndex((f) => TIMER_FRAME.test(f));
  const microtask = frames.findIndex((f) => MICROTASK_FRAME.test(f));
  const timerCallback = timer !== -1 && (microtask === -1 || timer < microtask);
  const candidates = frames.filter((f) => !NOT_THE_CAUSE.test(f));
  const own = candidates.find((f) => f.includes(root) && !f.includes('/node_modules/'));
  const chosen = own ?? candidates[0] ?? 'at an unknown frame';
  return { update, timerCallback, frame: chosen.replace(/^at /, '').split(root).join('') };
}

/** One line per distinct finding, counted, in the order first seen. */
export function describeFindings(findings: readonly Finding[], testName: string): string[] {
  const counts = new Map<string, number>();
  for (const { frame } of findings) counts.set(frame, (counts.get(frame) ?? 0) + 1);
  return [...counts].map(([frame, n]) => {
    const times = n > 1 ? ` (${n} times)` : '';
    return `act audit: an update from async work the test did not await landed during the teardown's act(...)${times}. Test: "${testName}". At: ${frame}`;
  });
}

export interface ActAudit {
  /** Runs `work` with the audit armed. */
  duringTeardown(work: () => Promise<void>): Promise<void>;
  /** Everything recorded since the last call, and clears it. */
  take(): Finding[];
}

/**
 * Installs the audit on React's shared internals (`actQueue`). Once per test
 * file, before anything renders — `jest.setup.js` does it.
 */
export function installActAudit({
  internals,
  root,
}: {
  internals: { actQueue: unknown[] | null };
  root: string;
}): ActAudit {
  const instrumented = new WeakSet<unknown[]>();
  let armed = false;
  let findings: Finding[] = [];

  function observe() {
    if (!armed) return;
    const limit = Error.stackTraceLimit;
    Error.stackTraceLimit = 100;
    const stack = new Error().stack ?? '';
    Error.stackTraceLimit = limit;
    const reading = readStack(stack, root);
    if (reading.update && !reading.timerCallback) findings.push({ frame: reading.frame });
  }

  let queue = internals.actQueue;
  const instrument = (next: unknown[] | null) => {
    if (Array.isArray(next) && !instrumented.has(next)) {
      instrumented.add(next);
      const push = next.push;
      next.push = function (this: unknown[], ...items: unknown[]) {
        observe();
        return push.apply(this, items);
      };
    }
  };
  instrument(queue);
  Object.defineProperty(internals, 'actQueue', {
    configurable: true,
    enumerable: true,
    get: () => queue,
    set: (next: unknown[] | null) => {
      instrument(next);
      queue = next;
    },
  });

  return {
    async duringTeardown(work) {
      armed = true;
      try {
        await work();
      } finally {
        armed = false;
      }
    },
    take() {
      const taken = findings;
      findings = [];
      return taken;
    },
  };
}

interface Registration {
  audit: ActAudit;
  tearDown: () => Promise<void>;
  /** Prints a line through the `console.error` captured at setup. */
  report: (line: string) => void;
}

let registered: Registration | null = null;

/**
 * `jest.setup.js` registers the audit it installed together with the exact
 * teardown it runs and the reporter it prints through, so the controls can
 * drive all three mid-test and assert on what was recorded rather than on a
 * printed line.
 */
export function registerActAudit(
  audit: ActAudit,
  tearDown: () => Promise<void>,
  report: (line: string) => void,
): void {
  registered = { audit, tearDown, report };
}

export function registeredActAudit(): Registration {
  if (!registered) throw new Error('act audit: jest.setup.js did not register it');
  return registered;
}
