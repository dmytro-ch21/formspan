"use client";

import { paceZoneBreakdown, type PaceZoneKey } from "@/lib/runningAnalysis";
import { formatDistance, formatPace, type UnitSystem } from "@/lib/units";
import type { RunSplit } from "@/lib/runningApi";
import { formatDuration } from "@/lib/history";

/**
 * How each split's pace is classified is `paceZoneBreakdown`'s job
 * (`lib/runningAnalysis.ts`, unit-tested there, doc comment explains the
 * "relative to this run's own average" rule since there's no stored
 * threshold pace to classify against). This component only renders the
 * result: a stacked time bar plus a table, the same "chart above, exact
 * numbers below" pairing `LoadHistoryChart` uses.
 */

const ZONE_COLOR: Record<PaceZoneKey, string> = {
  recovery: "bg-line",
  easy: "bg-accent-fill/40",
  steady: "bg-accent-fill",
  tempo: "bg-lime/60",
  fast: "bg-lime",
};

export function PaceZoneChart({
  splits,
  units,
}: {
  splits: RunSplit[];
  units: UnitSystem;
}) {
  const breakdown = paceZoneBreakdown(splits);

  if (!breakdown) {
    return (
      <p className="text-sm text-text-dim">
        No splits recorded for this run — pace zones need distance-based
        splits to break down.
      </p>
    );
  }

  return (
    <div>
      <div
        className="flex h-4 w-full overflow-hidden rounded-pill"
        role="img"
        aria-label={`Time by pace zone, relative to this run's average pace of ${formatPace(breakdown.avgPaceSecPerKm, units)}`}
      >
        {breakdown.zones.map((z) => (
          <div
            key={z.key}
            className={ZONE_COLOR[z.key]}
            style={{ width: `${Math.max(z.pctTime * 100, 1)}%` }}
            title={`${z.label}: ${formatDuration(z.seconds)}`}
          />
        ))}
      </div>

      <table className="mt-3 w-full text-left text-sm">
        <thead className="text-text-dim">
          <tr>
            <th scope="col" className="py-1 pr-4 font-medium">
              Zone
            </th>
            <th scope="col" className="py-1 pr-4 font-medium">
              Time
            </th>
            <th scope="col" className="py-1 pr-4 font-medium">
              Distance
            </th>
            <th scope="col" className="py-1 font-medium">
              Share of time
            </th>
          </tr>
        </thead>
        <tbody>
          {breakdown.zones.map((z) => (
            <tr key={z.key} className="border-t border-line">
              <td className="py-1 pr-4">
                <span
                  aria-hidden="true"
                  className={`mr-2 inline-block h-2.5 w-2.5 rounded-full ${ZONE_COLOR[z.key]}`}
                />
                {z.label}
              </td>
              <td className="py-1 pr-4">{formatDuration(z.seconds)}</td>
              <td className="py-1 pr-4">{formatDistance(z.meters, units)}</td>
              <td className="py-1">{Math.round(z.pctTime * 100)}%</td>
            </tr>
          ))}
        </tbody>
      </table>

      <p className="mt-2 text-xs text-text-dim">
        Zones are relative to this run&apos;s own average pace (
        {formatPace(breakdown.avgPaceSecPerKm, units)}) — Steady is within 5%
        of it, widening out to Recovery and in to Fast.
      </p>
    </div>
  );
}
