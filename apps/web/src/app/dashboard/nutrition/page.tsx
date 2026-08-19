"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useAuth } from "@clerk/nextjs";

import { fetchHistory, type HistoryDay } from "@/lib/api";
import { PERIODS, addDays, localZone, periodRange, today, type PeriodKey } from "@/lib/history";
import {
  listCheckins,
  listDays,
  listTargets,
  type Checkin,
  type DayTotals,
  type Target,
} from "@/lib/nutritionApi";
import {
  MEAN_WINDOW_DAYS,
  MIN_TREND_READINGS,
  adherence,
  buildSeries,
  fromDays,
  leadIn,
  trendChangeKG,
  windowMean,
} from "@/lib/nutritionSeries";
import { formatWeight, type UnitSystem } from "@/lib/units";
import { useUnits } from "@/lib/useUnits";
import { NutritionChart } from "./NutritionChart";

/**
 * The analytical surface — nutrition against training load against bodyweight,
 * on one timeline.
 *
 * The whole point of the screen is the JOIN. Any of the three alone is a
 * commodity chart; together they answer the questions an athlete actually has,
 * which are all comparative — is the weight moving at the rate the target was
 * built for, is the plateau food or is it a training block, did the week I ate
 * least happen to be the week I trained hardest.
 *
 * **Everything here is read-only.** Correcting a day is one click away and on
 * its own screen, because reading history and editing it are different modes
 * and mixing them is how a review surface turns into a logging surface.
 */

/** Matches the server's `maxDayWindowDays`. Exceeding it is a 400, not a
 *  truncation, so the clamp has to happen here. */
const MAX_DAY_WINDOW = 366;

export default function NutritionTrendPage() {
  const { getToken } = useAuth();
  const { units } = useUnits();
  const [period, setPeriod] = useState<PeriodKey>("3m");
  const [days, setDays] = useState<DayTotals[]>([]);
  const [targets, setTargets] = useState<Target[]>([]);
  const [checkins, setCheckins] = useState<Checkin[]>([]);
  const [training, setTraining] = useState<HistoryDay[]>([]);
  const [loading, setLoading] = useState(true);
  // Whether a load has ever COMPLETED, which `points` cannot tell us:
  // `buildSeries` returns one point per calendar day whether or not any data
  // arrived, so `points.length` is never zero and a guard on it can never
  // fire. Without this the first paint is a fully-drawn empty chart that then
  // fills in — which reads as "you logged nothing", the one thing this screen
  // must never say by accident.
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const range = useMemo(() => periodRange(period, today()), [period]);

  const load = useCallback(async () => {
    abortRef.current?.abort();
    const c = new AbortController();
    abortRef.current = c;
    setLoading(true);
    setError(null);

    // The lead-in makes the LEFT EDGE's rolling mean a real 7-day mean rather
    // than a 1-day one wearing the label — see `nutritionSeries.leadIn`. It is
    // clamped to the server's window cap: on a year view the clamp costs the
    // first few points some lookback, and they still report their own honest
    // day counts, so the result is a slightly softer left edge rather than an
    // overstated one.
    const floor = addDays(range.to, -(MAX_DAY_WINDOW - 1));
    const fetchFrom = leadIn(range.from) < floor ? floor : leadIn(range.from);

    try {
      const [d, t, w, h] = await Promise.all([
        listDays(getToken, { from: fetchFrom, to: range.to }, c.signal),
        listTargets(getToken, { from: fetchFrom, to: range.to }, c.signal),
        listCheckins(getToken, { from: fetchFrom, to: range.to }, c.signal),
        // The athlete's own zone, so a session logged at 22:00 lands on the
        // day they trained rather than on tomorrow.
        fetchHistory(getToken, { ...range, tz: localZone() }, c.signal),
      ]);
      if (c.signal.aborted) return;
      setDays(d);
      setTargets(t);
      setCheckins(w);
      setTraining(h.days);
      setLoaded(true);
    } catch (e) {
      if (c.signal.aborted) return;
      // `loaded` stays false: rendering the surfaces below a failed load means
      // an empty chart, "— / nothing logged in this period" tiles and the
      // gaps caption, all of which state something about the athlete's eating
      // that this request never learned.
      setError(e instanceof Error ? e.message : "Could not load your nutrition history.");
    } finally {
      if (!c.signal.aborted) setLoading(false);
    }
  }, [getToken, range]);

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

  const points = useMemo(
    () => buildSeries({ ...range, days, targets, checkins, training }),
    [range, days, targets, checkins, training],
  );

  const kcalMean = windowMean(points, (t) => t.kcal);
  const proteinMean = windowMean(points, (t) => t.protein_g);
  const logged = adherence(points);
  const weightChange = trendChangeKG(points);
  const liveTarget = points[points.length - 1]?.target ?? null;

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex gap-2" role="group" aria-label="Period">
          {PERIODS.map((p) => (
            <button
              key={p.key}
              type="button"
              onClick={() => setPeriod(p.key)}
              aria-pressed={p.key === period}
              className={`rounded-full border px-3 py-1 text-xs font-semibold transition ${
                p.key === period
                  ? "border-lime bg-lime/10 text-lime-ink"
                  : "border-line text-text-muted hover:text-text"
              }`}
            >
              {p.label}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-4">
          {/* Read, not just written. Once a load has succeeded the period
              buttons keep the OLD chart on screen while the new range fetches,
              which is right — a flash of "Loading…" on every click is worse
              than a moment of stale data — but only if the staleness is
              announced. A `loading` flag nothing renders is the "written but
              never read" shape this codebase has already paid for once. */}
          {loading && loaded && (
            <p role="status" className="text-xs text-text-dim">
              Updating…
            </p>
          )}
          <Link
            href="/dashboard/nutrition/days"
            className="text-xs font-semibold text-text-muted underline underline-offset-4 hover:text-text"
          >
            Correct a day
          </Link>
        </div>
      </div>

      {error && (
        <p role="alert" className="rounded-card border border-danger/40 bg-danger/10 p-3 text-sm text-danger-ink">
          {error}
        </p>
      )}

      {!loaded ? (
        error ? null : <p className="text-sm text-text-dim">Loading…</p>
      ) : (
        <>
          <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Stat
              label="Mean intake"
              value={kcalMean ? `${Math.round(kcalMean.value)} kcal` : "—"}
              // RULE 2, at its most visible. The number on its own is the
              // thing an athlete screenshots and argues from, so the count
              // travels WITH it rather than in a tooltip: 2,100 from 9 days of
              // 90 is not a diet, it is nine days.
              detail={kcalMean ? fromDays(kcalMean) : "nothing logged in this period"}
            />
            <Stat
              label="Mean protein"
              value={proteinMean ? `${Math.round(proteinMean.value)} g` : "—"}
              detail={proteinMean ? fromDays(proteinMean) : "nothing logged in this period"}
            />
            <Stat
              label="Days logged"
              value={`${logged.logged} / ${logged.considered}`}
              detail={
                logged.logged === logged.considered
                  ? "every day"
                  : `${logged.considered - logged.logged} ${logged.considered - logged.logged === 1 ? "day" : "days"} with nothing recorded`
              }
            />
            <Stat
              label="Trend weight"
              value={weightChange ? signedWeight(weightChange.kg, units) : "—"}
              detail={
                weightChange
                  ? `${weightChange.from} to ${weightChange.to}`
                  : // The real rule is MIN_TREND_READINGS weigh-ins inside the
                    // trailing window, at two separate points — not a
                    // consecutive run. The copy said "a 7-day run", which
                    // overstates it badly enough to talk somebody out of
                    // weighing in at all.
                    `needs ${MIN_TREND_READINGS} weigh-ins within ${MEAN_WINDOW_DAYS} days, at both ends of the period`
              }
            />
          </section>

          <section className="flex flex-col gap-3 rounded-card border border-line bg-surface p-4">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <h2 className="eyebrow">Intake, weight and training</h2>
              <p className="text-[0.6875rem] text-text-dim">
                {liveTarget
                  ? `Target ${liveTarget.kcal} kcal from ${liveTarget.effective_on}`
                  : "No target set"}
              </p>
            </div>

            <NutritionChart points={points} units={units} />

            <ul className="flex flex-wrap gap-x-5 gap-y-1 text-[0.6875rem] text-text-dim">
              <Key className="bg-lime">Logged intake</Key>
              <Key className="bg-info">Target (steps when it changes)</Key>
              <Key className="bg-text">{MEAN_WINDOW_DAYS}-day mean</Key>
              <Key className="bg-info-ink">Trend weight (right axis)</Key>
              <Key className="bg-text-dim">Training day</Key>
            </ul>

            {/* RULE 1, said out loud. The gaps are visible, but a reader who
                has not been told will read them as zero days rather than as
                unrecorded ones — which is the exact misreading the rule
                exists to prevent, arriving through the caption instead of
                through the data. */}
            <p className="text-[0.6875rem] text-text-dim">
              Days you did not log are drawn as gaps, not as zeros, and the
              mean and weight lines break across them. A missing day is not a
              day you ate nothing.
            </p>
          </section>
        </>
      )}
    </div>
  );
}

function Stat({
  label,
  value,
  detail,
}: {
  label: string;
  value: string;
  detail: string;
}) {
  return (
    <div className="rounded-card border border-line bg-surface p-4">
      <p className="eyebrow">{label}</p>
      <p className="stat mt-1">{value}</p>
      <p className="mt-1 text-[0.6875rem] text-text-dim">{detail}</p>
    </div>
  );
}

function Key({ className, children }: { className: string; children: React.ReactNode }) {
  return (
    <li className="flex items-center gap-1.5">
      <span aria-hidden="true" className={`inline-block h-2 w-4 rounded-sm ${className}`} />
      {children}
    </li>
  );
}

/** A weight change reads as a direction, so the sign is never dropped — and
 *  "0.0kg" is a real answer that must not render as "-0.0kg". */
function signedWeight(kg: number, units: UnitSystem): string {
  const formatted = formatWeight(Math.abs(kg), units);
  if (Math.abs(kg) < 0.05) return `±${formatted}`;
  return `${kg > 0 ? "+" : "−"}${formatted}`;
}
