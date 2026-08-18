"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useAuth } from "@clerk/nextjs";

import {
  getRoundMap,
  listPositions,
  listTechniques,
  techniquesInPosition,
  type Position,
  type RoundMap,
  type RoundMapEdgeKind,
  type TechniqueSummary,
} from "@/lib/api";
import {
  bandOf,
  edgePath,
  layout,
  NODE_H,
  NODE_W,
  type Placed,
} from "@/lib/roundMapLayout";

/**
 * The map of a round, drawn.
 *
 * **Why this is a picture and not prose.** The belt roadmaps ship the same
 * material as four concept cards (#272), and a card describing a flowchart is
 * strictly worse than the flowchart: the whole point of "the back is above
 * mount is above side control" is that you can SEE it, in one glance, without
 * holding six sentences in your head. That was left as the open question on
 * that PR and this is the answer to it.
 *
 * **The ladder is the message.** Vertical position is the only thing on this
 * screen carrying meaning on its own: higher is better, from your side. Every
 * other encoding is doubled — each edge kind has a distinct colour AND its own
 * words on the label AND its own toggle — because a diagram whose meaning is
 * carried by hue alone is unreadable to a colourblind athlete, and this palette
 * is validated only for hues that carry a secondary encoding (see
 * `libraryTiles.ts`).
 *
 * **Route first, the rest on request.** All 28 edges at once is a hairball, and
 * a beginner's first question is only ever "how do I get to the top". So
 * `route` is on and the other two kinds are off until asked for — progressive
 * disclosure, not a hidden feature. The toggles say what they hold and the
 * counts are on them, so nothing is secretly missing.
 *
 * Web, per the platform rule: this is reference material read sitting down. The
 * phone gets the same content as a ladder, which needs no edges at all — see
 * `tier`.
 */

/** Colour AND words, never colour alone — see the component docstring. */
const KIND: Record<
  RoundMapEdgeKind,
  { label: string; hint: string; stroke: string; dash?: string }
> = {
  route: {
    label: "Advancing",
    hint: "Trading up: the way toward the top of the ladder.",
    stroke: "var(--color-lime)",
  },
  recover: {
    label: "Getting out",
    hint: "The way back when you have lost ground — survive, escape, recover.",
    stroke: "var(--color-info)",
  },
  concede: {
    label: "Losing ground",
    hint: "How you end up in the bad places. Drawn dashed, because none of it is something you do on purpose.",
    stroke: "var(--color-danger)",
    dash: "5 4",
  },
};

export function RoundMapView() {
  const { getToken } = useAuth();
  const [map, setMap] = useState<RoundMap | null>(null);
  const [positions, setPositions] = useState<Position[]>([]);
  const [techniques, setTechniques] = useState<TechniqueSummary[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  /**
   * Route AND recover by default; concede on request.
   *
   * Route alone was the first version, on a "one question at a time" argument,
   * and looking at the drawn output killed it: every edge touching the losing
   * band is a recover or a concede, so the four worst positions rendered as
   * boxes with NO arrows at all — floating, unreachable, and reading as broken.
   * That is the same "a missing edge is invisible" failure the concede kind was
   * added to prevent, reintroduced by a default.
   *
   * Recover is also the beginner's actual second question. Concede — how you
   * end up down there — is the one that can wait.
   */
  const [shown, setShown] = useState<Record<RoundMapEdgeKind, boolean>>({
    route: true,
    recover: true,
    concede: false,
  });

  useEffect(() => {
    const ac = new AbortController();
    (async () => {
      try {
        // The glossary and the map share one request and one cache; the
        // library is a second, larger fetch and is only used for the counts.
        const [m, p, t] = await Promise.all([
          getRoundMap(getToken, ac.signal),
          listPositions(getToken, ac.signal),
          listTechniques(getToken, ac.signal),
        ]);
        if (ac.signal.aborted) return;
        setMap(m);
        setPositions(p);
        setTechniques(t);
      } catch (e) {
        if (!ac.signal.aborted) {
          setError(e instanceof Error ? e.message : "Could not load the map.");
        }
      } finally {
        if (!ac.signal.aborted) setLoaded(true);
      }
    })();
    return () => ac.abort();
  }, [getToken]);

  const { placed, width, height } = useMemo(
    () => (map ? layout(map.nodes) : { placed: [], width: 0, height: 0 }),
    [map],
  );
  const byID = useMemo(
    () => new Map(placed.map((n) => [n.id, n])),
    [placed],
  );

  const toggle = useCallback((k: RoundMapEdgeKind) => {
    setShown((s) => ({ ...s, [k]: !s[k] }));
  }, []);

  if (!loaded) return <p className="text-sm text-text-muted">Loading…</p>;
  if (error) {
    return (
      <p className="rounded-xl border border-danger/40 bg-danger/10 px-4 py-3 text-sm text-danger-ink">
        {error}
      </p>
    );
  }
  // Null rather than an error: an API older than this build simply has no map,
  // and a hard failure would be a worse answer than saying so.
  if (!map) {
    return (
      <p className="rounded-xl border border-dashed border-line px-4 py-10 text-center text-sm text-text-muted">
        This build of the API does not serve the map yet.
      </p>
    );
  }

  const node = selected ? byID.get(selected) : null;
  const position = node
    ? positions.find((p) => p.id === node.position_id) ?? null
    : null;
  const fromHere = node
    ? map.edges.filter((e) => e.from === node.id)
    : [];
  const toHere = node ? map.edges.filter((e) => e.to === node.id) : [];
  /**
   * By the GLOSSARY's rule, not the node's sided one.
   *
   * The number has to be the number the destination shows or the link lies, and
   * the destination is the library's position panel, which resolves with
   * `techniquesInPosition`. The first version counted the node's own sided
   * filter — a different, narrower set — so "27 techniques from mount" led to a
   * panel listing 44.
   */
  const count =
    node && position && techniques.length > 0
      ? techniquesInPosition(techniques, position).length
      : null;

  return (
    <div className="space-y-6">
      <header className="space-y-3">
        <h1 className="text-2xl font-semibold">{map.title}</h1>
        <p className="max-w-3xl text-sm leading-relaxed text-text-muted">
          {map.intro}
        </p>
      </header>

      <fieldset className="flex flex-wrap gap-2">
        <legend className="sr-only">Which arrows to draw</legend>
        {(Object.keys(KIND) as RoundMapEdgeKind[]).map((k) => {
          const n = map.edges.filter((e) => e.kind === k).length;
          return (
            <button
              key={k}
              type="button"
              onClick={() => toggle(k)}
              aria-pressed={shown[k]}
              title={KIND[k].hint}
              className={`flex items-center gap-2 rounded-full border px-3 py-1.5 text-sm ${
                shown[k]
                  ? "border-line bg-surface-hover font-medium text-text"
                  : "border-line-soft text-text-muted"
              }`}
            >
              <span
                aria-hidden
                className="h-0.5 w-5 rounded"
                style={{ background: KIND[k].stroke }}
              />
              {KIND[k].label}
              <span className="text-text-dim">{n}</span>
            </button>
          );
        })}
      </fieldset>

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_320px]">
        {/* The diagram scrolls inside its own box; the page never scrolls
            sideways. */}
        <div className="overflow-x-auto rounded-2xl border border-line bg-surface p-2">
          <svg
            viewBox={`0 0 ${width} ${height}`}
            width={width}
            height={height}
            role="img"
            aria-label={`${map.title}. ${map.nodes.length} positions, stacked best at the top. The same content is listed below the diagram.`}
            className="max-w-none"
          >
            <defs>
              {(Object.keys(KIND) as RoundMapEdgeKind[]).map((k) => (
                <marker
                  key={k}
                  id={`arrow-${k}`}
                  viewBox="0 0 8 8"
                  refX="7"
                  refY="4"
                  markerWidth="7"
                  markerHeight="7"
                  orient="auto-start-reverse"
                >
                  <path d="M 0 0 L 8 4 L 0 8 z" fill={KIND[k].stroke} />
                </marker>
              ))}
            </defs>

            {/* Band labels sit behind everything, as a reading key for the
                vertical axis. */}
            {map.bands.map((b) => {
              const inBand = placed.filter(
                (n) => bandOf(map.bands, n.tier)?.label === b.label,
              );
              if (inBand.length === 0) return null;
              const top = Math.min(...inBand.map((n) => n.y));
              return (
                <text
                  key={b.label}
                  x={4}
                  y={top - 4}
                  className="fill-text-dim text-[10px] font-semibold uppercase tracking-wide"
                >
                  {b.label}
                </text>
              );
            })}

            {map.edges
              .filter((e) => shown[e.kind])
              .map((e, i) => {
                const a = byID.get(e.from);
                const b = byID.get(e.to);
                if (!a || !b) return null;
                const dim =
                  selected !== null && e.from !== selected && e.to !== selected;
                return (
                  <path
                    key={`${e.from}-${e.to}-${i}`}
                    d={edgePath(a, b, width)}
                    fill="none"
                    stroke={KIND[e.kind].stroke}
                    strokeWidth={1.5}
                    strokeDasharray={KIND[e.kind].dash}
                    markerEnd={`url(#arrow-${e.kind})`}
                    opacity={dim ? 0.18 : 0.85}
                  />
                );
              })}

            {placed.map((n) => {
              const active = n.id === selected;
              return (
                <g
                  key={n.id}
                  transform={`translate(${n.x} ${n.y})`}
                  onClick={() => setSelected(active ? null : n.id)}
                  className="cursor-pointer"
                >
                  <rect
                    width={NODE_W}
                    height={NODE_H}
                    rx={12}
                    className={
                      active
                        ? "fill-surface-hover stroke-text"
                        : "fill-surface-raised stroke-line"
                    }
                    strokeWidth={active ? 2 : 1}
                  />
                  <text
                    x={NODE_W / 2}
                    y={NODE_H / 2 + 5}
                    textAnchor="middle"
                    className="fill-text text-[13px] font-semibold"
                  >
                    {n.label}
                  </text>
                </g>
              );
            })}
          </svg>
        </div>

        <aside className="space-y-3">
          {!node && (
            <div className="space-y-4 rounded-2xl border border-line bg-surface p-4">
              {map.bands.map((b) => (
                <div key={b.label}>
                  <h2 className="text-xs font-semibold uppercase tracking-wide text-text-dim">
                    {b.label}
                  </h2>
                  <p className="mt-1 text-sm leading-relaxed text-text-muted">
                    {b.note}
                  </p>
                </div>
              ))}
              <p className="text-sm text-text-dim">
                Pick a position on the diagram to read what it is and what you
                are trying to do there.
              </p>
            </div>
          )}

          {node && (
            <div className="space-y-3 rounded-2xl border border-line bg-surface p-4">
              <div>
                <h2 className="text-lg font-semibold">{node.label}</h2>
                <p className="mt-1 text-sm leading-relaxed text-text-muted">
                  {node.note}
                </p>
              </div>

              {position && (
                <div className="space-y-2 border-t border-line-soft pt-3">
                  <p className="text-sm leading-relaxed text-text-muted">
                    {position.description}
                  </p>
                  <p className="text-sm leading-relaxed text-text-muted">
                    {position.priorities}
                  </p>
                </div>
              )}

              <EdgeList title="From here" edges={fromHere} byID={byID} dir="to" onPick={setSelected} />
              <EdgeList title="You arrive here by" edges={toHere} byID={byID} dir="from" onPick={setSelected} />

              {/* The library's own position panel, which resolves the same way
                  this count does. NOT the position chip: those are keyed on
                  FAMILY ("Mount", "Side Control"), not on a glossary id, so a
                  link carrying `mount` filtered the grid to nothing and left no
                  chip looking active — review caught it. */}
              <Link
                href={`/dashboard/library?position=${encodeURIComponent(node.position_id)}`}
                className="block rounded-lg border border-line px-3 py-2 text-center text-sm font-medium hover:bg-surface-hover"
              >
                Read about {node.label.toLowerCase()}
                {count === null ? "" : ` · ${count} techniques`}
              </Link>
            </div>
          )}
        </aside>
      </div>

      {/* The same content as a list. Not a fallback for the SVG — the SVG is
          labelled and its boxes are reachable — but the map is reference
          material, and a reader who wants to read rather than look should not
          have to click sixteen boxes to do it. */}
      <section className="space-y-4">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-text-dim">
          Every position, best to worst
        </h2>
        <ol className="space-y-2">
          {placed.map((n) => (
            <li
              key={n.id}
              className="rounded-xl border border-line bg-surface px-4 py-3"
            >
              <button
                type="button"
                onClick={() => setSelected(n.id)}
                className="text-left font-medium hover:underline"
              >
                {n.label}
              </button>
              <p className="mt-1 text-sm leading-relaxed text-text-muted">
                {n.note}
              </p>
            </li>
          ))}
        </ol>
      </section>
    </div>
  );
}

/** One side of a node's edges, as words. */
function EdgeList({
  title,
  edges,
  byID,
  dir,
  onPick,
}: {
  title: string;
  edges: { from: string; to: string; label: string; kind: RoundMapEdgeKind }[];
  byID: Map<string, Placed>;
  dir: "to" | "from";
  onPick: (id: string) => void;
}) {
  if (edges.length === 0) return null;
  return (
    <div className="border-t border-line-soft pt-3">
      <h3 className="text-xs font-semibold uppercase tracking-wide text-text-dim">
        {title}
      </h3>
      <ul className="mt-1 space-y-1">
        {edges.map((e, i) => {
          const other = byID.get(dir === "to" ? e.to : e.from);
          if (!other) return null;
          return (
            <li key={`${e.from}-${e.to}-${i}`} className="text-sm">
              <span
                aria-hidden
                className="mr-2 inline-block h-0.5 w-3 rounded align-middle"
                style={{ background: KIND[e.kind].stroke }}
              />
              {/* The kind IN WORDS, not only in the swatch's hue. The diagram
                  can lean on colour because its toggles carry the words; this
                  list has no such control beside it, so without this the only
                  difference between an advancing edge and a conceding one is a
                  3px coloured dash that is `aria-hidden`. That is the palette
                  rule broken in the one place nobody would look. */}
              <span className="text-text-dim">{KIND[e.kind].label}</span>{" "}
              <span className="text-text-muted">{e.label}</span>{" "}
              <button
                type="button"
                onClick={() => onPick(other.id)}
                className="font-medium hover:underline"
              >
                {other.label}
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
