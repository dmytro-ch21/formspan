"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

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
  const viewportRef = useRef<HTMLDivElement>(null);
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

  // Memoized: `points` can be up to `running.MaxRoutePoints` (20,000), and
  // without this, every `setPan` during a drag — one per pointermove, easily
  // 100+/s — re-ran the full projection (four array scans, a bounding-box
  // `Math.min/max(...spread)`) for a route that had not itself changed.
  const projected = useMemo(() => projectRoute(points, VIEW_W, VIEW_H, 40), [points]);

  const clampScale = (s: number) => Math.min(MAX_SCALE, Math.max(MIN_SCALE, s));

  const zoomBy = useCallback((factor: number) => {
    setScale((s) => clampScale(s * factor));
  }, []);

  const reset = useCallback(() => {
    setScale(1);
    setPan({ x: 0, y: 0 });
  }, []);

  // Attached via a real DOM listener with `{ passive: false }`, NOT the
  // `onWheel` prop. React has attached wheel listeners as PASSIVE by default
  // since v17 (this app is on React 19), and `preventDefault()` inside a
  // passive listener is a silent no-op — the `onWheel` prop's
  // `e.preventDefault()` would look like it worked (no console warning, no
  // error) while the page scrolled under the cursor the whole time the map
  // "zoomed". Only a non-passive listener can actually stop that scroll.
  useEffect(() => {
    const el = viewportRef.current;
    if (!el) return;
    const handler = (e: WheelEvent) => {
      e.preventDefault();
      zoomBy(e.deltaY < 0 ? 1.15 : 1 / 1.15);
    };
    el.addEventListener("wheel", handler, { passive: false });
    return () => el.removeEventListener("wheel", handler);
  }, [zoomBy]);

  const onPointerDown = useCallback((e: React.PointerEvent) => {
    e.currentTarget.setPointerCapture(e.pointerId);
    dragRef.current = { x: e.clientX, y: e.clientY, panX: pan.x, panY: pan.y };
    setDragging(true);
  }, [pan]);

  const onPointerMove = useCallback((e: React.PointerEvent) => {
    if (!dragRef.current) return;
    // `pan` is applied to the `<g>` inside a `viewBox="0 0 ${VIEW_W} …"` SVG
    // that is itself rendered at whatever CSS width the container gives it
    // (`w-full`) — so one CLIENT pixel of pointer movement is NOT one
    // viewBox unit except when the rendered width happens to equal
    // `VIEW_W`. Scaling by that ratio is what keeps the route tracking the
    // cursor 1:1 at every container width — the compare page's half-width
    // column is roughly 2× off without it.
    const renderedWidth = viewportRef.current?.clientWidth || VIEW_W;
    const toViewBox = VIEW_W / renderedWidth;
    const dx = (e.clientX - dragRef.current.x) * toViewBox;
    const dy = (e.clientY - dragRef.current.y) * toViewBox;
    setPan({ x: dragRef.current.panX + dx, y: dragRef.current.panY + dy });
  }, []);

  const onPointerUp = useCallback(() => {
    dragRef.current = null;
    setDragging(false);
  }, []);

  // The one true source of "are we fullscreen" is `document.fullscreenElement`
  // — this listener is what keeps `fullscreen` state honest against it. Without
  // it, leaving fullscreen the ordinary way (Esc, the browser's own exit
  // control) never fires `toggleFullscreen` below, so the state stays `true`
  // forever: the map keeps its viewport-filling layout inside the normal page
  // flow (broken), and the button — believing it's still fullscreen — tries to
  // EXIT on the next click instead of entering again.
  useEffect(() => {
    const onChange = () => setFullscreen(document.fullscreenElement === containerRef.current);
    document.addEventListener("fullscreenchange", onChange);
    return () => document.removeEventListener("fullscreenchange", onChange);
  }, []);

  const toggleFullscreen = useCallback(async () => {
    const el = containerRef.current;
    if (!el) return;
    try {
      if (!document.fullscreenElement) {
        await el.requestFullscreen();
      } else {
        await document.exitFullscreen();
      }
      // `fullscreen` state itself is NOT set here — the `fullscreenchange`
      // listener above is the single writer, so this and Esc/the browser's
      // own exit button go through the same path and can't disagree.
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
        ref={viewportRef}
        className={`touch-none select-none ${fullscreen ? "flex-1" : ""}`}
        style={{ cursor: dragging ? "grabbing" : "grab" }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerLeave={onPointerUp}
        onPointerCancel={onPointerUp}
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
