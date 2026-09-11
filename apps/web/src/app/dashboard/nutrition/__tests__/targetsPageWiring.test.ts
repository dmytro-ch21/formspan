import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

/**
 * N127 (#531) — that the page is actually wired to `targetsState.tsx` and
 * `lib/manualTarget.ts`.
 *
 * A source read, like `toggleKnob.test.ts`: this app's tests run in node with
 * no DOM, so the page's effects cannot run here. The behaviour is pinned in
 * `targetsState.test.tsx` and `lib/__tests__/manualTarget.test.ts`; what only
 * the source can show is that the page goes through them, and that "No target
 * yet" sits inside the branch only a successful read reaches.
 */
const source = readFileSync(fileURLToPath(new URL("../targets/page.tsx", import.meta.url)), "utf8");

it("actually read the page", () => {
  expect(source).toContain("export default function NutritionTargetPage");
});

describe("the load gate", () => {
  it("renders from the view, and 'No target yet' only after the failed branch — in the ready one", () => {
    expect(source).toContain("const view = targetsView(loaded, loadError);");
    const loadingBranch = source.indexOf('{view === "loading" ? (');
    const failedBranch = source.indexOf('view === "failed" ? (');
    // The rendered sentence, not the bare phrase — the page's own comments
    // quote "No target yet" while explaining this fix.
    const noTarget = source.indexOf("No target yet. Derive one below");
    expect(source.split("No target yet. Derive one below").length - 1).toBe(1);
    expect(loadingBranch).toBeGreaterThan(-1);
    expect(failedBranch).toBeGreaterThan(loadingBranch);
    expect(source.indexOf("<TargetsLoadFailed", failedBranch)).toBeGreaterThan(failedBranch);
    expect(noTarget).toBeGreaterThan(failedBranch);
  });

  it("loads through loadTargetsInto, into its own error slot", () => {
    expect(source).toContain("await loadTargetsInto(");
    expect(source).toContain("{ setTargets, setAdjustment, setLoaded, setLoadError }");
  });

  it("renders the history through TargetHistory, with no unguarded label lookup left", () => {
    expect(source).toContain("<TargetHistory targets={targets} />");
    expect(source).not.toContain("SOURCE_LABEL[");
  });
});

describe("the typed target", () => {
  it("is validated by the server's rails, and submits what they parsed", () => {
    expect(source).toContain("parseManualTarget(");
    expect(source).toContain("disabled={!parsed.ok || saving}");
    expect(source).toContain("onSave({ effective_on: on, ...parsed.input });");
    expect(source).not.toMatch(/Number\(fibre\)/);
  });
});
