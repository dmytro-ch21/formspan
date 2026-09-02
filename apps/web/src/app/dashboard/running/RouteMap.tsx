"use client";

import { useCallback, useRef, useState } from "react";

import { projectRoute } from "@/lib/runningAnalysis";
import type { RunRoutePoint } from "@/lib/runningApi";

/**
 * A run's route, drawn as its own shape rather than over map tiles.
 *
 * **The map-library decision, recorded here because this is where it's
 * load-bearing.** `apps/web` has no existing map-rendering pattern anywhere
 * (checked before writing this), and mobile's choice — `react-native-maps` —
 * is a native module and cannot run in a browser at all, so it does not
 * transfer; this needed its own call. The alternative was a tile-based
 * library (Leaflet, Mapbox GL JS): real streets under the line, at the cost
 * of a tile provider, an API key to provision and keep out of git, and a new
 * heavy dependency for a page that draws ONE polyline. This codebase already
 * has a working answer for "chart something without a library" —
 * `LoadHistoryChart.tsx`, `VolumeTrend.tsx` and mobile's `TrendChart.tsx` all
 * hand-roll inline SVG rather than reach for a charting package — and a
 * route is the same shape of problem: points in, a line out. So: no tile
 * provider, no API key, no new dependency. `projectRoute` (in
 * `lib/runningAnalysis.ts`, and unit-tested there) fits the track's own
 * lat/lng bounds to the box with a latitude-corrected equirectangular
 * projection, and this component is the pan/zoom/fullscreen shell around
 * that polyline. The honest cost, stated rather than hidden: there is no
 * street context, no basemap, nothing to orient the shape against a real
 * place — this shows the run's SHAPE, not a map of the neighbourhood it
 * happened in. That trade is judged worth it for what N464 asks for; a
 * future ticket that specifically wants street context is a new decision,
 * not a silent scope-creep of this one.
 */

const VIEW_W = 960;
const VIEW_H = 640;
const MIN_SCALE = 1;
const MAX_SCALE = 8;

export function RouteMap({ points }: { points: RunRoutePoint[] }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [fullscreen, setFullscreen] = useState(false);
  // Whether a drag is in progress, kept as STATE (not just on `dragRef`
  // below) purely so the cursor style can read it during render — a ref
  // read in the render body is a lint error (`react-hooks/refs`) because a
  // ref change doesn't schedule a re-render, so the cursor would silently
  // never flip back after a drag ends.
  const [dragging, setDragging] = useState(false);
  const dragRef = useRef<{ x: number; y: number; panX: number; panY: number } | null>(null);

  const projected = projectRoute(points, VIEW_W, VIEW_H, 40);

  const clampScale = (s: number) => Math.min(MAX_SCALE, Math.max(MIN_SCALE, s));

  const zoomBy = useCallback((factor: number) => {
    setScale((s) => clampScale(s * factor));
  }, []);

  const reset = useCallback(() => {
    setScale(1);
    setPan({ x: 0, y: 0 });
  }, []);

  const onWheel = useCallback((e: React.WheelEvent) => {
    e.preventDefault();
    zoomBy(e.deltaY < 0 ? 1.15 : 1 / 1.15);
  }, [zoomBy]);

  const onPointerDown = useCallback((e: React.PointerEvent) => {
    (e.target as Element).setPointerCapture(e.pointerId);
    dragRef.current = { x: e.clientX, y: e.clientY, panX: pan.x, panY: pan.y };
    setDragging(true);
  }, [pan]);

  const onPointerMove = useCallback((e: React.PointerEvent) => {
    if (!dragRef.current) return;
    const dx = e.clientX - dragRef.current.x;
    const dy = e.clientY - dragRef.current.y;
    setPan({ x: dragRef.current.panX + dx, y: dragRef.current.panY + dy });
  }, []);

  const onPointerUp = useCallback(() => {
    dragRef.current = null;
    setDragging(false);
  }, []);

  const toggleFullscreen = useCallback(async () => {
    const el = containerRef.current;
    if (!el) return;
    try {
      if (!document.fullscreenElement) {
        await el.requestFullscreen();
        setFullscreen(true);
      } else {
        await document.exitFullscreen();
        setFullscreen(false);
      }
    } catch {
      // Fullscreen can be refused (no user gesture in an odd embed context,
      // a browser without the API) — the map still works, just at the
      // page's own size, so there is nothing to surface as an error here.
    }
  }, []);

  if (points.length === 0) {
    return (
      <div className="flex h-64 items-center justify-center rounded-card border border-dashed border-line text-sm text-text-dim">
        No GPS track for this run.
      </div>
    );
  }

  const start = projected[0];
  const finish = projected[projected.length - 1];

  return (
    <div
      ref={containerRef}
      className={
        fullscreen
          ? "flex h-screen w-screen flex-col bg-surface"
          : "relative overflow-hidden rounded-card border border-line bg-surface"
      }
    >
      <div className="flex items-center justify-between gap-2 border-b border-line-soft px-3 py-2">
        <p className="text-xs text-text-dim">
          Drag to pan · scroll to zoom
        </p>
        <div className="flex items-center gap-1">
          <MapButton label="Zoom out" onClick={() => zoomBy(1 / 1.3)}>
            −
          </MapButton>
          <MapButton label="Reset zoom" onClick={reset}>
            {Math.round(scale * 100)}%
          </MapButton>
          <MapButton label="Zoom in" onClick={() => zoomBy(1.3)}>
            +
          </MapButton>
          <MapButton
            label={fullscreen ? "Exit full screen" : "Full screen"}
            onClick={toggleFullscreen}
          >
            {fullscreen ? "⤓" : "⤢"}
          </MapButton>
        </div>
      </div>

      <div
        className={`touch-none select-none ${fullscreen ? "flex-1" : ""}`}
        style={{ cursor: dragging ? "grabbing" : "grab" }}
        onWheel={onWheel}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerLeave={onPointerUp}
      >
        <svg
          viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}
          className={fullscreen ? "h-full w-full" : "h-auto w-full"}
          role="img"
          aria-label={`Route map, ${points.length} recorded points`}
        >
          <g
            style={{
              transform: `translate(${pan.x}px, ${pan.y}px) scale(${scale})`,
              transformOrigin: "center",
            }}
          >
            <polyline
              points={projected.map((p) => `${p.x},${p.y}`).join(" ")}
              fill="none"
              className="stroke-lime"
              strokeWidth={3}
              strokeLinejoin="round"
              strokeLinecap="round"
              vectorEffect="non-scaling-stroke"
            />
            {start && (
              <circle cx={start.x} cy={start.y} r={6} className="fill-text">
                <title>Start</title>
              </circle>
            )}
            {finish && finish !== start && (
              <circle cx={finish.x} cy={finish.y} r={6} className="fill-danger">
                <title>Finish</title>
              </circle>
            )}
          </g>
        </svg>
      </div>
    </div>
  );
}

function MapButton({
  label,
  onClick,
  children,
}: {
  label: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      title={label}
      className="min-w-8 rounded-pill border border-line px-2 py-1 text-xs font-medium transition hover:bg-surface-raised"
    >
      {children}
    </button>
  );
}
