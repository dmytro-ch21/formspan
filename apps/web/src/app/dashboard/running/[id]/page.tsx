"use client";

import { use, useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useAuth } from "@clerk/nextjs";

import { getSession, isNotFound, type Session } from "@/lib/api";
import { getRunningDetail, runSetFrom, type RunningDetail } from "@/lib/runningApi";
import { elevationProfile, hasElevationData, splitPaceSecPerKm, splitsToCSV } from "@/lib/runningAnalysis";
import { formatDistance, formatPace, type UnitSystem } from "@/lib/units";
import { formatDuration } from "@/lib/history";
import { useUnits } from "@/lib/useUnits";
import { RouteMap } from "../RouteMap";
import { ElevationChart } from "../ElevationChart";
import { PaceZoneChart } from "../PaceZoneChart";

/**
 * One run, at desk depth: full route map, elevation profile, pace-zone
 * breakdown, splits, and a CSV export of the splits (N464's optional
 * nice-to-have).
 */
export default function RunDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  const { getToken } = useAuth();
  const { units } = useUnits();

  const [session, setSession] = useState<Session | null>(null);
  const [detail, setDetail] = useState<RunningDetail | null>(null);
  const [noDetail, setNoDetail] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const abortRef = useRef<AbortController | null>(null);

  const load = useCallback(() => {
    abortRef.current?.abort();
    const c = new AbortController();
    abortRef.current = c;
    setLoading(true);
    setError(null);
    setNoDetail(false);
    Promise.all([
      getSession(getToken, id, c.signal),
      getRunningDetail(getToken, id, c.signal).catch((err) => {
        // A run logged with no detail yet (a manual entry with only a
        // distance/duration, say) is a real, expected state — see this
        // module's own package doc — not a page-level error.
        if (isNotFound(err)) {
          if (!c.signal.aborted) setNoDetail(true);
          return null;
        }
        throw err;
      }),
    ])
      .then(([s, d]) => {
        if (c.signal.aborted) return;
        setSession(s.session);
        setDetail(d);
      })
      .catch((err) => {
        if (c.signal.aborted) return;
        setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (!c.signal.aborted) setLoading(false);
      });
  }, [getToken, id]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load();
    return () => abortRef.current?.abort();
  }, [load]);

  if (loading) {
    return (
      <div aria-busy="true" aria-label="Loading run" className="flex flex-col gap-6">
        <div className="h-10 w-64 animate-pulse rounded-card bg-surface" />
        <div className="h-96 animate-pulse rounded-card border border-line bg-surface" />
      </div>
    );
  }

  if (error) {
    return (
      <p
        role="alert"
        className="rounded-card border border-danger/40 bg-danger/10 px-4 py-3 text-sm"
      >
        {error}{" "}
        <button type="button" onClick={load} className="underline">
          Try again
        </button>
      </p>
    );
  }

  if (!session) return null;

  const runSet = runSetFrom(session.sets);
  const distanceM = detail?.distance_m ?? runSet?.distance_m ?? null;
  const durationSeconds =
    detail?.duration_seconds ??
    runSet?.seconds ??
    (session.ended_at
      ? (new Date(session.ended_at).getTime() - new Date(session.started_at).getTime()) / 1000
      : null);
  const avgPaceSecPerKm =
    detail?.avg_pace_sec_per_km ??
    (distanceM && distanceM > 0 && durationSeconds
      ? durationSeconds / (distanceM / 1000)
      : null);

  return (
    <div className="flex flex-col gap-8">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <Link
            href="/dashboard/running"
            className="text-xs text-text-dim underline hover:text-text"
          >
            ← All runs
          </Link>
          <h1 className="mt-1 font-display text-4xl font-bold">
            {session.name || "Run"}
          </h1>
          <p className="mt-1 text-sm text-text-dim">
            <time dateTime={session.started_at}>
              {new Date(session.started_at).toLocaleDateString(undefined, {
                weekday: "long",
                day: "numeric",
                month: "long",
                year: "numeric",
              })}
            </time>
          </p>
        </div>
        {detail && detail.splits.length > 0 && (
          <ExportCsvButton sessionName={session.name || "run"} splits={detail.splits} />
        )}
      </header>

      <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat label="Distance" value={formatDistance(distanceM, units)} />
        <Stat label="Duration" value={durationSeconds ? formatDuration(durationSeconds) : "—"} />
        <Stat label="Avg pace" value={formatPace(avgPaceSecPerKm, units)} />
        <Stat
          label="Elevation gain"
          // Always metres, on both unit systems — see ElevationChart.tsx's
          // doc comment. `formatDistance` was wrong here: on `imperial` it
          // renders a distance-sized number of METRES as yards or miles,
          // which is not a unit anyone reads elevation gain in.
          value={detail?.elevation_gain_m != null ? `${Math.round(detail.elevation_gain_m)}m` : "—"}
        />
      </dl>

      {noDetail ? (
        <p className="rounded-card border border-dashed border-line px-6 py-10 text-center text-sm text-text-muted">
          No route, elevation or split detail was recorded for this run —
          it&apos;s a summary only.
        </p>
      ) : (
        detail && (
          <>
            <section aria-label="Route map" className="flex flex-col gap-2">
              <h2 className="eyebrow">Route</h2>
              <RouteMap points={detail.route_points} />
            </section>

            {hasElevationData(detail.route_points) &&
              elevationProfile(detail.route_points).length >= 2 && (
              // Gated on the SAME condition `ElevationChart` itself checks
              // before returning null — this used to gate on
              // `route_points.length > 0` instead, which let a track with
              // points but no altitude on any of them (indoors, an older
              // phone), or with only one elevation-carrying point, render an
              // "Elevation" heading over nothing.
              <section aria-label="Elevation profile" className="flex flex-col gap-2">
                <h2 className="eyebrow">Elevation</h2>
                <ElevationChart
                  points={detail.route_points}
                  units={units}
                  elevationGainM={detail.elevation_gain_m}
                />
              </section>
            )}

            <section aria-label="Pace zones" className="flex flex-col gap-2">
              <h2 className="eyebrow">Pace zones</h2>
              <PaceZoneChart splits={detail.splits} units={units} />
            </section>

            {detail.splits.length > 0 && (
              <section aria-label="Splits" className="flex flex-col gap-2">
                <h2 className="eyebrow">Splits</h2>
                <SplitsTable splits={detail.splits} units={units} />
              </section>
            )}
          </>
        )
      )}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-card border border-line bg-surface px-4 py-3">
      <dt className="eyebrow text-[0.625rem]">{label}</dt>
      <dd className="stat mt-0.5 text-2xl">{value}</dd>
    </div>
  );
}

function SplitsTable({
  splits,
  units,
}: {
  splits: { distance_m: number; duration_seconds: number }[];
  units: UnitSystem;
}) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-left text-sm">
        <thead className="text-text-dim">
          <tr>
            <th scope="col" className="py-1 pr-4 font-medium">
              #
            </th>
            <th scope="col" className="py-1 pr-4 font-medium">
              Distance
            </th>
            <th scope="col" className="py-1 pr-4 font-medium">
              Time
            </th>
            <th scope="col" className="py-1 font-medium">
              Pace
            </th>
          </tr>
        </thead>
        <tbody>
          {splits.map((s, i) => (
            <tr key={i} className="border-t border-line">
              <td className="py-1 pr-4 text-text-dim">{i + 1}</td>
              <td className="py-1 pr-4">{formatDistance(s.distance_m, units)}</td>
              <td className="py-1 pr-4">{formatDuration(s.duration_seconds)}</td>
              <td className="py-1">{formatPace(splitPaceSecPerKm(s), units)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/**
 * A splits CSV, saved through an anchor click on an object URL — the
 * ordinary browser download mechanism, no server round-trip. N464 names this
 * optional; kept because `splitsToCSV` (`lib/runningAnalysis.ts`) already
 * exists and is unit-tested, so the marginal cost here is one button.
 */
function ExportCsvButton({
  sessionName,
  splits,
}: {
  sessionName: string;
  splits: { distance_m: number; duration_seconds: number }[];
}) {
  const onExport = () => {
    const csv = splitsToCSV(splits);
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${sessionName.replace(/[^\w-]+/g, "_") || "run"}-splits.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  };

  return (
    <button
      type="button"
      onClick={onExport}
      className="rounded-pill border border-line px-4 py-2 text-sm font-medium transition hover:bg-surface-raised"
    >
      Export splits (CSV)
    </button>
  );
}
