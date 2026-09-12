import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

/**
 * F27 (#715) — that a finished session's set row actually prints the grip
 * through `heldGripLabel`, in the branch only a read-only row reaches.
 *
 * A source read, like `nutrition/__tests__/targetsPageWiring.test.ts`: this
 * app's tests run in node with no DOM, so the page cannot render here. What
 * the label says is pinned in `lib/__tests__/heldGrip.test.ts`; what only the
 * source can show is that the row goes through it.
 */
const source = readFileSync(fileURLToPath(new URL("../[id]/page.tsx", import.meta.url)), "utf8");

it("actually read the page", () => {
  expect(source).toContain("function SetRow({");
});

describe("the grip a finished set was held in", () => {
  it("comes from the set's own grip, through the helper", () => {
    expect(source).toContain("const heldGrip = heldGripLabel(set.grip);");
  });

  it("prints in the branch after the editable picker, with a hidden 'grip' for a screen reader", () => {
    const picker = source.indexOf("editable && offeredGrips(offeredGripKeys, set.grip).length > 0 ? (");
    const readOnly = source.indexOf("heldGrip && (", picker);
    expect(picker).toBeGreaterThan(-1);
    expect(readOnly).toBeGreaterThan(picker);
    const branch = source.slice(readOnly, source.indexOf("\n          )", readOnly));
    expect(branch).toContain("{heldGrip}");
    expect(branch).toContain('<span className="sr-only"> grip</span>');
    // A `title` only ever reached a mouse; the hidden text replaces it.
    expect(branch).not.toContain("title=");
  });

  it("leaves no second, hand-rolled grip label on the page", () => {
    expect(source).not.toContain("GRIPS.find(");
  });
});
