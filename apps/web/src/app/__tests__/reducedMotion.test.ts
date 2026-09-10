import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

/**
 * F40 — the Reduce Motion floor, as a check rather than a one-off grep.
 *
 * The gap this closes was found by an audit, not by anything in the pipeline:
 * `prefers-reduced-motion` appeared NOWHERE in `apps/web` or `apps/admin`,
 * against 100 `transition` utilities and 11 infinite `animate-pulse` loops. A
 * grep that is true the day it is written is exactly what let that happen, so
 * the invariant is asserted here instead.
 *
 * `apps/admin` carries its own copy of this file for its own stylesheet —
 * each app checks the sheet it ships, rather than one app reaching across.
 */
const css = readFileSync(fileURLToPath(new URL("../globals.css", import.meta.url)), "utf8");

/** The rule's body, or null if the at-rule is absent. */
function reducedMotionBlock(source: string): string | null {
  const start = source.indexOf("@media (prefers-reduced-motion: reduce)");
  if (start === -1) return null;
  const open = source.indexOf("{", start);
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === "{") depth++;
    else if (source[i] === "}" && --depth === 0) return source.slice(open + 1, i);
  }
  return null;
}

/** How many unclosed `{` precede an index — 0 means the rule is top level. */
function nestingDepthAt(source: string, index: number): number {
  let depth = 0;
  for (let i = 0; i < index; i++) {
    if (source[i] === "{") depth++;
    else if (source[i] === "}") depth--;
  }
  return depth;
}

describe("Reduce Motion (F40)", () => {
  it("declares a prefers-reduced-motion block at all", () => {
    expect(reducedMotionBlock(css)).not.toBeNull();
  });

  it("names the block exactly once, so the brace matching above cannot pick the wrong one", () => {
    // Raised in review, and the reason is this repo's own history: an anchor
    // taken by FIRST match is safe right up until a later comment quotes the
    // string it anchors on — which is exactly how `history.md`'s heading trap
    // works, and this file's house style is to quote config verbatim in prose.
    // The parser below is only correct while the marker is unique; assert it.
    const marker = "@media (prefers-reduced-motion: reduce)";
    expect(css.indexOf(marker)).toBe(css.lastIndexOf(marker));
  });

  it("keeps `filter`, so the primary CTA's hover does not simply snap", () => {
    // `hover:brightness-110` is this app's solid-button hover and every one of
    // its call sites pairs it with `transition`. Brightness is luminance, not
    // movement — dropping it would be the "too aggressive" failure the block
    // warns about, rather than the caution it looks like.
    const property = /transition-property:([^;]*);/.exec(reducedMotionBlock(css)!)?.[1] ?? "";
    expect(property).toContain("filter");
  });

  it("narrows the transition list rather than disabling transitions outright", () => {
    const block = reducedMotionBlock(css)!;
    // Reduce Motion is a request not to be MOVED, not a request to see
    // nothing: the colour feedback that explains a state change is kept.
    expect(block).toMatch(/transition-property:\s*[^;]*opacity/);
    expect(block).toMatch(/transition-property:\s*[^;]*color/);
    // `transition: none` and the `0.01ms` trick both fail this, deliberately.
    expect(block).not.toMatch(/transition:\s*none/);
  });

  it("drops movement — no transform, translate, scale or rotate survives", () => {
    const property = /transition-property:([^;]*);/.exec(reducedMotionBlock(css)!)?.[1] ?? "";
    for (const moving of ["transform", "translate", "scale", "rotate"]) {
      expect(property).not.toContain(moving);
    }
  });

  it("stops the infinite skeleton loops, by an explicit rule", () => {
    // A `transition-property` narrowing does not touch `animation`, so without
    // its own line the pulse loops forever — the case Reduce Motion most often
    // exists for.
    expect(reducedMotionBlock(css)!).toMatch(/\.animate-pulse\s*\{[^}]*animation(-iteration-count)?:/);
  });

  it("is UNLAYERED, or it would silently lose to Tailwind's utilities", () => {
    // This is the assertion worth having. An unlayered declaration beats every
    // layered one; layered into `base`, this whole block would parse fine, ship
    // fine, and do nothing at all — the failure mode with no symptom.
    const index = css.indexOf("@media (prefers-reduced-motion: reduce)");
    expect(nestingDepthAt(css, index)).toBe(0);
  });
});
