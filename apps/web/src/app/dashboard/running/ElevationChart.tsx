"use client";

import { elevationProfile, hasElevationData } from "@/lib/runningAnalysis";
import { formatDistance, type UnitSystem } from "@/lib/units";
import type { RunRoutePoint } from "@/lib/runningApi";

/**
 * A run's elevation over distance, drawn the same way `LoadHistoryChart`
 * draws a lift's arc over time: a viewBox that scales with its container, an
 * SVG `<title>` per point for a hover tooltip, and `role="img"` with a full
 * text summary — so nothing here depends on colour alone to say what
 * happened. Only rendered when `hasElevationData` says there is something to
 * show — see `[id]/page.tsx`, which is also what makes this component safe to
 * assume a non-empty profile once mounted.
 */

const W = 720;
const H = 200;
const PAD = { top: 12, right: 12, bottom: 24, left: 48 };

export function ElevationChart({
  points,
  units,
}: {
  points: RunRoutePoint[];
  units: UnitSystem;
}) {
  if (!hasElevationData(points)) return null;
  const profile = elevationProfile(points);
  if (profile.length < 2) return null;

  const elevations = profile.map((p) => p.elevationM);
  const lo = Math.min(...elevations);
  const hi = Math.max(...elevations);
  const span = hi - lo || Math.max(hi * 0.1, 1);
  const yMin = lo - span * 0.1;
  const yMax = hi + span * 0.1;

  const maxDist = profile[profile.length - 1].distanceM || 1;
  const innerW = W - PAD.left - PAD.right;
  const innerH = H - PAD.top - PAD.bottom;
  const x = (d: number) => PAD.left + (d / maxDist) * innerW;
  const y = (e: number) => PAD.top + innerH - ((e - yMin) / (yMax - yMin)) * innerH;

  const linePoints = profile.map((p) => `${x(p.distanceM)},${y(p.elevationM)}`).join(" ");
  // A filled area under the line reads as "ground", the way every elevation
  // profile in a running app draws it — a bare line reads as an abstract
  // trend line instead.
  const areaPoints = `${x(0)},${y(yMin)} ${linePoints} ${x(maxDist)},${y(yMin)}`;

  const ticks = [yMax, yMin + (yMax - yMin) * 0.5, yMin];
  const gainM = elevations.reduce((sum, e, i) => {
    if (i === 0) return sum;
    const d = e - elevations[i - 1];
    return d > 0 ? sum + d : sum;
  }, 0);

  return (
    <figure className="m-0">
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="h-auto w-full"
        role="img"
        aria-label={`Elevation profile over ${formatDistance(maxDist, units)}, climbing about ${Math.round(gainM)} metres`}
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
              {Math.round(t)}m
            </text>
          </g>
        ))}

        <polygon points={areaPoints} className="fill-lime/10" />
        <polyline
          points={linePoints}
          fill="none"
          className="stroke-lime"
          strokeWidth={2}
          strokeLinejoin="round"
          strokeLinecap="round"
        />

        {profile.map((p, i) => (
          <circle
            key={i}
            cx={x(p.distanceM)}
            cy={y(p.elevationM)}
            r={1.5}
            className="fill-lime"
          >
            <title>
              {formatDistance(p.distanceM, units)}: {Math.round(p.elevationM)}m
            </title>
          </circle>
        ))}

        <text x={PAD.left} y={H - 6} className="fill-text-dim text-[11px]">
          0
        </text>
        <text
          x={W - PAD.right}
          y={H - 6}
          textAnchor="end"
          className="fill-text-dim text-[11px]"
        >
          {formatDistance(maxDist, units)}
        </text>
      </svg>
    </figure>
  );
}
