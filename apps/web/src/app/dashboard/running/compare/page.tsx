"use client";

import { Suspense, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useAuth } from "@clerk/nextjs";

import { getSession, isNotFound, type Session, type Token } from "@/lib/api";
import { getRunningDetail, runSetFrom, type RunningDetail } from "@/lib/runningApi";
import { compareRuns, type RunSummary } from "@/lib/runningAnalysis";
import { formatDistance, formatPace, type UnitSystem } from "@/lib/units";
import { formatDuration } from "@/lib/history";
import { useUnits } from "@/lib/useUnits";
import { RouteMap } from "../RouteMap";

/**
 * Two runs, side by side (N464's AC: "at least two runs can be compared").
 *
 * Reads `?a=<sessionId>&b=<sessionId>` — set by the "Compare selected"
 * button on `dashboard/running/page.tsx` — rather than taking a route param
 * pair, so the comparison is a shareable/bookmarkable URL like every other
 * filtered view in this app (`?sport=`, `?from=&to=` on History).
 *
 * `useSearchParams()` needs a `Suspense` boundary in the App Router or the
 * page fails the production build with "should be wrapped in a suspense
 * boundary" — the inner component is the one that actually reads it.
 */
export default function ComparePage() {
  return (
    <Suspense fallback={null}>
      <CompareContent />
    </Suspense>
  );
}

function CompareContent() {
  const params = useSearchParams();
  const idA = params.get("a");
  const idB = params.get("b");
  const { getToken } = useAuth();
  const { units } = useUnits();

  const [runA, setRunA] = useState<RunData | null>(null);
  const [runB, setRunB] = useState<RunData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  // Bumped by "Try again" to re-run the effect below without either id
  // having changed — `idA`/`idB` alone can't be a retry trigger, since a
  // retry on the same URL asks for the same two ids.
  const [retryNonce, setRetryNonce] = useState(0);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    // No fetch to make without both ids — and nothing to set either: the
    // render below checks `!idA || !idB` BEFORE it ever looks at `loading`,
    // so leaving `loading` at its initial `true` here is inert rather than
    // stuck.
    if (!idA || !idB) return;
    abortRef.current?.abort();
    const c = new AbortController();
    abortRef.current = c;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setLoading(true);
    setError(null);
    Promise.all([loadRun(getToken, idA, c.signal), loadRun(getToken, idB, c.signal)])
      .then(([a, b]) => {
        if (c.signal.aborted) return;
        setRunA(a);
        setRunB(b);
      })
      .catch((err) => {
        if (c.signal.aborted) return;
        setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (!c.signal.aborted) setLoading(false);
      });
    return () => c.abort();
  }, [getToken, idA, idB, retryNonce]);

  if (!idA || !idB) {
    return (
      <div className="rounded-card border border-dashed border-line px-6 py-16 text-center">
        <p className="font-display text-xl font-bold">Pick two runs to compare</p>
        <p className="mx-auto mt-2 max-w-sm text-sm text-text-muted">
          Select two from{" "}
          <Link href="/dashboard/running" className="text-lime underline">
            your runs
          </Link>{" "}
          and choose Compare selected.
        </p>
      </div>
    );
  }

  if (loading) {
    return (
      <div aria-busy="true" aria-label="Loading comparison" className="flex flex-col gap-6">
        <div className="h-10 w-64 animate-pulse rounded-card bg-surface" />
        <div className="grid gap-6 sm:grid-cols-2">
          <div className="h-96 animate-pulse rounded-card border border-line bg-surface" />
          <div className="h-96 animate-pulse rounded-card border border-line bg-surface" />
        </div>
      </div>
    );
  }

  if (error || !runA || !runB) {
    return (
      <p
        role="alert"
        className="rounded-card border border-danger/40 bg-danger/10 px-4 py-3 text-sm"
      >
        {error ?? "Couldn't load one of these runs."}{" "}
        <button
          type="button"
          onClick={() => setRetryNonce((n) => n + 1)}
          className="underline"
        >
          Try again
        </button>
      </p>
    );
  }

  const summaryA = summaryOf(runA);
  const summaryB = summaryOf(runB);
  const diff = compareRuns(summaryA, summaryB);

  return (
    <div className="flex flex-col gap-8">
      <header>
        <Link
          href="/dashboard/running"
          className="text-xs text-text-dim underline hover:text-text"
        >
          ← All runs
        </Link>
        <h1 className="mt-1 font-display text-4xl font-bold">Compare runs</h1>
      </header>

      <div className="grid gap-3 sm:grid-cols-2">
        <DiffStat
          label="Distance"
          format={(v) => formatDistance(v, units)}
          delta={diff.distanceDeltaM}
          higherIsMore
        />
        <DiffStat
          label="Duration"
          format={(v) => formatDuration(v)}
          delta={diff.durationDeltaSeconds}
          higherIsMore
        />
        <DiffStat
          label="Avg pace"
          format={(v) => formatPace(v, units)}
          delta={diff.paceDeltaSecPerKm}
          // A LOWER pace number (fewer seconds per km) is faster, so a
          // negative delta here is the "more" direction — the one place this
          // metric inverts the usual "up is more" reading.
          higherIsMore={false}
        />
        <DiffStat
          label="Elevation gain"
          format={(v) => formatDistance(v, units)}
          delta={diff.elevationGainDeltaM}
          higherIsMore
        />
      </div>

      <div className="grid gap-6 sm:grid-cols-2">
        <RunColumn run={runA} units={units} />
        <RunColumn run={runB} units={units} />
      </div>
    </div>
  );
}

type RunData = { session: Session; detail: RunningDetail | null };

async function loadRun(getToken: Token, id: string, signal: AbortSignal): Promise<RunData> {
  const [s, detail] = await Promise.all([
    getSession(getToken, id, signal),
    getRunningDetail(getToken, id, signal).catch((err) => {
      if (isNotFound(err)) return null;
      throw err;
    }),
  ]);
  return { session: s.session, detail };
}

function summaryOf({ session, detail }: RunData): RunSummary {
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
  return {
    sessionId: session.id,
    name: session.name || "Run",
    startedAt: session.started_at,
    distanceM,
    durationSeconds,
    avgPaceSecPerKm,
    elevationGainM: detail?.elevation_gain_m ?? null,
  };
}

function RunColumn({ run, units }: { run: RunData; units: UnitSystem }) {
  const summary = summaryOf(run);
  return (
    <div className="flex flex-col gap-3">
      <div>
        <Link
          href={`/dashboard/running/${run.session.id}`}
          className="font-display text-lg font-bold underline-offset-2 hover:underline"
        >
          {summary.name}
        </Link>
        <p className="text-xs text-text-dim">
          <time dateTime={summary.startedAt}>
            {new Date(summary.startedAt).toLocaleDateString(undefined, {
              weekday: "short",
              day: "numeric",
              month: "short",
              year: "numeric",
            })}
          </time>
        </p>
      </div>
      <dl className="grid grid-cols-3 gap-2">
        <MiniStat label="Dist" value={formatDistance(summary.distanceM, units)} />
        <MiniStat
          label="Time"
          value={summary.durationSeconds ? formatDuration(summary.durationSeconds) : "—"}
        />
        <MiniStat label="Pace" value={formatPace(summary.avgPaceSecPerKm, units)} />
      </dl>
      {run.detail && run.detail.route_points.length > 0 ? (
        <RouteMap points={run.detail.route_points} />
      ) : (
        <div className="flex h-48 items-center justify-center rounded-card border border-dashed border-line text-sm text-text-dim">
          No GPS track for this run.
        </div>
      )}
    </div>
  );
}

function MiniStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-card border border-line bg-surface px-3 py-2">
      <dt className="eyebrow text-[0.55rem]">{label}</dt>
      <dd className="stat text-base">{value}</dd>
    </div>
  );
}

/**
 * One metric's delta, coloured neutral-to-favourable rather than plain
 * red/green — matching `Stat` on the sessions History page: more volume in a
 * build block is progress, more in a taper is not, and this codebase's
 * stance is to state the direction and leave the judgement to whoever knows
 * what the two runs were for.
 */
function DiffStat({
  label,
  format,
  delta,
  higherIsMore,
}: {
  label: string;
  format: (v: number) => string;
  delta: number | null;
  higherIsMore: boolean;
}) {
  if (delta === null) {
    return (
      <div className="rounded-card border border-line bg-surface px-4 py-3">
        <dt className="eyebrow text-[0.625rem]">{label}</dt>
        <dd className="mt-0.5 text-sm text-text-dim">Not comparable</dd>
      </div>
    );
  }
  const more = higherIsMore ? delta > 0 : delta < 0;
  const unchanged = delta === 0;
  return (
    <div className="rounded-card border border-line bg-surface px-4 py-3">
      <dt className="eyebrow text-[0.625rem]">{label}</dt>
      <dd className="stat mt-0.5 text-xl">
        {delta > 0 ? "+" : delta < 0 ? "−" : ""}
        {format(Math.abs(delta))}
      </dd>
      <p className="mt-1 text-xs text-text-dim">
        {unchanged ? "no change" : more ? "B is more" : "B is less"}
      </p>
    </div>
  );
}
