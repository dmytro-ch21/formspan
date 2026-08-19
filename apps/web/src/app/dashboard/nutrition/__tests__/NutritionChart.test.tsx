import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { NutritionChart } from "../NutritionChart";
import { buildSeries, dateRange } from "@/lib/nutritionSeries";
import type { DayTotals } from "@/lib/nutritionApi";

/**
 * The rendering half of the two honesty rules.
 *
 * `nutritionSeries.test.ts` pins the arithmetic: an unlogged day is `null`, and
 * a mean carries its denominator. Neither of those guarantees the PICTURE is
 * honest — a component is perfectly free to render a `null` as a zero-height
 * bar sitting on the axis, or to join two segments across a gap, and the pure
 * tests would stay green through both.
 *
 * That is a render-path property, so it is covered in the render path. No
 * jsdom: `renderToStaticMarkup` gives the markup, and what the markup contains
 * is the whole question.
 */

function day(eaten_on: string, kcal: number): DayTotals {
  return {
    eaten_on,
    entries: 2,
    kcal,
    protein_g: 150,
    carb_g: 200,
    fat_g: 70,
    fibre_g: null,
    target_kcal: 2000,
    target_protein_g: 150,
  };
}

/** Bars carry `fill-lime` and nothing else in this component does. */
function countBars(html: string): number {
  return (html.match(/class="fill-lime"/g) ?? []).length;
}

/** The rolling-mean line is the only `stroke-text` path. */
function countMeanPaths(html: string): number {
  return (html.match(/<path [^>]*class="stroke-text"/g) ?? []).length;
}

const EMPTY = { targets: [], checkins: [], training: [] };

describe("rule 1, as a picture", () => {
  it("draws a bar for every logged day and none for the rest", () => {
    const points = buildSeries({
      from: "2026-08-01",
      to: "2026-08-10",
      days: [day("2026-08-01", 2000), day("2026-08-05", 2100), day("2026-08-10", 1900)],
      ...EMPTY,
    });
    const html = renderToStaticMarkup(<NutritionChart points={points} units="metric" />);

    expect(points).toHaveLength(10);
    // Three, not ten. A version that renders every day and lets the unlogged
    // ones come out at zero height would give ten here, and would look like a
    // week of fasting on screen.
    expect(countBars(html)).toBe(3);
  });

  it("breaks the mean line across a gap rather than spanning it", () => {
    // Logged, then a silence longer than the 7-day window (so the mean genuinely
    // has nothing to say in the middle), then logged again.
    const points = buildSeries({
      from: "2026-08-01",
      to: "2026-08-30",
      days: [
        ...dateRange("2026-08-01", "2026-08-05").map((d) => day(d, 2000)),
        ...dateRange("2026-08-20", "2026-08-30").map((d) => day(d, 2000)),
      ],
      ...EMPTY,
    });
    const html = renderToStaticMarkup(<NutritionChart points={points} units="metric" />);

    // Two paths, not one. One path would be a line drawn straight over eleven
    // days nobody recorded — a claim about them, in the most persuasive form
    // available, because it looks like data.
    expect(countMeanPaths(html)).toBe(2);
    expect(points.some((p) => p.mean === null)).toBe(true);
  });

  it("says 'nothing logged' for a gap in the accessible reading", () => {
    const points = buildSeries({
      from: "2026-08-01",
      to: "2026-08-02",
      days: [day("2026-08-01", 2000)],
      ...EMPTY,
    });
    const html = renderToStaticMarkup(<NutritionChart points={points} units="metric" />);

    // A sighted reader sees the gap. A screen-reader user would otherwise
    // simply never hear the day, which turns the honest gap back into silence.
    expect(html).toContain("nothing logged");
  });
});

describe("rule 2, as a picture", () => {
  it("puts the day count in the text for every rolling mean it draws", () => {
    const points = buildSeries({
      from: "2026-08-07",
      to: "2026-08-07",
      days: [day("2026-08-05", 1800), day("2026-08-06", 2200), day("2026-08-07", 2000)],
      ...EMPTY,
    });
    const html = renderToStaticMarkup(<NutritionChart points={points} units="metric" />);

    expect(html).toContain("7-day mean 2000 kcal");
    // The denominator travels with it, in the same sentence, in both the hover
    // title and the screen-reader row — they come from one function so they
    // cannot disagree.
    expect(html).toContain("from 3 of 7 days");
  });
});

describe("degenerate inputs", () => {
  it("renders a window with nothing in it without dividing by zero", () => {
    const points = buildSeries({
      from: "2026-08-01",
      to: "2026-08-07",
      days: [],
      ...EMPTY,
    });
    const html = renderToStaticMarkup(<NutritionChart points={points} units="metric" />);

    expect(countBars(html)).toBe(0);
    expect(countMeanPaths(html)).toBe(0);
    // A NaN in a `d` or a `y` attribute is how an SVG silently renders
    // nothing, so assert its absence rather than assuming the axis held.
    expect(html).not.toContain("NaN");
  });

  it("does not draw a weight axis when no trend point exists", () => {
    const points = buildSeries({
      from: "2026-08-01",
      to: "2026-08-07",
      days: [day("2026-08-01", 2000)],
      targets: [],
      // Two readings — one short of the three a trend point needs.
      checkins: [
        { user_id: "u", measured_on: "2026-08-01", weight_kg: 80, notes: "" },
        { user_id: "u", measured_on: "2026-08-02", weight_kg: 80, notes: "" },
      ],
      training: [],
    });
    const html = renderToStaticMarkup(<NutritionChart points={points} units="metric" />);
    expect(html).not.toContain("stroke-info-ink");
    expect(html).not.toContain("NaN");
  });
});
