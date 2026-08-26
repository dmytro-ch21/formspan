"use client";

import type { Suggestion, SuggestionCode } from "@/lib/api";
import { formatEstimate, formatWeight, type UnitSystem } from "@/lib/units";

/**
 * The progression recommendation for one exercise, on the web.
 *
 * Web is the analytical surface, so this shows the whole reasoning: where the
 * lift sits in its rep range, what moves next and why, and the evidence
 * underneath. Mobile gets the same recommendation compressed to a line —
 * between sets nobody reads a rationale.
 *
 * The rep-range track is the part that earns its space. Double progression is
 * a two-phase cycle and a sentence describing it never lands; five pips
 * filling up and then resetting one weight higher is the whole scheme in a
 * glance, and it makes "why am I not adding weight yet" answerable without
 * reading anything.
 *
 * Colour is never the only carrier of meaning here — every phase states its
 * name in full-contrast text, and the dot beside it is redundant encoding. It
 * matters because `--c-lime` on a light surface is 3.27:1, fine for a graphic
 * and not fine for a word you have to read.
 */

type Phase = {
  label: string;
  /** Tailwind text-colour class for the dot only, never for reading text. */
  dot: string;
  /** Fill for the rep-range pips. */
  pip: string;
};

/**
 * The fallback for a code this build doesn't know — a server deployed ahead of
 * the client. TypeScript treats the lookup below as total, so this is dead to
 * the compiler and live at runtime. It's deliberately nameless: labelling an
 * unknown phase "Hold" would state something confident and wrong right next to
 * a `reason` saying otherwise, and the reason is the thing that stays true.
 */
const UNKNOWN_PHASE: Phase = { label: "", dot: "bg-text-muted", pip: "bg-text-muted" };

const PHASE: Record<SuggestionCode, Phase> = {
  // `progression-advance`, NOT `lime` — the web half of the same split the
  // mobile map records. Every other colour here is a fixed semantic token, so
  // reading the brand would make this the one entry that moves with the logo.
  // Same value as before N183.
  add_load: {
    label: "Add load",
    dot: "bg-progression-advance",
    pip: "bg-progression-advance",
  },
  add_reps: { label: "Add a rep", dot: "bg-green", pip: "bg-green" },
  deload: { label: "Deload", dot: "bg-warn", pip: "bg-warn" },
  hold: { label: "Hold", dot: "bg-text-muted", pip: "bg-text-muted" },
  repeat_hard: { label: "Repeat", dot: "bg-warn", pip: "bg-warn" },
  repeat_stale: { label: "Restart", dot: "bg-text-muted", pip: "bg-text-muted" },
  repeat_unknown_effort: {
    label: "Log effort",
    dot: "bg-text-muted",
    pip: "bg-text-muted",
  },
  no_history: { label: "First time", dot: "bg-text-muted", pip: "bg-text-muted" },
  not_applicable: { label: "—", dot: "bg-text-muted", pip: "bg-text-muted" },
};

/**
 * The pips, low → high. `reached` is how far the *weakest* working set got,
 * which is the number the rule gates on — showing the best set instead would
 * explain the wrong thing, since a session opening at 10 and ending at 6 is
 * exactly the case where the load doesn't move.
 *
 * Capped at 8 pips so an endurance range (12–20, nine reps wide) degrades to
 * a bar with labelled ends rather than a row of dots nobody counts. The cap
 * matches mobile's; at 12 this branch was unreachable, since no goal produces
 * a range that wide, and endurance rendered as nine dots.
 */
function RepRangeTrack({
  low,
  high,
  reached,
  target,
  pip,
}: {
  low: number;
  high: number;
  reached: number | null;
  target: number | null;
  pip: string;
}) {
  const span = high - low + 1;
  if (span > 8) {
    const pct =
      reached == null ? 0 : Math.max(0, Math.min(1, (reached - low + 1) / span)) * 100;
    return (
      <div className="flex items-center gap-2" aria-hidden>
        <span className="text-xs tabular-nums text-text-muted">{low}</span>
        <div className="h-1.5 min-w-16 flex-1 overflow-hidden rounded-pill bg-line">
          <div className={`h-full rounded-pill ${pip}`} style={{ width: `${pct}%` }} />
        </div>
        <span className="text-xs tabular-nums text-text-muted">{high}</span>
      </div>
    );
  }

  return (
    // Decorative: the line beside it states the same position in words, so
    // announcing "Rep range six ten" as loose numbers only adds noise.
    <div className="flex items-center gap-2" aria-hidden>
      <span className="text-xs tabular-nums text-text-muted">{low}</span>
      <div className="flex items-center gap-1">
        {Array.from({ length: span }, (_, i) => {
          const rep = low + i;
          const filled = reached != null && rep <= reached;
          const isTarget = target != null && rep === target;
          return (
            <span
              key={rep}
              // A 2px surface ring on the target keeps it legible where it
              // sits next to a filled neighbour of the same colour.
              className={[
                "h-2 w-2 rounded-pill transition",
                filled ? pip : "bg-line",
                isTarget ? "ring-2 ring-text ring-offset-1 ring-offset-surface-raised" : "",
              ].join(" ")}
            />
          );
        })}
      </div>
      <span className="text-xs tabular-nums text-text-muted">{high}</span>
    </div>
  );
}

/** "5 × 100 kg · 1 RIR", the top set — one real set, never a composite. */
function lastSetLine(s: Suggestion, units: UnitSystem): string | null {
  if (s.last_weight_kg == null) return null;
  const reps = s.last_reps != null ? `${s.last_reps} × ` : "";
  const effort =
    s.last_rir != null
      ? ` · ${s.last_rir} RIR`
      : s.last_rpe != null
        ? ` · RPE ${s.last_rpe}`
        : "";
  return `${reps}${formatWeight(s.last_weight_kg, units)}${effort}`;
}

export default function ProgressionCard({
  suggestion,
  exerciseName,
  units,
  editable,
  applied,
  onApply,
}: {
  suggestion: Suggestion;
  /** Only for the apply button's accessible name — eight cards in a session
      otherwise present eight buttons called "Use this". */
  exerciseName: string;
  units: UnitSystem;
  editable: boolean;
  /** True when the sets already carry this recommendation. */
  applied: boolean;
  onApply: (weightKg: number | null, reps: number | null) => void;
}) {
  const s = suggestion;
  if (s.code === "not_applicable") return null;

  const phase = PHASE[s.code] ?? UNKNOWN_PHASE;
  // Defaulted rather than dereferenced: an app build newer than the deployed
  // API is routine with Expo Go and a rolling backend, and a missing field
  // should cost the track, not throw inside the session screen's render.
  const range = s.rep_range ?? { low: 0, high: 0 };
  const last = lastSetLine(s, units);
  const canApply =
    editable && !applied && (s.target_weight_kg != null || s.target_reps != null);

  // The headline prescription. Weight-only or reps-only are both real states
  // (no history yet, or an unloaded lift), so neither half is assumed.
  const target = [
    s.target_weight_kg != null ? formatWeight(s.target_weight_kg, units) : null,
    s.target_reps != null ? `× ${s.target_reps}` : null,
  ]
    .filter(Boolean)
    .join(" ");
  // The same thing in words. Screen readers announce "×" as "multiplication
  // sign", which turns a rep target into gibberish.
  const spoken = [
    s.target_weight_kg != null ? formatWeight(s.target_weight_kg, units) : null,
    s.target_reps != null ? `for ${s.target_reps} reps` : null,
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <div className="rounded-card border border-line bg-surface-raised px-4 py-3">
      <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className={`h-2 w-2 shrink-0 rounded-pill ${phase.dot}`} aria-hidden />
            <span className="text-xs font-bold uppercase tracking-wide text-text">
              {phase.label}
            </span>
            {/* Only shown once it means something. One session at a load is
                just "last time" and needs no counter. */}
            {s.sessions_at_load > 1 && (
              <span className="text-xs text-text-muted">
                · {s.sessions_at_load} sessions at this weight
              </span>
            )}
          </div>
          {target && (
            <p className="mt-1 font-display text-2xl font-bold leading-none tabular-nums text-text">
              {target}
              {s.target_reps != null && (
                <span className="ml-1 text-base font-medium text-text-muted">reps</span>
              )}
            </p>
          )}
        </div>

        {canApply && (
          <button
            type="button"
            onClick={() => onApply(s.target_weight_kg, s.target_reps)}
            aria-label={`Use ${spoken} for the remaining sets of ${exerciseName}`}
            className="shrink-0 rounded-pill bg-accent-fill px-4 py-1.5 text-sm font-bold text-accent-on-fill transition hover:brightness-110"
          >
            Use this
          </button>
        )}
        {/* Guarded on there being something to apply: with both targets null
            — a first-time exercise — `applied` is vacuously true, and the card
            would read "First time … Applied". */}
        {applied && (s.target_weight_kg != null || s.target_reps != null) && (
          <span className="shrink-0 self-center text-xs font-medium text-text-muted">
            Applied
          </span>
        )}
      </div>

      {/* The reason verbatim from the API — the point is a recommendation you
          can argue with, not one you have to trust. */}
      <p className="mt-2 text-sm text-text-muted">{s.reason}</p>

      {/* N191 — an ADDITIONAL note, never a replacement for the target/reason
          above, which stay purely last session's numbers. `text-text` rather
          than `text-text-muted`, deliberately: it's new information the
          prescription above hasn't seen, and reads as one. */}
      {s.in_session_signal != null && (
        <p className="mt-1 text-sm text-text">{s.in_session_signal.reason}</p>
      )}

      {(last || s.estimated_1rm_kg != null) && (
        <div className="mt-3 space-y-2 border-t border-line-soft pt-3">
          {range.high > 0 && (
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
              <span className="text-xs font-medium text-text-muted">Rep range</span>
              <RepRangeTrack
                low={range.low}
                high={range.high}
                reached={s.last_min_reps}
                target={s.target_reps}
                pip={phase.pip}
              />
              {/* Named explicitly: the pips show a position, this says what
                  the position is measuring. */}
              {s.last_min_reps != null && s.last_max_reps != null && (
                <span className="text-xs tabular-nums text-text-muted">
                  {s.last_min_reps === s.last_max_reps
                    ? `all sets at ${s.last_min_reps}`
                    : `last: ${s.last_min_reps}–${s.last_max_reps} across ${s.working_sets} sets`}
                </span>
              )}
            </div>
          )}

          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs">
            {last && (
              <span className="text-text-muted">
                Top set <span className="font-medium text-text">{last}</span>
              </span>
            )}
            {s.estimated_1rm_kg != null && (
              <span className="text-text-muted">
                Est. 1RM{" "}
                <span className="font-medium text-text">
                  {formatEstimate(s.estimated_1rm_kg, units)}
                </span>
                {s.best_1rm_kg != null &&
                  formatEstimate(s.estimated_1rm_kg, units) ===
                    formatEstimate(s.best_1rm_kg, units) &&
                  " · your best"}
              </span>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
