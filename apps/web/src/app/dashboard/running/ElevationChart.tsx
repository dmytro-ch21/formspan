"use client";

import { useMemo } from "react";

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
 *
 * **Elevation is always metres, on both unit systems** — matching
 * `apps/mobile/lib/celebration.ts`'s `'${Math.round(elevationGainM)} m'` (no
 * imperial conversion at all). Nobody reads elevation gain in yards or miles,
 * which is what `formatDistance` would render it as on `units: 'imperial'`;
 * running it through that function was the earlier bug here. Distance ALONG
 * the route (the x-axis) is a genuine distance and still goes through
 * `formatDistance` correctly.
 */

const W = 720;
const H = 200;
const PAD = { top: 12, right: 12, bottom: 24, left: 48 };

/**
 * At most this many markers, however long the profile is. A full
 * `MaxRoutePoints` (20,000) track would otherwise put one `<circle>` +
 * `<title>` per point in the DOM — unreadable as hover targets at that
 * density anyway, and a real rendering cost for no benefit. Buckets by
 * position in the array (not distance) and keeps EACH bucket's highest and
 * lowest point, not just its first — a downsample that dropped a peak or a
 * dip between two kept points would draw a smoother climb/descent than the
 * run actually had.
 */
const MAX_MARKERS = 300;

function downsample<T extends { elevationM: number }>(profile: T[], max: number): T[] {
  if (profile.length <= max) return profile;
  const bucketSize = Math.ceil(profile.length / (max / 2));
  const out: T[] = [];
  for (let i = 0; i < profile.length; i += bucketSize) {
    const bucket = profile.slice(i, i + bucketSize);
    let lo = bucket[0];
    let hi = bucket[0];
    for (const p of bucket) {
      if (p.elevationM < lo.elevationM) lo = p;
      if (p.elevationM > hi.elevationM) hi = p;
    }
    // Keep both, in the order they occurred, so the line doesn't zigzag
    // backwards in distance.
    if (lo === hi) out.push(lo);
    else if (bucket.indexOf(lo) < bucket.indexOf(hi)) out.push(lo, hi);
    else out.push(hi, lo);
  }
  return out;
}

export function ElevationChart({
  points,
  units,
  /**
   * The run's own STORED gain, when there is one — preferred over
   * recomputing from the (possibly downsampled) profile, so this chart's
   * aria-label can never disagree with the summary `Stat` above it on the
   * same page for the same run.
   */
  elevationGainM,
}: {
  points: RunRoutePoint[];
  units: UnitSystem;
  elevationGainM?: number | null;
}) {
  const fullProfile = useMemo(() => elevationProfile(points), [points]);
  const markers = useMemo(() => downsample(fullProfile, MAX_MARKERS), [fullProfile]);

  if (!hasElevationData(points) || fullProfile.length < 2) return null;

  const elevations = fullProfile.map((p) => p.elevationM);
  const lo = Math.min(...elevations);
  const hi = Math.max(...elevations);
  const span = hi - lo || Math.max(hi * 0.1, 1);
  const yMin = lo - span * 0.1;
  const yMax = hi + span * 0.1;

  const maxDist = fullProfile[fullProfile.length - 1].distanceM || 1;
  const innerW = W - PAD.left - PAD.right;
  const innerH = H - PAD.top - PAD.bottom;
  const x = (d: number) => PAD.left + (d / maxDist) * innerW;
  const y = (e: number) => PAD.top + innerH - ((e - yMin) / (yMax - yMin)) * innerH;

  // The LINE is drawn from the full-resolution profile — only the markers
  // (and their hover targets) are downsampled — so the polyline's shape
  // never loses a peak the way the marker set alone would.
  const linePoints = fullProfile.map((p) => `${x(p.distanceM)},${y(p.elevationM)}`).join(" ");
  // A filled area under the line reads as "ground", the way every elevation
  // profile in a running app draws it — a bare line reads as an abstract
  // trend line instead.
  const areaPoints = `${x(0)},${y(yMin)} ${linePoints} ${x(maxDist)},${y(yMin)}`;

  const ticks = [yMax, yMin + (yMax - yMin) * 0.5, yMin];
  // Only computed as a fallback — see the prop doc above.
  const computedGainM = elevations.reduce((sum, e, i) => {
    if (i === 0) return sum;
    const d = e - elevations[i - 1];
    return d > 0 ? sum + d : sum;
  }, 0);
  const gainM = elevationGainM ?? computedGainM;

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

        {markers.map((p, i) => (
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
