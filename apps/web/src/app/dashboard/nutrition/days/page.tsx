"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useAuth } from "@clerk/nextjs";

import { addDays, formatDayLong, today } from "@/lib/history";
import { listDays, type DayTotals } from "@/lib/nutritionApi";
import { dateRange } from "@/lib/nutritionSeries";

/**
 * Pick a day to correct.
 *
 * Six weeks of days, newest first, each one either a total or an honest
 * "nothing logged". **Rule 1 applies to a list exactly as it applies to a
 * chart** — and arguably harder here, because "0 kcal" in a table reads as a
 * measured figure rather than as the missing row it is.
 *
 * A date field sits above it for anything older, because six weeks is where a
 * scrolling list stops being a list and starts being a search problem, and a
 * date is what somebody actually has in mind when they go back further than
 * that.
 */

/** Six weeks. Long enough to cover "I forgot to log the weekend before last",
 *  short enough that the answer is visible without scrolling for a minute. */
const RECENT_DAYS = 42;

export default function CorrectDayPage() {
  const { getToken } = useAuth();
  const router = useRouter();
  const now = useMemo(() => today(), []);
  const from = useMemo(() => addDays(now, -(RECENT_DAYS - 1)), [now]);

  const [days, setDays] = useState<DayTotals[]>([]);
  const [jump, setJump] = useState(now);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const load = useCallback(async () => {
    abortRef.current?.abort();
    const c = new AbortController();
    abortRef.current = c;
    setLoading(true);
    setError(null);
    try {
      const d = await listDays(getToken, { from, to: now }, c.signal);
      if (!c.signal.aborted) setDays(d);
    } catch (e) {
      if (!c.signal.aborted) {
        setError(e instanceof Error ? e.message : "Could not load your days.");
      }
    } finally {
      if (!c.signal.aborted) setLoading(false);
    }
  }, [getToken, from, now]);

  useEffect(() => {
    // The same disable every fetch-on-mount screen in this app carries: the
    // rule cannot see that `load` aborts its own previous request and bails on
    // `signal.aborted` before any setState, so the cascade it warns about is
    // one render on mount rather than a loop. Removing the fetch is not the
    // alternative — there is no data without it.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load();
    return () => abortRef.current?.abort();
  }, [load]);

  const byDate = useMemo(() => new Map(days.map((d) => [d.eaten_on, d])), [days]);
  const rows = useMemo(() => dateRange(from, now).reverse(), [from, now]);

  return (
    <div className="flex flex-col gap-6">
      <form
        className="flex flex-wrap items-end gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          router.push(`/dashboard/nutrition/days/${jump}`);
        }}
      >
        <label className="flex flex-col gap-1 text-xs">
          <span className="text-text-muted">Go to a day</span>
          <input
            type="date"
            value={jump}
            max={now}
            onChange={(e) => setJump(e.target.value)}
            className="rounded-control border border-line bg-bg px-3 py-2 text-sm text-text"
          />
        </label>
        <button
          type="submit"
          className="rounded-control border border-line px-4 py-2 text-sm font-semibold"
        >
          Open
        </button>
      </form>

      {error && (
        <p role="alert" className="rounded-card border border-danger/40 bg-danger/10 p-3 text-sm text-danger-ink">
          {error}
        </p>
      )}

      {loading && days.length === 0 ? (
        <p className="text-sm text-text-dim">Loading…</p>
      ) : (
        <section className="rounded-card border border-line bg-surface">
          <ul className="divide-y divide-line-soft">
            {rows.map((date) => {
              const d = byDate.get(date);
              return (
                <li key={date}>
                  <Link
                    href={`/dashboard/nutrition/days/${date}`}
                    className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 px-4 py-3 hover:bg-surface-hover"
                  >
                    <span className="text-sm">
                      {formatDayLong(date)}
                      {date === now && <span className="text-text-dim"> · today</span>}
                    </span>
                    {d ? (
                      <span className="text-sm tabular-nums text-text-muted">
                        {Math.round(d.kcal)} kcal · {Math.round(d.protein_g)}P /{" "}
                        {Math.round(d.carb_g)}C / {Math.round(d.fat_g)}F ·{" "}
                        {d.entries} {d.entries === 1 ? "entry" : "entries"}
                        {d.target_kcal != null && (
                          <span className="text-text-dim"> · target {d.target_kcal}</span>
                        )}
                      </span>
                    ) : (
                      // NOT "0 kcal". A zero in a table looks like a
                      // measurement, and this is the absence of one.
                      <span className="text-sm text-text-dim">Nothing logged</span>
                    )}
                  </Link>
                </li>
              );
            })}
          </ul>
        </section>
      )}
    </div>
  );
}
