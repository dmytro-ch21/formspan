"use client";

import { useMemo, useState } from "react";

import type { LoadHistory, LoadPoint } from "@/lib/api";
import {
  formatEstimate,
  formatVolume,
  formatWeight,
  toDisplayWeight,
  weightUnit,
  type UnitSystem,
} from "@/lib/units";

/**
 * One lift's arc over time.
 *
 * **This is the web screen on purpose.** N6 asked for per-exercise load over
 * time and paired itself with N5's mobile weight chart, but it does not pass
 * N5's carve-out — the at-the-rack decision is already answered on the phone by
 * the double-progression recommendation, so a chart there would be decoration.
 * What is left is "did my squat go up over the last three months", asked while
 * planning the next block, at a desk.
 *
 * So this deliberately has the three things the carve-out forbids on mobile: a
 * metric picker, axes you can read values off, and per-point evidence. That is
 * not scope creep, it is the distinction being drawn — if this belonged on the
 * phone it would have to lose all three, and losing all three is what makes it
 * useless for the question it answers.
 *
 * SVG rather than a charting library, following `VolumeTrend`: a polyline and
 * some text is less code than the dependency, and it stays inspectable markup
 * instead of an opaque canvas.
 */

type Metric = {
  key: string;
  label: string;
  /** Null means this session has no value for this metric — a real gap. */
  value: (p: LoadPoint) => number | null;
  format: (kg: number, u: UnitSystem) => string;
  /** Whether the axis is a weight (converted) or a count (not). */
  weight: boolean;
};

const METRICS: Metric[] = [
  {
    key: "1rm",
    label: "Est. 1RM",
    value: (p) => p.best_1rm_kg,
    format: (kg, u) => formatEstimate(kg, u),
    weight: true,
  },
  {
    key: "top",
    label: "Top set",
    value: (p) => p.top_weight_kg,
    format: (kg, u) => formatWeight(kg, u),
    weight: true,
  },
  {
    key: "tonnage",
    label: "Volume",
    value: (p) => (p.tonnage_kg > 0 ? p.tonnage_kg : null),
    format: (kg, u) => formatVolume(kg, u),
    weight: true,
  },
];

// A viewBox, not pixels: the chart scales with its container and the numbers
// below stay readable as ratios.
const W = 720;
const H = 240;
const PAD = { top: 16, right: 16, bottom: 28, left: 56 };

export function LoadHistoryChart({
  history,
  units,
}: {
  history: LoadHistory;
  units: UnitSystem;
}) {
  const [metricKey, setMetricKey] = useState(METRICS[0].key);
  const metric = METRICS.find((m) => m.key === metricKey) ?? METRICS[0];

  const series = useMemo(
    () =>
      history.points.map((p) => ({
        point: p,
        raw: metric.value(p),
      })),
    [history.points, metric],
  );

  const present = series.filter((s) => s.raw !== null);

  if (history.points.length === 0) {
    return (
      <p className="text-sm text-text-dim">
        No sessions with this exercise yet. It will chart itself once you have
        logged it.
      </p>
    );
  }

  return (
    <div>
      <div className="mb-3 flex flex-wrap gap-2" role="group" aria-label="Metric">
        {METRICS.map((m) => (
          <button
            key={m.key}
            type="button"
            onClick={() => setMetricKey(m.key)}
            aria-pressed={m.key === metric.key}
            className={`rounded-full border px-3 py-1 text-xs font-semibold transition ${
              m.key === metric.key
                ? "border-lime bg-lime/10 text-lime"
                : "border-line text-text-dim hover:text-text"
            }`}
          >
            {m.label}
          </button>
        ))}
      </div>

      {present.length === 0 ? (
        // Not an error, and worth saying which metric is missing rather than
        // showing an empty frame: high-rep work genuinely supports no estimate.
        <p className="text-sm text-text-dim">
          None of these {history.points.length} sessions has a value for{" "}
          {metric.label.toLowerCase()}.
          {metric.key === "1rm" &&
            " An estimate needs a set of about twelve reps or fewer — every rep-max formula diverges past that."}
        </p>
      ) : (
        <Plot series={series} metric={metric} units={units} />
      )}

      <EvidenceTable history={history} metric={metric} units={units} />
    </div>
  );
}

function Plot({
  series,
  metric,
  units,
}: {
  series: { point: LoadPoint; raw: number | null }[];
  metric: Metric;
  units: UnitSystem;
}) {
  const values = series
    .map((s) => s.raw)
    .filter((v): v is number => v !== null)
    .map((kg) => (metric.weight ? toDisplayWeight(kg, units) : kg));

  const lo = Math.min(...values);
  const hi = Math.max(...values);
  // A flat series would divide by zero and, worse, draw a line at the very
  // top of the frame implying it is a maximum. Give it room and centre it.
  const span = hi - lo || Math.max(hi * 0.1, 1);
  const yMin = lo - span * 0.1;
  const yMax = hi + span * 0.1;

  const innerW = W - PAD.left - PAD.right;
  const innerH = H - PAD.top - PAD.bottom;
  const x = (i: number) =>
    PAD.left +
    (series.length === 1 ? innerW / 2 : (i / (series.length - 1)) * innerW);
  const y = (v: number) =>
    PAD.top + innerH - ((v - yMin) / (yMax - yMin)) * innerH;

  // Gaps break the line rather than bridging it. A polyline drawn straight
  // across a hole asserts a value that was never measured — the same reason
  // N5's weight chart renders a missed weigh-in as a gap.
  const segments: { i: number; v: number }[][] = [];
  let run: { i: number; v: number }[] = [];
  series.forEach((s, i) => {
    if (s.raw === null) {
      if (run.length) segments.push(run);
      run = [];
      return;
    }
    run.push({ i, v: metric.weight ? toDisplayWeight(s.raw, units) : s.raw });
  });
  if (run.length) segments.push(run);

  const ticks = [yMin + (yMax - yMin) * 0.5, yMax, yMin];
  const firstDate = series[0].point.started_at;
  const lastDate = series[series.length - 1].point.started_at;

  return (
    <figure className="m-0">
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="h-auto w-full"
        role="img"
        aria-label={`${metric.label} across ${series.length} sessions, from ${shortDate(firstDate)} to ${shortDate(lastDate)}. The table below lists every value.`}
      >
        {ticks.map((t, i) => (
          <g key={i}>
            <line
              x1={PAD.left}
              x2={W - PAD.right}
              y1={y(t)}
              y2={y(t)}
              className="stroke-line"
              strokeWidth={1}
            />
            <text
              x={PAD.left - 8}
              y={y(t)}
              textAnchor="end"
              dominantBaseline="middle"
              className="fill-text-dim text-[11px]"
            >
              {Math.round(t)}
            </text>
          </g>
        ))}
        <text
          x={PAD.left - 8}
          y={PAD.top - 4}
          textAnchor="end"
          className="fill-text-dim text-[10px]"
        >
          {weightUnit(units)}
        </text>

        {segments.map((seg, i) => (
          <polyline
            key={i}
            points={seg.map((p) => `${x(p.i)},${y(p.v)}`).join(" ")}
            fill="none"
            className="stroke-lime"
            strokeWidth={2}
            strokeLinejoin="round"
            strokeLinecap="round"
          />
        ))}

        {series.map((s, i) =>
          s.raw === null ? null : (
            <circle
              key={s.point.session_id}
              cx={x(i)}
              cy={y(metric.weight ? toDisplayWeight(s.raw, units) : s.raw)}
              r={3}
              className="fill-lime"
            >
              {/* A native <title> is the tooltip: it works without JS, it is
                  read by screen readers, and it cannot drift from the data. */}
              <title>
                {shortDate(s.point.started_at)}: {metric.format(s.raw, units)}
              </title>
            </circle>
          ),
        )}

        <text
          x={PAD.left}
          y={H - 8}
          className="fill-text-dim text-[11px]"
        >
          {shortDate(firstDate)}
        </text>
        <text
          x={W - PAD.right}
          y={H - 8}
          textAnchor="end"
          className="fill-text-dim text-[11px]"
        >
          {shortDate(lastDate)}
        </text>
      </svg>
    </figure>
  );
}

/**
 * The numbers, as a table.
 *
 * Not a fallback — an equal surface. A chart shows the shape and hides the
 * values; this is the analytical screen, so the values are on it. It is also
 * what makes the graphic accessible without duplicating meaning in colour.
 */
function EvidenceTable({
  history,
  metric,
  units,
}: {
  history: LoadHistory;
  metric: Metric;
  units: UnitSystem;
}) {
  // Newest first here, opposite to the chart: a table is read from the top and
  // the most recent session is the one being asked about.
  const rows = [...history.points].reverse();
  return (
    <details className="mt-4">
      <summary className="cursor-pointer text-sm text-text-dim hover:text-text">
        {rows.length} session{rows.length === 1 ? "" : "s"}
      </summary>
      <div className="mt-2 overflow-x-auto">
        <table className="w-full text-left text-sm">
          <thead className="text-text-dim">
            <tr>
              <th scope="col" className="py-1 pr-4 font-medium">
                Date
              </th>
              <th scope="col" className="py-1 pr-4 font-medium">
                {metric.label}
              </th>
              <th scope="col" className="py-1 pr-4 font-medium">
                Sets
              </th>
              <th scope="col" className="py-1 font-medium">
                Evidence
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((p) => {
              const v = metric.value(p);
              return (
                <tr key={p.session_id} className="border-t border-line">
                  <td className="py-1 pr-4">{shortDate(p.started_at)}</td>
                  <td className="py-1 pr-4">
                    {v === null ? (
                      <span className="text-text-dim">—</span>
                    ) : (
                      metric.format(v, units)
                    )}
                  </td>
                  <td className="py-1 pr-4">
                    {p.sets} × {p.reps} reps
                  </td>
                  <td className="py-1 text-text-dim">
                    {/* Only the estimate is a modelled number, so only it
                        needs its working shown. */}
                    {metric.key === "1rm" &&
                    p.one_rm_reps !== null &&
                    p.one_rm_weight_kg !== null
                      ? `from ${formatWeight(p.one_rm_weight_kg, units)} × ${p.one_rm_reps}`
                      : ""}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </details>
  );
}

function shortDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}
