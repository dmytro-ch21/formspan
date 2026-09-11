/**
 * N550/#1002 — walking the rendered tree, after RNTL 14 removed the API that
 * used to do it.
 *
 * RNTL 13 peered on `react-test-renderer`, whose root node carried
 * `findAllByType`. RNTL 14 peers on `test-renderer` instead — a deliberate
 * replacement for the now-deprecated React Test Renderer — and its node
 * exposes only `type`, `props` and `children`. Fifteen call sites in this
 * repo reached for `screen.root.findAllByType('RNSVGPath')` and have nowhere
 * to reach any more.
 *
 * The queries RNTL prefers (`getByTestId`, `getByRole`) cannot replace these:
 * they find what a PERSON can see, and these assertions are about SVG
 * primitives a chart emitted — `RNSVGPath`, `RNSVGCircle` — which carry no
 * role, no label and no testID. That is the right reason to reach past the
 * public API, and the reason this helper exists rather than the tests being
 * rewritten to assert something weaker.
 */

export type TreeNode = {
  type: unknown;
  props: Record<string, unknown>;
  children?: readonly (TreeNode | string)[] | null;
};

/**
 * Every node of the given host type, depth-first.
 *
 * Takes a possibly-null root because `screen.root` is nullable in RNTL 14 —
 * a component that rendered nothing has no root, and returning `[]` for it
 * says the same thing the assertion wants ("no paths were drawn") without
 * every call site repeating a null check.
 */
export function findAllByType(root: TreeNode | null | undefined, type: string): TreeNode[] {
  const out: TreeNode[] = [];
  const walk = (node: TreeNode | string | null | undefined): void => {
    if (!node || typeof node === 'string') return;
    if (node.type === type) out.push(node);
    for (const child of node.children ?? []) walk(child);
  };
  walk(root);
  return out;
}

/**
 * Every node in the tree, depth-first — for the cases that filtered on a prop
 * rather than a type. `root.findAll(predicate)` was react-test-renderer's;
 * RNTL 14's node has no query API at all, so the walk is explicit and the
 * predicate stays at the call site where it is readable.
 */
export function collectNodes(root: TreeNode | null | undefined): TreeNode[] {
  const out: TreeNode[] = [];
  const walk = (node: TreeNode | string | null | undefined): void => {
    if (!node || typeof node === 'string') return;
    out.push(node);
    for (const child of node.children ?? []) walk(child);
  };
  walk(root);
  return out;
}

/**
 * The view wrapping each native `<Switch>` — the nodes F43/#1042's invariant
 * is about.
 *
 * Found by looking for a node that HAS a switch as a direct child rather than
 * by walking up from the switch, because RNTL 14's node carries no `parent`
 * pointer (see the note at the top of this file on what the `test-renderer`
 * swap removed).
 *
 * Shared rather than copied because the invariant holds at three call sites
 * and a per-file copy is how two of them would drift apart. Compare its length
 * against the switch count at the call site: a loop over zero wrappers passes
 * vacuously, which is exactly the shape of the two assertions that had to be
 * rewritten when this was first written.
 */
export function switchWrappers(root: TreeNode | null | undefined): TreeNode[] {
  return collectNodes(root).filter((n) =>
    (n.children ?? []).some((c) => typeof c !== 'string' && c.type === 'RCTSwitch'),
  );
}
