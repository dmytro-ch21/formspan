import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

/**
 * N559 — the entrance layer, asserted where the decisions live.
 *
 * Every conditionally-mounted surface in this app hard-mounted: two popovers
 * appeared from nowhere instead of from the button that opened them, and the
 * only modal dropped a 70%-black scrim with no motion. These pin the four
 * choices that are easy to undo by accident and invisible in a screenshot.
 */
const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");

const css = read("../globals.css");
const share = read("../../components/ShareToFriend.tsx");
const sessions = read("../dashboard/sessions/page.tsx");
const workouts = read("../dashboard/workouts/page.tsx");
const heatmap = read("../dashboard/sessions/TrainingCalendar.tsx");

/**
 * A CSS rule body by selector, with COMMENTS STRIPPED, or null.
 *
 * Stripping matters and is not defensive tidiness: `.dialog-in`'s body carries
 * a comment explaining that it deliberately sets no `transform-origin`, and an
 * assertion that the rule does not CONTAIN that string matches the explanation
 * and fails against correct code. This repo has been caught by a comment
 * satisfying a text match several times; assert against code.
 */
function rule(selector: string): string | null {
  // Find the selector at TOP LEVEL — not nested inside an at-rule.
  //
  // `.popover-in` and `.dialog-in` each appear a second time inside the
  // `prefers-reduced-motion` block as part of a combined selector, so a plain
  // `indexOf` can match the override instead of the base rule. Bounding the
  // search by file position would fix that only while the definitions happen
  // to come first; depth is the property that actually distinguishes them, and
  // it survives the file being reordered. Raised in review — the same
  // first-match hazard this helper's comment-stripping already escapes once.
  let depth = 0;
  for (let i = 0; i < css.length; i++) {
    if (css[i] === "{") depth++;
    else if (css[i] === "}") depth--;
    else if (depth === 0 && css.startsWith(`${selector} {`, i)) {
      const body = css.slice(i, css.indexOf("}", i));
      return body.replace(/\/\*[\s\S]*?\*\//g, "");
    }
  }
  return null;
}


describe("the entrance layer (N559)", () => {
  it("gives both trigger-anchored popovers the same entrance", () => {
    expect(share).toContain("popover-in");
    expect(sessions).toContain("popover-in");
  });

  it("grows a popover from its trigger's corner, not its own centre", () => {
    // Without this the panel inflates symmetrically and reads as "appeared"
    // rather than "opened from there". Both popovers are `right-0`-anchored.
    expect(rule(".popover-in")).toMatch(/transform-origin:\s*top right/);
  });

  it("does NOT give the modal dialog an origin — a modal is anchored to nothing", () => {
    // The mistake the popovers exist to fix, applied where it does not belong.
    expect(rule(".dialog-in")).not.toContain("transform-origin");
  });

  it("fades the scrim and scales the dialog on the same duration", () => {
    // A scrim that lands before its dialog reads as two events, not one.
    expect(workouts).toContain("scrim-in");
    expect(workouts).toContain("dialog-in");
    expect(rule(".scrim-in")).toContain("var(--duration-sheet)");
    expect(rule(".dialog-in")).toContain("var(--duration-sheet)");
  });

  it("adds NO exit animation anywhere", () => {
    // P4's boundary. An unmount cannot be animated without holding the element
    // past the state change — a component-architecture change, not a motion one.
    expect(css).not.toMatch(/@keyframes\s+[a-z-]*-out\b/);
  });

  it("gates the heatmap's growth behind a real pointer, and shrinks it", () => {
    // `hover:` alone fires on TAP and leaves the cell inflated. 125% on a 12px
    // cell rendered ~365 times a view was the largest transform in the app.
    expect(heatmap).toContain("fine-hover:hover:scale-110");
    expect(heatmap).not.toContain("hover:scale-125");
    expect(css).toContain("@custom-variant fine-hover");
  });

  it("touches exactly two of the bare transition utilities", () => {
    // The other ~99 are colour hovers, correctly served by the default curve;
    // a 100-site diff would be unreviewable. Counted, not eyeballed.
    const eased = [sessions, workouts, share, heatmap, read("../dashboard/calendar/page.tsx"), read("../dashboard/workouts/[id]/page.tsx")]
      .join("\n")
      .match(/transition[^"`]*ease-\(--ease-out\)/g);
    expect(eased).toHaveLength(2);
  });

  it("neutralises its own entrances under Reduce Motion", () => {
    // F40's block narrows `transition-property`; it does not touch `animation`,
    // so these would keep SCALING without their own override. The fade is kept
    // — an entrance that explains where a surface came from is worth having.
    const reduced = css.slice(css.indexOf("@media (prefers-reduced-motion: reduce)"));
    expect(reduced).toMatch(/\.popover-in,\s*\n?\s*\.dialog-in\s*\{[^}]*animation-name:\s*fade-in/);
    // And the heatmap must not grow at all — instant growth is still growth.
    expect(reduced).toMatch(/fine-hover.*scale-110:hover\s*\{[^}]*scale:\s*1/);
  });
});
