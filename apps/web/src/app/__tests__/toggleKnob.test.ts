import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

/**
 * F39 — the discipline toggle's knob, which never animated.
 *
 * The author wrote `transition` intending the knob to slide and it teleported,
 * for as long as the control has existed. Tailwind's bare `transition` utility
 * animates a curated list of 23 properties and **`margin` is not among them**,
 * so `ml-0 ↔ ml-4` could never have moved. The track's colour DID animate, so
 * the control read as half-finished rather than broken and nobody reported it.
 *
 * That is the shape worth guarding: a transition naming a property the utility
 * does not animate is silent — it compiles, ships, and does nothing. A source
 * test is the cheapest thing that can see it, because the rendered page looks
 * plausible either way.
 */
const source = readFileSync(
  fileURLToPath(new URL("../dashboard/settings/page.tsx", import.meta.url)),
  "utf8",
);

/** The knob's className block — the inner `<span>`, not the track. */
function knobClasses(src: string): string {
  const marker = "block h-5 w-5 rounded-pill";
  const start = src.indexOf(marker);
  expect(start, "the knob's marker classes should appear exactly once").toBe(src.lastIndexOf(marker));
  return src.slice(start, src.indexOf("`}", start));
}

describe("the discipline toggle's knob (F39)", () => {
  it("moves by translate, not by margin", () => {
    const knob = knobClasses(source);
    expect(knob).toContain("translate-x-4");
    expect(knob).toContain("translate-x-0");
    // The regression: `margin` is not in ANY Tailwind transition property list,
    // so a knob moved by margin cannot animate however the transition is named.
    expect(knob).not.toMatch(/\bml-\d/);
  });

  it("names a duration and an easing rather than inheriting the default", () => {
    const knob = knobClasses(source);
    expect(knob).toMatch(/duration-/);
    expect(knob).toMatch(/ease-/);
  });

  it("references the motion tokens with the syntax that actually compiles", () => {
    // Measured, not assumed: written with SQUARE brackets, the same token
    // reference emits a bare `transition-duration: --duration-control` —
    // invalid CSS, silently ignored, falling back to the 150ms default. The
    // parenthesis form emits `var(...)`. Both look equally correct in a diff,
    // which is why this is asserted.
    //
    // The broken form is described rather than written out on purpose:
    // Tailwind v4's scanner extracts class candidates from raw file text,
    // comments included, so spelling it here would emit that invalid rule into
    // the production bundle. It did, until this comment was reworded.
    const knob = knobClasses(source);
    expect(knob).toContain("duration-(--duration-control)");
    expect(knob).toContain("ease-(--ease-out)");
    expect(knob).not.toMatch(/duration-\[--/);
    expect(knob).not.toMatch(/ease-\[--/);
  });

  it("transitions only what it actually changes", () => {
    // Narrowed rather than bare: the knob changes exactly two things, and
    // saying so is what makes the next reader able to check it.
    expect(knobClasses(source)).toContain("transition-[translate,background-color]");
  });
});
