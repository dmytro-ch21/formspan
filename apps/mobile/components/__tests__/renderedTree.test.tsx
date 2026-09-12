import { useEffect, useRef, useState } from 'react';
import { Text, View } from 'react-native';
import { render, renderHook, screen, waitFor } from '@testing-library/react-native';

import { hasRenderedTree } from '../../lib/__tests__/support/renderedTree';

/**
 * F56 (#1135) — pins the one signal `jest.setup.js`'s teardown trusts when it
 * skips its macrotask boundary, and what that teardown must still do.
 *
 * The tests are ORDERED on purpose: each test's teardown is part of what the
 * next one checks. Getting this wrong in one direction costs the F56 immunity;
 * getting it wrong in the other skips `cleanup()` on a tree that is still
 * mounted, and that tree then leaks into whichever test runs next.
 */
describe('hasRenderedTree', () => {
  it('is false when the test rendered nothing', () => {
    expect(hasRenderedTree(screen)).toBe(false);
  });

  it('is true after render', async () => {
    await render(
      <View>
        <Text>rendered</Text>
      </View>,
    );
    expect(hasRenderedTree(screen)).toBe(true);
  });

  it('is false again in the next test, because the rendered test above was torn down', () => {
    expect(hasRenderedTree(screen)).toBe(false);
  });

  it('is true after renderHook, whose screen.root is undefined rather than a throw', async () => {
    await renderHook(() => useState(0));
    expect(hasRenderedTree(screen)).toBe(true);
  });

  it('is true for a component that renders null', async () => {
    const Nothing = () => null;
    await render(<Nothing />);
    expect(hasRenderedTree(screen)).toBe(true);
  });

  it('is true after a manual unmount, so cleanup still runs', async () => {
    const result = await render(
      <View>
        <Text>unmounted by the test</Text>
      </View>,
    );
    await result.unmount();
    expect(hasRenderedTree(screen)).toBe(true);
  });

  it('treats any other error as rendered, so a reworded RNTL message never skips cleanup', () => {
    const throwing = (err: unknown) => ({
      get root(): unknown {
        throw err;
      },
    });
    expect(hasRenderedTree(throwing(new Error('`render` function has not been called')))).toBe(false);
    expect(hasRenderedTree(throwing(new Error('something else entirely')))).toBe(true);
    expect(hasRenderedTree(throwing('not even an Error'))).toBe(true);
  });
});

/**
 * "Nothing rendered" is not "nothing to clean up". RNTL's `cleanup()` also
 * drains a queue that `waitFor` registers its poll in, whether or not anything
 * was rendered. A teardown that skipped `cleanup()` for an unrendered test
 * left that poll running into the next test — measured on this branch's first
 * fix: the next test saw it fire 5–9 times in 60ms, and jest reported an open
 * handle. F47's teardown, which always cleans up, saw 0.
 */
describe('the teardown drains RNTL\'s cleanup queue even when nothing was rendered', () => {
  let polls = 0;

  it('starts an RNTL waitFor that never settles, renders nothing, and returns', () => {
    void waitFor(
      () => {
        polls += 1;
        throw new Error('never satisfied');
      },
      { timeout: 60_000, interval: 5 },
    ).catch(() => {});
    expect(hasRenderedTree(screen)).toBe(false);
  });

  it('sees no further polls in the next test', async () => {
    const before = polls;
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(polls).toBe(before);
  });
});

/**
 * F47's other promise: work that is DUE when a rendered test's body returns
 * still runs — inside `act`, in the teardown's real yield — before the unmount
 * clears it. "The pending work still RUNS, inside `act`; nothing is
 * swallowed."
 *
 * This is also the only observable proof that a rendered test was recognised
 * as rendered. Since the short path runs `cleanup()` too, a detection that
 * wrongly said "nothing rendered" would still unmount — it would just do it
 * first, clearing the timer instead of running it. No warning fires either
 * way (React does not warn about work on an unmounted tree), so F47's
 * warning-based controls cannot see that mistake. Measured: a destructured
 * `screen` and an always-false detection both passed every other check here.
 *
 * The timer is armed synchronously in the test body, after `render` has
 * returned, so it cannot fire inside `render`'s own `act` on a loaded host.
 */
describe('a rendered test still gets the full teardown: work due at its end runs before unmount', () => {
  let fired = 0;
  let arm: () => void = () => {};

  function ArmsOnRequest() {
    const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
    useEffect(() => {
      arm = () => {
        timer.current = setTimeout(() => {
          fired += 1;
        }, 5);
      };
      return () => {
        if (timer.current) clearTimeout(timer.current);
      };
    }, []);
    return <Text>arms a timer on request</Text>;
  }

  it('renders, then arms a 5ms timer that is due when the body returns', async () => {
    await render(<ArmsOnRequest />);
    arm();
    const until = Date.now() + 30;
    while (Date.now() < until) {
      // hold the thread: the timer is now due, and has not had a chance to run
    }
    expect(fired).toBe(0);
  });

  it('sees that the timer ran in that teardown, before the unmount could clear it', () => {
    expect(fired).toBe(1);
  });
});
