"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useAuth } from "@clerk/nextjs";

import {
  getBjjProficiency,
  type BjjProficiency,
  type BjjProficiencySummary,
} from "@/lib/api";

/**
 * The technique funnel, at desk depth.
 *
 * **Not a proficiency score, and that is the design.**
 * `docs/decisions/bjj-tracking-design.md` rules out asking anyone to rate
 * their triangle 1–5: people are bad at it, it goes stale, and it produces a
 * number with no provenance. What accumulates instead is small factual events
 * — drilled it today, went for it twice in rolling, landed it once — and this
 * page shows those, so every judgement it invites is one the reader can see
 * the basis for.
 *
 * The headline is the DROP-OFF, not the totals. "Drilled 34 techniques, taken
 * 6 of them into a live round" is a finding you can act on this week; "210
 * reps" is a statistic. That ordering — funnel first, list second — is the
 * whole reason this screen exists rather than a list of counters.
 *
 * Web, per the platform rule: this is review and analysis, done sitting down.
 * The phone captures the evidence mid-reflection; nothing here belongs on it.
 */

/** Below this, a hit rate is noise rather than a measurement. */
const MIN_TRIES_FOR_RATE = 5;

type Bucket = "all" | "untried" | "working" | "stalled";

const BUCKETS: { key: Bucket; label: string; blurb: string }[] = [
  { key: "all", label: "Everything", blurb: "Every technique with any evidence" },
  {
    key: "untried",
    label: "Never tried live",
    blurb: "Drilled, but never taken into a round — the most actionable list here",
  },
  { key: "working", label: "Landing", blurb: "Has worked live at least once" },
  {
    key: "stalled",
    label: "Not landing yet",
    blurb: "Tried live, hasn’t worked yet",
  },
];

function bucketOf(p: BjjProficiency): Exclude<Bucket, "all"> | null {
  const tried = p.attempted + p.scored;
  if (tried === 0) return p.drilled > 0 ? "untried" : null;
  return p.scored > 0 ? "working" : "stalled";
}

export default function ProficiencyPage() {
  const { getToken } = useAuth();
  const [rows, setRows] = useState<BjjProficiency[] | null>(null);
  const [summary, setSummary] = useState<BjjProficiencySummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [bucket, setBucket] = useState<Bucket>("all");
  const [search, setSearch] = useState("");
  const abortRef = useRef<AbortController | null>(null);

  const load = useCallback(async () => {
    abortRef.current?.abort();
    const c = new AbortController();
    abortRef.current = c;
    try {
      const data = await getBjjProficiency(getToken, c.signal);
      if (c.signal.aborted) return;
      setRows(data.techniques);
      setSummary(data.summary);
      setError(null);
    } catch (err) {
      if (c.signal.aborted) return;
      setError(err instanceof Error ? err.message : String(err));
      // An empty list, not a null one: the empty state below is written for
      // "no evidence yet", which is wrong here. The error banner carries the
      // real message and the list simply doesn't claim anything.
      setRows([]);
      setSummary(null);
    }
  }, [getToken]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load();
    return () => abortRef.current?.abort();
  }, [load]);

  const shown = useMemo(() => {
    if (!rows) return [];
    const q = search.trim().toLowerCase();
    return rows.filter((p) => {
      if (bucket !== "all" && bucketOf(p) !== bucket) return false;
      if (!q) return true;
      return (
        p.name.toLowerCase().includes(q) || p.position.toLowerCase().includes(q)
      );
    });
  }, [rows, bucket, search]);

  const counts = useMemo(() => {
    const c: Record<Bucket, number> = {
      all: rows?.length ?? 0,
      untried: 0,
      working: 0,
      stalled: 0,
    };
    for (const p of rows ?? []) {
      const b = bucketOf(p);
      if (b) c[b] += 1;
    }
    return c;
  }, [rows]);

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-col gap-1">
        <h1 className="font-display text-3xl font-bold tracking-wide">
          Technique funnel
        </h1>
        <p className="max-w-2xl text-sm text-text-muted">
          What you have drilled, what you have actually tried in a live round,
          and what has worked. Built from what you logged after each session —
          not from a self-rating, so every number here has a session behind it.
        </p>
      </header>

      {error && (
        <div
          role="alert"
          className="rounded-lg border border-danger/40 bg-danger/10 px-4 py-3 text-sm text-danger-ink"
        >
          <p className="font-semibold">Couldn’t load your funnel.</p>
          <p className="mt-0.5 text-text-muted">{error}</p>
          <button
            type="button"
            onClick={load}
            className="mt-2 rounded-md border border-line px-3 py-1.5 text-sm font-semibold hover:bg-surface-hover"
          >
            Try again
          </button>
        </div>
      )}

      {rows === null ? (
        <p className="text-sm text-text-muted">Loading…</p>
      ) : rows.length === 0 && !error ? (
        <EmptyState />
      ) : (
        <>
          {summary && <Funnel summary={summary} />}

          <div className="flex flex-col gap-3">
            <div
              className="flex flex-wrap gap-2"
              role="group"
              aria-label="Filter techniques"
            >
              {BUCKETS.map((b) => {
                const active = bucket === b.key;
                return (
                  <button
                    key={b.key}
                    type="button"
                    onClick={() => setBucket(b.key)}
                    aria-pressed={active}
                    title={b.blurb}
                    className={[
                      "rounded-full border px-3.5 py-1.5 text-sm font-semibold transition-colors",
                      active
                        ? "border-accent-fill bg-accent-fill text-accent-on-fill"
                        : "border-line text-text-muted hover:bg-surface-hover",
                    ].join(" ")}
                  >
                    {b.label}
                    <span className="ml-1.5 font-normal opacity-70">
                      {counts[b.key]}
                    </span>
                  </button>
                );
              })}
            </div>

            <label className="sr-only" htmlFor="proficiency-search">
              Search techniques
            </label>
            <input
              id="proficiency-search"
              type="search"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search by technique or position"
              className="w-full max-w-sm rounded-md border border-line bg-surface px-3 py-2 text-sm outline-none focus:border-text-muted"
            />
          </div>

          {shown.length === 0 ? (
            <p className="text-sm text-text-muted">
              Nothing in this filter{search.trim() ? " matches that search" : ""}.
            </p>
          ) : (
            <TechniqueTable rows={shown} />
          )}
        </>
      )}
    </div>
  );
}

/**
 * The headline, and the reason the page is ordered this way.
 *
 * Three counts of TECHNIQUES — not reps. The gaps between them are the
 * finding: a wide drilled→tried gap means class content is not reaching your
 * rolling, which is the single most common and most fixable pattern in BJJ.
 */
function Funnel({ summary }: { summary: BjjProficiencySummary }) {
  const stages = [
    { label: "Drilled", value: summary.drilled },
    { label: "Tried live", value: summary.tried_live },
    { label: "Landed live", value: summary.landed },
  ];
  const widest = Math.max(1, summary.drilled);
  return (
    <section
      aria-label="Funnel summary"
      className="flex flex-col gap-3 rounded-xl border border-line-soft bg-surface p-5"
    >
      <div className="flex flex-col gap-2.5">
        {stages.map((s) => (
          <div key={s.label} className="flex items-center gap-3">
            <span className="w-24 shrink-0 text-sm text-text-muted">
              {s.label}
            </span>
            {/* Decorative: the number beside it carries the same information,
                so the bar is not the only way to read this. */}
            <span
              aria-hidden="true"
              className="h-2.5 rounded-full bg-lime-rule"
              style={{
                width: `${Math.max(2, (s.value / widest) * 100)}%`,
                minWidth: "0.5rem",
              }}
            />
            <span className="text-sm font-semibold tabular-nums">{s.value}</span>
          </div>
        ))}
      </div>
      <p className="text-sm text-text-muted">
        {summary.drilled === 0
          ? "No techniques drilled yet."
          : summary.tried_live === 0
            ? `You have drilled ${summary.drilled} ${summary.drilled === 1 ? "technique" : "techniques"} and taken none of them into a live round yet.`
            : `You have drilled ${summary.drilled} ${summary.drilled === 1 ? "technique" : "techniques"}, tried ${summary.tried_live} live, and landed ${summary.landed}.`}
      </p>
    </section>
  );
}

function TechniqueTable({ rows }: { rows: BjjProficiency[] }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[44rem] border-collapse text-sm">
        <caption className="sr-only">
          Techniques with recorded evidence, most evidence first
        </caption>
        <thead>
          <tr className="border-b border-line text-left text-xs uppercase tracking-wider text-text-dim">
            <th scope="col" className="py-2 pr-4 font-semibold">
              Technique
            </th>
            <th scope="col" className="py-2 pr-4 font-semibold">
              Position
            </th>
            <th scope="col" className="py-2 pr-4 text-right font-semibold">
              Drilled
            </th>
            <th scope="col" className="py-2 pr-4 text-right font-semibold">
              Tried
            </th>
            <th scope="col" className="py-2 pr-4 text-right font-semibold">
              Landed
            </th>
            <th scope="col" className="py-2 pr-4 text-right font-semibold">
              Hit rate
            </th>
            <th scope="col" className="py-2 text-right font-semibold">
              Sessions
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((p) => {
            const tried = p.attempted + p.scored;
            return (
              <tr
                key={p.technique_id}
                className="border-b border-line-soft last:border-0"
              >
                <th
                  scope="row"
                  className="py-2.5 pr-4 text-left font-semibold font-normal"
                >
                  {p.name}
                  {p.drilled > 0 && tried === 0 && (
                    <span className="ml-2 rounded-full bg-surface-hover px-2 py-0.5 text-xs font-semibold text-text-muted">
                      never tried live
                    </span>
                  )}
                </th>
                <td className="py-2.5 pr-4 text-text-muted">
                  {p.position || "—"}
                </td>
                <td className="py-2.5 pr-4 text-right tabular-nums">
                  {p.drilled || "—"}
                </td>
                <td className="py-2.5 pr-4 text-right tabular-nums">
                  {tried || "—"}
                </td>
                <td className="py-2.5 pr-4 text-right tabular-nums font-semibold">
                  {p.scored || "—"}
                </td>
                <td className="py-2.5 pr-4 text-right tabular-nums text-text-muted">
                  {/* Withheld under a handful of tries, deliberately. One
                      landed out of one is not a 100% hit rate, and showing it
                      as one invites a conclusion the data cannot support. */}
                  {tried >= MIN_TRIES_FOR_RATE
                    ? `${Math.round((p.scored / tried) * 100)}%`
                    : tried > 0
                      ? <span title={`Needs ${MIN_TRIES_FOR_RATE} tries before this means anything`}>—</span>
                      : "—"}
                </td>
                <td className="py-2.5 text-right tabular-nums text-text-muted">
                  {p.sessions}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <p className="mt-3 max-w-2xl text-xs text-text-dim">
        “Tried” counts every time you went for it live, landed or not, so
        Landed is a subset of it. A hit rate appears once there are at least{" "}
        {MIN_TRIES_FOR_RATE} tries — below that it moves too much to mean
        anything. Sessions is how many separate sessions the evidence came
        from: the same count spread over six weeks is worth more than one
        night’s.
      </p>
    </div>
  );
}

function EmptyState() {
  return (
    <div className="rounded-xl border border-line-soft bg-surface p-6">
      <p className="font-semibold">No technique evidence yet.</p>
      <p className="mt-1 max-w-xl text-sm text-text-muted">
        This fills in from the reflection you do after a session on your phone —
        the techniques you drilled, and whether you took any of them into a
        live round. Log a class and add a few techniques, and the funnel starts
        here.
      </p>
    </div>
  );
}
