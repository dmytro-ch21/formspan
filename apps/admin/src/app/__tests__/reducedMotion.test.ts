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
 * `apps/web` carries its own copy of this file for its own stylesheet —
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

/**
 * The innermost block header enclosing `index` — the text before its `{`.
 *
 * Walks braces rather than comparing `lastIndexOf("@layer")` with
 * `lastIndexOf("@media")`, which any comment mentioning either word would
 * silently fool. Shares `nestingDepthAt`'s one assumption: no braces in comments.
 */
function enclosingHeaderAt(source: string, index: number): string {
  // Delegates to `enclosingHeadersAt`. This helper's own copy of the boundary
  // logic had two bugs, exposed while guarding against ac-verifier's findings:
  // with no delimiter before a header it dropped the header's first character,
  // and it did not treat `{` as a boundary, so a layer nested inside a media
  // query read as unlayered. It only passed because a comment happened to sit
  // right before the one header it was ever asked about.
  return enclosingHeadersAt(source, index)[0] ?? "";
}

describe("Press feedback (L14)", () => {
  // Anchored on the RULE, not the class name. A comment naming `.pressable`
  // would otherwise become the anchor — the first-match trap this file already
  // guards against for the Reduce Motion marker.
  const RULE = ".pressable {";

  it("declares the rule exactly once", () => {
    expect(css.indexOf(RULE)).not.toBe(-1);
    expect(css.indexOf(RULE)).toBe(css.lastIndexOf(RULE));
  });

  it("is LAYERED, so the unlayered Reduce Motion rule above beats it", () => {
    // The assertion this ticket exists for. Unlayered, `.pressable` (0,1,0)
    // outranks the universal (0,0,0) Reduce Motion narrowing and its scale
    // keeps animating — parses fine, ships fine, ignores the setting.
    const index = css.indexOf(RULE);
    expect(nestingDepthAt(css, index)).toBeGreaterThan(0);
    expect(enclosingHeaderAt(css, index)).toMatch(/^@layer\b/);
  });

  it("does not look pressed while disabled (the action is in flight)", () => {
    expect(css).toMatch(/\.pressable:active:not\(:disabled\)\s*\{[^}]*transform:\s*scale\(0\.97\)/);
  });

  it("takes its timing from the generated motion scale, not from literals", () => {
    const start = css.indexOf(RULE);
    const rule = css.slice(start, css.indexOf("}", start));
    expect(rule).toContain("var(--duration-press)");
    expect(rule).toContain("var(--ease-out)");
    expect(rule).not.toMatch(/\d+ms/);
    expect(rule).not.toContain("cubic-bezier");
  });

  it("imports the motion scale as the FIRST statement, where the browser cannot drop it", () => {
    // An @import after any other rule is not an error; it is ignored. The vars
    // would be undefined and the transition would degrade with no signal.
    const first = css.replace(/\/\*[\s\S]*?\*\//g, "").trimStart();
    expect(first.startsWith('@import "./motion.generated.css";')).toBe(true);
  });

  it("the generated sheet defines both variables the rule uses", () => {
    const generated = readFileSync(
      fileURLToPath(new URL("../motion.generated.css", import.meta.url)),
      "utf8",
    );
    expect(generated).toMatch(/--duration-press:\s*\d+ms/);
    expect(generated).toMatch(/--ease-out:\s*cubic-bezier\(/);
  });
});

describe("Press feedback keeps its hit area (L14, review)", () => {
  // frontend-reviewer measured it: at scale(0.97) a press released inside the
  // shrunken band lands on the parent row and the button gets 0 clicks, while
  // having visibly acknowledged the press. The cover restores the target.
  const HIT = ".pressable:active:not(:disabled)::before {";
  const ruleAt = (marker: string) => {
    const i = css.indexOf(marker);
    return css.slice(i, css.indexOf("}", i));
  };

  it("restores the original target while the button is pressed", () => {
    expect(css.indexOf(HIT)).not.toBe(-1);
    expect(css.indexOf(HIT)).toBe(css.lastIndexOf(HIT));
    expect(ruleAt(HIT)).toMatch(/content:\s*""/);
    expect(ruleAt(HIT)).toMatch(/position:\s*absolute/);
  });

  it("sizes the cover as a PERCENTAGE, because the dead band scales with width", () => {
    // A fixed -2px covers an 88px button and leaves part of a 240px one's
    // 3.6px band uncovered.
    expect(ruleAt(HIT)).toMatch(/inset:\s*-\d+(\.\d+)?%/);
    expect(ruleAt(HIT)).not.toMatch(/inset:[^;]*px/);
  });

  it("positions the cover against the button, not some ancestor", () => {
    expect(ruleAt(".pressable {")).toMatch(/position:\s*relative/);
  });

  it("never exists at rest, so the target is never larger than the button", () => {
    // A bare `.pressable::before` would enlarge the target of an irreversible
    // write for every click, not just a press already in progress.
    expect(css).not.toMatch(/\.pressable::before/);
  });
});

/**
 * The header of the block whose opening brace is at `open`.
 *
 * All four boundaries count: a closing brace, a semicolon, an OPENING brace
 * (so a nested block's header does not swallow its parent's), and the end of a
 * comment. A comment end is only used when one exists — never as `-1 + 1`,
 * which read as position 0 and cut a header's first character off.
 */
function headerBefore(source: string, open: number): string {
  let cut = Math.max(
    source.lastIndexOf("}", open - 1),
    source.lastIndexOf(";", open - 1),
    source.lastIndexOf("{", open - 1),
  );
  const commentEnd = source.lastIndexOf("*/", open - 1);
  if (commentEnd !== -1) cut = Math.max(cut, commentEnd + 1);
  return source.slice(cut + 1, open).trim();
}

/** Every block header enclosing `index`, innermost first. */
function enclosingHeadersAt(source: string, index: number): string[] {
  const headers: string[] = [];
  let depth = 0;
  for (let i = index - 1; i >= 0; i--) {
    if (source[i] === "}") depth++;
    else if (source[i] === "{") {
      if (depth === 0) headers.push(headerBefore(source, i));
      else depth--;
    }
  }
  return headers;
}

/** `source` with every comment blanked to spaces, so indices still line up. */
const withoutComments = (source: string) =>
  source.replace(/\/\*[\s\S]*?\*\//g, (comment) => " ".repeat(comment.length));

/** Press rules that are not inside any `@layer`, by selector. */
const unlayeredPressRules = (source: string) => {
  const code = withoutComments(source);
  const rules = [...code.matchAll(/\.pressable[^{};]*\{/g)];
  return {
    count: rules.length,
    escaped: rules
      .filter((rule) => !enclosingHeadersAt(code, rule.index ?? 0).some((h) => /^@layer\b/.test(h)))
      .map((rule) => rule[0]),
  };
};

describe("No press rule can escape the layer (L14, ac-verifier)", () => {
  it("every rule whose selector names .pressable sits inside an @layer", () => {
    // `.pressable {` anchors only the BASE rule. A later `.pressable:hover`
    // written unlayered would outrank the Reduce Motion block and animate for
    // someone who asked for stillness, and the base-rule anchor would never
    // see it. Comments are blanked first, and ANY enclosing @layer counts.
    const { count, escaped } = unlayeredPressRules(css);
    expect(count).toBeGreaterThanOrEqual(3);
    expect(escaped).toEqual([]);
  });

  it("the guard itself catches what it exists for, and rejects nothing it should accept", () => {
    // A guard is only evidence if it can fail. Each shape is one the helpers
    // got wrong or could plausibly get wrong.
    expect(unlayeredPressRules(".pressable:hover { transform: scale(0.9); }").escaped).toEqual([
      ".pressable:hover {",
    ]);
    expect(unlayeredPressRules("@media all { .pressable:hover { color: red; } }").escaped).toHaveLength(1);
    expect(
      unlayeredPressRules("/* was; @layer components { */ .pressable:focus { transform: none; }").escaped,
    ).toHaveLength(1);
    expect(unlayeredPressRules("@media all { @layer components { .pressable:hover { color: red; } } }").escaped).toEqual([]);
    expect(unlayeredPressRules("@layer components { .pressable:hover { color: red; } }").escaped).toEqual([]);
    // The committed single-header helper now delegates to the fixed logic. Pin
    // that: reverting it to its old copy survived every other test (measured),
    // because on the real stylesheet a comment sits right before the header.
    const nested = "@media all { @layer components { .x { color: red; } } }";
    expect(enclosingHeaderAt(nested, nested.indexOf(".x"))).toBe("@layer components");
  });

  it("keeps the generated motion sheet unlayered, so the brand curve beats Tailwind's own", () => {
    // Tailwind v4 emits `--ease-out: cubic-bezier(0, 0, 0.2, 1)` inside
    // `@layer theme`. The brand value wins only because this sheet is
    // unlayered; put it in any layer and Tailwind's curve silently takes over.
    const generated = readFileSync(
      fileURLToPath(new URL("../motion.generated.css", import.meta.url)),
      "utf8",
    );
    expect(generated).not.toMatch(/@layer/);
  });
});
