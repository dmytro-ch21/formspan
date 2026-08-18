import { describe, expect, it } from "vitest";

import {
  bandOf,
  edgePath,
  layout,
  NODE_H,
  PAD_TOP,
  ROW_H,
  type Placed,
} from "@/lib/roundMapLayout";
import type { RoundMapNode } from "@/lib/api";

const node = (id: string, tier: number): RoundMapNode => ({
  id,
  label: id,
  position_id: id,
  position: id,
  tier,
  note: "n",
});

describe("layout", () => {
  it("puts each distinct tier on its own row, best first", () => {
    const { placed } = layout([node("a", 0), node("c", 5), node("b", 3)]);
    const rows = placed
      .slice()
      .sort((x, y) => x.y - y.y)
      .map((p) => p.id);
    expect(rows).toEqual(["c", "b", "a"]);
  });

  it("treats tier as ordering, not arithmetic", () => {
    // The load-bearing one. Tiers 5 and 0 are ADJACENT rows: there is nothing
    // between them on the map, and the numeric gap of five means nothing.
    // Spacing by tier value would put four empty rows here.
    const { placed, height } = layout([node("top", 5), node("bottom", 0)]);
    const ys = placed.map((p) => p.y).sort((a, b) => a - b);
    expect(ys[1] - ys[0]).toBe(ROW_H);
    expect(height).toBe(PAD_TOP + 2 * ROW_H);
  });

  it("gives nodes of equal tier the same row and centres them", () => {
    const { placed, width } = layout([
      node("a", 3),
      node("b", 3),
      node("c", 3),
      node("solo", 5),
    ]);
    const row = placed.filter((p) => p.tier === 3);
    expect(new Set(row.map((p) => p.y)).size).toBe(1);

    // Centred: the gap to the left edge equals the gap to the right edge.
    const solo = placed.find((p) => p.id === "solo")!;
    const left = Math.min(...row.map((p) => p.x));
    const right = width - Math.max(...row.map((p) => p.x + 168));
    expect(Math.round(left)).toBe(Math.round(right));
    // And a one-node row is centred against the widest row, not left-aligned.
    expect(Math.round(solo.x + 168 / 2)).toBe(Math.round(width / 2));
  });

  it("is empty rather than NaN-wide for an empty map", () => {
    // Math.max of no arguments is -Infinity, which propagates into the viewBox
    // and blanks the whole diagram with no error anywhere.
    expect(layout([])).toEqual({ placed: [], width: 0, height: 0 });
  });
});

describe("bandOf", () => {
  const bands = [
    { min_tier: 1, label: "ahead", note: "" },
    { min_tier: 0, label: "even", note: "" },
    { min_tier: -99, label: "behind", note: "" },
  ];

  it("takes the first band a tier clears, not the last", () => {
    expect(bandOf(bands, 4)?.label).toBe("ahead");
    expect(bandOf(bands, 1)?.label).toBe("ahead");
    expect(bandOf(bands, 0)?.label).toBe("even");
    expect(bandOf(bands, -3)?.label).toBe("behind");
  });

  it("returns null rather than guessing when nothing matches", () => {
    expect(bandOf([{ min_tier: 0, label: "x", note: "" }], -1)).toBeNull();
  });
});

describe("edgePath", () => {
  const at = (x: number, y: number): Placed => ({ ...node("n", 0), x, y });

  it("bows a same-row edge instead of running through what sits between", () => {
    const d = edgePath(at(0, 500), at(400, 500));
    const ys = [...d.matchAll(/-?\d+(?:\.\d+)?\s+(-?\d+(?:\.\d+)?)/g)].map((m) =>
      Number(m[1]),
    );
    // Some control point leaves the row's own line; a straight segment would
    // have every y identical.
    expect(new Set(ys).size).toBeGreaterThan(1);
  });

  it("bows a top-row same-row edge downward, where there is room", () => {
    const d = edgePath(at(0, PAD_TOP), at(400, PAD_TOP));
    const ys = [...d.matchAll(/-?\d+(?:\.\d+)?\s+(-?\d+(?:\.\d+)?)/g)].map((m) =>
      Number(m[1]),
    );
    expect(Math.max(...ys)).toBeGreaterThan(PAD_TOP + NODE_H);
    // Never above the canvas, which is what bowing upward here would do.
    expect(Math.min(...ys)).toBeGreaterThanOrEqual(0);
  });

  it("leaves the bottom of the box going down and the top going up", () => {
    expect(edgePath(at(0, 100), at(0, 300)).startsWith(`M 84 ${100 + NODE_H}`)).toBe(true);
    expect(edgePath(at(0, 300), at(0, 100)).startsWith("M 84 300")).toBe(true);
  });
});
