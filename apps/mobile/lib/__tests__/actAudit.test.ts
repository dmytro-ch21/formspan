import { describeFindings, installActAudit, readStack } from './support/actAudit';

const ROOT = '/repo/apps/mobile/';
const REACT =
  '/repo/node_modules/.pnpm/react-reconciler@0.33.0/node_modules/react-reconciler/cjs/react-reconciler.development.js:1:1';

function stack(...frames: string[]) {
  return ['Error', ...frames.map((f) => `    at ${f}`)].join('\n');
}

describe('readStack', () => {
  it('reads a state update made synchronously in a timer callback as a timer callback', () => {
    const reading = readStack(
      stack(
        `Array.next.push (${ROOT}lib/__tests__/support/actAudit.ts:10:5)`,
        `scheduleImmediateRootScheduleTask (${REACT})`,
        `scheduleUpdateOnFiber (${REACT})`,
        `dispatchSetState (${REACT})`,
        `Timeout._onTimeout (${ROOT}app/library.tsx:120:7)`,
        'listOnTimeout (node:internal/timers:608:17)',
        'process.processTimers (node:internal/timers:543:7)',
      ),
      ROOT,
    );
    expect(reading).toEqual({
      update: true,
      timerCallback: true,
      frame: 'Timeout._onTimeout (app/library.tsx:120:7)',
    });
  });

  it('reads a continuation drained between two timers as NOT a timer callback', () => {
    // Node drains microtasks from inside `listOnTimeout` between timers, so a
    // timer frame is present; which one comes first is what decides.
    const reading = readStack(
      stack(
        `scheduleUpdateOnFiber (${REACT})`,
        `setCatalog (${ROOT}app/bjj/dictate.tsx:254:25)`,
        'processTicksAndRejections (node:internal/process/task_queues:105:5)',
        'runNextTicks (node:internal/process/task_queues:69:3)',
        'listOnTimeout (node:internal/timers:569:9)',
      ),
      ROOT,
    );
    expect(reading).toEqual({
      update: true,
      timerCallback: false,
      frame: 'setCatalog (app/bjj/dictate.tsx:254:25)',
    });
  });

  it('reads a continuation with nothing below it as NOT a timer callback', () => {
    const reading = readStack(
      stack(`scheduleUpdateOnFiber (${REACT})`, `load (${ROOT}app/goals.tsx:764:9)`),
      ROOT,
    );
    expect(reading.timerCallback).toBe(false);
  });

  it('reads an immediate callback, and a fake timer, as timer callbacks', () => {
    for (const bottom of [
      'process.processImmediate (node:internal/timers:505:21)',
      'callTimer (/repo/node_modules/@sinonjs/fake-timers/src/fake-timers-src.js:1:1)',
    ]) {
      const reading = readStack(stack(`scheduleUpdateOnFiber (${REACT})`, `cb (${ROOT}app/x.tsx:1:1)`, bottom), ROOT);
      expect(reading.timerCallback).toBe(true);
    }
  });

  it('does not read a root render or an unmount as an update', () => {
    const reading = readStack(
      stack(`scheduleUpdateOnFiber (${REACT})`, `updateContainerImpl (${REACT})`, `unmount (${ROOT}x.js:1:1)`),
      ROOT,
    );
    expect(reading.update).toBe(false);
  });

  it("does not read React's own queued work as an update", () => {
    expect(readStack(stack(`flushPassiveEffects (${REACT})`, `cb (${ROOT}app/x.tsx:1:1)`), ROOT).update).toBe(false);
  });

  it('falls back to the first frame outside React when no app frame exists', () => {
    const list =
      'VirtualizedList._updateCellsToRender (/repo/node_modules/react-native/Libraries/Lists/VirtualizedList.js:1:1)';
    expect(readStack(stack(`scheduleUpdateOnFiber (${REACT})`, `Object.enqueueSetState (${REACT})`, list), ROOT).frame).toBe(
      list.replace(/^/, ''),
    );
    expect(readStack(stack(`scheduleUpdateOnFiber (${REACT})`), ROOT).frame).toBe('an unknown frame');
  });
});

describe('describeFindings', () => {
  it('prints one line per distinct frame, counted, each carrying the census phrase', () => {
    const dictate = { frame: 'setCatalog (app/bjj/dictate.tsx:254:25)' };
    const goals = { frame: 'load (app/goals.tsx:764:9)' };
    expect(describeFindings([dictate, goals, dictate], 'Dictate › a test')).toEqual([
      `act audit: an update from async work the test did not await landed during the teardown's act(...) (2 times). Test: "Dictate › a test". At: setCatalog (app/bjj/dictate.tsx:254:25)`,
      `act audit: an update from async work the test did not await landed during the teardown's act(...). Test: "Dictate › a test". At: load (app/goals.tsx:764:9)`,
    ]);
  });

  it('prints nothing for no findings', () => {
    expect(describeFindings([], 'x')).toEqual([]);
  });
});

describe('installActAudit', () => {
  // Named for the reconciler functions `readStack` looks for, so the stack a
  // real push would carry is reproduced without React.
  function makeInternals() {
    const internals: { actQueue: unknown[] | null } = { actQueue: null };
    const audit = installActAudit({ internals, root: ROOT });
    function scheduleUpdateOnFiber() {
      internals.actQueue?.push('task');
    }
    function updateContainerImpl() {
      scheduleUpdateOnFiber();
    }
    return { internals, audit, scheduleUpdateOnFiber, updateContainerImpl };
  }

  it('records an update only while armed', async () => {
    const { internals, audit, scheduleUpdateOnFiber } = makeInternals();
    internals.actQueue = [];
    scheduleUpdateOnFiber();
    expect(audit.take()).toEqual([]);

    await audit.duringTeardown(async () => {
      scheduleUpdateOnFiber();
    });
    expect(audit.take()).toHaveLength(1);

    scheduleUpdateOnFiber();
    expect(audit.take()).toEqual([]);
    expect([...(internals.actQueue ?? [])]).toEqual(['task', 'task', 'task']);
  });

  it('disarms even when the teardown throws', async () => {
    const { internals, audit, scheduleUpdateOnFiber } = makeInternals();
    internals.actQueue = [];
    await expect(
      audit.duringTeardown(async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    scheduleUpdateOnFiber();
    expect(audit.take()).toEqual([]);
  });

  it('does not record a root render, or an update in a timer callback', async () => {
    const { internals, audit, scheduleUpdateOnFiber, updateContainerImpl } = makeInternals();
    internals.actQueue = [];
    await audit.duringTeardown(async () => {
      updateContainerImpl();
      await new Promise<void>((resolve) =>
        setTimeout(() => {
          scheduleUpdateOnFiber();
          resolve();
        }, 0),
      );
    });
    expect(audit.take()).toEqual([]);
  });

  it('instruments each queue React assigns, and never wraps one twice', async () => {
    const { internals, audit, scheduleUpdateOnFiber } = makeInternals();
    const first: unknown[] = [];
    internals.actQueue = first;
    internals.actQueue = null;
    internals.actQueue = first;
    internals.actQueue = [];
    await audit.duringTeardown(async () => {
      scheduleUpdateOnFiber();
      internals.actQueue = first;
      scheduleUpdateOnFiber();
    });
    expect(audit.take()).toHaveLength(2);
    expect([...first]).toEqual(['task']);
  });
});
