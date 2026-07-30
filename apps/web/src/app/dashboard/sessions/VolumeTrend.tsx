"use client";

import { useMemo } from "react";

import type { HistoryDay } from "@/lib/api";
import { byWeek, formatDuration, loadMetric, monthShort } from "@/lib/history";
import { formatVolume } from "@/lib/units";
import { useUnits } from "@/lib/useUnits";

/**
 * Weekly load, as bars.
 *
 * The question this answers is the one totals can't: is the block building or
 * decaying. A deload is supposed to look like a dip, and a dip you didn't
 * plan is the thing worth noticing.
 *
 * Bars rather than a line, and CSS rather than a charting library: this is a
 * row of rectangles, the dependency would outweigh the drawing, and building
 * it here keeps the markup accessible instead of an opaque canvas.
 */
export function VolumeTrend({
  from,
  to,
  days,
}: {
  from: string;
  to: string;
  days: HistoryDay[];
}) {
  const { units } = useUnits();
  const metric = loadMetric(days);
  const weeks = useMemo(() => byWeek(from, to, days), [from, to, days]);

  const value = (w: (typeof weeks)[number]) =>
    metric === "volume" ? w.tonnageKg : w.minutes;
  const peak = Math.max(1, ...weeks.map(value));
  const format = (v: number) =>
    metric === "volume" ? formatVolume(v, units) : formatDuration(v * 60);

  // Counted off sessions, not off the metric. The axis can only show one
  // measure, and `metric` is chosen for the whole period — so in a block that
  // mixes lifting with BJJ, every mat-only week scores zero volume. Counting
  // those as untrained printed "10 of 12 weeks trained" over twelve trained
  // weeks, which is not a rounding error, it's a false statement about
  // someone's training.
  const trained = weeks.filter((w) => w.sessions > 0).length;

  if (weeks.length < 2) return null;

  return (
    <section className="flex flex-col gap-3" aria-labelledby="trend-heading">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 id="trend-heading" className="eyebrow">
          Weekly {metric}
        </h2>
        <p className="text-[0.6875rem] text-text-dim">
          {trained} of {weeks.length} weeks trained · peak {format(peak)}
        </p>
      </div>

      <div className="rounded-card border border-line bg-surface p-4">
        {/* A list, not a canvas: every bar is a labelled row to a screen
            reader, so the trend is readable without seeing it. */}
        <ul className="flex h-32 items-end gap-1" role="list">
          {weeks.map((w) => {
            const v = value(w);
            const sessions = `${w.sessions} ${w.sessions === 1 ? "session" : "sessions"}`;
            // Three states, not two. A week can have training the axis can't
            // measure — BJJ under a volume axis — and calling that "no
            // training" is the one thing this label must never say.
            const detail =
              v > 0 ? format(v) : w.sessions > 0 ? `${sessions}, no ${metric} logged` : "no training";
            const label = `Week of ${monthShort(w.start)} ${Number(w.start.slice(8))}: ${detail}`;
            return (
              <li
                key={w.start}
                className="group relative flex h-full flex-1 items-end"
                title={label}
              >
                <span className="sr-only">{label}</span>
                <span
                  aria-hidden="true"
                  className={`w-full rounded-t-[3px] transition-colors ${
                    v > 0
                      ? "bg-lime group-hover:bg-green"
                      : w.sessions > 0
                        ? // Trained, just not in this measure. Dimmed rather
                          // than absent, so the week still reads as a week
                          // that happened.
                          "bg-lime/30 group-hover:bg-lime/50"
                        : "bg-line-soft"
                  }`}
                  // A trained week must never round to invisible: 2px is the
                  // floor, so a light week reads as light rather than absent.
                  style={{
                    height:
                      v > 0 ? `${Math.max(2, (v / peak) * 100)}%` : w.sessions > 0 ? "6%" : "2px",
                  }}
                />
              </li>
            );
          })}
        </ul>

        <div className="mt-2 flex justify-between text-[0.6875rem] text-text-dim">
          <span>{monthShort(weeks[0].start)}</span>
          <span>{monthShort(weeks[weeks.length - 1].start)}</span>
        </div>
      </div>
    </section>
  );
}
