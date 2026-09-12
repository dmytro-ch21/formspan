import { useState } from 'react';
import { Text, View } from 'react-native';
import { render, renderHook, screen } from '@testing-library/react-native';

import { hasRenderedTree } from '../../lib/__tests__/support/renderedTree';

/**
 * F56 (#1135) — pins the one signal `jest.setup.js`'s teardown trusts when it
 * skips its macrotask boundary.
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
