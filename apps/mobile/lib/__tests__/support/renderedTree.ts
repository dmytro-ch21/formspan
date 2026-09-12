/**
 * F56 (#1135) — whether a test left anything for RNTL's `cleanup()` to tear down.
 *
 * `jest.setup.js`'s teardown hook reads this to decide whether it has to cross
 * a macrotask boundary at all; that hook's comment says why the boundary is
 * the whole problem.
 *
 * The signal is RNTL's `screen.root` THROWING "`render` function has not been
 * called", and nothing else. Measured on RNTL 14.0.1: after `renderHook`, after
 * rendering a component that returns `null`, and after a manual `unmount()`,
 * `screen.root` returns `undefined` WITHOUT throwing. A truthiness check would
 * therefore call a mounted hook host "nothing rendered" and skip its cleanup,
 * leaking it into the next test.
 *
 * Any OTHER error counts as rendered. If RNTL ever rewords the message, every
 * test takes the full teardown again: that gives up F56's immunity, and it
 * never skips a cleanup. `components/__tests__/renderedTree.test.tsx` pins each
 * of these cases.
 */
export const NOT_RENDERED = /`render` function has not been called/;

export function hasRenderedTree(screen: { readonly root: unknown }): boolean {
  try {
    void screen.root;
    return true;
  } catch (e) {
    return !NOT_RENDERED.test(e instanceof Error ? e.message : String(e));
  }
}
