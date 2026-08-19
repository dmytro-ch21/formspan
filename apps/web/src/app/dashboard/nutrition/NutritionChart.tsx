"use client";

import { useMemo } from "react";

import { monthShort } from "@/lib/history";
import { MEAN_WINDOW_DAYS, fromDays, type DayPoint } from "@/lib/nutritionSeries";
import { toDisplayWeight, weightUnit, type UnitSystem } from "@/lib/units";

/**
 * Intake, target, bodyweight and training on ONE timeline.
 *
 * This is the join the project considers its reason to exist: nobody can tell
 * you whether you are eating too little from a calorie chart, or whether a
 * plateau is food or fatigue from a weight chart. The answer is in how the
 * three move against each other, and it only exists on a surface wide enough
 * to hold all three at once — which is why this is web and stays web.
 *
 * **SVG by hand, no charting library**, following `LoadHistoryChart` and
 * `VolumeTrend`: it is some rects and three polylines, the dependency would
 * outweigh the drawing, and it stays inspectable markup rather than an opaque
 * canvas. It also lets the accessible reading be a real list underneath rather
 * than an `aria-label` describing a picture.
 *
 * # The two honesty rules, as they land on a picture
 *
 * **An unlogged day draws NOTHING.** No bar, no zero, no floor-height stub —
 * and the mean and trend lines BREAK across it rather than interpolating. A
 * line drawn straight over a gap is a claim about a day nobody recorded, and
 * it is the more persuasive kind of lie because it looks like data.
 *
 * **Every average carries its denominator.** The rolling mean's hover text
 * names how many days contributed, and `Mean` cannot be rendered without it —
 * see `nutritionSeries.ts`.
 *
 * # What the bars deliberately do NOT do
 *
 * They are one colour. Colouring over-target days red would be the chart
 * taking a position it has no standing to take: over target is failure on a
 * cut and success on a lean bulk, and the phase is not on this axis. The
 * target line is the comparison; the reader supplies the judgement.
 */

const W = 960;
const H = 300;
const PAD = { top: 16, right: 56, bottom: 52, left: 56 };
/** The training strip, below the plot rather than inside it. */
const STRIP_H = 10;
const STRIP_Y = H - PAD.bottom + 12;

/** A run of consecutive days that all have a value — one polyline each.
 *  Splitting on nulls is what stops a line spanning a gap. */
function segments<T>(
  points: DayPoint[],
  pick: (p: DayPoint) => T | null,
): { index: number; value: T }[][] {
  const out: { index: number; value: T }[][] = [];
  let run: { index: number; value: T }[] = [];
  points.forEach((p, index) => {
    const value = pick(p);
    if (value == null) {
      if (run.length) out.push(run);
      run = [];
    } else {
      run.push({ index, value });
    }
  });
  if (run.length) out.push(run);
  return out;
}

function path(run: { x: number; y: number }[]): string {
  return run.map((p, i) => `${i === 0 ? "M" : "L"}${p.x},${p.y}`).join(" ");
}

function niceCeil(v: number): number {
  if (v <= 0) return 1000;
  const step = v > 4000 ? 1000 : v > 1500 ? 500 : 100;
  return Math.ceil(v / step) * step;
}

export function NutritionChart({
  points,
  units,
}: {
  points: DayPoint[];
  units: UnitSystem;
}) {
  const geometry = useMemo(() => {
    const n = Math.max(1, points.length);
    const plotW = W - PAD.left - PAD.right;
    const plotH = H - PAD.top - PAD.bottom;
    const band = plotW / n;

    const kcals = points.flatMap((p) =>
      [p.totals?.kcal, p.target?.kcal, p.mean?.value].filter(
        (v): v is number => v != null,
      ),
    );
    const kcalMax = niceCeil(Math.max(1, ...kcals) * 1.08);

    const trendKgs = points
      .map((p) => p.trend?.kg)
      .filter((v): v is number => v != null);
    // A flat run would collapse the axis onto a single line, so a minimum span
    // keeps stable weight reading as stable rather than as jitter blown up to
    // full height.
    const wMin = trendKgs.length ? Math.min(...trendKgs) : 0;
    const wMax = trendKgs.length ? Math.max(...trendKgs) : 0;
    const wSpan = Math.max(2, (wMax - wMin) * 1.6);
    const wLo = (wMin + wMax) / 2 - wSpan / 2;

    return {
      band,
      plotH,
      kcalMax,
      hasWeight: trendKgs.length > 0,
      x: (i: number) => PAD.left + band * (i + 0.5),
      yKcal: (v: number) => PAD.top + plotH * (1 - v / kcalMax),
      yWeight: (kg: number) => PAD.top + plotH * (1 - (kg - wLo) / wSpan),
      wLo,
      wHi: wLo + wSpan,
    };
  }, [points]);

  const { band, plotH, kcalMax, hasWeight, x, yKcal, yWeight, wLo, wHi } = geometry;

  const gridlines = useMemo(
    () => [0, 0.25, 0.5, 0.75, 1].map((f) => Math.round(kcalMax * f)),
    [kcalMax],
  );

  const meanRuns = segments(points, (p) => p.mean).map((run) =>
    run.map((r) => ({ x: x(r.index), y: yKcal(r.value.value) })),
  );
  const targetRuns = segments(points, (p) => p.target).map((run) =>
    run.map((r) => ({ x: x(r.index), y: yKcal(r.value.kcal) })),
  );
  const trendRuns = segments(points, (p) => p.trend).map((run) =>
    run.map((r) => ({ x: x(r.index), y: yWeight(r.value.kg) })),
  );

  if (points.length === 0) return null;

  const barW = Math.max(1.5, Math.min(14, band * 0.62));

  // A month tick wherever the month changes, plus the first day: dense enough
  // to place a bar in time, sparse enough not to become a wall of text.
  const monthTicks = points
    .map((p, i) => ({ p, i }))
    .filter(({ p, i }) => i === 0 || p.date.slice(5, 7) !== points[i - 1].date.slice(5, 7));

  return (
    <div className="overflow-x-auto">
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="w-full min-w-[560px]"
        role="img"
        aria-label={`Daily calories against target over ${points.length} days, with the ${MEAN_WINDOW_DAYS}-day mean, bodyweight trend and training days. Every day is listed in words below the chart.`}
      >
        {gridlines.map((v) => (
          <g key={v}>
            <line
              x1={PAD.left}
              x2={W - PAD.right}
              y1={yKcal(v)}
              y2={yKcal(v)}
              className="stroke-line-soft"
              strokeWidth={1}
            />
            <text
              x={PAD.left - 8}
              y={yKcal(v) + 4}
              textAnchor="end"
              className="fill-text-dim text-[11px]"
            >
              {v}
            </text>
          </g>
        ))}

        {/* The target, as a STEP: it holds until the day it changes, and a
            sloped line between two targets would draw days at calorie figures
            nobody was ever eating to. */}
        {targetRuns.map((run, i) => (
          <path
            key={`t${i}`}
            d={path(
              run.flatMap((p, j) => (j === 0 ? [p] : [{ x: p.x, y: run[j - 1].y }, p])),
            )}
            fill="none"
            className="stroke-info"
            strokeWidth={1.5}
            strokeDasharray="5 4"
          />
        ))}

        {/* Bars: LOGGED DAYS ONLY. An unlogged day is simply absent here, and
            that absence is the feature. */}
        {points.map((p, i) =>
          p.totals ? (
            <rect
              key={p.date}
              x={x(i) - barW / 2}
              y={yKcal(p.totals.kcal)}
              width={barW}
              // A tiny day must still be visible, but never below 1px — that
              // is where "logged almost nothing" would start to look like
              // "logged nothing".
              height={Math.max(1, PAD.top + plotH - yKcal(p.totals.kcal))}
              rx={1.5}
              className="fill-lime"
            />
          ) : null,
        )}

        {meanRuns.map((run, i) => (
          <g key={`m${i}`}>
            <path d={path(run)} fill="none" className="stroke-text" strokeWidth={2} />
            {/* A run of one has no line to draw, and dropping it would hide a
                genuine data point in the middle of a sparse stretch. */}
            {run.length === 1 && (
              <circle cx={run[0].x} cy={run[0].y} r={2.5} className="fill-text" />
            )}
          </g>
        ))}

        {hasWeight &&
          trendRuns.map((run, i) => (
            <g key={`w${i}`}>
              <path d={path(run)} fill="none" className="stroke-info-ink" strokeWidth={2} />
              {run.length === 1 && (
                <circle cx={run[0].x} cy={run[0].y} r={2.5} className="fill-info-ink" />
              )}
            </g>
          ))}

        {hasWeight && (
          <g>
            {[wLo, (wLo + wHi) / 2, wHi].map((kg) => (
              <text
                key={kg}
                x={W - PAD.right + 8}
                y={yWeight(kg) + 4}
                className="fill-info-ink text-[11px]"
              >
                {toDisplayWeight(kg, units).toFixed(1)}
              </text>
            ))}
            <text x={W - PAD.right + 8} y={PAD.top - 4} className="fill-text-dim text-[10px]">
              {weightUnit(units)}
            </text>
          </g>
        )}

        {/* Training, underneath rather than on an axis. It is context for the
            two lines above it, not a third quantity to read values off — the
            question it answers is "was that a hard week", and a tick answers
            it without competing for the plot area. */}
        {points.map((p, i) =>
          p.training ? (
            <rect
              key={`s${p.date}`}
              x={x(i) - barW / 2}
              y={STRIP_Y}
              width={barW}
              height={STRIP_H}
              rx={1.5}
              className="fill-text-dim"
              opacity={Math.min(1, 0.45 + 0.25 * p.training.sessions)}
            />
          ) : null,
        )}

        {monthTicks.map(({ p, i }) => (
          <text
            key={`x${p.date}`}
            x={x(i)}
            y={H - PAD.bottom + 4}
            textAnchor="middle"
            className="fill-text-dim text-[11px]"
          >
            {monthShort(p.date)}
          </text>
        ))}

        {/* One transparent hit target per day, so hovering anywhere in a column
            explains that day — INCLUDING an unlogged one, which has no bar to
            hover and is exactly the day a reader most wants explained. */}
        {points.map((p, i) => (
          <rect
            key={`h${p.date}`}
            x={x(i) - band / 2}
            y={PAD.top}
            width={band}
            height={plotH + STRIP_H + 14}
            fill="transparent"
          >
            <title>{describe(p, units)}</title>
          </rect>
        ))}
      </svg>

      <ul className="sr-only">
        {points.map((p) => (
          <li key={p.date}>{describe(p, units)}</li>
        ))}
      </ul>
    </div>
  );
}

/**
 * One day in words — the hover text AND the screen-reader row, from one
 * function so the two can never tell different stories.
 *
 * "Nothing logged" is stated outright rather than left as an absence. A
 * sighted reader sees a gap; a screen-reader user would otherwise never hear
 * the day at all, which turns the honest gap back into silence.
 */
function describe(p: DayPoint, units: UnitSystem): string {
  const parts: string[] = [formatDate(p.date)];
  parts.push(
    p.totals
      ? `${Math.round(p.totals.kcal)} kcal from ${p.totals.entries} ${p.totals.entries === 1 ? "entry" : "entries"}`
      : "nothing logged",
  );
  if (p.target) parts.push(`target ${p.target.kcal}`);
  if (p.mean) {
    parts.push(
      `${MEAN_WINDOW_DAYS}-day mean ${Math.round(p.mean.value)} kcal, ${fromDays(p.mean)}`,
    );
  }
  if (p.trend) {
    parts.push(
      `trend weight ${toDisplayWeight(p.trend.kg, units).toFixed(1)}${weightUnit(units)} from ${p.trend.readings} weigh-ins`,
    );
  }
  if (p.training) {
    parts.push(
      `${p.training.sessions} ${p.training.sessions === 1 ? "session" : "sessions"}: ${p.training.sports.join(", ")}`,
    );
  }
  return parts.join(" · ");
}

function formatDate(key: string): string {
  return `${monthShort(key)} ${Number(key.slice(8))}`;
}
