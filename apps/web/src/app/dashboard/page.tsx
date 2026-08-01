"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useAuth } from "@clerk/nextjs";

import {
  fetchHistory,
  labelForModule,
  listSessionsPage,
  listWorkouts,
  type History,
  type Session,
  type Workout,
} from "@/lib/api";
import {
  addDays,
  delta,
  formatDuration,
  loadMetric,
  localZone,
  today,
} from "@/lib/history";
import { useModules } from "@/lib/ModulesProvider";
import { useUnits } from "@/lib/useUnits";
import { formatWeight } from "@/lib/units";

/**
 * Today — the first screen of the desk app.
 *
 * **It used to read `activities`**, a table that has had no writer since the
 * in-app logging form was removed. So its three headline numbers were 0, 0 and
 * a template count, and its list showed "Nothing logged yet — log a session in
 * the mobile app" to athletes who had done exactly that. It was the home page
 * of the product, and it was blind to the product's own data.
 *
 * Now it reads what actually gets written: `sessions` and `session_sets`.
 *
 * **Three requests, run concurrently, and each earns its place:**
 *  1. `GET /sessions/history` — the whole stat row in one call. It returns
 *     server-side aggregates *and* the same-length previous window, which is
 *     what makes "this week vs last" free rather than a second query.
 *  2. `GET /sessions?limit=8` — the recent list, and its `total` gives the
 *     all-time count without a separate count query.
 *  3. `GET /workouts?scope=mine` — templates.
 *
 * The stat row's third metric is chosen by `loadMetric` from **the data
 * present**, not from the enabled modules: an athlete with strength switched on
 * who spent the week on the mat sees Mat time, not a flat 0 kg. That
 * distinction — toggles decide what you can reach, data decides what you can
 * read — is the registry's rule and this is its clearest case.
 */

const WINDOW_DAYS = 7;

export default function TodayPage() {
  const { getToken } = useAuth();
  const { modules } = useModules();
  const { units } = useUnits();

  const [history, setHistory] = useState<History | null>(null);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [sessionTotal, setSessionTotal] = useState(0);
  const [workouts, setWorkouts] = useState<Workout[]>([]);
  const [everLoaded, setEverLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const load = useCallback(async () => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    const to = today();
    try {
      const [hist, page, mine] = await Promise.all([
        fetchHistory(
          getToken,
          { from: addDays(to, -(WINDOW_DAYS - 1)), to, tz: localZone() },
          controller.signal,
        ),
        listSessionsPage(getToken, { limit: 8 }, controller.signal),
        listWorkouts(getToken, "mine", controller.signal),
      ]);
      if (controller.signal.aborted) return;
      setHistory(hist);
      setSessions(page.sessions);
      setSessionTotal(page.total);
      setWorkouts(mine);
      setEverLoaded(true);
      setError(null);
    } catch (err) {
      if (controller.signal.aborted) return;
      setError(err instanceof Error ? err.message : String(err));
      setEverLoaded(true);
    }
  }, [getToken]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load();
    return () => abortRef.current?.abort();
  }, [load]);

  const totals = history?.totals;
  const prev = history?.previous;
  const metric = history ? loadMetric(history.days) : "volume";
  // Always an em dash, never "0". `everLoaded` is true after a *failed* load
  // too, so a "0" branch renders a fabricated zero precisely when the figure
  // is unknown — on the screen whose own comment two lines down says it must
  // never lie. A real zero comes from `totals`, which only exists on success.
  const dash = "—";

  return (
    <div className="flex flex-col gap-10">
      <header>
        <p className="eyebrow">Last {WINDOW_DAYS} days</p>
        <h1 className="font-display text-4xl font-bold">Overview</h1>
      </header>

      {error && (
        <p
          role="alert"
          className="rounded-card border border-danger/40 bg-danger/10 px-4 py-3 text-sm"
        >
          {error}
        </p>
      )}

      {/* Real numbers only. The Readiness/Load/Fuel dials from the design doc
          need data we don't collect yet, and a placeholder dial would be a
          fabricated number on the one screen that must never lie. */}
      <section className="grid gap-4 sm:grid-cols-3">
        <Stat
          label="Sessions"
          value={totals ? String(totals.sessions) : dash}
          change={totals && prev ? delta(totals.sessions, prev.sessions) : null}
        />
        <Stat
          label="Working sets"
          value={totals ? String(totals.working_sets) : dash}
          change={
            totals && prev ? delta(totals.working_sets, prev.working_sets) : null
          }
        />
        {metric === "volume" ? (
          <Stat
            label="Volume"
            value={totals ? formatWeight(totals.tonnage_kg, units) : dash}
            change={
              totals && prev ? delta(totals.tonnage_kg, prev.tonnage_kg) : null
            }
          />
        ) : (
          <Stat
            label="Time"
            value={totals ? formatDuration(totals.duration_seconds) : dash}
            change={
              totals && prev
                ? delta(totals.duration_seconds, prev.duration_seconds)
                : null
            }
          />
        )}
      </section>

      {/* Two columns from `lg` up. On a desk the recent list and the templates
          you'd start from are both wanted at once — stacking them means the
          second one is below the fold on the screen with the most room. */}
      <div className="grid gap-8 lg:grid-cols-[1.6fr_1fr]">
        <section className="flex min-w-0 flex-col gap-3">
          <div className="flex items-baseline justify-between">
            <h2 className="eyebrow">Recent sessions</h2>
            <Link
              href="/dashboard/sessions"
              className="text-sm text-text-muted hover:text-text"
            >
              All {sessionTotal > 0 ? sessionTotal : ""} →
            </Link>
          </div>

          {!everLoaded ? (
            <p className="text-sm text-text-muted">Loading…</p>
          ) : sessions.length === 0 ? (
            <div className="rounded-card border border-dashed border-line px-6 py-12 text-center">
              <p className="font-medium">Nothing logged yet</p>
              <p className="mt-1 text-sm text-text-muted">
                Log a session on your phone — it syncs here automatically.
              </p>
            </div>
          ) : (
            <ul className="flex flex-col gap-2">
              {sessions.map((s) => (
                // Deep-linked, matching History's own rows: /dashboard/
                // sessions/[id] exists and sessions/page.tsx already links to
                // it. An earlier comment here claimed no such target existed —
                // it was wrong, and identical rows being clickable on one
                // screen and inert on the next is felt immediately.
                <li key={s.id}>
                  <Link
                    href={`/dashboard/sessions/${s.id}`}
                    className="flex items-center justify-between gap-4 rounded-card border border-line bg-surface px-4 py-3 transition hover:bg-surface-raised"
                  >
                    <span className="min-w-0">
                      <span className="block truncate font-medium">
                        {s.name || labelForModule(modules, s.sport)}
                      </span>
                      <span className="block truncate text-sm text-text-dim">
                        {labelForModule(modules, s.sport)} ·{" "}
                        {s.sets.length === 1 ? "1 set" : `${s.sets.length} sets`}
                        {s.ended_at ? "" : " · in progress"}
                      </span>
                    </span>
                    <span className="stat shrink-0 text-sm text-text-muted">
                      {DAY.format(new Date(s.started_at))}
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="flex min-w-0 flex-col gap-3">
          <div className="flex items-baseline justify-between">
            <h2 className="eyebrow">Your templates</h2>
            <Link
              href="/dashboard/workouts"
              className="text-sm text-text-muted hover:text-text"
            >
              Build →
            </Link>
          </div>

          {!everLoaded ? (
            <p className="text-sm text-text-muted">Loading…</p>
          ) : workouts.length === 0 ? (
            <div className="rounded-card border border-dashed border-line px-6 py-8 text-center">
              <p className="text-sm text-text-muted">
                No templates yet. Building one is a desk job — that&apos;s what
                this screen is for.
              </p>
            </div>
          ) : (
            <ul className="flex flex-col gap-2">
              {workouts.slice(0, 6).map((w) => (
                <li key={w.id}>
                  <Link
                    href={`/dashboard/workouts/${w.id}`}
                    className="flex items-center justify-between gap-3 rounded-card border border-line bg-surface px-4 py-3 transition hover:bg-surface-raised"
                  >
                    <span className="min-w-0 truncate font-medium">{w.name}</span>
                    <span className="shrink-0 text-sm text-text-muted">
                      {labelForModule(modules, w.sport)}
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </div>
  );
}

// Fixed locale and zone: the default resolves differently during SSR than in
// the browser, which mismatches on hydration.
const DAY = new Intl.DateTimeFormat("en-GB", {
  dateStyle: "medium",
  timeZone: "UTC",
});

/**
 * A number with its direction.
 *
 * `change` is null when there is nothing to compare against — a first week, or
 * a previous window of zero. Rendering "+100%" against zero would be arithmetic
 * dressed up as insight, so nothing is shown instead.
 */
function Stat({
  label,
  value,
  change,
}: {
  label: string;
  value: string;
  change?: number | null;
}) {
  return (
    <div className="relative overflow-hidden rounded-card border border-line bg-surface p-5">
      <span
        aria-hidden="true"
        className="accent-rule absolute inset-x-0 top-0 h-[2px]"
      />
      <p className="eyebrow">{label}</p>
      <p className="stat mt-1 text-5xl">{value}</p>
      {change != null && Math.abs(change) >= 1 && (
        <p className="mt-1 text-sm text-text-muted">
          <span aria-hidden="true">{change > 0 ? "↑" : "↓"} </span>
          <span className="sr-only">{change > 0 ? "up " : "down "}</span>
          {Math.abs(Math.round(change))}% vs previous {WINDOW_DAYS} days
        </p>
      )}
    </div>
  );
}
