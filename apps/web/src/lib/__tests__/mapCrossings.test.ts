import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { edgePath, layout, NODE_H, NODE_W } from "@/lib/roundMapLayout";
import type { RoundMap } from "@/lib/api";

/**
 * The two things about the drawn map that only a person could previously see.
 *
 * The layout tests next door cover the RULES — tier is ordering, rows are
 * ranked, same-row edges bow. These cover the RESULT, against the real content,
 * because the rules can all hold while the picture is still wrong. It was:
 * rendering the shipped map and looking at it found **six edges driving through
 * boxes** and, after the first fix, several leaving the canvas entirely.
 *
 * Reading the real `roundmap.json` rather than a fixture is the point. A
 * fixture would pass forever while the content it is meant to protect grew a
 * seventeenth node.
 */

const CONTENT = "backend/internal/modules/technique/roundmap.json";

function realMap(): RoundMap {
  // vitest runs from apps/web; the content lives at the repo root.
  const root = process.cwd().replace(/apps\/web$/, "");
  return JSON.parse(readFileSync(root + CONTENT, "utf8")) as RoundMap;
}

/** Sample a cubic bezier, parsed back out of the "M x y C ..." we emit. */
function samples(d: string, n = 240): [number, number][] {
  const v = d.match(/-?\d+(\.\d+)?/g)!.map(Number);
  const [x0, y0, x1, y1, x2, y2, x3, y3] = v;
  const out: [number, number][] = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const u = 1 - t;
    out.push([
      u * u * u * x0 + 3 * u * u * t * x1 + 3 * u * t * t * x2 + t * t * t * x3,
      u * u * u * y0 + 3 * u * u * t * y1 + 3 * u * t * t * y2 + t * t * t * y3,
    ]);
  }
  return out;
}

describe("the drawn round map", () => {
  it("routes every edge around the boxes it passes", () => {
    const map = realMap();
    const { placed, width } = layout(map.nodes);
    expect(placed.length).toBeGreaterThan(0);
    const byID = new Map(placed.map((n) => [n.id, n]));

    const crossings: string[] = [];
    for (const e of map.edges) {
      const a = byID.get(e.from)!;
      const b = byID.get(e.to)!;
      const pts = samples(edgePath(a, b, width));
      for (const n of placed) {
        if (n.id === e.from || n.id === e.to) continue;
        // Two pixels of tolerance: grazing a rounded corner is not something a
        // reader sees, and demanding perfection here would make the test
        // fragile against a corner-radius change.
        const pad = 2;
        const through = pts.some(
          ([x, y]) =>
            x > n.x + pad &&
            x < n.x + NODE_W - pad &&
            y > n.y + pad &&
            y < n.y + NODE_H - pad,
        );
        if (through) crossings.push(`${e.kind} ${e.from} → ${e.to} crosses ${n.id}`);
      }
    }
    expect(crossings).toEqual([]);
  });

  it("keeps every edge on the canvas", () => {
    // The first fix for the crossings swung long edges outward proportionally
    // to the rows they skipped, which put a three-row edge hundreds of pixels
    // past the left border — geometrically correct and half invisible. The
    // gutter lane replaced it; this is what stops the next attempt regressing.
    const map = realMap();
    const { placed, width, height } = layout(map.nodes);
    const byID = new Map(placed.map((n) => [n.id, n]));

    const escaped: string[] = [];
    for (const e of map.edges) {
      const a = byID.get(e.from)!;
      const b = byID.get(e.to)!;
      for (const [x, y] of samples(edgePath(a, b, width))) {
        if (x < 0 || x > width || y < 0 || y > height) {
          escaped.push(
            `${e.from} → ${e.to} leaves the canvas at ${Math.round(x)},${Math.round(y)}`,
          );
          break;
        }
      }
    }
    expect(escaped).toEqual([]);
  });

  it("draws something into every node, so no box floats unreachable", () => {
    // The default view is route + recover. Concede is opt-in, and route ALONE
    // was the original default — which left the four losing positions with no
    // arrows whatsoever, floating and reading as broken. That is the same
    // "a missing edge is invisible" failure the concede kind exists to prevent,
    // reintroduced by a default rather than by the content.
    const map = realMap();
    const shown = new Set(["route", "recover"]);
    const touched = new Set<string>();
    for (const e of map.edges) {
      if (!shown.has(e.kind)) continue;
      touched.add(e.from);
      touched.add(e.to);
    }
    const floating = map.nodes.filter((n) => !touched.has(n.id)).map((n) => n.id);
    expect(floating).toEqual([]);
  });
});
