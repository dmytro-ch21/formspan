import { useState } from 'react';
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
