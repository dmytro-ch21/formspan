/**
 * F47 (#1057) — controls for the act audit (`lib/__tests__/support/actAudit.ts`).
 *
 * Each test drives the SAME teardown `jest.setup.js` runs, mid-test, against
 * real React, and asserts on what the audit recorded. Every control also
 * asserts the update it is about happened during that teardown and not
 * before, so none can pass by measuring nothing. A React upgrade that moves the
 * internals the audit reads turns these red.
 *
 * **The test decides the exact moment each update becomes runnable: right
 * before the teardown.** The first version let a 1ms timer fall due with a
 * busy-wait instead, and it was flaky: whether a due timer or the teardown's
 * own `setImmediate` runs first depends on the event-loop phase the test
 * happens to be in, and one run in a loop of mutation checks went red on an
 * unmutated file. An immediate queued before the teardown's, or a promise
 * resolved before it starts, has one possible order.
 */
import { Component, useEffect, useState } from 'react';
import { Text } from 'react-native';
import { act, render } from '@testing-library/react-native';

import { registeredActAudit } from '@/lib/__tests__/support/actAudit';

const { audit, tearDown, report } = registeredActAudit();

beforeEach(() => {
  audit.take();
});

type Arm = (queue: () => void) => void;

/** A hook component whose update runs in an immediate callback, when the test arms it. */
function UpdatesInAnImmediate({ arm, onFire }: { arm: Arm; onFire: () => void }) {
  const [fired, setFired] = useState(false);
  useEffect(() => {
    arm(() => {
      setImmediate(() => {
        onFire();
        setFired(true);
      });
    });
  }, [arm, onFire]);
  return <Text>{fired ? 'fired' : 'waiting'}</Text>;
}

/** `VirtualizedList`'s path: a CLASS component's `setState`, in a callback it scheduled. */
class ClassUpdatesInAnImmediate extends Component<
  { arm: Arm; onFire: () => void },
  { fired: boolean }
> {
  state = { fired: false };
  componentDidMount() {
    this.props.arm(() => {
      setImmediate(() => {
        this.props.onFire();
        this.setState({ fired: true });
      });
    });
  }
  render() {
    return <Text>{this.state.fired ? 'fired' : 'waiting'}</Text>;
  }
}

/** A chain the component started and nobody awaits: it continues when `held` resolves. */
function ContinuesWhenReleased({ held, onLoaded }: { held: Promise<void>; onLoaded: () => void }) {
  const [data, setData] = useState('none');
  useEffect(() => {
    void held.then(() => {
      onLoaded();
      setData('loaded');
    });
  }, [held, onLoaded]);
  return <Text>{data}</Text>;
}

function armable() {
  let queue: (() => void) | undefined;
  const arm: Arm = (q) => {
    queue = q;
  };
  return {
    arm,
    fire: () => {
      if (!queue) throw new Error('the component never armed its callback');
      queue();
    },
  };
}

function held() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

it('does not flag an update made inside a timer callback during the teardown', async () => {
  const onFire = jest.fn();
  const { arm, fire } = armable();
  await render(<UpdatesInAnImmediate arm={arm} onFire={onFire} />);

  fire();
  expect(onFire).not.toHaveBeenCalled();
  await tearDown();

  expect(onFire).toHaveBeenCalledTimes(1);
  expect(audit.take()).toEqual([]);
});

it("does not flag a class component's setState inside a timer callback during the teardown", async () => {
  const onFire = jest.fn();
  const { arm, fire } = armable();
  await render(<ClassUpdatesInAnImmediate arm={arm} onFire={onFire} />);

  fire();
  expect(onFire).not.toHaveBeenCalled();
  await tearDown();

  expect(onFire).toHaveBeenCalledTimes(1);
  expect(audit.take()).toEqual([]);
});

it('flags an unawaited chain whose next step lands in the teardown', async () => {
  const onLoaded = jest.fn();
  const { promise, release } = held();
  await render(<ContinuesWhenReleased held={promise} onLoaded={onLoaded} />);

  // Resolved and never awaited: the continuation is queued, and runs inside
  // the teardown's `act`, which is the case the census cannot see.
  release();
  expect(onLoaded).not.toHaveBeenCalled();
  await tearDown();

  expect(onLoaded).toHaveBeenCalledTimes(1);
  const findings = audit.take();
  expect(findings).toHaveLength(1);
  expect(findings[0].frame).toContain('components/__tests__/actAudit.test.tsx');
});

it('prints through a console.error that a test spying on console.error cannot swallow', () => {
  // Several suites spy on or stub `console.error` (workoutsScreen, shareCard).
  // The audit's line must still reach the output, so `jest.setup.js` binds the
  // original before any test runs. This line is printed on purpose, and does
  // not carry the census phrase.
  const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
  try {
    report('act-audit control: printed on purpose, past a console.error spy');
    expect(spy).not.toHaveBeenCalled();
  } finally {
    spy.mockRestore();
  }
});

it('does not flag the same chain when the test lets it land before the teardown', async () => {
  const onLoaded = jest.fn();
  const { promise, release } = held();
  await render(<ContinuesWhenReleased held={promise} onLoaded={onLoaded} />);

  await act(async () => {
    release();
  });
  expect(onLoaded).toHaveBeenCalledTimes(1);
  await tearDown();

  expect(audit.take()).toEqual([]);
});
