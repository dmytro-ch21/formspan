"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useAuth } from "@clerk/nextjs";

import {
  fetchPinnedExercises,
  fetchRecords,
  listExercises,
  RECORD_BASIS,
  RECORD_LABEL,
  setPinnedExercises,
  type Exercise,
  type ExerciseRecords,
  type PersonalRecord,
  type Sport,
} from "@/lib/api";
import { useModules } from "@/lib/ModulesProvider";
import {
  formatDistance,
  formatEstimate,
  formatWeight,
  type UnitSystem,
} from "@/lib/units";
import { useUnits } from "@/lib/useUnits";

/** Matches the backend's pinned-shortlist cap. */
const MAX_PINNED = 12;

/**
 * Records, at desk depth.
 *
 * The phone shows a shortlist because that's what a glance can hold. This
 * shows **everything you've actually trained** — every exercise, every record
 * kind it can hold, the exact set behind each, and a link into the session it
 * came from. That's the platform split doing its job: the wide screen is
 * where you interrogate the data, so nothing here is summarised away.
 *
 * Pinning is inline rather than on a separate screen, because on a table the
 * choice and the thing being chosen can sit side by side — you decide what
 * matters *while looking at* the numbers, which is not an option on a phone.
 *
 * Every figure comes from the API. Records are derived from the log there, so
 * a corrected set corrects the record; recomputing any of it here would be
 * the drift this codebase has already paid for twice.
 */
export default function RecordsPage() {
  // Only disciplines that HAVE record kinds. A chip for one with none filters
  // the grid to a guaranteed-empty state.
  const { modules } = useModules();
  const recordSports = modules.filter(
    (m) => m.enabled && m.is_sport && m.capabilities.record_kinds.length > 0,
  );
  const { getToken } = useAuth();
  const { units } = useUnits();

  const [records, setRecords] = useState<ExerciseRecords[] | null>(null);
  const [catalog, setCatalog] = useState<Map<string, Exercise>>(new Map());
  const [pinned, setPinned] = useState<string[]>([]);
  const [sport, setSport] = useState<Sport | null>(null);
  const [search, setSearch] = useState("");
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const load = useCallback(async () => {
    abortRef.current?.abort();
    const c = new AbortController();
    abortRef.current = c;
    try {
      const [recs, pins, exercises] = await Promise.all([
        fetchRecords(getToken, { scope: "all" }, c.signal),
        fetchPinnedExercises(getToken, c.signal),
        listExercises(getToken, {}, c.signal),
      ]);
      if (c.signal.aborted) return;
      setRecords(recs);
      setPinned(pins);
      setCatalog(new Map(exercises.map((e) => [e.id, e])));
      setError(null);
    } catch (err) {
      if (c.signal.aborted) return;
      setError(err instanceof Error ? err.message : String(err));
      setRecords([]);
    }
  }, [getToken]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load();
    return () => abortRef.current?.abort();
  }, [load]);

  const togglePin = useCallback(
    (id: string) => {
      const next = pinned.includes(id)
        ? pinned.filter((x) => x !== id)
        : pinned.length >= MAX_PINNED
          ? null
          : [...pinned, id];
      if (next === null) {
        setError(`Your profile shows at most ${MAX_PINNED} — unpin one first.`);
        return;
      }
      setError(null);
      // Optimistic; a failure puts it back rather than leaving the star and
      // the profile disagreeing.
      const previous = pinned;
      setPinned(next);
      setPinnedExercises(getToken, next).catch((err) => {
        setPinned(previous);
        setError(err instanceof Error ? err.message : String(err));
      });
    },
    [getToken, pinned],
  );

  const shown = useMemo(() => {
    if (!records) return [];
    const q = search.trim().toLowerCase();
    const withNames = records.map((r) => ({
      r,
      ex: catalog.get(r.exercise_id),
    }));
    return (
      withNames
        .filter(({ r, ex }) => {
          if (sport && ex?.sport !== sport) return false;
          if (!q) return true;
          return (ex?.name ?? r.exercise_id).toLowerCase().includes(q);
        })
        // Pinned first, then most-trained order as the API returned it.
        .sort((a, b) => {
          const ap = pinned.indexOf(a.r.exercise_id);
          const bp = pinned.indexOf(b.r.exercise_id);
          if (ap !== -1 && bp !== -1) return ap - bp;
          if (ap !== -1) return -1;
          if (bp !== -1) return 1;
          return 0;
        })
    );
  }, [records, catalog, pinned, sport, search]);

  const recentCount = useMemo(
    () =>
      (records ?? []).filter((r) => r.records.some((x) => x.is_recent)).length,
    [records],
  );

  return (
    <div className="flex flex-col gap-8">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="eyebrow">Training</p>
          <h1 className="font-display text-4xl font-bold">Records</h1>
        </div>
        <p className="text-sm text-text-muted">
          {records === null
            ? "Loading…"
            : recentCount > 0
              ? `${recentCount} set in the last two weeks`
              : `${records.length} ${records.length === 1 ? "exercise" : "exercises"}`}
        </p>
      </header>

      <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
        <label className="relative">
          <span className="sr-only">Search exercises</span>
          <input
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search exercises…"
            maxLength={100}
            className="w-64 rounded-pill border border-line bg-surface px-4 py-1.5 text-sm placeholder:text-text-dim focus-visible:border-text"
          />
        </label>
        <div
          role="group"
          aria-label="Sport"
          className="flex flex-wrap items-center gap-1.5"
        >
          <Chip active={sport === null} onClick={() => setSport(null)}>
            All
          </Chip>
          {recordSports.map((s) => (
            <Chip
              key={s.key}
              active={sport === s.key}
              onClick={() => setSport(s.key)}
            >
              {s.label}
            </Chip>
          ))}
        </div>
        <p className="text-xs text-text-dim">
          ★ {pinned.length}/{MAX_PINNED} shown on your phone
        </p>
      </div>

      {error && (
        <p
          role="alert"
          className="rounded-card border border-danger/40 bg-danger/10 px-4 py-3 text-sm"
        >
          {error}
        </p>
      )}

      {records === null ? (
        <div className="flex flex-col gap-3">
          {Array.from({ length: 4 }, (_, i) => (
            <div
              key={i}
              className="h-28 animate-pulse rounded-card border border-line bg-surface"
            />
          ))}
        </div>
      ) : shown.length === 0 ? (
        <div className="rounded-card border border-dashed border-line px-6 py-16 text-center">
          <p className="font-display text-xl font-bold">
            {records.length === 0 ? "No records yet" : "Nothing matches"}
          </p>
          <p className="mx-auto mt-2 max-w-sm text-sm text-text-muted">
            {records.length === 0 ? (
              <>
                Log a few working sets and your bests appear here — nothing to
                set up.{" "}
                <Link
                  href="/dashboard/sessions"
                  className="text-lime underline"
                >
                  Start a session
                </Link>
                .
              </>
            ) : (
              "Try a different search or sport."
            )}
          </p>
        </div>
      ) : (
        <ul className="flex flex-col gap-3">
          {shown.map(({ r, ex }) => (
            <RecordCard
              key={r.exercise_id}
              records={r}
              exercise={ex}
              units={units}
              pinned={pinned.includes(r.exercise_id)}
              onTogglePin={() => togglePin(r.exercise_id)}
            />
          ))}
        </ul>
      )}
    </div>
  );
}

function RecordCard({
  records,
  exercise,
  units,
  pinned,
  onTogglePin,
}: {
  records: ExerciseRecords;
  exercise: Exercise | undefined;
  units: UnitSystem;
  pinned: boolean;
  onTogglePin: () => void;
}) {
  const name = exercise?.name ?? records.exercise_id;
  const isNew = records.records.some((r) => r.is_recent);

  return (
    <li className="rounded-card border border-line bg-surface px-5 py-4">
      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={onTogglePin}
          aria-pressed={pinned}
          // Named for what it does, not for the glyph — "star" tells a screen
          // reader nothing about the consequence.
          aria-label={
            pinned
              ? `Stop showing ${name} on your phone`
              : `Show ${name} on your phone`
          }
          title={pinned ? "Shown on your phone" : "Show on your phone"}
          className={`shrink-0 text-lg leading-none transition ${
            pinned ? "text-lime" : "text-text-dim hover:text-text"
          }`}
        >
          {pinned ? "★" : "☆"}
        </button>
        <h2 className="min-w-0 flex-1 truncate font-display text-lg font-bold">
          {name}
        </h2>
        {isNew && (
          <span className="rounded-pill bg-accent-fill px-2 py-0.5 text-[0.625rem] font-bold tracking-wide text-accent-on-fill">
            NEW
          </span>
        )}
        {exercise && (
          <span className="text-xs capitalize text-text-dim">
            {exercise.sport} · {exercise.movement_pattern.replace(/_/g, " ")}
          </span>
        )}
      </div>

      {/* Every kind this exercise can hold, side by side — the desk view
          doesn't have to choose which one to show. */}
      <dl className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {records.records.map((r) => (
          <RecordCell key={r.kind} record={r} units={units} />
        ))}
      </dl>
    </li>
  );
}

function RecordCell({
  record,
  units,
}: {
  record: PersonalRecord;
  units: UnitSystem;
}) {
  return (
    <div className="rounded-card border border-line-soft bg-surface-raised px-4 py-3">
      <dt className="eyebrow text-[0.625rem]">
        {RECORD_LABEL[record.kind]}
        {/* A modelled number says so. `RECORD_LABEL` already reads "Est. 1RM",
            but that is the record's NAME — this says what sort of number it is,
            and stays right if the label is ever reworded. */}
        {RECORD_BASIS[record.kind] === "modelled" && (
          <span className="ml-1 font-normal normal-case text-text-dim">
            estimate
          </span>
        )}
      </dt>
      <dd className="stat mt-0.5 text-2xl">{formatValue(record, units)}</dd>
      {/* The evidence, and a way to go and look at it. A record you can open
          is one you can argue with; a bare number is one you have to trust. */}
      <p className="mt-1 text-xs text-text-muted">
        {describe(record, units).measured || "—"}
        {/* The rating, set apart rather than joined to the measurements with
            the same middle dot. It is the athlete's account of the set. */}
        {describe(record, units).reported && (
          <span className="ml-1 italic text-text-dim">
            · {describe(record, units).reported}
          </span>
        )}
      </p>
      <Link
        href={`/dashboard/sessions/${record.session_id}`}
        className="mt-1 inline-block text-xs text-text-dim underline hover:text-text"
      >
        <time dateTime={record.achieved_at}>
          {new Date(record.achieved_at).toLocaleDateString(undefined, {
            day: "numeric",
            month: "short",
            year: "numeric",
          })}
        </time>
      </Link>
    </div>
  );
}

/** Each kind is measured in its own unit; format it as that unit. */
function formatValue(r: PersonalRecord, units: UnitSystem): string {
  switch (r.kind) {
    case "heaviest_weight":
      return formatWeight(r.value, units);
    // Modelled rather than measured, so whole units — see formatEstimate.
    case "estimated_1rm":
      return formatEstimate(r.value, units);
    case "most_reps":
      return String(Math.round(r.value));
    case "longest_time": {
      const s = Math.round(r.value);
      const m = Math.floor(s / 60);
      return m > 0 ? `${m}m${s % 60 ? ` ${s % 60}s` : ""}` : `${s}s`;
    }
    case "furthest_distance":
      return formatDistance(r.value, units);
  }
}

/**
 * The set behind the number, split by what kind of fact each half is.
 *
 * This returned one string with the same separator between the two halves —
 * `"5 × 100kg · 2 RIR"` — which presents an opinion as another column of the
 * measurement. `5 × 100kg` is what was on the bar; `2 RIR` is what the athlete
 * reckoned was left. See `backend/internal/modules/session/basis.go`.
 *
 * The mobile twin is `describeEvidence` in `apps/mobile/lib/records.ts`, and it
 * splits the same way.
 */
function describe(
  r: PersonalRecord,
  units: UnitSystem,
): { measured: string; reported: string } {
  const measured: string[] = [];
  if (r.reps != null && r.weight_kg != null) {
    measured.push(`${r.reps} × ${formatWeight(r.weight_kg, units)}`);
  } else if (r.reps != null) {
    measured.push(`${r.reps} reps`);
  }
  // RIR wins where both are present, matching the estimator's own precedence.
  const reported: string[] = [];
  if (r.rir != null) reported.push(`${r.rir} RIR`);
  else if (r.rpe != null) reported.push(`RPE ${r.rpe}`);
  return { measured: measured.join(" · "), reported: reported.join(" · ") };
}

function Chip({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={`rounded-pill border px-3 py-1.5 text-sm font-medium transition ${
        active
          ? "border-text bg-surface-raised"
          : "border-line text-text-muted hover:bg-surface-raised"
      }`}
    >
      {children}
    </button>
  );
}
