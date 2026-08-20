import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { Derivation } from "../targets/Derivation";
import type { Basis, Projection } from "@/lib/nutritionApi";
import type { UnitSystem } from "@/lib/units";

/**
 * "Does this look right?" on the render path (N69).
 *
 * The arithmetic is pinned in Go (`projection_test.go`). That does not make the
 * PICTURE honest: a component is free to render a null projection as a
 * reassuring blank, or a missed deadline in the same muted grey as a met one,
 * and the server tests stay green through both.
 *
 * The rule these guard is the one this whole module runs on — **an absence must
 * not read as an answer.** A null projection means "we did not check", and
 * showing nothing is the only honest rendering of that.
 */

const basis = (projection: Projection | null): Basis =>
  ({
    rmr_kcal: 1800,
    rmr_precision: "measured",
    weight_kg: 90,
    weight_measured_on: "2026-01-01",
    activity: "light",
    activity_factor: 1.375,
    neat_kcal: 675,
    training_kcal_per_day: 200,
    training_days_covered: 28,
    training_sessions: 12,
    tdee_kcal: 2675,
    phase_kind: "cut",
    target_rate_pct_per_week: -0.0075,
    target_rate_kg_per_week: -0.675,
    kcal_per_kg: 7700,
    energy_delta_kcal: -742,
    clamped: false,
    protein_g_per_kg: 2,
    fat_g_per_kg: 0.8,
    projection,
  }) as unknown as Basis;

const render = (p: Projection | null, units: UnitSystem = "metric") =>
  renderToStaticMarkup(
    <Derivation basis={basis(p)} kcal={1933} proteinG={180} carbG={140} fatG={72} fibreG={30} units={units} />,
  );

const base: Projection = {
  target_weight_kg: 82,
  kg_to_go: 8,
  reached_on: "2026-03-25",
  weeks_to_go: 11.85,
  already: false,
  unreachable: false,
  meets_deadline: null,
};

describe("the feasibility line", () => {
  it("renders NOTHING when there is no projection", () => {
    // The load-bearing one. Null means no goal weight or no phase — "we did not
    // check". An all-clear here would assert a check that never ran.
    expect(render(null)).not.toContain("target-feasibility");
  });

  it("says when the goal arrives, with no verdict when no deadline was set", () => {
    const html = render(base);
    expect(html).toContain("2026-03-25");
    // `8kg`, not `8 kg` — `formatWeight`'s own spacing, which is what this
    // line renders through since N105. It used to print a literal `kg`.
    expect(html).toContain("8kg to go");
    // No deadline: it must not claim one is met or missed.
    expect(html).not.toContain("deadline");
  });

  it("marks a missed deadline differently from a met one, not just differently worded", () => {
    const met = render({ ...base, deadline_on: "2026-06-01", meets_deadline: true });
    const missed = render({
      ...base,
      deadline_on: "2026-01-29",
      meets_deadline: false,
      days_late: 55,
      shortfall_kg: 5.3,
    });
    expect(met).toContain("ahead of your");
    // The shortfall is the number that says HOW wrong the plan is.
    expect(missed).toContain("5.3");
    expect(missed).toContain("55");
    // Colour carries it too — a missed deadline in the same muted grey as a met
    // one is a warning nobody reads.
    expect(missed).toContain("text-danger-ink");
    expect(met).not.toContain("text-danger-ink");
  });

  it("names what to change on a contradictory plan rather than only refusing", () => {
    const html = render({
      ...base,
      reached_on: "",
      unreachable: true,
      unreachable_reason: "this phase moves your weight away from that goal",
    });
    expect(html).toContain("never reaches");
    expect(html).toContain("moves your weight away");
    // And it must not have invented a date.
    expect(html).not.toContain("2026-03-25");
  });

  it("treats a reached goal as finished rather than as a problem", () => {
    const html = render({ ...base, already: true, kg_to_go: 0 });
    expect(html).toContain("done its job");
    expect(html).not.toContain("text-danger-ink");
  });
});

/**
 * The same projection in imperial (N105).
 *
 * Every weight on this line — the gap, the goal, the shortfall — was printed as
 * a literal `kg` regardless of the athlete's profile, so a US athlete read four
 * numbers in a unit they do not think in on the screen whose entire job is
 * showing them the arithmetic they are being asked to trust.
 */
describe("the feasibility line follows the athlete's units", () => {
  it("renders pounds for an imperial athlete, and no kilograms anywhere", () => {
    const html = render(base, "imperial");
    // 8 kg = 17.6 lb, 82 kg = 180.8 lb.
    expect(html).toContain("17.6lb to go");
    expect(html).toContain("180.8lb");
    expect(html).not.toContain("8kg to go");
  });

  it("still renders kilograms for a metric athlete", () => {
    // Both directions: a conversion applied unconditionally would break this
    // one while leaving the imperial case above perfectly green.
    const html = render(base, "metric");
    expect(html).toContain("8kg to go");
    expect(html).not.toContain("17.6lb");
  });

  it("converts the shortfall on a missed deadline too", () => {
    const late = render(
      { ...base, deadline_on: "2026-02-01", meets_deadline: false, days_late: 12, shortfall_kg: 3 },
      "imperial",
    );
    // 3 kg = 6.6 lb. The easiest of the four to miss, being inside a template
    // literal in the trailing clause rather than in JSX text.
    expect(late).toContain("6.6lb short");
    expect(late).not.toContain("3 kg short");
  });
});
