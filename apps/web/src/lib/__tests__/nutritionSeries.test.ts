import { describe, expect, it } from "vitest";

import {
  MEAN_WINDOW_DAYS,
  MIN_TREND_READINGS,
  adherence,
  buildSeries,
  dateRange,
  fromDays,
  leadIn,
  targetOn,
  trendChangeKG,
  windowMean,
} from "@/lib/nutritionSeries";
import type { Checkin, DayTotals, Target } from "@/lib/nutritionApi";
import type { HistoryDay } from "@/lib/api";

/**
 * The two honesty rules N28 exists for, and they are arithmetic rules — which
 * is why they are pinned here rather than in a render test.
 *
 * Every assertion below fails if the code it covers is deleted. The gap tests
 * in particular were written by first making `buildSeries` fill missing days
 * with a zeroed row, checking they went red, and putting it back: a suite that
 * passes against the very bug it is named after is the thing this repo's
 * mobile suite was started over.
 */

function day(eaten_on: string, kcal: number, entries = 1): DayTotals {
  return {
    eaten_on,
    entries,
    kcal,
    protein_g: kcal / 20,
    carb_g: kcal / 10,
    fat_g: kcal / 30,
    fibre_g: null,
    target_kcal: 2000,
    target_protein_g: 150,
  };
}

function target(effective_on: string, kcal: number): Target {
  return {
    user_id: "u",
    effective_on,
    kcal,
    protein_g: 150,
    carb_g: 200,
    fat_g: 70,
    fibre_g: 30,
    source: "derived",
    created_at: "",
    updated_at: "",
  };
}

function weighin(measured_on: string, weight_kg: number | null): Checkin {
  return { user_id: "u", measured_on, weight_kg, notes: "" };
}

function trained(date: string): HistoryDay {
  return {
    date,
    sessions: 1,
    working_sets: 12,
    total_reps: 100,
    tonnage_kg: 4000,
    duration_seconds: 3600,
    sports: ["strength"],
  };
}

const EMPTY = { targets: [], checkins: [], training: [] };

describe("dateRange", () => {
  it("is inclusive at both ends", () => {
    expect(dateRange("2026-08-01", "2026-08-04")).toEqual([
      "2026-08-01",
      "2026-08-02",
      "2026-08-03",
      "2026-08-04",
    ]);
  });

  it("crosses a month boundary", () => {
    expect(dateRange("2026-08-30", "2026-09-02")).toEqual([
      "2026-08-30",
      "2026-08-31",
      "2026-09-01",
      "2026-09-02",
    ]);
  });

  it("is a single day when from equals to", () => {
    expect(dateRange("2026-08-19", "2026-08-19")).toEqual(["2026-08-19"]);
  });
});

describe("rule 1 — an unlogged day is a gap, never a zero", () => {
  it("gives an unlogged day null totals rather than a zeroed row", () => {
    const series = buildSeries({
      from: "2026-08-01",
      to: "2026-08-03",
      days: [day("2026-08-01", 2000), day("2026-08-03", 2200)],
      ...EMPTY,
    });

    expect(series.map((p) => p.date)).toEqual([
      "2026-08-01",
      "2026-08-02",
      "2026-08-03",
    ]);
    // The point EXISTS — the day is on the axis — but it makes no claim about
    // what was eaten. That distinction is the whole rule.
    expect(series[1].totals).toBeNull();
    expect(series[0].totals?.kcal).toBe(2000);
    expect(series[2].totals?.kcal).toBe(2200);
  });

  it("keeps a genuinely-zero logged day distinguishable from an unlogged one", () => {
    // A day with entries summing to zero is vanishingly rare but it is a real
    // record, and it must not be indistinguishable from silence. If a caller
    // ever tests `totals?.kcal` truthiness instead of `totals === null` this
    // is the case that catches it.
    const series = buildSeries({
      from: "2026-08-01",
      to: "2026-08-02",
      days: [day("2026-08-01", 0, 1)],
      ...EMPTY,
    });
    expect(series[0].totals).not.toBeNull();
    expect(series[0].totals?.entries).toBe(1);
    expect(series[1].totals).toBeNull();
  });

  it("does not let an unlogged day drag the rolling mean toward zero", () => {
    // Two days at 2000, five unlogged. The honest mean is 2000; a zero-filled
    // one is 571. This is the assertion that fails the moment somebody writes
    // `?? 0` in the accumulator.
    const series = buildSeries({
      from: "2026-08-07",
      to: "2026-08-07",
      days: [day("2026-08-01", 2000), day("2026-08-07", 2000)],
      ...EMPTY,
    });
    expect(series[0].mean).toEqual({ value: 2000, days: 2, considered: 7 });
  });

  it("has no mean at all for a window with nothing logged in it", () => {
    const series = buildSeries({
      from: "2026-08-01",
      to: "2026-08-01",
      days: [],
      ...EMPTY,
    });
    // Not zero, and not NaN from a divide-by-nothing. There is no average of
    // no days, and saying so is the only honest answer.
    expect(series[0].mean).toBeNull();
  });
});

describe("rule 2 — an average is labelled with how many days it came from", () => {
  it("carries the contributing count and the window size on every mean", () => {
    const series = buildSeries({
      from: "2026-08-07",
      to: "2026-08-07",
      days: [
        day("2026-08-05", 1800),
        day("2026-08-06", 2200),
        day("2026-08-07", 2000),
      ],
      ...EMPTY,
    });
    expect(series[0].mean).toEqual({ value: 2000, days: 3, considered: 7 });
  });

  it("distinguishes a full week from a partial one at the same value", () => {
    // Both windows average 2000. They are NOT the same statement, and the only
    // thing that says so is `days`.
    const full = buildSeries({
      from: "2026-08-07",
      to: "2026-08-07",
      days: dateRange("2026-08-01", "2026-08-07").map((d) => day(d, 2000)),
      ...EMPTY,
    });
    const partial = buildSeries({
      from: "2026-08-07",
      to: "2026-08-07",
      days: [day("2026-08-07", 2000)],
      ...EMPTY,
    });
    expect(full[0].mean?.value).toBe(partial[0].mean?.value);
    expect(full[0].mean?.days).toBe(7);
    expect(partial[0].mean?.days).toBe(1);
  });

  it("phrases the count with the right plural", () => {
    expect(fromDays({ value: 2000, days: 1, considered: 1 })).toBe("from 1 of 1 day");
    expect(fromDays({ value: 2000, days: 4, considered: 7 })).toBe("from 4 of 7 days");
  });

  it("labels the window mean the same way", () => {
    const points = buildSeries({
      from: "2026-08-01",
      to: "2026-08-10",
      days: [day("2026-08-01", 2000), day("2026-08-02", 3000)],
      ...EMPTY,
    });
    expect(windowMean(points, (t) => t.kcal)).toEqual({
      value: 2500,
      days: 2,
      considered: 10,
    });
  });

  it("has no window mean when nothing was logged", () => {
    const points = buildSeries({
      from: "2026-08-01",
      to: "2026-08-10",
      days: [],
      ...EMPTY,
    });
    expect(windowMean(points, (t) => t.kcal)).toBeNull();
  });
});

describe("the rolling window", () => {
  it("looks back exactly MEAN_WINDOW_DAYS, inclusive of the day itself", () => {
    // 2000 on the 1st, 1000 on the 8th. On the 8th the 1st is 7 days back —
    // one too far — so the mean is 1000 alone, not 1500.
    const series = buildSeries({
      from: "2026-08-08",
      to: "2026-08-08",
      days: [day("2026-08-01", 2000), day("2026-08-08", 1000)],
      ...EMPTY,
    });
    expect(series[0].mean).toEqual({ value: 1000, days: 1, considered: MEAN_WINDOW_DAYS });

    // One day earlier the 1st IS in range, which is what proves the boundary
    // is where it is rather than off by one in a direction nothing checks.
    const earlier = buildSeries({
      from: "2026-08-07",
      to: "2026-08-07",
      days: [day("2026-08-01", 2000), day("2026-08-07", 1000)],
      ...EMPTY,
    });
    expect(earlier[0].mean?.days).toBe(2);
  });

  it("reaches back before `from` when the caller supplies a lead-in", () => {
    // The left edge of a chart is not the left edge of somebody's eating. With
    // the lead-in fetched, the first rendered day's mean is a real seven-day
    // mean rather than a one-day one wearing the label.
    const from = "2026-08-08";
    expect(leadIn(from)).toBe("2026-08-02");
    const series = buildSeries({
      from,
      to: "2026-08-08",
      days: dateRange(leadIn(from), from).map((d) => day(d, 2000)),
      ...EMPTY,
    });
    expect(series).toHaveLength(1);
    expect(series[0].mean?.days).toBe(7);
  });
});

describe("targetOn", () => {
  it("returns the newest target on or before the day", () => {
    const targets = [target("2026-06-01", 2400), target("2026-08-01", 2200)];
    expect(targetOn(targets, "2026-07-15")?.kcal).toBe(2400);
    expect(targetOn(targets, "2026-08-01")?.kcal).toBe(2200);
    expect(targetOn(targets, "2026-09-01")?.kcal).toBe(2200);
  });

  it("is null for a day before any target existed", () => {
    // NOT a fallback to the earliest target. A day the athlete was eating to
    // nothing must not be judged against a number invented later.
    expect(targetOn([target("2026-08-01", 2200)], "2026-07-31")).toBeNull();
  });

  it("does not depend on the order rows arrive in", () => {
    const ascending = [target("2026-06-01", 2400), target("2026-08-01", 2200)];
    const descending = [...ascending].reverse();
    expect(targetOn(descending, "2026-08-05")?.kcal).toBe(
      targetOn(ascending, "2026-08-05")?.kcal,
    );
    expect(targetOn(descending, "2026-08-05")?.kcal).toBe(2200);
  });

  it("attaches the live target to every day, logged or not", () => {
    const series = buildSeries({
      from: "2026-08-01",
      to: "2026-08-02",
      days: [day("2026-08-01", 2000)],
      targets: [target("2026-07-01", 2200)],
      checkins: [],
      training: [],
    });
    // The unlogged day still HAS a target — the athlete was eating to
    // something, they just did not write it down. Dropping the target there
    // would make the target line itself gappy for a reason that has nothing to
    // do with the target.
    expect(series[1].totals).toBeNull();
    expect(series[1].target?.kcal).toBe(2200);
  });
});

describe("the weight trend on the second axis", () => {
  const week = ["2026-08-01", "2026-08-02", "2026-08-03", "2026-08-04"];

  it("needs MIN_TREND_READINGS before it draws a point", () => {
    const two = buildSeries({
      from: "2026-08-04",
      to: "2026-08-04",
      days: [],
      targets: [],
      checkins: week.slice(0, 2).map((d) => weighin(d, 80)),
      training: [],
    });
    expect(MIN_TREND_READINGS).toBe(3);
    expect(two[0].trend).toBeNull();

    const three = buildSeries({
      from: "2026-08-04",
      to: "2026-08-04",
      days: [],
      targets: [],
      checkins: week.slice(0, 3).map((d) => weighin(d, 80)),
      training: [],
    });
    expect(three[0].trend).toEqual({ kg: 80, readings: 3 });
  });

  it("ignores a check-in that recorded no weight", () => {
    // A waist measurement is a real check-in and is not a weigh-in. Counting
    // it would clear the readings bar with rows contributing nothing to the
    // mean — a trend line drawn from two numbers and a blank.
    const series = buildSeries({
      from: "2026-08-04",
      to: "2026-08-04",
      days: [],
      targets: [],
      checkins: [
        weighin("2026-08-01", 80),
        weighin("2026-08-02", 82),
        weighin("2026-08-03", null),
      ],
      training: [],
    });
    expect(series[0].trend).toBeNull();
  });

  it("smooths across the window rather than showing the last reading", () => {
    const series = buildSeries({
      from: "2026-08-03",
      to: "2026-08-03",
      days: [],
      targets: [],
      checkins: [
        weighin("2026-08-01", 80),
        weighin("2026-08-02", 81),
        weighin("2026-08-03", 85),
      ],
      training: [],
    });
    // 82, not 85. The spike is the point of smoothing.
    expect(series[0].trend?.kg).toBe(82);
  });

  it("measures net change between trend points, not between weigh-ins", () => {
    const checkins = [
      ...dateRange("2026-08-01", "2026-08-03").map((d) => weighin(d, 80)),
      ...dateRange("2026-08-08", "2026-08-10").map((d) => weighin(d, 79)),
    ];
    const series = buildSeries({
      from: "2026-08-01",
      to: "2026-08-10",
      days: [],
      targets: [],
      checkins,
      training: [],
    });
    const change = trendChangeKG(series);
    expect(change?.from).toBe("2026-08-03");
    expect(change?.to).toBe("2026-08-10");
    expect(change?.kg).toBeCloseTo(-1, 6);
  });

  it("reports no change when only one end has a trend", () => {
    const series = buildSeries({
      from: "2026-08-01",
      to: "2026-08-10",
      days: [],
      targets: [],
      checkins: dateRange("2026-08-01", "2026-08-03").map((d) => weighin(d, 80)),
      training: [],
    });
    // There ARE trend points here (the 3rd onward, until they age out), so
    // this is not the empty case — it is the case where substituting a raw
    // weigh-in for the missing end would compare a smoothed number with an
    // unsmoothed one and call the difference progress.
    expect(series.some((p) => p.trend !== null)).toBe(true);
    const change = trendChangeKG(series);
    expect(change).not.toBeNull();
    // Both ends are trend points; the tail is flat because the readings age
    // out together, so the change is zero rather than fabricated.
    expect(change?.kg).toBeCloseTo(0, 6);
  });
});

describe("training days underneath", () => {
  it("marks only the days that had training", () => {
    const series = buildSeries({
      from: "2026-08-01",
      to: "2026-08-03",
      days: [],
      targets: [],
      checkins: [],
      training: [trained("2026-08-02")],
    });
    expect(series.map((p) => p.training?.sessions ?? null)).toEqual([null, 1, null]);
  });
});

describe("adherence", () => {
  it("counts logged days against days considered", () => {
    const points = buildSeries({
      from: "2026-08-01",
      to: "2026-08-07",
      days: [day("2026-08-01", 2000), day("2026-08-04", 2000)],
      ...EMPTY,
    });
    expect(adherence(points)).toEqual({ logged: 2, considered: 7 });
  });
});
