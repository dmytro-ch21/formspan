"use client";

import { useMemo } from "react";

import type { HistoryDay } from "@/lib/api";
import { buildCalendar, formatDayLong, monthShort } from "@/lib/history";
import { labelForModule } from "@/lib/modules";
import { useModules } from "@/lib/ModulesProvider";

/**
 * The consistency view: one cell per day, a year at a glance.
 *
 * Consistency is the thing a training log is actually for. Totals say how
 * much; only this says whether it happened *regularly*, and a three-week gap
 * is visible here in a way no number makes it.
 *
 * Intensity is by working sets, falling back to session count for periods
 * with none — a month of BJJ has no sets to count, and rendering it uniformly
 * blank would say "you didn't train" about a month you did.
 */
export function TrainingCalendar({
  from,
  to,
  days,
  selected,
  onSelect,
}: {
  from: string;
  to: string;
  days: HistoryDay[];
  selected: string | null;
  onSelect: (date: string | null) => void;
}) {
  const weeks = useMemo(() => buildCalendar(from, to, days), [from, to, days]);

  const { measure, scale } = useMemo(() => {
    const hasSets = days.some((d) => d.working_sets > 0);
    const value = (d: HistoryDay) => (hasSets ? d.working_sets : d.sessions);
    const peak = Math.max(1, ...days.map(value));
    return {
      measure: hasSets ? ("sets" as const) : ("sessions" as const),
      // Four steps. Quartiles of the period's own peak rather than absolute
      // thresholds, so a beginner's calendar has the same range of colour as
      // someone deep into a block — the shape is what's being read, not the
      // absolute number.
      //
      // The floor at 1 is the important part. `hasSets` is decided once for
      // the period but the measure is applied per day, so for the athlete
      // this product is actually for — lifting Monday, rolling Tuesday — one
      // strength session puts every BJJ day on the working-sets scale at
      // zero, and it renders pixel-identical to a rest day. Half a training
      // week vanishing from the view whose entire job is showing which days
      // you trained.
      scale: (d: HistoryDay | null) =>
        !d ? 0 : Math.max(1, Math.ceil((value(d) / peak) * 4)),
    };
  }, [days]);

  // One label per month, above the first week that starts it — but only when
  // there's room. A month whose first week sits two columns after the last
  // label has nowhere to render and collides into "AprMay"; skipping it costs
  // one tick mark and keeps the strip legible.
  const monthCols = useMemo(() => {
    const out: { index: number; label: string }[] = [];
    let previousMonth = "";
    let lastPlaced = -99;
    weeks.forEach((week, i) => {
      const month = week[0].date.slice(0, 7);
      if (month === previousMonth) return;
      previousMonth = month;
      const label = { index: i, label: monthShort(week[0].date) };
      if (i - lastPlaced < 3) {
        // Too close to the last one. Replace it rather than skip this one:
        // the collision only happens at the leading edge, where the earlier
        // label belongs to the padding week and the later one is the month
        // actually on screen. Skipping would drop May from an Apr–Jul view.
        out.pop();
      }
      lastPlaced = i;
      out.push(label);
    });
    return out;
  }, [weeks]);

  return (
    <section className="flex flex-col gap-3" aria-labelledby="calendar-heading">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 id="calendar-heading" className="eyebrow">
          Consistency
        </h2>
        <Legend measure={measure} />
      </div>

      {/* The grid is wider than the column on a year view; scrolling it beats
          shrinking cells below a comfortable target. */}
      <div className="overflow-x-auto pb-1">
        <div className="flex min-w-max gap-1.5">
          <WeekdayGutter />

          <div className="flex flex-col gap-1">
            <div className="relative h-4">
              {monthCols.map((m) => (
                <span
                  key={`${m.label}-${m.index}`}
                  className="absolute text-[0.6875rem] text-text-dim"
                  // rem, not px: the cells are w-3 + gap-1, both rem-derived, so a
                  // hardcoded 16 desyncs the strip at a non-default root font size.
                  style={{ left: `${m.index}rem` }}
                >
                  {m.label}
                </span>
              ))}
            </div>

            <div className="flex gap-1">
              {weeks.map((week) => (
                <div key={week[0].date} className="flex flex-col gap-1">
                  {week.map((cell) => (
                    <DayCell
                      key={cell.date}
                      date={cell.date}
                      day={cell.day}
                      inRange={cell.inRange}
                      level={scale(cell.day)}
                      measure={measure}
                      selected={selected === cell.date}
                      onSelect={onSelect}
                    />
                  ))}
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

/**
 * Mon/Wed/Fri only — seven labels at this size is noise, not orientation.
 *
 * Row 0 is Monday, because `buildCalendar` starts its weeks there. An earlier
 * version led with a blank, which pushed every label down a row and quietly
 * labelled Tuesday as Monday.
 */
function WeekdayGutter() {
  return (
    <div className="mt-5 flex flex-col gap-1 pr-0.5" aria-hidden="true">
      {["M", "", "W", "", "F", "", ""].map((d, i) => (
        <span
          key={i}
          className="flex h-3 items-center text-[0.625rem] leading-none text-text-dim"
        >
          {d}
        </span>
      ))}
    </div>
  );
}

/**
 * The consistency heatmap's steps — a QUANTITY, so `training`, not `lime`.
 *
 * These are opacity steps of one hue, and until N183 that hue was `--c-lime`.
 * The brand moved and mobile's equivalent (`vola.gridLevels`) did not, so
 * leaving this on the brand would have given one measurement two different
 * colours on two surfaces — invisible on screen (the two limes are ΔE 3.05
 * apart under deuteranopia) and therefore exactly the kind of drift no test
 * would ever have reported. Caught in review. Values are unchanged.
 */
const LEVEL_CLASS = [
  "bg-line-soft",
  "bg-training/25",
  "bg-training/45",
  "bg-training/70",
  "bg-training",
] as const;

function DayCell({
  date,
  day,
  inRange,
  level,
  measure,
  selected,
  onSelect,
}: {
  date: string;
  day: HistoryDay | null;
  inRange: boolean;
  level: number;
  measure: "sets" | "sessions";
  selected: boolean;
  onSelect: (date: string | null) => void;
}) {
  // Before the early return below: a hook after a conditional return is a
  // rules-of-hooks violation.
  const { modules } = useModules();

  // Padding that only exists to square off the grid. Rendered as a hole
  // rather than a rest day — it isn't one, it's outside the period.
  if (!inRange) return <span className="h-3 w-3" aria-hidden="true" />;

  const summary = day
    ? `${day.sessions} ${day.sessions === 1 ? "session" : "sessions"}` +
      (measure === "sets" && day.working_sets > 0 ? `, ${day.working_sets} working sets` : "") +
      ` · ${day.sports.map((sp) => labelForModule(modules, sp)).join(", ")}`
    : "no training";
  const label = `${formatDayLong(date)}: ${summary}`;

  // Only trained days are focusable. Tabbing through 365 empty cells to reach
  // the session list would make the keyboard path strictly worse than the
  // mouse one.
  if (!day) {
    return (
      <span
        className="h-3 w-3 rounded-[3px] bg-line-soft"
        title={label}
        aria-hidden="true"
      />
    );
  }

  return (
    <button
      type="button"
      onClick={() => onSelect(selected ? null : date)}
      aria-pressed={selected}
      aria-label={label}
      title={label}
      className={`h-3 w-3 rounded-[3px] transition-transform hover:scale-125 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-lime ${
        LEVEL_CLASS[Math.min(level, 4)]
      } ${selected ? "ring-2 ring-text ring-offset-1 ring-offset-bg" : ""}`}
    />
  );
}

function Legend({ measure }: { measure: "sets" | "sessions" }) {
  return (
    <p className="flex items-center gap-1.5 text-[0.6875rem] text-text-dim">
      <span>{measure === "sets" ? "Fewer sets" : "Fewer sessions"}</span>
      {LEVEL_CLASS.map((c) => (
        <span key={c} className={`h-3 w-3 rounded-[3px] ${c}`} aria-hidden="true" />
      ))}
      <span>More</span>
    </p>
  );
}
